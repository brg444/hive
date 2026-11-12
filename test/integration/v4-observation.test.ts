import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { connect, openWallet, type WalletSendJournal, walletSend, walletTerms } from "@hive/ark";
import { faultCode, hex, localPath, readJson, readJsonIfPresent, writeJson } from "@hive/kit";
import { driveTreasurySpend, newSpendJournal, planTreasurySend, type SpendJournal } from "@hive/hive";
import { approveWithdrawal } from "@hive/steward";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { startFakeNetwork } from "../support/fake-network.js";
import { hiveFixture } from "../support/hive-v4.js";

async function walletFixture(t: TestContext) {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 86_400 });
  t.after(() => fake.close());
  const conn = await connect(fake.deployment());
  const ownerSecret = secp256k1.utils.randomSecretKey();
  const wallet = await openWallet(
    conn,
    walletTerms(conn, hex(secp256k1.getPublicKey(ownerSecret, true)), {
      renewalWindowSeconds: 600,
      maxFeeSats: 500,
    }),
  );
  const directory = localPath("v4-test", randomUUID());
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  fake.mint(wallet.account.pkScript, 1_500);
  fake.mint(wallet.account.pkScript, 2_500);
  const destination = `5120${"ab".repeat(32)}`;
  const path = resolve(directory, "send.json");
  const args = {
    journalPath: path,
    destination,
    amount: 3_000,
    validUntil: Math.floor(Date.now() / 1000) + 600,
    purpose: { kind: "observation-regression" },
    routes: ["self" as const],
    timeoutMs: 1_500,
  };
  return { fake, conn, wallet, ownerSecret, args, path };
}

for (const missing of ["input", "output"] as const) {
  test(`a wallet send with a missing ${missing} stays pending and resumes without resubmission`, async (t) => {
    const { fake, conn, wallet, ownerSecret, args, path } = await walletFixture(t);
    const coins = conn.arkd.coins.bind(conn.arkd);
    let incomplete = true;
    conn.arkd.coins = async (query) => {
      const found = await coins(query);
      if (!incomplete) return found;
      const expected = readJsonIfPresent<WalletSendJournal>(path)?.arkTxid;
      if (missing === "input" && query.outpoints && found.some((coin) => coin.isSpent))
        return found.slice(0, 1);
      if (missing === "output" && expected) return found.filter((coin) => coin.txid !== expected);
      return found;
    };
    const run = () => walletSend(wallet, ownerSecret, args);
    await assert.rejects(run(), (error: unknown) => faultCode(error) === "SEND_PENDING");
    const pending = readJson<WalletSendJournal>(path);
    assert.equal(pending.status, "registered");
    assert.equal(pending.txid, undefined);
    const submissions = fake.emulatorSubmissions.length;
    incomplete = false;
    const done = await run();
    assert.equal(done.status, "done");
    assert.equal(done.txid, pending.arkTxid);
    assert.equal(fake.emulatorSubmissions.length, submissions);
  });
}

test("a wallet never records a different spender even when it pays the same destination and amount", async (t) => {
  const { conn, wallet, ownerSecret, args, path } = await walletFixture(t);
  const coins = conn.arkd.coins.bind(conn.arkd);
  const other = "ee".repeat(32);
  conn.arkd.coins = async (query) => {
    const found = await coins(query);
    const expected = readJsonIfPresent<WalletSendJournal>(path)?.arkTxid;
    return found.map((coin) => {
      if (coin.isSpent && coin.arkTxid === expected) return { ...coin, arkTxid: other, spentBy: other };
      if (expected && coin.txid === expected) return { ...coin, txid: other };
      return coin;
    });
  };
  await assert.rejects(
    walletSend(wallet, ownerSecret, args),
    (error: unknown) => faultCode(error) === "SEND_SUPERSEDED",
  );
  const journal = readJson<WalletSendJournal>(path);
  assert.equal(journal.txid, undefined);
  assert.notEqual(journal.status, "done");
});

test("a partially visible treasury withdrawal remains pending and completes when every link appears", async (t) => {
  const hive = await hiveFixture(t);
  hive.fake.mint(hive.account.pkScript, 20_000);
  hive.fake.mint(hive.account.pkScript, 15_000);
  const withdrawal = {
    label: "partial",
    destination: `5120${"cd".repeat(32)}`,
    amountSats: 30_000,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
  for (const path of hive.configPaths.slice(0, 2)) await approveWithdrawal(path, withdrawal);
  const plan = await planTreasurySend(hive.treasury, {
    pair: "01",
    amount: withdrawal.amountSats,
    destination: withdrawal.destination,
    validSeconds: 300,
  });
  const directory = localPath("v4-test", randomUUID());
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, "withdrawal.json");
  writeJson(path, newSpendJournal("partial", { kind: "withdrawal", withdrawal }, plan));
  const coins = hive.conn.arkd.coins.bind(hive.conn.arkd);
  let partial = true;
  hive.conn.arkd.coins = async (query) => {
    const found = await coins(query);
    if (!partial || !query.outpoints || !found.some((coin) => coin.isSpent)) return found;
    return found.map((coin, index) =>
      index === 0 ? { ...coin, spentBy: "" } : { ...coin, isSpent: false, spentBy: "", arkTxid: "" },
    );
  };
  const run = () => driveTreasurySpend(hive.treasury, path, { routes: ["self"], timeoutMs: 1_500 });
  await assert.rejects(run(), (error: unknown) => faultCode(error) === "SPEND_PENDING");
  const pending = readJson<SpendJournal>(path);
  assert.equal(pending.status, "registered");
  assert.equal(pending.txid, undefined);
  const submissions = hive.fake.emulatorSubmissions.length;
  partial = false;
  const done = await run();
  assert.equal(done.status, "done");
  assert.equal(done.txid, pending.arkTxid);
  assert.equal(hive.fake.emulatorSubmissions.length, submissions);
});
