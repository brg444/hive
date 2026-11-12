import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  canonicalBytes,
  canonicalJson,
  deriveEscrowId,
  encodeReceiptAmount,
  parseCanonicalJson,
  quoteCanonicalBytes,
  quoteCostSats,
  quoteDigest,
  quotePreimage,
  type ReceiptContext,
  receiptDigest,
  receiptPreimage,
  requireValidReceipt,
  requireValidSignedQuote,
  type SignedQuote,
  type SignedReceipt,
  validateQuoteForFunding,
  verifyReceipt,
  verifySignedQuote,
} from "../src/index.js";

type Context = Parameters<typeof validateQuoteForFunding>[1];
type Negative =
  | { label: string; check: "canonicalParse"; text: string }
  | { label: string; check: "quote"; signed: unknown }
  | { label: string; check: "quoteFunding"; signed: unknown; context: Context }
  | { label: string; check: "receipt"; receipt: unknown; context: ReceiptContext }
  | { label: string; check: "receiptAmount"; amount: unknown }
  | { label: string; check: "receiptId"; escrowId: string };
interface Vectors {
  schema: string;
  quotes: {
    label: string;
    signed: SignedQuote;
    context: Context;
    canonicalJson: string;
    canonicalUtf8Hex: string;
    preimageHex: string;
    digestHex: string;
  }[];
  receipts: {
    label: string;
    receipt: SignedReceipt;
    context: ReceiptContext;
    amount8Hex: string;
    preimageHex: string;
    digestHex: string;
  }[];
  negatives: Negative[];
  costs: {
    label: string;
    inputTokens: string;
    outputTokens: string;
    expectedSats?: string;
    valid: boolean;
  }[];
}

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../vectors/protocol.json"), "utf8"),
) as Vectors;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("vector file identity", () => {
  assert.equal(vectors.schema, "hive-protocol-vectors/v2");
  assert.equal(vectors.quotes.length, 2);
  assert.deepEqual(
    vectors.receipts.map((r) => r.receipt.amountSats),
    ["1", "330", "331", "9223372036854775807"],
  );
  assert.equal(vectors.negatives.length, 79);
});

test("quotes reproduce canonical bytes, preimage, digest and signature", () => {
  for (const q of vectors.quotes) {
    assert.equal(canonicalJson(q.signed.body), q.canonicalJson);
    assert.equal(hex(canonicalBytes(q.signed.body)), q.canonicalUtf8Hex);
    assert.deepEqual(parseCanonicalJson(q.canonicalJson), q.signed.body);
    assert.equal(hex(quoteCanonicalBytes(q.signed.body)), q.canonicalUtf8Hex);
    assert.equal(hex(quotePreimage(q.signed.body)), q.preimageHex);
    assert.equal(hex(quoteDigest(q.signed.body)), q.digestHex);
    assert.equal(deriveEscrowId(q.signed.body), q.signed.quoteId);
    assert.ok(verifySignedQuote(q.signed));
    assert.deepEqual(requireValidSignedQuote(q.signed), q.signed);
    assert.deepEqual(validateQuoteForFunding(q.signed, q.context), q.signed);
    const framed = Buffer.from(q.preimageHex, "hex");
    const domain = Buffer.from("hive-metered/v2/quote\0");
    assert.deepEqual(framed.subarray(0, domain.length), domain);
    assert.equal(framed.readUInt32BE(domain.length), q.canonicalUtf8Hex.length / 2);
  }
  assert.notEqual(vectors.quotes[0]!.signed.quoteId, vectors.quotes[1]!.signed.quoteId);
});

test("receipts reproduce amount encoding, preimage, digest and signature", () => {
  for (const r of vectors.receipts) {
    assert.equal(hex(encodeReceiptAmount(r.receipt.amountSats)), r.amount8Hex);
    assert.equal(hex(receiptPreimage(r.receipt.escrowId, r.receipt.amountSats)), r.preimageHex);
    assert.equal(hex(receiptDigest(r.receipt.escrowId, r.receipt.amountSats)), r.digestHex);
    assert.ok(verifyReceipt(r.receipt, r.context));
    assert.deepEqual(requireValidReceipt(r.receipt, r.context), r.receipt);
  }
});

test("all 79 negative vectors are rejected", () => {
  for (const n of vectors.negatives) {
    switch (n.check) {
      case "canonicalParse":
        assert.throws(() => parseCanonicalJson(n.text), Error, n.label);
        break;
      case "quote":
        assert.equal(verifySignedQuote(n.signed), false, n.label);
        assert.throws(() => requireValidSignedQuote(n.signed), Error, n.label);
        break;
      case "quoteFunding":
        assert.throws(() => validateQuoteForFunding(n.signed, n.context), Error, n.label);
        break;
      case "receipt":
        assert.equal(verifyReceipt(n.receipt, n.context), false, n.label);
        break;
      case "receiptAmount":
        assert.throws(() => encodeReceiptAmount(n.amount as string), Error, n.label);
        break;
      case "receiptId":
        assert.throws(() => receiptDigest(n.escrowId, "1"), Error, n.label);
        break;
    }
  }
});

test("cost cases round the combined price up once and refuse overcap", () => {
  const body = vectors.quotes[0]!.signed.body;
  for (const c of vectors.costs) {
    if (c.valid)
      assert.equal(quoteCostSats(body, c.inputTokens, c.outputTokens).toString(), c.expectedSats, c.label);
    else assert.throws(() => quoteCostSats(body, c.inputTokens, c.outputTokens), Error, c.label);
  }
});

test("canonical JSON refuses values JSON cannot carry exactly", () => {
  for (const bad of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1,
    1n,
    { a: undefined },
    { a: 1 },
    { a: new Date(0) },
    [undefined],
  ]) {
    assert.throws(() => canonicalJson(bad));
  }
});
