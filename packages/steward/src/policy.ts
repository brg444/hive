import {
  ARTIFACTS,
  AUTHORIZATION_GRACE_SECONDS,
  type ClaimPlan,
  type Connection,
  checkClaim,
  claimVariables,
  deriveAccount,
  type EscrowTerms,
  escrowArguments,
  escrowRefundTemplate,
  type RefundPlan,
  networkCeilings,
  lookupSpendCoins,
  REFUND_MARGIN_SECONDS,
  type SendPlan,
  sendMessages,
  sendTerms,
  signedSend,
  spendRequestFor,
  treasuryArguments,
  treasuryPlanVariables,
  verifyWatch,
  xOnly,
} from "@hive/ark";
import { ensure, guard, hex, requireNotHalted, sha256Hex, unhex } from "@hive/kit";
import {
  canonicalJson,
  escrowTermsFromQuote,
  quoteTerms,
  requireValidSignedQuote,
  type SignedQuote,
  validateQuoteForFunding,
} from "@hive/protocol";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { Steward } from "./config.js";
import { MAX_VALIDITY_SECONDS, type Purpose, type SessionRequest, sameWithdrawal } from "./purpose.js";

export { MAX_VALIDITY_SECONDS };

export interface Checked {
  messages: Uint8Array[];
  /** What holds the reservations: the plan, so its attest and register sessions share them. */
  holder: string;
  /** Coins this session would spend, reserved until `until`. */
  coins: string[];
  until: number;
  /** A purchase's quote, reserved like its coins so it is funded once. */
  quoteId?: string;
  /**
   * A permanent binding: an approved request funds one quote, and an approved
   * withdrawal one plan. A session that would bind the key to another value is
   * refused with `code`.
   */
  binds?: { key: string; value: string; code: string };
}

