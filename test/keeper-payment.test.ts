import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type TestContext, test } from "node:test";
import { jobEscrow, sendMessages } from "@hive/ark";
import { planTreasurySend } from "@hive/hive";
import { faultCode, hex, unhex } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import { loadSteward } from "../packages/steward/src/config.js";
import {
  assignShared,
  newSession,
  nonceBatch,
  record,
  signOver,
  signShared,
} from "../packages/steward/src/keeper.js";
import {
  checkPayment,
  checkPurpose,
  KEEPER_MAX_VALIDITY_SECONDS,
  keeperView,
  type PaymentApproval,
} from "../packages/steward/src/policy.js";
import type { FundingRequest, SessionRequest } from "../packages/steward/src/purpose.js";
import { hiveFixture } from "./support/hive-v4.js";

const now = () => Math.floor(Date.now() / 1000);
const hasCode = (code: string) => (error: unknown) => faultCode(error) === code;
const hours = (n: number) => n * 3600;
const xonly = () => hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));

/**
 * A treasury with coins, and a job its agent asks the keepers to fund: a pay-arkade escrow built from
 * the job's terms, returning to this treasury, with a deadline that leaves room for a day-long signature.
 */
async function paymentFixture(
  t: TestContext,
  options: { renewalWindowSeconds?: number; deadlineHours?: number; minCoinExpiry?: number } = {},
) {
  const hive = await hiveFixture(t, { renewalWindowSeconds: options.renewalWindowSeconds });
  hive.fake.mint(hive.account.pkScript, 30_000);
  const job = (overrides: Partial<FundingRequest["params"]> = {}): FundingRequest => {
    const params = {
      agentPk: xonly(),
      providerPk: xonly(),
      treasuryProgram: hive.account.pkScript.slice(4),
      deadline: now() + hours(options.deadlineHours ?? 40),
      jobId: hex(randomBytes(32)),
      ...overrides,
    };
    return {
      jobId: params.jobId,
      address: jobEscrow(hive.conn, params).address,
      capSats: 20_000,
      deadline: params.deadline,
      model: "qwen3-8b",
      priceMsatPerMtok: 2_000_000,
      providerPk: params.providerPk,
      params,
      ...(options.minCoinExpiry !== undefined ? { minCoinExpiry: options.minCoinExpiry } : {}),
    };
  };
  const request = job();
  const view = keeperView(hive.stewardKeys, hive.treasury.terms);
  const approval: PaymentApproval = { request, remainingSats: 50_000 };
  const plan = (validSeconds: number, to = request) =>
    planTreasurySend(hive.treasury, {
      pair: "01",
      amount: to.capSats,
      destination: jobEscrow(hive.conn, to.params).pkScript,
      validSeconds,
    });
  const session = (
    stage: { stage: "attest" } | { stage: "register"; signatures: string[] },
    sendPlan: Awaited<ReturnType<typeof plan>>,
    to = request,
  ): SessionRequest => ({
    id: hex(randomBytes(32)),
    pair: "01",
    purpose: { kind: "payment", request: to, plan: sendPlan, ...stage } as SessionRequest["purpose"],
  });
  return { hive, request, job, view, approval, plan, session };
}

test("two keepers fund a job hours apart, each checking the escrow returns to their treasury", async (t) => {
  const { hive, view, approval, plan, session } = await paymentFixture(t);
  const sendPlan = await plan(hours(20));
  const keys = hive.stewardKeys;
  const [first, second] = [hive.stewardSecrets[0]!, hive.stewardSecrets[1]!];

  // Attest: the first keeper signs over the second's shared nonces; the second completes it later.
  const attestRequest = session({ stage: "attest" }, sendPlan);
  const checked = await checkPayment(view, hive.conn, attestRequest, approval, now());
  assert.deepEqual(
    checked.messages.map(hex),
    sendMessages(sendPlan, hive.account.instance, hive.conn.operator.checkpointTapscript).map(hex),
  );
  assert.equal(checked.until, sendPlan.validUntil);
  assert.equal(checked.binds?.key, `job:${approval.request.jobId}`);
  const secondNonces = nonceBatch(second, 8);
  const attest = newSession(keys, "01", checked.messages);
  assignShared(attest, keys[1], (n) => secondNonces.batch.nonces.slice(0, n));
  record(attest, keys, keys[0], signOver(attest, first, checked.messages));
  const later = await checkPayment(view, hive.conn, attestRequest, approval, now());
  record(attest, keys, keys[1], {
    partials: signShared(attest, second, later.messages, secondNonces.secrets),
  });
  assert.equal(attest.signatures?.length, sendPlan.coins.length);

  // Register: the second keeper, still there, signs over the first's nonces; the first comes back once.
  const registerRequest = session({ stage: "register", signatures: attest.signatures! }, sendPlan);
  const reg = await checkPayment(view, hive.conn, registerRequest, approval, now());
  assert.equal(reg.messages.length, 1);
  const firstNonces = nonceBatch(first, 8);
  const register = newSession(keys, "01", reg.messages);
  assignShared(register, keys[0], (n) => firstNonces.batch.nonces.slice(0, n));
  record(register, keys, keys[1], signOver(register, second, reg.messages));
  record(register, keys, keys[0], {
    partials: signShared(register, first, reg.messages, firstNonces.secrets),
  });
  assert.ok(schnorr.verify(unhex(register.signatures![0]!), reg.messages[0]!, unhex(view.pairs["01"])));
});

