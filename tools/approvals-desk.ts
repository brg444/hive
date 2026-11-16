/**
 * The approvals desk: where a v5 hive's payments wait for its keepers, run on the hive's host beside
 * the hive's agent. It holds no key that moves funds and decides nothing. It follows the hive's Buzz
 * channel, as the members' Hive plugins forward it to the host: each job the agent asks the keepers
 * to fund becomes a payment, and so does each withdrawal a keeper asks for in the channel. The
 * keepers approve a payment by sending its approval in the channel, hours apart and in any order;
 * once two have, the desk submits the payment itself through the Emulator. A keeper's decline stops
 * the desk from paying it. The desk also folds chip-ins and returned escrows into the treasury coin.
 *
 * One payment is open for the keepers at a time. A payment's number is the counter units the
 * treasury coin holds when it pays, and an approval names that number, so a payment approved under
 * two numbers could pay under both. The desk therefore gives a number to one payment only, the open
 * one, which takes the treasury's current count; the others wait their turn with no number and no
 * approvals asked. A payment gets another number only once the treasury has passed the one it had,
 * which is also when approvals sent under that number stop paying. Jobs take their turn before
 * withdrawals, each keeper has one withdrawal request waiting at most, and an open withdrawal nobody
 * else has approved steps aside for a job after a while.
 *
 * The desk checks each approval as the contract will before it counts it, and counts only the
 * messages still in the channel: an approval its keeper deleted no longer counts here. What became of
 * a payment is read from the transaction that spent the treasury coin, its recipient and amount, not
 * from the counter alone, since anyone holding two keepers' approvals may submit them.
 *
 * What the desk says about a payment is in the hive's state for every member to read, as the keepers'
 * approvals are in its channel. Each keeper's Hive plugin rebuilds every payment itself before it
 * offers the approval, from the job's own terms or the withdrawal's address: what the desk says is
 * never taken on its word.
 */
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type Connection,
  connect,
  type IndexedCoin,
  jobEscrow,
  networkCeilings,
  parseArkAddress,
  xOnly,
} from "@hive/ark";
import {
  type KnownCoin,
  mergeIntoTreasury,
  payFromTreasury,
  type TreasuryCoin,
  type TreasuryContract,
  treasuryCoins,
  unitsOn,
} from "@hive/executor";
import { ensure, hex, lockedQueue, readJsonIfPresent, unhex, writeJson } from "@hive/kit";
import { KEEPER_MAX_VALIDITY_SECONDS } from "@hive/steward";
import {
  ApprovalRefused,
  approvalHolds,
  approvalText,
  type BuzzEvent,
  buzzApproval,
  codeOf,
  declineText,
  eventIdHolds,
  eventSigned,
  MAX_AMOUNT_SATS,
  type Payment,
  payMessage,
  paymentWord,
  withdrawalOf,
} from "@hive/treasury";
import { type AgentJob, AgentLog, type Budget, budgetOf, type DeskOptions } from "./desk.js";
import { type HiveRecord, loadHive, opsPaths } from "./ops.js";
import { checkEmulator, type KeeperTreasury, v5Contract, v5Terms } from "./treasury-v5.js";

const DEADLINE_MARGIN_SECONDS = 600;
/** A payment the Emulator refused this many times, on a treasury coin that was there, is left to the keepers. */
const MAX_ATTEMPTS = 3;
/** How often one round tries again at once, when a merge or a renewal moved the coin under a payment. */
const RETRIES_PER_ROUND = 3;
/** A withdrawal's approvals lapse after this long, as does a request that never got its turn. */
const WITHDRAWAL_VALIDITY_SECONDS = KEEPER_MAX_VALIDITY_SECONDS;
/** How long an open withdrawal with fewer than two approvals keeps a waiting job waiting. */
const WITHDRAWAL_PATIENCE_SECONDS = 900;
/** A payment is not submitted this close to its lapse: the Emulator's clock decides, not ours. */
const SUBMIT_MARGIN_SECONDS = 30;
/** Finished payments stay with the live ones this long, then move to the archive. */
const FINISHED_KEEP_SECONDS = 7 * 86_400;
/** How many steps of the treasury coin's history one round follows. */
const MAX_TRACE = 64;

/** Reads coins from the Operator's indexer, by outpoint or by script. */
export type CoinLookup = (query: { outpoints?: string[]; scripts?: string[] }) => Promise<IndexedCoin[]>;

export interface ApprovalDeskOptions
  extends Pick<
    DeskOptions,
    "agentLog" | "governance" | "tickMs" | "now" | "deadlineMarginSeconds" | "minimumValiditySeconds"
  > {
  /** The hive's channel as the host keeps it: a JSON array of signed events. */
  events?: string;
  /** Where a desk running on its own writes its payments after each round, for hive-api to serve. */
  paymentsFile?: string;
  /** The Operator's indexer; the connection's own unless a test stands in. */
  lookup?: CoinLookup;
  /** How long an open withdrawal with fewer than two approvals keeps a job waiting. */
  patienceSeconds?: number;
}

