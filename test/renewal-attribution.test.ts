import assert from "node:assert/strict";
import { test } from "node:test";
import type { Connection, IndexedCoin } from "@hive/ark";
import { buildHiveView, observeTreasury } from "@hive/hive";

const treasuryScript = "5120" + "11".repeat(32);
let sequence = 1;
function batch(commitment: string, settled: number[], created: number[]): IndexedCoin[] {
  const coin = (amount: number, fields: Partial<IndexedCoin>): IndexedCoin => ({
    txid: (sequence++).toString(16).padStart(64, "0"),
    vout: 0,
    amount,
    script: treasuryScript,
    createdAt: 1,
    expiresAt: 86400,
    isSpent: false,
    isSwept: false,
    isPreconfirmed: false,
    spentBy: "",
    settledBy: "",
    arkTxid: "",
    commitmentTxids: [commitment],
    ...fields,
  });
  return [
    ...settled.map((amount) =>
      coin(amount, { isSpent: true, settledBy: commitment, commitmentTxids: ["old"] }),
    ),
    ...created.map((amount) => coin(amount, {})),
  ];
}
function connection(coins: IndexedCoin[]): Connection {
  return {
    operator: { checkpointTapscript: "" },
    arkd: { coins: async () => coins, virtualTxs: async () => [] },
  } as unknown as Connection;
}
const observe = (coins: IndexedCoin[]) =>
  observeTreasury(connection(coins), {
    treasuryScript,
    internalTxids: new Set<string>(),
    renewalMaxFeeSats: 200,
  });
const outputContributions = (view: Awaited<ReturnType<typeof observe>>, coins: IndexedCoin[]) =>
  view.contributions.filter((c) => coins.some((coin) => !coin.isSpent && coin.txid === c.txid));
type UnknownBatch = { commitmentTxid: string; coins: { amountSats: number }[]; deposits: number | null };
const unattributed = (value: unknown) => (value as { unattributed?: UnknownBatch[] }).unattributed;
const amounts = (coins: { amountSats: number }[]) => coins.map((c) => c.amountSats).sort((a, b) => a - b);

test("a same-batch deposit cannot turn the actual renewal into a contribution", async () => {
  const coins = batch("a", [1000], [900, 1000]);
  const view = await observe(coins);
  assert.deepEqual(outputContributions(view, coins), []);
  assert.deepEqual(view.renewals, []);
  assert.deepEqual(
    unattributed(view)?.map((b) => [amounts(b.coins), b.deposits]),
    [[[900, 1000], 1]],
  );
  const hiveView = await buildHiveView(connection(coins), {
    treasuryAddress: "unused",
    treasuryScript,
    journalRoots: [],
    renewalMaxFeeSats: 200,
  });
  assert.equal(hiveView.totals.contributedSats, 1000);
  assert.deepEqual(unattributed(hiveView), unattributed(view));
});

test("renewal attribution resolves only where every complete pairing agrees", async () => {
  const closeCoins = batch("a", [5000], [4850, 4900]);
  const close = await observe(closeCoins);
  assert.deepEqual(close.renewals, []);
  assert.deepEqual(outputContributions(close, closeCoins), []);
  assert.deepEqual(
    unattributed(close)?.map((b) => [amounts(b.coins), b.deposits]),
    [[[4850, 4900], 1]],
  );
  const distinctCoins = batch("b", [5000], [4850, 3000]);
  const distinct = await observe(distinctCoins);
  assert.deepEqual(amounts(distinct.renewals), [4850]);
  assert.deepEqual(amounts(outputContributions(distinct, distinctCoins)), [3000]);
  assert.deepEqual(unattributed(distinct), []);
  const sameCoins = batch("c", [5000, 5000], [4900, 4900, 4900]);
  const same = await observe(sameCoins);
  assert.deepEqual(same.renewals, []);
  assert.deepEqual(outputContributions(same, sameCoins), []);
  assert.deepEqual(
    unattributed(same)?.map((b) => [b.coins.length, b.deposits]),
    [[3, 1]],
  );
  const twoCoins = batch("d", [5000, 3000], [4900, 2950]);
  const two = await observe(twoCoins);
  assert.deepEqual(two.renewals.map((r) => [r.amountSats, r.sources]).sort(), [
    [2950, [twoCoins[1]!.txid + ":0"]],
    [4900, [twoCoins[0]!.txid + ":0"]],
  ]);
});

test("inconsistent and large renewal batches remain conservative with bounded work", async () => {
  const twelve = (n: number) => Array.from({ length: 12 }, () => n);
  for (const [settled, created] of [
    [twelve(5000), twelve(4900).slice(1)],
    [[...twelve(5000).slice(1), 3000], twelve(4900)],
    [
      [...twelve(5000).slice(2), 3000, 3000],
      [...twelve(4900).slice(2), 2950, 6000],
    ],
  ]) {
    const coins = batch("e", settled!, created!);
    const started = performance.now();
    const view = await observe(coins);
    assert.deepEqual(view.renewals, []);
    assert.deepEqual(outputContributions(view, coins), []);
    assert.deepEqual(
      unattributed(view)?.map((b) => b.deposits),
      [null],
    );
    assert.ok(performance.now() - started < 500);
  }
  const large = await observe(batch("f", Array(40).fill(5000), Array(40).fill(4900)));
  assert.equal(large.renewals.length, 40);
  assert.deepEqual(unattributed(large), []);
  const largerCoins = batch("g", Array(20).fill(5000), Array(41).fill(4900));
  const started = performance.now();
  const larger = await observe(largerCoins);
  assert.deepEqual(outputContributions(larger, largerCoins), []);
  assert.deepEqual(
    unattributed(larger)?.map((b) => [b.coins.length, b.deposits]),
    [[41, 21]],
  );
  assert.ok(performance.now() - started < 500);
});

test("renewal attribution is recomputed when batch relationships become complete", async () => {
  const coins = batch("h", [1000], [900, 1000]);
  const uncertain = await observe(coins);
  assert.deepEqual(outputContributions(uncertain, coins), []);
  coins[2]!.commitmentTxids = ["unrelated"];
  const resolved = await observe(coins);
  assert.deepEqual(amounts(resolved.renewals), [900]);
  assert.deepEqual(amounts(outputContributions(resolved, coins)), [1000]);
  assert.deepEqual(unattributed(resolved), []);
});

test("multiple commitment associations cannot be used to attribute a renewal", async () => {
  const coins = batch("i", [1000], [900]);
  coins[1]!.commitmentTxids.push("another");
  const view = await observe(coins);
  assert.deepEqual(view.renewals, []);
  assert.deepEqual(outputContributions(view, coins), []);
  assert.deepEqual(
    unattributed(view)?.map((b) => b.deposits),
    [null],
  );
});

test("oversized renewal batches stay unattributed before constructing a matching graph", async () => {
  for (const [sources, outputs] of [
    [257, 257],
    [1, 257],
    [257, 1],
  ]) {
    const coins = batch("oversized", Array(sources).fill(5000), Array(outputs).fill(4900));
    const view = await observe(coins);
    assert.deepEqual(view.renewals, []);
    assert.deepEqual(outputContributions(view, coins), []);
    assert.deepEqual(
      unattributed(view)?.map((b) => [b.coins.length, b.deposits]),
      [[outputs, null]],
    );
  }
});
