/**
 * Writes `packages/protocol/vectors/protocol.json`, the public vectors for
 * `hive-metered/v2`. Keys derive from fixed labels, so the file is
 * reproducible; none of them is ever used outside these vectors.
 *
 *   node --import tsx tools/protocol-vectors.ts
 *
 * `tools/protocol-vectors` (Go) then checks the `crypto` section with the
 * Emulator's number encoder, Go's SHA-256 and btcd's BIP340.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pairKeys } from "@hive/ark";
import { hex, repositoryRoot } from "@hive/kit";
import {
  canonicalJson,
  encodeReceiptAmount,
  framed,
  QUOTE_DOMAIN,
  type QuoteBody,
  quoteDigest,
  quotePreimage,
  receiptDigest,
  receiptPreimage,
  type SignedQuote,
  signQuote,
  signReceipt,
} from "@hive/protocol";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const label = (text: string) => sha256(new TextEncoder().encode(`hive-protocol-vectors/v2/${text}`));
const xonly = (text: string) => hex(schnorr.getPublicKey(label(text)));
const compressed = (text: string) => hex(secp256k1.getPublicKey(label(text), true));
const MAX_I64 = "9223372036854775807";

const rfqSecret = label("rfq");
const payerSecret = label("payer");
const stewards = [compressed("steward-0"), compressed("steward-1"), compressed("steward-2")] as [
  string,
  string,
  string,
];
const pairs = pairKeys(stewards);

function body(network: "regtest" | "mutinynet"): QuoteBody {
  return {
    profile: "hive-metered/v2",
    pair: "arkade:BTC->compute:METERED_INFERENCE",
    network,
    requestId: hex(label("request")),
    quoteNonce: hex(label("nonce")),
    model: "vector-model/v1",
    operatorKey: xonly("operator"),
    emulatorKey: xonly("emulator"),
    providerRfqKey: hex(schnorr.getPublicKey(rfqSecret)),
    providerWorkloadKey: xonly("workload"),
    providerPayoutScript: `5120${xonly("payout")}`,
    payerReceiptKey: hex(schnorr.getPublicKey(payerSecret)),
    treasuryScript: `5120${xonly("treasury")}`,
    stewardPairKeys: [pairs["01"], pairs["02"], pairs["12"]],
    capSats: "20000",
    inputRateMsatPerMillionTokens: "1234",
    outputRateMsatPerMillionTokens: "5678",
    timeoutAt: "1800003600",
    quoteExpiresAt: "1800000060",
    exitDelaySeconds: "1024",
  };
}

const NOW = "1800000000";
const context = (b: QuoteBody) => {
  const { profile: _p, pair: _q, quoteNonce: _n, ...terms } = b;
  return { ...terms, nowSeconds: NOW };
};

/** Signs any body, valid or not, over the quote preimage of its canonical JSON (numbers allowed). */
function looseCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(looseCanonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${looseCanonical((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
function signLoose(b: Record<string, unknown>, domain = QUOTE_DOMAIN) {
  const preimage = framed(domain, Uint8Array.of(0), new TextEncoder().encode(looseCanonical(b)));
  const digest = sha256(preimage);
  return {
    preimage,
    digest,
    signed: {
      body: b,
      quoteId: hex(digest),
      signature: hex(schnorr.sign(digest, rfqSecret, new Uint8Array(32))),
    },
  };
}

const quotes = (["regtest", "mutinynet"] as const).map((network) => {
  const b = body(network);
  const signed = signQuote(b, rfqSecret, new Uint8Array(32));
  return {
    label: network,
    signed,
    context: context(b),
    canonicalJson: canonicalJson(b),
    canonicalUtf8Hex: hex(new TextEncoder().encode(canonicalJson(b))),
    preimageHex: hex(quotePreimage(b)),
    digestHex: hex(quoteDigest(b)),
  };
});
const base = quotes[0]!.signed as SignedQuote;
const escrowId = base.quoteId;

const receipts = ["1", "330", "331", MAX_I64].map((amountSats) => {
  const receipt = signReceipt({ escrowId, amountSats }, payerSecret, new Uint8Array(32));
  return {
    label: `amount-${amountSats}`,
    receipt,
    context: { escrowId, payerReceiptKey: base.body.payerReceiptKey, capSats: MAX_I64 },
    amount8Hex: hex(encodeReceiptAmount(amountSats)),
    preimageHex: hex(receiptPreimage(escrowId, amountSats)),
    digestHex: hex(receiptDigest(escrowId, amountSats)),
  };
});

// Bodies the schema refuses although their signatures verify.
const b0 = base.body as unknown as Record<string, unknown>;
const mutate = (patch: Record<string, unknown>) => ({ ...b0, ...patch });
const otherKey = xonly("other");
const schemaRejected: [string, Record<string, unknown>][] = [
  ["unknown-field", { ...b0, unknown: "value" }],
  ["wrong-profile", mutate({ profile: "hive-metered/v1" })],
  ["mainnet", mutate({ network: "bitcoin" })],
  ["mainnet-name", mutate({ network: "mainnet" })],
  ["wrong-pair", mutate({ pair: "arkade:BTC->compute:OTHER" })],
  ["leading-zero-cap", mutate({ capSats: "020000" })],
  ["plus-cap", mutate({ capSats: "+20000" })],
  ["numeric-cap", mutate({ capSats: 20000 })],
  ["exponent-cap", mutate({ capSats: "2e4" })],
  ["zero-cap", mutate({ capSats: "0" })],
  ["leading-zero-rate", mutate({ inputRateMsatPerMillionTokens: "01234" })],
  ["zero-rates", mutate({ inputRateMsatPerMillionTokens: "0", outputRateMsatPerMillionTokens: "0" })],
  ["rate-overflow", mutate({ outputRateMsatPerMillionTokens: "18446744073709551616" })],
  ["timestamp-overflow", mutate({ timeoutAt: "9223372036854775808" })],
  ["model-whitespace", mutate({ model: " vector-model/v1" })],
  ["money-overflow", mutate({ capSats: "2100000000000001" })],
  ["exit-block-unit", mutate({ exitDelaySeconds: "1000" })],
  ["invalid-public-key", mutate({ providerRfqKey: "ff".repeat(32) })],
  ["uppercase-public-key", mutate({ providerRfqKey: (b0.providerRfqKey as string).toUpperCase() })],
  ["wrong-script-version", mutate({ providerPayoutScript: `0020${xonly("payout")}` })],
  ["two-pair-keys", mutate({ stewardPairKeys: [pairs["01"], pairs["02"]] })],
  ["duplicate-pair-keys", mutate({ stewardPairKeys: [pairs["01"], pairs["01"], pairs["12"]] })],
  ["compressed-pair-key", mutate({ stewardPairKeys: [`02${pairs["01"]}`, pairs["02"], pairs["12"]] })],
  ["pair-key-is-payer", mutate({ stewardPairKeys: [b0.payerReceiptKey, pairs["02"], pairs["12"]] })],
  ["rfq-workload-key-collision", mutate({ providerWorkloadKey: b0.providerRfqKey })],
  ["workload-direct-payout", mutate({ providerPayoutScript: `5120${b0.providerWorkloadKey}` })],
  ["expired-before-timeout", mutate({ quoteExpiresAt: "1800003600" })],
];
const signedRejected = schemaRejected.map(([name, b]) => ({ name, ...signLoose(b) }));

const negatives: unknown[] = signedRejected.map((s) => ({
  label: `quote-${s.name}`,
  check: "quote",
  signed: s.signed,
}));
negatives.push(
  { label: "quote-envelope-unknown-field", check: "quote", signed: { ...base, ignored: "value" } },
  { label: "quote-wrong-id", check: "quote", signed: { ...base, quoteId: hex(label("other-id")) } },
  {
    label: "quote-wrong-signer",
    check: "quote",
    signed: {
      ...base,
      signature: hex(schnorr.sign(quoteDigest(base.body), label("stranger"), new Uint8Array(32))),
    },
  },
);
const wrongDomain = signLoose(b0, "hive-metered/v1/quote");
negatives.push({
  label: "quote-wrong-signature-domain",
  check: "quote",
  signed: { ...base, signature: wrongDomain.signed.signature },
});
const ctx = context(base.body);
const reordered: [string, string, string] = [pairs["02"], pairs["01"], pairs["12"]];
for (const [field, value] of [
  ["network", "mutinynet"],
  ["requestId", otherKey],
  ["model", "other-model"],
  ["operatorKey", otherKey],
  ["emulatorKey", otherKey],
  ["providerRfqKey", otherKey],
  ["providerWorkloadKey", otherKey],
  ["providerPayoutScript", `5120${otherKey}`],
  ["payerReceiptKey", otherKey],
  ["treasuryScript", `5120${otherKey}`],
  ["stewardPairKeys", reordered],
  ["exitDelaySeconds", "2048"],
] as const)
  negatives.push({
    label: `quote-context-${field}`,
    check: "quoteFunding",
    signed: base,
    context: { ...ctx, [field]: value },
  });
negatives.push(
  {
    label: "quote-context-unknown-field",
    check: "quoteFunding",
    signed: base,
    context: { ...ctx, unknown: "value" },
  },
  {
    label: "quote-expiry-boundary",
    check: "quoteFunding",
    signed: base,
    context: { ...ctx, nowSeconds: "1800000060" },
  },
  {
    label: "quote-after-timeout",
    check: "quoteFunding",
    signed: base,
    context: { ...ctx, nowSeconds: "1800003600" },
  },
);
const text = canonicalJson(base.body);
negatives.push(
  { label: "canonical-whitespace", check: "canonicalParse", text: text.replace(":", ": ") },
  {
    label: "canonical-reordered-keys",
    check: "canonicalParse",
    text: `{${Object.keys(b0)
      .sort()
      .reverse()
      .map((k) => `${JSON.stringify(k)}:${JSON.stringify(b0[k])}`)
      .join(",")}}`,
  },
  {
    label: "canonical-duplicate-key",
    check: "canonicalParse",
    text: text.replace("{", '{"capSats":"20000",'),
  },
  { label: "canonical-numeric-json-value", check: "canonicalParse", text: '{"a":1}' },
  {
    label: "canonical-escaped-equivalent",
    check: "canonicalParse",
    text: text.replace('"capSats"', '"cap\\u0053ats"'),
  },
);
const receiptCtx = receipts[2]!.context;
const r331 = receipts[2]!.receipt;
const otherEscrow = hex(label("other-escrow"));
negatives.push(
  {
    label: "receipt-cross-escrow-replay",
    check: "receipt",
    receipt: { ...r331, escrowId: otherEscrow },
    context: { ...receiptCtx, escrowId: otherEscrow },
  },
  {
    label: "receipt-wrong-amount",
    check: "receipt",
    receipt: { ...r331, amountSats: "332" },
    context: receiptCtx,
  },
  {
    label: "receipt-wrong-signer",
    check: "receipt",
    receipt: {
      ...r331,
      signature: hex(schnorr.sign(receiptDigest(escrowId, "331"), label("stranger"), new Uint8Array(32))),
    },
    context: receiptCtx,
  },
  {
    label: "receipt-wrong-domain",
    check: "receipt",
    receipt: {
      ...r331,
      signature: hex(
        schnorr.sign(sha256(new TextEncoder().encode("other-domain")), payerSecret, new Uint8Array(32)),
      ),
    },
    context: receiptCtx,
  },
  {
    label: "receipt-wrong-expected-key",
    check: "receipt",
    receipt: r331,
    context: { ...receiptCtx, payerReceiptKey: otherKey },
  },
  { label: "receipt-above-cap", check: "receipt", receipt: r331, context: { ...receiptCtx, capSats: "330" } },
  {
    label: "receipt-unknown-field",
    check: "receipt",
    receipt: { ...r331, unknown: "value" },
    context: receiptCtx,
  },
  {
    label: "receipt-short-signature",
    check: "receipt",
    receipt: { ...r331, signature: r331.signature.slice(2) },
    context: receiptCtx,
  },
  {
    label: "receipt-extra-sighash-byte",
    check: "receipt",
    receipt: { ...r331, signature: `${r331.signature}01` },
    context: receiptCtx,
  },
);
for (const amount of [
  "0",
  "-1",
  "9223372036854775808",
  "18446744073709551615",
  "01",
  "+1",
  "1.0",
  "1e0",
  " 1",
  "1 ",
  "",
  1,
])
  negatives.push({
    label: `receipt-invalid-amount-${JSON.stringify(amount)}`,
    check: "receiptAmount",
    amount,
  });
negatives.push(
  { label: "receipt-short-id", check: "receiptId", escrowId: "00".repeat(31) },
  { label: "receipt-uppercase-id", check: "receiptId", escrowId: escrowId.toUpperCase() },
);
for (const [field, value] of [
  ["capSats", "19999"],
  ["inputRateMsatPerMillionTokens", "1233"],
  ["outputRateMsatPerMillionTokens", "5677"],
  ["timeoutAt", "1800003599"],
  ["quoteExpiresAt", "1800000059"],
] as const)
  negatives.push({
    label: `quote-context-${field}`,
    check: "quoteFunding",
    signed: base,
    context: { ...ctx, [field]: value },
  });

const messages = [
  ...signedRejected.map((s) => ({
    label: `schema-rejected-but-cryptographically-valid-${s.name}`,
    preimageHex: hex(s.preimage),
    digestHex: hex(s.digest),
    publicKeyHex: base.body.providerRfqKey,
    signatureHex: s.signed.signature,
    valid: true,
  })),
  ...quotes.map((q) => ({
    label: `quote-${q.label}`,
    preimageHex: q.preimageHex,
    digestHex: q.digestHex,
    publicKeyHex: base.body.providerRfqKey,
    signatureHex: q.signed.signature,
    valid: true,
  })),
  ...receipts.map((r) => ({
    label: `receipt-${r.label}`,
    preimageHex: r.preimageHex,
    digestHex: r.digestHex,
    publicKeyHex: base.body.payerReceiptKey,
    signatureHex: r.receipt.signature,
    valid: true,
  })),
  ...(["quote-wrong-signer", "quote-wrong-signature-domain"] as const).map((name) => {
    const n = negatives.find((x) => (x as { label: string }).label === name) as { signed: SignedQuote };
    return {
      label: name,
      preimageHex: quotes[0]!.preimageHex,
      digestHex: quotes[0]!.digestHex,
      publicKeyHex: base.body.providerRfqKey,
      signatureHex: n.signed.signature,
      valid: false,
    };
  }),
  ...[
    "receipt-cross-escrow-replay",
    "receipt-wrong-amount",
    "receipt-wrong-signer",
    "receipt-wrong-domain",
    "receipt-wrong-expected-key",
  ].map((name) => {
    const n = negatives.find((x) => (x as { label: string }).label === name) as {
      receipt: { escrowId: string; amountSats: string; signature: string };
      context: { payerReceiptKey: string };
    };
    return {
      label: name,
      preimageHex: hex(receiptPreimage(n.receipt.escrowId, n.receipt.amountSats)),
      digestHex: hex(receiptDigest(n.receipt.escrowId, n.receipt.amountSats)),
      publicKeyHex: n.context.payerReceiptKey,
      signatureHex: n.receipt.signature,
      valid: false,
    };
  }),
];

const vectors = {
  schema: "hive-protocol-vectors/v2",
  source:
    "Offline vectors generated by tools/protocol-vectors.ts from keys derived from fixed labels. No funded transactions are present.",
  quotes,
  receipts,
  negatives,
  crypto: {
    schema: "hive-public-crypto-vectors/v1",
    amounts: [
      ...["1", "330", "331", MAX_I64].map((d) => ({
        label: `amount-${d}`,
        decimal: d,
        expectedHex: hex(encodeReceiptAmount(d)),
        fits: true,
      })),
      { label: "overflow-positive-sign-bit", decimal: "9223372036854775808", fits: false },
    ],
    canonical: quotes.map((q) => ({ label: q.label, body: q.signed.body, utf8Hex: q.canonicalUtf8Hex })),
    messages,
  },
  costs: [
    { label: "zero-usage", inputTokens: "0", outputTokens: "0", expectedSats: "0", valid: true },
    { label: "combine-before-ceiling", inputTokens: "1", outputTokens: "1", expectedSats: "1", valid: true },
    {
      label: "fractional-cumulative",
      inputTokens: "1000000",
      outputTokens: "1000000",
      expectedSats: "7",
      valid: true,
    },
    {
      label: "exact-satoshi-cost",
      inputTokens: "1000000000",
      outputTokens: "0",
      expectedSats: "1234",
      valid: true,
    },
    { label: "over-cap", inputTokens: "20000000000", outputTokens: "0", valid: false },
    { label: "noncanonical-token-count", inputTokens: "01", outputTokens: "0", valid: false },
    { label: "negative-token-count", inputTokens: "-1", outputTokens: "0", valid: false },
  ],
};
const target = resolve(repositoryRoot, "packages/protocol/vectors/protocol.json");
const generated = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== generated) {
    process.stderr.write(`${target} differs from its generator\n`);
    process.exit(1);
  }
} else writeFileSync(target, generated);
process.stdout.write(
  `${JSON.stringify({ quotes: quotes.length, receipts: receipts.length, negatives: negatives.length, messages: messages.length })}\n`,
);
