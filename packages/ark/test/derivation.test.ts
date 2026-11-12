import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  type Artifact,
  ARTIFACTS,
  BOARDING_CONTRACT,
  type ContractKind,
  instantiate,
  pairKeys,
  taprootAddress,
  walletBoardingTemplate,
} from "@hive/ark";

/** The delegatee's own Go derivation (tools/ark-vectors.ts) is the reference for every contract. */
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "vectors/derivations.json"), "utf8"),
) as {
  keys: { server: string; emulator: string; delegate: string };
  stewards: [string, string, string];
  pairs: Record<string, string>;
  cases: {
    name: string;
    kind: ContractKind | "boarding";
    args: Record<string, string>;
    expected: { pkScript: string; tapscripts: string[] };
  }[];
};

test("each contract derives the address and leaves the delegatee derives", () => {
  assert.deepEqual(pairKeys(vectors.stewards), vectors.pairs);
  for (const c of vectors.cases) {
    const artifact: Artifact = c.kind === "boarding" ? BOARDING_CONTRACT : ARTIFACTS[c.kind];
    const instance = instantiate(artifact, c.args, vectors.keys);
    assert.equal(instance.pkScript, c.expected.pkScript, c.name);
    assert.deepEqual(instance.tapscripts, c.expected.tapscripts, c.name);
  }
});

test("the wallet is the SimpleWallet artifact and the treasury keeps its renew leaf", () => {
  const walletRenew = ARTIFACTS.wallet.functions.find((f) => f.name === "renew");
  const treasuryRenew = ARTIFACTS.treasury.functions.find((f) => f.name === "renew");
  assert.deepEqual(treasuryRenew, walletRenew);
  assert.deepEqual(
    ARTIFACTS.treasury.functions.map((f) => f.name),
    ["exit01", "exit02", "exit12", "renew", "send01", "send02", "send12"],
  );
  assert.deepEqual(
    ARTIFACTS.escrow.functions.map((f) => f.name),
    ["exit01", "exit02", "exit12", "claim", "refund"],
  );
});

test("a changed constructor value moves the address", () => {
  const treasury = vectors.cases.find((c) => c.kind === "treasury")!;
  const other = instantiate(ARTIFACTS.treasury, { ...treasury.args, maxFee: "e803" }, vectors.keys);
  assert.notEqual(other.pkScript, treasury.expected.pkScript);
  assert.throws(() => instantiate(ARTIFACTS.treasury, { ...treasury.args, pair01: "00" }, vectors.keys));
  assert.throws(() => instantiate(ARTIFACTS.treasury, { ...treasury.args, extra: "00" }, vectors.keys));
});

test("a boarding address is the segwit v1 address of the boarding contract's script", () => {
  // Observed from the regtest delegatee for one wallet's boarding watch, October 10, 2026.
  assert.equal(
    taprootAddress("regtest", "5120a18d414cc07c70cbeac68314303af4386d10ae4bb62d157402f9db9fc203758c"),
    "bcrt1p5xx5znxq03cvh6kxsv2rqwh58pk3ptjtkck32aqzl8delssrwkxqa7mz7l",
  );
  const template = JSON.stringify(walletBoardingTemplate("ab".repeat(32)));
  assert.ok(!template.includes("SIMPLE_WALLET") && template.includes("ab".repeat(32)));
});
