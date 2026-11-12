import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { faultCode, hex, localPath } from "@hive/kit";
import { nostrTransport, requestQuote } from "@hive/hive";
import {
  CARD_PROFILE,
  type ComputeQuoteRequest,
  matchQuote,
  signProviderCard,
  verifySignedQuote,
} from "@hive/protocol";
import { QuoteDesk, startNostrSolver } from "@hive/provider";
import { startLocalRelay } from "../../gates/support/relay.js";
import { makeQuote, newSecret, xOnly } from "../support/quotes.js";

const isCode = (code: string) => (error: unknown) => faultCode(error) === code;

function market(relay = "ws://127.0.0.1:7777/") {
  const fixture = makeQuote();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const card = signProviderCard(
    {
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
      expiresAt: String(now + 86_400n),
      relays: [relay],
    },
    fixture.secrets.rfq,
  );
  const run = randomBytes(6).toString("hex");
  const request = (overrides: Partial<ComputeQuoteRequest> = {}): ComputeQuoteRequest => ({
    ...fixture.request,
    requestId: hex(randomBytes(32)),
    ...overrides,
  });
  return { fixture, card, run, request, rfq: fixture.secrets.rfq };
}

describe("quote desk", () => {
  test("a request is quoted once; a replay returns the same quote and a changed one is refused", async () => {
    const { card, run, request, rfq } = market();
    const desk = new QuoteDesk({ secretKey: rfq, card, stateDirectory: localPath("test-runs", run, "desk") });
    const asked = request();
    const quote = await desk.answer(asked, xOnly(newSecret()));
    assert.ok(verifySignedQuote(quote));
    matchQuote(quote, asked);
    assert.deepEqual(await desk.answer(asked, xOnly(newSecret())), quote);
    await assert.rejects(
      desk.answer({ ...asked, capSats: "10000" }, "aa".repeat(32)),
      isCode("REQUEST_ID_REUSED"),
    );
  });

  test("open quotes are bounded per payer key and per transport identity (review R12)", async () => {
    const { card, run, request, rfq } = market();
    const desk = new QuoteDesk({
      secretKey: rfq,
      card,
      stateDirectory: localPath("test-runs", run, "desk"),
      maxOpenRequestsPerRequester: 2,
    });
    const requester = xOnly(newSecret());
    await desk.answer(request(), requester);
    await desk.answer(request(), requester);
    await assert.rejects(desk.answer(request(), requester), isCode("REQUESTER_LIMIT"));
    // A rotated transport key does not escape the payer-key bound.
    await assert.rejects(desk.answer(request(), xOnly(newSecret())), isCode("REQUESTER_LIMIT"));
    await desk.answer(request({ payerReceiptKey: xOnly(newSecret()) }), xOnly(newSecret()));
    const records = readdirSync(localPath("test-runs", run, "desk")).filter((name) => name.endsWith(".json"));
    assert.equal(records.length, 3);
  });

  test("a request outside the card is refused", async () => {
    const { card, run, request, rfq } = market();
    const desk = new QuoteDesk({ secretKey: rfq, card, stateDirectory: localPath("test-runs", run, "desk") });
    await assert.rejects(
      desk.answer(request({ capSats: "30000" }), "aa".repeat(32)),
      isCode("REQUEST_EXCEEDS_CAP"),
    );
    await assert.rejects(
      desk.answer(request({ model: "other-model" }), "aa".repeat(32)),
      isCode("REQUEST_CARD_MISMATCH"),
    );
  });
});

test("the hive and the provider negotiate over a local Nostr relay", async () => {
  const relay = await startLocalRelay();
  const { card, run, request, rfq } = market(relay.url);
  const desk = new QuoteDesk({ secretKey: rfq, card, stateDirectory: localPath("test-runs", run, "solver") });
  const solver = await startNostrSolver(desk, rfq);
  try {
    const asked = request();
    const directory = localPath("test-runs", run, "hive-rfq");
    const quote = await requestQuote(asked, card, directory, { transport: nostrTransport(5000) });
    matchQuote(quote, asked);
    // The saved quote answers a replay without the relay.
    await relay.close();
    assert.deepEqual(await requestQuote(asked, card, directory), quote);
  } finally {
    await solver.close();
    await relay.close().catch(() => {});
  }
  assert.ok(relay.stats.ephemeral >= 2 && relay.stats.advertisements === 1);
});
