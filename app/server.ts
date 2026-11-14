import { CovenantRefusal } from "@hive/executor";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { networkCeilings } from "@hive/ark";
import {
  clientAddress,
  ensure,
  rateLimit,
  shapedObject,
  Fault,
  faultCode,
  haltReason,
  readJson,
  readJsonBody,
  requireHiveId,
  requireNotHalted,
  sendJson,
} from "@hive/kit";
import {
  type IntakeEndpoint,
  type IntakeRail,
  type IntakeRequest,
  intakeSettlement,
  type HiveView,
  type ClaimRequest,
  requestContribution,
} from "@hive/hive";
import { type HiveNetwork, type SignedHiveListing, validateHiveListing } from "@hive/protocol";

/**
 * One hive's routes: its page and four JSON routes. `/api/view` is the
 * observed view; `/api/pour` asks the hive's Lightning address for a payment
 * on a visitor's behalf; `/api/pour/:id` reports that payment's LUD-21 status
 * next to whether its treasury output has been observed. Credit on the page
 * follows observation only. `/api/claim` is the claim desk: a provider hands
 * in the payer's receipt and its own claim signature, and a steward pair
 * registers the claim with the delegatee. Neither the desk nor the stewards
 * can change the amount; the escrow's covenant checks both signatures.
 */
export interface HiveRoutes {
  /** The hive's name, whose own halt switch applies besides the operator's. */
  hive?: string;
  /** What its keepers signed about it: name, purpose, keys and treasury. */
  listing?: SignedHiveListing;
  view(): Promise<HiveView>;
  intake?: {
    endpoint: IntakeEndpoint;
    network: HiveNetwork;
    operatorKey: string;
    requestsDirectory: string;
    minSats?: number;
    maxSats?: number;
    /** The Lightning swap market's maximum; Mutinynet's solver takes at most 25,000 sats. */
    maxLightningSats?: number;
  };
  /** Minimum spacing between payment requests; one per second by default. */
  pourIntervalMs?: number;
  /** How long one reading of the view answers every request; three seconds by default. */
  viewCacheMs?: number;
  /** Register a provider's claim; absent, the desk is closed. */
  claimDesk?(claim: ClaimHandIn): Promise<{ spendId: string }>;
}

/** A provider's claim as the desk takes it: the quote, the receipt and the claim signature. */
export type ClaimHandIn = ClaimRequest;

export interface HivePageOptions extends HiveRoutes {
  host?: string;
  port?: number;
  /** Read the page from disk on every request, so edits show on refresh. */
  livePages?: boolean;
}

export interface HivePage {
  url: string;
  close(): Promise<void>;
}

const PAGE = resolve(import.meta.dirname, "page.html");
const FONTS = new Map(
  ["bricolage-grotesque", "figtree", "jetbrains-mono"].map((name) => [
    `/fonts/${name}.woff2`,
    readFileSync(resolve(import.meta.dirname, "fonts", `${name}.woff2`)),
  ]),
);

/** The page's typefaces, served from this server: the page loads nothing from anywhere else. */
function servedFont(request: IncomingMessage, response: ServerResponse, path: string): boolean {
  const font = request.method === "GET" ? FONTS.get(path) : undefined;
  if (!font) return false;
  response.writeHead(200, {
    "content-type": "font/woff2",
    "cache-control": "public, max-age=31536000, immutable",
  });
  response.end(font);
  return true;
}
const DIRECTORY = resolve(import.meta.dirname, "hives.html");

interface Page {
  body: Buffer;
  headers: Record<string, string>;
}

/**
 * A page with the headers it is served under. Its own script runs by its hash and no other does,
 * so nothing a page ever shows of a hive's listing or view can run as code, and no other site can
 * frame it.
 */
