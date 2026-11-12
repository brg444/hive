import { decimal, exactObject, fail, hexField } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalBytes, framed } from "./canonical.js";
import { quoteCostSats, requireValidSignedQuote, type SignedQuote } from "./quote.js";
import { requireValidReceipt, type SignedReceipt } from "./receipt.js";

export const METERED_PROFILE = "hive-metered-output/v1";
export const GENESIS_RECEIPT_HASH = "00".repeat(32);
export const MAX_TOKEN_COUNT = 0xfffffffen;

export type OutputContentType = "application/json" | "text/event-stream";

export interface MeteredChallenge {
  profile: typeof METERED_PROFILE;
  escrowId: string;
  requestId: string;
  requestSha256: string;
  responseSha256: string;
  contentType: OutputContentType;
  inputTokens: string;
  outputTokens: string;
  totalTokens: string;
  cumulativeInputTokens: string;
  cumulativeOutputTokens: string;
  amountSats: string;
  sequence: string;
  previousReceiptSha256: string;
  challengeId: string;
  /** Workload-key signature over `challengeId`, so an over-report is attributable. */
  providerSignature: string;
}

export type MeteredChallengeBody = Omit<MeteredChallenge, "challengeId" | "providerSignature">;

/** Per-request ceilings the payer applies before signing. */
export interface MeteredRequestLimits {
  maxInputTokens: string;
  maxOutputTokens: string;
  maxRequestSats: string;
}

/** The committed ledger before this request, plus the request it must describe. */
export interface MeteredContext {
  requestId: string;
  requestSha256: string;
  previousReceipt: SignedReceipt | null;
  sequence: string;
  cumulativeInputTokens: string;
  cumulativeOutputTokens: string;
  requestLimits: MeteredRequestLimits;
  /** Acceptance-time deadline check; omit only for historical verification. */
  nowSeconds?: string;
}

const BODY_FIELDS = [
  "profile",
  "escrowId",
  "requestId",
  "requestSha256",
  "responseSha256",
  "contentType",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cumulativeInputTokens",
  "cumulativeOutputTokens",
  "amountSats",
  "sequence",
  "previousReceiptSha256",
] as const;

export function receiptSha256(receipt: SignedReceipt | null): string {
  return receipt === null ? GENESIS_RECEIPT_HASH : bytesToHex(sha256(canonicalBytes(receipt)));
}

export function meteredChallengeId(body: MeteredChallengeBody): string {
  return bytesToHex(sha256(framed(METERED_PROFILE, Uint8Array.of(0), canonicalBytes(body))));
}

export function makeMeteredChallenge(
  body: MeteredChallengeBody,
  workloadSecret: Uint8Array,
): MeteredChallenge {
  exactObject(body, BODY_FIELDS, "metered challenge body");
  const challengeId = meteredChallengeId(body);
  const providerSignature = bytesToHex(schnorr.sign(hexToBytes(challengeId), workloadSecret));
  return { ...body, challengeId, providerSignature };
}

/**
 * Check the provider's cumulative charge before a receipt is signed: identity,
 * sequence and previous receipt, counters, per-request ceilings, quoted price,
 * deadline, digest and workload signature.
 */
export function validateMeteredChallenge(
  value: unknown,
  signedQuote: SignedQuote,
  expected: MeteredContext,
): MeteredChallenge {
  const quote = requireValidSignedQuote(signedQuote);
  const raw = exactObject(value, [...BODY_FIELDS, "challengeId", "providerSignature"], "metered challenge");
  if (raw.profile !== METERED_PROFILE || raw.escrowId !== quote.quoteId) fail("CHALLENGE_ESCROW");
  for (const field of [
    "escrowId",
    "requestId",
    "requestSha256",
    "responseSha256",
    "previousReceiptSha256",
    "challengeId",
  ] as const) {
    hexField(raw[field], 32, field);
  }
  if (raw.requestId !== expected.requestId || raw.requestSha256 !== expected.requestSha256)
    fail("CHALLENGE_REQUEST");
  if (raw.contentType !== "application/json" && raw.contentType !== "text/event-stream")
    fail("CHALLENGE_CONTENT_TYPE");
  const input = decimal(raw.inputTokens, "inputTokens", 0n, MAX_TOKEN_COUNT);
  const output = decimal(raw.outputTokens, "outputTokens", 0n, MAX_TOKEN_COUNT);
  const total = decimal(raw.totalTokens, "totalTokens", 0n, MAX_TOKEN_COUNT);
  if (input + output !== total) fail("CHALLENGE_USAGE_TOTALS");
  const limits = exactObject(
    expected.requestLimits,
    ["maxInputTokens", "maxOutputTokens", "maxRequestSats"],
    "request limits",
  );
  if (
    input > decimal(limits.maxInputTokens, "maximum input tokens") ||
    output > decimal(limits.maxOutputTokens, "maximum output tokens", 1n, 65536n)
  ) {
    fail("CHALLENGE_TOKEN_LIMIT");
  }
  const previousInput = decimal(expected.cumulativeInputTokens, "previous input tokens");
  const previousOutput = decimal(expected.cumulativeOutputTokens, "previous output tokens");
  if (
    decimal(raw.cumulativeInputTokens, "cumulativeInputTokens") !== previousInput + input ||
    decimal(raw.cumulativeOutputTokens, "cumulativeOutputTokens") !== previousOutput + output
  ) {
    fail("CHALLENGE_CUMULATIVE");
  }
  if (decimal(raw.sequence, "sequence", 1n) !== decimal(expected.sequence, "previous sequence") + 1n) {
    fail("CHALLENGE_SEQUENCE");
  }
  const previousCost = quoteCostSats(quote.body, previousInput, previousOutput);
  if (expected.previousReceipt) {
    const previous = requireValidReceipt(expected.previousReceipt, {
      escrowId: quote.quoteId,
      payerReceiptKey: quote.body.payerReceiptKey,
      capSats: quote.body.capSats,
    });
    if (BigInt(previous.amountSats) !== previousCost) fail("CHALLENGE_PREVIOUS_RECEIPT");
  } else if (previousCost !== 0n || expected.sequence !== "0") {
    fail("CHALLENGE_PREVIOUS_RECEIPT");
  }
  if (raw.previousReceiptSha256 !== receiptSha256(expected.previousReceipt))
    fail("CHALLENGE_PREVIOUS_RECEIPT");
  const amount = quoteCostSats(quote.body, previousInput + input, previousOutput + output);
  if (decimal(raw.amountSats, "amountSats", 1n) !== amount) fail("CHALLENGE_PRICE");
  if (amount - previousCost > decimal(limits.maxRequestSats, "maximum request spend", 1n)) {
    fail("CHALLENGE_SPEND_CEILING");
  }
  if (
    expected.nowSeconds !== undefined &&
    decimal(expected.nowSeconds, "current time", 1n) >= BigInt(quote.body.timeoutAt)
  ) {
    fail("ESCROW_DEADLINE_PASSED");
  }
  const { challengeId, providerSignature, ...body } = raw;
  if (meteredChallengeId(body as unknown as MeteredChallengeBody) !== challengeId) fail("CHALLENGE_DIGEST");
  const signature = hexField(providerSignature, 64, "provider signature");
  const workloadKey = hexToBytes(quote.body.providerWorkloadKey);
  if (!schnorr.verify(hexToBytes(signature), hexToBytes(challengeId as string), workloadKey)) {
    fail("CHALLENGE_SIGNATURE");
  }
  return raw as unknown as MeteredChallenge;
}
