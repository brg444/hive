import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { executionState, type Route, Router } from "@hive/executor";
import { faultCode, localPath, readJson, writeJson } from "@hive/kit";
import {
  driveTreasurySpend,
  newSpendJournal,
  planTreasurySend,
  reservedCoins,
  type SpendJournal,
} from "@hive/hive";
import { hiveFixture } from "../support/hive-v4.js";

test("concurrent treasury resumes cannot overwrite a durable covenant refusal", async (t) => {
  const hive = await hiveFixture(t);
  hive.fake.mint(hive.account.pkScript, 50_000);
  const { quote, escrow: terms } = await hive.quote();
  const escrow = await hive.escrow(terms);
  const plan = await planTreasurySend(hive.treasury, {
    pair: "01",
    amount: 20_000,
    destination: escrow.pkScript,
    validSeconds: 600,
  });
  const directory = localPath("v4-treasury-routing-test", randomUUID());
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = directory + "/funding.json";
  writeJson(path, newSpendJournal("resume-race", { kind: "allocation", quote }, plan));
  let observing = false;
  let releaseSelf!: () => void;
  let releaseDelegatee!: () => void;
  let enteredSelf!: () => void;
  const selfHeld = new Promise<void>((resolve) => {
    releaseSelf = resolve;
  });
  const delegateeHeld = new Promise<void>((resolve) => {
    releaseDelegatee = resolve;
  });
  const selfEntered = new Promise<void>((resolve) => {
    enteredSelf = resolve;
  });
  let delegateePosts = 0;
  const self: Route = {
    name: "self",
    async submit(action) {
      enteredSelf();
      await selfHeld;
      return {
        result: "refused",
        detail: "COVENANT_REJECTED",
        proof: {
          source: "offline-model",
          route: "self",
          txid: action.txid,
          outpoints: action.spend!.inputs.map((coin) => coin.txid + ":" + coin.vout),
          reason: "covenant-failed",
        },
      };
    },
  };
  const delegatee: Route = {
    name: "delegatee",
    async submit() {
      delegateePosts++;
      await delegateeHeld;
      return { result: "unavailable", detail: "SERVICE_UNAVAILABLE" };
    },
  };
  hive.conn.router = new Router({
    routes: [self, delegatee],
    observe: async () => (observing ? "unspent" : "pending"),
    patienceMs: 0,
    retryMs: 10_000,
    pollMs: 1,
  });
  await assert.rejects(
    driveTreasurySpend(hive.treasury, path, { timeoutMs: 5 }),
    (error: unknown) => faultCode(error) === "SPEND_PENDING",
  );
  observing = true;
  const first = driveTreasurySpend(hive.treasury, path, { timeoutMs: 100 }).catch(() => undefined);
  await selfEntered;
  const concurrent = driveTreasurySpend(hive.treasury, path, { timeoutMs: 150 }).catch(() => undefined);
  // Let a stale second driver read the prepared attempt before the first reply.
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseSelf();
  await first;
  releaseDelegatee();
  await concurrent;
  const saved = readJson<SpendJournal>(path);
  assert.ok(
    saved.execution?.attempts.some((attempt) => attempt.response?.result === "refused"),
    "a stale resume must not erase the refusal saved by the original driver",
  );
  assert.equal(delegateePosts, 0, "only one journal driver may submit at a time");
  await assert.rejects(
    driveTreasurySpend(hive.treasury, path, { timeoutMs: 20 }),
    (error: unknown) => faultCode(error) === "SPEND_PENDING",
  );
  assert.equal(delegateePosts, 0, "the resumed fixed action remains pinned to self");
});

test("ambiguous prepared and legacy treasury sends stay excluded after the grace", async (t) => {
  const hive = await hiveFixture(t);
  hive.fake.mint(hive.account.pkScript, 50_000);
  const { quote, escrow: terms } = await hive.quote();
  const escrow = await hive.escrow(terms);
  const plan = await planTreasurySend(hive.treasury, {
    pair: "01",
    amount: 20_000,
    destination: escrow.pkScript,
    validSeconds: 600,
  });
  const unsigned = newSpendJournal("reservation", { kind: "allocation", quote }, plan);
  const outpoints = plan.coins.map((coin) => coin.txid + ":" + coin.vout);
  const later = plan.validUntil + 601;
  const action = { txid: "ab".repeat(32), validUntil: plan.validUntil };
  const prepared = {
    ...structuredClone(unsigned),
    status: "registered" as const,
    execution: executionState(action, ["self", "delegatee"]),
  };
  prepared.execution.attempts.push({ sequence: 1, route: "self", preparedAt: Date.now() });
  assert.deepEqual(reservedCoins([prepared], later), outpoints);
  const answered = structuredClone(prepared);
  answered.execution.attempts[0]!.answeredAt = Date.now();
  answered.execution.attempts[0]!.response = { result: "unavailable", detail: "SERVICE_UNAVAILABLE" };
  assert.deepEqual(reservedCoins([answered], later), outpoints);
  const legacy = {
    ...structuredClone(unsigned),
    status: "registered" as const,
    request: {
      templateId: "",
      variables: {},
      outpoints,
      expiresAt: plan.validUntil,
      pubkey: "",
      signature: "",
    },
  };
  assert.deepEqual(reservedCoins([legacy], later), outpoints);
  const migrated = {
    ...structuredClone(unsigned),
    status: "registered" as const,
    execution: executionState(action, ["self"], [], true),
  };
  assert.deepEqual(reservedCoins([migrated], later), outpoints);
  const neverPosted = {
    ...structuredClone(unsigned),
    status: "expired" as const,
    execution: executionState(action, ["self"]),
  };
  assert.deepEqual(reservedCoins([neverPosted], later), []);
  assert.deepEqual(reservedCoins([{ ...prepared, status: "done", txid: action.txid }], later), []);
  assert.deepEqual(reservedCoins([{ ...unsigned, status: "expired" }], later), []);
});
