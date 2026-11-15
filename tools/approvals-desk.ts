/**
 * The approvals desk: where a v5 hive's payments wait for its keepers, run on the hive's host beside
 * the hive's agent. It holds no key that moves funds and decides nothing. It reads the jobs the
 * agent asks the keepers to fund, gives each payment a keeper starts its number, collects the
 * keepers' passkey approvals as they come, hours apart and in any order, and once two have approved,
 * submits the payment itself through the Emulator. It also folds chip-ins and returned escrows into
 * the treasury coin.
 *
 * A payment's number is the counter units the treasury coin holds when it pays, so payments go out
 * in the order keepers started them, each one when the one before it has paid. An approval names its
 * number, amount, recipient and lapse time; the desk checks each one as the contract will before it
 * keeps it, and a payment whose approvals are all in can be submitted again safely: the covenant pays
 * it once.
 *
 * Only a keeper reads the hive's payments here: each read carries a signature by the keeper's Bitcoin
 * key, as starting, cancelling and withdrawing do. An approval needs no other signature: it is one.
 *
 * Each keeper's console rebuilds every payment itself before asking for the passkey, from the job's
 * own terms or the withdrawal's address; what the desk says is never taken on its word.
 */
import { readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type Connection, connect, jobEscrow, parseArkAddress, xOnly } from "@hive/ark";
import {
  type TreasuryContract,
  treasuryCoins,
  mergeIntoTreasury,
  payFromTreasury,
  unitsOn,
} from "@hive/executor";
import {
  clientAddress,
  ensure,
  Fault,
  hex,
  lockedQueue,
  rateLimit,
  readJsonBody,
  readJsonIfPresent,
  sendJson,
  unhex,
  writeJson,
} from "@hive/kit";
import { deskAuthDigest, KEEPER_MAX_VALIDITY_SECONDS, withdrawalId } from "@hive/steward";
import {
  type Approval,
  ApprovalRefused,
  approvalHolds,
  PASSKEY,
  passkeyApproval,
  payMessage,
  RAW_P256,
  rawApproval,
} from "@hive/treasury";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  type AgentJob,
  AgentLog,
  type Budget,
  budgetOf,
  consoleCors,
  type DeskAuth,
  type DeskOptions,
  faultStatus,
} from "./desk.js";
import { type HiveRecord, loadHive, opsPaths } from "./ops.js";
import { currentPrice } from "./price.js";
import { checkEmulator, type PasskeyTreasury, v5Contract, v5Terms } from "./treasury-v5.js";

const AUTH_WINDOW_SECONDS = 300;
const DEADLINE_MARGIN_SECONDS = 600;
/** A payment the desk could not submit this many times is left to the keepers. */
const MAX_ATTEMPTS = 3;
/** A withdrawal's approvals lapse after this long; a job's lapse before its deadline. */
const WITHDRAWAL_VALIDITY_SECONDS = KEEPER_MAX_VALIDITY_SECONDS;

/** One approval as the desk keeps it, hex. */
interface StoredApproval {
  sig: string;
  authData: string;
  tail: string;
}

/** A payment as the desk keeps it: what the keepers approve, and their approvals so far. */
export interface PasskeyPayment {
  schema: "hive-desk-passkey-payment/v1";
  /** The job's id; a withdrawal's own id. */
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
  /** What approved work had left when the payment was started, by the desk's count. */
  remainingSats: number;
  startedBy: string;
  status: "approving" | "ready" | "submitted" | "done" | "lapsed" | "cancelled" | "failed";
  attempts?: number;
  txid?: string;
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

const ACTIVE = new Set<PasskeyPayment["status"]>(["approving", "ready", "submitted"]);

/** A payment as a console reads it: who approved, never the approvals themselves. */
const shown = ({ approvals, ...p }: PasskeyPayment) => ({ ...p, approved: approvals.map(Boolean) });

export class ApprovalDesk {
  readonly paths: ReturnType<typeof opsPaths>;
  readonly record: HiveRecord;
  readonly passkeys: PasskeyTreasury;
  readonly #queue: <T>(action: () => Promise<T>) => Promise<T>;
  readonly #log: AgentLog;
  #ticking: Promise<void> | null = null;