/** One approval as the desk keeps it, hex, with the message it came in. */
interface StoredApproval {
  sig: string;
  time: string;
  tags: string;
  event: string;
}

/** A payment as the desk keeps it: what the keepers approve, and their approvals so far. */
export interface KeeperPayment {
  schema: "hive-desk-payment/v5";
  /** The job's id; a withdrawal's, the id of the message that asked for it. */
  id: string;
  request?: AgentJob["request"];
  withdrawal?: { destination: string; amountSats: number };
  /** The address the keepers read, and the program the payment output carries. */
  address: string;
  program: string;
  amountSats: number;
  /**
   * The payment's number: the counter units on the treasury coin when it pays. Null until the
   * payment's turn comes, and again once the treasury has passed the number it had.
   */
  left: string | null;
  /** When its approvals lapse; 0 while it has no number. */
  validUntil: number;
  /** One per keeper, in the hive's order. */
  approvals: (StoredApproval | null)[];
  /** The order payments started in: jobs take their turn in it, then withdrawals. */
  seq: number;
  /** What approved work had left when the payment's turn came, by the desk's count. */
  remainingSats: number;
  /** The keeper who asked for a withdrawal; "agent" for a job. */
  startedBy: string;
  status: "queued" | "approving" | "ready" | "submitted" | "done" | "lapsed" | "declined" | "failed";
  declinedBy?: string;
  attempts?: number;
  /** The treasury coin the desk last tried to pay it from. */
  tried?: string;
  /** When its turn last came. */
  openedAt?: number;
  /** When a withdrawal's request ends, turn or no turn. */
  expiresAt?: number;
  txid?: string;
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

type Status = KeeperPayment["status"];
/** The one payment the keepers are asked about, on its way to the treasury. */
const OPEN = new Set<Status>(["approving", "ready", "submitted"]);
const ACTIVE = new Set<Status>(["queued", "approving", "ready", "submitted"]);

/** A withdrawal request the desk did not take up, and why. */
interface Refusal {
  at: number;
  by: string;
  reason?: string;
}

const outpoint = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`;

export class ApprovalDesk {
  readonly paths: ReturnType<typeof opsPaths>;
  readonly record: HiveRecord;
  readonly v5: KeeperTreasury;
  readonly #queue: <T>(action: () => Promise<T>) => Promise<T>;
  readonly #log: AgentLog;
  /** Why a job waiting for funding has no payment yet, or why its payment still waits, as the last round found. */
  readonly #waiting = new Map<string, string>();
  /** Payment files as last read, by name: a file is read again only once it changed. */
  readonly #files = new Map<string, { mtimeMs: number; payment: KeeperPayment }>();
  /** Events whose signature held: each is verified once, not every round. */
  readonly #verified = new Set<string>();
  #ticking: Promise<void> | null = null;

  /** The desk over a connection and a treasury contract already open; `open` is the usual way in. */
  constructor(
    readonly hive: string,
    readonly conn: Connection,
    readonly contract: TreasuryContract,
    readonly options: ApprovalDeskOptions,
  ) {
    this.record = loadHive(hive);
    ensure(this.record.v5, "INVALID", `${hive}'s treasury is not a v5 treasury`);
    this.v5 = this.record.v5;
    this.paths = opsPaths(hive);
    this.#queue = lockedQueue(this.file("desk.lock"));
    this.#log = new AgentLog(options.agentLog);
  }

  static async open(hive: string, options: ApprovalDeskOptions): Promise<ApprovalDesk> {
    const record = loadHive(hive);
    ensure(record.v5, "INVALID", `${hive}'s treasury is not a v5 treasury`);
    const conn = await connect(record.deployment);
    await checkEmulator(record.deployment, conn.keys.emulator);
    const { contract } = await v5Contract(record.deployment, v5Terms(record.v5));
    ensure(
      hex(contract.pkScript) === record.treasuryScript,
      "DELEGATEE_MISMATCH",
      "the treasury derives differently",
    );
    return new ApprovalDesk(hive, conn, contract, options);
  }

  /** The keepers' Buzz keys, in the hive's order. */
  get keepers(): [string, string, string] {
    return this.v5.keepers;
  }

  get assetId(): string {
    return this.v5.counter.assetId;
  }

  now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private file(...parts: string[]) {
    return this.paths.local("desk", ...parts);
  }

  private lock<T>(action: () => Promise<T>): Promise<T> {
    return this.#queue(action);
  }

  private lookup(query: { outpoints?: string[]; scripts?: string[] }): Promise<IndexedCoin[]> {
    return this.options.lookup ? this.options.lookup(query) : this.conn.arkd.coins(query);
  }

  jobs(): AgentJob[] {
    return this.#log.jobs(this.now());
  }

  /**
   * What approved work has left. A job's payment that is open, or that went out before the agent has
   * seen its escrow funded, is already spoken for: the agent's log does not count it yet.
   */
  budget(jobs = this.jobs(), payments: readonly Readonly<KeeperPayment>[] = this.scan()): Budget {
    const governance = this.options.governance
      ? readJsonIfPresent<unknown>(this.options.governance)
      : undefined;
    const base = budgetOf(governance, jobs);
    const unfunded = new Set(jobs.filter((j) => j.status === "awaiting_funding").map((j) => j.request.jobId));
    const underWaySats = payments
      .filter((p) => p.request && (OPEN.has(p.status) || (p.status === "done" && unfunded.has(p.id))))
      .reduce((n, p) => n + p.amountSats, 0);
    return {
      ...base,
      underWaySats,
      remainingSats: Math.max(0, base.remainingSats - underWaySats),
    };
  }

  payment(id: string): KeeperPayment | undefined {
    ensure(/^[0-9a-f]{64}$/.test(id), "INVALID", "payment id");
    const found = this.scan().find((p) => p.id === id);
    return found && structuredClone(found);
  }

  /** A new payment's place in the order. */
  private nextSeq(): number {
    return this.scan().reduce((n, p) => Math.max(n, p.seq), 0) + 1;
  }

  private save(payment: KeeperPayment) {
    payment.updatedAt = this.now();
    const name = `${payment.id}.json`;
    const path = this.file("payments", name);
    writeJson(path, payment);
    this.#files.set(name, { mtimeMs: statSync(path).mtimeMs, payment: structuredClone(payment) });
  }

  private names(folder: "payments" | "archive"): string[] {
    try {
      return readdirSync(this.file(folder)).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
    } catch {
      return [];
    }
  }

  /**
   * The payments on file as last read, in the order they started, for looking only: a file is parsed
   * again only once it changed, and what is handed out to be changed is a copy.
   */
  private scan(): readonly Readonly<KeeperPayment>[] {
    const names = this.names("payments");
    const live = new Set(names);
    for (const name of this.#files.keys()) if (!live.has(name)) this.#files.delete(name);
    const out: KeeperPayment[] = [];
    // The folder's path is checked once; a file that changed is read through the same check.
    const folder = names.length ? this.file("payments") : "";
    for (const name of names) {
      const path = join(folder, name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      let kept = this.#files.get(name);
      if (!kept || kept.mtimeMs !== mtimeMs) {
        const payment = readJsonIfPresent<KeeperPayment>(path);
        if (!payment) continue;
        kept = { mtimeMs, payment };
        this.#files.set(name, kept);
      }
      out.push(kept.payment);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** The payments on file, in the order they started. */
  payments(): KeeperPayment[] {
    return this.scan().map((p) => structuredClone(p));
  }

  /** Every payment the desk ever started, live or archived: none is started twice. */
  private known(): Set<string> {
    return new Set([...this.names("payments"), ...this.names("archive")].map((f) => f.slice(0, 64)));
  }

  /** The payments still under way: the open one, and those waiting their turn. */
  active(): KeeperPayment[] {
    return this.scan()
      .filter((p) => ACTIVE.has(p.status))
      .map((p) => structuredClone(p));
  }

  /** The payment the keepers are asked about now, if any. */
  open(): KeeperPayment | undefined {
    const found = this.scan().find((p) => OPEN.has(p.status));
    return found && structuredClone(found);
  }

  /** The treasury coin as the desk last saw it: the coin it follows if another ever holds units. */
  private knownCoin(): KnownCoin | undefined {
    return readJsonIfPresent<KnownCoin>(this.file("coin.json"));
  }

  private remember(coin: TreasuryCoin) {
    const known = this.knownCoin();
    const units = String(unitsOn(coin, this.assetId));
    if (known?.txid === coin.txid && known.vout === coin.vout && known.units === units) return;
    writeJson(this.file("coin.json"), { txid: coin.txid, vout: coin.vout, units });
  }

  private coins() {
    return treasuryCoins(this.contract, this.assetId, this.knownCoin());
  }

  /** The treasury coin's counter units now: the number of the open payment. */
  async units(): Promise<bigint> {
    const { treasury, held } = await this.coins();
    ensure(
      treasury,
      "COUNTER_MISSING",
      held.length ? "the counter sits on more than one coin" : "no treasury coin",
    );
    return unitsOn(treasury, this.assetId);
  }

  /** A payment with a number, as its keepers approve it. */
  private terms(payment: Pick<KeeperPayment, "left" | "amountSats" | "validUntil" | "program">): Payment {
    ensure(payment.left !== null, "INVALID", "the payment has no number yet");
    return {
      left: BigInt(payment.left),
      amount: BigInt(payment.amountSats),
      validUntil: payment.validUntil,
      program: payment.program,
    };
  }

  /** The message a payment's keepers approve, as the contract rebuilds it. */
  message(payment: Pick<KeeperPayment, "left" | "amountSats" | "validUntil" | "program">): Uint8Array {
    return payMessage(this.v5.counter, this.terms(payment));
  }

  /** The text a keeper sends to approve a payment, and to decline it. */
  approval(payment: Pick<KeeperPayment, "left" | "amountSats" | "validUntil" | "program">): string {
    return approvalText(this.v5.counter, this.terms(payment));
  }

  decline(payment: Pick<KeeperPayment, "left" | "amountSats" | "validUntil" | "program">): string {
    return declineText(this.v5.counter, this.terms(payment));
  }

  /** A payment as members read it in the hive's state: who approved, never the approvals themselves. */
  shown(payment: KeeperPayment) {
    const { approvals, ...p } = payment;
    delete p.tried;
    return {
      ...p,
      kind: p.withdrawal ? "withdrawal" : "job",
      approvedBy: this.keepers.filter((_, i) => approvals[i]),
      // The approval's code, for the plugins to match keepers' messages with; none before its turn.
      ...(p.left !== null && p.program ? { code: codeOf(this.message(p)) } : {}),
    };
  }

  private requests(): Record<string, Refusal> {
    return readJsonIfPresent<Record<string, Refusal>>(this.file("requests.json")) ?? {};
  }

  /**
   * Where the hive's payments stand, for its state: the treasury's counter, terms and Operator, which
   * a keeper's plugin rebuilds the treasury and each payment from, the jobs waiting for funding, and
   * each payment's progress.
   */
  async overview() {
    const jobs = this.jobs();
    const all = this.scan();
    const budget = this.budget(jobs, all);
    const units = await this.units().catch(() => null);
    const byId = new Set(all.map((p) => p.id));
    const cutoff = this.now() - FINISHED_KEEP_SECONDS;
    return {
      v: 5,
      counter: this.v5.counter,
      keepers: this.keepers,
      treasuryScript: this.record.treasuryScript,
      terms: {
        delegateKey: this.v5.delegateKey,
        renewalWindowSeconds: this.v5.renewalWindowSeconds,
        maxFeeSats: this.v5.maxFeeSats,
        exitDelaySeconds: this.v5.exitDelaySeconds,
      },
      operator: {
        network: this.record.network,
        server: this.conn.keys.server,
        emulator: this.conn.keys.emulator,
        exitDelay: this.conn.operator.unilateralExitDelay,
      },
      units: units === null ? null : String(units),
      budget,
      waiting: jobs
        .filter((j) => j.status === "awaiting_funding" && !byId.has(j.request.jobId))
        .map((j) => ({ jobId: j.request.jobId, reason: this.#waiting.get(j.request.jobId) ?? null })),
      // Withdrawal requests the desk did not take up, for the card under the keeper's message.
      refused: Object.entries(this.requests())
        .filter(([, r]) => r.reason)
        .sort(([, a], [, b]) => a.at - b.at)
        .slice(-20)
        .map(([id, r]) => ({ id, by: r.by, reason: r.reason })),
      payments: all
        .filter((p) => ACTIVE.has(p.status) || p.updatedAt > cutoff)
        .slice(-40)
        .map((p) => this.shown(structuredClone(p))),
    };
  }

  /** A job's payment, which waits its turn once the job's own terms hold. */
  private admitJob(job: AgentJob): KeeperPayment | string {
    const request = job.request;
    let escrow: ReturnType<typeof jobEscrow>;
    try {
      escrow = jobEscrow(this.conn, request.params);
    } catch {
      return "the job's terms do not build an escrow";
    }
    if (escrow.address !== request.address.toLowerCase()) return "the job's address is not its escrow";
    if (request.params.treasuryProgram !== this.record.treasuryScript.slice(4))
      return "the job's escrow returns elsewhere";
    if (!Number.isSafeInteger(request.capSats) || request.capSats < this.conn.operator.dust)
      return `the job's cap is below ${this.conn.operator.dust} sats`;
    const ceilings = networkCeilings(this.record.network);
    if (ceilings && request.capSats > ceilings.escrowSats)
      return `the job asks ${request.capSats} sats, above the ${ceilings.escrowSats} sats an escrow may hold on mainnet`;
    return {
      schema: "hive-desk-payment/v5",
      id: request.jobId,
      request,
      address: request.address.toLowerCase(),
      program: escrow.pkScript.slice(4),
      amountSats: request.capSats,
      left: null,
      validUntil: 0,
      approvals: [null, null, null],
      seq: this.nextSeq(),
      remainingSats: 0,
      startedBy: "agent",
      status: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
  }

  /** A keeper's withdrawal, asked for in the channel, to an Arkade address on the hive's Operator. */
  private admitWithdrawal(
    event: BuzzEvent,
    asked: { amountSats: number; address: string },
  ): KeeperPayment | string {
    let decoded: { serverKey: string; pkScript: string };
    try {
      decoded = parseArkAddress(asked.address);
    } catch {
      return "not an Arkade address";
    }
    if (decoded.serverKey !== hex(xOnly(this.conn.keys.server)))
      return "an address on another Operator than the hive's";
    if (decoded.pkScript === this.record.treasuryScript) return "the treasury itself";
    if (asked.amountSats < this.conn.operator.dust) return `below ${this.conn.operator.dust} sats`;
    if (BigInt(asked.amountSats) > MAX_AMOUNT_SATS) return "more than an approval can name";
    return {
      schema: "hive-desk-payment/v5",
      id: event.id,
      address: asked.address,
      program: decoded.pkScript.slice(4),
      withdrawal: { destination: decoded.pkScript, amountSats: asked.amountSats },
      amountSats: asked.amountSats,
      left: null,
      validUntil: 0,
      approvals: [null, null, null],
      seq: this.nextSeq(),
      remainingSats: 0,
      startedBy: event.pubkey,
      status: "queued",
      expiresAt: event.created_at + WITHDRAWAL_VALIDITY_SECONDS,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
  }

  /**
   * The keepers' payment messages still in the hive's channel, oldest first, each one checked: its
   * id is its own, and its keeper signed it. Only messages that speak of a payment are looked at,
   * a signature is verified once, and a message its keeper deleted is left out.
   */
  private channel(): { messages: BuzzEvent[]; deleted: Set<string> } {
    const events = this.options.events ? (readJsonIfPresent<BuzzEvent[]>(this.options.events) ?? []) : [];
    const keepers = new Set<string>(this.keepers);
    if (this.#verified.size > 100_000) this.#verified.clear();
    const holds = (e: BuzzEvent) => {
      if (!eventIdHolds(e)) return false;
      const key = `${e.id}${e.sig}`;
      if (this.#verified.has(key)) return true;
      if (!eventSigned(e)) return false;
      this.#verified.add(key);
      return true;
    };
    const messages = events.filter(
      (e) =>
        e?.kind === 9 &&
        keepers.has(e.pubkey) &&
        typeof e.content === "string" &&
        Boolean(paymentWord(e.content) || withdrawalOf(e.content)) &&
        holds(e),
    );
    // A deletion counts from the message's own author, as Buzz takes it.
    const author = new Map(messages.map((e) => [e.id, e.pubkey]));
    const deleted = new Set<string>();
    for (const e of events) {
      if (e?.kind !== 5 || !keepers.has(e.pubkey) || !Array.isArray(e.tags)) continue;
      const targets = e.tags.filter((t) => t[0] === "e" && author.get(t[1] ?? "") === e.pubkey);
      if (targets.length && holds(e)) for (const t of targets) deleted.add(t[1]!);
    }
    return {
      messages: messages
        .filter((e) => !deleted.has(e.id))
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)),
      deleted,
    };
  }

  /** New jobs and new withdrawal requests take their place in the queue. */
  private admit(jobs: AgentJob[], messages: BuzzEvent[]) {
    const known = this.known();
    for (const job of jobs) {
      if (job.status !== "awaiting_funding" || known.has(job.request.jobId)) continue;
      const made = this.admitJob(job);
      if (typeof made === "string") {
        this.#waiting.set(job.request.jobId, made);
        continue;
      }
      this.#waiting.delete(job.request.jobId);
      this.save(made);
      known.add(made.id);
    }
    const now = this.now();
    const requests = this.requests();
    let changed = false;
    for (const [id, r] of Object.entries(requests)) {
      // A request older than a withdrawal's life is never looked at again, refused or not.
      if (r.at < now - 2 * WITHDRAWAL_VALIDITY_SECONDS) {
        delete requests[id];
        changed = true;
      }
    }
    for (const e of messages) {
      const asked = withdrawalOf(e.content);
      if (!asked || known.has(e.id) || requests[e.id]) continue;
      if (e.created_at < now - WITHDRAWAL_VALIDITY_SECONDS) continue;
      // One request per keeper waits at a time: more of them queue nothing.
      const waiting = this.active().some((p) => p.withdrawal && p.startedBy === e.pubkey);
      const made = waiting
        ? "this keeper already has a withdrawal waiting; one at a time"
        : this.admitWithdrawal(e, asked);
      changed = true;
      if (typeof made === "string") {
        requests[e.id] = { at: e.created_at, by: e.pubkey, reason: made };
        continue;
      }
      requests[e.id] = { at: e.created_at, by: e.pubkey };
      this.save(made);
      known.add(made.id);
    }
    if (changed) writeJson(this.file("requests.json"), requests);
  }

  /** Back in the queue with no number: the treasury passed the one it had, so its approvals are spent. */
  private requeue(p: KeeperPayment, detail: string) {
    p.status = "queued";
    p.left = null;
    p.validUntil = 0;
    p.approvals = [null, null, null];
    delete p.attempts;
    delete p.tried;
    p.detail = detail;
    this.save(p);
  }

  /** Whether a waiting job's payment could take its turn now; why not, otherwise. */
  private fits(
    p: Readonly<KeeperPayment>,
    jobs: AgentJob[],
    all: readonly Readonly<KeeperPayment>[],
  ): string | null {
    const budget = this.budget(jobs, all);
    return p.amountSats > budget.remainingSats
      ? `the job asks ${p.amountSats} sats and approved work has ${budget.remainingSats} left`
      : null;
  }

  /**
   * Ends what has run out, lets an unanswered withdrawal step aside for a job, and gives the next
   * payment its turn: the treasury's current number, and the time its approvals lapse.
   */
  private advance(units: bigint, jobs: AgentJob[], deleted: Set<string>) {
    const now = this.now();
    const minimum = this.options.minimumValiditySeconds ?? 600;
    const job = new Map(jobs.map((j) => [j.request.jobId, j]));
    for (const p of this.active()) {
      // A keeper who deletes their request takes it back, as long as two have not approved it.
      if (p.withdrawal && deleted.has(p.id) && (p.status === "queued" || p.status === "approving")) {
        p.status = "declined";
        p.declinedBy = p.startedBy;
        p.detail = "the keeper who asked took the request back";
        this.save(p);
        continue;
      }
      const gone = p.request && job.get(p.id)?.status !== "awaiting_funding";
      if (OPEN.has(p.status)) {
        if (p.status === "submitted") continue;
        if (p.validUntil <= now) {
          p.status = "lapsed";
          this.save(p);
        } else if (gone) {
          p.status = "lapsed";
          p.detail = "the job no longer waits for funding";
          this.save(p);
        }
        continue;
      }
      if (gone || (p.expiresAt !== undefined && p.expiresAt <= now)) {
        p.status = "lapsed";
        p.detail = gone ? "the job no longer waits for funding" : "nobody approved it in time";
        this.save(p);
      }
    }
    let all = this.scan();
    const open = this.open();
    const queuedJobs = all.filter((p) => p.status === "queued" && p.request);
    // An open withdrawal that two keepers have not approved does not keep a job waiting for long.
    if (
      open?.withdrawal &&
      open.status === "approving" &&
      (open.openedAt ?? now) <= now - (this.options.patienceSeconds ?? WITHDRAWAL_PATIENCE_SECONDS) &&
      queuedJobs.some((p) => this.fits(p, jobs, all) === null)
    ) {
      // It keeps its number and its lapse time: if its turn comes back before the treasury moves
      // on, the approval it has still counts, and no keeper is asked for another under a new code.
      open.status = "queued";
      open.detail = "stepped aside for a job; it waits its turn again";
      this.save(open);
      all = this.scan();
    }
    if (all.some((p) => OPEN.has(p.status)) || units <= 1n) return;
    const queued = all.filter((p) => p.status === "queued");
    for (const waiting of [...queued.filter((q) => q.request), ...queued.filter((q) => !q.request)]) {
      const p = structuredClone(waiting) as KeeperPayment;
      let validUntil = now + WITHDRAWAL_VALIDITY_SECONDS;
      if (p.request) {
        const why = this.fits(p, jobs, all);
        if (why) {
          if (p.detail !== why) {
            p.detail = why;
            this.save(p);
          }
          continue;
        }
        validUntil = Math.min(
          now + KEEPER_MAX_VALIDITY_SECONDS,
          p.request.deadline - (this.options.deadlineMarginSeconds ?? DEADLINE_MARGIN_SECONDS),
        );
        if (validUntil - now <= minimum) {
          p.status = "lapsed";
          p.detail = "too close to the job's deadline for two keepers to approve";
          this.save(p);
          continue;
        }
        p.remainingSats = this.budget(jobs, all).remainingSats;
      }
      // The number it had, if the treasury still stands at it and time remains; a new one otherwise.
      if (p.left !== String(units) || p.validUntil - now <= minimum) {
        p.left = String(units);
        p.validUntil = validUntil;
        p.approvals = [null, null, null];
      }
      p.status = "approving";
      p.openedAt = now;
      delete p.detail;
      this.save(p);
      return;
    }
  }

  /**
   * Takes in the keepers' messages about the open payment, matched by its code: a decline stops the
   * desk, and the approvals still in the channel are counted afresh each round.
   */
  private take(messages: BuzzEvent[]) {
    const p = this.open();
    if (!p || p.status === "submitted" || p.left === null) return;
    const terms = this.terms(p);
    const code = codeOf(payMessage(this.v5.counter, terms));
    const approvals: (StoredApproval | null)[] = [null, null, null];
    let declinedBy: string | null = null;
    for (const e of messages) {
      const said = paymentWord(e.content);
      if (!said || said.code !== code) continue;
      if (said.word === "decline") {
        declinedBy ??= e.pubkey;
        continue;
      }
      try {
        const approval = buzzApproval(e.pubkey, this.v5.counter, terms, e);
        approvals[this.keepers.indexOf(e.pubkey)] = {
          sig: hex(approval.sig),
          time: hex(approval.time),
          tags: hex(approval.tags),
          event: e.id,
        };
      } catch (error) {
        if (!(error instanceof ApprovalRefused)) throw error;
      }
    }
    const count = approvals.filter(Boolean).length;
    if (declinedBy) {
      p.approvals = approvals;
      p.status = "declined";
      p.declinedBy = declinedBy;
      // A decline is the desk's to honour, not the covenant's: two approvals already sent still pay.
      if (count >= 2)
        p.detail = `two keepers had approved it; their approvals stay valid until ${new Date(p.validUntil * 1000).toISOString()}`;
      this.save(p);
      return;
    }
    const status: Status = count >= 2 ? "ready" : "approving";
    const same = p.approvals.every((a, i) => (a?.event ?? null) === (approvals[i]?.event ?? null));
    if (same && p.status === status) return;
    p.approvals = approvals;
    p.status = status;
    this.save(p);
  }

  /**
   * The desk's round: what became of a payment the treasury has passed, lapses, new payments and the
   * next one's turn, the keepers' messages, the open payment out once approved, and chip-ins and
   * returned escrows folded into the treasury coin.
   */
  tick(): Promise<void> {
    this.#ticking ??= this.round().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  /**
   * The payments that left the treasury between the coin the desk last saw and the coin it holds
   * now, in order: each payment transaction's second output. Null when the path cannot be followed,
   * across a renewal into a new batch for instance.
   */
  private async trace(
    from: KnownCoin,
    to: TreasuryCoin,
  ): Promise<{ txid: string; script: string; amount: number }[] | null> {
    const paid: { txid: string; script: string; amount: number }[] = [];
    let at = outpoint(from);
    for (let step = 0; step < MAX_TRACE; step++) {
      if (at === outpoint(to)) return paid;
      const [coin] = await this.lookup({ outpoints: [at] });
      if (!coin?.arkTxid) return null;
      const [second] = await this.lookup({ outpoints: [`${coin.arkTxid}:1`] });
      if (second) paid.push({ txid: coin.arkTxid, script: second.script, amount: second.amount });
      at = `${coin.arkTxid}:0`;
    }
    return null;
  }

  /**
   * Squares the desk's payments with what the treasury did since the desk last looked. Anyone holding
   * two keepers' approvals may submit them, so a payment is done when the transaction that spent the
   * treasury coin under its number paid its recipient its amount, whoever sent it, and a payment
   * whose number went to another waits its turn again. False when the indexer cannot say yet: nothing
   * is decided blind, and the next round looks again.
   */
  private async settle(treasury: TreasuryCoin, units: bigint): Promise<boolean> {
    const before = this.knownCoin();
    const open = this.open();
    const passed = Boolean(open && open.left !== null && BigInt(open.left) > units);
    const moved = before !== undefined && outpoint(before) !== outpoint(treasury);
    if (!passed && !(moved && BigInt(before.units) !== units)) {
      // The same count: a merge or a renewal at most, and a payment on its way goes again.
      if (open?.status === "submitted")
        await this.lock(async () => {
          const p = this.payment(open.id)!;
          if (p.status !== "submitted") return;
          p.status = "ready";
          this.save(p);
        });
      return true;
    }
    let paid: Awaited<ReturnType<ApprovalDesk["trace"]>> = null;
    let seen = true;
    if (moved)
      try {
        paid = await this.trace(before, treasury);
      } catch {
        seen = false;
      }
    // Where the path cannot be followed, the recipient's own coins say whether the open payment arrived.
    let arrived: IndexedCoin | undefined;
    if (seen && !paid && open && passed) {
      try {
        const since = (open.openedAt ?? open.createdAt) - 120;
        arrived = (await this.lookup({ scripts: [`5120${open.program}`] })).find(
          (c) => c.amount === open.amountSats && c.createdAt >= since,
        );
      } catch {
        seen = false;
      }
    }
    if (!seen) return false;
    await this.lock(async () => {
      let number = BigInt(before?.units ?? units);
      for (const out of paid ?? []) {
        const found = this.scan().find(
          (x) =>
            x.status !== "done" &&
            x.left === String(number) &&
            `5120${x.program}` === out.script &&
            x.amountSats === out.amount,
        );
        number -= 1n;
        if (!found) continue;
        const p = structuredClone(found) as KeeperPayment;
        if (!OPEN.has(p.status)) p.detail = `paid on approvals sent before it was ${p.status}`;
        else delete p.detail;
        p.status = "done";
        p.txid = out.txid;
        this.save(p);
      }
      const still = this.open();
      if (!still || still.left === null || BigInt(still.left) <= units) return;
      if (arrived) {
        still.status = "done";
        still.txid = arrived.txid;
        delete still.detail;
        this.save(still);
        return;
      }
      this.requeue(still, "another payment went out under its number; it waits its turn again");
    });
    return true;
  }

  private async round() {
    let coins = await this.coins();
    if (!coins.treasury) return;
    let treasury = coins.treasury;
    let units = unitsOn(treasury, this.assetId);
    if (!(await this.settle(treasury, units))) return;
    this.remember(treasury);
    for (let tries = 0; ; tries++) {
      const head = await this.lock(async () => {
        const jobs = this.jobs();
        const { messages, deleted } = this.channel();
        // What the keepers said about the open payment first, so a decline frees the turn this
        // round; then again for the payment whose turn it became.
        this.take(messages);
        this.admit(jobs, messages);
        this.advance(units, jobs, deleted);
        this.take(messages);
        return this.open();
      });
      const due =
        head?.status === "ready" &&
        head.left === String(units) &&
        head.validUntil - this.now() > SUBMIT_MARGIN_SECONDS;
      if (!due) break;
      // The change stays above dust: a payment the treasury coin cannot cover waits for a merge.
      if (treasury.value - head.amountSats < this.conn.operator.dust) {
        if (coins.others.length === 0)
          await this.lock(async () => {
            const p = this.payment(head.id)!;
            p.detail = `the treasury holds ${treasury.value} sats`;
            this.save(p);
          });
        break;
      }
      const sent = await this.submit(head, treasury);
      if (sent !== "moved" || tries >= RETRIES_PER_ROUND) return;
      // A merge or a renewal took the coin first. The payment's approvals name no coin, so it goes
      // again at once on the coin that replaced it, unless the count changed with it.
      coins = await this.coins();
      if (!coins.treasury) return;
      treasury = coins.treasury;
      units = unitsOn(treasury, this.assetId);
      if (!(await this.settle(treasury, units))) return;
      this.remember(treasury);
    }
    // Chip-ins and returned escrows fold in one at a time; the next round sees the new treasury coin.
    const other = coins.others.find((c) => c.value > 0);
    if (other) await mergeIntoTreasury(this.contract, treasury, other, this.assetId).catch(() => {});
    await this.lock(async () => this.archive());
  }

  /** Finished payments leave the live folder after a week: every round reads what is in it. */
  private archive() {
    const cutoff = this.now() - FINISHED_KEEP_SECONDS;
    for (const p of this.scan()) {
      if (ACTIVE.has(p.status) || p.updatedAt > cutoff) continue;
      const name = `${p.id}.json`;
      mkdirSync(this.file("archive"), { recursive: true, mode: 0o700 });
      renameSync(this.file("payments", name), this.file("archive", name));
      this.#files.delete(name);
    }
  }

  /**
   * Sends the open payment. "paid" once the Emulator's answer says so; "moved" when the treasury coin
   * was spent under it, by a merge, a renewal or another payment, which the next look settles;
   * "failed" when the coin stood and the payment was refused; "unknown" when the indexer cannot say.
   */
  private async submit(
    head: KeeperPayment,
    coin: TreasuryCoin,
  ): Promise<"paid" | "moved" | "failed" | "unknown"> {
    const tried = outpoint(coin);
    await this.lock(async () => {
      const p = this.payment(head.id)!;
      p.status = "submitted";
      p.tried = tried;
      this.save(p);
    });
    const terms = this.terms(head);
    const approvals = head.approvals.map((a, i) => {
      if (!a) return null;
      const approval = { sig: unhex(a.sig), time: unhex(a.time), tags: unhex(a.tags) };
      return approvalHolds(this.keepers[i]!, this.v5.counter, terms, approval) ? approval : null;
    });
    let txid: string | undefined;
    let detail: string | undefined;
    try {
      txid = (
        await payFromTreasury(
          this.contract,
          coin,
          this.assetId,
          { amount: BigInt(head.amountSats), program: unhex(head.program), validUntil: head.validUntil },
          approvals,
        )
      ).txid;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    if (txid !== undefined) {
      await this.lock(async () => {
        const p = this.payment(head.id)!;
        p.status = "done";
        p.txid = txid;
        delete p.detail;
        this.save(p);
      });
      return "paid";
    }
    // An answer lost on the way is no failure, and neither is a coin that moved: the coin says which.
    let spent: IndexedCoin | undefined;
    try {
      [spent] = await this.lookup({ outpoints: [tried] });
    } catch {
      return "unknown";
    }
    if (!spent || spent.isSpent || spent.arkTxid || spent.spentBy || spent.settledBy) return "moved";
    await this.lock(async () => {
      const p = this.payment(head.id)!;
      p.attempts = (p.attempts ?? 0) + 1;
      p.status = p.attempts >= MAX_ATTEMPTS ? "failed" : "ready";
      if (detail) p.detail = detail;
      this.save(p);
    });
    return "failed";
  }
}

/** Runs a v5 hive's desk on its own, a round at a time, following the channel in `options.events`. */
export async function startApprovalDesk(hive: string, options: ApprovalDeskOptions) {
  ensure(options.events, "USAGE", "the desk follows the hive's channel: give it the channel's events file");
  const desk = await ApprovalDesk.open(hive, options);
  const round = async () => {
    await desk.tick();
    if (options.paymentsFile) writeJson(options.paymentsFile, await desk.overview());
  };
  void round().catch(() => {});
  const timer = setInterval(() => void round().catch(() => {}), options.tickMs ?? 15_000);
  return {
    desk,
    close() {
      clearInterval(timer);
    },
  };
}