function pageOf(body: Buffer): Page {
  const scripts = [...body.toString("utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`,
  );
  return {
    body,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'self'",
        "style-src 'unsafe-inline'",
        `script-src ${scripts.join(" ") || "'none'"}`,
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  };
}

/** A page read once at start, or on every request while someone edits it. */
function pageSource(path: string, live = false): () => Page {
  if (live) return () => pageOf(readFileSync(path));
  const page = pageOf(readFileSync(path));
  return () => page;
}
const MAX_BODY = 4 * 1024;
const MAX_CLAIM_BODY = 32 * 1024;
const POUR_INTERVAL_MS = 1_000;
const VIEW_CACHE_MS = 3_000;
/** Payment requests kept in memory to answer for; older ones are still on disk. */
const MAX_REQUESTS = 5_000;
/** Claim registrations that may wait their turn; each runs a signing session. */
const MAX_CLAIMS_WAITING = 8;
/** One address's share of payment requests and of claims a minute, so none takes everyone's. */
const pours = rateLimit(6, 3);
const claims = rateLimit(30, 15);
const SUMMARY_TIMEOUT_MS = 5_000;

interface Hive {
  handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<void>;
  view(): Promise<HiveView>;
  claim(body: ClaimHandIn): Promise<{ spendId: string }>;
  status(): { halted: boolean; haltReason: string | null };
}

/**
 * Everything one hive keeps between requests, apart from every other hive's:
 * its payment requests, its pacing and its queue of claim registrations.
 */
function openHive(options: HiveRoutes, page: () => Page): Hive {
  const hive = options.hive === undefined ? undefined : requireHiveId(options.hive);
  const requests = new Map<string, IntakeRequest>();
  // Requests handed out before a restart stay answerable.
  const saved = options.intake?.requestsDirectory;
  if (saved && existsSync(saved)) {
    for (const name of readdirSync(saved).filter((n) => n.endsWith(".json"))) {
      const record = readJson<IntakeRequest>(resolve(saved, name));
      if (record.schema === "hive-intake-request/v4") requests.set(record.id, record);
    }
  }
  let lastPour = 0;
  // The view reads the Operator and the hive's records: it is worked out once for everyone who asks
  // within a few seconds, and by one request at a time.
  const cacheMs = options.viewCacheMs ?? VIEW_CACHE_MS;
  let seen: { at: number; view: HiveView } | undefined;
  let reading: Promise<HiveView> | undefined;
  const view = (): Promise<HiveView> => {
    if (seen && Date.now() - seen.at < cacheMs) return Promise.resolve(seen.view);
    reading ??= options
      .view()
      .then((read) => {
        seen = { at: Date.now(), view: read };
        return read;
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };
  // One claim registration at a time: each runs a steward pair's signing session. Only a few wait.
  let registering: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  const claim = (body: ClaimHandIn) => {
    const desk = options.claimDesk;
    if (!desk) throw new Fault("CLAIM_DESK_CLOSED");
    if (waiting >= MAX_CLAIMS_WAITING) throw new Fault("BUSY");
    waiting += 1;
    const run = registering.then(() => desk(body));
    registering = run
      .catch(() => undefined)
      .finally(() => {
        waiting -= 1;
      });
    return run;
  };
  const status = () => {
    const reason = haltReason(hive);
    return { halted: reason !== undefined, haltReason: reason ?? null };
  };

  return {
    claim,
    status,
    view,
    async handle(request, response, path) {
      if (request.method === "GET" && path === "/") {
        const served = page();
        response.writeHead(200, served.headers);
        response.end(served.body);
        return;
      }
      if (request.method === "GET" && path === "/api/view") {
        sendJson(response, 200, await view());
        return;
      }
      if (request.method === "GET" && path === "/api/status") {
        const ceilings = options.intake ? networkCeilings(options.intake.network) : undefined;
        sendJson(response, 200, {
          hive: hive ?? null,
          listing: options.listing ?? null,
          network: options.intake?.network ?? null,
          intake: Boolean(options.intake),
          ...status(),
          ceilings: ceilings
            ? Object.fromEntries(Object.entries(ceilings).map(([k, v]) => [k, Number(v)]))
            : null,
        });
        return;
      }
      if (request.method === "POST" && path === "/api/pour") {
        const intake = options.intake;
        if (!intake) throw new Fault("INTAKE_DISABLED");
        const body = (await readJsonBody(request, MAX_BODY)) as { amountSats?: unknown; rail?: unknown };
        const rail = body.rail === "arkade" ? "arkade" : body.rail === "lightning" ? "lightning" : undefined;
        const amountSats = Number(body.amountSats);
        const ceilings = networkCeilings(intake.network);
        const maxSats = Math.min(
          intake.maxSats ?? 1_000_000,
          ceilings ? Number(ceilings.contributionSats) : Number.MAX_SAFE_INTEGER,
          rail === "lightning" ? (intake.maxLightningSats ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER,
        );
        if (
          !rail ||
          !Number.isSafeInteger(amountSats) ||
          amountSats < (intake.minSats ?? 1) ||
          amountSats > maxSats
        )
          throw new Fault("INVALID_POUR");
        requireNotHalted(hive);
        if (ceilings) {
          const { treasury } = await view();
          ensure(BigInt(treasury.balanceSats + amountSats) <= ceilings.treasurySats, "TREASURY_FULL");
        }
        // Only well-formed requests reach lnurl-server: a few a minute from one address, and at most
        // one per interval from them all.
        if (!pours.take(clientAddress(request))) throw new Fault("SLOW_DOWN");
        const now = Date.now();
        if (now - lastPour < (options.pourIntervalMs ?? POUR_INTERVAL_MS)) throw new Fault("SLOW_DOWN");
        lastPour = now;
        const record = await requestContribution({
          endpoint: intake.endpoint,
          network: intake.network,
          rail: rail as IntakeRail,
          amountSats,
          operatorKey: intake.operatorKey,
          requestsDirectory: intake.requestsDirectory,
        });
        requests.set(record.id, record);
        if (requests.size > MAX_REQUESTS) requests.delete(requests.keys().next().value as string);
        sendJson(response, 200, {
          id: record.id,
          rail: record.rail,
          amountSats: record.amountSats,
          invoice: record.invoice ?? null,
          destination: record.destination ?? null,
        });
        return;
      }
      if (request.method === "POST" && path === "/api/claim") {
        if (!claims.take(clientAddress(request))) throw new Fault("SLOW_DOWN");
        const { spendId } = await claim(await readClaim(request));
        sendJson(response, 200, { spendId });
        return;
      }
      const pour = /^\/api\/pour\/([0-9a-f-]{36})$/.exec(path);
      if (request.method === "GET" && pour) {
        const record = requests.get(pour[1]!);
        if (!record) throw new Fault("UNKNOWN_POUR");
        const [settlement, current] = await Promise.all([intakeSettlement(record), view()]);
        const credited = current.contributions.find((c) => c.requestId === record.id) ?? null;
        sendJson(response, 200, { id: record.id, settled: settlement.settled, credited });
        return;
      }
      sendJson(response, 404, { error: "NOT_FOUND" });
    },
  };
}

async function readClaim(request: IncomingMessage): Promise<ClaimHandIn> {
  return shapedObject(
    await readJsonBody(request, MAX_CLAIM_BODY),
    ["quote", "receipt", "claimSignature"],
    ["expectedSpend", "postBefore"],
    "claim",
  ) as unknown as ClaimHandIn;
}

async function listen(
  server: Server,
  options: { host?: string; port?: number },
): Promise<HivePage> {
  // A client that sends its request a byte at a time holds a connection no longer than this.
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => done());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Fault("PAGE_ADDRESS");
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const failed = (response: ServerResponse, error: unknown) => {
  if (error instanceof CovenantRefusal) {
    sendJson(response, 409, { error: "COVENANT_REFUSAL", rejection: error.rejection });
    return;
  }
  const code = faultCode(error, "FAILED");
  sendJson(response, code === "BUSY" ? 429 : error instanceof Fault ? 400 : 500, { error: code });
};

/** A server for one hive, at the root of its address. */
export async function startHivePage(options: HivePageOptions): Promise<HivePage> {
  const hive = openHive(options, pageSource(PAGE, options.livePages));
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", "http://hive.local").pathname;
      if (servedFont(request, response, path)) return;
      await hive.handle(request, response, path);
    } catch (error) {
      failed(response, error);
    }
  });
  return listen(server, options);
}

/** One hive on a host: its routes and the listing all three of its keepers signed. */
export interface HostedHive extends Omit<HiveRoutes, "hive"> {
  listing: SignedHiveListing;
}

export interface HiveHostOptions {
  host?: string;
  port?: number;
  hives: HostedHive[];
  /** Read the directory and the hive page from disk on every request, so edits show on refresh. */
  livePages?: boolean;
}

/** What the directory shows of one hive: its signed listing, its switches and its totals. */
export interface HiveSummary {
  hive: string;
  listing: SignedHiveListing;
  halted: boolean;
  haltReason: string | null;
  balanceSats: number | null;
  totals: HiveView["totals"] | null;
  /** Why the totals are missing: this hive's view failed, and no other hive's. */
  error: string | null;
}

const withTimeout = <T>(work: Promise<T>, ms: number) =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Fault("VIEW_TIMEOUT")), ms).unref()),
  ]);

