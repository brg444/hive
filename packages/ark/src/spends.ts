import { ensure, Fault, fail, hex, unhex } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  type Coin,
  checkpointTxid,
  claimMessage,
  receiptMessage,
  sendMessage,
  spendFingerprint,
  spendRequestMessage,
  TREASURY_SEND_TAG,
  WALLET_SEND_TAG,
} from "./attest.js";
import { type Instance, leafOf } from "./contract.js";
import type { Pair } from "./musig.js";
import type { SpendRequest } from "./services.js";
import {
  type EscrowTerms,
  escrowVariables,
  intVar,
  type TreasuryTerms,
  treasuryVariables,
  type WalletTerms,
  walletVariables,
} from "./templates.js";

/**
 * A spend as its owners sign it. A plan names the coins, the terms and the
 * template; the owners sign one message per coin and then the delegatee's
 * request. Nothing in a plan is trusted by a signer: each recomputes the
 * messages from the terms before signing them.
 */
export interface SendTerms {
  amount: number;
  change: number;
  validUntil: number;
  /** The P2TR script paid. */
  destination: string;
}

export interface SendPlan extends SendTerms {
  account: "treasury" | "wallet";
  /** The treasury pair that authorizes it; absent for a wallet. */
  pair?: Pair;
  coins: (Coin & { script: string })[];
  templateId: string;
  /** The account's variables and the terms, without signatures. */
  variables: Record<string, string>;
}

export interface Dust {
  dust: number;
}

/** Pick coins, largest first, for exactly `amount`; change below dust takes another coin or fails. */
export function selectCoins<T extends Coin>(
  coins: T[],
  amount: number,
  dust: number,
): { picked: T[]; change: number } {
  ensure(Number.isSafeInteger(amount) && amount >= dust, "INVALID", `amounts start at ${dust} sats`);
  const sorted = [...coins].sort((a, b) => b.amount - a.amount);
  const picked: T[] = [];
  let total = 0;
  for (const coin of sorted) {
    if (total >= amount && (total === amount || total - amount >= dust)) break;
    picked.push(coin);
    total += coin.amount;
  }
  const change = total - amount;
  if (change < 0 || (change > 0 && change < dust))
    fail("INSUFFICIENT_FUNDS", `${total} sats cannot pay ${amount} with change`);
  ensure(picked.length <= 16, "TOO_MANY_COINS", "a spend takes at most 16 coins");
  return { picked, change };
}

/**
 * `selectCoins` over an account's coins. When the spendable coins fall short
 * only because others wait for their renewal, the fault is `COINS_RENEWING`:
 * the same send can be planned again once the delegatee has renewed them.
 */
export function pickCoins<T extends Coin>(
  coins: { spendable: T[]; renewing: T[] },
  amount: number,
  dust: number,
): { picked: T[]; change: number } {
  try {
    return selectCoins(coins.spendable, amount, dust);
  } catch (error) {
    if (!(error instanceof Fault) || error.code !== "INSUFFICIENT_FUNDS" || !coins.renewing.length)
      throw error;
    const waiting = coins.renewing.reduce((n, c) => n + c.amount, 0);
    if (coins.spendable.reduce((n, c) => n + c.amount, 0) + waiting < amount) throw error;
    return fail("COINS_RENEWING", `${waiting} sats wait for their renewal; plan again once it lands`);
  }
}

export function sendTerms(plan: SendPlan): SendTerms {
  return {
    amount: plan.amount,
    change: plan.change,
    validUntil: plan.validUntil,
    destination: plan.destination,
  };
}

export function planVariables(base: Record<string, string>, terms: SendTerms): Record<string, string> {
  return {
    ...base,
    amount: intVar(terms.amount),
    change: intVar(terms.change),
    valid_until: intVar(terms.validUntil),
    dest: terms.destination,
  };
}

export const treasuryPlanVariables = (t: TreasuryTerms, s: SendTerms) =>
  planVariables(treasuryVariables(t), s);
export const walletPlanVariables = (t: WalletTerms, s: SendTerms) => planVariables(walletVariables(t), s);

/**
 * The message each coin's `send` covenant checks. The checkpoint depends on
 * the leaf, so a treasury attestation also names the pair that signs it.
 */
export function sendMessages(plan: SendPlan, instance: Instance, unrollScript: string): Uint8Array[] {
  ensure(
    plan.coins.reduce((n, c) => n + c.amount, 0) === plan.amount + plan.change,
    "INVALID",
    "coins and terms disagree",
  );
  const fn = plan.account === "treasury" ? `send${plan.pair}` : "send";
  const tag = plan.account === "treasury" ? TREASURY_SEND_TAG : WALLET_SEND_TAG;
  const leaf = leafOf(instance, fn);
  return plan.coins.map((coin) => {
    ensure(coin.script === instance.pkScript, "INVALID", "a coin is not the account's");
    return sendMessage(tag, { txid: checkpointTxid(coin, leaf, unrollScript), vout: 0 }, sendTerms(plan));
  });
}

