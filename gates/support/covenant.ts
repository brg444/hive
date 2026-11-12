import { spawnSync } from "node:child_process";
import {
  ARTIFACTS,
  type Attempt,
  type ClaimPlan,
  checkClaim,
  claimMessage,
  claimSpend,
  claimVariables,
  escrowArguments,
  type IndexedCoin,
  instantiate,
  planVariables,
  receiptMessage,
  type SendPlan,
  type ServiceKeys,
  sendMessages,
  sendSpend,
  spendFingerprint,
  spendRequestMessage,
  type TreasuryTerms,
  taprootOutput,
  treasuryArguments,
  treasuryVariables,
} from "@hive/ark";
import { type Action, buildSpend, type RouteAnswer, type RouteName } from "@hive/executor";
import { ensure, hex, sha256Hex, unhex, writeJson } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";

/** An explicit result of the offline model's signature check, never an Emulator VM log. */
export interface ModelRejection {
  source: "offline-model";
  route: RouteName;
  actionId: string;
  outpoints: string[];
  at: number;
  vin: number;
  reason: "signature-verification";
}

export class ModelSignatureRejection extends Error {
  constructor(readonly vin: number) {
    super("internal error");
  }
}

export interface VmIdentity {
  containerId: string;
  image: string;
  startedAt: string;
}

export interface VmFailure {
  at: string;
  digest: string;
  reason: "signature-verification" | "other";
  vin: number | null;
}

export function normalizeVmFailure(line: string): VmFailure {
  return {
    at: line.split(" ")[0]!,
    digest: sha256Hex(line),
    reason:
      /msg="failed to process transaction"/.test(line) &&
      /failed to execute arkade script:.*signature verification failed vin=\d+/.test(line)
        ? "signature-verification"
        : "other",
    vin: /vin=(\d+)/.exec(line) ? Number(/vin=(\d+)/.exec(line)![1]) : null,
  };
}

export interface VmRejection {
  source: "emulator-log";
  identity: VmIdentity;
  previousLines: string[];
  lines: VmFailure[];
  since: string;
  until: string;
}

export type RejectionBasis =
  | { kind: "forged-claim"; plan: ClaimPlan; keys: ServiceKeys }
  | {
      kind: "swapped-send";
      plan: SendPlan;
      destination: string;
      signatures: string[];
      treasury: TreasuryTerms;
      keys: ServiceKeys;
    };

export interface RejectionRecord {
  schema: "hive-covenant-rejection/v4";
  label: string;
  basis: RejectionBasis;
  route: RouteName;
  actionId: string;
  action: Action & { spend: NonNullable<Action["spend"]> };
  checkpointTapscript: string;
  preparedAt: number;
  attemptedAt?: number;
  respondedAt?: number;
  before: IndexedCoin[];
  after?: IndexedCoin[];
  answer?: RouteAnswer;
  attempt?: Attempt;
  rejection?: ModelRejection | VmRejection;
}

export function rejectionActionId(action: Action, route: RouteName): string {
  if (route === "self") return action.txid;
  ensure(action.request, "TAMPER_REQUEST_REQUIRED");
  return spendFingerprint(action.request.templateId, action.request.variables, action.request.outpoints);
}

const outpointsOf = (r: RejectionRecord) => r.action.spend.inputs.map((i) => `${i.txid}:${i.vout}`);
const sameSet = (a: string[], b: string[]) =>
  a.length === new Set(a).size &&
  b.length === new Set(b).size &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function requireUnchangedInputs(r: RejectionRecord, coins: IndexedCoin[] | undefined): void {
  ensure(Array.isArray(coins), "TAMPER_INPUTS_MISSING");
  const outpoints = outpointsOf(r);
  ensure(
    outpoints.length > 0 &&
      sameSet(
        outpoints,
        coins.map((c) => `${c.txid}:${c.vout}`),
      ),
    "TAMPER_INPUTS_MISMATCH",
  );
  for (const input of r.action.spend.inputs) {
    const coin = coins.find((c) => c.txid === input.txid && c.vout === input.vout)!;
    ensure(
      coin.amount === input.amount &&
        coin.script === `5120${hex(taprootOutput(input.tapscripts.map(unhex)))}` &&
        coin.isSpent === false &&
        coin.isSwept === false &&
        !coin.spentBy &&
        !coin.arkTxid &&
        !coin.settledBy,
      "TAMPER_INPUT_CHANGED",
    );
  }
}

