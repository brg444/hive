import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { type ClaimPlan, claimMessage, claimSpend } from "@hive/ark";
import { type Action, buildSpend } from "@hive/executor";
import { faultCode, hex, localPath, readJsonIfPresent } from "@hive/kit";
import { executeRefund, refundEscrow, registerClaim } from "@hive/hive";
import { signReceipt } from "@hive/protocol";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hiveFixture } from "../support/hive-v4.js";

interface SavedExecution {
  action: Action;
  execution: {
    action: Action;
    attempts: {
      sequence: number;
      route: string;
      response?: { result: string };
    }[];
  };
  registration?: { request: unknown };
  record?: { request: unknown };
}

function directoryFor(t: TestContext): string {
  const directory = localPath("v4-routing-journal-test", randomUUID());
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Observe the durable record at the HTTP boundary, then lose a completed response. */
function loseResponse(t: TestContext, url: string, path: string) {
  const original = globalThis.fetch;
  const observed: { saved: SavedExecution | undefined; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== url || init?.method !== "POST") return original(input, init);
    observed.push({
      saved: readJsonIfPresent<SavedExecution>(path),
      body: JSON.parse(String(init.body)),
    });
    const response = await original(input, init);
    await response.arrayBuffer();
    throw new TypeError("injected response loss after execution");
  });
  return observed;
}

function assertPrepared(
  observed: { saved: SavedExecution | undefined; body: unknown }[],
  expected: { route: "self" | "delegatee"; outpoint: string },
): SavedExecution {
  assert.equal(observed.length, 1, "one actual network submission");
  const saved = observed[0]!.saved;
  assert.ok(saved, "the fixed action exists on disk before the actual network POST");
  assert.equal(saved.action.txid, saved.execution.action.txid);
  assert.deepEqual(saved.action, saved.execution.action);
  const input = saved.action.spend!.inputs[0]!;
  assert.equal(`${input.txid}:${input.vout}`, expected.outpoint);
  const prepared = saved.execution.attempts.at(-1);
  assert.equal(prepared?.route, expected.route);
  assert.equal(prepared?.response, undefined, "the response is attached only after posting");
  return saved;
}

async function claimFixture(t: TestContext) {
  const hive = await hiveFixture(t);
  const { quote, escrow: terms, secrets } = await hive.quote();
  const escrow = await hive.escrow(terms);
  const coin = hive.fake.mint(escrow.pkScript, Number(quote.body.capSats));
  const receipt = signReceipt({ escrowId: quote.quoteId, amountSats: "7000" }, secrets.payer);
  const claimSignature = hex(schnorr.sign(claimMessage(quote.quoteId, 7000), secrets.workload));
  const plan: ClaimPlan = {
    escrow: terms,
    coin: { txid: coin.txid, vout: coin.vout, amount: coin.amount, script: coin.script },
    amount: 7000,
    receiptSig: receipt.signature,
    claimSig: claimSignature,
    templateId: "",
    expiresAt: terms.timeoutAt,
  };
  const spend = claimSpend(plan, escrow.instance);
  const expectedSpend = {
    txid: buildSpend(spend, hive.conn.operator.checkpointTapscript).txid,
    outpoint: `${coin.txid}:${coin.vout}`,
  };
  return { hive, quote, escrow, coin, receipt, claimSignature, expectedSpend };
}

async function refundFixture(t: TestContext) {
  const hive = await hiveFixture(t);
  const now = Math.floor(Date.now() / 1000);
  const { quote, escrow: terms } = await hive.quote({
    timeoutAt: String(now - 5),
    quoteExpiresAt: String(now - 60),
  });
  const escrow = await hive.escrow(terms);
  const coin = hive.fake.mint(escrow.pkScript, Number(quote.body.capSats));
  return { hive, quote, escrow, coin };
}

