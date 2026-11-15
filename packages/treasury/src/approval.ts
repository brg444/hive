import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { CLIENT_PREFIX, challengeOf, type KeeperKind, keeperPoint, PASSKEY, RAW_P256 } from "./message.js";

/**
 * One keeper's approval as the contract's `pay` takes it: the signature, compact and low-S, and
 * for a passkey the authenticator data and what follows the challenge in clientDataJSON.
 */
export interface Approval {
  sig: Uint8Array;
  authData: Uint8Array;
  tail: Uint8Array;
}

/** What a passkey's assertion carries, as the keeper page posts it. */
export interface Assertion {
  authenticatorData: Uint8Array;
  clientDataJSON: string;
  /** DER, as WebAuthn returns it. */
  signature: Uint8Array;
}

export class ApprovalRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ApprovalRefused";
  }
}

const N = p256.Point.CURVE().n;
const empty = new Uint8Array(0);
const utf8 = (s: string) => new TextEncoder().encode(s);

/** (r, s) with s made low, as the Emulator requires. */
export function compactLowS(signature: Uint8Array, format: "der" | "compact"): Uint8Array {
  const sig = p256.Signature.fromBytes(signature, format);
  const s = sig.s > N / 2n ? N - sig.s : sig.s;
  return new p256.Signature(sig.r, s).toBytes("compact");
}

function verifies(sig: Uint8Array, digest: Uint8Array, key: Uint8Array | string): boolean {
  try {
    return p256.verify(sig, digest, keeperPoint(key), { prehash: false, lowS: true });
  } catch {
    return false;
  }
}

/** Whether a page at `origin` may use passkeys of `site`: on that domain, over https or on this machine. */
export function originOf(site: string, origin: unknown): boolean {
  let url: URL;
  try {
    url = new URL(String(origin));
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  const local = site === "localhost" && url.protocol === "http:";
  return (url.protocol === "https:" || local) && (url.hostname === site || url.hostname.endsWith(`.${site}`));
}

/**
 * Checks a passkey's assertion exactly as the contract will, and as a browser would: the challenge
 * is this payment's message, made by the keeper's passkey for their site on a page of that site,
 * with the keeper present and verified, and signed by the keeper's key. Returns the approval in the
 * form `pay` takes, or throws ApprovalRefused.
 */
export function passkeyApproval(
  key: Uint8Array | string,
  message: Uint8Array,
  site: string,
  assertion: Assertion,
): Approval {
  const { authenticatorData: authData, clientDataJSON } = assertion;
  if (!clientDataJSON.startsWith(CLIENT_PREFIX)) throw new ApprovalRefused("NOT_AN_ASSERTION");
  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    client = JSON.parse(clientDataJSON);
  } catch {
    throw new ApprovalRefused("NOT_AN_ASSERTION");
  }
  const challenge = challengeOf(message);
  if (client.type !== "webauthn.get" || client.challenge !== challenge)
    throw new ApprovalRefused("ANOTHER_PAYMENT");
  if (!originOf(site, client.origin) || client.crossOrigin === true)
    throw new ApprovalRefused("ANOTHER_SITE");
  // The contract reads the challenge at a fixed place: right after the prefix, closed by a quote.
  const tail = utf8(clientDataJSON.slice(CLIENT_PREFIX.length + challenge.length));
  if (tail[0] !== 0x22) throw new ApprovalRefused("NOT_AN_ASSERTION");
  if (authData.length < 37 || hex.encode(authData.subarray(0, 32)) !== hex.encode(sha256(utf8(site))))
    throw new ApprovalRefused("ANOTHER_SITE");
  if ((authData[32]! & 0x05) !== 0x05) throw new ApprovalRefused("KEEPER_NOT_VERIFIED");
  let sig: Uint8Array;
  try {
    sig = compactLowS(assertion.signature, "der");
  } catch {
    throw new ApprovalRefused("BAD_SIGNATURE");
  }
  const digest = sha256(new Uint8Array([...authData, ...sha256(utf8(clientDataJSON))]));
  if (!verifies(sig, digest, key)) throw new ApprovalRefused("BAD_SIGNATURE");
  return { sig, authData, tail };
}

/** A raw P-256 key's approval: a signature over sha256 of the message, as a Secure Enclave makes it. */
export function rawApproval(key: Uint8Array | string, message: Uint8Array, signature: Uint8Array): Approval {
  let sig: Uint8Array;
  try {
    sig = compactLowS(signature, signature.length === 64 ? "compact" : "der");
  } catch {
    throw new ApprovalRefused("BAD_SIGNATURE");
  }
  if (!verifies(sig, sha256(message), key)) throw new ApprovalRefused("BAD_SIGNATURE");
  return { sig, authData: empty, tail: empty };
}

/** Rechecks a stored approval against the keeper it is filed under, before it is spent. */
export function approvalHolds(
  kind: KeeperKind,
  key: Uint8Array | string,
  message: Uint8Array,
  site: string,
  a: Approval,
): boolean {
  if (kind === RAW_P256) return verifies(a.sig, sha256(message), key);
  if (kind !== PASSKEY) return false;
  const client = new TextEncoder().encode(CLIENT_PREFIX + challengeOf(message));
  const digest = sha256(new Uint8Array([...a.authData, ...sha256(new Uint8Array([...client, ...a.tail]))]));
  return (
    hex.encode(a.authData.subarray(0, 32)) === hex.encode(sha256(utf8(site))) &&
    (a.authData[32]! & 0x05) === 0x05 &&
    a.tail[0] === 0x22 &&
    verifies(a.sig, digest, key)
  );
}
