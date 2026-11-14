/**
 * The Hive service: one server for many hives, so a community runs nothing of its own. A hive
 * lives here under its Buzz channel, at `/c/<channel ID>/`:
 *
 *   GET  /hives?community=<relay>         the hives a community has here, once approved
 *   POST /hives                           HiveBot's setup asks for a hive for its channel
 *   GET  /c/<channel>/hive/v1/state       what the Hive plugin shows
 *   POST /c/<channel>/hive/v1/channel     members' plugins forward the channel's signed events
 *   GET  /c/<channel>/hive/v1/invite      the agent's mesh invite, with --serve-invite
 *   …    /c/<channel>/desk/v1/…           the signing desk, for keepers' consoles
 *   POST /c/<channel>/agent/v1/events     a community's own agent node reports its activity
 *   GET  /c/<channel>/agent/v1/members    and fetches the members it may serve
 *
 * A hive HiveBot asks for waits until the service's operator approves it
 * (`pnpm ops service-approve <hive> --bot <HiveBot's key>`), so a host carries only the communities
 * it agreed to. Any key can sign a request for any channel, and the key approved is the one whose
 * messages name the hive's keepers: the operator takes HiveBot's key from the channel itself, never
 * from the request. Until then a hive keeps nothing but its requests. From then on nothing needs a
 * person here: once every keeper's key is in, the service builds the treasury from the three keys,
 * and the hive's agent node starts. The service holds no key that moves funds; each keeper's console
 * checks every payment itself.
 *
 *   pnpm ops service --network <regtest|bitcoin> --public https://<host> --console https://<host>/keeper/
 *                    [--port 8787] [--model <id>] [--discussion-minutes <n>] [--origin <console origin> …]
 *                    [--serve-invite]
 */
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Deployment } from "@hive/ark";
import {
  clientAddress,
  ensure,
  Fault,
  localPath,
  rateLimit,
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
import { currentPrice } from "./price.js";

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
    mergeForwarded(
      known: unknown[],
      incoming: unknown,
      channelId: string,
      trust: { bot?: string; keepers?: string[] },
    ): Promise<{ events: unknown[]; added: number; refused: number }>;
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
  /** While pending: every key that asked for this channel, for the operator to pick HiveBot's from. */
  requests?: Record<string, HiveRequest>;
}

