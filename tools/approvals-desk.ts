/**
 * The approvals desk: where a v5 hive's payments wait for its keepers, run on the hive's host beside
 * the hive's agent. It holds no key that moves funds and decides nothing. It follows the hive's Buzz
 * channel, as the members' Hive plugins forward it to the host: each job the agent asks the keepers
 * to fund becomes a payment, and so does each withdrawal a keeper asks for in the channel. The
 * keepers approve a payment by sending its approval in the channel, hours apart and in any order;
 * once two have, the desk submits the payment itself through the Emulator. A keeper's decline stops
 * it. The desk also folds chip-ins and returned escrows into the treasury coin.
 *
 * A payment's number is the counter units the treasury coin holds when it pays, so payments go out
 * in the order they started, each one when the one before it has paid. An approval names its number,
 * amount, recipient and lapse time; the desk checks each one as the contract will before it keeps it,
 * and a payment whose approvals are all in can be submitted again safely: the covenant pays it once.
 *
 * What the desk says about a payment is in the hive's state for every member to read, as the keepers'
 * approvals are in its channel. Each keeper's Hive plugin rebuilds every payment itself before it
 * offers the approval, from the job's own terms or the withdrawal's address: what the desk says is
 * never taken on its word.
 */
import { type Connection, connect, jobEscrow, parseArkAddress, xOnly } from "@hive/ark";
import {
  type TreasuryContract,
  treasuryCoins,
  mergeIntoTreasury,
  payFromTreasury,
  unitsOn,
} from "@hive/executor";
import { ensure, hex, lockedQueue, readJsonIfPresent, unhex, writeJson } from "@hive/kit";
import { KEEPER_MAX_VALIDITY_SECONDS } from "@hive/steward";
import {
  type Approval,
  ApprovalRefused,
  approvalHolds,
  type BuzzEvent,
  buzzApproval,
  codeOf,
  eventHolds,
  payMessage,
  paymentWord,
  withdrawalOf,
} from "@hive/treasury";
import { readdirSync } from "node:fs";
import { type AgentJob, AgentLog, type Budget, budgetOf, type DeskOptions } from "./desk.js";
import { type HiveRecord, loadHive, opsPaths } from "./ops.js";
import { checkEmulator, type KeeperTreasury, v5Contract, v5Terms } from "./treasury-v5.js";

const DEADLINE_MARGIN_SECONDS = 600;
/** A payment the desk could not submit this many times is left to the keepers. */
const MAX_ATTEMPTS = 3;
/** A withdrawal's approvals lapse after this long; a job's lapse before its deadline. */
const WITHDRAWAL_VALIDITY_SECONDS = KEEPER_MAX_VALIDITY_SECONDS;

