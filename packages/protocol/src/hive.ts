import { decimal, exactObject, fail, HIVE_ID, hexField, mainnetEnabled } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalBytes, canonicalJson, framed } from "./canonical.js";
import { compressedKey, p2trScript } from "./keys.js";
import type { HiveNetwork } from "./quote.js";

/**
 * A hive's public listing: what a directory shows and what a contributor
 * checks before chipping in. All three keepers sign it, each consenting to
 * keep this treasury under this name, so neither a host nor a directory can
 * list a hive its keepers did not agree to, or change what it says.
 */
export const HIVE_PROFILE = "hive-listing/v1";

export interface HiveListingBody {
  profile: typeof HIVE_PROFILE;
  network: HiveNetwork;
  /** The hive's path on a host, as `HIVE_ID` allows. */
  hive: string;
  name: string;
  purpose: string;
  /** The keepers' compressed keys, in the order the treasury's pairs are built. */
  stewardKeys: [string, string, string];
  treasuryScript: string;
  lightningAddress: string | null;
  createdAt: string;
}

export interface SignedHiveListing {
  body: HiveListingBody;
  listingId: string;
  /** One BIP340 signature over `listingId` per keeper, in `stewardKeys` order. */
  signatures: [string, string, string];
}

const FIELDS = [
  "profile",
  "network",
  "hive",
  "name",
  "purpose",
  "stewardKeys",
  "treasuryScript",
  "lightningAddress",
  "createdAt",
] as const;

/** Printable text without control characters, of bounded length. */
function text(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string") fail("INVALID", `${name} must be text`);
  const length = [...value].length;
  if (length < min || length > max) fail("INVALID", `${name} must be ${min} to ${max} characters`);
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029)
      fail("INVALID", `${name} has control characters`);
  }
  if (value.trim() !== value) fail("INVALID", `${name} has surrounding spaces`);
  return value;
}

const LIGHTNING_ADDRESS = /^[a-z0-9._-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*(:[0-9]{1,5})?$/;

export function parseHiveListingBody(value: unknown): HiveListingBody {
  canonicalJson(value);
  const raw = exactObject(value, FIELDS, "hive listing body");
  if (raw.profile !== HIVE_PROFILE) fail("INVALID", "listing profile");
  if (
    raw.network !== "regtest" &&
    raw.network !== "mutinynet" &&
    !(raw.network === "bitcoin" && mainnetEnabled())
  )
    fail("INVALID", "listing network");
  if (typeof raw.hive !== "string" || !HIVE_ID.test(raw.hive)) fail("INVALID", "hive id");
  text(raw.name, "name", 1, 64);
  text(raw.purpose, "purpose", 0, 280);
  if (!Array.isArray(raw.stewardKeys) || raw.stewardKeys.length !== 3) fail("INVALID", "three keeper keys");
  const keys = raw.stewardKeys.map((key, i) => compressedKey(key, `keeper key ${i + 1}`));
  // Keys equal up to parity would make a pair of one keeper.
  if (new Set(keys.map((key) => key.slice(2))).size !== 3) fail("INVALID", "keeper keys must differ");
  p2trScript(raw.treasuryScript, "treasuryScript");
  if (raw.lightningAddress !== null) {
    if (typeof raw.lightningAddress !== "string" || !LIGHTNING_ADDRESS.test(raw.lightningAddress))
      fail("INVALID", "lightning address");
  }
  decimal(raw.createdAt, "createdAt", 1n);
  return raw as unknown as HiveListingBody;
}

export function hiveListingId(body: HiveListingBody): string {
  return bytesToHex(sha256(framed(HIVE_PROFILE, Uint8Array.of(0), canonicalBytes(body))));
}

/** One keeper's signature over a listing. The key must be one of its three. */
export function signHiveListing(
  body: HiveListingBody,
  secretKey: Uint8Array,
): { keeper: number; signature: string } {
  const parsed = parseHiveListingBody(body);
  const own = bytesToHex(schnorr.getPublicKey(secretKey));
  const keeper = parsed.stewardKeys.findIndex((key) => key.slice(2) === own);
  if (keeper < 0) fail("LISTING_SIGNER", "not one of the hive's keepers");
  const signature = bytesToHex(
    schnorr.sign(hexToBytes(hiveListingId(parsed)), secretKey, new Uint8Array(32)),
  );
  return { keeper, signature };
}

/** A listing every keeper signed, or a fault naming what is wrong with it. */
export function validateHiveListing(value: unknown): SignedHiveListing {
  canonicalJson(value);
  const raw = exactObject(value, ["body", "listingId", "signatures"], "hive listing");
  const body = parseHiveListingBody(raw.body);
  if (raw.listingId !== hiveListingId(body)) fail("LISTING_DIGEST");
  if (!Array.isArray(raw.signatures) || raw.signatures.length !== 3)
    fail("LISTING_SIGNATURE", "three signatures");
  const signatures = raw.signatures.map((s, i) => hexField(s, 64, `signature ${i + 1}`)) as [
    string,
    string,
    string,
  ];
  signatures.forEach((signature, i) => {
    const key = hexToBytes(body.stewardKeys[i]!.slice(2));
    if (!schnorr.verify(hexToBytes(signature), hexToBytes(raw.listingId as string), key))
      fail("LISTING_SIGNATURE", `keeper ${i + 1}`);
  });
  return { body, listingId: raw.listingId as string, signatures };
}
