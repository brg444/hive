import { resolve } from "node:path";
import {
  type Checkpoint,
  ensure,
  exactObject,
  faultCode,
  isFault,
  lockedQueue,
  nowIso,
  nowSeconds,
  readJson,
  readJsonIfPresent,
  sha256Hex,
  stateExists,
  unixNow,
  writeJson,
  writeOnce,
} from "@hive/kit";
import {
  canonicalJson,
  METERED_PROFILE,
  type MeteredChallenge,
  type MeteredChallengeBody,
  type MeteredContext,
  quoteCostSats,
  receiptSha256,
  requireValidReceipt,
  type SignedQuote,
  type SignedReceipt,
  validateMeteredChallenge,
} from "@hive/protocol";
import type { ChallengeSigner } from "../challenge.js";
import {
  callUpstream,
  type PreparedRequest,
  prepareRequest,
  type RetainedOutput,
  type SidecarLimits,
  verifyRetainedOutput,
} from "./upstream.js";

export type RequestState =
  | "prepared"
  | "running"
  | "ready"
  | "receipted"
  | "cancelled"
  | "failed"
  | "indeterminate";

export interface RequestStatus {
  requestId: string;
  status: RequestState;
  challenge?: MeteredChallenge;
  error?: string;
}

export interface MeterTotals {
  frozen: boolean;
  latestReceipt: SignedReceipt | null;
  cumulativeInputTokens: string;
  cumulativeOutputTokens: string;
  sequence: string;
}

interface Entry extends RequestStatus {
  requestSha256: string;
  dispatchedAt?: string;
  receipt?: SignedReceipt;
}

interface Ledger extends MeterTotals {
  schema: "hive-sidecar-ledger/v4";
  configurationSha256: string;
  activeRequestId: string | null;
  requests: Record<string, Entry>;
}

export interface MeterOptions {
  quote: SignedQuote;
  upstream: URL;
  limits: SidecarLimits;
  directory: string;
  /** Binds the ledger to one quote, upstream, limit set and bearer token. */
  configurationSha256: string;
  signer: ChallengeSigner;
  checkpoint: Checkpoint;
}

const OPEN: RequestState[] = ["prepared", "running", "ready"];
const MAX_REQUESTS = 256;

/**
 * One escrow's metering ledger. A request moves prepared → running → ready
 * (challenge signed) → receipted, one at a time; its output is released only
 * after the payer's receipt for the challenged amount is saved.
 */
export class Meter {
  readonly #options: MeterOptions;
  readonly #locked: <T>(action: () => Promise<T>) => Promise<T>;
  readonly #jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  #stopped = false;

  private constructor(options: MeterOptions) {
    this.#options = options;
    this.#locked = lockedQueue(this.#path("ledger.lock"));
  }

  /** Open or create the ledger; a run interrupted mid-request becomes ready or indeterminate. */
  static async open(options: MeterOptions): Promise<Meter> {
    const meter = new Meter(options);
    await meter.#locked(async () => {
      const ledger = stateExists(meter.#path("ledger.json"))
        ? meter.#read()
        : ({
            schema: "hive-sidecar-ledger/v4",
            configurationSha256: options.configurationSha256,
            frozen: false,
            latestReceipt: null,
            sequence: "0",
            cumulativeInputTokens: "0",
            cumulativeOutputTokens: "0",
            activeRequestId: null,
            requests: {},
          } satisfies Ledger);
      for (const entry of Object.values(ledger.requests)) {
        if (entry.status !== "running") continue;
        if (stateExists(meter.#path(`${entry.requestId}.output.json`)) && !ledger.frozen) {
          try {
            await meter.#retainReady(ledger, entry);
          } catch {
            meter.#settle(ledger, entry, "failed", "RETAINED_OUTPUT_INVALID");
          }
        } else meter.#settle(ledger, entry, "indeterminate", "UPSTREAM_INTERRUPTED");
      }
      meter.#write(ledger);
    });
    return meter;
  }