export interface HiveRequest {
  community: string;
  name: string;
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
  /**
   * Serves each hive's mesh invite to anyone who asks. Whoever holds it can join the mesh, though not
   * spend, so it is off unless asked for.
   */
  serveInvite?: boolean;
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
const KEY = /^[0-9a-f]{64}$/;
/** How many keys may ask for one channel before the operator has chosen among them. */
export const MAX_REQUESTS = 8;
/** How many hives may wait for the operator at once, and how long one waits before it makes room. */
export const MAX_PENDING = 200;
const PENDING_SECONDS = 30 * 86_400;
/** How many forwards or reports may wait on one hive before more are turned away. */
const MAX_WAITING = 8;
/** The largest body each kind of request may carry. */
const BODY_LIMIT = { hives: 32 * 1024, channel: 4 * 1024 * 1024, desk: 256 * 1024, agent: 2 * 1024 * 1024 };
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
  /** Each hive's writes, one after another: two forwards never both start from the same stored events. */
  #tails = new Map<string, { tail: Promise<unknown>; waiting: number }>();

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
    // A hive's id is the start of its channel ID: another channel that starts the same is not this hive.
    ensure(found && found.channelId === channelId, "NO_HIVE", "no hive in this channel");
    return found;
  }

  list(community?: string): Registration[] {
    const index = readJsonIfPresent<Record<string, string>>(join(this.root, "index.json")) ?? {};
    return Object.values(index)
      .map((hive) => readJsonIfPresent<Registration>(this.files(hive).registration))
      .filter((r): r is Registration => Boolean(r) && (!community || r!.community === community));
  }

  /** What anyone may read of a community's hives: the approved ones, without the keys that asked. */
  published(community?: string) {
    return this.list(community)
      .filter((r) => r.status === "approved")
      .map(({ hive, channelId, community: c, name, bot, status }) => ({
        hive,
        channelId,
        community: c,
        name,
        bot,
        status,
      }));
  }

  /** Every key that has asked for a pending hive. */
  requests(registration: Registration): Record<string, HiveRequest> {
    return (
      registration.requests ?? {
        [registration.bot]: {
          community: registration.community,
          name: registration.name,
          requestedAt: registration.requestedAt,
        },
      }
    );
  }

  /**
   * HiveBot's setup asks for a hive in its channel, with its first setup message as proof: a signed
   * message in that channel. Anyone can sign one, so a request proves only that its key asked: every
   * key that asks is kept until the operator approves HiveBot's, and the answer is the request as
   * it stands for the key that sent it.
   */
  register(body: { channelId?: string; community?: string; name?: string; call?: unknown }): Registration {
    const channelId = String(body.channelId ?? "").toLowerCase();
    ensure(CHANNEL.test(channelId), "INVALID", "channel ID");
    const call = body.call as { pubkey?: string; kind?: number; tags?: string[][] } | undefined;
    ensure(
      this.modules.channel.verifyEvent(call) &&
        call!.kind === 9 &&
        call!.tags!.some((t) => t[0] === "h" && t[1] === channelId) &&
        call!.tags!.some((t) => t[0] === "hive" && t[1] === "call"),
      "INVALID",
      "HiveBot's first setup message in the channel, signed",
    );
    const bot = call!.pubkey!;
    const now = Math.floor(Date.now() / 1000);
    const asked: HiveRequest = {
      community: String(body.community ?? "").slice(0, 200),
      name: String(body.name ?? "Hive").slice(0, 80) || "Hive",
      requestedAt: now,
    };
    const hive = hiveIdFor(channelId);
    const files = this.files(hive);
    const existing = readJsonIfPresent<Registration>(files.registration);
    if (existing) {
      ensure(existing.channelId === channelId, "HIVE_ID_TAKEN", "another channel has this hive's id here");
      if (existing.status === "approved") return existing;
      const requests = this.requests(existing);
      if (!requests[bot]) {
        ensure(
          Object.keys(requests).length < MAX_REQUESTS,
          "TOO_MANY_REQUESTS",
          "this channel has all the requests it can hold until the operator has chosen",
        );
        writeJson(files.registration, { ...existing, requests: { ...requests, [bot]: asked } });
      }
      return { hive, channelId, ...(requests[bot] ?? asked), bot, status: "pending" };
    }
    this.makeRoom(now);
    const registration: Registration = {
      hive,
      channelId,
      ...asked,
      bot,
      status: "pending",
      requests: { [bot]: asked },
    };
    writeJson(files.registration, registration);
    const indexPath = join(this.root, "index.json");
    writeJson(indexPath, {
      ...(readJsonIfPresent<Record<string, string>>(indexPath) ?? {}),
      [channelId]: hive,
    });
    return { hive, channelId, ...asked, bot, status: "pending" };
  }

  /** Requests nobody approved in a month leave; past that, a full waiting list takes no more. */
  private makeRoom(now: number) {
    const pending = this.list().filter((r) => r.status === "pending");
    const stale = pending.filter((r) => now - r.requestedAt > PENDING_SECONDS);
    for (const r of stale) this.reject(r.hive);
    ensure(
      pending.length - stale.length < MAX_PENDING,
      "SERVICE_FULL",
      "too many hives are waiting for this service's operator",
    );
  }

  /** The operator turns a request down: it leaves, and the channel may ask again. */
  reject(hive: string): void {
    const files = this.files(hive);
    const registration = readJsonIfPresent<Registration>(files.registration);
    ensure(registration, "NO_HIVE");
    ensure(registration.status === "pending", "APPROVED", "an approved hive is not removed this way");
    rmSync(files.dir, { recursive: true, force: true });
    const indexPath = join(this.root, "index.json");
    const index = readJsonIfPresent<Record<string, string>>(indexPath) ?? {};
    delete index[registration.channelId];
    writeJson(indexPath, index);
  }

  /**
   * The operator opens a hive, naming HiveBot's key as its profile in the channel shows it. The key
   * decides who the hive's keepers are, so it is never taken from a request alone.
   */
  async approve(hive: string, bot?: string): Promise<Registration> {
    const files = this.files(hive);
    const registration = readJsonIfPresent<Registration>(files.registration);
    ensure(registration, "NO_HIVE");
    if (registration.status !== "approved") {
      const requests = this.requests(registration);
      ensure(
        bot && KEY.test(bot),
        "BOT_REQUIRED",
        `name HiveBot's key, from its profile in the channel; these keys asked: ${Object.keys(requests).join(", ")}`,
      );
      const chosen = requests[bot];
      ensure(chosen, "NO_SUCH_REQUEST", `${bot} has not asked for this channel`);
      Object.assign(registration, chosen, { bot, status: "approved" });
      delete registration.requests;
      writeJson(files.registration, registration);
    } else ensure(!bot || bot === registration.bot, "APPROVED", `already open for ${registration.bot}`);
    await this.serial(hive, () => this.coordinate(registration));
    return registration;
  }

  /** One hive's work in turn, with a bound on how much may wait. */
  private async serial<T>(hive: string, action: () => Promise<T>): Promise<T> {
    const queue = this.#tails.get(hive) ?? { tail: Promise.resolve(), waiting: 0 };
    this.#tails.set(hive, queue);
    ensure(queue.waiting < MAX_WAITING, "BUSY", "this hive has work waiting; try again shortly");
    queue.waiting += 1;
    const result = queue.tail.then(action);
    queue.tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        queue.waiting -= 1;
      });
    return result;
  }

  record(hive: string): HiveRecord | undefined {
    return readJsonIfPresent<HiveRecord>(localPath("ops", hive, "hive.json"));
  }

  /**
   * Forwarded events: verified, merged, and the hive worked out again. A hive still waiting for the
   * operator keeps none: its plugins are told so and forward again once it is open.
   */
  async receive(channelId: string, events: unknown) {
    const registration = this.registration(channelId);
    if (registration.status !== "approved") return { added: 0, refused: 0, events: 0, pending: true };
    return this.serial(registration.hive, async () => {
      const files = this.files(registration.hive);
      const known = readJsonIfPresent<unknown[]>(files.events) ?? [];
      const keepers = readJsonIfPresent<Governance>(files.governance)?.keepers ?? [];
      const merged = await this.modules.channel.mergeForwarded(known, events, channelId, {
        bot: registration.bot,
        keepers,
      });
      if (merged.added) writeJson(files.events, merged.events);
      if (merged.added || !readJsonIfPresent(files.governance)) await this.coordinate(registration);
      return { added: merged.added, refused: merged.refused, events: merged.events.length };
    });
  }

  /** Every open hive worked out again, one at a time: time alone closes discussions and starts budgets. */
  async sweep(): Promise<void> {
    for (const r of this.list()) {
      if (r.status !== "approved") continue;
      await this.serial(r.hive, () => this.coordinate(r)).catch(() => {});
      if (this.record(r.hive))
        await this.desk(r)
          .then((d) => d.tick())
          .catch(() => {});
    }
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
    if (cached && Date.now() - cached.at < 15_000) return { ...cached.body, price: currentPrice() };
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
        // HiveBot's key here, once the operator has named it: a bot that finds another's in its
        // channel leaves the hive alone.
        ...(registration.status === "approved" ? { bot: registration.bot } : {}),
        agent: governance.agentKey ? { own: true, key: governance.agentKey } : { own: false },
        ...(this.options.serveInvite ? { invite: `${base}/hive/v1/invite` } : {}),
      },
    };
    this.#cache.set(registration.hive, { at: Date.now(), body });
    // The Bitcoin price, for members who show amounts in dollars; display only.
    return { ...body, price: currentPrice() };
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
    ensure(Number.isSafeInteger(offset) && offset >= 0, "INVALID", "offset");
    ensure(
      lines.every((l) => !l.includes("\n")),
      "INVALID",
      "one log line each",
    );
    return this.serial(registration.hive, async () => {
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
      // Added to the end, never written whole: a reader sees the old log or the longer one.
      if (fresh.length) appendFileSync(files.agentLog, `${fresh.join("\n")}\n`);
      if (fresh.length) await this.coordinate(registration);
      return { lines: count + fresh.length };
    });
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
  // Each client's share of the service, by what it asks for: asking for a hive and forwarding a
  // channel cost the most, reading the least. Members behind one address share its allowance.
  const limits = {
    register: rateLimit(10),
    forward: rateLimit(60, 30),
    desk: rateLimit(240, 120),
    agent: rateLimit(120, 60),
    read: rateLimit(600, 300),
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://service");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      if (parts[0] === "healthz") return res.writeHead(200).end("ok");
      const kind = parts[0] === "hives" ? "hives" : parts[0] === "c" ? parts[2] : undefined;
      // Keepers' consoles call the desk from their own page.
      if (kind === "desk" && !consoleCors(req, res, options.origins)) return;
      const limit =
        kind === "desk"
          ? limits.desk
          : kind === "agent"
            ? limits.agent
            : method !== "POST"
              ? limits.read
              : kind === "hives"
                ? limits.register
                : limits.forward;
      ensure(limit.take(clientAddress(req)), "RATE_LIMITED", "too many requests; try again in a minute");
      const size =
        kind === "hives"
          ? BODY_LIMIT.hives
          : kind === "desk"
            ? BODY_LIMIT.desk
            : kind === "agent"
              ? BODY_LIMIT.agent
              : BODY_LIMIT.channel;
      const body = method === "POST" ? ((await readJsonBody(req, size)) as Record<string, unknown>) : {};
      ensure(body && typeof body === "object" && !Array.isArray(body), "INVALID_JSON");
      if (parts[0] === "hives" && method === "GET")
        return sendJson(res, 200, {
          hives: service.published(url.searchParams.get("community") ?? undefined),
        });
      if (parts[0] === "hives" && method === "POST") return sendJson(res, 200, service.register(body));
      ensure(parts[0] === "c" && parts[1], "NOT_FOUND");
      const channelId = parts[1].toLowerCase();
      const [area, version, ...rest] = parts.slice(2);
      if (area === "hive" && version === "v1" && rest[0] === "state" && method === "GET")
        return sendJson(res, 200, await service.state(channelId));
      if (area === "hive" && version === "v1" && rest[0] === "channel" && method === "POST") {
        const taken = await service.receive(channelId, body.events);
        // 202 while the hive waits for the operator: nothing was kept, so plugins send it again.
        return sendJson(res, "pending" in taken ? 202 : 200, taken);
      }
      if (area === "hive" && version === "v1" && rest[0] === "invite" && method === "GET") {
        ensure(options.serveInvite, "NOT_FOUND");
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
        const keeper = req.headers["x-hive-keeper"];
        return sendJson(
          res,
          200,
          await deskRoute(desk, method, rest, body, keeper ? String(keeper) : undefined),
        );
      }
      if (area === "agent" && version === "v1" && rest[0] === "events" && method === "POST")
        return sendJson(res, 200, await service.agentEvents(channelId, body));
      // The node's signature travels in headers, which proxies and access logs leave out.
      if (area === "agent" && version === "v1" && rest[0] === "members" && method === "GET")
        return sendJson(
          res,
          200,
          service.agentMembers(
            channelId,
            Number(req.headers["x-hive-at"]),
            String(req.headers["x-hive-signature"]),
          ),
        );
      throw new Fault("NOT_FOUND");
    } catch (error) {
      const { status, body } = faultStatus(error);
      sendJson(res, status, body);
    }
  });
  // A client that sends its request a byte at a time holds a connection no longer than this.
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => ready());
  });
  const address = server.address();
  ensure(address && typeof address !== "string", "LISTEN_FAILED");
  // Time alone closes discussions and starts budgets: every open hive is worked out again each
  // minute, one after another, and each desk carries its payments forward. A pass still running
  // when the next is due is left to finish.
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void service.sweep().finally(() => {
      sweeping = false;
    });
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
