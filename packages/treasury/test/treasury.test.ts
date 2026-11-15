import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { type Artifact, instantiate, leafOf, pairKey } from "@hive/ark";
import {
  ApprovalRefused,
  approvalHolds,
  bitcoinKeyOf,
  CLIENT_PREFIX,
  challengeOf,
  counterOf,
  keeperKey,
  keeperSecret,
  originOf,
  PASSKEY,
  passkeyApproval,
  payMessage,
  RAW_P256,
  rawApproval,
  recipientOf,
  sha256,
  TREASURY_ARTIFACT,
  type TreasuryTerms,
  treasuryArguments,
} from "@hive/treasury";
import { p256 } from "@noble/curves/nist.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bech32m, hex } from "@scure/base";

const site = "keepers.example";
const ORIGIN = "https://keepers.example";
const utf8 = (s: string) => new TextEncoder().encode(s);
const N = p256.Point.CURVE().n;

/** A passkey as an authenticator holds one: it signs WebAuthn assertions for `rpId`. */
function passkey() {
  const secret = p256.utils.randomSecretKey();
  return {
    key: keeperKey(p256.getPublicKey(secret, false)),
    assert(
      message: Uint8Array,
      o: { rpId?: string; origin?: string; flags?: number; extra?: string; highS?: boolean } = {},
    ) {
      const authData = new Uint8Array([...sha256(utf8(o.rpId ?? site)), o.flags ?? 0x05, 0, 0, 0, 7]);
      const clientDataJSON = `${CLIENT_PREFIX}${challengeOf(message)}","origin":"${o.origin ?? ORIGIN}","crossOrigin":false${o.extra ?? ""}}`;
      const digest = sha256(new Uint8Array([...authData, ...sha256(utf8(clientDataJSON))]));
      let sig = p256.Signature.fromBytes(p256.sign(digest, secret, { prehash: false }), "compact");
      if (o.highS && sig.s < N / 2n) sig = new p256.Signature(sig.r, N - sig.s);
      return { authenticatorData: authData, clientDataJSON, signature: sig.toBytes("der") };
    },
  };
}

const counter = counterOf(`${"ab".repeat(30)}cdef0100`);
const program = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
const validUntil = 1_900_000_000;
const message = payMessage(counter, { left: 999n, amount: 20_000n, validUntil, program });

test("the counter's txid is the asset id's, reversed, and its group is little-endian", () => {
  assert.equal(counter.txid, `efcd${"ab".repeat(30)}`);
  assert.equal(counter.gidx, 1);
});