test("a steward service refuses a keeper payment: nobody there confirmed it", async (t) => {
  const { hive, plan, session } = await paymentFixture(t);
  const request = session({ stage: "attest" }, await plan(600));
  await assert.rejects(
    checkPurpose(loadSteward(hive.configPaths[0]!), hive.conn, request, now()),
    hasCode("KEEPER_ONLY"),
  );
});

test("a payment is refused when the escrow is not the one its terms build, or returns elsewhere", async (t) => {
  const { hive, request, job, view, approval, plan, session } = await paymentFixture(t);
  const check = async (to: FundingRequest) => {
    const sendPlan = await plan(
      600,
      to.params.treasuryProgram === request.params.treasuryProgram ? to : request,
    );
    return checkPayment(
      view,
      hive.conn,
      session({ stage: "attest" }, sendPlan, to),
      { ...approval, request: to },
      now(),
    );
  };
  // An address someone swapped in, though the terms are fine.
  await assert.rejects(check({ ...request, address: job().address }), hasCode("ESCROW_MISMATCH"));
  // A provider named in the request that the escrow does not pay.
  await assert.rejects(check({ ...request, providerPk: xonly() }), hasCode("ESCROW_MISMATCH"));
  // An escrow whose unclaimed funds go to another treasury.
  await assert.rejects(check(job({ treasuryProgram: xonly() })), hasCode("NOT_OUR_TREASURY"));
});

test("a payment is refused above the remaining budget, on a request the keeper did not see, or late", async (t) => {
  const { hive, request, view, approval, plan, session } = await paymentFixture(t);
  const attest = session({ stage: "attest" }, await plan(600));
  await assert.rejects(
    checkPayment(view, hive.conn, attest, { ...approval, remainingSats: 19_999 }, now()),
    hasCode("ABOVE_BUDGET"),
  );
  await assert.rejects(
    checkPayment(view, hive.conn, attest, { ...approval, request: { ...request, model: "other" } }, now()),
    hasCode("UNAPPROVED_PAYMENT"),
  );
  await assert.rejects(
    checkPayment(view, hive.conn, attest, approval, request.deadline + 1),
    hasCode("PAYMENT_LATE"),
  );
  // Dust someone sent to the escrow's public address does not stop the payment.
  hive.fake.mint(jobEscrow(hive.conn, request.params).pkScript, 330);
  await checkPayment(view, hive.conn, attest, approval, now());
  // Once the escrow holds the cap, the job is funded and nobody signs again.
  const funding = hive.fake.mint(jobEscrow(hive.conn, request.params).pkScript, 20_000);
  await assert.rejects(checkPayment(view, hive.conn, attest, approval, now()), hasCode("ESCROW_FUNDED"));
  // Nor once that funding has been claimed or returned: a job is funded once, not once at a time.
  funding.isSpent = true;
  await assert.rejects(checkPayment(view, hive.conn, attest, approval, now()), hasCode("ESCROW_FUNDED"));
});

test("a payment lives 23 hours at most and ends before the job's deadline; an allocation still half an hour", async (t) => {
  const { hive, view, approval, plan, session } = await paymentFixture(t, { deadlineHours: 60 });
  const tooLong = session({ stage: "attest" }, await plan(KEEPER_MAX_VALIDITY_SECONDS + 600));
  await assert.rejects(checkPayment(view, hive.conn, tooLong, approval, now()), hasCode("PLAN_INVALID"));
  const short = await paymentFixture(t, { deadlineHours: 1 });
  const pastDeadline = short.session({ stage: "attest" }, await short.plan(hours(2)));
  await assert.rejects(
    checkPayment(short.view, short.hive.conn, pastDeadline, short.approval, now()),
    hasCode("PLAN_INVALID"),
  );
  const { quote, escrow } = await hive.quote();
  const allocation: SessionRequest = {
    id: hex(randomBytes(32)),
    pair: "01",
    purpose: {
      kind: "allocation",
      stage: "attest",
      quote,
      plan: await planTreasurySend(hive.treasury, {
        pair: "01",
        amount: 20_000,
        destination: (await hive.escrow(escrow)).pkScript,
        validSeconds: hours(2),
      }),
    },
  };
  await assert.rejects(
    checkPurpose(loadSteward(hive.configPaths[0]!), hive.conn, allocation, now()),
    hasCode("PLAN_INVALID"),
  );
});

test("a long-lived payment refuses coins that would need renewing, or that die before the job needs", async (t) => {
  const renewing = await paymentFixture(t, { renewalWindowSeconds: hours(30) });
  // Coins last two days: signed within the hour, renewal is no concern; held for 20 hours, it is.
  await checkPayment(
    renewing.view,
    renewing.hive.conn,
    renewing.session({ stage: "attest" }, await renewing.plan(1800)),
    renewing.approval,
    now(),
  );
  await assert.rejects(
    checkPayment(
      renewing.view,
      renewing.hive.conn,
      renewing.session({ stage: "attest" }, await renewing.plan(hours(20))),
      renewing.approval,
      now(),
    ),
    hasCode("COIN_EXPIRES_TOO_SOON"),
  );
  // With no renewal service for the escrow, the provider names how long the funding coin must last.
  const unrenewed = await paymentFixture(t, { minCoinExpiry: now() + hours(72) });
  await assert.rejects(
    checkPayment(
      unrenewed.view,
      unrenewed.hive.conn,
      unrenewed.session({ stage: "attest" }, await unrenewed.plan(1800)),
      unrenewed.approval,
      now(),
    ),
    hasCode("COIN_EXPIRES_TOO_SOON"),
  );
});
