import { randomBytes } from "node:crypto";
import { hex } from "@hive/kit";
import { pairKeys } from "@hive/ark";
import {
  type ComputeQuoteRequest,
  type QuoteBody,
  type QuoteTerms,
  quoteTerms,
  type SignedQuote,
  signQuote,
} from "@hive/protocol";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";

/** Fresh role keys and a signed quote for offline tests. Keys exist only in memory. */
export interface QuoteFixture {
  secrets: {
    operator: Uint8Array;
    emulator: Uint8Array;
    rfq: Uint8Array;
    workload: Uint8Array;
    payer: Uint8Array;
    payout: Uint8Array;
    treasury: Uint8Array;
    stewards: [Uint8Array, Uint8Array, Uint8Array];
  };
  body: QuoteBody;
  quote: SignedQuote;
  terms: QuoteTerms;
  request: ComputeQuoteRequest;
}

export function newSecret(): Uint8Array {
  return schnorr.utils.randomSecretKey();
}

export function xOnly(secret: Uint8Array): string {
  return hex(schnorr.getPublicKey(secret));
}

export function compressed(secret: Uint8Array): string {
  return hex(secp256k1.getPublicKey(secret));
}

export function makeQuote(overrides: Partial<QuoteBody> = {}): QuoteFixture {
  const secrets = {
    operator: newSecret(),
    emulator: newSecret(),
    rfq: newSecret(),
    workload: newSecret(),
    payer: newSecret(),
    payout: newSecret(),
    treasury: newSecret(),
    stewards: [newSecret(), newSecret(), newSecret()] as [Uint8Array, Uint8Array, Uint8Array],
  };
  const pairs = pairKeys(secrets.stewards.map(compressed) as [string, string, string]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const body: QuoteBody = {
    profile: "hive-metered/v2",
    pair: "arkade:BTC->compute:METERED_INFERENCE",
    network: "regtest",
    requestId: hex(randomBytes(32)),
    quoteNonce: hex(randomBytes(32)),
    model: "test-model",
    operatorKey: xOnly(secrets.operator),
    emulatorKey: xOnly(secrets.emulator),
    providerRfqKey: xOnly(secrets.rfq),
    providerWorkloadKey: xOnly(secrets.workload),
    providerPayoutScript: `5120${xOnly(secrets.payout)}`,
    payerReceiptKey: xOnly(secrets.payer),
    treasuryScript: `5120${xOnly(secrets.treasury)}`,
    stewardPairKeys: [pairs["01"], pairs["02"], pairs["12"]],
    capSats: "20000",
    inputRateMsatPerMillionTokens: "10000000000",
    outputRateMsatPerMillionTokens: "10000000000",
    timeoutAt: String(now + 7200n),
    quoteExpiresAt: String(now + 3600n),
    exitDelaySeconds: "1024",
    ...overrides,
  };
  const quote = signQuote(body, secrets.rfq, new Uint8Array(32));
  const { quoteNonce: _nonce, ...request } = quote.body;
  return { secrets, body: quote.body, quote, terms: quoteTerms(quote.body), request };
}
