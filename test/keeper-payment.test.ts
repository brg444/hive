import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type TestContext, test } from "node:test";
import { sendMessages } from "@hive/ark";
import { planTreasurySend } from "@hive/hive";
import { faultCode, hex } from "@hive/kit";
import { quoteTerms } from "@hive/protocol";
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
import type { SessionRequest } from "../packages/steward/src/purpose.js";
import { hiveFixture } from "./support/hive-v4.js";

const now = () => Math.floor(Date.now() / 1000);
const hasCode = (code: string) => (error: unknown) => faultCode(error) === code;
const hours = (n: number) => n * 3600;
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

/** A treasury with coins, a provider's quote whose deadlines leave room for a day-long signature, and its watched escrow. */
async function paymentFixture(
  t: TestContext,
  options: { renewalWindowSeconds?: number; quoteHours?: number; timeoutHours?: number } = {},
) {
  const hive = await hiveFixture(t, { renewalWindowSeconds: options.renewalWindowSeconds });
  hive.fake.mint(hive.account.pkScript, 30_000);
  const { quote, escrow: terms } = await hive.quote({
    quoteExpiresAt: String(now() + hours(options.quoteHours ?? 36)),
    timeoutAt: String(now() + hours(options.timeoutHours ?? 40)),
  });
  const escrow = await hive.escrow(terms);
  const view = keeperView(hive.stewardKeys, hive.treasury.terms);
  const approval: PaymentApproval = {
    proposal: "translate-docs",
    remainingSats: 50_000,
    terms: quoteTerms(quote.body),
  };
  const plan = (validSeconds: number) =>
    planTreasurySend(hive.treasury, {
      pair: "01",
      amount: 20_000,
      destination: escrow.pkScript,
      validSeconds,
    });
  const session = (
    purpose: { stage: "attest" } | { stage: "register"; signatures: string[] },
    sendPlan: Awaited<ReturnType<typeof plan>>,
  ): SessionRequest => ({
    id: hex(randomBytes(32)),
    pair: "01",
    purpose: { kind: "payment", quote, plan: sendPlan, ...purpose } as SessionRequest["purpose"],
  });
  return { hive, quote, escrow, view, approval, plan, session };
}

test("two keepers sign a payment hours apart, each from the terms they confirmed, with no steward config", async (t) => {
  const { hive, view, approval, plan, session } = await paymentFixture(t);
  const sendPlan = await plan(hours(30));
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
  assert.deepEqual(checked.binds?.key, `request:${approval.terms.requestId}`);
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

test("a keeper payment is refused above the proposal's remaining budget or on terms the keeper did not see", async (t) => {
  const { hive, view, approval, plan, session } = await paymentFixture(t);
  const request = session({ stage: "attest" }, await plan(600));
  await assert.rejects(
    checkPayment(view, hive.conn, request, { ...approval, remainingSats: 19_999 }, now()),
    hasCode("ABOVE_BUDGET"),
  );
  const shown = { ...approval.terms, outputRateMsatPerMillionTokens: "1" };
  await assert.rejects(
    checkPayment(view, hive.conn, request, { ...approval, terms: shown }, now()),
    hasCode("QUOTE_TERMS_MISMATCH"),
  );
  const other = await hive.quote();
  await assert.rejects(
    checkPayment(view, hive.conn, request, { ...approval, terms: quoteTerms(other.quote.body) }, now()),
    hasCode("UNAPPROVED_REQUEST"),
  );
});

test("a keeper payment lives two days at most, and a steward's allocation still half an hour", async (t) => {
  const { hive, view, approval, plan, session, quote, escrow } = await paymentFixture(t, {
    quoteHours: 50,
    timeoutHours: 60,
  });
  const tooLong = session({ stage: "attest" }, await plan(KEEPER_MAX_VALIDITY_SECONDS + 600));
  await assert.rejects(checkPayment(view, hive.conn, tooLong, approval, now()), hasCode("PLAN_INVALID"));
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
        destination: escrow.pkScript,
        validSeconds: hours(2),
      }),
    },
  };
  await assert.rejects(
    checkPurpose(loadSteward(hive.configPaths[0]!), hive.conn, allocation, now()),
    hasCode("PLAN_INVALID"),
  );
});

test("a long-lived payment refuses coins that would need renewing before it ends", async (t) => {
  const { hive, view, approval, plan, session } = await paymentFixture(t, {
    renewalWindowSeconds: hours(20),
  });
  // Coins last two days: signed within the hour, renewal is no concern; held for 30 hours, it is.
  await checkPayment(view, hive.conn, session({ stage: "attest" }, await plan(1800)), approval, now());
  await assert.rejects(
    checkPayment(view, hive.conn, session({ stage: "attest" }, await plan(hours(30))), approval, now()),
    hasCode("COIN_EXPIRES_TOO_SOON"),
  );
});
