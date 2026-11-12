import {
  decimal,
  exactObject,
  Fault,
  fail,
  hexField,
  MAX_MONEY_SATS,
  MAX_SIGNED_64,
  mainnetEnabled,
} from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { keyAggExport, keyAggregate } from "@scure/btc-signer/musig2.js";
import { canonicalBytes, canonicalJson, framed, parseCanonicalJson } from "./canonical.js";
import { compressedKey, modelId, p2trScript, xOnlyKey } from "./keys.js";

export const QUOTE_PROFILE = "hive-metered/v2";
export const QUOTE_DOMAIN = "hive-metered/v2/quote";
/** Quotes signed before the project took the Hive name: they still verify as history, but nothing new is signed or funded under them. */
export const RECORDED_QUOTE_PROFILE = "buzzpool-metered/v2";
const RECORDED_QUOTE_DOMAIN = "buzzpool-metered/v2/quote";
export const COMPUTE_PAIR = "arkade:BTC->compute:METERED_INFERENCE";
export { MAX_MONEY_SATS };
export type HiveNetwork = "regtest" | "mutinynet" | "bitcoin";

export interface QuoteBody {
  profile: typeof QUOTE_PROFILE | typeof RECORDED_QUOTE_PROFILE;
  pair: typeof COMPUTE_PAIR;
  network: HiveNetwork;
  requestId: string;
  quoteNonce: string;
  model: string;
  operatorKey: string;
  emulatorKey: string;
  providerRfqKey: string;
  providerWorkloadKey: string;
  providerPayoutScript: string;
  payerReceiptKey: string;
  treasuryScript: string;
  /** The MuSig2 keys of the three steward pairs, x-only: the escrow's exits and its claim registrars. */
  stewardPairKeys: [string, string, string];
  capSats: string;
  inputRateMsatPerMillionTokens: string;
  outputRateMsatPerMillionTokens: string;
  timeoutAt: string;
  quoteExpiresAt: string;
  exitDelaySeconds: string;
}

export interface SignedQuote {
  body: QuoteBody;
  quoteId: string;
  signature: string;
}

const FIELDS = [
  "profile",
  "pair",
  "network",
  "requestId",
  "quoteNonce",
  "model",
  "operatorKey",
  "emulatorKey",
  "providerRfqKey",
  "providerWorkloadKey",
  "providerPayoutScript",
  "payerReceiptKey",
  "treasuryScript",
  "stewardPairKeys",
  "capSats",
  "inputRateMsatPerMillionTokens",
  "outputRateMsatPerMillionTokens",
  "timeoutAt",
  "quoteExpiresAt",
  "exitDelaySeconds",
] as const;

/** Terms every party approves independently before funding; the provider adds only the nonce. */
export const QUOTE_TERMS = [
  "network",
  "requestId",
  "model",
  "operatorKey",
  "emulatorKey",
  "providerRfqKey",
  "providerWorkloadKey",
  "providerPayoutScript",
  "payerReceiptKey",
  "treasuryScript",
  "stewardPairKeys",
  "exitDelaySeconds",
  "capSats",
  "inputRateMsatPerMillionTokens",
  "outputRateMsatPerMillionTokens",
  "timeoutAt",
  "quoteExpiresAt",
] as const;

export type QuoteTerms = Pick<QuoteBody, (typeof QUOTE_TERMS)[number]>;
export type QuoteFundingContext = QuoteTerms & { nowSeconds: string };

const KEY_FIELDS = [
  "operatorKey",
  "emulatorKey",
  "providerRfqKey",
  "providerWorkloadKey",
  "payerReceiptKey",
] as const;