/** The variables with each coin's signature, and the outpoints in slot order. */
export function signedSend(
  plan: SendPlan,
  signatures: string[],
): { variables: Record<string, string>; outpoints: string[] } {
  ensure(signatures.length === plan.coins.length, "INVALID", "one signature per coin");
  const variables = { ...plan.variables };
  signatures.forEach((sig, i) => {
    variables[`sig_${i}`] = sig;
  });
  return { variables, outpoints: plan.coins.map((c) => `${c.txid}:${c.vout}`) };
}

/** What the exit-leaf key signs to register a spend, and the request it completes. */
export function spendRequestFor(
  templateId: string,
  variables: Record<string, string>,
  outpoints: string[],
  expiresAt: number,
  pubkey: string,
): { id: string; message: Uint8Array; request: (signature: string) => SpendRequest } {
  const id = spendFingerprint(templateId, variables, outpoints);
  return {
    id,
    message: spendRequestMessage(id, expiresAt),
    request: (signature) => {
      ensure(
        schnorr.verify(unhex(signature), spendRequestMessage(id, expiresAt), unhex(pubkey)),
        "SIGNATURE_INVALID",
        "spend request",
      );
      return { templateId, variables, outpoints, expiresAt, pubkey, signature };
    },
  };
}

/** The owner's attestation for each coin of a wallet send. */
export function sendSignatures(
  plan: SendPlan,
  instance: Instance,
  unrollScript: string,
  secretKey: Uint8Array,
): string[] {
  ensure(plan.account === "wallet", "INVALID", "not a wallet send");
  return sendMessages(plan, instance, unrollScript).map((m) => hex(schnorr.sign(m, secretKey)));
}

/** The delegatee's form of a wallet send: its request, signed by the owner's exit-leaf key. */
export function walletSendRequest(plan: SendPlan, signatures: string[], secretKey: Uint8Array): SpendRequest {
  const { variables, outpoints } = signedSend(plan, signatures);
  const pubkey = hex(schnorr.getPublicKey(secretKey));
  const req = spendRequestFor(plan.templateId, variables, outpoints, plan.validUntil, pubkey);
  return req.request(hex(schnorr.sign(req.message, secretKey)));
}

/** A wallet send signed in one process with the wallet's own key, as SimpleWallet does it. */
export function signWalletSend(
  plan: SendPlan,
  instance: Instance,
  unrollScript: string,
  secretKey: Uint8Array,
): SpendRequest {
  return walletSendRequest(plan, sendSignatures(plan, instance, unrollScript, secretKey), secretKey);
}

/**
 * The grace after `valid_until` used for authorization timing and coin
 * selection margins. It does not revoke signatures a service already issued.
 * A prepared or submitted spend with no observed outcome remains unresolved.
 */
export const AUTHORIZATION_GRACE_SECONDS = 600;

// ---------------------------------------------------------------- claims and refunds

export interface ClaimPlan {
  escrow: EscrowTerms;
  coin: Coin & { script: string };
  amount: number;
  receiptSig: string;
  claimSig: string;
  templateId: string;
  expiresAt: number;
}

/** Checks a claim against its escrow's terms, as the covenant will, before a pair registers it. */
export function checkClaim(plan: ClaimPlan): void {
  ensure(
    Number.isSafeInteger(plan.amount) && plan.amount > 0 && plan.amount <= plan.coin.amount,
    "CLAIM_INVALID",
    "amount",
  );
  ensure(
    schnorr.verify(
      unhex(plan.receiptSig),
      receiptMessage(plan.escrow.escrowId, plan.amount),
      unhex(plan.escrow.payer),
    ),
    "CLAIM_INVALID",
    "receipt signature",
  );
  ensure(
    schnorr.verify(
      unhex(plan.claimSig),
      claimMessage(plan.escrow.escrowId, plan.amount),
      unhex(plan.escrow.provider),
    ),
    "CLAIM_INVALID",
    "claim signature",
  );
  ensure(plan.expiresAt <= plan.escrow.timeoutAt, "CLAIM_INVALID", "a claim spend must end by the deadline");
}

/**
 * A refund a pair registers itself, after the deadline, should the escrow's
 * refund watch not act: the covenant pays the whole coin to the treasury.
 */
export interface RefundPlan {
  escrow: EscrowTerms;
  coin: Coin & { script: string };
  templateId: string;
  expiresAt: number;
}

/** A claim leaves a remainder for the treasury when more than 330 sats are left. */
export const claimHasRemainder = (plan: Pick<ClaimPlan, "coin" | "amount">): boolean =>
  plan.coin.amount - plan.amount > 330;

export function claimVariables(plan: ClaimPlan): Record<string, string> {
  return {
    ...escrowVariables(plan.escrow),
    amount: intVar(plan.amount),
    receipt_sig: plan.receiptSig,
    claim_sig: plan.claimSig,
  };
}
