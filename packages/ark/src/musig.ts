import { ensure, hex, unhex } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import * as musig2 from "@scure/btc-signer/musig2.js";

/**
 * A two-of-three is three two-of-two owners: each pair of stewards shares one
 * BIP327 MuSig2 key, which owns an exit leaf and checks the pair's
 * authorizations in the covenants. Signing takes two rounds between the pair.
 */
export const PAIRS = ["01", "02", "12"] as const;
export type Pair = (typeof PAIRS)[number];

export const pairMembers = (pair: Pair): [number, number] => [Number(pair[0]), Number(pair[1])];

/** The pair's aggregate key, x-only hex, over the two compressed steward keys in sorted order. */
export function pairKey(a: string, b: string): string {
  ensure(a !== b, "INVALID", "a pair needs two keys");
  const keys = musig2.sortKeys([unhex(a), unhex(b)]);
  return hex(musig2.keyAggExport(musig2.keyAggregate(keys)));
}

export function pairKeys(stewards: readonly [string, string, string]): Record<Pair, string> {
  return Object.fromEntries(
    PAIRS.map((pair) => {
      const [i, j] = pairMembers(pair);
      return [pair, pairKey(stewards[i]!, stewards[j]!)];
    }),
  ) as Record<Pair, string>;
}

/** The two compressed keys of `pair`, in the order the aggregate used. */
export const pairSigners = (stewards: readonly [string, string, string], pair: Pair): Uint8Array[] => {
  const [i, j] = pairMembers(pair);
  return musig2.sortKeys([unhex(stewards[i]!), unhex(stewards[j]!)]);
};

export interface NonceRound {
  publicNonce: string;
  /** Kept by the signer between rounds; never leaves its process. */
  secretNonce: Uint8Array;
}

/** Round one for one message: a fresh nonce bound to the signer, the pair key and the message. */
export function firstRound(
  secretKey: Uint8Array,
  publicKey: string,
  aggKey: string,
  message: Uint8Array,
): NonceRound {
  const nonce = musig2.nonceGen(unhex(publicKey), secretKey, unhex(aggKey), message);
  return { publicNonce: hex(nonce.public), secretNonce: nonce.secret };
}

/** Round two: this signer's partial signature once both public nonces are known. */
export function secondRound(
  secretKey: Uint8Array,
  round: NonceRound,
  signers: Uint8Array[],
  publicNonces: string[],
  message: Uint8Array,
): string {
  const session = new musig2.Session(musig2.nonceAggregate(publicNonces.map(unhex)), signers, message);
  const partial = session.sign(round.secretNonce, secretKey);
  // A nonce is single use: wipe it as soon as it has signed.
  round.secretNonce.fill(0);
  return hex(partial);
}

/** The BIP340 signature both partials make, checked against the pair key before it is used. */
export function combine(
  signers: Uint8Array[],
  publicNonces: string[],
  partials: string[],
  message: Uint8Array,
  aggKey: string,
): string {
  const session = new musig2.Session(musig2.nonceAggregate(publicNonces.map(unhex)), signers, message);
  partials.forEach((partial, i) => {
    ensure(
      session.partialSigVerify(unhex(partial), publicNonces.map(unhex), i),
      "PARTIAL_SIGNATURE_INVALID",
      `signer ${i}`,
    );
  });
  const signature = session.partialSigAgg(partials.map(unhex));
  ensure(
    schnorr.verify(signature, message, unhex(aggKey)),
    "SIGNATURE_INVALID",
    "the pair signature does not verify",
  );
  return hex(signature);
}

/** Both rounds in one process, for tests and for a hive whose stewards share a machine. */
export function signTogether(
  secrets: [Uint8Array, Uint8Array],
  stewards: readonly [string, string, string],
  pair: Pair,
  message: Uint8Array,
): string {
  const signers = pairSigners(stewards, pair);
  const aggKey = pairKeys(stewards)[pair];
  const ordered = signers.map((key) => {
    const secret = secrets.find((s) => hex(musig2.IndividualPubkey(s)) === hex(key));
    ensure(secret, "INVALID", "secret for a pair member missing");
    return secret;
  });
  const rounds = ordered.map((secret, i) => firstRound(secret, hex(signers[i]!), aggKey, message));
  const nonces = rounds.map((r) => r.publicNonce);
  const partials = ordered.map((secret, i) => secondRound(secret, rounds[i]!, signers, nonces, message));
  return combine(signers, nonces, partials, message, aggKey);
}
