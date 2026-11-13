/**
 * The signing desk: where a keepers' hive's payments wait for its keepers, run on the hive's host
 * beside the hive's agent. It holds no key and decides nothing. It reads the jobs the agent asks the
 * keepers to fund, plans each payment for a pair of keepers, keeps the nonces each keeper's console
 * shared ahead of time, and collects their signatures as they come, hours apart and in either order.
 * Once a pair has signed, it hands the payment to the delegatee and watches it land.
 *
 *   pnpm ops desk <hive> --agent-log <pay-arkade buyer log> [--governance <file>] [--port 8790]
 *                 [--origin https://brg444.github.io …]
 *
 * Each keeper's console checks every payment itself before signing (`checkPayment`), against the
 * Operator and its own reading of the job's terms; what the desk says is never taken on its word.
 */

import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Pair } from "@hive/ark";
import { jobEscrow, PAIRS, pairMembers, sendMessages } from "@hive/ark";
import type { RouteName } from "@hive/executor";
import {
  driveTreasurySpend,
  newSpendJournal,
  planTreasurySend,
  registerSigned,
  registrationMessage,
  type SpendJournal,
  type Treasury,
  treasuryAccountOf,
} from "@hive/hive";
import {
  ensure,
  Fault,
  faultCode,
  readJsonBody,
  readJsonIfPresent,
  sendJson,
  unhex,
  withLock,
  writeJson,
} from "@hive/kit";
import {
  assignShared,
  deskAuthDigest,
  type FundingRequest,
  KEEPER_MAX_VALIDITY_SECONDS,
  type NonceBatch,
  newSession,
  type PairSession,
  record as recordSignature,
  type SharedNonce,
  verifyNonceBatch,
} from "@hive/steward";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  type HiveRecord,
  loadHive,
  type OpsContext,
  opsPaths,
  type PendingListing,
  signPendingListing,
  treasuryOf,
} from "./ops.js";

/** A keeper's console keeps a few dozen nonces here; more would only wait. */
const MAX_POOLED = 64;
/** A signed request to the desk is fresh for this long. */
const AUTH_WINDOW_SECONDS = 300;
/** A payment's authorization ends this long before the job's deadline, so the provider can still open it. */
const DEADLINE_MARGIN_SECONDS = 600;

/** A job the hive's agent asked the keepers to fund, and where it stands now. */
export interface AgentJob {
  request: FundingRequest;
  status: "awaiting_funding" | "open" | "claimed" | "returned" | "declined" | "lapsed";
  usedSats: number;
  requestedAt: number;
}

/** The agent's jobs, from its pay-arkade event log; requests without their escrow's terms are left out. */
export function agentJobs(log: string, now = Math.floor(Date.now() / 1000)): AgentJob[] {
  const jobs = new Map<string, AgentJob>();
  for (const line of log.split("\n")) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const at = Number(e.at ?? 0);
    if (e.event === "funding_requested" && e.request && typeof e.request === "object") {
      const r = e.request as Record<string, unknown>;
      const params = r.params as FundingRequest["params"] | undefined;
      if (!params) continue;
      const request: FundingRequest = {
        jobId: String(r.job_id),
        address: String(r.address),
        capSats: Number(r.cap_sats),
        deadline: Number(r.deadline),
        model: String(r.model ?? ""),
        priceMsatPerMtok: Number(r.price_msat_per_mtok ?? 0),
        providerPk: String(r.provider_pk),
        params,
        ...(r.min_coin_expiry !== undefined && r.min_coin_expiry !== null
          ? { minCoinExpiry: Number(r.min_coin_expiry) }
          : {}),
      };
      jobs.set(request.jobId, { request, status: "awaiting_funding", usedSats: 0, requestedAt: at });
      continue;
    }
    const job = jobs.get(
      String(e.job_id ?? (e.message as Record<string, unknown> | undefined)?.job_id ?? ""),
    );
    if (!job) continue;
    if (e.event === "job_open") job.status = "open";
    else if (e.event === "receipt_signed") job.usedSats = Math.max(job.usedSats, Number(e.amount_sats ?? 0));
    else if (e.event === "job_closed" && e.txid) job.status = "claimed";
    else if (e.event === "expired") job.status = "returned";
    else if (e.event === "received" && (e.message as Record<string, unknown>)?.kind === "decline")
      job.status = job.status === "awaiting_funding" ? "declined" : job.status;
  }
  for (const job of jobs.values())
    if (job.status === "awaiting_funding" && now >= job.request.deadline) job.status = "lapsed";
  return [...jobs.values()].sort((a, b) => b.requestedAt - a.requestedAt);
}

