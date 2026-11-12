import { ensure, fail, hex, unhex } from "@hive/kit";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bech32m } from "@scure/base";
import { compactSize, concat, equalBytes } from "./encoding.js";

/** Taproot trees as btcd assembles them, Ark addresses and the Emulator's key tweak. */
export const taggedHash = (tag: string, ...parts: Uint8Array[]): Uint8Array =>
  schnorr.utils.taggedHash(tag, ...parts);

/** ark-lib's unspendable internal key. */
export const UNSPENDABLE_KEY = unhex("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");
const N = secp256k1.Point.CURVE().n;

const toBig = (bytes: Uint8Array): bigint => BigInt(`0x${hex(bytes) || "0"}`);

/** The x-only form of a compressed (or already x-only) key. */
export function xOnly(key: string): Uint8Array {
  const raw = unhex(key);
  if (raw.length === 32) {
    schnorr.utils.lift_x(toBig(raw));
    return raw;
  }
  ensure(raw.length === 33, "INVALID", "key must be 32 or 33 bytes");
  secp256k1.Point.fromHex(key);
  return raw.slice(1);
}

export const leafHash = (script: Uint8Array): Uint8Array =>
  taggedHash("TapLeaf", Uint8Array.of(0xc0), compactSize(script.length), script);

function branch(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [x, y] = hex(a) < hex(b) ? [a, b] : [b, a];
  return taggedHash("TapBranch", x, y);
}

/** btcd's AssembleTaprootScriptTree: leaves in pairs, an odd last leaf folded into the last pair, then a queue. */
export function treeRoot(leaves: Uint8Array[]): Uint8Array {
  const hashes = leaves.map(leafHash);
  if (hashes.length === 1) return hashes[0]!;
  const branches: Uint8Array[] = [];
  for (let i = 0; i < hashes.length; i += 2) {
    if (i === hashes.length - 1)
      branches[branches.length - 1] = branch(branches[branches.length - 1]!, hashes[i]!);
    else branches.push(branch(hashes[i]!, hashes[i + 1]!));
  }
  while (branches.length > 1) branches.push(branch(branches.shift()!, branches.shift()!));
  return branches[0]!;
}

/** The x-only output key of a script tree under the unspendable internal key. */
export function taprootOutput(leaves: Uint8Array[]): Uint8Array {
  const internal = schnorr.utils.lift_x(toBig(UNSPENDABLE_KEY));
  const t = toBig(taggedHash("TapTweak", UNSPENDABLE_KEY, treeRoot(leaves))) % N;
  return internal.add(secp256k1.Point.BASE.multiply(t)).toBytes(true).slice(1);
}

/** The Emulator's key for one covenant: even-y key plus tagged_hash("ArkScriptHash", covenant)·G. */
export function arkadeTweak(key: string, covenant: Uint8Array): Uint8Array {
  const base = schnorr.utils.lift_x(toBig(xOnly(key)));
  const t = toBig(taggedHash("ArkScriptHash", covenant)) % N;
  return base.add(secp256k1.Point.BASE.multiply(t)).toBytes(true).slice(1);
}

export const p2tr = (outputKey: Uint8Array): Uint8Array => concat([0x51, 0x20], outputKey);

export type Network = "regtest" | "mutinynet" | "bitcoin";
export const arkHrp = (network: Network): string => (network === "bitcoin" ? "ark" : "tark");

/** The chain's own HRP: a bitcoin address for an onchain contract such as a boarding address. */
export const chainHrp = (network: Network): string =>
  network === "bitcoin" ? "bc" : network === "mutinynet" ? "tb" : "bcrt";

/** A segwit v1 address for a P2TR script. */
export function taprootAddress(network: Network, pkScript: string): string {
  const script = unhex(pkScript);
  ensure(script.length === 34 && script[0] === 0x51 && script[1] === 0x20, "INVALID", "not a P2TR script");
  return bech32m.encode(chainHrp(network), [1, ...bech32m.toWords(script.slice(2))]);
}

/** An Ark address: version 0, the server's x-only key and the output key. */
export function arkAddress(network: Network, serverKey: string, pkScript: string): string {
  const script = unhex(pkScript);
  ensure(script.length === 34 && script[0] === 0x51 && script[1] === 0x20, "INVALID", "not a P2TR script");
  return bech32m.encode(
    arkHrp(network),
    bech32m.toWords(concat([0], xOnly(serverKey), script.slice(2))),
    1023,
  );
}

/** The P2TR script an Ark address pays; it must name `serverKey`. */
export function decodeArkAddress(network: Network, serverKey: string, address: string): string {
  const lower = address.trim().toLowerCase();
  ensure(lower.startsWith(`${arkHrp(network)}1`), "ADDRESS_INVALID", `not a ${network} Ark address`);
  let data: Uint8Array;
  try {
    data = bech32m.fromWords(bech32m.decode(lower as `${string}1${string}`, 1023).words);
  } catch {
    return fail("ADDRESS_INVALID", "bad Ark address");
  }
  ensure(data.length === 65 && data[0] === 0, "ADDRESS_INVALID", "unknown Ark address version");
  ensure(
    equalBytes(data.slice(1, 33), xOnly(serverKey)),
    "ADDRESS_INVALID",
    "the address names another server",
  );
  return hex(p2tr(data.slice(33)));
}

/** Any Ark address: its server's x-only key and the P2TR script it pays. */
export function parseArkAddress(address: string): { serverKey: string; pkScript: string } {
  const lower = address.trim().toLowerCase();
  ensure(lower.startsWith("ark1") || lower.startsWith("tark1"), "ADDRESS_INVALID", "not an Ark address");
  let data: Uint8Array;
  try {
    data = bech32m.fromWords(bech32m.decode(lower as `${string}1${string}`, 1023).words);
  } catch {
    return fail("ADDRESS_INVALID", "bad Ark address");
  }
  ensure(data.length === 65 && data[0] === 0, "ADDRESS_INVALID", "unknown Ark address version");
  return { serverKey: hex(data.slice(1, 33)), pkScript: hex(p2tr(data.slice(33))) };
}
