import { randomBytes } from "node:crypto";
import {
  type ClaimPlan,
  claimHasRemainder,
  claimSpend,
  claimVariables,
  deriveAccount,
  escrowArguments,
  escrowClaimTemplate,
  lookupSpendCoins,
  type Pair,
  requireCoinExpiry,
  type SpendRequest,
  spendRequestFor,
} from "@hive/ark";
import {
  type Action,
  buildSpend,
  CovenantRefusal,
  type ExecutionState,
  executionState,
  requireRejection,
} from "@hive/executor";
import { ensure, ensureEqual, fail, hex, localPath, readJsonIfPresent, withLock, writeJson } from "@hive/kit";
import {
  escrowTermsFromQuote,
  requireValidReceipt,
  requireValidSignedQuote,
  type SignedQuote,
  type SignedReceipt,
} from "@hive/protocol";
import { signWithPair } from "@hive/steward/client";
import type { Treasury } from "./treasury.js";

/**
 * A provider's claim, as it reaches the hive: the payer's latest receipt and
 * the provider's own signature over the same amount. The hive cannot change
 * either; a pair of stewards only registers the spend the escrow's covenant
 * will check.
 */
export interface ClaimRequest {
  quote: SignedQuote;
  receipt: SignedReceipt;
  /** The provider's BIP340 signature over sha256(CLAIM_TAG ‖ escrow id ‖ amount). */
  claimSignature: string;
  expectedSpend?: { txid: string; outpoint: string };
  /** A caller budget only; this does not alter the claim authorization. */
  postBefore?: number;
}

export interface RegisteredClaim {
  spendId: string;
  escrow: string;
  amount: number;
  pair: Pair;
  /** What the pair signed: the claim and its spend request, for the record. */
  claim: ClaimPlan;
  request: SpendRequest;
}

interface ClaimRegistrationJournal {
  schema: "hive-claim-registration/v4";
  quoteId: string;
  submission: Omit<ClaimRequest, "postBefore">;
  record: RegisteredClaim;
  action: Action;
  execution: ExecutionState;
}

/** The fixed request is saved before registration, including after a response is lost. */
export async function registerClaim(
  treasury: Treasury,
  request: ClaimRequest,
  options: {
    pair?: Pair;
    escrowArtifactId: string;
    lifetimeSeconds?: number;
    journalPath?: string;
    timeoutMs?: number;
  },
): Promise<RegisteredClaim> {
  const quote = requireValidSignedQuote(request.quote);
  const path = options.journalPath ?? localPath("v4", "claim-registrations", `${quote.quoteId}.json`);
  return withLock(`${path}.lock`, async () => {
    const { postBefore, ...submission } = request;
    if (postBefore !== undefined)
      ensure(Number.isSafeInteger(postBefore) && postBefore > 0, "CLAIM_DEADLINE");
    let journal = readJsonIfPresent<ClaimRegistrationJournal>(path);
    if (journal) {
      ensure(
        journal.schema === "hive-claim-registration/v4" && journal.quoteId === quote.quoteId,
        "JOURNAL_MISMATCH",
      );
      ensureEqual(journal.submission, submission, "JOURNAL_MISMATCH", "claim");
    } else {
      const escrowTerms = escrowTermsFromQuote(quote);
      const receipt = requireValidReceipt(request.receipt, {
        escrowId: quote.quoteId,
        payerReceiptKey: quote.body.payerReceiptKey,
        capSats: quote.body.capSats,
      });
      const escrow = deriveAccount(treasury.conn, "escrow", escrowArguments(escrowTerms));
      const selected = (
        await treasury.conn.arkd.coins(
          request.expectedSpend
            ? { outpoints: [request.expectedSpend.outpoint] }
            : { scripts: [escrow.pkScript], spendableOnly: true },
        )
      ).filter(
        (coin) =>
          coin.script === escrow.pkScript &&
          !coin.isSpent &&
          !coin.isSwept &&
          coin.amount === Number(quote.body.capSats),
      );
      ensure(selected.length === 1, "ESCROW_NOT_FUNDED");
      const coin = selected[0]!;
      requireCoinExpiry(coin);
      const amount = Number(receipt.amountSats);
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = Math.min(escrowTerms.timeoutAt, now + (options.lifetimeSeconds ?? 3600));
      ensure(expiresAt > now + 30, "ESCROW_DEADLINE_TOO_NEAR");
      const templateId = await treasury.conn.delegatee.registerTemplate(
        escrowClaimTemplate(options.escrowArtifactId, claimHasRemainder({ coin, amount })),
      );
      const claim: ClaimPlan = {
        escrow: escrowTerms,
        coin: { txid: coin.txid, vout: coin.vout, amount: coin.amount, script: coin.script },
        amount,
        receiptSig: receipt.signature,
        claimSig: request.claimSignature,
        templateId,
        expiresAt,
      };
      const spend = claimSpend(claim, escrow.instance);
      const txid = buildSpend(spend, treasury.conn.operator.checkpointTapscript).txid;
      if (request.expectedSpend)
        ensure(
          request.expectedSpend.txid === txid &&
            request.expectedSpend.outpoint === `${coin.txid}:${coin.vout}`,
          "CLAIM_ACTION_MISMATCH",
        );
      const pair = options.pair ?? "01";
      const pending = spendRequestFor(
        templateId,
        claimVariables(claim),
        [`${coin.txid}:${coin.vout}`],
        expiresAt,
        treasury.terms.pairs[pair],
      );
      const [signature] = await signWithPair(
        treasury.stewards,
        treasury.stewardKeys,
        { id: hex(randomBytes(32)), pair, purpose: { kind: "claim", quote, claim } },
        [pending.message],
      );
      const signed = pending.request(signature!);
      const action: Action = { txid, spend, request: signed, validUntil: escrowTerms.timeoutAt };
      journal = {
        schema: "hive-claim-registration/v4",
        quoteId: quote.quoteId,
        submission,
        record: { spendId: pending.id, escrow: escrow.pkScript, amount, pair, claim, request: signed },
        action,
        execution: executionState(action, ["delegatee"]),
      };
      writeJson(path, journal);
    }
    const fixed = journal;
    const outcome = await treasury.conn.router.execute(fixed.action, {
      routes: ["delegatee"],
      execution: fixed.execution,
      returnAfterPost: true,
      timeoutMs: Math.max(
        0,
        Math.min(options.timeoutMs ?? 30_000, postBefore === undefined ? Infinity : postBefore - Date.now()),
      ),
      beforeSubmit: async (context) => {
        await lookupSpendCoins(treasury.conn, [fixed.record.claim.coin], 0, context?.signal);
      },
      onState: (state) => {
        fixed.execution = state;
        writeJson(path, fixed);
      },
    });
    if (outcome.status === "done") return fixed.record;
    const refusal = fixed.execution.attempts.find(
      (attempt) => attempt.response?.result === "refused",
    )?.response;
    if (refusal?.result === "refused") {
      requireRejection(refusal.proof, fixed.action, "delegatee");
      throw new CovenantRefusal(refusal.proof);
    }
    if (fixed.execution.attempts.some((attempt) => attempt.response?.result === "accepted"))
      return fixed.record;
    if (outcome.status === "invalid")
      fail("CLAIM_INVALID", fixed.execution.attempts.at(-1)?.response?.result ?? "INVALID");
    return fail("CLAIM_PENDING", "the fixed registration has no accepted response or observed payment");
  });
}
