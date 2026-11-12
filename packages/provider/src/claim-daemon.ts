import { resolve } from "node:path";
import {
  type ClaimPlan,
  type Connection,
  claimSpend,
  deriveAccount,
  type EscrowTerms,
  escrowArguments,
  lookupSpendCoins,
  refundSpend,
  xOnly,
} from "@hive/ark";
import {
  type Action,
  type Attempt,
  buildSpend,
  observeSpend,
  type ExecutionState,
  executionState,
  executionAttempts,
  type Route,
  type RouteContext,
  routeContext,
  routeFailure,
  HttpError,
  CovenantRefusal,
  type CovenantRejection,
  requireRejection,
} from "@hive/executor";
import {
  ensure,
  exactObject,
  fail,
  hex,
  isFault,
  isLoopbackHost,
  readBoundedResponse,
  readJsonIfPresent,
  runInWindow,
  type WindowHandle,
  withLock,
  writeJson,
  writeOnce,
} from "@hive/kit";
import {
  escrowTermsFromQuote,
  quoteCostSats,
  requireValidReceipt,
  requireValidSignedQuote,
  type SignedQuote,
  type SignedReceipt,
} from "@hive/protocol";
import type { ClaimSigner } from "./claim.js";

/**
 * The provider's claim: freeze the sidecar, take the payer's latest receipt
 * and sign the claim for its amount with the workload key. The provider then
 * executes the claim itself: the Emulator checks the receipt and the claim
 * signature and, with the Arkade Operator, finalizes the payment. When it
 * cannot, it hands both signatures to the hive's claim desk, where a steward
 * pair registers the same spend with the delegatee. Completion requires the
 * fixed transaction's input relationships and expected payment outputs.
 * A correlated covenant refusal keeps the claim on its current route.
 * The hive can delay a desk claim but cannot change it. Its accounting also
 * needs the public claim proof in its own journals; a matching payout alone
 * does not identify the claim. The refund becomes available at the deadline.
 */
export interface ClaimDesk {
  submit(
    claim: {
      quote: SignedQuote;
      receipt: SignedReceipt;
      claimSignature: string;
      expectedSpend?: { txid: string; outpoint: string };
      postBefore?: number;
    },
    context?: RouteContext,
  ): Promise<{
    spendId: string;
  }>;
}

/** The hive's claim desk over HTTP: `http:` only on a loopback host. */
export function httpClaimDesk(deskUrl: string): ClaimDesk {
  const url = new URL(deskUrl);
  ensure(
    (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) &&
      !url.username &&
      !url.search,
    "CLAIM_DESK_URL",
  );
  return {
    async submit(claim, context) {
      const bodyText = JSON.stringify(claim);
      await context?.beforePost();
      context?.recheckPostable();
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
        redirect: "error",
        signal: context?.signal ?? AbortSignal.timeout(60_000),
      });
      const body = JSON.parse((await readBoundedResponse(response, 65_536)).toString("utf8")) as {
        spendId?: unknown;
        error?: unknown;
        rejection?: CovenantRejection;
      };
      if (!response.ok && body.error === "COVENANT_REFUSAL") {
        ensure(claim.expectedSpend && body.rejection, "COVENANT_PROOF");
        const action: Action = {
          txid: claim.expectedSpend.txid,
          validUntil: 0,
          request: {
            templateId: "",
            variables: {},
            outpoints: [claim.expectedSpend.outpoint],
            expiresAt: 0,
            pubkey: "",
            signature: "",
          },
        };
        requireRejection(body.rejection, action, "delegatee");
        throw new CovenantRefusal(body.rejection);
      }
      if (!response.ok) throw new HttpError(response.status, "");
      ensure(typeof body.spendId === "string" && /^[0-9a-f]{64}$/.test(body.spendId), "CLAIM_DESK_RESPONSE");
      return { spendId: body.spendId };
    },
  };
}

export interface ClaimOptions {
  stateDirectory: string;
  sidecarUrl: string;
  bearerToken: string;
  signer: ClaimSigner;
  desk: ClaimDesk;
  pollMs?: number;
  /** How long one attempt waits for the payment after handing the claim in. */
  waitMs?: number;
  /** How long executing the claim ourselves may take before the desk gets it. */
  selfMs?: number;
}

interface CloseDecision {
  schema: "hive-close-decision/v4";
  escrowId: string;
  receipt: SignedReceipt | null;
  cumulativeInputTokens: string;
  cumulativeOutputTokens: string;
}

