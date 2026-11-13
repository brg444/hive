import type { ClaimPlan, JobEscrowParams, Pair, RefundPlan, SendPlan } from "@hive/ark";
import type { SignedQuote } from "@hive/protocol";

/** An authorization lives at most this long; its coins stay reserved until it ends. */
export const MAX_VALIDITY_SECONDS = 1800;

/**
 * A payment two keepers sign by hand, hours apart, stays valid up to 23 hours, so the second keeper
 * has the best part of a day to open the console. The delegatee registers a spend for at most a day
 * ahead, and the registration comes only once both have signed, so the hour left is a margin. Its
 * coins stay reserved for as long, and must not need renewing meanwhile.
 */
export const KEEPER_MAX_VALIDITY_SECONDS = 23 * 3600;

/** A treasury withdrawal a steward's administrator approved: exact destination, amount and expiry. */
export interface WithdrawalTerms {
  label: string;
  /** The P2TR script paid: an Ark address on this hive's Operator. */
  destination: string;
  amountSats: number;
  /** Unix seconds; the approval ends then. */
  expiresAt: number;
}

/**
 * A job the hive's agent asks the keepers to fund, as the pay-arkade plugin writes it to its funding
 * queue: the escrow's address and every term it is built from, so the address can be checked.
 */
export interface FundingRequest {
  jobId: string;
  /** The escrow's Ark address. */
  address: string;
  capSats: number;
  /** Unix seconds: the provider stops serving before it, and the escrow returns after it. */
  deadline: number;
  model: string;
  priceMsatPerMtok: number;
  providerPk: string;
  params: JobEscrowParams;
  /** Without a renewal service, the coin funding the escrow must last until then. */
  minCoinExpiry?: number;
}

export const sameWithdrawal = (a: WithdrawalTerms, b: WithdrawalTerms): boolean =>
  a.label === b.label &&
  a.destination === b.destination &&
  a.amountSats === b.amountSats &&
  a.expiresAt === b.expiresAt;

/**
 * What a pair of stewards is asked to sign, and why. A steward never signs a
 * message it was handed: it recomputes every message from the purpose, after
 * checking the purpose against its own policy and the network.
 *
 * A treasury spend takes two sessions: `attest` signs one message per coin,
 * then `register` signs the delegatee's request, which names those signatures.
 * A claim takes one: the request that registers the provider's claim. So does
 * a refund a pair registers after the deadline, should the escrow's refund
 * watch not act.
 *
 * A payment funds a MeshLLM job's escrow with exactly its cap, approved by the keepers themselves:
 * each confirms the funding request in the keeper console, so only a keeper's console signs one,
 * and a steward service refuses it.
 */
export type Purpose =
  | { kind: "allocation"; stage: "attest"; quote: SignedQuote; plan: SendPlan }
  | { kind: "allocation"; stage: "register"; quote: SignedQuote; plan: SendPlan; signatures: string[] }
  | { kind: "withdrawal"; stage: "attest"; withdrawal: WithdrawalTerms; plan: SendPlan }
  | {
      kind: "withdrawal";
      stage: "register";
      withdrawal: WithdrawalTerms;
      plan: SendPlan;
      signatures: string[];
    }
  | { kind: "payment"; stage: "attest"; request: FundingRequest; plan: SendPlan }
  | { kind: "payment"; stage: "register"; request: FundingRequest; plan: SendPlan; signatures: string[] }
  | { kind: "claim"; quote: SignedQuote; claim: ClaimPlan }
  | { kind: "refund"; quote: SignedQuote; refund: RefundPlan };

export interface SessionRequest {
  /** Chosen by the coordinator; a steward binds it to the messages on first use. */
  id: string;
  pair: Pair;
  purpose: Purpose;
}

export type StewardRequest =
  | { operation: "describe" }
  | { operation: "nonce"; session: SessionRequest }
  | { operation: "sign"; session: SessionRequest; peerNonces: string[] }
  | { operation: "sign-last"; session: SessionRequest; peerNonces: string[] };

export interface StewardDescription {
  index: 0 | 1 | 2;
  publicKey: string;
  pairs: Record<Pair, string>;
  treasuryScript: string;
}
