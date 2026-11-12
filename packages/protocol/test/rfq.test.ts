import assert from "node:assert/strict";
import { test } from "node:test";
import { isFault } from "@hive/kit";
import { makeQuote, newSecret, xOnly } from "../../../test/support/quotes.js";
import {
  CARD_PROFILE,
  canonicalJson,
  matchQuote,
  type ProviderCardBody,
  parseQuoteWire,
  parseRequestWire,
  quoteWire,
  requestWire,
  signProviderCard,
  signQuote,
  validateProviderCard,
  validateRequestAgainstCard,
} from "../src/index.js";

const fixture = makeQuote();
const now = BigInt(Math.floor(Date.now() / 1000));
const cardBody: ProviderCardBody = {
  profile: CARD_PROFILE,
  network: "regtest",
  model: fixture.body.model,
  providerRfqKey: fixture.body.providerRfqKey,
  providerWorkloadKey: fixture.body.providerWorkloadKey,
  providerPayoutScript: fixture.body.providerPayoutScript,
  inputRateMsatPerMillionTokens: fixture.body.inputRateMsatPerMillionTokens,
  outputRateMsatPerMillionTokens: fixture.body.outputRateMsatPerMillionTokens,
  maxCapSats: "20000",
  maxDurationSeconds: "7200",
  expiresAt: String(now + 86400n),
  relays: ["ws://127.0.0.1:7777/"],
};
const code = (expected: string) => (error: unknown) => isFault(error, expected);

test("a signed card validates and expires", () => {
  const card = signProviderCard(cardBody, fixture.secrets.rfq);
  assert.deepEqual(validateProviderCard(card, String(now)), card);
  assert.throws(() => validateProviderCard(card, cardBody.expiresAt), code("CARD_EXPIRED"));
  assert.throws(() => signProviderCard(cardBody, newSecret()), code("CARD_SIGNER"));
  const forged = {
    ...card,
    signature: signProviderCard({ ...cardBody, maxCapSats: "1" }, fixture.secrets.rfq).signature,
  };
  assert.throws(() => validateProviderCard(forged), code("CARD_SIGNATURE"));
});

test("card relays follow network transport rules", () => {
  for (const relays of [["wss://relay.example/"], ["ws://relay.example/"], ["ws://127.0.0.1:7777"], []]) {
    assert.throws(
      () => signProviderCard({ ...cardBody, relays }, fixture.secrets.rfq),
      Error,
      String(relays),
    );
  }
  const mutinynet = { ...cardBody, network: "mutinynet" as const, relays: ["wss://relay.example/"] };
  assert.ok(signProviderCard(mutinynet, fixture.secrets.rfq));
});

test("requests must copy the card terms and fit its limits", () => {
  const card = signProviderCard(cardBody, fixture.secrets.rfq);
  validateRequestAgainstCard(fixture.request, card, String(now));
  assert.throws(
    () => validateRequestAgainstCard({ ...fixture.request, capSats: "20001" }, card, String(now)),
    Error,
  );
  const otherPayout = { ...fixture.request, providerPayoutScript: `5120${xOnly(newSecret())}` };
  assert.throws(
    () => validateRequestAgainstCard(otherPayout, card, String(now)),
    code("REQUEST_CARD_MISMATCH"),
  );
  const long = { ...fixture.request, timeoutAt: String(now + 7201n) };
  assert.throws(() => validateRequestAgainstCard(long, card, String(now)), code("REQUEST_DURATION"));
});

test("the RFQ wire carries exact canonical text both ways", () => {
  const wire = requestWire(fixture.request);
  assert.deepEqual(parseRequestWire(JSON.parse(JSON.stringify(wire))), fixture.request);
  const reply = quoteWire(fixture.quote);
  assert.equal(reply.quote, canonicalJson(fixture.quote));
  assert.deepEqual(parseQuoteWire(reply, fixture.request), fixture.quote);
});

test("a quote that changes any requested term is refused", () => {
  const changed = signQuote({ ...fixture.body, capSats: "19999" }, fixture.secrets.rfq);
  assert.throws(() => matchQuote(changed, fixture.request), code("QUOTE_TERMS_CHANGED"));
  assert.throws(() => parseQuoteWire(quoteWire(changed), fixture.request), code("QUOTE_TERMS_CHANGED"));
});
