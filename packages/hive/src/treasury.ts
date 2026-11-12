import { randomBytes } from "node:crypto";
import {
  type Account,
  accountCoins,
  type Connection,
  type CovenantSpend,
  deriveAccount,
  type Pair,
  pickCoins,
  type SendPlan,
  type SpendRequest,
  sendMessages,
  sendSpend,
  signedSend,
  spendRequestFor,
  type TreasuryTerms,
  treasuryArguments,
  treasuryPlanVariables,
  treasurySendTemplate,
} from "@hive/ark";
import {
  type Attempt,
  buildSpend,
  type ExecutionState,
  executionAttempts,
  executionState,
  type RouteName,
} from "@hive/executor";
import { ensure, fail, hex, readJsonIfPresent, withLock, writeJson } from "@hive/kit";
import type { SignedQuote } from "@hive/protocol";
import {
  type Purpose,
  type SessionRequest,
  type StewardEndpoint,
  signWithPair,
  type WithdrawalTerms,
} from "@hive/steward/client";

/**
 * The coordinator's view of the treasury: its terms, the delegatee's artifact
 * for it, and the three steward processes. It holds no key.
 */
export interface Treasury {
  conn: Connection;
  terms: TreasuryTerms;
  stewardKeys: readonly [string, string, string];
  stewards: readonly [StewardEndpoint, StewardEndpoint, StewardEndpoint];
  /** The delegatee's id for the treasury artifact, from registration. */
  artifactId: string;
  /** The hive this treasury belongs to, whose halt switch stops its new purchases. */
  hive?: string;
}

export const treasuryAccountOf = (t: Pick<Treasury, "conn" | "terms">) =>
  deriveAccount(t.conn, "treasury", treasuryArguments(t.terms));

/** A treasury spend from its fixed plan to an observed outcome, saved before each submission. */
export interface SpendJournal {
  schema: "hive-spend/v4";
  label: string;
  purpose: { kind: "allocation"; quote: SignedQuote } | { kind: "withdrawal"; withdrawal: WithdrawalTerms };
  plan: SendPlan;
  sessions: { attest: string; register: string };
  attestations?: string[];
  /** The delegatee's form of the spend, signed by the pair's exit-leaf key. */
  request?: SpendRequest;
  /** The same spend as data, for a route that builds it itself, and the txid every route builds. */
  spend?: CovenantSpend;
  arkTxid?: string;
  spendId?: string;
  status: "planned" | "attested" | "registered" | "done" | "expired";
  /** Each route's answer, in order. */
  attempts?: Attempt[];
  execution?: ExecutionState;
  /** The Ark transaction that spent the coins, once the indexer shows it. */
  txid?: string;
}

function purposeFor(journal: SpendJournal, stage: "attest" | "register"): Purpose {
  const signatures = journal.attestations ?? [];
  if (journal.purpose.kind === "allocation")
    return stage === "attest"
      ? { kind: "allocation", stage, quote: journal.purpose.quote, plan: journal.plan }
      : { kind: "allocation", stage, quote: journal.purpose.quote, plan: journal.plan, signatures };
  return stage === "attest"
    ? { kind: "withdrawal", stage, withdrawal: journal.purpose.withdrawal, plan: journal.plan }
    : { kind: "withdrawal", stage, withdrawal: journal.purpose.withdrawal, plan: journal.plan, signatures };
}

/** Plan a send of exactly `amount` to `destination`, authorized by `pair`, valid for `validSeconds`. */
export async function planTreasurySend(
  treasury: Treasury,
  args: { pair: Pair; amount: number; destination: string; validSeconds: number; exclude?: string[] },
): Promise<SendPlan> {
  const account = treasuryAccountOf(treasury);
  const coins = await accountCoins(treasury.conn, account.pkScript, treasury.terms.renewalWindowSeconds);
  const free = (c: { txid: string; vout: number }) => !(args.exclude ?? []).includes(`${c.txid}:${c.vout}`);
  const { picked, change } = pickCoins(
    { spendable: coins.spendable.filter(free), renewing: coins.renewing.filter(free) },
    args.amount,
    treasury.conn.operator.dust,
  );
  const validUntil = Math.floor(Date.now() / 1000) + args.validSeconds;
  const templateId = await treasury.conn.delegatee.registerTemplate(
    treasurySendTemplate(treasury.artifactId, args.pair, picked.length, change > 0),
  );
  const terms = { amount: args.amount, change, validUntil, destination: args.destination };
  return {
    account: "treasury",
    pair: args.pair,
    coins: picked.map((c) => ({ txid: c.txid, vout: c.vout, amount: c.amount, script: c.script })),
    templateId,
    variables: treasuryPlanVariables(treasury.terms, terms),
    ...terms,
  };
}

