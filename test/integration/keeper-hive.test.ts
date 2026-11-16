import assert from "node:assert/strict";
import { test } from "node:test";
import { faultCode, hex } from "@hive/kit";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { nip19 } from "nostr-tools";
import { keepersOption } from "../../tools/ops.js";

/**
 * `--keepers`, as `pnpm ops init` takes it: the three keepers' Buzz keys, from which the v5 treasury
 * is built. The compressed keys keepers once made in the keeper console build nothing any more.
 */
const buzzKey = () => hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
const refused = async (value: string) => {
  try {
    await keepersOption(value);
    return "ok";
  } catch (error) {
    return faultCode(error) ?? (error instanceof Error ? error.message : String(error));
  }
};

test("a keepers' hive is built from three Buzz keys, npub or hex, in the hive's order", async () => {
  const keys = [buzzKey(), buzzKey(), buzzKey()];
  assert.deepEqual(await keepersOption(keys.join(",")), keys);
  assert.deepEqual(await keepersOption(keys.map((k) => nip19.npubEncode(k)).join(", ")), keys);
  assert.deepEqual(
    await keepersOption(` ${keys[0]!.toUpperCase()} ,${nip19.npubEncode(keys[1]!)},${keys[2]}`),
    keys,
  );
  for (const bad of [
    `${keys[0]},${keys[1]}`,
    `${keys[0]},${keys[0]},${keys[1]}`,
    `${keys[0]},${keys[1]},${"00".repeat(32)}`,
    `${keys[0]},${keys[1]},nsec1notakey`,
  ])
    assert.notEqual(await refused(bad), "ok", bad);
});

test("compressed keys, which built the treasury keepers signed for in the keeper console, build nothing now", async () => {
  const keys = [0, 1, 2].map(() => hex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)));
  assert.equal(await refused(keys.join(",")), "V4_KEEPERS");
  await assert.rejects(keepersOption(keys.join(", ")), /console and desk of commit ffb0839/);
  // One compressed key among Buzz keys is the same mistake.
  assert.equal(await refused(`${buzzKey()},${keys[0]},${buzzKey()}`), "V4_KEEPERS");
});