const outpoint = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`;
/** Equality of plain JSON values, key order aside. */
function sameJson(a: unknown, b: unknown): boolean {
  const sorted = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([x], [y]) => (x < y ? -1 : 1))
            .map(([k, w]) => [k, sorted(w)]),
        )
      : Array.isArray(v)
        ? v.map(sorted)
        : v;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}
const planHolder = (plan: SendPlan) =>
  sha256Hex(
    [
      plan.templateId,
      plan.destination,
      plan.amount,
      plan.change,
      plan.validUntil,
      ...plan.coins.map(outpoint),
    ].join("|"),
  );

/** Check a session's purpose and return the messages this steward may sign for it. */
export async function checkPurpose(
  steward: Steward,
  conn: Connection,
  session: SessionRequest,
  now: number,
): Promise<Checked> {
  ensure(session.pair.includes(String(steward.index)), "NOT_IN_PAIR");
  ensure(/^[0-9a-f]{64}$/.test(session.id), "INVALID", "session id");
  const purpose = session.purpose;
  switch (purpose.kind) {
    case "allocation":
      requireNotHalted(steward.config.hive);
      return checkAllocation(steward, conn, session, purpose, now);
    case "withdrawal":
      return checkWithdrawal(steward, conn, session, purpose, now);
    case "claim":
      return checkClaimRegistration(steward, conn, session, purpose.quote, purpose.claim, now);
    case "refund":
      return checkRefund(steward, conn, session, purpose.quote, purpose.refund, now);
    default:
      ensure(false, "UNKNOWN_PURPOSE");
  }
}

function treasuryOf(steward: Steward, conn: Connection) {
  return deriveAccount(conn, "treasury", treasuryArguments(steward.treasuryTerms));
}

/** The common rules of a treasury send: our coins, unspent, exactly balanced, briefly valid. */
async function checkSend(
  steward: Steward,
  conn: Connection,
  session: SessionRequest,
  plan: SendPlan,
  now: number,
): Promise<{ attest: Uint8Array[]; coins: string[] }> {
  const treasury = treasuryOf(steward, conn);
  ensure(plan.account === "treasury" && plan.pair === session.pair, "PLAN_INVALID", "account or pair");
  ensure(plan.coins.length >= 1 && plan.coins.length <= 16, "PLAN_INVALID", "coin count");
  const coins = plan.coins.map(outpoint);
  ensure(new Set(coins).size === coins.length, "PLAN_INVALID", "repeated coin");
  const dust = conn.operator.dust;
  ensure(Number.isSafeInteger(plan.amount) && plan.amount >= dust, "PLAN_INVALID", "amount");
  ensure(
    plan.change === 0 || (Number.isSafeInteger(plan.change) && plan.change >= dust),
    "PLAN_INVALID",
    "change",
  );
  ensure(
    plan.validUntil > now + 60 && plan.validUntil <= now + MAX_VALIDITY_SECONDS,
    "PLAN_INVALID",
    "validity",
  );
  ensure(/^[0-9a-f]{64}$/.test(plan.templateId), "PLAN_INVALID", "template id");
  ensure(
    canonicalJson(plan.variables) ===
      canonicalJson(treasuryPlanVariables(steward.treasuryTerms, sendTerms(plan))),
    "PLAN_INVALID",
    "variables",
  );
  // The steward reads the coins itself: each must be the treasury's, unspent, of the stated value.
  ensure(
    plan.coins.every((coin) => coin.script === treasury.pkScript),
    "COIN_UNKNOWN",
  );
  await lookupSpendCoins(
    conn,
    plan.coins,
    now + steward.treasuryTerms.renewalWindowSeconds + AUTHORIZATION_GRACE_SECONDS + 1,
  );
  return { attest: sendMessages(plan, treasury.instance, conn.operator.checkpointTapscript), coins };
}

/** The registration message, once every attestation verifies under the pair's key. */
function registration(
  steward: Steward,
  session: SessionRequest,
  plan: SendPlan,
  attest: Uint8Array[],
  signatures: string[],
) {
  const pairKey = steward.pairs[session.pair];
  ensure(signatures.length === attest.length, "PLAN_INVALID", "signature count");
  signatures.forEach((sig, i) => {
    ensure(
      /^[0-9a-f]{128}$/.test(sig) && schnorr.verify(unhex(sig), attest[i]!, unhex(pairKey)),
      "ATTESTATION_INVALID",
      `coin ${i}`,
    );
  });
  const { variables, outpoints } = signedSend(plan, signatures);
  return spendRequestFor(plan.templateId, variables, outpoints, plan.validUntil, pairKey).message;
}

function escrowFrom(
  steward: Steward,
  conn: Connection,
  quote: SignedQuote,
): { terms: EscrowTerms; account: ReturnType<typeof deriveAccount> } {
  const body = quote.body;
  const treasury = treasuryOf(steward, conn);
  ensure(
    body.network === conn.deployment.network &&
      body.operatorKey === hex(xOnly(conn.keys.server)) &&
      body.emulatorKey === hex(xOnly(conn.keys.emulator)) &&
      body.treasuryScript === treasury.pkScript &&
      body.exitDelaySeconds === String(steward.treasuryTerms.exitDelaySeconds) &&
      canonicalJson(body.stewardPairKeys) ===
        canonicalJson([steward.pairs["01"], steward.pairs["02"], steward.pairs["12"]]),
    "DEPLOYMENT_MISMATCH",
  );
  const terms = escrowTermsFromQuote(quote) as EscrowTerms;
  return { terms, account: deriveAccount(conn, "escrow", escrowArguments(terms)) };
}

async function checkAllocation(
  steward: Steward,
  conn: Connection,
  session: SessionRequest,
  purpose: Extract<Purpose, { kind: "allocation" }>,
  now: number,
): Promise<Checked> {
  const signed = guard("INVALID_QUOTE", () => requireValidSignedQuote(purpose.quote));
  const approved = steward.config.approvedRequests.find((t) => t.requestId === signed.body.requestId);
  ensure(approved, "UNAPPROVED_REQUEST");
  const quote = guard("UNAPPROVED_QUOTE", () =>
    validateQuoteForFunding(signed, { ...approved, nowSeconds: String(now) }),
  );
  ensure(canonicalJson(quoteTerms(quote.body)) === canonicalJson(approved), "UNAPPROVED_QUOTE");
  const ceilings = networkCeilings(conn.deployment.network);
  ensure(!ceilings || Number(quote.body.capSats) <= ceilings.escrowSats, "ABOVE_CEILING");
  const { terms, account } = escrowFrom(steward, conn, quote);
  const plan = purpose.plan;
  ensure(
    plan.destination === account.pkScript && plan.amount === Number(quote.body.capSats),
    "PLAN_INVALID",
    "escrow or cap",
  );
  ensure(
    plan.validUntil <= Number(quote.body.quoteExpiresAt),
    "PLAN_INVALID",
    "the authorization outlives the quote",
  );
  const { attest, coins } = await checkSend(steward, conn, session, plan, now);
  // The coins' batch expiry bounds the escrow's: the refund must run before it.
  const indexed = await lookupSpendCoins(conn, plan.coins);
  for (const coin of indexed)
    ensure(
      coin.expiresAt >= terms.timeoutAt + REFUND_MARGIN_SECONDS[conn.deployment.network],
      "COIN_EXPIRES_TOO_SOON",
      `${coin.txid}:${coin.vout}`,
    );
  // An escrow is funded once, and only with its deadline refund already watched.
  const funded = await conn.arkd.coins({ scripts: [account.pkScript] });
  ensure(funded.length === 0, "ESCROW_FUNDED");
  // The watch the delegatee reports is the newest; a pair refunds the escrow itself should another act.
  const watch = await conn.delegatee.address(account.address).catch(() => undefined);
  ensure(watch, "REFUND_NOT_WATCHED", "the delegatee has no watch on the escrow");
  const templateId = await conn.delegatee.registerTemplate(
    escrowRefundTemplate(await conn.delegatee.registerArtifact(ARTIFACTS.escrow), terms),
  );
  guard("REFUND_NOT_WATCHED", () =>
    verifyWatch(account.instance, watch.delegation, account.address, { templateId }),
  );
  const messages =
    purpose.stage === "attest" ? attest : [registration(steward, session, plan, attest, purpose.signatures)];
  return {
    messages,
    holder: planHolder(plan),
    coins,
    until: plan.validUntil,
    quoteId: quote.quoteId,
    // A provider can sign many quotes for one request; the stewards fund one of them.
    binds: { key: `request:${quote.body.requestId}`, value: quote.quoteId, code: "REQUEST_ALREADY_QUOTED" },
  };
}

async function checkWithdrawal(
  steward: Steward,
  conn: Connection,
  session: SessionRequest,
  purpose: Extract<Purpose, { kind: "withdrawal" }>,
  now: number,
): Promise<Checked> {
  const approved = steward.config.approvedWithdrawals.find((w) => w.label === purpose.withdrawal.label);
  ensure(approved && sameWithdrawal(approved, purpose.withdrawal), "UNAPPROVED_WITHDRAWAL");
  ensure(now < approved.expiresAt, "WITHDRAWAL_EXPIRED");
  const plan = purpose.plan;
  ensure(
    plan.destination === approved.destination && plan.amount === approved.amountSats,
    "PLAN_INVALID",
    "destination or amount",
  );
  ensure(plan.validUntil <= approved.expiresAt, "PLAN_INVALID", "the authorization outlives the approval");
  const { attest, coins } = await checkSend(steward, conn, session, plan, now);
  const messages =
    purpose.stage === "attest" ? attest : [registration(steward, session, plan, attest, purpose.signatures)];
  const holder = planHolder(plan);
  // An approval pays once: a second plan for it needs a new approval, whatever became of the first.
  return {
    messages,
    holder,
    coins,
    until: plan.validUntil,
    binds: { key: `withdrawal:${approved.label}`, value: holder, code: "WITHDRAWAL_USED" },
  };
}

async function checkClaimRegistration(
  steward: Steward,
  conn: Connection,
  session: SessionRequest,
  quoteValue: SignedQuote,
  claim: ClaimPlan,
  now: number,
): Promise<Checked> {
  const quote = guard("INVALID_QUOTE", () => requireValidSignedQuote(quoteValue));
  const { terms, account } = escrowFrom(steward, conn, quote);
  ensure(sameJson(claim.escrow, terms), "CLAIM_INVALID", "escrow terms");
  ensure(claim.amount <= Number(quote.body.capSats), "CLAIM_INVALID", "above the cap");
  ensure(claim.expiresAt > now && claim.expiresAt <= now + 86_400, "CLAIM_INVALID", "spend lifetime");
  ensure(/^[0-9a-f]{64}$/.test(claim.templateId), "CLAIM_INVALID", "template id");
  checkClaim(claim);
  await escrowCoin(conn, account.pkScript, claim.coin, Number(quote.body.capSats));
  const request = spendRequestFor(
    claim.templateId,
    claimVariables(claim),
    [outpoint(claim.coin)],
    claim.expiresAt,
    steward.pairs[session.pair],
  );
  return { messages: [request.message], holder: session.id, coins: [], until: claim.expiresAt };
}

/** The escrow's own coin: at its script, of exactly the cap it was funded with, unspent. */
async function escrowCoin(
  conn: Connection,
  script: string,
  coin: { txid: string; vout: number; amount: number; script: string },
  capSats: number,
): Promise<void> {
  ensure(coin.script === script && coin.amount === capSats, "COIN_UNKNOWN");
  await lookupSpendCoins(conn, [coin]);
}

/**
 * A pair registers an escrow's refund itself once the deadline has passed, in
 * case the delegatee's refund watch is not the one acting on the escrow. The
 * covenant pays the whole coin to the treasury, so nothing else can follow.
 */
async function checkRefund(
  steward: Steward,
  conn: Connection,
  session: SessionRequest,
  quoteValue: SignedQuote,
  refund: RefundPlan,
  now: number,
): Promise<Checked> {
  const quote = guard("INVALID_QUOTE", () => requireValidSignedQuote(quoteValue));
  const { terms, account } = escrowFrom(steward, conn, quote);
  ensure(sameJson(refund.escrow, terms), "REFUND_INVALID", "escrow terms");
  ensure(now >= terms.timeoutAt, "REFUND_EARLY");
  ensure(refund.expiresAt > now && refund.expiresAt <= now + 86_400, "REFUND_INVALID", "spend lifetime");
  ensure(/^[0-9a-f]{64}$/.test(refund.templateId), "REFUND_INVALID", "template id");
  await escrowCoin(conn, account.pkScript, refund.coin, Number(quote.body.capSats));
  const request = spendRequestFor(
    refund.templateId,
    {},
    [outpoint(refund.coin)],
    refund.expiresAt,
    steward.pairs[session.pair],
  );
  return { messages: [request.message], holder: session.id, coins: [], until: refund.expiresAt };
}
