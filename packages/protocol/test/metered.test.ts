import assert from "node:assert/strict";
import { test } from "node:test";
import { isFault } from "@hive/kit";
import { makeQuote } from "../../../test/support/quotes.js";
import {
  METERED_PROFILE,
  type MeteredChallengeBody,
  type MeteredContext,
  makeMeteredChallenge,
  quoteCostSats,
  receiptSha256,
  signReceipt,
  validateMeteredChallenge,
} from "../src/index.js";

const fixture = makeQuote({ capSats: "20000" });
const { quote, secrets } = fixture;
const id = "11".repeat(32);
const limits = { maxInputTokens: "200", maxOutputTokens: "32", maxRequestSats: "20000" };
const context: MeteredContext = {
  requestId: id,
  requestSha256: "22".repeat(32),
  previousReceipt: null,
  sequence: "0",
  cumulativeInputTokens: "0",
  cumulativeOutputTokens: "0",
  requestLimits: limits,
};
const code = (expected: string) => (error: unknown) => isFault(error, expected);

function body(
  input: bigint,
  output: bigint,
  overrides: Partial<MeteredChallengeBody> = {},
): MeteredChallengeBody {
  return {
    profile: METERED_PROFILE,
    escrowId: quote.quoteId,
    requestId: id,
    requestSha256: context.requestSha256,
    responseSha256: "33".repeat(32),
    contentType: "application/json",
    inputTokens: String(input),
    outputTokens: String(output),
    totalTokens: String(input + output),
    cumulativeInputTokens: String(input),
    cumulativeOutputTokens: String(output),
    amountSats: quoteCostSats(quote.body, input, output).toString(),
    sequence: "1",
    previousReceiptSha256: receiptSha256(null),
    ...overrides,
  };
}

test("a plausible, signed challenge is accepted", () => {
  const challenge = makeMeteredChallenge(body(40n, 10n), secrets.workload);
  assert.deepEqual(validateMeteredChallenge(challenge, quote, context), challenge);
});

test("usage beyond the request's own bounds is refused (review R1)", () => {
  const inflated = makeMeteredChallenge(body(1000n, 1000n), secrets.workload);
  assert.throws(() => validateMeteredChallenge(inflated, quote, context), code("CHALLENGE_TOKEN_LIMIT"));
  const pricey = makeMeteredChallenge(body(100n, 10n), secrets.workload);
  assert.throws(
    () =>
      validateMeteredChallenge(pricey, quote, {
        ...context,
        requestLimits: { ...limits, maxRequestSats: "100" },
      }),
    code("CHALLENGE_SPEND_CEILING"),
  );
});

test("a challenge signed by any key but the workload key is refused", () => {
  const forged = makeMeteredChallenge(body(40n, 10n), secrets.rfq);
  assert.throws(() => validateMeteredChallenge(forged, quote, context), code("CHALLENGE_SIGNATURE"));
});

test("changed fields break the digest, price or sequence", () => {
  const good = makeMeteredChallenge(body(40n, 10n), secrets.workload);
  assert.throws(
    () => validateMeteredChallenge({ ...good, responseSha256: "44".repeat(32) }, quote, context),
    code("CHALLENGE_DIGEST"),
  );
  const cheap = makeMeteredChallenge(body(40n, 10n, { amountSats: "1" }), secrets.workload);
  assert.throws(() => validateMeteredChallenge(cheap, quote, context), code("CHALLENGE_PRICE"));
  const skipped = makeMeteredChallenge(body(40n, 10n, { sequence: "2" }), secrets.workload);
  assert.throws(() => validateMeteredChallenge(skipped, quote, context), code("CHALLENGE_SEQUENCE"));
  assert.throws(
    () => validateMeteredChallenge(good, quote, { ...context, nowSeconds: quote.body.timeoutAt }),
    code("ESCROW_DEADLINE_PASSED"),
  );
});

test("the second challenge must chain from the committed receipt", () => {
  const first = makeMeteredChallenge(body(40n, 10n), secrets.workload);
  const receipt = signReceipt({ escrowId: quote.quoteId, amountSats: first.amountSats }, secrets.payer);
  const next: MeteredContext = {
    ...context,
    requestId: "55".repeat(32),
    previousReceipt: receipt,
    sequence: "1",
    cumulativeInputTokens: "40",
    cumulativeOutputTokens: "10",
  };
  const second = makeMeteredChallenge(
    body(20n, 5n, {
      requestId: next.requestId,
      cumulativeInputTokens: "60",
      cumulativeOutputTokens: "15",
      amountSats: quoteCostSats(quote.body, 60n, 15n).toString(),
      sequence: "2",
      previousReceiptSha256: receiptSha256(receipt),
    }),
    secrets.workload,
  );
  assert.equal(validateMeteredChallenge(second, quote, next).amountSats, "750");
  assert.throws(
    () => validateMeteredChallenge(second, quote, { ...next, previousReceipt: null }),
    code("CHALLENGE_PREVIOUS_RECEIPT"),
  );
});
