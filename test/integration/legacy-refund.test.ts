import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Action } from "@hive/executor";
import { localPath, readJsonIfPresent } from "@hive/kit";
import { executeRefund, refundEscrow, type RegisteredRefund } from "@hive/hive";
import { hiveFixture } from "../support/hive-v4.js";

test("an old registered refund reconciles its original spent input without selecting or signing again", async (t) => {
  const hive = await hiveFixture(t);
  const now = Math.floor(Date.now() / 1000);
  const { quote, escrow: terms } = await hive.quote({
    timeoutAt: String(now - 5),
    quoteExpiresAt: String(now - 60),
  });
  const escrow = await hive.escrow(terms);
  const original = hive.fake.mint(escrow.pkScript, Number(quote.body.capSats));
  const directory = localPath("legacy-refund-test", randomUUID());
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, "refund-execution.json");
  const options = {
    escrowArtifactId: escrow.artifactId,
    journalPath: path,
    timeoutMs: 5000,
  };
  const registration = await refundEscrow(hive.treasury, quote, options);
  assert.ok(registration);
  const before = readJsonIfPresent<{ action: Action }>(path);
  assert.ok(before?.action);
  assert.equal(original.isSpent, true);
  // The old deployment retained only this public registration.
  const legacyRegistration: RegisteredRefund = structuredClone(registration);
  rmSync(path);
  original.expiresAt = 0;
  const second = hive.fake.mint(escrow.pkScript, Number(quote.body.capSats));
  let lookups = 0;
  let posts = 0;
  const coins = hive.conn.arkd.coins.bind(hive.conn.arkd);
  t.mock.method(hive.conn.arkd, "coins", async (query: Parameters<typeof coins>[0], signal?: AbortSignal) => {
    lookups++;
    assert.equal(query.scripts, undefined, "resume must not select a replacement cap coin");
    assert.ok(query.outpoints?.length, "only the fixed original action is observed");
    return coins(query, signal);
  });
  t.mock.method(hive.conn.delegatee, "registerTemplate", async () => {
    assert.fail("resume must not create a template or request fresh pair signatures");
  });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (
      init?.method === "POST" &&
      [hive.fake.delegateeUrl + "/v1/spend", hive.fake.emulatorUrl + "/v1/tx"].includes(String(input))
    ) {
      posts++;
      assert.fail("an already observed legacy refund must not post again");
    }
    return fetch(input, init);
  });
  const recovered = await executeRefund(hive.treasury, quote, {
    journalPath: path,
    observeOnly: true,
    legacyRegistration,
    timeoutMs: 5000,
  } as Parameters<typeof executeRefund>[2]);
  assert.equal(recovered?.txid, before.action.txid);
  const saved = readJsonIfPresent<{
    action: Action;
    registration: RegisteredRefund;
    execution: { action: Action; legacyUnknown?: boolean; attempts: unknown[] };
  }>(path);
  assert.ok(saved);
  assert.deepEqual(saved.registration, legacyRegistration);
  assert.equal(saved.action.txid, before.action.txid);
  assert.deepEqual(saved.action, saved.execution.action);
  assert.equal(saved.execution.legacyUnknown, true);
  assert.deepEqual(saved.execution.attempts, []);
  assert.deepEqual(
    await refundEscrow(hive.treasury, quote, {
      ...options,
      legacyRegistration,
    } as Parameters<typeof refundEscrow>[2]),
    legacyRegistration,
  );
  assert.ok(lookups > 0);
  assert.equal(posts, 0);
  assert.equal(second.isSpent, false);
  assert.equal(hive.fake.balance(hive.account.pkScript), Number(quote.body.capSats));
});