/** What the provider signed and handed in, and what it saw happen to the escrow. */
export interface ClaimJournal {
  schema: "hive-provider-claim/v4";
  escrowId: string;
  escrowScript: string;
  payoutScript: string;
  amountSats: number;
  claimSignature: string;
  /** Each try: executing it ourselves (`route: "self"`) or handing it to the desk. */
  submissions: { at: string; route?: "self" | "desk"; result?: string; spendId?: string; code?: string }[];
  status: "signed" | "paid" | "refunded";
  txid?: string;
  paidSats?: number;
  /** Fixed claim and refund identities, retained even when output visibility is incomplete. */
  claimAction?: Action;
  refundAction?: Action;
  execution?: ExecutionState;
}

export type ClaimOutcome =
  | { kind: "paid"; txid: string; amountSats: number }
  | { kind: "refunded"; txid: string }
  | { kind: "no-receipt" };

export async function claimEscrow(
  conn: Connection,
  value: SignedQuote,
  options: ClaimOptions,
): Promise<ClaimOutcome> {
  return withLock(resolve(options.stateDirectory, "claim.lock"), async () => {
    const quote = requireValidSignedQuote(value);
    ensure(
      quote.body.network === conn.deployment.network &&
        quote.body.operatorKey === hex(xOnly(conn.keys.server)) &&
        quote.body.emulatorKey === hex(xOnly(conn.keys.emulator)),
      "DEPLOYMENT_MISMATCH",
    );
    const receiptContext = {
      escrowId: quote.quoteId,
      payerReceiptKey: quote.body.payerReceiptKey,
      capSats: quote.body.capSats,
    };
    const decision = await closeDecision(quote, options);
    if (!decision.receipt) return { kind: "no-receipt" };
    const receipt = requireValidReceipt(decision.receipt, receiptContext);
    const escrow = deriveAccount(conn, "escrow", escrowArguments(escrowTermsFromQuote(quote) as EscrowTerms));
    const journalPath = resolve(options.stateDirectory, "claim.json");
    let journal = readJsonIfPresent<ClaimJournal>(journalPath);
    const legacy = Boolean(journal);
    if (!journal) {
      const signed = await options.signer.signClaim({ kind: "sign-escrow-claim", quote, receipt });
      ensure(
        signed.escrowId === quote.quoteId && signed.amountSats === receipt.amountSats,
        "CLAIM_SIGNATURE",
      );
      journal = {
        schema: "hive-provider-claim/v4",
        escrowId: quote.quoteId,
        escrowScript: escrow.pkScript,
        payoutScript: quote.body.providerPayoutScript,
        amountSats: Number(receipt.amountSats),
        claimSignature: signed.claimSignature,
        submissions: [],
        status: "signed",
      };
      writeJson(journalPath, journal);
    }
    ensure(
      journal.schema === "hive-provider-claim/v4" &&
        journal.escrowId === quote.quoteId &&
        journal.escrowScript === escrow.pkScript &&
        journal.payoutScript === quote.body.providerPayoutScript &&
        journal.amountSats === Number(receipt.amountSats),
      "JOURNAL_MISMATCH",
    );
    const save = () => writeJson(journalPath, journal);
    const terms = escrowTermsFromQuote(quote) as EscrowTerms;
    if (!journal.claimAction || !journal.refundAction) {
      // Old journals may describe an already spent coin; absence or multiple cap coins proves nothing.
      const coins = (await conn.arkd.coins({ scripts: [escrow.pkScript] })).filter(
        (coin) => coin.script === escrow.pkScript && coin.amount === Number(quote.body.capSats),
      );
      ensure(coins.length === 1, "CLAIM_PENDING", "the original escrow coin is not unambiguous");
      const coin = coins[0]!;
      const source = { txid: coin.txid, vout: coin.vout, amount: coin.amount, script: coin.script };
      const plan: ClaimPlan = {
        escrow: terms,
        coin: source,
        amount: journal.amountSats,
        receiptSig: receipt.signature,
        claimSig: journal.claimSignature,
        templateId: "",
        expiresAt: terms.timeoutAt,
      };
      const claim = claimSpend(plan, escrow.instance);
      // Refund expiry is not encoded in its covenant. This Action is only observed,
      // so rebuilding history does not require batch metadata or authorize a post.
      const refund = refundSpend(
        { escrow: terms, coin: source, templateId: "", expiresAt: terms.timeoutAt },
        escrow.instance,
      );
      const action = (spend: Action["spend"], validUntil: number): Action => ({
        txid: buildSpend(spend!, conn.operator.checkpointTapscript).txid,
        spend,
        validUntil,
      });
      journal.claimAction = action(claim, terms.timeoutAt);
      journal.refundAction = action(refund, terms.timeoutAt);
      if (!legacy) journal.execution = executionState(journal.claimAction, ["self", "desk"]);
      save();
    }
    const observe = observeSpend({
      coins: (query) => conn.arkd.coins(query),
      checkpointTapscript: conn.operator.checkpointTapscript,
    });
    const settled = async (): Promise<ClaimOutcome | undefined> => {
      const closed = await observeClose(observe, journal);
      if (!closed) return undefined;
      journal.status = closed.kind;
      journal.txid = closed.txid;
      if (closed.kind === "paid") journal.paidSats = closed.amountSats;
      else delete journal.paidSats;
      save();
      return closed;
    };
    const before = await settled();
    if (before) return before;
    // An older terminal label may have been inferred from missing outputs.
    journal.status = "signed";
    delete journal.txid;
    delete journal.paidSats;
    save();
    ensure(
      (await observe(journal.claimAction)) === "unspent",
      "CLAIM_PENDING",
      "the escrow close is not yet completely observed",
    );
    const requirePostableCoin = (signal?: AbortSignal) =>
      lookupSpendCoins(
        conn,
        journal.claimAction!.spend!.inputs.map(({ txid, vout, amount }) => ({
          txid,
          vout,
          amount,
          script: escrow.pkScript,
        })),
        0,
        signal,
      );
    await requirePostableCoin();
    const desk: Route = {
      name: "desk",
      async submit(current, suppliedContext) {
        const context = suppliedContext ?? routeContext(current);
        try {
          const input = current.spend!.inputs[0]!;
          context.recheckPostable();
          const posted = await options.desk.submit(
            {
              quote,
              receipt,
              claimSignature: journal.claimSignature,
              expectedSpend: { txid: current.txid, outpoint: `${input.txid}:${input.vout}` },
              postBefore: context.deadline,
            },
            context,
          );
          ensure(/^[0-9a-f]{64}$/.test(posted.spendId), "CLAIM_DESK_RESPONSE");
          return { result: "accepted", reference: posted.spendId };
        } catch (error) {
          if (error instanceof CovenantRefusal) {
            requireRejection(error.rejection, current, "delegatee");
            return {
              result: "refused",
              detail: "COVENANT_REFUSAL",
              proof: { ...error.rejection, route: "desk" },
            };
          }
          if (isFault(error) || error instanceof HttpError || error instanceof TypeError)
            return routeFailure(error);
          return { result: "unavailable", detail: "CLAIM_DESK_UNAVAILABLE" };
        }
      },
    };
    const self = conn.router.route("self");
    const router = conn.router.withRoutes([...(self ? [self] : []), desk], {
      patienceMs: options.selfMs ?? 30_000,
      ...(options.pollMs ? { pollMs: options.pollMs } : {}),
    });
    if (!journal.execution) {
      const attempts: Attempt[] = journal.submissions.map((entry) => ({
        route: entry.route ?? "desk",
        at: Date.parse(entry.at),
        result:
          entry.result === "refused"
            ? "refused"
            : entry.result === "unavailable" || entry.code
              ? "unavailable"
              : "accepted",
        ...(entry.code ? { detail: "LEGACY_RECORDED_ERROR" } : {}),
        ...(entry.spendId ? { reference: entry.spendId } : {}),
      }));
      journal.execution = executionState(journal.claimAction, ["self", "desk"], attempts, legacy);
      save();
    }
    const outcome = await router.execute(journal.claimAction, {
      routes: [...(self ? ["self" as const] : []), "desk"],
      execution: journal.execution,
      timeoutMs: (options.selfMs ?? 30_000) + (options.waitMs ?? 60_000),
      routeBudgetMs: { self: options.selfMs ?? 30_000 },
      beforeSubmit: async (context) => {
        await requirePostableCoin(context?.signal);
      },
      onState: (state) => {
        journal.execution = state;
        journal.submissions = executionAttempts(state).map((attempt) => ({
          at: new Date(attempt.at).toISOString(),
          route: attempt.route as "self" | "desk",
          result: attempt.result,
          ...(attempt.detail ? { code: attempt.detail } : {}),
          ...(attempt.route === "desk" && attempt.reference ? { spendId: attempt.reference } : {}),
        }));
        save();
      },
    });
    const after = await settled();
    if (after) return after;
    if (outcome.status === "invalid") return fail(journal.submissions.at(-1)?.code ?? "CLAIM_INVALID");
    return fail("CLAIM_PENDING", "the fixed claim has no completely observed payout or refund");
  });
}

