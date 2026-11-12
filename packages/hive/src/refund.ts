import { randomBytes } from "node:crypto";
import {
  deriveAccount,
  type EscrowTerms,
  escrowArguments,
  escrowRefundTemplate,
  type Pair,
  REFUND_MARGIN_SECONDS,
  type RefundPlan,
  refundSpend,
  requireCoinExpiry,
  lookupSpendCoins,
  type SpendRequest,
  spendRequestFor,
} from "@hive/ark";
import {
  type Action,
  type Attempt,
  buildSpend,
  type ExecutionState,
  executionState,
  executionAttempts,
  delegateeRoute,
} from "@hive/executor";
import { ensure, ensureEqual, fail, hex, localPath, readJsonIfPresent, withLock, writeJson } from "@hive/kit";
import { escrowTermsFromQuote, requireValidSignedQuote, type SignedQuote } from "@hive/protocol";
import { signWithPair } from "@hive/steward/client";
import type { Treasury } from "./treasury.js";

export interface RegisteredRefund {
  spendId: string;
  escrow: string;
  pair: Pair;
  refund: RefundPlan;
  request: SpendRequest;
}
interface RefundJournal {
  schema: "hive-refund-execution/v4";
  quoteId: string;
  refund: RefundPlan;
  /** The fixed spend is signatureless; a later pair registration adds transport authorization only. */
  action: Action;
  execution: ExecutionState;
  registration?: RegisteredRefund;
}
const pathFor = (quote: SignedQuote, path?: string) =>
  path ?? localPath("v4", "refund-execution", `${quote.quoteId}.json`);

async function loadRefund(
  treasury: Treasury,
  quote: SignedQuote,
  path: string,
  legacyRegistration?: RegisteredRefund,
): Promise<RefundJournal | null> {
  const saved = readJsonIfPresent<RefundJournal>(path);
  if (saved) {
    ensure(
      saved.schema === "hive-refund-execution/v4" && saved.quoteId === quote.quoteId,
      "JOURNAL_MISMATCH",
    );
    return saved;
  }
  const terms = escrowTermsFromQuote(quote) as EscrowTerms;
  const escrow = deriveAccount(treasury.conn, "escrow", escrowArguments(terms));
  if (legacyRegistration) {
    const registration = structuredClone(legacyRegistration);
    ensureEqual(registration.refund.escrow, terms, "JOURNAL_MISMATCH", "refund escrow");
    ensure(
      registration.escrow === escrow.pkScript &&
        registration.refund.coin.script === escrow.pkScript &&
        registration.refund.coin.amount === Number(quote.body.capSats) &&
        ["01", "02", "12"].includes(registration.pair),
      "JOURNAL_MISMATCH",
    );
    const pending = spendRequestFor(
      registration.refund.templateId,
      {},
      [registration.refund.coin.txid + ":" + registration.refund.coin.vout],
      registration.refund.expiresAt,
      treasury.terms.pairs[registration.pair],
    );
    ensure(registration.spendId === pending.id, "JOURNAL_MISMATCH");
    // Verifies the saved signature and its exact terms; no new signature is requested.
    ensureEqual(
      registration.request,
      pending.request(registration.request.signature),
      "JOURNAL_MISMATCH",
      "refund request",
    );
    const spend = refundSpend(registration.refund, escrow.instance);
    const action: Action = {
      txid: buildSpend(spend, treasury.conn.operator.checkpointTapscript).txid,
      spend,
      validUntil: registration.refund.expiresAt,
    };
    const migrated: RefundJournal = {
      schema: "hive-refund-execution/v4",
      quoteId: quote.quoteId,
      refund: registration.refund,
      action,
      registration,
      // The old record does not preserve every submission or its response.
      execution: executionState(action, ["self", "delegatee"], [], true),
    };
    writeJson(path, migrated);
    return migrated;
  }
  const coins = (await treasury.conn.arkd.coins({ scripts: [escrow.pkScript], spendableOnly: true })).filter(
    (coin) =>
      coin.script === escrow.pkScript &&
      !coin.isSpent &&
      !coin.isSwept &&
      coin.amount === Number(quote.body.capSats),
  );
  if (coins.length === 0) return null;
  ensure(coins.length === 1, "REFUND_PENDING", "the escrow input is ambiguous");
  const coin = coins[0]!;
  ensure(Math.floor(Date.now() / 1000) >= terms.timeoutAt, "REFUND_EARLY");
  const refund: RefundPlan = {
    escrow: terms,
    coin: { txid: coin.txid, vout: coin.vout, amount: coin.amount, script: coin.script },
    templateId: "",
    expiresAt: requireCoinExpiry(coin),
  };
  const spend = refundSpend(refund, escrow.instance);
  const action: Action = {
    txid: buildSpend(spend, treasury.conn.operator.checkpointTapscript).txid,
    spend,
    validUntil: refund.expiresAt,
  };
  const journal: RefundJournal = {
    schema: "hive-refund-execution/v4",
    quoteId: quote.quoteId,
    refund,
    action,
    execution: executionState(action, ["self", "delegatee"]),
  };
  writeJson(path, journal);
  return journal;
}

