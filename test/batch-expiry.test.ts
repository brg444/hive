import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountCoins,
  Arkd,
  type Connection,
  type IndexedCoin,
  openWallet,
  walletSend,
  walletTerms,
} from "@hive/ark";
import { faultCode, localPath, writeJson } from "@hive/kit";
import { newSpendJournal, planTreasurySend, purchase } from "@hive/hive";
import { loadSteward } from "../packages/steward/src/config.js";
import { checkPurpose } from "../packages/steward/src/policy.js";
import { hiveFixture } from "./support/hive-v4.js";

const now = () => Math.floor(Date.now() / 1000);
const knownCoin = (): IndexedCoin => ({
  txid: "ab".repeat(32),
  vout: 0,
  amount: 30_000,
  script: "5120" + "cd".repeat(32),
  createdAt: now(),
  expiresAt: now() + 86_400,
  isSpent: false,
  isSwept: false,
  isPreconfirmed: false,
  spentBy: "",
  settledBy: "",
  arkTxid: "",
  commitmentTxids: [],
});
const hasCode = (code: string) => (error: unknown) => faultCode(error) === code;

test("indexer preserves unknown historical batch expiry without calling it zero", async () => {
  for (const expiresAt of [undefined, null, "", 0, "0"]) {
    const arkd = new Arkd("http://unused", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        vtxos: [{ outpoint: { txid: "ab".repeat(32), vout: 0 }, amount: "30000", isSpent: true, expiresAt }],
      }),
    }));
    const [coin] = await arkd.coins({ scripts: ["51"] });
    assert.equal(coin?.expiresAt, null);
    assert.equal(coin?.isSpent, true);
  }
});

test("indexer rejects malformed expiry values instead of coercing their type", async () => {
  for (const expiresAt of [-1, 1.5, true, " 1000", "1e3", Number.MAX_SAFE_INTEGER + 1]) {
    const arkd = new Arkd("http://unused", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ vtxos: [{ outpoint: { txid: "ab".repeat(32), vout: 0 }, expiresAt }] }),
    }));
    await assert.rejects(arkd.coins({ scripts: ["51"] }), hasCode("INDEXER"));
  }
});

test("an account refuses a new plan when an unspent coin has unknown batch expiry", async () => {
  const coin = knownCoin();
  coin.expiresAt = 0;
  const conn = { arkd: { coins: async () => [coin] } } as unknown as Connection;
  await assert.rejects(accountCoins(conn, coin.script, 600), hasCode("COIN_EXPIRY_UNKNOWN"));
  coin.isSpent = true;
  assert.deepEqual(await accountCoins(conn, coin.script, 600), { spendable: [], renewing: [] });
});

test("allocation refuses unknown expiry in the first input lookup", async (t) => {
  const hive = await hiveFixture(t);
  const coin = hive.fake.mint(hive.account.pkScript, 30_000);
  const { quote, escrow: terms } = await hive.quote();
  const escrow = await hive.escrow(terms);
  const plan = await planTreasurySend(hive.treasury, {
    pair: "01",
    amount: 20_000,
    destination: escrow.pkScript,
    validSeconds: 600,
  });
  coin.expiresAt = 0;
  await assert.rejects(
    checkPurpose(
      loadSteward(hive.configPaths[0]!),
      hive.conn,
      {
        id: "aa".repeat(32),
        pair: "01",
        purpose: { kind: "allocation", stage: "attest", quote, plan },
      },
      now(),
    ),
    hasCode("COIN_EXPIRY_UNKNOWN"),
  );
});

