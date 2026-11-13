/**
 * The Hive service: one server for many hives, so a community runs nothing of its own. A hive
 * lives here under its Buzz channel, at `/c/<channel ID>/`:
 *
 *   GET  /hives?community=<relay>         the hives a community has here
 *   POST /hives                           HiveBot's setup asks for a hive for its channel
 *   GET  /c/<channel>/hive/v1/state       what the Hive plugin shows
 *   POST /c/<channel>/hive/v1/channel     members' plugins forward the channel's signed events
 *   GET  /c/<channel>/hive/v1/invite      the agent's mesh invite, for providers and members
 *   …    /c/<channel>/desk/v1/…           the signing desk, for keepers' consoles
 *   POST /c/<channel>/agent/v1/events     a community's own agent node reports its activity
 *   GET  /c/<channel>/agent/v1/members    and fetches the members it may serve
 *
 * The pilot is gated: a hive HiveBot asks for waits until the service's operator approves it
 * (`pnpm ops service-approve <hive>`). From then on nothing needs a person here: once every keeper's
 * key is in, the service builds the treasury from the three keys, and the hive's agent node starts.
 * The service holds no key that moves funds; each keeper's console checks every payment itself.
 *
 *   pnpm ops service --network <regtest|bitcoin> --public https://<host> --console https://<host>/keeper/
 *                    [--port 8787] [--model <id>] [--discussion-minutes <n>] [--origin <console origin> …]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Deployment } from "@hive/ark";
import {
  ensure,
  Fault,
  localPath,
  readJsonBody,
  readJsonIfPresent,
  repositoryRoot,
  sendJson,
  sha256Hex,
  unhex,
  writeJson,
} from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import { inviteNodeId } from "./agents.js";
import { consoleCors, Desk, type DeskOptions, deskRoute, faultStatus } from "./desk.js";
import { type HiveRecord, initHive, type OpsContext, treasuryOf } from "./ops.js";

/** The Buzz plugin's own modules, which the service runs exactly as a single hive's host does. */
interface HiveBuzz {
  state: {
    arkadePkScript(address: string): string;
    jobsFromLog(log: string): { status: string }[];
    proposalsFromLog(log: string): { proposal: string; usedSats: number }[];
    hiveState(args: Record<string, unknown>): Record<string, unknown>;
  };
  channel: {
    verifyEvent(event: unknown): boolean;
    mergeEvents(
      known: unknown[],
      incoming: unknown,
      channelId: string,
    ): { events: unknown[]; added: number; refused: number };
    governanceFrom(
      events: unknown[],
      cfg: Record<string, unknown>,
      usage: Record<string, number>,
    ): { governance: Governance; members: unknown };
  };
}
const hiveBuzz = async (): Promise<HiveBuzz> => {
  const at = (p: string) => pathToFileURL(join(repositoryRoot, "hive/hive-buzz/api/src", p)).href;
  return { state: await import(at("state.mjs")), channel: await import(at("channel.mjs")) };
};

export interface Governance {
  channelId: string;
  keepers: string[];
  keeperKeys: (string | null)[];
  agentKey: string | null;
  proposals: { state: string }[];
}

/** A hive as the service keeps it. */
export interface Registration {
  hive: string;
  channelId: string;
  /** The community's relay, as its Buzz app names it, to find the hive from anywhere in it. */
  community: string;
  name: string;
  /** HiveBot, whose own messages in the channel record the keepers. */
  bot: string;
  status: "pending" | "approved";
  requestedAt: number;
}

export interface ServiceOptions {
  network: string;
  deployment?: Deployment;
  publicUrl: string;
  consoleUrl: string;
  model?: string;
  threshold?: number;
  smallSats?: number;
  discussionSeconds?: number;
  origins?: string[];
  /** Starts and stops each hive's agent node; none in tests. */
  agents?: AgentRunner;
  /** The desks' timing, shortened for a rehearsal whose jobs last minutes. */
  desk?: Pick<DeskOptions, "deadlineMarginSeconds" | "minimumValiditySeconds">;
  root?: string;
}