const ordered = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(ordered)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, value]) => [k, ordered(value)]),
        )
      : v;
const equal = (a: unknown, b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

function requireMaliciousAction(r: RejectionRecord): void {
  const basis = r.basis;
  const request = r.action.request;
  ensure(request && request.templateId === basis.plan.templateId, "TAMPER_TEMPLATE");
  let spend: NonNullable<Action["spend"]>;
  let variables: Record<string, string>;
  if (basis.kind === "forged-claim") {
    const p = basis.plan;
    ensure(r.label.endsWith("Claim"), "TAMPER_CASE");
    ensure(
      p.amount > 0 &&
        p.amount <= p.coin.amount &&
        p.expiresAt === r.action.validUntil &&
        p.expiresAt <= p.escrow.timeoutAt,
      "TAMPER_CLAIM_TERMS",
    );
    ensure(
      !schnorr.verify(
        unhex(p.receiptSig),
        receiptMessage(p.escrow.escrowId, p.amount),
        unhex(p.escrow.payer),
      ),
      "TAMPER_RECEIPT_IS_VALID",
    );
    ensure(
      schnorr.verify(unhex(p.claimSig), claimMessage(p.escrow.escrowId, p.amount), unhex(p.escrow.provider)),
      "TAMPER_PROVIDER_SIGNATURE",
    );
    spend = claimSpend(p, instantiate(ARTIFACTS.escrow, escrowArguments(p.escrow), basis.keys));
    variables = claimVariables(p);
  } else {
    ensure(basis.kind === "swapped-send" && r.label.endsWith("Send"), "TAMPER_CASE");
    const p = basis.plan;
    ensure(
      p.account === "treasury" &&
        p.pair &&
        basis.destination !== p.destination &&
        p.validUntil === r.action.validUntil,
      "TAMPER_SEND_TERMS",
    );
    const instance = instantiate(ARTIFACTS.treasury, treasuryArguments(basis.treasury), basis.keys);
    const messages = sendMessages(p, instance, r.checkpointTapscript);
    ensure(
      messages.length === basis.signatures.length &&
        messages.every((message, i) =>
          schnorr.verify(unhex(basis.signatures[i]!), message, unhex(basis.treasury.pairs[p.pair!])),
        ),
      "TAMPER_ATTESTATIONS",
    );
    const swapped = { ...p, destination: basis.destination };
    spend = sendSpend(swapped, instance, basis.signatures);
    variables = {
      ...planVariables(treasuryVariables(basis.treasury), swapped),
      ...Object.fromEntries(basis.signatures.map((sig, i) => [`sig_${i}`, sig])),
    };
  }
  ensure(equal(spend, r.action.spend), "TAMPER_SPEND_BASIS");
  ensure(equal(variables, request.variables), "TAMPER_REQUEST_VARIABLES");
}

/** Operational correlation: a bounded, otherwise quiet VM-log window, not a signed rejection. */
export function requireCovenantRejection(r: RejectionRecord, mode: "offline" | "live"): void {
  ensure(r.schema === "hive-covenant-rejection/v4", "TAMPER_SCHEMA");
  ensure(r.route === "self" || r.route === "delegatee", "TAMPER_ROUTE");
  requireMaliciousAction(r);
  ensure(buildSpend(r.action.spend, r.checkpointTapscript).txid === r.action.txid, "TAMPER_TXID");
  ensure(r.actionId === rejectionActionId(r.action, r.route), "TAMPER_ACTION");
  if (r.action.request) {
    const request = r.action.request;
    ensure(
      sameSet(request.outpoints, outpointsOf(r)) && request.expiresAt === r.action.validUntil,
      "TAMPER_REQUEST_INPUTS",
    );
    ensure(
      schnorr.verify(
        unhex(request.signature),
        spendRequestMessage(
          spendFingerprint(request.templateId, request.variables, request.outpoints),
          request.expiresAt,
        ),
        unhex(request.pubkey),
      ),
      "TAMPER_REQUEST_SIGNATURE",
    );
  }
  ensure(
    Number.isFinite(r.preparedAt) && Number.isFinite(r.attemptedAt) && Number.isFinite(r.respondedAt),
    "TAMPER_UNRESOLVED",
  );
  const start = r.attemptedAt!;
  const end = r.respondedAt!;
  ensure(r.preparedAt <= start && start <= end && end - start < 30_000, "TAMPER_WINDOW");
  ensure(start < r.action.validUntil * 1000, "TAMPER_EXPIRED");
  requireUnchangedInputs(r, r.before);
  requireUnchangedInputs(r, r.after);
  if (r.route === "self")
    ensure(r.answer?.result === "refused" || r.answer?.result === "unavailable", "TAMPER_NO_RESPONSE");
  else {
    const a = r.attempt;
    ensure(r.answer?.result === "accepted" && r.answer.reference === r.actionId, "TAMPER_REGISTRATION");
    ensure(a && a.success === false && a.error.includes("emulator:"), "TAMPER_NO_ATTEMPT");
    ensure(sameSet(a.outpoints, outpointsOf(r)), "TAMPER_ATTEMPT_INPUTS");
    ensure(
      a.attemptedAt * 1000 >= start - 1000 && a.attemptedAt * 1000 <= end + 1000,
      "TAMPER_STALE_ATTEMPT",
    );
    ensure(!a.txid || a.txid === r.action.txid, "TAMPER_ATTEMPT_TXID");
  }
  const proof = r.rejection;
  ensure(proof, "VM_REJECTION_UNPROVEN");
  if (proof.source === "offline-model") {
    ensure(mode === "offline", "MODEL_IS_NOT_VM_PROOF");
    ensure(
      proof.route === r.route && proof.actionId === r.actionId && sameSet(proof.outpoints, outpointsOf(r)),
      "TAMPER_MODEL_ACTION",
    );
    ensure(
      proof.at >= start && proof.at <= end && proof.vin === 0 && proof.reason === "signature-verification",
      "TAMPER_MODEL_REJECTION",
    );
    return;
  }
  ensure(proof.source === "emulator-log", "VM_REJECTION_UNPROVEN");
  ensure(
    /^[0-9a-f]{64}$/.test(proof.identity.containerId) &&
      proof.identity.image.startsWith("ghcr.io/arkade-os/emulator:"),
    "EMULATOR_UNIDENTIFIED",
  );
  ensure(Date.parse(proof.identity.startedAt) <= start, "EMULATOR_RESTARTED");
  ensure(
    Date.parse(proof.since) === start - 1000 && Date.parse(proof.until) === end + 1000,
    "VM_FAILURE_WINDOW",
  );
  ensure(
    proof.lines.length === 1 && !proof.previousLines.includes(proof.lines[0]!.digest),
    "VM_FAILURE_UNCORRELATED",
  );
  const line = proof.lines[0]!;
  const timestamp = Date.parse(line.at);
  ensure(timestamp >= start - 1000 && timestamp <= end + 1000, "VM_FAILURE_WINDOW");
  ensure(
    /^[0-9a-f]{64}$/.test(line.digest) && line.reason === "signature-verification" && line.vin === 0,
    "UNEXPECTED_REJECTION",
  );
}

export interface RejectionSource {
  identity(): VmIdentity;
  lines(since: string, until: string): string[];
}

/** Reading existing logs changes no stack state. Hosted Emulators expose no equivalent proof API. */
export function localRejectionSource(): RejectionSource {
  // The default names the local Docker setup this project grew up on; set the variable for another.
  const context = process.env.BUZZ_GATE_DOCKER_CONTEXT ?? "colima-buzz-pool";
  const container = process.env.BUZZ_GATE_EMULATOR_CONTAINER ?? "buzz-pool-emulator";
  const docker = (args: string[]) => {
    const result = spawnSync("docker", ["--context", context, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    ensure(result.status === 0, "EMULATOR_LOGS_UNAVAILABLE");
    return `${result.stdout}\n${result.stderr}`;
  };
  return {
    identity() {
      const [containerId, image, startedAt] = docker([
        "inspect",
        "--format",
        "{{.Id}}\n{{.Config.Image}}\n{{.State.StartedAt}}",
        container,
      ])
        .trim()
        .split("\n");
      ensure(containerId && image && startedAt, "EMULATOR_UNIDENTIFIED");
      return { containerId, image, startedAt };
    },
    lines(since, until) {
      return docker(["logs", "--timestamps", "--since", since, "--until", until, container])
        .split("\n")
        .filter((line) => line.includes('msg="failed to process transaction"'));
    },
  };
}

/** Prepare before posting; retain incomplete observations if submission or correlation fails. */
export async function captureRejection(options: {
  record: Omit<RejectionRecord, "schema" | "actionId" | "preparedAt" | "before">;
  journalPath?: string;
  mode: "offline" | "regtest" | "mutinynet";
  observe(): Promise<IndexedCoin[]>;
  submit(): Promise<{ answer: RouteAnswer; attempt?: Attempt }>;
  model?(): ModelRejection[];
  source?: RejectionSource;
}): Promise<RejectionRecord> {
  ensure(
    options.mode !== "mutinynet" || options.source,
    "VM_REJECTION_UNAVAILABLE",
    "the hosted Emulator exposes no correlated VM rejection",
  );
  const source = options.mode === "offline" ? undefined : (options.source ?? localRejectionSource());
  const identity = source?.identity();
  const r: RejectionRecord = {
    label: options.record.label,
    basis: options.record.basis,
    route: options.record.route,
    action: options.record.action,
    checkpointTapscript: options.record.checkpointTapscript,
    schema: "hive-covenant-rejection/v4",
    actionId: rejectionActionId(options.record.action, options.record.route),
    preparedAt: Date.now(),
    before: await options.observe(),
  };
  requireUnchangedInputs(r, r.before);
  const save = () => {
    if (options.journalPath) writeJson(options.journalPath, r);
  };
  save();
  const previousLines =
    source
      ?.lines(new Date(Date.now() - 5000).toISOString(), new Date(Date.now() + 1000).toISOString())
      .map(sha256Hex) ?? [];
  r.attemptedAt = Date.now();
  save();
  const result = await options.submit();
  r.respondedAt = Date.now();
  Object.assign(r, result);
  r.after = await options.observe();
  save();
  if (source) {
    ensure(JSON.stringify(source.identity()) === JSON.stringify(identity), "EMULATOR_RESTARTED");
    const since = new Date(r.attemptedAt - 1000).toISOString();
    const until = new Date(r.respondedAt + 1000).toISOString();
    r.rejection = {
      source: "emulator-log",
      identity: identity!,
      previousLines,
      since,
      until,
      lines: source
        .lines(since, until)
        .map(normalizeVmFailure)
        .filter((line) => !previousLines.includes(line.digest)),
    };
  } else {
    r.rejection = options
      .model?.()
      .find(
        (p) =>
          p.route === r.route &&
          p.actionId === r.actionId &&
          p.at >= r.attemptedAt! &&
          p.at <= r.respondedAt!,
      );
  }
  save();
  requireCovenantRejection(r, options.mode === "offline" ? "offline" : "live");
  return r;
}

export function refusalChecks(
  results: Record<string, unknown>,
  mode: "offline" | "live",
  expectedPaid: number,
): Record<string, boolean> {
  const check = (name: string) => {
    try {
      const r = results[name] as RejectionRecord;
      ensure(r.label === name && r.route === (name.startsWith("self") ? "self" : "delegatee"), "TAMPER_CASE");
      requireCovenantRejection(r, mode);
      return true;
    } catch {
      return false;
    }
  };
  const unchanged = (names: string[]) =>
    names.every((name) => {
      try {
        const r = results[name] as RejectionRecord;
        requireUnchangedInputs(r, r.after);
        return true;
      } catch {
        return false;
      }
    });
  const observedPayment = () => {
    try {
      const payment = results.genuineClaimExecution as {
        txid: string;
        spend: NonNullable<Action["spend"]>;
        checkpointTapscript: string;
        plan: ClaimPlan;
        outputs: IndexedCoin[];
      };
      const refused = results.compromisedClaim as RejectionRecord;
      ensure(refused.basis.kind === "forged-claim", "GENUINE_CLAIM_BASIS");
      checkClaim(payment.plan);
      ensure(
        equal(payment.plan.escrow, refused.basis.plan.escrow) &&
          equal(payment.plan.coin, refused.basis.plan.coin),
        "GENUINE_CLAIM_TERMS",
      );
      ensure(
        equal(
          payment.spend,
          claimSpend(
            payment.plan,
            instantiate(ARTIFACTS.escrow, escrowArguments(payment.plan.escrow), refused.basis.keys),
          ),
        ),
        "GENUINE_CLAIM_SPEND",
      );
      ensure(
        buildSpend(payment.spend, payment.checkpointTapscript).txid === payment.txid,
        "GENUINE_CLAIM_TXID",
      );
      ensure(
        sameSet(
          payment.spend.inputs.map((i) => `${i.txid}:${i.vout}`),
          outpointsOf(refused),
        ),
        "GENUINE_CLAIM_INPUTS",
      );
      const expected = payment.spend.outputs[0]!;
      ensure(expected.amount === expectedPaid && expectedPaid > 0, "GENUINE_CLAIM_AMOUNT");
      ensure(
        payment.outputs.length === 1 &&
          payment.outputs[0]!.txid === payment.txid &&
          payment.outputs[0]!.vout === (payment.spend.extensionIndex === 0 ? 1 : 0) &&
          payment.outputs[0]!.script === expected.script &&
          payment.outputs[0]!.amount === expected.amount,
        "GENUINE_CLAIM_OUTPUT",
      );
      return results.providerPaid === expectedPaid;
    } catch {
      return false;
    }
  };
  const sameAction = (a: string, b: string) =>
    equal((results[a] as RejectionRecord)?.action, (results[b] as RejectionRecord)?.action);
  const expected = {
    unapprovedQuote: "UNAPPROVED_REQUEST",
    secondFunding: "ESCROW_FUNDED",
    firstPromise: "accepted",
    secondPromise: "RESERVED",
    unapprovedWithdrawal: "UNAPPROVED_WITHDRAWAL",
    haltedPurchase: "HALTED",
  };
  const desk = results.forgedClaimAtDesk as { status?: number; error?: string } | undefined;
  const genuine = results.genuineClaimAfter as { status?: number; spendId?: string } | undefined;
  return {
    ...Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, results[k] === v])),
    forgedClaimAtDesk: desk?.status === 400 && desk.error === "CLAIM_INVALID",
    compromisedClaim: check("compromisedClaim") && sameAction("compromisedClaim", "selfForgedClaim"),
    escrowAfterForgedClaim: unchanged(["compromisedClaim"]),
    compromisedSend: check("compromisedSend") && sameAction("compromisedSend", "selfSwappedSend"),
    treasuryAfterSwappedSend: unchanged(["compromisedSend"]),
    selfForgedClaim: check("selfForgedClaim"),
    selfSwappedSend: check("selfSwappedSend"),
    coinsAfterDirect: unchanged(["selfForgedClaim", "selfSwappedSend"]),
    genuineClaimAfter: genuine?.status === 200 && /^[0-9a-f]{64}$/.test(genuine.spendId ?? ""),
    providerPaid: Number.isSafeInteger(expectedPaid) && observedPayment(),
  };
}