export function newSpendJournal(
  label: string,
  purpose: SpendJournal["purpose"],
  plan: SendPlan,
): SpendJournal {
  return {
    schema: "hive-spend/v4",
    label,
    purpose,
    plan,
    sessions: { attest: hex(randomBytes(32)), register: hex(randomBytes(32)) },
    status: "planned",
  };
}

/**
 * Execute the treasury's fixed spend through the configured routes and
 * observe its outcome. The pair's attestations, signed request, spend and
 * expected txid are saved before a prepared attempt can post. Resumes retain
 * that action and route history, including any covenant refusal.
 *
 * A plan without a signed request can expire before registration. Once an
 * attempt is prepared, its posting deadline does not prove that no service
 * emitted signatures. The fixed spend remains unresolved until observation
 * establishes its outcome.
 */
export async function driveTreasurySpend(
  treasury: Treasury,
  path: string,
  options: { pollMs?: number; timeoutMs?: number; routes?: RouteName[] } = {},
): Promise<SpendJournal> {
  return withLock(`${path}.lock`, () => driveTreasurySpendLocked(treasury, path, options));
}

async function driveTreasurySpendLocked(
  treasury: Treasury,
  path: string,
  options: { pollMs?: number; timeoutMs?: number; routes?: RouteName[] },
): Promise<SpendJournal> {
  const journal = readJsonIfPresent<SpendJournal>(path);
  ensure(journal, "JOURNAL_MISSING", path);
  if (journal.status === "done" || (journal.status === "expired" && !journal.request)) return journal;
  const legacyRequest = Boolean(journal.request);
  const save = () => writeJson(path, journal);
  const now = () => Math.floor(Date.now() / 1000);
  const pair = journal.plan.pair!;
  const account = treasuryAccountOf(treasury);
  const session = (id: string, stage: "attest" | "register"): SessionRequest => ({
    id,
    pair,
    purpose: purposeFor(journal, stage),
  });
  if (
    (journal.status === "planned" || journal.status === "attested") &&
    now() >= journal.plan.validUntil - 60
  ) {
    journal.status = "expired";
    save();
    return journal;
  }
  if (journal.status === "planned") {
    const messages = sendMessages(journal.plan, account.instance, treasury.conn.operator.checkpointTapscript);
    journal.attestations = await signWithPair(
      treasury.stewards,
      treasury.stewardKeys,
      session(journal.sessions.attest, "attest"),
      messages,
    );
    journal.status = "attested";
    save();
  }
  if (journal.status === "attested") {
    const { variables, outpoints } = signedSend(journal.plan, journal.attestations!);
    const pending = spendRequestFor(
      journal.plan.templateId,
      variables,
      outpoints,
      journal.plan.validUntil,
      treasury.terms.pairs[pair],
    );
    const [signature] = await signWithPair(
      treasury.stewards,
      treasury.stewardKeys,
      session(journal.sessions.register, "register"),
      [pending.message],
    );
    journal.request = pending.request(signature!);
    journal.spendId = pending.id;
    journal.status = "registered";
    journal.spend = sendSpend(journal.plan, account.instance, journal.attestations!);
    journal.arkTxid = buildSpend(journal.spend, treasury.conn.operator.checkpointTapscript).txid;
    journal.execution = executionState(
      {
        txid: journal.arkTxid,
        spend: journal.spend,
        request: journal.request,
        validUntil: journal.plan.validUntil,
      },
      options.routes ?? treasury.conn.router.routes,
    );
    save();
  }
  if (!journal.spend) {
    journal.spend = sendSpend(journal.plan, account.instance, journal.attestations!);
    journal.arkTxid = buildSpend(journal.spend, treasury.conn.operator.checkpointTapscript).txid;
    save();
  }
  const action = {
    txid: journal.arkTxid!,
    spend: journal.spend,
    request: journal.request!,
    validUntil: journal.plan.validUntil,
  };
  if (!journal.execution) {
    journal.execution = executionState(
      action,
      options.routes ?? treasury.conn.router.routes,
      journal.attempts,
      legacyRequest,
    );
    save();
  }
  const outcome = await treasury.conn.router.execute(action, {
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.routes ? { routes: options.routes } : {}),
    execution: journal.execution,
    onState: (state) => {
      journal.execution = state;
      journal.attempts = executionAttempts(state);
      save();
    },
  });
  if (outcome.status === "elsewhere")
    fail("SPEND_SUPERSEDED", "an input is affirmatively linked to another spend");
  if (outcome.status === "invalid") fail(journal.attempts?.at(-1)?.detail ?? "SPEND_INVALID");
  if (outcome.status === "pending")
    fail("SPEND_PENDING", journal.attempts?.at(-1)?.detail ?? "no observed outcome");
  if (outcome.status === "done") {
    journal.status = "done";
    journal.txid = journal.arkTxid;
  } else journal.status = "expired";
  save();
  return journal;
}

export type { Account };