/** Self and pair fallback share the same saved input, action, route order and attempt history. */
export async function executeRefund(
  treasury: Treasury,
  value: SignedQuote,
  options: {
    timeoutMs?: number;
    journalPath?: string;
    observeOnly?: boolean;
    /** An existing pre-execution-journal registration, never a request to choose new inputs. */
    legacyRegistration?: RegisteredRefund;
  } = {},
): Promise<{ txid?: string; attempts: Attempt[] } | null> {
  const quote = requireValidSignedQuote(value);
  const path = pathFor(quote, options.journalPath);
  return withLock(`${path}.lock`, async () => {
    const journal = await loadRefund(treasury, quote, path, options.legacyRegistration);
    if (!journal) return null;
    const outcome = await treasury.conn.router.execute(journal.action, {
      routes: options.observeOnly ? [] : ["self"],
      observeOnly: options.observeOnly ?? false,
      timeoutMs: options.timeoutMs ?? 20_000,
      execution: journal.execution,
      beforeSubmit: async (context) => {
        await lookupSpendCoins(treasury.conn, [journal.refund.coin], 0, context?.signal);
      },
      onState: (state) => {
        journal.execution = state;
        writeJson(path, journal);
      },
    });
    if (outcome.status === "invalid")
      fail("REFUND_INVALID", executionAttempts(journal.execution).at(-1)?.detail ?? "INVALID");
    return {
      ...(outcome.status === "done" ? { txid: journal.action.txid } : {}),
      attempts: outcome.attempts,
    };
  });
}

/** A pair registers the same transaction after half the network's refund margin. */
export const refundFallbackAt = (treasury: Pick<Treasury, "conn">, quote: SignedQuote): number =>
  Number(quote.body.timeoutAt) + REFUND_MARGIN_SECONDS[treasury.conn.deployment.network] / 2;

export async function refundEscrow(
  treasury: Treasury,
  value: SignedQuote,
  options: {
    escrowArtifactId: string;
    pair?: Pair;
    journalPath?: string;
    timeoutMs?: number;
    legacyRegistration?: RegisteredRefund;
  },
): Promise<RegisteredRefund | null> {
  const quote = requireValidSignedQuote(value);
  const path = pathFor(quote, options.journalPath);
  return withLock(`${path}.lock`, async () => {
    const journal = await loadRefund(treasury, quote, path, options.legacyRegistration);
    if (!journal) return null;
    // Reconcile before requesting pair signatures, including a response lost after self execution.
    const before = await treasury.conn.router.execute(journal.action, {
      routes: [],
      timeoutMs: options.timeoutMs ?? 30_000,
      observeOnly: true,
      execution: journal.execution,
      onState: () => {},
    });
    if (before.status === "done") return journal.registration ?? null;
    if (before.status === "elsewhere" || before.status === "invalid")
      return fail("REFUND_PENDING", "the fixed refund is not currently postable");
    if (before.status !== "pending" || before.observation !== "unspent")
      return fail("REFUND_PENDING", "the fixed input is not completely observed unspent");
    if (!journal.registration) {
      await lookupSpendCoins(treasury.conn, [journal.refund.coin]);
      const now = Math.floor(Date.now() / 1000);
      ensure(now >= journal.refund.escrow.timeoutAt, "REFUND_EARLY");
      const templateId = await treasury.conn.delegatee.registerTemplate(
        escrowRefundTemplate(options.escrowArtifactId, journal.refund.escrow),
      );
      const refund: RefundPlan = {
        ...journal.refund,
        templateId,
        expiresAt: Math.min(now + 86_400, journal.refund.expiresAt),
      };
      const pair = options.pair ?? "02";
      const pending = spendRequestFor(
        templateId,
        {},
        [`${refund.coin.txid}:${refund.coin.vout}`],
        refund.expiresAt,
        treasury.terms.pairs[pair],
      );
      const [signature] = await signWithPair(
        treasury.stewards,
        treasury.stewardKeys,
        { id: hex(randomBytes(32)), pair, purpose: { kind: "refund", quote, refund } },
        [pending.message],
      );
      journal.registration = {
        spendId: pending.id,
        escrow: refund.coin.script,
        pair,
        refund,
        request: pending.request(signature!),
      };
      writeJson(path, journal);
    }
    const registration = journal.registration;
    const transport =
      treasury.conn.router.route("delegatee") ??
      delegateeRoute({ url: treasury.conn.deployment.delegateeUrl });
    const router = treasury.conn.router.withRoutes([
      ...(treasury.conn.router.route("self") ? [treasury.conn.router.route("self")!] : []),
      {
        name: "delegatee",
        submit: (action, context) => transport.submit({ ...action, request: registration.request }, context),
      },
    ]);
    const outcome = await router.execute(journal.action, {
      routes: ["delegatee"],
      execution: journal.execution,
      returnAfterPost: true,
      postUntil: registration.request.expiresAt,
      timeoutMs: options.timeoutMs ?? 30_000,
      beforeSubmit: async (context) => {
        await lookupSpendCoins(treasury.conn, [journal.refund.coin], 0, context?.signal);
      },
      onState: (state) => {
        journal.execution = state;
        writeJson(path, journal);
      },
    });
    if (
      outcome.status === "done" ||
      journal.execution.attempts.some(
        (attempt) => attempt.route === "delegatee" && attempt.response?.result === "accepted",
      )
    )
      return registration;
    return fail(
      outcome.status === "invalid" ? "REFUND_INVALID" : "REFUND_PENDING",
      "the fixed refund has no accepted registration or observed output",
    );
  });
}