/**
 * Many hives on one server, each under `/h/<hive>/` with exactly the routes a
 * single-hive server has, and nothing shared between them but the process.
 * `/api/hives` lists every hive with its keepers' signed listing; a hive
 * whose view fails shows its error and leaves the others untouched.
 * `/api/claim` takes a claim for any hive and hands it to the hive whose
 * treasury the quote names, so a provider needs one desk address.
 */
export async function startHiveHost(options: HiveHostOptions): Promise<HivePage> {
  ensure(options.hives.length > 0, "INVALID", "a host needs a hive");
  const page = pageSource(PAGE, options.livePages);
  const directory = pageSource(DIRECTORY, options.livePages);
  const hives = new Map<string, { entry: HostedHive; hive: Hive }>();
  const byTreasury = new Map<string, string>();
  for (const entry of options.hives) {
    const listing = validateHiveListing(entry.listing);
    const id = listing.body.hive;
    ensure(!hives.has(id), "DUPLICATE_HIVE", id);
    ensure(!byTreasury.has(listing.body.treasuryScript), "DUPLICATE_TREASURY", id);
    hives.set(id, { entry: { ...entry, listing }, hive: openHive({ ...entry, hive: id }, page) });
    byTreasury.set(listing.body.treasuryScript, id);
  }

  const summary = async (id: string): Promise<HiveSummary> => {
    const { entry, hive } = hives.get(id)!;
    const base = { hive: id, listing: entry.listing, ...hive.status() };
    try {
      const view = await withTimeout(hive.view(), SUMMARY_TIMEOUT_MS);
      return { ...base, balanceSats: view.treasury.balanceSats, totals: view.totals, error: null };
    } catch (error) {
      return { ...base, balanceSats: null, totals: null, error: faultCode(error, "VIEW_FAILED") };
    }
  };

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", "http://hive.local").pathname;
      if (servedFont(request, response, path)) return;
      if (request.method === "GET" && path === "/") {
        const served = directory();
        response.writeHead(200, served.headers);
        response.end(served.body);
        return;
      }
      if (request.method === "GET" && path === "/api/hives") {
        sendJson(response, 200, { hives: await Promise.all([...hives.keys()].map(summary)) });
        return;
      }
      if (request.method === "POST" && path === "/api/claim") {
        if (!claims.take(clientAddress(request))) throw new Fault("SLOW_DOWN");
        const body = await readClaim(request);
        const treasury = (body.quote as { body?: { treasuryScript?: unknown } })?.body?.treasuryScript;
        const id = typeof treasury === "string" ? byTreasury.get(treasury) : undefined;
        if (!id) throw new Fault("UNKNOWN_HIVE", "no hive here keeps the quote's treasury");
        const { spendId } = await hives.get(id)!.hive.claim(body);
        sendJson(response, 200, { hive: id, spendId });
        return;
      }
      const route = /^\/h\/([^/]+)(\/.*)?$/.exec(path);
      const found = route ? hives.get(route[1]!) : undefined;
      if (route && found) {
        if (route[2] === undefined) {
          // Relative links on a hive's page resolve under its own path.
          response.writeHead(308, { location: `/h/${route[1]}/` });
          response.end();
          return;
        }
        await found.hive.handle(request, response, route[2]);
        return;
      }
      sendJson(response, 404, { error: route ? "UNKNOWN_HIVE" : "NOT_FOUND" });
    } catch (error) {
      failed(response, error);
    }
  });
  return listen(server, options);
}
