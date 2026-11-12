import assert from "node:assert/strict";
import { test } from "node:test";
import { combine, firstRound, pairKeys, pairSigners, secondRound, signTogether } from "@hive/ark";
import { faultCode, hex, unhex } from "@hive/kit";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const secrets = [0, 1, 2].map(() => secp256k1.utils.randomSecretKey());
const stewards = secrets.map((s) => hex(secp256k1.getPublicKey(s, true))) as [string, string, string];
const message = sha256(new TextEncoder().encode("attestation"));

test("each pair of stewards signs for its own key, and only for it", () => {
  const pairs = pairKeys(stewards);
  assert.equal(new Set(Object.values(pairs)).size, 3);
  const sig = signTogether([secrets[0]!, secrets[2]!], stewards, "02", message);
  assert.ok(schnorr.verify(unhex(sig), message, unhex(pairs["02"])));
  assert.ok(!schnorr.verify(unhex(sig), message, unhex(pairs["01"])));
  // Key order inside a pair does not matter.
  assert.equal(pairKeys([stewards[1], stewards[0], stewards[2]])["01"], pairs["01"]);
});

test("a partial signature from the wrong steward is refused", () => {
  const pairs = pairKeys(stewards);
  const signers = pairSigners(stewards, "01");
  const order = signers.map((k) => secrets.find((s) => hex(secp256k1.getPublicKey(s, true)) === hex(k))!);
  const rounds = order.map((s, i) => firstRound(s, hex(signers[i]!), pairs["01"], message));
  const nonces = rounds.map((r) => r.publicNonce);
  const partials = order.map((s, i) => secondRound(s, rounds[i]!, signers, nonces, message));
  assert.ok(
    schnorr.verify(
      unhex(combine(signers, nonces, partials, message, pairs["01"])),
      message,
      unhex(pairs["01"]),
    ),
  );
  const forged = [...partials];
  forged[1] = partials[0]!;
  assert.throws(
    () => combine(signers, nonces, forged, message, pairs["01"]),
    (e) => faultCode(e) === "PARTIAL_SIGNATURE_INVALID",
  );
});