  async prepare(id: string, requestBase64: unknown, requestedDefault?: unknown): Promise<RequestStatus> {
    const { limits, quote } = this.#options;
    ensure(typeof requestBase64 === "string", "INVALID_REQUEST");
    const bytes = Buffer.from(requestBase64, "base64");
    ensure(
      bytes.length > 0 &&
        bytes.length <= limits.maxRequestBytes &&
        bytes.toString("base64") === requestBase64,
      "INVALID_REQUEST_BYTES",
    );
    const requested = requestedDefault ?? limits.maxOutputTokens;
    ensure(
      typeof requested === "number" &&
        Number.isSafeInteger(requested) &&
        requested > 0 &&
        requested <= 65_536,
      "TOKEN_LIMIT",
    );
    const defaultOutputTokens = Math.min(requested, limits.maxOutputTokens);
    const requestSha256 = sha256Hex(bytes);
    const status = await this.#locked(async () => {
      const ledger = this.#read();
      this.#expirePending(ledger);
      const existing = ledger.requests[id];
      if (existing) {
        ensure(existing.requestSha256 === requestSha256, "REQUEST_MUTATION");
        const prepared = this.#prepared(id);
        ensure(
          prepared.requestBase64 === requestBase64 && prepared.defaultOutputTokens === defaultOutputTokens,
          "REQUEST_MUTATION",
        );
        return view(existing);
      }
      ensure(!ledger.frozen, "ESCROW_FROZEN");
      this.#beforeDeadline();
      const runway = BigInt(Math.ceil(limits.requestTimeoutMs / 1000) + limits.deadlineGuardSeconds);
      ensure(nowSeconds() + runway < BigInt(quote.body.timeoutAt), "INSUFFICIENT_DEADLINE");
      ensure(ledger.activeRequestId === null, "ESCROW_BUSY");
      ensure(Object.keys(ledger.requests).length < MAX_REQUESTS, "REQUEST_LIMIT");
      writeOnce(
        this.#path(`${id}.request.json`),
        prepareRequest(bytes, quote.body.model, limits, defaultOutputTokens),
      );
      await this.#options.checkpoint("sidecar.request.persisted");
      const entry: Entry = { requestId: id, status: "prepared", requestSha256 };
      ledger.requests[id] = entry;
      ledger.activeRequestId = id;
      this.#write(ledger);
      await this.#options.checkpoint("sidecar.prepared.persisted");
      return view(entry);
    });
    if (status.status === "prepared") this.#schedule(id);
    return status;
  }

  status(id: string): Promise<RequestStatus> {
    return this.#locked(async () => {
      const ledger = this.#read();
      this.#expirePending(ledger);
      const entry = ledger.requests[id];
      ensure(entry, "UNKNOWN_REQUEST");
      return view(entry);
    });
  }

  totals(): Promise<MeterTotals> {
    return this.#locked(async () => {
      const ledger = this.#read();
      this.#expirePending(ledger);
      return totals(ledger);
    });
  }

  /** Accept the payer's receipt for the ready challenge and advance the cumulative totals. */
  commit(id: string, value: unknown): Promise<RequestStatus> {
    const raw = exactObject(value, ["challengeId", "receipt"], "receipt commitment");
    const { quote } = this.#options;
    return this.#locked(async () => {
      const ledger = this.#read();
      const entry = ledger.requests[id];
      ensure(entry, "UNKNOWN_REQUEST");
      if (entry.status === "receipted") {
        ensure(
          entry.challenge?.challengeId === raw.challengeId &&
            canonicalJson(entry.receipt) === canonicalJson(raw.receipt),
          "RECEIPT_MUTATION",
        );
        return view(entry);
      }
      ensure(!ledger.frozen, "ESCROW_FROZEN");
      this.#beforeDeadline();
      ensure(
        entry.status === "ready" && entry.challenge && ledger.activeRequestId === id,
        "OUTPUT_NOT_READY",
      );
      ensure(entry.challenge.challengeId === raw.challengeId, "CHALLENGE_MISMATCH");
      const checked = validateMeteredChallenge(entry.challenge, quote, {
        ...this.#context(ledger, entry),
        nowSeconds: unixNow(),
      });
      let receipt: SignedReceipt;
      try {
        receipt = requireValidReceipt(raw.receipt, {
          escrowId: quote.quoteId,
          payerReceiptKey: quote.body.payerReceiptKey,
          capSats: quote.body.capSats,
        });
      } catch {
        ensure(false, "INVALID_RECEIPT");
      }
      ensure(receipt.amountSats === checked.amountSats, "RECEIPT_AMOUNT_MISMATCH");
      if (ledger.latestReceipt?.amountSats === receipt.amountSats) {
        ensure(
          canonicalJson(receipt) === canonicalJson(ledger.latestReceipt),
          "UNCHANGED_AMOUNT_REQUIRES_SAVED_RECEIPT",
        );
      }
      entry.status = "receipted";
      entry.receipt = receipt;
      ledger.latestReceipt = receipt;
      ledger.sequence = checked.sequence;
      ledger.cumulativeInputTokens = checked.cumulativeInputTokens;
      ledger.cumulativeOutputTokens = checked.cumulativeOutputTokens;
      ledger.activeRequestId = null;
      this.#write(ledger);
      await this.#options.checkpoint("sidecar.receipt.persisted");
      return view(entry);
    });
  }

  /** Cancel one open request. */
  cancel(id: string): Promise<RequestStatus> {
    return this.#locked(async () => {
      const ledger = this.#read();
      const entry = ledger.requests[id];
      ensure(entry, "UNKNOWN_REQUEST");
      if (OPEN.includes(entry.status)) this.#abort(ledger, entry, "CANCELLED");
      this.#write(ledger);
      await this.#options.checkpoint("sidecar.cancel.persisted");
      return view(entry);
    });
  }

  /** Stop all further authorization; the claim uses the totals this returns. */
  freeze(): Promise<MeterTotals> {
    return this.#locked(async () => {
      const ledger = this.#read();
      ledger.frozen = true;
      const entry = ledger.requests[ledger.activeRequestId ?? ""];
      if (entry && OPEN.includes(entry.status)) this.#abort(ledger, entry, "ESCROW_FROZEN");
      this.#write(ledger);
      await this.#options.checkpoint("sidecar.freeze.persisted");
      return totals(ledger);
    });
  }

  /** The paid output, only once its receipt is saved. */
  async output(id: string): Promise<{ bytes: Buffer; contentType: string; challengeId: string }> {
    const entry = this.#read().requests[id];
    ensure(entry?.status === "receipted" && entry.challenge && entry.receipt, "RECEIPT_REQUIRED");
    const output = readJson<RetainedOutput>(this.#path(`${id}.output.json`));
    const bytes = Buffer.from(output.responseBase64, "base64");
    ensure(
      sha256Hex(bytes) === entry.challenge.responseSha256 &&
        output.contentType === entry.challenge.contentType &&
        bytes.length <= this.#options.limits.maxResponseBytes,
      "OUTPUT_CORRUPTED",
    );
    await this.#options.checkpoint("sidecar.output.before-release");
    return { bytes, contentType: output.contentType, challengeId: entry.challenge.challengeId };
  }

  /** Abort running upstream calls; an interrupted request is recorded as indeterminate. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const job of this.#jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.#jobs.values()].map((job) => job.promise));
  }

  #path(name: string): string {
    return resolve(this.#options.directory, name);
  }

  #read(): Ledger {
    const ledger = readJson<Ledger>(this.#path("ledger.json"));
    ensure(
      ledger.schema === "hive-sidecar-ledger/v4" &&
        ledger.configurationSha256 === this.#options.configurationSha256,
      "CONFIGURATION_CHANGED",
    );
    return ledger;
  }

  #write(ledger: Ledger): void {
    writeJson(this.#path("ledger.json"), ledger);
  }

  #prepared(id: string): PreparedRequest {
    return readJson<PreparedRequest>(this.#path(`${id}.request.json`));
  }

  #beforeDeadline(): void {
    const { limits, quote } = this.#options;
    ensure(
      nowSeconds() + BigInt(limits.deadlineGuardSeconds) < BigInt(quote.body.timeoutAt),
      "ESCROW_DEADLINE",
    );
  }

  #settle(ledger: Ledger, entry: Entry, status: RequestState, error: string): void {
    entry.status = status;
    entry.error = error;
    if (ledger.activeRequestId === entry.requestId) ledger.activeRequestId = null;
  }

  #abort(ledger: Ledger, entry: Entry, error: string): void {
    this.#settle(ledger, entry, "cancelled", error);
    this.#jobs.get(entry.requestId)?.controller.abort();
  }

  /** An open request that reaches the deadline guard can no longer be paid. */
  #expirePending(ledger: Ledger): void {
    const entry = ledger.requests[ledger.activeRequestId ?? ""];
    const { limits, quote } = this.#options;
    if (
      entry &&
      OPEN.includes(entry.status) &&
      nowSeconds() + BigInt(limits.deadlineGuardSeconds) >= BigInt(quote.body.timeoutAt)
    ) {
      this.#settle(ledger, entry, "failed", "BUFFER_EXPIRED");
      this.#jobs.get(entry.requestId)?.controller.abort();
      this.#write(ledger);
    }
  }

  #context(ledger: Ledger, entry: Entry): Omit<MeteredContext, "nowSeconds"> {
    const prepared = this.#prepared(entry.requestId);
    return {
      requestId: entry.requestId,
      requestSha256: entry.requestSha256,
      previousReceipt: ledger.latestReceipt,
      sequence: ledger.sequence,
      cumulativeInputTokens: ledger.cumulativeInputTokens,
      cumulativeOutputTokens: ledger.cumulativeOutputTokens,
      requestLimits: {
        maxInputTokens: String(prepared.maxInputTokens),
        maxOutputTokens: String(prepared.maxTokens),
        maxRequestSats: this.#options.quote.body.capSats,
      },
    };
  }

  async #challenge(ledger: Ledger, entry: Entry, output: RetainedOutput): Promise<MeteredChallenge> {
    const { quote } = this.#options;
    const cumulativeInputTokens = (
      BigInt(ledger.cumulativeInputTokens) + BigInt(output.usage.inputTokens)
    ).toString();
    const cumulativeOutputTokens = (
      BigInt(ledger.cumulativeOutputTokens) + BigInt(output.usage.outputTokens)
    ).toString();
    let amount: bigint;
    try {
      amount = quoteCostSats(quote.body, cumulativeInputTokens, cumulativeOutputTokens);
    } catch {
      ensure(false, "USAGE_EXCEEDS_CAP");
    }
    ensure(amount > 0n, "ZERO_COST_RECEIPT_UNSUPPORTED");
    const body: MeteredChallengeBody = {
      profile: METERED_PROFILE,
      escrowId: quote.quoteId,
      requestId: entry.requestId,
      requestSha256: entry.requestSha256,
      responseSha256: output.responseSha256,
      contentType: output.contentType,
      ...output.usage,
      cumulativeInputTokens,
      cumulativeOutputTokens,
      amountSats: amount.toString(),
      sequence: (BigInt(ledger.sequence) + 1n).toString(),
      previousReceiptSha256: receiptSha256(ledger.latestReceipt),
    };
    const context = this.#context(ledger, entry);
    const challenge = await this.#options.signer.signChallenge({
      kind: "sign-metered-challenge",
      quote,
      body,
      context,
    });
    return validateMeteredChallenge(challenge, quote, { ...context, nowSeconds: unixNow() });
  }

  async #retainReady(ledger: Ledger, entry: Entry): Promise<void> {
    this.#beforeDeadline();
    const { limits, quote } = this.#options;
    const output = readJson<RetainedOutput>(this.#path(`${entry.requestId}.output.json`));
    verifyRetainedOutput(output, this.#prepared(entry.requestId), limits, quote.body.model);
    entry.challenge = await this.#challenge(ledger, entry, output);
    entry.status = "ready";
  }

  #schedule(id: string): void {
    if (this.#jobs.has(id)) return;
    const controller = new AbortController();
    const promise = this.#execute(id, controller).finally(() => this.#jobs.delete(id));
    this.#jobs.set(id, { controller, promise });
  }

  async #execute(id: string, controller: AbortController): Promise<void> {
    const { limits, quote, upstream, checkpoint } = this.#options;
    try {
      const prepared = await this.#locked(async () => {
        const ledger = this.#read();
        const entry = ledger.requests[id];
        ensure(
          entry?.status === "prepared" && ledger.activeRequestId === id && !ledger.frozen,
          "REQUEST_NOT_PREPARED",
        );
        this.#beforeDeadline();
        entry.status = "running";
        entry.dispatchedAt = nowIso();
        this.#write(ledger);
        await checkpoint("sidecar.dispatch.persisted");
        return this.#prepared(id);
      });
      const timer = setTimeout(() => controller.abort(), limits.requestTimeoutMs);
      let output: RetainedOutput;
      try {
        output = await callUpstream(upstream, prepared, limits, quote.body.model, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      await this.#locked(async () => {
        const ledger = this.#read();
        const entry = ledger.requests[id];
        if (entry?.status !== "running" || ledger.frozen) return;
        this.#beforeDeadline();
        writeOnce(this.#path(`${id}.output.json`), output);
        await checkpoint("sidecar.output.persisted");
        await this.#retainReady(ledger, entry);
        this.#write(ledger);
        await checkpoint("sidecar.challenge.persisted");
      });
    } catch (error) {
      await this.#locked(async () => {
        const ledger = readJsonIfPresent<Ledger>(this.#path("ledger.json"));
        const entry = ledger?.requests[id];
        if (!ledger || !entry || !["prepared", "running"].includes(entry.status)) return;
        const code = isFault(error)
          ? faultCode(error)
          : this.#stopped
            ? "UPSTREAM_INTERRUPTED"
            : "UPSTREAM_FAILED";
        this.#settle(ledger, entry, this.#stopped ? "indeterminate" : "failed", code);
        this.#write(ledger);
      }).catch(() => {});
    }
  }
}

function view(entry: Entry): RequestStatus {
  return {
    requestId: entry.requestId,
    status: entry.status,
    ...(entry.challenge ? { challenge: entry.challenge } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function totals(ledger: Ledger): MeterTotals {
  return {
    frozen: ledger.frozen,
    latestReceipt: ledger.latestReceipt,
    cumulativeInputTokens: ledger.cumulativeInputTokens,
    cumulativeOutputTokens: ledger.cumulativeOutputTokens,
    sequence: ledger.sequence,
  };
}