/**
 * The decision is the receipt the sidecar holds once frozen, saved before
 * anything is signed, so every retry claims the same amount.
 */
async function closeDecision(quote: SignedQuote, options: ClaimOptions): Promise<CloseDecision> {
  const path = resolve(options.stateDirectory, "close-decision.json");
  const receiptContext = {
    escrowId: quote.quoteId,
    payerReceiptKey: quote.body.payerReceiptKey,
    capSats: quote.body.capSats,
  };
  let decision = readJsonIfPresent<CloseDecision>(path);
  if (!decision) {
    const totals = await freezeSidecar(options.sidecarUrl, options.bearerToken);
    const owed = quoteCostSats(quote.body, totals.cumulativeInputTokens, totals.cumulativeOutputTokens);
    let receipt: SignedReceipt | null = null;
    if (owed > 0n) {
      receipt = requireValidReceipt(totals.latestReceipt, receiptContext);
      ensure(receipt.amountSats === owed.toString(), "RECEIPT_TOTALS_MISMATCH");
    } else ensure(totals.latestReceipt === null, "RECEIPT_TOTALS_MISMATCH");
    decision = writeOnce(path, {
      schema: "hive-close-decision/v4",
      escrowId: quote.quoteId,
      receipt,
      cumulativeInputTokens: totals.cumulativeInputTokens,
      cumulativeOutputTokens: totals.cumulativeOutputTokens,
    } satisfies CloseDecision);
  }
  ensure(
    decision.schema === "hive-close-decision/v4" && decision.escrowId === quote.quoteId,
    "JOURNAL_MISMATCH",
  );
  if (decision.receipt)
    ensure(
      requireValidReceipt(decision.receipt, receiptContext).amountSats ===
        quoteCostSats(quote.body, decision.cumulativeInputTokens, decision.cumulativeOutputTokens).toString(),
      "RECEIPT_TOTALS_MISMATCH",
    );
  return decision;
}

