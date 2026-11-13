import { combine, type Pair, pairKeys, pairSigners } from "@hive/ark";
import { ensure, hex, sha256Hex, unhex } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import * as musig2 from "@scure/btc-signer/musig2.js";

/**
 * Two keepers sign a treasury payment by hand, hours apart and in either order, each opening the
 * keeper console when it suits them. A pair signs as one MuSig2 key, which takes nonces from both
 * before either partial signature: so each keeper's console shares nonces ahead of time, which
 * authorize nothing, and keeps their secret halves until it signs.
 *
 * A payment takes two sessions. `attest` signs one message per coin; `register` signs the
 * delegation service's request, which names the attest signatures, so it can only start once
 * attest is complete. Whoever acts first signs attest at once, deterministically over the other's
 * shared nonces. The second keeper completes attest with their own shared nonces and, in the same
 * sitting, signs register deterministically over the first keeper's. The first keeper then finishes
 * register: the only time a keeper acts twice, and it decides nothing new.
 *
 * A secret nonce signs once. The console deletes it before it signs, and the coordinator gives a
 * nonce to one session only, so a coordinator that asked twice gets nothing it could combine.
 */

export const NONCE_BATCH_TAG = "hive/keeper-nonces/v1";
export const DESK_TAG = "hive-desk/v1";

/** The digest a keeper signs to ask the signing desk for something: start or cancel a payment. */
export const deskAuthDigest = (hive: string, action: string, jobId: string, at: number): Uint8Array =>
  unhex(sha256Hex(`${DESK_TAG}|${hive}|${action}|${jobId}|${at}`));

/** One shared nonce, as the coordinator holds it. */
export interface SharedNonce {
  id: string;
  publicNonce: string;
}

/** A keeper's nonces, signed with their key, so nobody else can hand the coordinator nonces in their name. */
export interface NonceBatch {
  keeper: string;
  nonces: SharedNonce[];
  signature: string;
}

/** What the console keeps until it signs: the secret halves, by id. */
export interface SecretNonce {
  id: string;
  secretNonce: string;
}

const batchDigest = (keeper: string, nonces: SharedNonce[]) =>
  unhex(sha256Hex(`${NONCE_BATCH_TAG}|${keeper}|${nonces.map((n) => `${n.id}:${n.publicNonce}`).join(",")}`));

/** New nonces for later sessions: the batch to share, and the secrets to keep. */
export function nonceBatch(
  secretKey: Uint8Array,
  count: number,
): { batch: NonceBatch; secrets: SecretNonce[] } {
  ensure(Number.isSafeInteger(count) && count >= 1 && count <= 256, "INVALID", "nonce count");
  const keeper = hex(musig2.IndividualPubkey(secretKey));
  const made = Array.from({ length: count }, () => {
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    // Bound to the keeper's key, and fresh randomness; not to a message, which is unknown yet.
    const nonce = musig2.nonceGen(unhex(keeper), secretKey, new Uint8Array(0), undefined, unhex(id));
    return { id, publicNonce: hex(nonce.public), secretNonce: hex(nonce.secret) };
  });
  const nonces = made.map(({ id, publicNonce }) => ({ id, publicNonce }));
  const signature = hex(schnorr.sign(batchDigest(keeper, nonces), secretKey));
  return {
    batch: { keeper, nonces, signature },
    secrets: made.map(({ id, secretNonce }) => ({ id, secretNonce })),
  };
}

/** Whether a batch is the keeper's own. */
export function verifyNonceBatch(batch: NonceBatch): boolean {
  if (!/^0[23][0-9a-f]{64}$/.test(batch.keeper) || !batch.nonces.length) return false;
  if (!batch.nonces.every((n) => /^[0-9a-f]{32}$/.test(n.id) && /^[0-9a-f]{132}$/.test(n.publicNonce)))
    return false;
  return schnorr.verify(
    unhex(batch.signature),
    batchDigest(batch.keeper, batch.nonces),
    unhex(batch.keeper.slice(2)),
  );
}

/** One session between a pair over some messages, as the coordinator keeps it. */
export interface PairSession {
  pair: Pair;
  /** The two keepers' compressed keys, in the order the pair key aggregates them. */
  signers: [string, string];
  messages: string[];
  /** Each signer's public nonces, one per message. */
  nonces: Partial<Record<string, string[]>>;
  /** For a signer whose nonces were shared ahead of time: which ones, so the console finds their secrets. */
  pooled: Partial<Record<string, string[]>>;
  partials: Partial<Record<string, string[]>>;
  signatures?: string[];
}

export function newSession(
  keepers: readonly [string, string, string],
  pair: Pair,
  messages: Uint8Array[],
): PairSession {
  ensure(messages.length >= 1 && messages.length <= 16, "INVALID", "message count");
  const signers = pairSigners(keepers, pair).map(hex) as [string, string];
  return { pair, signers, messages: messages.map(hex), nonces: {}, pooled: {}, partials: {} };
}

const other = (session: PairSession, keeper: string) => {
  ensure(session.signers.includes(keeper), "NOT_IN_PAIR");
  return session.signers.find((k) => k !== keeper)!;
};