/** Validate every signed field. No clock policy is applied here. */
export function parseQuoteBody(value: unknown): QuoteBody {
  const raw = exactObject(value, FIELDS, "quote body");
  if ((raw.profile !== QUOTE_PROFILE && raw.profile !== RECORDED_QUOTE_PROFILE) || raw.pair !== COMPUTE_PAIR)
    fail("INVALID", "unsupported profile or pair");
  if (
    raw.network !== "regtest" &&
    raw.network !== "mutinynet" &&
    !(raw.network === "bitcoin" && mainnetEnabled())
  )
    fail("INVALID", "only regtest and Mutinynet, or bitcoin where mainnet is enabled");
  hexField(raw.requestId, 32, "requestId");
  hexField(raw.quoteNonce, 32, "quoteNonce");
  modelId(raw.model);
  for (const field of KEY_FIELDS) xOnlyKey(raw[field], field);
  const providerScript = p2trScript(raw.providerPayoutScript, "providerPayoutScript");
  const treasuryScript = p2trScript(raw.treasuryScript, "treasuryScript");
  if (providerScript === treasuryScript) fail("INVALID", "provider and treasury destinations must differ");
  if (!Array.isArray(raw.stewardPairKeys) || raw.stewardPairKeys.length !== 3) {
    fail("INVALID", "exactly three steward pair keys");
  }
  // Canonical encoding rejects sparse arrays, extra properties and accessors.
  canonicalBytes(raw.stewardPairKeys);
  const pairs: [string, string, string] = [
    xOnlyKey(raw.stewardPairKeys[0], "steward pair key"),
    xOnlyKey(raw.stewardPairKeys[1], "steward pair key"),
    xOnlyKey(raw.stewardPairKeys[2], "steward pair key"),
  ];
  const identities = [...KEY_FIELDS.map((field) => raw[field] as string), ...pairs];
  if (new Set(identities).size !== identities.length) fail("INVALID", "roles require distinct public keys");
  if (identities.includes(providerScript.slice(4)))
    fail("INVALID", "provider payout is an authorization key");
  decimal(raw.capSats, "capSats", 1n, MAX_MONEY_SATS);
  const inputRate = decimal(raw.inputRateMsatPerMillionTokens, "inputRateMsatPerMillionTokens");
  const outputRate = decimal(raw.outputRateMsatPerMillionTokens, "outputRateMsatPerMillionTokens");
  if (inputRate === 0n && outputRate === 0n) fail("INVALID", "at least one token rate must be positive");
  const deadline = decimal(raw.timeoutAt, "timeoutAt", 1n);
  const expiry = decimal(raw.quoteExpiresAt, "quoteExpiresAt", 1n);
  if (expiry >= deadline) fail("INVALID", "quote expiry must precede the escrow deadline");
  const exitDelay = decimal(raw.exitDelaySeconds, "exitDelaySeconds", 1n, 65535n * 512n);
  if (exitDelay % 512n !== 0n) fail("INVALID", "exit delay must be a multiple of 512 seconds");
  return { ...raw, stewardPairKeys: pairs } as unknown as QuoteBody;
}

/**
 * The receiver key the hive's Lightning address names for swaps and per-payment
 * destinations: the MuSig2 aggregate of all three stewards, sorted, as an even
 * compressed key. No single party, the coordinator included, holds it.
 */
export function intakeKey(stewardKeys: readonly [string, string, string]): string {
  const keys = stewardKeys.map((key, i) => compressedKey(key, `steward key ${i}`));
  if (new Set(keys).size !== 3) fail("INVALID", "intake key needs three distinct stewards");
  return `02${bytesToHex(keyAggExport(keyAggregate([...keys].sort().map((key) => hexToBytes(key)))))}`;
}

export function quoteCanonicalBytes(body: QuoteBody): Uint8Array {
  return canonicalBytes(parseQuoteBody(body));
}

/** UTF8(domain), NUL, uint32 big-endian payload length, canonical UTF-8 body. */
export function quotePreimage(body: QuoteBody): Uint8Array {
  const domain = body.profile === RECORDED_QUOTE_PROFILE ? RECORDED_QUOTE_DOMAIN : QUOTE_DOMAIN;
  return framed(domain, Uint8Array.of(0), quoteCanonicalBytes(body));
}

export function quoteDigest(body: QuoteBody): Uint8Array {
  return sha256(quotePreimage(body));
}

/** The quote digest is the escrow id; a receipt for one escrow fails for every other. */
export function deriveEscrowId(body: QuoteBody): string {
  return bytesToHex(quoteDigest(body));
}

/** Quote authority belongs to the RFQ key, separate from the workload claim key. */
export function signQuote(value: QuoteBody, secretKey: Uint8Array, auxRand?: Uint8Array): SignedQuote {
  const body = parseQuoteBody(value);
  if (body.profile !== QUOTE_PROFILE) fail("INVALID", "retired quote profile");
  if (bytesToHex(schnorr.getPublicKey(secretKey)) !== body.providerRfqKey) fail("QUOTE_SIGNER");
  const digest = quoteDigest(body);
  return {
    body,
    quoteId: bytesToHex(digest),
    signature: bytesToHex(schnorr.sign(digest, secretKey, auxRand)),
  };
}

export function parseSignedQuote(value: unknown): SignedQuote {
  const envelope = exactObject(value, ["body", "quoteId", "signature"], "signed quote");
  return {
    body: parseQuoteBody(envelope.body),
    quoteId: hexField(envelope.quoteId, 32, "quoteId"),
    signature: hexField(envelope.signature, 64, "quote signature"),
  };
}