  /** The desk over a connection and a treasury contract already open; `open` is the usual way in. */
  constructor(
    readonly hive: string,
    readonly conn: Connection,
    readonly contract: TreasuryContract,
    readonly options: DeskOptions,
  ) {
    this.record = loadHive(hive);
    ensure(this.record.passkeys, "INVALID", `${hive}'s treasury is not a passkey treasury`);
    this.passkeys = this.record.passkeys;
    this.paths = opsPaths(hive);
    this.#queue = lockedQueue(this.file("desk.lock"));
    this.#log = new AgentLog(options.agentLog);
  }

  static async open(hive: string, options: DeskOptions): Promise<ApprovalDesk> {
    const record = loadHive(hive);
    ensure(record.passkeys, "INVALID", `${hive}'s treasury is not a passkey treasury`);
    const conn = await connect(record.deployment);
    await checkEmulator(record.deployment, conn.keys.emulator);
    const { contract } = await v5Contract(record.deployment, v5Terms(record.passkeys));
    ensure(
      hex(contract.pkScript) === record.treasuryScript,
      "DELEGATEE_MISMATCH",
      "the treasury derives differently",
    );
    return new ApprovalDesk(hive, conn, contract, options);
  }

  get keepers(): [string, string, string] {
    return this.record.stewardKeys;
  }

  get assetId(): string {
    return this.passkeys.counter.assetId;
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

  payment(id: string): PasskeyPayment | undefined {
    ensure(/^[0-9a-f]{64}$/.test(id), "INVALID", "payment id");
    return readJsonIfPresent<PasskeyPayment>(this.file("payments", `${id}.json`));
  }

  private save(payment: PasskeyPayment) {
    payment.updatedAt = this.now();
    writeJson(this.file("payments", `${payment.id}.json`), payment);
  }

  payments(): PasskeyPayment[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.file("payments")).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
    } catch {
      // none yet
    }
    return files
      .map((f) => this.payment(f.slice(0, 64)))
      .filter((p): p is PasskeyPayment => Boolean(p))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** The payments still under way, in the order they pay: the order keepers started them. */
  active(): PasskeyPayment[] {
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

  /** What the console needs to know about the hive: its keepers, its treasury and where to check them. */
  describe() {
    const p = this.passkeys;
    return {
      hive: this.hive,
      network: this.record.network,
      version: 5,
      deployment: {
        arkdUrl: this.record.deployment.arkdUrl,
        delegateeUrl: this.record.deployment.delegateeUrl,
        ...(this.record.deployment.emulatorUrl ? { emulatorUrl: this.record.deployment.emulatorUrl } : {}),
      },
      keepers: this.keepers,
      passkeys: p.keepers,
      treasury: {
        address: this.record.treasuryAddress,
        script: this.record.treasuryScript,
        terms: {
          counter: p.counter,
          delegateKey: p.delegateKey,
          renewalWindowSeconds: p.renewalWindowSeconds,
          maxFeeSats: p.maxFeeSats,
          exitDelaySeconds: p.exitDelaySeconds,
        },
        supply: p.supply,
      },
      // For a keeper who reads amounts in dollars; nothing approved depends on it.
      price: currentPrice(),
    };
  }

  /**
   * A keeper reading the hive's payments: `<key>.<time>.<signature>`, signed as a start or a cancel
   * is, so what the keepers approve is shown to them and to nobody else.
   */
  verifyRead(header: string | undefined) {
    const [keeper = "", at = "", signature = ""] = String(header ?? "").split(".");
    ensure(keeper, "AUTH_REQUIRED", "a keeper's console signs what it reads here");
    this.verifyAuth("read", "", { keeper, at: Number(at), signature });
  }

  private verifyAuth(action: string, id: string, auth: DeskAuth) {
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
          deskAuthDigest(this.hive, action, id, auth.at),
          unhex(auth.keeper.slice(2)),
        ),
      "AUTH_INVALID",
    );
  }

  /** The jobs waiting for the keepers and the withdrawals, each with its payment's progress. */
  async overview() {
    const jobs = this.jobs();
    const budget = this.budget(jobs);
    const all = this.payments();
    const byId = new Map(all.map((p) => [p.id, p]));
    const payments = jobs
      .filter((j) => j.status === "awaiting_funding" || byId.has(j.request.jobId))
      .map((j) => {
        const p = byId.get(j.request.jobId);
        return { job: j, payment: p ? shown(p) : null };
      });
    const withdrawals = all
      .filter((p) => p.withdrawal)
      .reverse()
      .slice(0, 20)
      .map((p) => ({ payment: shown(p) }));
    const units = await this.units().catch(() => null);
    return { budget, units: units === null ? null : String(units), payments, withdrawals };
  }

