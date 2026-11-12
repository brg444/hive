import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { VtxoScript } from "@arkade-os/sdk";
import {
  type Action,
  buildSpend,
  type CovenantSpend,
  type ObservedCoin,
  observeSpend,
  Router,
} from "@hive/executor";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../packages/ark/test/vectors/spends.json"), "utf8"),
) as { checkpointTapscript: string; cases: { spend: CovenantSpend }[] };

function fixture(extensionIndex?: number) {
  const spend = structuredClone(
    vectors.cases.find((vector) => vector.spend.inputs.length === 2 && vector.spend.outputs.length === 2)!
      .spend,
  );
  if (extensionIndex !== undefined) spend.extensionIndex = extensionIndex;
  const built = buildSpend(spend, vectors.checkpointTapscript);
  const action: Action = { txid: built.txid, spend, validUntil: Math.floor(Date.now() / 1000) + 600 };
  const inputs: ObservedCoin[] = spend.inputs.map((input, index) => ({
    txid: input.txid,
    vout: input.vout,
    amount: input.amount,
    script: Buffer.from(
      new VtxoScript(input.tapscripts.map((leaf) => Buffer.from(leaf, "hex"))).pkScript,
    ).toString("hex"),
    isSpent: true,
    spentBy: built.checkpoints[index]!.id,
    arkTxid: built.txid,
  }));
  const outputs: ObservedCoin[] = spend.outputs.map((output, index) => ({
    ...output,
    txid: built.txid,
    vout: index + (index >= spend.extensionIndex ? 1 : 0),
    isSpent: false,
  }));
  const observe = (seenInputs: ObservedCoin[], seenOutputs = outputs) =>
    observeSpend({
      checkpointTapscript: vectors.checkpointTapscript,
      coins: async ({ outpoints }) =>
        outpoints.includes(`${inputs[0]!.txid}:${inputs[0]!.vout}`) ? seenInputs : seenOutputs,
    })(action);
  const unspent = (index: number): ObservedCoin => ({
    ...inputs[index]!,
    isSpent: false,
    spentBy: "",
    arkTxid: "",
  });
  return { action, inputs, outputs, observe, unspent };
}

test("a shared spend observer preserves missing, partial and contradictory input evidence", async () => {
  const { inputs, observe, unspent } = fixture();
  const first = inputs[0]!;
  const second = inputs[1]!;
  const other = "ee".repeat(32);
  assert.equal(await observe([unspent(0), unspent(1)]), "unspent");
  assert.equal(await observe(inputs), "spent");
  const uncertain: [string, ObservedCoin[]][] = [
    ["missing expected input", [first]],
    ["duplicate expected input", [first, first]],
    ["unrelated replacement input", [first, { ...second, txid: other }]],
    ["changed input value", [first, { ...second, amount: second.amount + 1 }]],
    ["changed input script", [first, { ...second, script: `5120${other}` }]],
    ["one input spent", [first, unspent(1)]],
    ["spent with no links", [{ ...first, spentBy: "", arkTxid: "" }, unspent(1)]],
    ["our Ark link only", [{ ...first, spentBy: "" }, unspent(1)]],
    ["our checkpoint link only", [{ ...first, arkTxid: "" }, unspent(1)]],
    ["other Ark link only", [{ ...first, spentBy: "", arkTxid: other }, unspent(1)]],
    ["our Ark link contradicts checkpoint", [{ ...first, spentBy: other }, unspent(1)]],
    ["our checkpoint contradicts settlement", [{ ...first, arkTxid: "", settledBy: other }, unspent(1)]],
    ["our spend and another batch", [first, { ...second, spentBy: "", arkTxid: "", settledBy: other }]],
    ["swept input", [first, { ...second, isSwept: true }]],
  ];
  for (const [name, coins] of uncertain) assert.equal(await observe(coins), "pending", name);
  const elsewhere: ObservedCoin[] = [
    { ...first, spentBy: "", arkTxid: "", settledBy: other },
    { ...first, spentBy: other, arkTxid: other },
    { ...first, spentBy: other, arkTxid: "" },
    { ...first, arkTxid: other },
  ];
  for (const coin of elsewhere) assert.equal(await observe([coin, unspent(1)]), "elsewhere");
});

test("completion requires every exact output, including change and its extension-adjusted index", async () => {
  for (const extensionIndex of [0, 1, 2]) {
    const { inputs, outputs, observe } = fixture(extensionIndex);
    assert.equal(await observe(inputs), "spent");
    const first = outputs[0]!;
    const second = outputs[1]!;
    for (const coins of [
      [],
      [first],
      [first, first],
      [first, { ...second, amount: second.amount + 1 }],
      [first, { ...second, script: `5120${"ee".repeat(32)}` }],
      [first, { ...second, vout: second.vout + 1 }],
      [first, { ...second, txid: "ee".repeat(32) }],
    ])
      assert.equal(await observe(inputs, coins), "pending");
    assert.equal(
      await observe(
        inputs,
        outputs.map((coin) => ({ ...coin, isSpent: true })),
      ),
      "spent",
    );
  }
});

test("the observer refuses an action identity that differs from the rebuilt spend", async () => {
  const { action } = fixture();
  const observe = observeSpend({
    checkpointTapscript: vectors.checkpointTapscript,
    coins: async () => [],
  });
  await assert.rejects(observe({ ...action, txid: "ee".repeat(32) }), /ACTION_MISMATCH/);
});

test("an incomplete observation neither posts nor expires after the authorization grace", async () => {
  let submissions = 0;
  const router = new Router({
    routes: [
      {
        name: "self",
        async submit() {
          submissions++;
          return { result: "accepted" };
        },
      },
    ],
    observe: async () => "pending",
    graceSeconds: 0,
    pollMs: 1,
  });
  const { action } = fixture();
  assert.equal((await router.execute({ ...action, validUntil: 0 }, { timeoutMs: 5 })).status, "pending");
  assert.equal((await router.execute(action, { timeoutMs: 5 })).status, "pending");
  assert.equal(submissions, 0);
});