/** Runs the agent node of hives that use the service's own. */
export interface AgentRunner {
  ensure(hive: Registration, files: HiveFiles, treasury: HiveRecord): Promise<void>;
  stop(hive: string): Promise<void>;
  /** The agent's current mesh invite, for providers and members to join. */
  invite(hive: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface HiveFiles {
  dir: string;
  registration: string;
  events: string;
  governance: string;
  members: string;
  agentLog: string;
}

const CHANNEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The hive's id here: short, stable, and derived from its channel alone. */
export const hiveIdFor = (channelId: string) => `hive-${channelId.replace(/-/g, "").slice(0, 16)}`;
export const AGENT_TAG = "hive-agent/v1";
/** What a community's own agent node signs to report to the service or fetch its members. */
export const agentDigest = (channelId: string, at: number, what: string) =>
  unhex(sha256Hex(`${AGENT_TAG}|${channelId}|${at}|${what}`));

export class HiveService {
  readonly root: string;
  /** One desk per hive, so its queue is the only one: two requests never build two. */
  #desks = new Map<string, Promise<Desk>>();
  #cache = new Map<string, { at: number; body: Record<string, unknown> }>();
  #building = new Set<string>();

  private constructor(
    readonly options: ServiceOptions,
    readonly modules: HiveBuzz,
    readonly ctx: OpsContext,
  ) {
    this.root = options.root ?? localPath("service");
  }

  static async create(options: ServiceOptions, ctx: OpsContext = {}) {
    return new HiveService(options, await hiveBuzz(), ctx);
  }

  files(hive: string): HiveFiles {
    const dir = join(this.root, "hives", hive);
    return {
      dir,
      registration: join(dir, "registration.json"),
      events: join(dir, "events.json"),
      governance: join(dir, "governance.json"),
      members: join(dir, "members.json"),
      agentLog: join(dir, "agent.jsonl"),
    };
  }

  registration(channelId: string): Registration {
    ensure(CHANNEL.test(channelId), "NO_HIVE", "not a channel ID");
    const found = readJsonIfPresent<Registration>(this.files(hiveIdFor(channelId)).registration);
    ensure(found, "NO_HIVE", "no hive in this channel");
    return found;
  }

  list(community?: string): Registration[] {
    const index = readJsonIfPresent<Record<string, string>>(join(this.root, "index.json")) ?? {};
    return Object.values(index)
      .map((hive) => readJsonIfPresent<Registration>(this.files(hive).registration))
      .filter((r): r is Registration => Boolean(r) && (!community || r!.community === community));
  }

  /**
   * HiveBot's setup asks for a hive in its channel, with its first setup message as proof: signed by
   * HiveBot, in that channel. The first request for a channel stands; the operator approves it.
   */
  register(body: { channelId?: string; community?: string; name?: string; call?: unknown }): Registration {
    const channelId = String(body.channelId ?? "").toLowerCase();
    ensure(CHANNEL.test(channelId), "INVALID", "channel ID");
    const call = body.call as { pubkey?: string; tags?: string[][] } | undefined;
    ensure(
      this.modules.channel.verifyEvent(call) &&
        call!.tags!.some((t) => t[0] === "h" && t[1] === channelId) &&
        call!.tags!.some((t) => t[0] === "hive" && t[1] === "call"),
      "INVALID",
      "HiveBot's first setup message in the channel, signed",
    );
    const hive = hiveIdFor(channelId);
    const files = this.files(hive);
    const existing = readJsonIfPresent<Registration>(files.registration);
    if (existing) return existing;
    const registration: Registration = {
      hive,
      channelId,
      community: String(body.community ?? "").slice(0, 200),
      name: String(body.name ?? "Hive").slice(0, 80) || "Hive",
      bot: call!.pubkey!,
      status: "pending",
      requestedAt: Math.floor(Date.now() / 1000),
    };
    writeJson(files.registration, registration);
    const indexPath = join(this.root, "index.json");
    writeJson(indexPath, {
      ...(readJsonIfPresent<Record<string, string>>(indexPath) ?? {}),
      [channelId]: hive,
    });
    return registration;
  }

  /** The operator opens a hive for the pilot. */
  async approve(hive: string): Promise<Registration> {
    const files = this.files(hive);
    const registration = readJsonIfPresent<Registration>(files.registration);
    ensure(registration, "NO_HIVE");
    registration.status = "approved";
    writeJson(files.registration, registration);
    await this.coordinate(registration);
    return registration;
  }

  record(hive: string): HiveRecord | undefined {
    return readJsonIfPresent<HiveRecord>(localPath("ops", hive, "hive.json"));
  }

  /** Forwarded events: verified, merged, and the hive worked out again. */
  async receive(channelId: string, events: unknown) {
    const registration = this.registration(channelId);
    const files = this.files(registration.hive);
    const known = readJsonIfPresent<unknown[]>(files.events) ?? [];
    const merged = this.modules.channel.mergeEvents(known, events, channelId);
    if (merged.added) writeJson(files.events, merged.events);
    if (merged.added || !readJsonIfPresent(files.governance)) await this.coordinate(registration);
    return { added: merged.added, refused: merged.refused, events: merged.events.length };
  }

  /**
   * Where the hive stands, from its channel: proposals, keepers, keys, members. Once an approved
   * hive has all three keepers' keys, its treasury is built, and its agent node started.
   */
  async coordinate(registration: Registration): Promise<Governance> {
    const files = this.files(registration.hive);
    const events = readJsonIfPresent<unknown[]>(files.events) ?? [];
    let log = "";
    try {
      log = readFileSync(files.agentLog, "utf8");
    } catch {
      // no usage yet
    }
    const usage = Object.fromEntries(
      this.modules.state.proposalsFromLog(log).map((p) => [p.proposal, p.usedSats]),
    );
    const { governance, members } = this.modules.channel.governanceFrom(
      events,
      {
        channelId: registration.channelId,
        bot: registration.bot,
        threshold: this.options.threshold ?? 2,
        smallSats: this.options.smallSats ?? 20_000,
        ...(this.options.discussionSeconds !== undefined
          ? { discussionSeconds: this.options.discussionSeconds }
          : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
      },
      usage,
    );
    writeJson(files.governance, governance);
    writeJson(files.members, members);
    this.#cache.delete(registration.hive);
    if (registration.status === "approved") await this.buildTreasury(registration, governance);
    const record = this.record(registration.hive);
    if (record && this.options.agents) {
      if (governance.agentKey) await this.options.agents.stop(registration.hive);
      else await this.options.agents.ensure(registration, files, record);
    }
    return governance;
  }

  private async buildTreasury(registration: Registration, governance: Governance) {
    if (this.record(registration.hive) || this.#building.has(registration.hive)) return;
    const keys = governance.keeperKeys;
    if (keys.length !== 3 || keys.some((k) => !k)) return;
    this.#building.add(registration.hive);
    try {
      await initHive(
        registration.hive,
        {
          network: this.options.network,
          ...(this.options.deployment ? { deployment: this.options.deployment } : {}),
          keepers: keys as [string, string, string],
        },
        this.ctx,
      );
    } finally {
      this.#building.delete(registration.hive);
    }
  }

  /** The hive's desk, once it has a treasury. */
  async desk(registration: Registration): Promise<Desk> {
    const cached = this.#desks.get(registration.hive);
    if (cached) return cached;
    const record = this.record(registration.hive);
    ensure(record, "NO_TREASURY", "the hive's treasury is built once every keeper's key is in");
    const files = this.files(registration.hive);
    const made = treasuryOf(record, this.ctx).then(
      (treasury) =>
        new Desk(registration.hive, treasury, {
          ...this.options.desk,
          agentLog: files.agentLog,
          governance: files.governance,
        }),
    );
    this.#desks.set(registration.hive, made);
    made.catch(() => this.#desks.delete(registration.hive));
    return made;
  }

  /** What the Hive plugin shows, cached for 15 seconds whatever the number of members. */
  async state(channelId: string): Promise<Record<string, unknown>> {
    const registration = this.registration(channelId);
    const cached = this.#cache.get(registration.hive);
    if (cached && Date.now() - cached.at < 15_000) return cached.body;
    const files = this.files(registration.hive);
    const record = this.record(registration.hive);
    let log = "";
    try {
      log = readFileSync(files.agentLog, "utf8");
    } catch {
      // no agent yet
    }
    const governance = readJsonIfPresent<Governance>(files.governance) ?? {
      channelId,
      keepers: [],
      keeperKeys: [],
      agentKey: null,
      proposals: [],
    };
    const balance = record ? await this.balance(record).catch(() => null) : null;
    // Members install with the agent's node id, from its own invite.
    const invite = governance.agentKey ? null : await this.options.agents?.invite(registration.hive);
    const nodeId = invite ? inviteNodeId(invite) : null;
    const base = `${this.options.publicUrl}/c/${channelId}`;
    const body = {
      ...this.modules.state.hiveState({
        name: registration.name,
        chipIn: { lightningAddress: null, arkadeAddress: record?.treasuryAddress ?? null },
        treasury: record ? { address: record.treasuryAddress, balanceSats: balance } : null,
        jobs: this.modules.state.jobsFromLog(log),
        contributions: [],
        proposals: this.modules.state.proposalsFromLog(log),
        agent: nodeId ? { nodeId } : null,
        governance: {
          ...governance,
          threshold: this.options.threshold ?? 2,
          smallSats: this.options.smallSats ?? 20_000,
          ...(this.options.discussionSeconds !== undefined
            ? { discussionSeconds: this.options.discussionSeconds }
            : {}),
          members: (governance as { members?: unknown }).members ?? {},
        },
        // The console adds /desk/v1/… to this address itself.
        keepersDesk: record ? { desk: base, console: this.options.consoleUrl } : null,
      }),
      hive: {
        id: registration.hive,
        status: registration.status,
        network: this.options.network,
        agent: governance.agentKey ? { own: true, key: governance.agentKey } : { own: false },
        invite: `${base}/hive/v1/invite`,
      },
    };
    this.#cache.set(registration.hive, { at: Date.now(), body });
    return body;
  }

  private async balance(record: HiveRecord): Promise<number> {
    const res = await fetch(
      `${record.deployment.arkdUrl}/v1/indexer/vtxos?scripts=${record.treasuryScript}&spendableOnly=true`,
      { signal: AbortSignal.timeout(10_000) },
    );
    ensure(res.ok, "INDEXER", String(res.status));
    const { vtxos = [] } = (await res.json()) as { vtxos?: { amount: string }[] };
    return vtxos.reduce((n, v) => n + Number(v.amount), 0);
  }

  /** A community's own agent node, checked against the key a keeper named in the channel. */
  private agentAuth(registration: Registration, at: number, what: string, signature: string) {
    const governance = readJsonIfPresent<Governance>(this.files(registration.hive).governance);
    const key = governance?.agentKey;
    ensure(key, "NO_AGENT", "no keeper has named the community's own agent node in the channel");
    ensure(Math.abs(Math.floor(Date.now() / 1000) - at) <= 300, "AUTH_STALE");
    ensure(
      /^[0-9a-f]{128}$/.test(signature) &&
        schnorr.verify(unhex(signature), agentDigest(registration.channelId, at, what), unhex(key)),
      "AUTH_INVALID",
    );
  }

  /** The community's agent node reports the lines its pay-arkade plugin logged, in order. */
  async agentEvents(
    channelId: string,
    body: { at?: number; signature?: string; lines?: string[]; offset?: number },
  ) {
    const registration = this.registration(channelId);
    const lines = Array.isArray(body.lines) ? body.lines.map(String) : [];
    const offset = Number(body.offset ?? 0);
    this.agentAuth(
      registration,
      Number(body.at),
      `events|${offset}|${sha256Hex(lines.join("\n"))}`,
      String(body.signature),
    );
    const files = this.files(registration.hive);
    let have = "";
    try {
      have = readFileSync(files.agentLog, "utf8");
    } catch {
      // first report
    }
    const count = have ? have.split("\n").filter(Boolean).length : 0;
    // Lines arrive in order; ones already here are skipped, a gap is refused so none is lost.
    ensure(offset <= count, "GAP", `the service has ${count} lines`);
    const fresh = lines.slice(count - offset).filter((l) => l.trim());
    if (fresh.length) writeFileSync(files.agentLog, `${have}${fresh.join("\n")}\n`);
    if (fresh.length) await this.coordinate(registration);
    return { lines: count + fresh.length };
  }

  agentMembers(channelId: string, at: number, signature: string) {
    const registration = this.registration(channelId);
    this.agentAuth(registration, at, "members", signature);
    return readJsonIfPresent(this.files(registration.hive).members) ?? { members: {} };
  }
}

/** Serves the Hive service; the host's TLS proxy puts it on HTTPS. */
export async function startService(
  options: ServiceOptions & { port?: number; host?: string },
  ctx: OpsContext = {},
) {
  const service = await HiveService.create(options, ctx);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://service");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      if (parts[0] === "healthz") return res.writeHead(200).end("ok");
      // Keepers' consoles call the desk from their own page.
      if (parts[0] === "c" && parts[2] === "desk" && !consoleCors(req, res, options.origins)) return;
      const body =
        method === "POST" ? ((await readJsonBody(req, 8 * 1024 * 1024)) as Record<string, unknown>) : {};
      if (parts[0] === "hives" && method === "GET")
        return sendJson(res, 200, { hives: service.list(url.searchParams.get("community") ?? undefined) });
      if (parts[0] === "hives" && method === "POST") return sendJson(res, 200, service.register(body));
      ensure(parts[0] === "c" && parts[1], "NOT_FOUND");
      const channelId = parts[1].toLowerCase();
      const [area, version, ...rest] = parts.slice(2);
      if (area === "hive" && version === "v1" && rest[0] === "state" && method === "GET")
        return sendJson(res, 200, await service.state(channelId));
      if (area === "hive" && version === "v1" && rest[0] === "channel" && method === "POST")
        return sendJson(res, 200, await service.receive(channelId, body.events));
      if (area === "hive" && version === "v1" && rest[0] === "invite" && method === "GET") {
        const invite = await options.agents?.invite(service.registration(channelId).hive);
        if (!invite)
          return res
            .writeHead(503, { "content-type": "text/plain" })
            .end("the hive's agent is not running here\n");
        return res
          .writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" })
          .end(`${invite}\n`);
      }
      if (area === "desk" && version === "v1") {
        const desk = await service.desk(service.registration(channelId));
        return sendJson(res, 200, await deskRoute(desk, method, rest, body));
      }
      if (area === "agent" && version === "v1" && rest[0] === "events" && method === "POST")
        return sendJson(res, 200, await service.agentEvents(channelId, body));
      if (area === "agent" && version === "v1" && rest[0] === "members" && method === "GET")
        return sendJson(
          res,
          200,
          service.agentMembers(
            channelId,
            Number(url.searchParams.get("at")),
            String(url.searchParams.get("signature")),
          ),
        );
      throw new Fault("NOT_FOUND");
    } catch (error) {
      const { status, body } = faultStatus(error);
      sendJson(res, status, body);
    }
  });
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => ready());
  });
  const address = server.address();
  ensure(address && typeof address !== "string", "LISTEN_FAILED");
  // Time alone closes discussions and starts budgets: every hive is worked out again each minute,
  // and each desk carries its payments forward.
  const timer = setInterval(() => {
    for (const r of service.list()) void service.coordinate(r).catch(() => {});
    for (const r of service.list())
      if (service.record(r.hive))
        void service
          .desk(r)
          .then((d) => d.tick())
          .catch(() => {});
  }, 60_000);
  timer.unref();
  return {
    service,
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    async close() {
      clearInterval(timer);
      await options.agents?.close();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
