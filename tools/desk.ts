/**
 * What a hive's desk reads on its host, whichever treasury the hive has: the jobs its agent asks the
 * keepers to fund, from the agent's log, and what approved work has left, from the hive's governance.
 * The approvals desk of a v5 hive (`tools/approvals-desk.ts`) is built on these.
 *
 * The signing desk of the v4 keepers' treasury, which keepers' consoles called over HTTP, went with
 * the keeper console: a hive built for it signs with the console and desk of commit ffb0839.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { faultCode } from "@hive/kit";
import type { FundingRequest } from "@hive/steward";

export interface AgentJob {
  request: FundingRequest;
  /** The provider's mesh peer: the only one whose word about the job counts. */
  peer: string;
  status: "awaiting_funding" | "open" | "claimed" | "returned" | "declined" | "lapsed";
  usedSats: number;
  requestedAt: number;
}

/** One line of the agent's log, taken into the jobs read so far. */
function takeLine(jobs: Map<string, AgentJob>, line: string): void {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (!e || typeof e !== "object") return;
  const at = Number(e.at ?? 0);
  if (e.event === "funding_requested" && e.request && typeof e.request === "object") {
    const r = e.request as Record<string, unknown>;
    const params = r.params as FundingRequest["params"] | undefined;
    if (!params) return;
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
    jobs.set(request.jobId, {
      request,
      peer: String(r.provider_peer ?? ""),
      status: "awaiting_funding",
      usedSats: 0,
      requestedAt: at,
    });
    return;
  }
  const job = jobs.get(String(e.job_id ?? (e.message as Record<string, unknown> | undefined)?.job_id ?? ""));
  if (!job) return;
  if (e.event === "job_open") job.status = "open";
  else if (e.event === "receipt_signed") job.usedSats = Math.max(job.usedSats, Number(e.amount_sats ?? 0));
  else if (e.event === "job_closed" && e.txid) job.status = "claimed";
  else if (e.event === "expired") job.status = "returned";
  else if (
    e.event === "received" &&
    (e.message as Record<string, unknown>)?.kind === "decline" &&
    e.from === job.peer
  )
    job.status = job.status === "awaiting_funding" ? "declined" : job.status;
}

/** The jobs as they stand at `now`, newest first: one still waiting past its deadline has lapsed. */
function jobsAt(jobs: Map<string, AgentJob>, now: number): AgentJob[] {
  return [...jobs.values()]
    .map((job) =>
      job.status === "awaiting_funding" && now >= job.request.deadline
        ? { ...job, status: "lapsed" as const }
        : { ...job },
    )
    .sort((a, b) => b.requestedAt - a.requestedAt);
}

/** The agent's jobs, from its pay-arkade event log; requests without their escrow's terms are left out. */
export function agentJobs(log: string, now = Math.floor(Date.now() / 1000)): AgentJob[] {
  const jobs = new Map<string, AgentJob>();
  for (const line of log.split("\n")) takeLine(jobs, line);
  return jobsAt(jobs, now);
}

/**
 * The agent's log as a desk follows it: the log only grows, so each look reads what it gained since
 * the last one and no more, however long it has become.
 */
export class AgentLog {
  #offset = 0;
  #rest = "";
  #jobs = new Map<string, AgentJob>();
  // A character cut across two reads is put back together, not read as two broken halves.
  #decoder = new StringDecoder("utf8");

  constructor(readonly path: string) {}

  jobs(now: number): AgentJob[] {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      // No log yet: the agent has asked for nothing.
      return [];
    }
    try {
      const { size } = fstatSync(fd);
      // A log shorter than what was read is another log: read from its start.
      if (size < this.#offset) {
        this.#offset = 0;
        this.#rest = "";
        this.#jobs = new Map();
        this.#decoder = new StringDecoder("utf8");
      }
      const chunk = Buffer.alloc(Math.min(size - this.#offset, 1024 * 1024));
      while (this.#offset < size) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - this.#offset), this.#offset);
        if (n <= 0) break;
        this.#offset += n;
        const lines = (this.#rest + this.#decoder.write(chunk.subarray(0, n))).split("\n");
        // A line still being written is kept for the next look.
        this.#rest = lines.pop() ?? "";
        for (const line of lines) takeLine(this.#jobs, line);
      }
    } finally {
      closeSync(fd);
    }
    return jobsAt(this.#jobs, now);
  }
}

/** What the hive's approved work has left for new jobs, from its proposals and the jobs already open. */
export interface Budget {
  approvedLeftSats: number;
  lockedSats: number;
  /** Job payments open or just paid, which the agent's log does not count yet; the approvals desk's. */
  underWaySats?: number;
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

/** What a desk is told about its host: where the agent logs, where the hive's governance is kept, and its timing. */
export interface DeskOptions {
  agentLog: string;
  governance?: string;
  tickMs?: number;
  now?: () => number;
  /**
   * How long before the job's deadline a payment's approvals lapse, and the least time two keepers
   * get to approve: ten minutes each by default, shorter only for a rehearsal on regtest.
   */
  deadlineMarginSeconds?: number;
  minimumValiditySeconds?: number;
}

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  NO_PAYMENT: 404,
  NO_HIVE: 404,
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  AUTH_STALE: 401,
  RATE_LIMITED: 429,
  BUSY: 429,
  REQUEST_TOO_LARGE: 413,
  SERVICE_FULL: 503,
  INTERNAL: 500,
};

/** A fault as an HTTP status: unknown things are 404, our own mistakes 500, the rest the caller's. */
export function faultStatus(error: unknown): { status: number; body: { error: string; detail: string } } {
  const code = faultCode(error) ?? "INTERNAL";
  // The channel's own refusals carry their status with them.
  const own = (error as { status?: unknown } | null)?.status;
  const status =
    code === "INTERNAL" && typeof own === "number" && own >= 400 && own < 500 ? own : (STATUS[code] ?? 400);
  return { status, body: { error: code, detail: error instanceof Error ? error.message : String(error) } };
}