test("allocation repeats a complete input lookup before producing a signing message", async (t) => {
  const hive = await hiveFixture(t);
  hive.fake.mint(hive.account.pkScript, 12_000);
  hive.fake.mint(hive.account.pkScript, 13_000);
  const { quote, escrow: terms } = await hive.quote();
  const escrow = await hive.escrow(terms);
  const plan = await planTreasurySend(hive.treasury, {
    pair: "01",
    amount: 20_000,
    destination: escrow.pkScript,
    validSeconds: 600,
  });
  assert.equal(plan.coins.length, 2);
  const read = hive.conn.arkd.coins.bind(hive.conn.arkd);
  t.after(() => {
    hive.conn.arkd.coins = read;
  });
  const mutations: [string, (coins: IndexedCoin[]) => IndexedCoin[], string][] = [
    ["missing", (coins) => coins.slice(0, 1), "COIN_UNKNOWN"],
    ["duplicate", (coins) => [coins[0]!, coins[0]!], "COIN_UNKNOWN"],
    ["substitute", (coins) => [{ ...coins[0]!, txid: "ef".repeat(32) }, coins[1]!], "COIN_UNKNOWN"],
    ["changed amount", (coins) => [{ ...coins[0]!, amount: 1 }, coins[1]!], "COIN_UNKNOWN"],
    ["spent", (coins) => [{ ...coins[0]!, isSpent: true }, coins[1]!], "COIN_SPENT"],
    ["linked spender", (coins) => [{ ...coins[0]!, arkTxid: "dd".repeat(32) }, coins[1]!], "COIN_SPENT"],
    ["linked checkpoint", (coins) => [{ ...coins[0]!, spentBy: "dd".repeat(32) }, coins[1]!], "COIN_SPENT"],
    ["linked settlement", (coins) => [{ ...coins[0]!, settledBy: "dd".repeat(32) }, coins[1]!], "COIN_SPENT"],
    ["unknown expiry", (coins) => [{ ...coins[0]!, expiresAt: 0 }, coins[1]!], "COIN_EXPIRY_UNKNOWN"],
    [
      "short expiry",
      (coins) => [{ ...coins[0]!, expiresAt: terms.timeoutAt }, coins[1]!],
      "COIN_EXPIRES_TOO_SOON",
    ],
  ];
  for (const [name, mutate, expected] of mutations) {
    let lookups = 0;
    hive.conn.arkd.coins = async (query) => {
      const coins = await read(query);
      return query.outpoints && ++lookups === 2 ? mutate(coins) : coins;
    };
    await assert.rejects(
      checkPurpose(
        loadSteward(hive.configPaths[0]!),
        hive.conn,
        {
          id: "bb".repeat(32),
          pair: "01",
          purpose: { kind: "allocation", stage: "attest", quote, plan },
        },
        now(),
      ),
      hasCode(expected),
      name,
    );
  }
  hive.conn.arkd.coins = read;
  const result = await checkPurpose(
    loadSteward(hive.configPaths[0]!),
    hive.conn,
    {
      id: "cc".repeat(32),
      pair: "01",
      purpose: { kind: "allocation", stage: "attest", quote, plan },
    },
    now(),
  );
  assert.equal(result.messages.length, 2);
});

test("escrow activation refuses an observed funding coin with unknown batch expiry", async (t) => {
  const hive = await hiveFixture(t);
  hive.fake.mint(hive.account.pkScript, 30_000);
  const { quote, escrow: terms } = await hive.quote();
  const escrow = await hive.escrow(terms);
  const plan = await planTreasurySend(hive.treasury, {
    pair: "01",
    amount: 20_000,
    destination: escrow.pkScript,
    validSeconds: 600,
  });
  const coin = hive.fake.mint(escrow.pkScript, 20_000);
  coin.expiresAt = 0;
  const directory = localPath("v4-expiry-test", randomUUID());
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeJson(join(directory, "purchase.json"), {
    schema: "hive-purchase/v4",
    quote,
    escrow: {
      terms,
      address: escrow.address,
      pkScript: escrow.pkScript,
      artifactId: escrow.artifactId,
      refundWatch: escrow.watch.delegationId,
    },
    createdAt: new Date().toISOString(),
  });
  writeJson(join(directory, "funding.json"), {
    ...newSpendJournal("activation", { kind: "allocation", quote }, plan),
    status: "done",
    txid: coin.txid,
  });
  await assert.rejects(purchase(hive.treasury, { quote, directory }), hasCode("COIN_EXPIRY_UNKNOWN"));
});

test("a wallet rechecks the renewal margin after template preparation and before signing", async (t) => {
  const hive = await hiveFixture(t);
  const wallet = await openWallet(
    hive.conn,
    walletTerms(hive.conn, hive.stewardKeys[0], {
      renewalWindowSeconds: 600,
      maxFeeSats: 500,
    }),
  );
  const coin = hive.fake.mint(wallet.account.pkScript, 30_000);
  const register = hive.conn.delegatee.registerTemplate.bind(hive.conn.delegatee);
  t.after(() => {
    hive.conn.delegatee.registerTemplate = register;
  });
  hive.conn.delegatee.registerTemplate = async (template) => {
    const id = await register(template);
    coin.expiresAt = now() + 800;
    return id;
  };
  const directory = localPath("v4-wallet-expiry-test", randomUUID());
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    walletSend(wallet, hive.stewardSecrets[0]!, {
      journalPath: join(directory, "send.json"),
      destination: hive.account.pkScript,
      amount: 1000,
      validUntil: now() + 600,
      purpose: { test: "expiry changed after selection" },
      beforeSubmit: () => {
        throw new Error("reached posting with a now-renewing coin");
      },
    }),
    hasCode("COIN_EXPIRES_TOO_SOON"),
  );
});