/** What the hive's approved work has left for new jobs, from its proposals and the jobs already open. */
export interface Budget {
  approvedLeftSats: number;
  lockedSats: number;
  remainingSats: number;
  proposals: { id: string; title: string; budgetSats: number; usedSats: number; state: string }[];
}

export function budgetOf(governance: unknown, jobs: AgentJob[]): Budget {
  const all = ((governance as { proposals?: unknown[] } | undefined)?.proposals ?? []) as Budget["proposals"];
  const proposals = all
    .filter((p) => p.state === "approved" || p.state === "running")
    .map(({ id, title, budgetSats, usedSats, state }) => ({
      id,
      title,
      budgetSats,
      usedSats: usedSats ?? 0,
      state,
    }));
  const approvedLeftSats = proposals.reduce((n, p) => n + Math.max(0, p.budgetSats - p.usedSats), 0);
  // What open escrows hold and have not yet spent is already set aside for approved work.
  const lockedSats = jobs
    .filter((j) => j.status === "open")
    .reduce((n, j) => n + Math.max(0, j.request.capSats - j.usedSats), 0);
  return {
    approvedLeftSats,
    lockedSats,
    remainingSats: Math.max(0, approvedLeftSats - lockedSats),
    proposals,
  };
}

/** A payment as the desk keeps it: the plan, who signs, and each session's progress. */
export interface DeskPayment {
  schema: "hive-desk-payment/v1";
  jobId: string;
  request: FundingRequest;
  /** What the hive's approved work had left when the first keeper started it. */
  remainingSats: number;
  pair: Pair;
  /** The keeper who started it, and signs each session over the other's shared nonces first. */
  first: string;
  second: string;
  attest: PairSession;
  register?: PairSession;
  status: "attesting" | "registering" | "submitted" | "done" | "expired" | "cancelled" | "failed";
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeskAuth {
  keeper: string;
  at: number;
  signature: string;
}

export interface DeskOptions {
  agentLog: string;
  governance?: string;
  port?: number;
  host?: string;
  /** Origins a keeper console may call from; any origin when empty. */
  origins?: string[];
  /** How the finished payment is executed: the delegatee unless told otherwise. */
  routes?: RouteName[];
  tickMs?: number;
  now?: () => number;
  /**
   * How long before the job's deadline a payment's authorization ends, and the least time two keepers
   * get to sign: ten minutes each by default, shorter only for a rehearsal on regtest.
   */
  deadlineMarginSeconds?: number;
  minimumValiditySeconds?: number;
}

export class Desk {
  readonly paths: ReturnType<typeof opsPaths>;
  readonly record: HiveRecord;
  #drives = new Map<string, Promise<void>>();

  constructor(
    readonly hive: string,
    readonly treasury: Treasury,
    readonly options: DeskOptions,
  ) {
    this.record = loadHive(hive);
    ensure(this.record.keepersHold, "INVALID", `${hive}'s keys are not its keepers' own; it needs no desk`);
    this.paths = opsPaths(hive);
  }

  get keepers(): [string, string, string] {
    return this.record.stewardKeys;
  }

  now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private file(...parts: string[]) {
    return this.paths.local("desk", ...parts);
  }

  private lock<T>(action: () => Promise<T>): Promise<T> {
    return withLock(this.file("desk.lock"), action);
  }

  jobs(): AgentJob[] {
    let log = "";
    try {
      log = readFileSync(this.options.agentLog, "utf8");
    } catch {
      // No log yet: the agent has asked for nothing.
    }
    return agentJobs(log, this.now());
  }

  budget(jobs = this.jobs()): Budget {
    const governance = this.options.governance
      ? readJsonIfPresent<unknown>(this.options.governance)
      : undefined;
    return budgetOf(governance, jobs);
  }

  pooled(): Record<string, SharedNonce[]> {
    return readJsonIfPresent<Record<string, SharedNonce[]>>(this.file("nonces.json")) ?? {};
  }

  payment(jobId: string): DeskPayment | undefined {
    ensure(/^[0-9a-f]{64}$/.test(jobId), "INVALID", "job id");
    return readJsonIfPresent<DeskPayment>(this.file("payments", `${jobId}.json`));
  }