test("claim registration is durable before POST and resumes a lost response with the same action", async (t) => {
  const { hive, quote, escrow, coin, receipt, claimSignature, expectedSpend } = await claimFixture(t);
  const path = resolve(directoryFor(t), "claim-registration.json");
  const observed = loseResponse(t, `${hive.fake.delegateeUrl}/v1/spend`, path);
  const options = {
    escrowArtifactId: escrow.artifactId,
    pair: "12" as const,
    journalPath: path,
    timeoutMs: 500,
  } as Parameters<typeof registerClaim>[2];
  const request = { quote, receipt, claimSignature, expectedSpend };
  const run = () => registerClaim(hive.treasury, request, options);
  const first = await run().catch(() => undefined);
  const before = assertPrepared(observed, { route: "delegatee", outpoint: expectedSpend.outpoint });
  assert.deepEqual(before.record?.request, observed[0]!.body);
  assert.equal(before.action.txid, expectedSpend.txid);
  assert.ok(first, "the lost reply reconciles against the actual payment");
  // Historical expiry metadata is unnecessary for an already observed spend.
  coin.expiresAt = 0;
  assert.deepEqual(await run(), first);
  assert.equal(observed.length, 1);
  assert.equal(hive.fake.balance(quote.body.providerPayoutScript), 7000);
});

test("a self refund is durable before POST and reconciles its lost response on resume", async (t) => {
  const { hive, quote, coin } = await refundFixture(t);
  const path = resolve(directoryFor(t), "refund.json");
  const observed = loseResponse(t, `${hive.fake.emulatorUrl}/v1/tx`, path);
  const options = { journalPath: path, timeoutMs: 500 } as Parameters<typeof executeRefund>[2];
  const run = () => executeRefund(hive.treasury, quote, options);
  const first = await run().catch(() => undefined);
  const before = assertPrepared(observed, { route: "self", outpoint: `${coin.txid}:${coin.vout}` });
  assert.equal(first?.txid, before.action.txid);
  coin.expiresAt = 0;
  const resumed = await run();
  assert.equal(resumed?.txid, before.action.txid);
  assert.equal(observed.length, 1);
  assert.equal(hive.fake.balance(hive.account.pkScript), Number(quote.body.capSats));
});

test("a pair refund shares the self journal and resumes registration after a lost reply", async (t) => {
  const { hive, quote, escrow, coin } = await refundFixture(t);
  const path = resolve(directoryFor(t), "refund.json");
  hive.fake.emulatorUnavailable = true;
  await executeRefund(hive.treasury, quote, { journalPath: path, timeoutMs: 100 } as Parameters<
    typeof executeRefund
  >[2]);
  const observed = loseResponse(t, `${hive.fake.delegateeUrl}/v1/spend`, path);
  const options = {
    escrowArtifactId: escrow.artifactId,
    journalPath: path,
    timeoutMs: 500,
  } as Parameters<typeof refundEscrow>[2];
  const run = () => refundEscrow(hive.treasury, quote, options);
  const first = await run().catch(() => undefined);
  const before = assertPrepared(observed, { route: "delegatee", outpoint: `${coin.txid}:${coin.vout}` });
  assert.equal(before.execution.attempts[0]?.route, "self");
  assert.equal(before.execution.attempts[0]?.response?.result, "unavailable");
  assert.equal(before.action.request, undefined, "pair authorization does not replace the shared Action");
  assert.deepEqual(before.registration?.request, observed[0]!.body);
  assert.ok(first);
  coin.expiresAt = 0;
  assert.deepEqual(await run(), first);
  assert.equal(observed.length, 1);
  assert.equal(hive.fake.balance(hive.account.pkScript), Number(quote.body.capSats));
});

test("the claim desk refuses a different expected transaction or cap input before posting", async (t) => {
  for (const change of ["txid", "input"] as const) {
    const { hive, quote, escrow, coin, receipt, claimSignature, expectedSpend } = await claimFixture(t);
    const other = hive.fake.mint(escrow.pkScript, Number(quote.body.capSats));
    const mismatched =
      change === "txid"
        ? { ...expectedSpend, txid: "ff".repeat(32) }
        : { ...expectedSpend, outpoint: `${other.txid}:${other.vout}` };
    const path = resolve(directoryFor(t), `claim-${change}.json`);
    await assert.rejects(
      registerClaim(
        hive.treasury,
        { quote, receipt, claimSignature, expectedSpend: mismatched } as Parameters<typeof registerClaim>[1],
        { escrowArtifactId: escrow.artifactId, journalPath: path, timeoutMs: 500 } as Parameters<
          typeof registerClaim
        >[2],
      ),
      (error: unknown) => faultCode(error) === "CLAIM_ACTION_MISMATCH",
    );
    assert.equal(hive.fake.balance(quote.body.providerPayoutScript), 0);
    assert.equal(coin.isSpent, false);
    assert.equal(other.isSpent, false);
  }
});
