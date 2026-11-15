import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad, bech32m, hex } from "@scure/base";

/**
 * What the treasury contract, the Hive service and the keeper page must agree on byte for byte:
 * the message each keeper approves, the keeper key as the contract holds it, the recipient's
 * Taproot program behind the address a keeper reads, and the Bitcoin key a passkey derives with
 * WebAuthn's PRF extension. Runs in Node and in the browser.
 */

export const PAY_TAG = "hive/treasury/pay/v1";

/** How every browser begins a WebAuthn assertion's clientDataJSON. */
export const CLIENT_PREFIX = '{"type":"webauthn.get","challenge":"';

/** Keeper kinds, as the contract's constructor numbers them. */
export const PASSKEY = 1;
export const RAW_P256 = 2;
export type KeeperKind = typeof PASSKEY | typeof RAW_P256;

/** The counter asset: its issuance txid in the Emulator's internal byte order, and its group. */
export interface Counter {
  assetId: string;
  txid: string;
  gidx: number;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const bytes = (v: string | Uint8Array) => (typeof v === "string" ? hex.decode(v) : v);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An unsigned little-endian integer of `width` bytes, as the script's num2bin writes a positive one. */
function le(n: number | bigint, width: number): Uint8Array {
  let v = BigInt(n);
  if (v < 0n || v >= 1n << BigInt(8 * width - 1)) throw new Error(`out of range for ${width} bytes`);
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

/**
 * The counter of an asset id as the SDK writes it (txid hex, then the group as two bytes). The
 * Emulator compares a script's asset txid with the packet's in internal byte order: the reverse of
 * the hex in the asset id.
 */
export function counterOf(assetId: string): Counter {
  if (!/^[0-9a-f]{68}$/.test(assetId)) throw new Error("not an asset id");
  const txid = hex.encode(hex.decode(assetId.slice(0, 64)).reverse());
  const gidx = Number.parseInt(assetId.slice(64, 66), 16) | (Number.parseInt(assetId.slice(66, 68), 16) << 8);
  return { assetId, txid, gidx };
}

/** One payment as the keepers approve it. */
export interface Payment {
  /** The counter units on the treasury coin when it pays: the payment's number. */
  left: bigint | number;
  amount: bigint | number;
  /** Unix seconds: the approval lapses then. */
  validUntil: number;
  /** The recipient's version-1 witness program. */
  program: string | Uint8Array;
}

/**
 * What each keeper approves: the treasury (its counter), the payment while `left` counter units
 * remain, `amount` sats, the time the approval lapses, and the version-1 witness program
 * `program`. The contract's `pay` rebuilds exactly these bytes.
 */
export function payMessage(counter: Pick<Counter, "txid" | "gidx">, payment: Payment): Uint8Array {
  const { left, amount, validUntil, program } = payment;
  const p = bytes(program);
  if (p.length !== 32) throw new Error("a Taproot program is 32 bytes");
  return sha256(
    concat(
      utf8(PAY_TAG),
      bytes(counter.txid),
      le(counter.gidx, 2),
      le(left, 8),
      le(amount, 8),
      le(validUntil, 8),
      p,
      Uint8Array.of(1),
    ),
  );
}

/** The challenge as the browser writes it in clientDataJSON, and as the contract rebuilds it. */
export const challengeOf = (message: Uint8Array): string => base64urlnopad.encode(message);

/** A keeper key as the contract holds it: 0x11 ‖ the compressed P-256 point. */
export function keeperKey(point: Uint8Array): Uint8Array {
  const compressed = p256.Point.fromBytes(point).toBytes(true);
  return concat(Uint8Array.of(0x11), compressed);
}

/** The keeper key of a passkey, from the SubjectPublicKeyInfo the browser returns at creation. */
export const keeperKeyFromSpki = (spki: Uint8Array): Uint8Array => keeperKey(spki.subarray(spki.length - 65));

/** The compressed P-256 point inside a keeper key. */
export function keeperPoint(key: string | Uint8Array): Uint8Array {
  const k = bytes(key);
  if (k.length !== 34 || k[0] !== 0x11) throw new Error("not a keeper key");
  return k.subarray(1);
}

export interface Recipient {
  kind: "arkade" | "bitcoin";
  network: string;
  /** The version-1 witness program the payment output carries. */
  program: Uint8Array;
}

/**
 * The recipient's Taproot program, from the address a keeper reads: an Arkade address (version ‖
 * operator key ‖ Taproot key) or a Bitcoin Taproot address.
 */
export function recipientOf(address: string): Recipient {
  const { prefix, words } = bech32m.decode(address as `${string}1${string}`, 1023);
  if (/^(bc|tb|bcrt)$/.test(prefix)) {
    if (words[0] !== 1) throw new Error("only Taproot addresses");
    const program = Uint8Array.from(bech32m.fromWords(words.slice(1)));
    if (program.length !== 32) throw new Error("a Taproot program is 32 bytes");
    return { kind: "bitcoin", network: prefix, program };
  }
  const data = Uint8Array.from(bech32m.fromWords(words));
  if (data.length !== 65) throw new Error("not an Arkade address");
  return { kind: "arkade", network: prefix, program: data.subarray(33, 65) };
}

/** The PRF input every keeper's passkey evaluates, giving the same secret each time. */
export const KEY_SALT = sha256(utf8("hive/keeper-key/v1"));

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * A keeper's Bitcoin key, from the passkey's PRF output: the key on the treasury's and escrows'
 * exit leaves (through the pairs' MuSig2 keys) and the one the keeper signs Hive's records with.
 * Nothing to back up beyond the passkey, and it exists only in the page that asked the passkey.
 * A scalar in [1, n-1] from 48 bytes of HKDF, so the reduction's bias is negligible.
 */
export function keeperSecret(prfOutput: Uint8Array): Uint8Array {
  const okm = hkdf(sha256, prfOutput, utf8("hive"), utf8("hive/keeper-key/v1"), 48);
  const v = BigInt(`0x${hex.encode(okm)}`) % (SECP256K1_N - 1n);
  return hex.decode((v + 1n).toString(16).padStart(64, "0"));
}

/** The keeper's Bitcoin key, compressed, as Hive's MuSig2 pairs and record signatures take it. */
export const bitcoinKeyOf = (prfOutput: Uint8Array): Uint8Array =>
  secp256k1.getPublicKey(keeperSecret(prfOutput), true);

/** What a keeper signs at enrollment with their Bitcoin key, proving the page derived it. */
export const enrollmentMessage = (hive: string, p256Key: Uint8Array): Uint8Array =>
  sha256(concat(utf8("hive/keeper-enroll/v1"), utf8(hive), Uint8Array.of(0), p256Key));

export { sha256 };