test("the message is the tag, the counter, units left, amount and program, as the contract writes them", () => {
  const le = (n: bigint, w: number) =>
    Uint8Array.from({ length: w }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
  const expected = sha256(
    new Uint8Array([
      ...utf8("hive/treasury/pay/v1"),
      ...hex.decode(counter.txid),
      1,
      0,
      ...le(999n, 8),
      ...le(20_000n, 8),
      ...le(BigInt(validUntil), 8),
      ...program,
      1,
    ]),
  );
  assert.deepEqual(message, expected);
  assert.notDeepEqual(
    payMessage(counter, { left: 998n, amount: 20_000n, validUntil, program }),
    message,
    "another payment number",
  );
  assert.notDeepEqual(
    payMessage(counter, { left: 999n, amount: 20_000n, validUntil: validUntil + 1, program }),
    message,
    "another lapse time",
  );
  assert.throws(() => payMessage(counter, { left: -1n, amount: 1n, validUntil, program }));
});

test("a passkey's approval of this payment, on this site, is accepted in the form pay takes", () => {
  const k = passkey();
  const a = passkeyApproval(k.key, message, site, k.assert(message));
  assert.equal(a.sig.length, 64);
  assert.equal(new TextDecoder().decode(a.tail), `","origin":"${ORIGIN}","crossOrigin":false}`);
  assert.ok(approvalHolds(PASSKEY, k.key, message, site, a));
  assert.ok(
    !approvalHolds(
      PASSKEY,
      k.key,
      payMessage(counter, { left: 998n, amount: 20_000n, validUntil, program }),
      site,
      a,
    ),
  );
});

test("a browser's extra fields after the challenge stay in the tail the contract hashes", () => {
  const k = passkey();
  const extra = `,"other_keys_can_be_added_here":"do not compare clientDataJSON against a template"`;
  const a = passkeyApproval(k.key, message, site, k.assert(message, { extra }));
  assert.ok(new TextDecoder().decode(a.tail).endsWith(`${extra}}`));
  assert.ok(approvalHolds(PASSKEY, k.key, message, site, a));
});

test("a high-S signature is made low, as the Emulator requires", () => {
  const k = passkey();
  const a = passkeyApproval(k.key, message, site, k.assert(message, { highS: true }));
  assert.ok(p256.Signature.fromBytes(a.sig, "compact").s <= N / 2n);
  assert.ok(approvalHolds(PASSKEY, k.key, message, site, a));
});

test("an approval of another payment, from another site, unverified or by another key is refused", () => {
  const k = passkey();
  const refused = (fn: () => unknown, reason: string) =>
    assert.throws(fn, (e: unknown) => e instanceof ApprovalRefused && e.reason === reason);
  const other = payMessage(counter, { left: 999n, amount: 20_001n, validUntil, program });
  refused(() => passkeyApproval(k.key, message, site, k.assert(other)), "ANOTHER_PAYMENT");
  refused(
    () => passkeyApproval(k.key, message, site, k.assert(message, { origin: "https://evil.example" })),
    "ANOTHER_SITE",
  );
  refused(
    () => passkeyApproval(k.key, message, site, k.assert(message, { rpId: "evil.example" })),
    "ANOTHER_SITE",
  );
  refused(
    () => passkeyApproval(k.key, message, site, k.assert(message, { flags: 0x01 })),
    "KEEPER_NOT_VERIFIED",
  );
  refused(() => passkeyApproval(passkey().key, message, site, k.assert(message)), "BAD_SIGNATURE");
});

test("a passkey approves only from a page of its own site, over https or on this machine", () => {
  assert.ok(originOf("keepers.example", "https://keepers.example"));
  assert.ok(originOf("keepers.example", "https://console.keepers.example"));
  assert.ok(originOf("localhost", "http://localhost:8788"));
  assert.ok(!originOf("keepers.example", "http://keepers.example"));
  assert.ok(!originOf("keepers.example", "https://keepers.example.evil"));
  assert.ok(!originOf("keepers.example", "https://evilkeepers.example"));
  assert.ok(!originOf("localhost", "http://localhost:8788/"));
});

test("a raw P-256 key approves with a signature over sha256 of the message, compact or DER", () => {
  const secret = p256.utils.randomSecretKey();
  const key = keeperKey(p256.getPublicKey(secret, true));
  const compact = p256.sign(message, secret); // prehash: sha256 of the message
  const a = rawApproval(key, message, compact);
  assert.ok(approvalHolds(RAW_P256, key, message, site, a));
  assert.deepEqual(
    rawApproval(key, message, p256.Signature.fromBytes(compact, "compact").toBytes("der")).sig,
    a.sig,
  );
  assert.throws(
    () => rawApproval(key, payMessage(counter, { left: 1n, amount: 1n, validUntil, program }), compact),
    ApprovalRefused,
  );
});

test("the recipient's program comes from an Arkade address or a Bitcoin Taproot address", () => {
  const arkade = bech32m.encode(
    "tark",
    bech32m.toWords(new Uint8Array([0, ...new Uint8Array(32).fill(9), ...program])),
    1023,
  );
  assert.deepEqual(recipientOf(arkade), { kind: "arkade", network: "tark", program });
  const taproot = bech32m.encode("bcrt", [1, ...bech32m.toWords(program)]);
  assert.deepEqual(recipientOf(taproot), { kind: "bitcoin", network: "bcrt", program });
  assert.throws(() => recipientOf(bech32m.encode("bcrt", [0, ...bech32m.toWords(new Uint8Array(32))])));
});

test("a passkey's PRF output gives the keeper the same Bitcoin key every time, and another gives another", () => {
  const prf = new Uint8Array(32).fill(3);
  assert.deepEqual(keeperSecret(prf), keeperSecret(new Uint8Array(32).fill(3)));
  assert.notDeepEqual(keeperSecret(prf), keeperSecret(new Uint8Array(32).fill(4)));
  assert.deepEqual(bitcoinKeyOf(prf), secp256k1.getPublicKey(keeperSecret(prf), true));
});

test("Hive builds the v5 treasury from its keepers, with v4's exit leaves over their Bitcoin keys", () => {
  const vectors = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../ark/test/vectors/derivations.json"), "utf8"),
  ) as { keys: { server: string; emulator: string; delegate: string } };
  const prfs = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
  const keepers = prfs.map((prf, i) => ({
    site: i === 1 ? "localhost" : site,
    kind: i === 2 ? RAW_P256 : PASSKEY,
    key: hex.encode(keeperKey(p256.getPublicKey(p256.utils.randomSecretKey(), true))),
    bitcoinKey: hex.encode(bitcoinKeyOf(prf)),
  })) as unknown as TreasuryTerms["keepers"];
  const terms: TreasuryTerms = {
    keepers,
    counter,
    delegateKey: vectors.keys.delegate,
    renewalWindowSeconds: 86_400,
    maxFeeSats: 2_000,
    exitDelaySeconds: 86_016,
  };
  const instance = instantiate(
    TREASURY_ARTIFACT as unknown as Artifact,
    treasuryArguments(terms),
    vectors.keys,
  );
  assert.match(instance.pkScript, /^5120[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(instance.covenants).sort(), ["merge", "pay", "renew"]);
  const pair01 = pairKey(keepers[0].bitcoinKey, keepers[1].bitcoinKey);
  assert.ok(leafOf(instance, "exit01").includes(pair01), "the first pair's MuSig2 key is on its exit leaf");
  assert.ok(
    instance.covenants.renew &&
      hex.encode(instance.covenants.renew).includes(hex.encode(utf8(vectors.keys.delegate))),
  );
  assert.throws(() => treasuryArguments({ ...terms, keepers: [keepers[0], keepers[0], keepers[2]] }));
  assert.throws(() =>
    treasuryArguments({
      ...terms,
      keepers: [{ ...keepers[0], site: "https://evil" }, keepers[1], keepers[2]],
    }),
  );
  // The Emulator runs a covenant of at most 10,000 bytes.
  for (const [fn, script] of Object.entries(instance.covenants))
    assert.ok(script.length < 10_000, `${fn} fits`);
});
