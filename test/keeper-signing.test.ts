import assert from "node:assert/strict";
import { test } from "node:test";
import { type Pair, pairKeys } from "@hive/ark";
import { hex, unhex } from "@hive/kit";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import * as musig2 from "@scure/btc-signer/musig2.js";
import {
  assignShared,
  newSession,
  nonceBatch,
  record,
  type SecretNonce,
  type SharedNonce,
  signOver,
  signShared,
  verifyNonceBatch,
} from "../packages/steward/src/keeper.js";

const secrets = [0, 1, 2].map(() => secp256k1.utils.randomSecretKey());
const keys = secrets.map((s) => hex(musig2.IndividualPubkey(s))) as [string, string, string];

/** A keeper's console: its key, the secrets it keeps, and the pool the coordinator holds for it. */
function keeper(i: number) {
  const { batch, secrets: kept } = nonceBatch(secrets[i]!, 8);
  assert.ok(verifyNonceBatch(batch));
  const store = new Map(kept.map((s) => [s.id, s]));
  const pool = [...batch.nonces];
  return {
    secret: secrets[i]!,
    key: keys[i]!,
    take: (n: number): SharedNonce[] => pool.splice(0, n),
    /** The console hands over a secret once and forgets it before it signs. */
    use: (ids: string[]): SecretNonce[] =>
      ids.flatMap((id) => {
        const s = store.get(id);
        store.delete(id);
        return s ? [s] : [];
      }),
  };
}

const message = () => crypto.getRandomValues(new Uint8Array(32));

/**
 * A payment as the coordinator runs it: attest over `coins` messages, then register over one message
 * that only exists once attest is complete. `firstAct` is the keeper who opens the console first.
 */
function payment(pair: Pair, firstAct: number, secondAct: number, coins: number) {
  const k = [keeper(0), keeper(1), keeper(2)];
  const first = k[firstAct]!,
    second = k[secondAct]!;
  const attestMessages = Array.from({ length: coins }, message);
  const attest = newSession(keys, pair, attestMessages);
  // The first keeper signs at once, over the second's shared nonces.
  assignShared(attest, second.key, second.take);
  record(attest, keys, first.key, signOver(attest, first.secret, attestMessages));
  const unsigned = attest.signatures === undefined;
  assert.ok(unsigned, "one keeper alone signs nothing");
  // Hours later, the second keeper completes attest with the secrets their console kept...
  record(attest, keys, second.key, {
    partials: signShared(attest, second.secret, attestMessages, second.use(attest.pooled[second.key]!)),
  });
  assert.equal(attest.signatures?.length, coins);
  // ...and signs register in the same sitting, over the first keeper's shared nonces.
  const registerMessages = [message()];
  const register = newSession(keys, pair, registerMessages);
  assignShared(register, first.key, first.take);
  record(register, keys, second.key, signOver(register, second.secret, registerMessages));
  // The first keeper comes back once to finish.
  record(register, keys, first.key, {
    partials: signShared(register, first.secret, registerMessages, first.use(register.pooled[first.key]!)),
  });
  return { attest, register, aggKey: pairKeys(keys)[pair], attestMessages, registerMessages, k };
}

test("two keepers sign a payment hours apart, in either order, with every pair", () => {
  for (const [pair, a, b] of [
    ["01", 0, 1],
    ["01", 1, 0],
    ["02", 2, 0],
    ["12", 1, 2],
  ] as const) {
    const { attest, register, aggKey, attestMessages, registerMessages } = payment(pair, a, b, 3);
    for (const [i, sig] of attest.signatures!.entries())
      assert.ok(schnorr.verify(unhex(sig), attestMessages[i]!, unhex(aggKey)), `attest ${pair} ${i}`);
    assert.ok(
      schnorr.verify(unhex(register.signatures![0]!), registerMessages[0]!, unhex(aggKey)),
      `register ${pair}`,
    );
  }
});

test("a secret nonce signs once, nobody outside the pair signs, and a batch is only its keeper's", () => {
  const { attest, k } = payment("01", 0, 1, 1);
  // The coordinator asks again with nonces the console already used: there is nothing left to sign with.
  assert.throws(
    () => signShared(attest, k[1]!.secret, attest.messages.map(unhex), k[1]!.use(attest.pooled[k[1]!.key]!)),
    /NONCE_GONE/,
  );
  // A keeper outside the pair cannot take part.
  const session = newSession(keys, "01", [message()]);
  assert.throws(() => assignShared(session, keys[2], k[2]!.take), /NOT_IN_PAIR/);
  // Different messages than the session's are refused.
  assignShared(session, keys[1], k[1]!.take);
  assert.throws(() => signOver(session, secrets[0]!, [message()]), /MESSAGES_DIFFER/);
  // A partial that does not verify never makes a signature.
  const good = signOver(session, secrets[0]!, session.messages.map(unhex));
  record(session, keys, keys[0], good);
  assert.throws(
    () => record(session, keys, keys[1], { partials: [good.partials[0]!] }),
    /PARTIAL_SIGNATURE_INVALID/,
  );
  assert.equal(session.partials[keys[1]], undefined, "a refused partial is not kept");
  // A batch with someone else's nonces in it fails its signature.
  const { batch } = nonceBatch(secrets[0]!, 2);
  const forged = {
    ...batch,
    nonces: [...batch.nonces.slice(1), nonceBatch(secrets[2]!, 1).batch.nonces[0]!],
  };
  assert.equal(verifyNonceBatch(forged), false);
  assert.equal(verifyNonceBatch({ ...batch, keeper: keys[2] }), false);
});
