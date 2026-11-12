import { createHmac } from "node:crypto";
import { AUTHORIZATION_GRACE_SECONDS, pairSigners } from "@hive/ark";
import { ensure, hex, readJsonIfPresent, sha256Hex, unhex, withLock, writeJson } from "@hive/kit";
import * as musig2 from "@scure/btc-signer/musig2.js";
import type { Steward } from "./config.js";
import type { Checked } from "./policy.js";
import type { SessionRequest } from "./purpose.js";

/**
 * A steward's half of a pair's MuSig2 signatures, in a worker process that
 * lives for one request. The first signer of a pair answers twice: its nonces,
 * then its partial signatures once the other's nonces are known. Its nonces
 * are derived again for the second call, from its key, the session and the
 * messages, so nothing secret is stored; what is stored is that the session
 * signed, and over which peer nonces, so the same nonces never sign twice. A
 * repeated call returns the same answer, so a coordinator that lost one
 * resumes the session. The second signer answers once, with BIP327's
 * deterministic signing, which binds its nonce to the first signer's.
 */
interface SessionState {
  pair: string;
  /** sha256 of the messages, binding the session id to them. */
  digest: string;
  stage: "nonce" | "signed";
  peerNonces?: string[];
  partials?: string[];
  until: number;
}

interface StewardState {
  schema: "hive-steward-state/v4";
  sessions: Record<string, SessionState>;
  /** Coins and quotes held by a session until its authorization ends. */
  reservations: Record<string, { holder: string; until: number }>;
  /** Requests bound to the one quote they fund, withdrawals to the one plan that pays them; never pruned. */
  bindings: Record<string, string>;
}

/** After its end, a reservation is kept this long: an Ark transaction signed in time may still finalize. */
const GRACE_SECONDS = AUTHORIZATION_GRACE_SECONDS;

const emptyState = (): StewardState => ({
  schema: "hive-steward-state/v4",
  sessions: {},
  reservations: {},
  bindings: {},
});

function digestOf(messages: Uint8Array[]): string {
  return sha256Hex(messages.map(hex).join(","));
}

function signersFor(steward: Steward, session: SessionRequest) {
  const signers = pairSigners(steward.config.stewardKeys, session.pair);
  const own = signers.findIndex((key) => hex(key) === steward.publicKey);
  ensure(own >= 0, "NOT_IN_PAIR");
  return { signers, own, aggKey: steward.pairs[session.pair] };
}

/** The first signer is the pair's first key in sorted order; the other signs last. */
export function isFirstSigner(steward: Steward, session: SessionRequest): boolean {
  return signersFor(steward, session).own === 0;
}

function nonces(steward: Steward, session: SessionRequest, messages: Uint8Array[]) {
  const { aggKey } = signersFor(steward, session);
  return messages.map((message, i) => {
    const rand = createHmac("sha256", Buffer.from(steward.secretKey))
      .update(`hive/musig-nonce/v1|${session.id}|${i}|${hex(message)}`)
      .digest();
    return musig2.nonceGen(
      unhex(steward.publicKey),
      steward.secretKey,
      unhex(aggKey),
      message,
      unhex(session.id),
      rand,
    );
  });
}

async function withState<T>(steward: Steward, action: (state: StewardState) => T): Promise<T> {
  const path = steward.config.statePath;
  return withLock(`${path}.lock`, async () => {
    const state = readJsonIfPresent<StewardState>(path) ?? emptyState();
    state.bindings ??= {};
    const result = action(state);
    writeJson(path, state);
    return result;
  });
}

