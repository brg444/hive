import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type TestContext, test } from "node:test";
import { pairKeys, parseArkAddress } from "@hive/ark";
import { faultCode, hex } from "@hive/kit";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  approvePurchase,
  initHive,
  opsPaths,
  parseKeeperKeys,
  withdrawTreasury,
  writeListing,
} from "../../tools/ops.js";
import { startFakeNetwork } from "../support/fake-network.js";

/** A hive whose keepers hold their own keys: built from the three keys they posted, keeping none of them. */
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
    return "ok";
  } catch (error) {
    return faultCode(error);
  }
};

async function setup(t: TestContext) {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 2 * 86_400 });
  t.after(() => fake.close());
  const hive = `keepers-${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(opsPaths(hive).local(), { recursive: true, force: true });
    rmSync(opsPaths(hive).secret(), { recursive: true, force: true });
  });
  const keys = [0, 1, 2].map(() => hex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)));
  return { fake, hive, keys };
}

test("a keepers' hive builds its treasury from their posted keys and keeps no steward key", async (t) => {
  const { fake, hive, keys } = await setup(t);
  const keepers = parseKeeperKeys(keys.map((k) => k.toUpperCase()).join(", "));
  const record = await initHive(hive, { network: "regtest", deployment: fake.deployment(), keepers }, {});
  assert.equal(record.keepersHold, true);
  assert.deepEqual(record.stewardKeys, keys);
  assert.deepEqual(record.treasury.pairs, pairKeys(keepers));
  assert.equal(parseArkAddress(record.treasuryAddress).pkScript, record.treasuryScript);
  assert.equal(fake.watchesOf(record.treasuryAddress).length, 1, "renewals need no keeper");
  for (const i of [0, 1, 2]) assert.equal(existsSync(opsPaths(hive).secret(`steward-${i}.json`)), false);
  // Signing here is refused with a pointer to the console, never attempted.
  assert.equal(await code(() => writeListing(hive, { name: "Keepers" })), "KEEPERS_SIGN");
  assert.equal(
    await code(approvePurchase(hive, "job", { provider: "p", capSats: "1000", timeoutSeconds: 600 })),
    "KEEPERS_SIGN",
  );
  assert.equal(
    await code(withdrawTreasury(hive, "out", { to: record.treasuryAddress, amount: "1000" })),
    "KEEPERS_SIGN",
  );
  // The same keys again give the same hive; another kind of hive under its name is refused.
  assert.deepEqual(
    await initHive(hive, { network: "regtest", deployment: fake.deployment(), keepers }, {}),
    record,
  );
});

test("keeper keys must be three distinct compressed points", () => {
  const key = hex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
  const other = hex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
  for (const bad of [
    `${key},${other}`,
    `${key},${key},${other}`,
    `${key},${other},${key.slice(2)}`,
    `${key},${other},02${"00".repeat(32)}`,
  ])
    assert.throws(
      () => parseKeeperKeys(bad),
      (e: unknown) => faultCode(e) !== undefined || e instanceof Error,
    );
});
