import { decimal, exactObject, fail, hexField, MAX_SIGNED_64 } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export const RECEIPT_DOMAIN = "arkade-metered-escrow/v1";

export interface ReceiptBody {
  escrowId: string;
  amountSats: string;
}

export interface SignedReceipt extends ReceiptBody {
  signature: string;
}

export interface ReceiptContext {
  escrowId: string;
  payerReceiptKey: string;
  capSats: string;
}

/**
 * The contract checks `num2bin(amount, 8)`: a positive 8-byte ScriptNum, which
 * is unsigned little-endian below 2^63.
 */
export function encodeReceiptAmount(amountSats: string | bigint): Uint8Array {
  const amount = decimal(
    typeof amountSats === "bigint" ? amountSats.toString() : amountSats,
    "amountSats",
    1n,
  );
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, amount, true);
  return result;
}

export function receiptPreimage(escrowId: string, amountSats: string | bigint): Uint8Array {
  return concatBytes(
    utf8ToBytes(RECEIPT_DOMAIN),
    hexToBytes(hexField(escrowId, 32, "escrowId")),
    encodeReceiptAmount(amountSats),
  );
}

export function receiptDigest(escrowId: string, amountSats: string | bigint): Uint8Array {
  return sha256(receiptPreimage(escrowId, amountSats));
}

/** Receipt signing only; this key has no transaction or generic-message signer. */
export function signReceipt(value: ReceiptBody, secretKey: Uint8Array, auxRand?: Uint8Array): SignedReceipt {
  const body = parseReceiptBody(value);
  const signature = schnorr.sign(receiptDigest(body.escrowId, body.amountSats), secretKey, auxRand);
  return { ...body, signature: bytesToHex(signature) };
}

export function parseReceiptBody(value: unknown): ReceiptBody {
  const body = exactObject(value, ["escrowId", "amountSats"], "receipt");
  const escrowId = hexField(body.escrowId, 32, "escrowId");
  decimal(body.amountSats, "amountSats", 1n);
  return { escrowId, amountSats: body.amountSats as string };
}

export function parseSignedReceipt(value: unknown): SignedReceipt {
  const receipt = exactObject(value, ["escrowId", "amountSats", "signature"], "signed receipt");
  const body = parseReceiptBody({ escrowId: receipt.escrowId, amountSats: receipt.amountSats });
  return { ...body, signature: hexField(receipt.signature, 64, "receipt signature") };
}

export function requireValidReceipt(value: unknown, expected: ReceiptContext): SignedReceipt {
  const receipt = parseSignedReceipt(value);
  exactObject(expected, ["escrowId", "payerReceiptKey", "capSats"], "receipt context");
  const escrowId = hexField(expected.escrowId, 32, "expected escrowId");
  const publicKey = hexToBytes(hexField(expected.payerReceiptKey, 32, "payerReceiptKey"));
  const cap = decimal(expected.capSats, "capSats", 1n, MAX_SIGNED_64);
  if (receipt.escrowId !== escrowId) fail("RECEIPT_ESCROW_MISMATCH");
  if (BigInt(receipt.amountSats) > cap) fail("RECEIPT_EXCEEDS_CAP");
  const digest = receiptDigest(receipt.escrowId, receipt.amountSats);
  if (!schnorr.verify(hexToBytes(receipt.signature), digest, publicKey)) fail("RECEIPT_SIGNATURE");
  return receipt;
}

export function verifyReceipt(value: unknown, expected: ReceiptContext): boolean {
  try {
    requireValidReceipt(value, expected);
    return true;
  } catch {
    return false;
  }
}