function reserve(state: StewardState, checked: Checked, now: number) {
  if (checked.binds) {
    const { key, value, code } = checked.binds;
    const bound = state.bindings[key];
    ensure(bound === undefined || bound === value, code, key);
    state.bindings[key] = value;
  }
  const keys = [...checked.coins, ...(checked.quoteId ? [`quote:${checked.quoteId}`] : [])];
  for (const key of keys) {
    const held = state.reservations[key];
    ensure(!held || held.holder === checked.holder || held.until + GRACE_SECONDS <= now, "RESERVED", key);
  }
  for (const key of keys) state.reservations[key] = { holder: checked.holder, until: checked.until };
  for (const [key, held] of Object.entries(state.reservations))
    if (held.until + GRACE_SECONDS + 86_400 < now) delete state.reservations[key];
  for (const [id, s] of Object.entries(state.sessions)) if (s.until + 86_400 < now) delete state.sessions[id];
}

/** Round one for the first signer: its public nonces, bound to this session and these messages. */
export function firstNonces(
  steward: Steward,
  session: SessionRequest,
  checked: Checked,
  now: number,
): Promise<string[]> {
  ensure(isFirstSigner(steward, session), "WRONG_ROUND");
  const digest = digestOf(checked.messages);
  return withState(steward, (state) => {
    const existing = state.sessions[session.id];
    if (existing) ensure(existing.digest === digest && existing.pair === session.pair, "SESSION_MISMATCH");
    else {
      reserve(state, checked, now);
      state.sessions[session.id] = { pair: session.pair, digest, stage: "nonce", until: checked.until };
    }
    // The same public nonces, again, for a coordinator that lost the first answer. A signed
    // session then signs nothing new: `firstPartials` returns its saved partials or refuses.
    return nonces(steward, session, checked.messages).map((n) => hex(n.public));
  });
}

/** Round two for the first signer. Its nonces sign once: a retry with the same peer nonces gets the same answer. */
export function firstPartials(
  steward: Steward,
  session: SessionRequest,
  checked: Checked,
  peerNonces: string[],
): Promise<string[]> {
  const { signers } = signersFor(steward, session);
  ensure(isFirstSigner(steward, session) && peerNonces.length === checked.messages.length, "WRONG_ROUND");
  const digest = digestOf(checked.messages);
  return withState(steward, (state) => {
    const existing = state.sessions[session.id];
    ensure(existing && existing.digest === digest && existing.pair === session.pair, "SESSION_MISMATCH");
    if (existing.stage === "signed") {
      ensure(JSON.stringify(existing.peerNonces) === JSON.stringify(peerNonces), "SESSION_USED");
      return existing.partials!;
    }
    const own = nonces(steward, session, checked.messages);
    const partials = checked.messages.map((message, i) => {
      const aggNonce = musig2.nonceAggregate([own[i]!.public, unhex(peerNonces[i]!)]);
      return hex(new musig2.Session(aggNonce, signers, message).sign(own[i]!.secret, steward.secretKey));
    });
    state.sessions[session.id] = { ...existing, stage: "signed", peerNonces, partials };
    return partials;
  });
}

/** The second signer's only round: deterministic nonces and partials over the first signer's nonces. */
export async function lastSignature(
  steward: Steward,
  session: SessionRequest,
  checked: Checked,
  peerNonces: string[],
  now: number,
): Promise<{ publicNonces: string[]; partials: string[] }> {
  const { signers } = signersFor(steward, session);
  ensure(!isFirstSigner(steward, session) && peerNonces.length === checked.messages.length, "WRONG_ROUND");
  await withState(steward, (state) => {
    // Reserve on this steward too, so it never signs the same coins for two sessions.
    reserve(state, checked, now);
    state.sessions[session.id] ??= {
      pair: session.pair,
      digest: digestOf(checked.messages),
      stage: "signed",
      until: checked.until,
    };
    ensure(state.sessions[session.id]!.digest === digestOf(checked.messages), "SESSION_MISMATCH");
  });
  const out = checked.messages.map((message, i) =>
    musig2.deterministicSign(
      steward.secretKey,
      musig2.nonceAggregate([unhex(peerNonces[i]!)]),
      signers,
      message,
    ),
  );
  return { publicNonces: out.map((o) => hex(o.publicNonce)), partials: out.map((o) => hex(o.partialSig)) };
}