/**
 * Gives the session one of `keeper`'s shared nonces per message, for the other keeper to sign over.
 * `take` hands out unused nonces and must never hand the same one out again.
 */
export function assignShared(
  session: PairSession,
  keeper: string,
  take: (count: number) => SharedNonce[],
): void {
  ensure(session.signers.includes(keeper), "NOT_IN_PAIR");
  ensure(!session.nonces[keeper], "NONCES_ASSIGNED");
  const taken = take(session.messages.length);
  ensure(
    taken.length === session.messages.length,
    "NO_NONCES",
    "the keeper has no shared nonces left: open the console to share more",
  );
  session.nonces[keeper] = taken.map((n) => n.publicNonce);
  session.pooled[keeper] = taken.map((n) => n.id);
}

/** The keeper who signs over the other's shared nonces: their nonces and partials come together, from their key. */
export function signOver(
  session: PairSession,
  secretKey: Uint8Array,
  messages: Uint8Array[],
): { nonces: string[]; partials: string[] } {
  const keeper = hex(musig2.IndividualPubkey(secretKey));
  const peer = other(session, keeper);
  const peerNonces = session.nonces[peer];
  ensure(peerNonces && !session.nonces[keeper], "WRONG_ROUND");
  ensure(
    messages.length === session.messages.length && messages.every((m, i) => hex(m) === session.messages[i]),
    "MESSAGES_DIFFER",
  );
  const signers = session.signers.map(unhex);
  const out = messages.map((message, i) =>
    musig2.deterministicSign(secretKey, musig2.nonceAggregate([unhex(peerNonces[i]!)]), signers, message),
  );
  return { nonces: out.map((o) => hex(o.publicNonce)), partials: out.map((o) => hex(o.partialSig)) };
}

/** The keeper whose shared nonces the other signed over: their partials, from the secrets the console kept. */
export function signShared(
  session: PairSession,
  secretKey: Uint8Array,
  messages: Uint8Array[],
  secrets: SecretNonce[],
): string[] {
  const keeper = hex(musig2.IndividualPubkey(secretKey));
  const peer = other(session, keeper);
  const own = session.nonces[keeper],
    ids = session.pooled[keeper],
    peerNonces = session.nonces[peer];
  ensure(own && ids && peerNonces, "WRONG_ROUND");
  ensure(
    messages.length === session.messages.length && messages.every((m, i) => hex(m) === session.messages[i]),
    "MESSAGES_DIFFER",
  );
  const signers = session.signers.map(unhex);
  return messages.map((message, i) => {
    const secret = secrets.find((s) => s.id === ids[i]);
    ensure(secret, "NONCE_GONE", "this nonce was used or never kept here");
    const ordered = session.signers.map((k) => (k === keeper ? own[i]! : peerNonces[i]!)).map(unhex);
    return hex(
      new musig2.Session(musig2.nonceAggregate(ordered), signers, message).sign(
        unhex(secret.secretNonce),
        secretKey,
      ),
    );
  });
}

/** Records a keeper's contribution, and once both have signed, the pair's signatures, each checked against the pair key. */
export function record(
  session: PairSession,
  keepers: readonly [string, string, string],
  keeper: string,
  contribution: { nonces?: string[]; partials: string[] },
): PairSession {
  ensure(session.signers.includes(keeper) && !session.partials[keeper], "WRONG_ROUND");
  ensure(contribution.partials.length === session.messages.length, "INVALID", "partial count");
  if (contribution.nonces) {
    ensure(!session.nonces[keeper] && contribution.nonces.length === session.messages.length, "WRONG_ROUND");
  }
  const nonces = contribution.nonces ?? session.nonces[keeper];
  const peerNonces = session.nonces[other(session, keeper)];
  ensure(nonces && peerNonces, "WRONG_ROUND");
  // Each partial is checked on arrival, so a bad one is refused and never stored.
  const signers = session.signers.map(unhex);
  const index = session.signers.indexOf(keeper);
  contribution.partials.forEach((partial, i) => {
    const ordered = session.signers.map((k) => (k === keeper ? nonces[i]! : peerNonces[i]!)).map(unhex);
    const check = new musig2.Session(musig2.nonceAggregate(ordered), signers, unhex(session.messages[i]!));
    ensure(
      /^[0-9a-f]{64}$/.test(partial) && check.partialSigVerify(unhex(partial), ordered, index),
      "PARTIAL_SIGNATURE_INVALID",
      `message ${i}`,
    );
  });
  session.nonces[keeper] = nonces;
  session.partials[keeper] = contribution.partials;
  const [a, b] = session.signers;
  if (session.partials[a] && session.partials[b]) {
    const signers = session.signers.map(unhex);
    const aggKey = pairKeys(keepers)[session.pair];
    session.signatures = session.messages.map((m, i) =>
      combine(
        signers,
        [session.nonces[a]![i]!, session.nonces[b]![i]!],
        [session.partials[a]![i]!, session.partials[b]![i]!],
        unhex(m),
        aggKey,
      ),
    );
  }
  return session;
}