/** Historical validity: digest and RFQ signature, independent of time and deployment. */
export function requireValidSignedQuote(value: unknown): SignedQuote {
  const quote = parseSignedQuote(value);
  const digest = quoteDigest(quote.body);
  if (quote.quoteId !== bytesToHex(digest)) fail("QUOTE_ID_MISMATCH");
  if (!schnorr.verify(hexToBytes(quote.signature), digest, hexToBytes(quote.body.providerRfqKey))) {
    fail("QUOTE_SIGNATURE");
  }
  return quote;
}

export function verifySignedQuote(value: unknown): boolean {
  try {
    requireValidSignedQuote(value);
    return true;
  } catch {
    return false;
  }
}

/** The approved terms of a quote, without its profile, pair and nonce. */
export function quoteTerms(body: QuoteBody): QuoteTerms {
  return Object.fromEntries(QUOTE_TERMS.map((field) => [field, body[field]])) as QuoteTerms;
}

/** Check a quote against independently approved terms at `nowSeconds`. */
export function validateQuoteForFunding(value: unknown, expected: QuoteFundingContext): SignedQuote {
  const quote = requireValidSignedQuote(value);
  if (quote.body.profile !== QUOTE_PROFILE) fail("INVALID", "retired quote profile");
  exactObject(expected, [...QUOTE_TERMS, "nowSeconds"], "quote funding context");
  for (const field of QUOTE_TERMS) {
    if (canonicalJson(quote.body[field]) !== canonicalJson(expected[field])) {
      throw new Fault("QUOTE_TERMS_MISMATCH", field);
    }
  }
  const now = decimal(expected.nowSeconds, "nowSeconds", 1n);
  if (now >= BigInt(quote.body.quoteExpiresAt)) fail("QUOTE_EXPIRED");
  if (now >= BigInt(quote.body.timeoutAt)) fail("ESCROW_DEADLINE_PASSED");
  return quote;
}

/** Signature and terms only; `nowSeconds: "1"` deliberately skips the clock. */
export function validateQuoteTerms(value: unknown, terms: QuoteTerms): SignedQuote {
  return validateQuoteForFunding(value, { ...terms, nowSeconds: "1" });
}

export function serializeSignedQuote(value: unknown): string {
  return canonicalJson(requireValidSignedQuote(value));
}

export function parseSignedQuoteJson(text: string): SignedQuote {
  return requireValidSignedQuote(parseCanonicalJson(text));
}

/** Cumulative price, rounded up once over the combined usage; never above the cap. */
export function quoteCostSats(
  value: QuoteBody,
  inputTokens: string | bigint,
  outputTokens: string | bigint,
): bigint {
  const body = parseQuoteBody(value);
  const input = decimal(
    typeof inputTokens === "bigint" ? inputTokens.toString() : inputTokens,
    "inputTokens",
  );
  const output = decimal(
    typeof outputTokens === "bigint" ? outputTokens.toString() : outputTokens,
    "outputTokens",
  );
  const numerator =
    input * BigInt(body.inputRateMsatPerMillionTokens) + output * BigInt(body.outputRateMsatPerMillionTokens);
  const sats = (numerator + 999_999_999n) / 1_000_000_000n;
  if (sats > BigInt(body.capSats)) fail("USAGE_EXCEEDS_CAP");
  return sats;
}

/**
 * The escrow's constructor terms, read from a valid quote: the payer's receipt
 * key, the provider's workload key as its claim key, both witness programs,
 * the quote id as escrow id, the deadline, the exit delay and the pair keys.
 */
export interface EscrowQuoteTerms {
  payer: string;
  provider: string;
  providerProgram: string;
  treasuryProgram: string;
  escrowId: string;
  timeoutAt: number;
  exitDelaySeconds: number;
  pairs: { "01": string; "02": string; "12": string };
}

export function escrowTermsFromQuote(value: unknown): EscrowQuoteTerms {
  const { body, quoteId } = requireValidSignedQuote(value);
  const [p01, p02, p12] = body.stewardPairKeys;
  return {
    payer: body.payerReceiptKey,
    provider: body.providerWorkloadKey,
    providerProgram: body.providerPayoutScript.slice(4),
    treasuryProgram: body.treasuryScript.slice(4),
    escrowId: quoteId,
    timeoutAt: Number(body.timeoutAt),
    exitDelaySeconds: Number(body.exitDelaySeconds),
    pairs: { "01": p01, "02": p02, "12": p12 },
  };
}

export { MAX_SIGNED_64 };