export interface ApprovalDeskOptions
  extends Pick<
    DeskOptions,
    "agentLog" | "governance" | "tickMs" | "now" | "deadlineMarginSeconds" | "minimumValiditySeconds"
  > {
  /** The hive's channel as the host keeps it: a JSON array of signed events. */
  events?: string;
  /** Where a desk running on its own writes its payments after each round, for hive-api to serve. */
  paymentsFile?: string;
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
  /** The payment's number: the counter units on the treasury coin when it pays. */
  left: string;
  validUntil: number;
  /** One per keeper, in the hive's order. */
  approvals: (StoredApproval | null)[];
  /** The order payments started in, which is the order they pay. */
  seq: number;
  /** What approved work had left when the payment was started, by the desk's count. */
  remainingSats: number;
  /** The keeper who asked for a withdrawal; "agent" for a job. */
  startedBy: string;
  status: "approving" | "ready" | "submitted" | "done" | "lapsed" | "declined" | "failed";
  declinedBy?: string;
  attempts?: number;
  txid?: string;
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

const ACTIVE = new Set<KeeperPayment["status"]>(["approving", "ready", "submitted"]);

export class ApprovalDesk {
  readonly paths: ReturnType<typeof opsPaths>;
  readonly record: HiveRecord;
  readonly v5: KeeperTreasury;
  readonly #queue: <T>(action: () => Promise<T>) => Promise<T>;
  readonly #log: AgentLog;
  /** Why a job waiting for funding has no payment yet, as the last round found. */
  readonly #waiting = new Map<string, string>();
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

  jobs(): AgentJob[] {
    return this.#log.jobs(this.now());
  }

  budget(jobs = this.jobs()): Budget {
    const governance = this.options.governance
      ? readJsonIfPresent<unknown>(this.options.governance)
      : undefined;
    return budgetOf(governance, jobs);
  }

  payment(id: string): KeeperPayment | undefined {
    ensure(/^[0-9a-f]{64}$/.test(id), "INVALID", "payment id");
    return readJsonIfPresent<KeeperPayment>(this.file("payments", `${id}.json`));
  }

  /** A new payment's place in the order. */
  private nextSeq(): number {
    return this.payments().reduce((n, p) => Math.max(n, p.seq), 0) + 1;
  }

  private save(payment: KeeperPayment) {
    payment.updatedAt = this.now();
    writeJson(this.file("payments", `${payment.id}.json`), payment);
  }

  payments(): KeeperPayment[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.file("payments")).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
    } catch {
      // none yet
    }
    return files
      .map((f) => this.payment(f.slice(0, 64)))
      .filter((p): p is KeeperPayment => Boolean(p))
      .sort((a, b) => a.seq - b.seq);
  }

  /** The payments still under way, in the order they pay: the order they started. */
  active(): KeeperPayment[] {
    return this.payments().filter((p) => ACTIVE.has(p.status));
  }

  /** The treasury coin's counter units now: the number of the next payment. */
  async units(): Promise<bigint> {
    const { treasury, held } = await treasuryCoins(this.contract, this.assetId);
    ensure(
      treasury,
      "COUNTER_MISSING",
      held.length ? "the counter sits on more than one coin" : "no treasury coin",
    );
    return unitsOn(treasury, this.assetId);
  }

  /** The message a payment's keepers approve, as the contract rebuilds it. */
  message(payment: Pick<KeeperPayment, "left" | "amountSats" | "validUntil" | "program">): Uint8Array {
    return payMessage(this.v5.counter, {
      left: BigInt(payment.left),
      amount: BigInt(payment.amountSats),
      validUntil: payment.validUntil,
      program: payment.program,
    });
  }

  /** A payment as members read it in the hive's state: who approved, never the approvals themselves. */
  shown({ approvals, ...p }: KeeperPayment) {
    return {
      ...p,
      kind: p.withdrawal ? "withdrawal" : "job",
      approvedBy: this.keepers.filter((_, i) => approvals[i]),
      // The approval's code, for the plugins to match keepers' messages with; none for a refused request.
      ...(p.program ? { code: codeOf(this.message(p)) } : {}),
    };
  }

  /**
   * Where the hive's payments stand, for its state: the treasury's counter and the Operator's keys a
   * keeper's plugin checks them with, the jobs waiting for funding, and each payment's progress.
   */
  async overview() {
    const jobs = this.jobs();
    const budget = this.budget(jobs);
    const units = await this.units().catch(() => null);
    const all = this.payments();
    const byId = new Set(all.map((p) => p.id));
    return {
      v: 5,
      counter: this.v5.counter,
      keepers: this.keepers,
      treasuryScript: this.record.treasuryScript,
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
      payments: all
        .filter((p) => ACTIVE.has(p.status) || p.updatedAt > this.now() - 7 * 86_400)
        .slice(-40)
        .map((p) => this.shown(p)),
    };
  }

  /** A job's payment, which the desk starts itself once the job fits the hive's approved budget. */
  private startJob(job: AgentJob, number: bigint): KeeperPayment | string {
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
    const budget = this.budget();
    if (request.capSats > budget.remainingSats)
      return `the job asks ${request.capSats} sats and approved work has ${budget.remainingSats} left`;
    const validUntil = Math.min(
      this.now() + KEEPER_MAX_VALIDITY_SECONDS,
      request.deadline - (this.options.deadlineMarginSeconds ?? DEADLINE_MARGIN_SECONDS),
    );
    if (validUntil - this.now() <= (this.options.minimumValiditySeconds ?? 600))
      return "too close to the job's deadline for two keepers to approve";
    return {
      schema: "hive-desk-payment/v5",
      id: request.jobId,
      request,
      address: request.address.toLowerCase(),
      program: escrow.pkScript.slice(4),
      amountSats: request.capSats,
      left: String(number),
      validUntil,
      approvals: [null, null, null],
      seq: this.nextSeq(),
      remainingSats: budget.remainingSats,
      startedBy: "agent",
      status: "approving",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
  }

  /** A keeper's withdrawal, asked for in the channel, to an Arkade address on the hive's Operator. */
  private startWithdrawal(event: BuzzEvent, asked: { amountSats: number; address: string }, number: bigint) {
    const base = {
      schema: "hive-desk-payment/v5" as const,
      id: event.id,
      address: asked.address,
      amountSats: asked.amountSats,
      left: String(number),
      validUntil: this.now() + WITHDRAWAL_VALIDITY_SECONDS,
      approvals: [null, null, null],
      seq: this.nextSeq(),
      remainingSats: 0,
      startedBy: event.pubkey,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const refused = (detail: string): KeeperPayment => ({
      ...base,
      program: "",
      withdrawal: { destination: "", amountSats: asked.amountSats },
      status: "failed",
      detail,
    });
    let decoded: { serverKey: string; pkScript: string };
    try {
      decoded = parseArkAddress(asked.address);
    } catch {
      return refused("not an Arkade address");
    }
    if (decoded.serverKey !== hex(xOnly(this.conn.keys.server)))
      return refused("an address on another Operator than the hive's");
    if (decoded.pkScript === this.record.treasuryScript) return refused("the treasury itself");
    if (asked.amountSats < this.conn.operator.dust) return refused(`below ${this.conn.operator.dust} sats`);
    return {
      ...base,
      program: decoded.pkScript.slice(4),
      withdrawal: { destination: decoded.pkScript, amountSats: asked.amountSats },
      status: "approving",
    } as KeeperPayment;
  }

  /** The keepers' messages in the hive's channel, oldest first, each one checked. */
  private keeperMessages(): BuzzEvent[] {
    const events = this.options.events ? (readJsonIfPresent<BuzzEvent[]>(this.options.events) ?? []) : [];
    const keepers = new Set<string>(this.keepers);
    return events
      .filter((e) => e?.kind === 9 && keepers.has(e.pubkey) && eventHolds(e))
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  }

  /**
   * Starts what waits to be paid and takes in the keepers' messages: new withdrawals, then the
   * approvals and declines of the payments under way, each matched to a payment by its code.
   */
  private follow(units: bigint) {
    const known = new Set(this.payments().map((p) => p.id));
    let next = units - BigInt(this.active().length);
    // Jobs first: the agent asked before any keeper could ask after it.
    for (const job of this.jobs()) {
      if (job.status !== "awaiting_funding" || known.has(job.request.jobId)) continue;
      if (next <= 1n) break;
      const made = this.startJob(job, next);
      if (typeof made === "string") {
        this.#waiting.set(job.request.jobId, made);
        continue;
      }
      this.#waiting.delete(job.request.jobId);
      this.save(made);
      known.add(made.id);
      next -= 1n;
    }
    const messages = this.keeperMessages();
    for (const e of messages) {
      const asked = withdrawalOf(e.content);
      if (!asked || known.has(e.id) || e.created_at < this.now() - WITHDRAWAL_VALIDITY_SECONDS) continue;
      if (next <= 1n) break;
      const made = this.startWithdrawal(e, asked, next);
      this.save(made);
      known.add(made.id);
      if (made.status === "approving") next -= 1n;
    }
    const byCode = new Map(
      this.active()
        .filter((p) => p.status !== "submitted")
        .map((p) => [codeOf(this.message(p)), p] as const),
    );
    for (const e of messages) {
      const said = paymentWord(e.content);
      const p = said && byCode.get(said.code);
      if (!said || !p || !ACTIVE.has(p.status)) continue;
      const at = this.keepers.indexOf(e.pubkey);
      if (said.word === "decline") {
        p.status = "declined";
        p.declinedBy = e.pubkey;
        this.save(p);
        continue;
      }
      if (p.approvals[at]?.event === e.id) continue;
      let approval: Approval;
      try {
        approval = buzzApproval(e.pubkey, this.message(p), e);
      } catch (error) {
        if (!(error instanceof ApprovalRefused)) throw error;
        continue;
      }
      p.approvals[at] = {
        sig: hex(approval.sig),
        time: hex(approval.time),
        tags: hex(approval.tags),
        event: e.id,
      };
      if (p.approvals.filter(Boolean).length >= 2) p.status = "ready";
      this.save(p);
    }
  }

  /**
   * The desk's round: lapsed payments end, numbers follow the payments still under way, new payments
   * start and the keepers' messages come in, chip-ins and returned escrows fold into the treasury
   * coin, and the next payment goes out once approved.
   */
  tick(): Promise<void> {
    this.#ticking ??= this.round().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  /**
   * A payment the keepers declined, or that lapsed, gives its number to the ones after it, whose
   * approvals named the old numbers and are asked for again.
   */
  private renumber(units: bigint) {
    for (const [i, p] of this.active().entries()) {
      const expected = String(units - BigInt(i));
      if (p.left !== expected && p.status !== "submitted") {
        p.left = expected;
        p.approvals = [null, null, null];
        p.status = "approving";
        this.save(p);
      }
    }
  }

  private async round() {
    const coins = await treasuryCoins(this.contract, this.assetId);
    if (!coins.treasury) return;
    let treasury = coins.treasury;
    const units = unitsOn(treasury, this.assetId);
    // A payment whose approvals all came in pays first; until it is done, nothing else spends the coin.
    const head = await this.lock(async () => {
      const now = this.now();
      for (const p of this.active()) {
        // A payment submitted before the host stopped, which the counter shows went out, is done.
        if (p.status === "submitted" && BigInt(p.left) > units) p.status = "done";
        else if (p.status !== "submitted" && p.validUntil <= now + 30) p.status = "lapsed";
        else continue;
        this.save(p);
      }
      this.renumber(units);
      this.follow(units);
      this.renumber(units);
      return this.active()[0];
    });
    const due =
      head && (head.status === "ready" || head.status === "submitted") && BigInt(head.left) === units;
    // The change stays above dust: a payment the treasury coin cannot cover waits for a merge.
    if (due && treasury.value - head.amountSats >= this.conn.operator.dust) {
      await this.submit(head, treasury);
      return;
    }
    if (due && coins.others.length === 0)
      await this.lock(async () => {
        const p = this.payment(head.id)!;
        p.detail = `the treasury holds ${treasury.value} sats`;
        this.save(p);
      });
    // Chip-ins and returned escrows fold in one at a time; the next round sees the new treasury coin.
    const other = coins.others.find((c) => c.value > 0);
    if (other) {
      await mergeIntoTreasury(this.contract, treasury, other, this.assetId).catch(() => {});
      treasury = (await treasuryCoins(this.contract, this.assetId)).treasury ?? treasury;
    }
  }

  private async submit(
    head: KeeperPayment,
    coin: Awaited<ReturnType<typeof treasuryCoins>>["treasury"] & object,
  ) {
    await this.lock(async () => {
      const p = this.payment(head.id)!;
      p.status = "submitted";
      p.attempts = (p.attempts ?? 0) + 1;
      this.save(p);
    });
    const message = this.message(head);
    const approvals = head.approvals.map((a, i) => {
      if (!a) return null;
      const approval = { sig: unhex(a.sig), time: unhex(a.time), tags: unhex(a.tags) };
      return approvalHolds(this.keepers[i]!, message, approval) ? approval : null;
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
    // An answer lost on the way is no failure: the counter says whether the payment went out.
    const paid =
      txid !== undefined || (await this.units().catch(() => BigInt(head.left))) < BigInt(head.left);
    await this.lock(async () => {
      const p = this.payment(head.id)!;
      if (paid) {
        p.status = "done";
        if (txid) p.txid = txid;
        delete p.detail;
      } else {
        p.status = (p.attempts ?? 0) >= MAX_ATTEMPTS ? "failed" : "ready";
        if (detail) p.detail = detail;
      }
      this.save(p);
    });
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