  journal(jobId: string): SpendJournal | undefined {
    return readJsonIfPresent<SpendJournal>(this.file("payments", `${jobId}.spend.json`));
  }

  private save(payment: DeskPayment) {
    payment.updatedAt = this.now();
    writeJson(this.file("payments", `${payment.jobId}.json`), payment);
  }

  /** What the console needs to know about the hive: its keepers, its treasury and where to check them. */
  describe() {
    const pooled = this.pooled();
    return {
      hive: this.hive,
      network: this.record.network,
      deployment: {
        arkdUrl: this.record.deployment.arkdUrl,
        delegateeUrl: this.record.deployment.delegateeUrl,
        ...(this.record.deployment.emulatorUrl ? { emulatorUrl: this.record.deployment.emulatorUrl } : {}),
      },
      keepers: this.keepers,
      treasury: {
        address: this.record.treasuryAddress,
        script: this.record.treasuryScript,
        terms: this.record.treasury,
      },
      nonces: Object.fromEntries(this.keepers.map((k) => [k, pooled[k]?.length ?? 0])),
    };
  }

  /** The listing waiting for the keepers' signatures, if any. */
  listing(): PendingListing | null {
    return readJsonIfPresent<PendingListing>(this.paths.local("listings", "pending.json")) ?? null;
  }

  async signListing(keeper: string, signature: string) {
    return this.lock(async () => signPendingListing(this.hive, keeper, signature));
  }

  /** A keeper's console shares nonces for later sessions. Each batch is signed by the keeper's key. */
  async addNonces(batch: NonceBatch) {
    ensure(verifyNonceBatch(batch), "INVALID", "a nonce batch its keeper did not sign");
    ensure(this.keepers.includes(batch.keeper), "NOT_A_KEEPER");
    return this.lock(async () => {
      const pooled = this.pooled();
      const have = pooled[batch.keeper] ?? [];
      const seen = new Set(have.map((n) => n.id));
      const used = new Set(readJsonIfPresent<string[]>(this.file("used-nonces.json")) ?? []);
      const fresh = batch.nonces.filter((n) => !seen.has(n.id) && !used.has(n.id));
      pooled[batch.keeper] = [...have, ...fresh].slice(-MAX_POOLED);
      writeJson(this.file("nonces.json"), pooled);
      return { keeper: batch.keeper, pooled: pooled[batch.keeper]!.length };
    });
  }

  /** Hands out a keeper's shared nonces once each; a nonce given to a session is never given again. */
  private take(keeper: string) {
    return (count: number): SharedNonce[] => {
      const pooled = this.pooled();
      const have = pooled[keeper] ?? [];
      const taken = have.slice(0, count);
      if (taken.length < count) return [];
      pooled[keeper] = have.slice(count);
      writeJson(this.file("nonces.json"), pooled);
      const used = readJsonIfPresent<string[]>(this.file("used-nonces.json")) ?? [];
      writeJson(this.file("used-nonces.json"), [...used, ...taken.map((n) => n.id)].slice(-10_000));
      return taken;
    };
  }

  private verifyAuth(action: string, jobId: string, auth: DeskAuth) {
    ensure(this.keepers.includes(auth?.keeper), "NOT_A_KEEPER");
    ensure(
      Number.isSafeInteger(auth.at) && Math.abs(this.now() - auth.at) <= AUTH_WINDOW_SECONDS,
      "AUTH_STALE",
      "the console's clock is off, or the request is old",
    );
    ensure(
      /^[0-9a-f]{128}$/.test(auth.signature ?? "") &&
        schnorr.verify(
          unhex(auth.signature),
          deskAuthDigest(this.hive, action, jobId, auth.at),
          unhex(auth.keeper.slice(2)),
        ),
      "AUTH_INVALID",
    );
  }

  /** The jobs waiting for the keepers, each with what the budget has left and the payment's progress. */
  overview() {
    const jobs = this.jobs();
    const budget = this.budget(jobs);
    const files = (() => {
      try {
        return readdirSync(this.file("payments")).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
      } catch {
        return [];
      }
    })();
    const known = new Set(files.map((f) => f.slice(0, 64)));
    const payments = jobs
      .filter((j) => j.status === "awaiting_funding" || known.has(j.request.jobId))
      .map((j) => ({ job: j, payment: this.payment(j.request.jobId) ?? null }));
    return { budget, payments };
  }