  /** The number the next payment a keeper starts gets. */
  private async nextNumber(): Promise<bigint> {
    const units = await this.units();
    const next = units - BigInt(this.active().length);
    ensure(next > 1n, "COUNTER_SPENT", "the treasury has made all the payments its counter allows");
    return next;
  }

  /** A keeper starts a job's payment: it gets its number, its amount and its lapse time. */
  async start(jobId: string, auth: DeskAuth) {
    this.verifyAuth("start", jobId, auth);
    return this.lock(async () => {
      const existing = this.payment(jobId);
      ensure(
        !existing || !ACTIVE.has(existing.status),
        "PAYMENT_STARTED",
        "this job's payment is already under way",
      );
      ensure(existing?.status !== "done", "PAID", "this job is funded");
      const job = this.jobs().find((j) => j.request.jobId === jobId);
      ensure(
        job?.status === "awaiting_funding",
        "NOT_WAITING",
        "the agent is not waiting for this job's funding",
      );
      const request = job.request;
      const escrow = jobEscrow(this.conn, request.params);
      ensure(escrow.address === request.address.toLowerCase(), "ESCROW_MISMATCH");
      ensure(
        request.params.treasuryProgram === this.record.treasuryScript.slice(4),
        "ESCROW_MISMATCH",
        "it returns elsewhere",
      );
      const budget = this.budget();
      ensure(request.capSats <= budget.remainingSats, "ABOVE_BUDGET", `${budget.remainingSats} sats left`);
      const validUntil = Math.min(
        this.now() + KEEPER_MAX_VALIDITY_SECONDS,
        request.deadline - (this.options.deadlineMarginSeconds ?? DEADLINE_MARGIN_SECONDS),
      );
      ensure(
        validUntil - this.now() > (this.options.minimumValiditySeconds ?? 600),
        "PAYMENT_LATE",
        "too close to the job's deadline for two keepers to approve",
      );
      const payment: PasskeyPayment = {
        schema: "hive-desk-passkey-payment/v1",
        id: jobId,
        request,
        address: request.address.toLowerCase(),
        program: escrow.pkScript.slice(4),
        amountSats: request.capSats,
        left: String(await this.nextNumber()),
        validUntil,
        approvals: [null, null, null],
        remainingSats: budget.remainingSats,
        startedBy: auth.keeper,
        status: "approving",
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.save(payment);
      return payment;
    });
  }

  /** A keeper starts a withdrawal to an Arkade address on the hive's Operator. */
  async startWithdrawal(auth: DeskAuth, asked: { address?: unknown; amountSats?: unknown }) {
    const address = String(asked.address ?? "")
      .trim()
      .toLowerCase();
    let decoded: { serverKey: string; pkScript: string };
    try {
      decoded = parseArkAddress(address);
    } catch {
      throw new Fault("INVALID_DESTINATION", "not an Arkade address");
    }
    ensure(
      decoded.serverKey === hex(xOnly(this.conn.keys.server)),
      "INVALID_DESTINATION",
      "an address on another Operator",
    );
    ensure(decoded.pkScript !== this.record.treasuryScript, "INVALID_DESTINATION", "the treasury itself");
    const amountSats = Number(asked.amountSats);
    ensure(Number.isSafeInteger(amountSats) && amountSats >= this.conn.operator.dust, "INVALID", "amount");
    const id = withdrawalId(this.hive, decoded.pkScript, amountSats, Number(auth?.at));
    this.verifyAuth("withdraw", id, auth);
    return this.lock(async () => {
      ensure(!this.payment(id), "PAYMENT_STARTED", "this withdrawal is already under way");
      const payment: PasskeyPayment = {
        schema: "hive-desk-passkey-payment/v1",
        id,
        withdrawal: { destination: decoded.pkScript, amountSats },
        address,
        program: decoded.pkScript.slice(4),
        amountSats,
        left: String(await this.nextNumber()),
        validUntil: this.now() + WITHDRAWAL_VALIDITY_SECONDS,
        approvals: [null, null, null],
        remainingSats: 0,
        startedBy: auth.keeper,
        status: "approving",
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.save(payment);
      return payment;
    });
  }

  /** The message a payment's keepers approve, as the contract rebuilds it. */
  message(payment: PasskeyPayment): Uint8Array {
    return payMessage(this.passkeys.counter, {
      left: BigInt(payment.left),
      amount: BigInt(payment.amountSats),
      validUntil: payment.validUntil,
      program: payment.program,
    });
  }

  /**
   * A keeper's approval: a passkey's WebAuthn assertion, or a raw key's signature with its keeper's
   * place. Checked as the contract will check it before it is kept; a passkey's keeper is the one
   * whose key it verifies under.
   */
  async approve(
    id: string,
    body: {
      assertion?: { authenticatorData?: unknown; clientDataJSON?: unknown; signature?: unknown };
      keeper?: unknown;
      signature?: unknown;
    },
  ) {
    return this.lock(async () => {
      const payment = this.payment(id);
      ensure(payment, "NO_PAYMENT");
      ensure(payment.status === "approving" || payment.status === "ready", "WRONG_ROUND", payment.status);
      ensure(payment.validUntil > this.now() + 30, "LAPSED", "this payment's approvals have lapsed");
      const message = this.message(payment);
      const keepers = this.passkeys.keepers;
      let at = -1;
      let approval: Approval | null = null;
      if (body.assertion) {
        const a = body.assertion;
        const assertion = {
          authenticatorData: Buffer.from(String(a.authenticatorData ?? ""), "base64url"),
          clientDataJSON: String(a.clientDataJSON ?? ""),
          signature: Buffer.from(String(a.signature ?? ""), "base64url"),
        };
        let reason = "NOT_A_KEEPER";
        for (const [i, k] of keepers.entries()) {
          if (k.kind !== PASSKEY) continue;
          try {
            approval = passkeyApproval(k.key, message, k.site, assertion);
            at = i;
            break;
          } catch (error) {
            // Another keeper's passkey refuses with BAD_SIGNATURE; anything else is this approval's fault.
            if (
              error instanceof ApprovalRefused &&
              error.reason !== "BAD_SIGNATURE" &&
              error.reason !== "ANOTHER_SITE"
            )
              reason = error.reason;
          }
        }
        ensure(approval, reason === "NOT_A_KEEPER" ? "NOT_A_KEEPER" : "APPROVAL_REFUSED", reason);
      } else {
        at = Number(body.keeper);
        const k = keepers[at];
        ensure(k && k.kind === RAW_P256, "NOT_A_KEEPER");
        try {
          approval = rawApproval(k.key, message, unhex(String(body.signature ?? "")));
        } catch (error) {
          throw new Fault(
            "APPROVAL_REFUSED",
            error instanceof ApprovalRefused ? error.reason : String(error),
          );
        }
      }
      payment.approvals[at] = {
        sig: hex(approval.sig),
        authData: hex(approval.authData),
        tail: hex(approval.tail),
      };
      if (payment.approvals.filter(Boolean).length >= 2) payment.status = "ready";
      this.save(payment);
      return payment;
    });
  }

  async cancel(id: string, auth: DeskAuth) {
    this.verifyAuth("cancel", id, auth);
    return this.lock(async () => {
      const payment = this.payment(id);
      ensure(payment, "NO_PAYMENT");
      ensure(payment.status === "approving" || payment.status === "ready", "WRONG_ROUND", payment.status);
      payment.status = "cancelled";
      this.save(payment);
      return payment;
    });
  }

  /**
   * The desk's round: lapsed payments end, numbers follow the payments still under way, chip-ins and
   * returned escrows fold into the treasury coin, and the next payment goes out once approved.
   */
  tick(): Promise<void> {
    this.#ticking ??= this.round().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  private async round() {
    await this.lock(async () => {
      const now = this.now();
      for (const p of this.active())
        if (p.status !== "submitted" && p.validUntil <= now + 30) {
          p.status = "lapsed";
          this.save(p);
        }
    });
    const coins = await treasuryCoins(this.contract, this.assetId);
    if (!coins.treasury) return;
    let treasury = coins.treasury;
    let units = unitsOn(treasury, this.assetId);
    // A payment whose approvals all came in pays first; until it is done, nothing else spends the coin.
    const head = await this.lock(async () => {
      // A payment submitted before the host stopped, which the counter shows went out, is done.
      for (const p of this.active())
        if (p.status === "submitted" && BigInt(p.left) > units) {
          p.status = "done";
          this.save(p);
        }
      const active = this.active();
      // A payment the keepers stopped, or that lapsed, gives its number to the ones after it, whose
      // approvals named the old numbers and are asked for again.
      for (const [i, p] of active.entries()) {
        const expected = String(units - BigInt(i));
        if (p.left !== expected && p.status !== "submitted") {
          p.left = expected;
          p.approvals = [null, null, null];
          p.status = "approving";
          this.save(p);
        }
      }
      return active[0];
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
      units = unitsOn(treasury, this.assetId);
    }
  }

  private async submit(
    head: PasskeyPayment,
    coin: Awaited<ReturnType<typeof treasuryCoins>>["treasury"] & object,
  ) {
    await this.lock(async () => {
      const p = this.payment(head.id)!;
      p.status = "submitted";
      p.attempts = (p.attempts ?? 0) + 1;
      this.save(p);
    });
    const message = this.message(head);
    const keepers = this.passkeys.keepers;
    const approvals = head.approvals.map((a, i) => {
      if (!a) return null;
      const approval = { sig: unhex(a.sig), authData: unhex(a.authData), tail: unhex(a.tail) };
      return approvalHolds(keepers[i]!.kind, keepers[i]!.key, message, keepers[i]!.site, approval)
        ? approval
        : null;
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

/** The approvals desk's routes, below `/desk/v1/`, beside the signing desk's. */
export async function approvalsRoute(
  desk: ApprovalDesk,
  method: string,
  parts: string[],
  body: Record<string, unknown>,
  keeper?: string,
): Promise<unknown> {
  const [what, id = "", action] = parts;
  if (method === "GET" && what === "hive") return desk.describe();
  // The delegatee serves no browser: its keys reach the console through the desk, and the console
  // checks the treasury they build against the hive's.
  if (method === "GET" && what === "delegatee") return desk.conn.delegatee.info();
  // An approval is its own authority: a passkey's signature over this payment.
  if (method === "POST" && what === "payments" && action === "approve")
    return { payment: shown(await desk.approve(id, body as never)) };
  if (method === "GET") desk.verifyRead(keeper);
  if (method === "GET" && what === "payments" && !id) return desk.overview();
  if (method === "GET" && what === "listing") return { pending: null };
  if (method === "GET" && what === "payments") {
    const payment = desk.payment(id);
    ensure(payment, "NO_PAYMENT");
    return { payment: shown(payment) };
  }
  if (method === "POST" && what === "payments" && action === "start")
    return { payment: shown(await desk.start(id, body.auth as DeskAuth)) };
  if (method === "POST" && what === "payments" && action === "cancel")
    return { payment: shown(await desk.cancel(id, body.auth as DeskAuth)) };
  if (method === "POST" && what === "withdrawals" && !id)
    return {
      payment: shown(
        await desk.startWithdrawal(body.auth as DeskAuth, {
          address: body.address,
          amountSats: body.amountSats,
        }),
      ),
    };
  throw new Fault("NOT_FOUND");
}

/** Serves a v5 hive's desk over HTTP for keepers' consoles; the host's TLS proxy puts it on HTTPS. */
export async function startApprovalDesk(hive: string, options: DeskOptions) {
  const desk = await ApprovalDesk.open(hive, options);
  // Three keepers' consoles ask for little; anything asking for more is not one of them.
  const limit = rateLimit(240, 120);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!consoleCors(req, res, options.origins)) return;
    try {
      ensure(limit.take(clientAddress(req)), "RATE_LIMITED", "too many requests; try again in a minute");
      const url = new URL(req.url ?? "/", "http://desk");
      const parts = url.pathname.split("/").filter(Boolean);
      ensure(parts[0] === "desk" && parts[1] === "v1", "NOT_FOUND");
      const body =
        req.method === "POST" ? ((await readJsonBody(req, 256 * 1024)) as Record<string, unknown>) : {};
      ensure(body && typeof body === "object" && !Array.isArray(body), "INVALID_JSON");
      const keeper = req.headers["x-hive-keeper"];
      sendJson(
        res,
        200,
        await approvalsRoute(
          desk,
          req.method ?? "GET",
          parts.slice(2),
          body,
          keeper ? String(keeper) : undefined,
        ),
      );
    } catch (error) {
      const { status, body } = faultStatus(error);
      sendJson(res, status, body);
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
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
