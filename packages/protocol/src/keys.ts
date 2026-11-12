import { Fault, hexField } from "@hive/kit";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";

/** A 32-byte BIP340 key that lifts to a curve point. */
export function xOnlyKey(value: unknown, name: string): string {
  const encoded = hexField(value, 32, name);
  try {
    schnorr.utils.lift_x(BigInt(`0x${encoded}`));
  } catch {
    throw new Fault("INVALID", `${name} is not a curve point`);
  }
  return encoded;
}

export function compressedKey(value: unknown, name: string): string {
  const encoded = hexField(value, 33, name);
  if (!encoded.startsWith("02") && !encoded.startsWith("03"))
    throw new Fault("INVALID", `${name} must be compressed`);
  try {
    secp256k1.Point.fromBytes(hexToBytes(encoded)).assertValidity();
  } catch {
    throw new Fault("INVALID", `${name} is not a curve point`);
  }
  return encoded;
}

/** A P2TR output script whose witness program is a valid x-only key. */
export function p2trScript(value: unknown, name: string): string {
  const script = hexField(value, 34, name);
  if (!script.startsWith("5120")) throw new Fault("INVALID", `${name} must be a P2TR script`);
  xOnlyKey(script.slice(4), `${name} witness program`);
  return script;
}

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,255}$/;

export function modelId(value: unknown): string {
  if (typeof value !== "string" || !MODEL_PATTERN.test(value)) {
    throw new Fault("INVALID", "model must be an ASCII model identifier of at most 256 characters");
  }
  return value;
}