  /** The sessions a keeper's console signs, with the purpose each one checks. */
  sessions(payment: DeskPayment) {
    const journal = this.journal(payment.jobId);
    ensure(journal, "JOURNAL_MISSING");
    const attest = {
      id: journal.sessions.attest,
      pair: payment.pair,
      purpose: {
        kind: "payment" as const,
        stage: "attest" as const,
        request: payment.request,
        plan: journal.plan,
      },
    };
    const register = journal.attestations
      ? {
          id: journal.sessions.register,
          pair: payment.pair,
          purpose: {
            kind: "payment" as const,
            stage: "register" as const,
            request: payment.request,
            plan: journal.plan,
            signatures: journal.attestations,
          },
        }
      : null;
    return { attest, register, txid: journal.txid ?? journal.arkTxid ?? null };
  }

  /**
   * A keeper starts a payment: the desk plans the send for that keeper and a partner who has shared
   * nonces, the one asked for if any, and opens the attest session over the partner's nonces.
   */
  async start(jobId: string, auth: DeskAuth, partner?: string) {
    this.verifyAuth("start", jobId, auth);
    return this.lock(async () => {
      const existing = this.payment(jobId);
      ensure(
        !existing || ["expired", "cancelled", "failed"].includes(existing.status),
        "PAYMENT_STARTED",
        "this job's payment is already under way",
      );
      const job = this.jobs().find((j) => j.request.jobId === jobId);
      ensure(
        job && job.status === "awaiting_funding",
        "NOT_WAITING",
        "the agent is not waiting for this job's funding",
      );
      const request = job.request;
      const escrow = jobEscrow(this.treasury.conn, request.params);
      ensure(escrow.address === request.address.toLowerCase(), "ESCROW_MISMATCH");
      const budget = this.budget();
      ensure(request.capSats <= budget.remainingSats, "ABOVE_BUDGET", `${budget.remainingSats} sats left`);
      const first = auth.keeper;
      const pooled = this.pooled();
      const others = this.keepers.filter((k) => k !== first);
      const candidates = partner
        ? [partner]
        : others.sort((a, b) => (pooled[b]?.length ?? 0) - (pooled[a]?.length ?? 0));
      const second = candidates.find((k) => others.includes(k) && (pooled[k]?.length ?? 0) >= 16);
      ensure(
        second,
        "NO_PARTNER",
        partner
          ? "that keeper has no nonces shared here yet: they need to open the console once"
          : "no other keeper has opened the console yet, so nobody can sign with you",
      );
      const pair = PAIRS.find((p) => {
        const [i, j] = pairMembers(p);
        const keys = [this.keepers[i], this.keepers[j]];
        return keys.includes(first) && keys.includes(second);
      })!;
      const validSeconds = Math.min(
        KEEPER_MAX_VALIDITY_SECONDS,
        request.deadline - (this.options.deadlineMarginSeconds ?? DEADLINE_MARGIN_SECONDS) - this.now(),
      );
      ensure(
        validSeconds > (this.options.minimumValiditySeconds ?? 600),
        "PAYMENT_LATE",
        "too close to the job's deadline for two keepers to sign",
      );
      // Coins another payment is signing for stay out of this one.
      const exclude = this.activePayments()
        .filter((p) => p.jobId !== jobId)
        .flatMap((p) => this.journal(p.jobId)?.plan.coins.map((c) => `${c.txid}:${c.vout}`) ?? []);
      const plan = await planTreasurySend(this.treasury, {
        pair,
        amount: request.capSats,
        destination: escrow.pkScript,
        validSeconds,
        exclude,
      });
      const journal = newSpendJournal(`desk-${jobId.slice(0, 16)}`, { kind: "payment", request }, plan);
      writeJson(this.file("payments", `${jobId}.spend.json`), journal);
      const account = treasuryAccountOf(this.treasury);
      const attest = newSession(
        this.keepers,
        pair,
        sendMessages(journal.plan, account.instance, this.treasury.conn.operator.checkpointTapscript),
      );
      assignShared(attest, second, this.take(second));
      const payment: DeskPayment = {
        schema: "hive-desk-payment/v1",
        jobId,
        request,
        remainingSats: budget.remainingSats,
        pair,
        first,
        second,
        attest,
        status: "attesting",
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.save(payment);
      return payment;
    });
  }

  activePayments(): DeskPayment[] {
    try {
      return readdirSync(this.file("payments"))
        .filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
        .map((f) => this.payment(f.slice(0, 64))!)
        .filter(
          (p) => p && (p.status === "attesting" || p.status === "registering" || p.status === "submitted"),
        );
    } catch {
      return [];
    }
  }

  /**
   * A keeper's signature for one session: the first keeper's comes with their own nonces, over the
   * other's shared ones; the second's uses the nonces they shared. Each partial is checked against
   * the pair's key before it is kept. Once attest is complete, the register session opens over the
   * first keeper's shared nonces; once register is complete, the payment goes to the delegatee.
   */
  async sign(
    jobId: string,
    body: { keeper: string; stage: "attest" | "register"; nonces?: string[]; partials: string[] },
  ) {
    return this.lock(async () => {
      const payment = this.payment(jobId);
      ensure(payment, "NO_PAYMENT", "nobody has started this payment");
      this.expireIfLate(payment);
      ensure(
        payment.status === "attesting" || payment.status === "registering",
        "WRONG_ROUND",
        payment.status,
      );
      const journal = this.journal(jobId)!;
      if (body.stage === "attest") {
        ensure(payment.status === "attesting", "WRONG_ROUND", "attest is complete");
        recordSignature(payment.attest, this.keepers, body.keeper, {
          ...(body.nonces ? { nonces: body.nonces } : {}),
          partials: body.partials,
        });
        if (payment.attest.signatures) {
          journal.attestations = payment.attest.signatures;
          journal.status = "attested";
          writeJson(this.file("payments", `${jobId}.spend.json`), journal);
          payment.register = newSession(this.keepers, payment.pair, [
            registrationMessage(this.treasury, journal),
          ]);
          assignShared(payment.register, payment.first, this.take(payment.first));
          payment.status = "registering";
        }
      } else {
        ensure(payment.status === "registering" && payment.register, "WRONG_ROUND", "attest is not complete");
        if (!payment.register.nonces[payment.first] && !body.nonces)
          assignShared(payment.register, payment.first, this.take(payment.first));
        recordSignature(payment.register, this.keepers, body.keeper, {
          ...(body.nonces ? { nonces: body.nonces } : {}),
          partials: body.partials,
        });
        if (payment.register.signatures) {
          registerSigned(
            this.treasury,
            journal,
            payment.register.signatures[0]!,
            this.options.routes ?? ["delegatee"],
          );
          writeJson(this.file("payments", `${jobId}.spend.json`), journal);
          payment.status = "submitted";
        }
      }
      this.save(payment);
      if (payment.status === "submitted") this.drive(jobId);
      return payment;
    });
  }

  /** The keeper who started a payment, or the other one, gives up on it before it is submitted. */
  async cancel(jobId: string, auth: DeskAuth) {
    this.verifyAuth("cancel", jobId, auth);
    return this.lock(async () => {
      const payment = this.payment(jobId);
      ensure(payment, "NO_PAYMENT");
      ensure(auth.keeper === payment.first || auth.keeper === payment.second, "NOT_IN_PAIR");
      ensure(
        payment.status === "attesting" || payment.status === "registering",
        "WRONG_ROUND",
        payment.status,
      );
      payment.status = "cancelled";
      const journal = this.journal(jobId);
      if (journal && !journal.request) {
        journal.status = "expired";
        writeJson(this.file("payments", `${jobId}.spend.json`), journal);
      }
      this.save(payment);
      return payment;
    });
  }

  private expireIfLate(payment: DeskPayment) {
    const journal = this.journal(payment.jobId);
    if (
      journal &&
      (payment.status === "attesting" || payment.status === "registering") &&
      this.now() >= journal.plan.validUntil - 60
    ) {
      payment.status = "expired";
      this.save(payment);
    }
  }

  /** Executes a submitted payment until its outcome is observed; a pending one is tried again later. */
  drive(jobId: string): Promise<void> {
    const running = this.#drives.get(jobId);
    if (running) return running;
    const run = (async () => {
      try {
        const journal = await driveTreasurySpend(
          this.treasury,
          this.file("payments", `${jobId}.spend.json`),
          {
            routes: this.options.routes ?? ["delegatee"],
            timeoutMs: 60_000,
          },
        );
        await this.lock(async () => {
          const payment = this.payment(jobId)!;
          payment.status = journal.status === "done" ? "done" : "expired";
          this.save(payment);
        });
      } catch (error) {
        if (faultCode(error) === "SPEND_PENDING") return;
        await this.lock(async () => {
          const payment = this.payment(jobId)!;
          payment.status = "failed";
          payment.detail = faultCode(error) ?? String(error);
          this.save(payment);
        });
      } finally {
        this.#drives.delete(jobId);
      }
    })();
    this.#drives.set(jobId, run);
    return run;
  }

  /** One pass over open payments: late ones expire, submitted ones are driven on. */
  async tick() {
    for (const payment of this.activePayments()) {
      if (payment.status === "submitted") await this.drive(payment.jobId);
      else await this.lock(async () => this.expireIfLate(this.payment(payment.jobId)!));
    }
  }
}

/** Serves the desk over HTTP for keepers' consoles; the host's TLS proxy puts it on HTTPS. */
export async function startDesk(hive: string, options: DeskOptions, ctx: OpsContext = {}) {
  const treasury = await treasuryOf(loadHive(hive), ctx);
  const desk = new Desk(hive, treasury, options);
  const allowed = (origin: string | undefined) =>
    !origin || !options.origins?.length || options.origins.includes(origin) ? (origin ?? "*") : null;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = allowed(req.headers.origin);
    if (origin === null) return sendJson(res, 403, { error: "ORIGIN" });
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      return res.end();
    }
    try {
      const url = new URL(req.url ?? "/", "http://desk");
      const parts = url.pathname.split("/").filter(Boolean);
      ensure(parts[0] === "desk" && parts[1] === "v1", "NOT_FOUND");
      const body =
        req.method === "POST" ? ((await readJsonBody(req, 256 * 1024)) as Record<string, unknown>) : {};
      if (req.method === "GET" && parts[2] === "hive") return sendJson(res, 200, desk.describe());
      // The delegatee serves no browser: its keys reach the console through the desk, and the
      // console checks the treasury they build against the hive's.
      if (req.method === "GET" && parts[2] === "delegatee")
        return sendJson(res, 200, await treasury.conn.delegatee.info());
      if (req.method === "POST" && parts[2] === "nonces")
        return sendJson(res, 200, await desk.addNonces(body.batch as NonceBatch));
      if (req.method === "GET" && parts[2] === "payments" && !parts[3])
        return sendJson(res, 200, desk.overview());
      if (req.method === "GET" && parts[2] === "listing")
        return sendJson(res, 200, { pending: desk.listing() });
      if (req.method === "POST" && parts[2] === "listing")
        return sendJson(res, 200, await desk.signListing(String(body.keeper), String(body.signature)));
      const jobId = parts[3] ?? "";
      if (req.method === "GET" && parts[2] === "payments") {
        const payment = desk.payment(jobId);
        ensure(payment, "NO_PAYMENT");
        return sendJson(res, 200, { payment, sessions: desk.sessions(payment) });
      }
      if (req.method === "POST" && parts[2] === "payments" && parts[4] === "start") {
        const payment = await desk.start(jobId, body.auth as DeskAuth, body.partner as string | undefined);
        return sendJson(res, 200, { payment, sessions: desk.sessions(payment) });
      }
      if (req.method === "POST" && parts[2] === "payments" && parts[4] === "sign") {
        const payment = await desk.sign(jobId, body as never);
        return sendJson(res, 200, { payment, sessions: desk.sessions(payment) });
      }
      if (req.method === "POST" && parts[2] === "payments" && parts[4] === "cancel")
        return sendJson(res, 200, { payment: await desk.cancel(jobId, body.auth as DeskAuth) });
      throw new Fault("NOT_FOUND");
    } catch (error) {
      const code = faultCode(error) ?? "INTERNAL";
      const status = code === "NOT_FOUND" || code === "NO_PAYMENT" ? 404 : code === "INTERNAL" ? 500 : 400;
      sendJson(res, status, { error: code, detail: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => ready());
  });
  const address = server.address();
  ensure(address && typeof address !== "string", "LISTEN_FAILED");
  const timer = setInterval(() => void desk.tick().catch(() => {}), options.tickMs ?? 15_000);
  return {
    desk,
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    async close() {
      clearInterval(timer);
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
