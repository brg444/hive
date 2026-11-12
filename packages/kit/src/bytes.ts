import { createHash } from "node:crypto";
import { Fault } from "./fault.js";

export function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export function unhex(value: string): Uint8Array {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})*$/.test(value))
    throw new Fault("INVALID", "not lowercase hex");
  return Uint8Array.from(Buffer.from(value, "hex"));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Base64 that round-trips exactly, so two encodings cannot name one payload. */
export function strictBase64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Fault("INVALID", "base64 payload missing or too large");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > maxBytes) {
    throw new Fault("INVALID", "noncanonical base64");
  }
  return bytes;
}
