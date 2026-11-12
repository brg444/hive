import { decimal, exactObject, Fault, fail } from "@hive/kit";
import { canonicalJson, parseCanonicalJson } from "./canonical.js";
import { type SignedProviderCard, validateProviderCard } from "./card.js";
import {
  parseQuoteBody,
  type QuoteBody,
  type QuoteFundingContext,
  requireValidSignedQuote,
  type SignedQuote,
} from "./quote.js";

/** The hive's side of a quote: every signed term except the provider's nonce. */
export type ComputeQuoteRequest = Omit<QuoteBody, "quoteNonce">;

export interface RfqRequestWire {
  v: 1;
  type: "rfq_request";
  rfq_id: string;
  pair: string;
  request: string;
}

export interface RfqQuoteWire {
  v: 1;
  type: "rfq_quote";
  rfq_id: string;
  pair: string;
  quote: string;
}

export function parseComputeQuoteRequest(value: unknown): ComputeQuoteRequest {
  canonicalJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID", "compute request must be an object");
  if (Object.hasOwn(value, "quoteNonce")) fail("INVALID", "the provider owns quoteNonce");
  const { quoteNonce: _nonce, ...request } = parseQuoteBody({ ...value, quoteNonce: "00".repeat(32) });
  return request;
}

export function quoteContextFromRequest(
  request: ComputeQuoteRequest,
  nowSeconds: string,
): QuoteFundingContext {
  const { profile: _profile, pair: _pair, ...context } = parseComputeQuoteRequest(request);
  return { ...context, nowSeconds };
}

/** A request is quotable when it copies the card's terms and fits its limits. */
export function validateRequestAgainstCard(
  request: ComputeQuoteRequest,
  card: SignedProviderCard,
  nowSeconds: string,
): void {
  const parsed = parseComputeQuoteRequest(request);
  const { body } = validateProviderCard(card, nowSeconds);
  for (const field of [
    "network",
    "model",
    "providerRfqKey",
    "providerWorkloadKey",
    "providerPayoutScript",
    "inputRateMsatPerMillionTokens",
    "outputRateMsatPerMillionTokens",
  ] as const) {
    if (parsed[field] !== body[field]) throw new Fault("REQUEST_CARD_MISMATCH", field);
  }
  const now = decimal(nowSeconds, "current time", 1n);
  if (BigInt(parsed.capSats) > BigInt(body.maxCapSats)) fail("REQUEST_EXCEEDS_CAP");
  if (BigInt(parsed.quoteExpiresAt) <= now || BigInt(parsed.quoteExpiresAt) > BigInt(body.expiresAt)) {
    fail("REQUEST_QUOTE_EXPIRY");
  }
  if (BigInt(parsed.timeoutAt) <= now || BigInt(parsed.timeoutAt) - now > BigInt(body.maxDurationSeconds)) {
    fail("REQUEST_DURATION");
  }
}

/** A quote answers a request when it changes nothing but the nonce. */
export function matchQuote(value: unknown, request: ComputeQuoteRequest): SignedQuote {
  const quote = requireValidSignedQuote(value);
  const { quoteNonce: _nonce, ...quoted } = quote.body;
  if (canonicalJson(quoted) !== canonicalJson(request)) fail("QUOTE_TERMS_CHANGED");
  return quote;
}

export function requestWire(request: ComputeQuoteRequest): RfqRequestWire {
  return {
    v: 1,
    type: "rfq_request",
    rfq_id: request.requestId,
    pair: request.pair,
    request: canonicalJson(request),
  };
}

export function parseRequestWire(value: unknown): ComputeQuoteRequest {
  const raw = exactObject(value, ["v", "type", "rfq_id", "pair", "request"], "RFQ request");
  if (raw.v !== 1 || raw.type !== "rfq_request" || typeof raw.request !== "string")
    fail("INVALID", "RFQ envelope");
  const request = parseComputeQuoteRequest(parseCanonicalJson(raw.request));
  if (raw.rfq_id !== request.requestId || raw.pair !== request.pair) fail("INVALID", "RFQ envelope identity");
  return request;
}

export function quoteWire(quote: SignedQuote): RfqQuoteWire {
  return {
    v: 1,
    type: "rfq_quote",
    rfq_id: quote.body.requestId,
    pair: quote.body.pair,
    quote: canonicalJson(quote),
  };
}

/** The quote travels as canonical text so its exact signed bytes survive transport. */
export function parseQuoteWire(value: unknown, request: ComputeQuoteRequest): SignedQuote {
  const raw = exactObject(value, ["v", "type", "rfq_id", "pair", "quote"], "RFQ quote");
  if (raw.v !== 1 || raw.type !== "rfq_quote") fail("INVALID", "RFQ reply envelope");
  if (raw.rfq_id !== request.requestId || raw.pair !== request.pair) fail("INVALID", "RFQ reply identity");
  if (typeof raw.quote !== "string") fail("INVALID", "quote must preserve canonical wire text");
  return matchQuote(requireValidSignedQuote(parseCanonicalJson(raw.quote)), request);
}
