import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { faultCode, hex, localPath, secretPath } from "@hive/kit";
import { METERED_PROFILE, receiptSha256 } from "@hive/protocol";
import {
  approveProviderRequest,
  ChallengeClient,
  type ChallengeRequest,
  writeProviderConfig,
} from "@hive/provider";
import { makeQuote } from "../../../test/support/quotes.js";
import { localUpstream, parseLimits } from "../src/sidecar/upstream.js";

const isCode = (code: string) => (error: unknown) => faultCode(error) === code;

test("inference stays on loopback", () => {
  assert.equal(localUpstream("http://127.0.0.1:9337/v1").href, "http://127.0.0.1:9337/v1/");
  for (const url of [
    "https://127.0.0.1/v1",
    "http://example.com/v1",
    "http://user:pw@127.0.0.1/v1",
    "http://127.0.0.1/v1?x=1",
  ]) {
    assert.throws(() => localUpstream(url), isCode("LOCAL_UPSTREAM_REQUIRED"));
  }
});

test("sidecar limits are complete and bounded", () => {
  const limits = {
    maxRequestBytes: 65_536,
    maxResponseBytes: 1_048_576,
    maxOutputTokens: 64,
    requestTimeoutMs: 30_000,
    deadlineGuardSeconds: 60,
  };
  assert.deepEqual(parseLimits(limits), limits);
  assert.throws(() => parseLimits({ ...limits, maxOutputTokens: 70_000 }), isCode("INVALID_LIMIT"));
  assert.throws(() => parseLimits({ ...limits, requestTimeoutMs: 0 }), isCode("INVALID_LIMIT"));
  const { deadlineGuardSeconds: _guard, ...missing } = limits;
  assert.throws(() => parseLimits(missing as typeof limits), isCode("INVALID_LIMIT"));
});

test("the challenge worker signs each request and sequence once, and answers with codes", async () => {
  const run = randomBytes(6).toString("hex");
  const fixture = makeQuote();
  const path = secretPath("test-runs", run, "provider.json");
  writeProviderConfig(path, {
    schema: "hive-provider/v4",
    workloadSecret: hex(fixture.secrets.workload),
    stateDirectory: localPath("test-runs", run, "provider"),
    deployment: { network: "regtest", arkdUrl: "http://127.0.0.1:9", delegateeUrl: "http://127.0.0.1:9" },
    approvedRequests: [],
  });
  const client = new ChallengeClient(path);
  const requestId = "11".repeat(32);
  const request = (sequenceInput: string, responseSha256 = "22".repeat(32)): ChallengeRequest => ({
    kind: "sign-metered-challenge",
    quote: fixture.quote,
    body: {
      profile: METERED_PROFILE,
      escrowId: fixture.quote.quoteId,
      requestId,
      requestSha256: "33".repeat(32),
      responseSha256,
      contentType: "application/json",
      inputTokens: sequenceInput,
      outputTokens: "5",
      totalTokens: String(Number(sequenceInput) + 5),
      cumulativeInputTokens: sequenceInput,
      cumulativeOutputTokens: "5",
      amountSats: String((Number(sequenceInput) + 5) * 10),
      sequence: "1",
      previousReceiptSha256: receiptSha256(null),
    },
    context: {
      requestId,
      requestSha256: "33".repeat(32),
      previousReceipt: null,
      sequence: "0",
      cumulativeInputTokens: "0",
      cumulativeOutputTokens: "0",
      requestLimits: { maxInputTokens: "200", maxOutputTokens: "32", maxRequestSats: "5000" },
    },
  });
  await assert.rejects(client.signChallenge(request("21")), isCode("UNAPPROVED_REQUEST"));
  await approveProviderRequest(path, fixture.terms);
  const signed = await client.signChallenge(request("21"));
  assert.equal(signed.amountSats, "260");
  assert.deepEqual(
    await client.signChallenge(request("21")),
    signed,
    "an identical request returns the saved challenge",
  );
  await assert.rejects(
    client.signChallenge(request("21", "44".repeat(32))),
    isCode("CHALLENGE_ALREADY_SIGNED"),
  );
});
