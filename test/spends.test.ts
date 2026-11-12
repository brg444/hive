import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { type CovenantSpend, checkpointId } from "@hive/ark";
import { buildSpend, extensionOutput, selfRoute } from "@hive/executor";
import { ConditionWitness, getArkPsbtFields } from "@arkade-os/sdk";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * The delegatee's own Go code built these transactions from the templates
 * (`tools/spend-vectors.ts`). Built here from the same spend through the SDK,
 * they must match byte for byte: then a spend has one txid whoever executes it.
 */
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../packages/ark/test/vectors/spends.json"), "utf8"),
) as {
  checkpointTapscript: string;
  keys: { server: string; emulator: string; delegate: string };
  cases: {
    name: string;
    kind: string;
    spend: CovenantSpend;
    expected: {
      arkTxid: string;
      arkTx: string;
      checkpoints: { txid: string; tx: string }[];
      leaves: string[];
      extension: number;
      outputs: { script: string; amount: number }[];
    };
  }[];
};

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

for (const c of vectors.cases) {
  test(`${c.name}: the same transaction as the delegatee's`, () => {
    const built = buildSpend(c.spend, vectors.checkpointTapscript);
    assert.equal(built.txid, c.expected.arkTxid);
    assert.equal(hexOf(built.arkTx.unsignedTx), c.expected.arkTx);
    assert.deepEqual(
      built.checkpoints.map((cp) => hexOf(cp.unsignedTx)),
      c.expected.checkpoints.map((cp) => cp.tx),
    );
    assert.deepEqual(
      c.spend.inputs.map((i) => i.leaf),
      c.expected.leaves,
    );
    assert.equal(c.spend.extensionIndex, c.expected.extension);
    assert.equal(hexOf(extensionOutput(c.spend)!.script), c.expected.outputs[c.expected.extension]!.script);
  });
}

test("a send's attestations commit to the checkpoints the executor builds", () => {
  for (const c of vectors.cases.filter((c) => c.name.includes("send"))) {
    const built = buildSpend(c.spend, vectors.checkpointTapscript);
    c.spend.inputs.forEach((input, i) => {
      assert.equal(
        checkpointId(input, input.leaf, vectors.checkpointTapscript),
        built.checkpoints[i]!.id,
        c.name,
      );
    });
  }
});

test("a leaf outside the contract is refused before anything is built", () => {
  const c = vectors.cases[0]!;
  const spend = { ...c.spend, inputs: [{ ...c.spend.inputs[0]!, leaf: "51" }] };
  assert.throws(() => buildSpend(spend, vectors.checkpointTapscript), /INVALID/);
});

test("the committed spend vectors cover every requested pair, input shape and dust boundary", () => {
  const required = [
    "wallet send with change",
    "wallet send of everything from two coins",
    "treasury send by pair 02 from two coins with change",
    "escrow claim with a remainder",
    "escrow claim of nearly everything",
    "escrow refund",
    "treasury send by pair 01 from two coins with change",
    "treasury send by pair 12 from two coins with change",
    "wallet send of everything from one coin",
    "treasury send from one coin with change",
    "treasury send of everything from one coin",
    "treasury send of everything from two coins",
    "wallet send from three coins with change",
    "escrow claim with exactly 330 sats left",
    "escrow claim with exactly 331 sats left",
  ];
  assert.deepEqual(
    vectors.cases.map((c) => c.name),
    required,
  );
  const dust = vectors.cases.find((c) => c.name === "escrow claim with exactly 330 sats left")!;
  const change = vectors.cases.find((c) => c.name === "escrow claim with exactly 331 sats left")!;
  assert.deepEqual(
    dust.spend.outputs.map((o) => o.amount),
    [10_000],
  );
  assert.deepEqual(
    change.spend.outputs.map((o) => o.amount),
    [9669, 331],
  );
});

test("a conditional fixture carries its condition witness on the Ark transaction and every checkpoint", () => {
  const spend = structuredClone(vectors.cases[1]!.spend);
  const witnesses = spend.inputs.map((input, index) => {
    const preimage = Uint8Array.from({ length: 32 }, (_, i) => i + index);
    const prefix = "a820" + hexOf(sha256(preimage)) + "8769";
    const original = input.leaf;
    input.leaf = prefix + original;
    input.tapscripts = input.tapscripts.map((leaf) => (leaf === original ? input.leaf : leaf));
    input.condition = [hexOf(preimage)];
    return [preimage];
  });
  const built = buildSpend(spend, vectors.checkpointTapscript);
  spend.inputs.forEach((_, i) => {
    assert.deepEqual(getArkPsbtFields(built.arkTx, i, ConditionWitness), [witnesses[i]!]);
    assert.deepEqual(getArkPsbtFields(built.checkpoints[i]!, 0, ConditionWitness), [witnesses[i]!]);
  });
});

test("the self route reports ACTION_MISMATCH as invalid before loading previous transactions or posting", async () => {
  let previousLookups = 0;
  let posts = 0;
  const route = selfRoute({
    emulatorKey: vectors.keys.emulator,
    serverKey: vectors.keys.server,
    checkpointTapscript: vectors.checkpointTapscript,
    emulator: {
      getInfo: async () => ({ signerPubkey: vectors.keys.emulator }),
      submitTx: async () => {
        posts++;
        throw new Error("unexpected submission");
      },
    },
    prevTxs: {
      getVirtualTxs: async () => {
        previousLookups++;
        return { txs: [] };
      },
    },
  });
  const answer = await route.submit({
    txid: "00".repeat(32),
    spend: vectors.cases[0]!.spend,
    validUntil: Math.floor(Date.now() / 1000) + 600,
  });
  assert.deepEqual(answer, { result: "invalid", detail: "ACTION_MISMATCH" });
  assert.equal(previousLookups, 0);
  assert.equal(posts, 0);
});