/**
 * How the escrow closed, if it did: the transaction that spent its coin paid
 * the provider's script (a claim) or only the treasury (the refund).
 */
async function observeClose(
  observe: ReturnType<typeof observeSpend>,
  journal: ClaimJournal,
): Promise<Exclude<ClaimOutcome, { kind: "no-receipt" }> | undefined> {
  if (journal.claimAction && (await observe(journal.claimAction)) === "spent") {
    const amountSats = journal.claimAction
      .spend!.outputs.filter((output) => output.script === journal.payoutScript)
      .reduce((total, output) => total + output.amount, 0);
    return { kind: "paid", txid: journal.claimAction.txid, amountSats };
  }
  if (journal.refundAction && (await observe(journal.refundAction)) === "spent")
    return { kind: "refunded", txid: journal.refundAction.txid };
  return undefined;
}

export interface ClaimSchedule {
  /** Start claiming this many seconds before the deadline. */
  leadSeconds?: number;
  /** Stop starting new attempts this many seconds before the deadline. */
  marginSeconds?: number;
  pollMs?: number;
  onRetry?(error: unknown, delayMs: number): void;
}

/** The provider's claim loop: from the lead time until the margin, with backoff. */
export function scheduleClaim(
  conn: Connection,
  quote: SignedQuote,
  options: ClaimOptions,
  schedule: ClaimSchedule = {},
): WindowHandle<ClaimOutcome> {
  const lead = schedule.leadSeconds ?? 600;
  const margin = schedule.marginSeconds ?? 90;
  ensure(
    Number.isSafeInteger(lead) && Number.isSafeInteger(margin) && margin >= 60 && margin < lead,
    "INVALID_SCHEDULE",
  );
  const deadline = BigInt(quote.body.timeoutAt);
  return runInWindow({
    opensAt: deadline - BigInt(lead),
    closesAt: deadline - BigInt(margin),
    attempt: () => claimEscrow(conn, quote, options),
    isFinal: (error) =>
      isFault(error, "CLAIM_ALREADY_SIGNED") ||
      isFault(error, "DEPLOYMENT_MISMATCH") ||
      isFault(error, "JOURNAL_MISMATCH"),
    ...(schedule.onRetry ? { onRetry: schedule.onRetry } : {}),
    ...(schedule.pollMs ? { pollMs: schedule.pollMs, initialBackoffMs: schedule.pollMs } : {}),
  });
}

async function freezeSidecar(
  sidecarUrl: string,
  bearerToken: string,
): Promise<{ latestReceipt: unknown; cumulativeInputTokens: string; cumulativeOutputTokens: string }> {
  const url = new URL(sidecarUrl);
  ensure(
    url.protocol === "http:" &&
      isLoopbackHost(url.hostname) &&
      url.pathname === "/" &&
      !url.username &&
      !url.search,
    "LOCAL_SIDECAR_REQUIRED",
  );
  const response = await fetch(new URL("/freeze", url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  ensure(response.ok, "SIDECAR_NOT_FROZEN");
  const totals = JSON.parse((await readBoundedResponse(response, 65_536)).toString("utf8")) as Record<
    string,
    unknown
  >;
  exactObject(
    totals,
    ["frozen", "latestReceipt", "cumulativeInputTokens", "cumulativeOutputTokens", "sequence"],
    "sidecar totals",
  );
  ensure(totals.frozen === true, "SIDECAR_NOT_FROZEN");
  return totals as { latestReceipt: unknown; cumulativeInputTokens: string; cumulativeOutputTokens: string };
}
