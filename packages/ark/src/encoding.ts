import { fail } from "@hive/kit";

/** Byte helpers shared by scripts, taproot trees and signed messages. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Unsigned little-endian integer of `size` bytes. */
export function le(value: number | bigint, size: number): Uint8Array {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << BigInt(8 * size)) fail("INVALID", `value does not fit ${size} bytes`);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

export const be64 = (value: number | bigint): Uint8Array => le(value, 8).reverse();

/** Minimal Script number, as the contract reads an int; zero is empty. */
export function scriptNum(value: number | bigint): Uint8Array {
  let v = BigInt(value);
  if (v === 0n) return new Uint8Array();
  const negative = v < 0n;
  if (negative) v = -v;
  const out: number[] = [];
  for (; v > 0n; v >>= 8n) out.push(Number(v & 0xffn));
  if (out[out.length - 1]! & 0x80) out.push(negative ? 0x80 : 0);
  else if (negative) out[out.length - 1]! |= 0x80;
  return Uint8Array.from(out);
}

/** Reads a minimally encoded Script number. */
export function decodeScriptNum(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  const last = bytes[bytes.length - 1]!;
  if ((last & 0x7f) === 0 && (bytes.length === 1 || !(bytes[bytes.length - 2]! & 0x80)))
    fail("INVALID", "non-minimal script number");
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--)
    v = (v << 8n) | BigInt(i === bytes.length - 1 ? last & 0x7f : bytes[i]!);
  return last & 0x80 ? -v : v;
}

export function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return concat([0xfd], le(n, 2));
  return concat([0xfe], le(n, 4));
}

/** BIP68 relative locktime as arkd counts it: seconds from 512 on, blocks below. */
export function sequence(delaySeconds: number): number {
  return delaySeconds >= 512 ? (1 << 22) | Math.floor(delaySeconds / 512) : delaySeconds;
}

const OP_0 = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_1NEGATE = 0x4f;
const OP_1 = 0x51;

/** btcd's ScriptBuilder: canonical pushes, small integers as opcodes. */
export class ScriptBuilder {
  private readonly bytes: number[] = [];

  addOp(op: number): this {
    this.bytes.push(op);
    return this;
  }

  addInt(value: number | bigint): this {
    const v = BigInt(value);
    if (v === 0n) return this.addOp(OP_0);
    if (v === -1n) return this.addOp(OP_1NEGATE);
    if (v >= 1n && v <= 16n) return this.addOp(OP_1 - 1 + Number(v));
    return this.addData(scriptNum(v));
  }

  addData(data: Uint8Array): this {
    const n = data.length;
    if (n === 0 || (n === 1 && data[0] === 0)) return this.addOp(OP_0);
    if (n === 1 && data[0]! <= 16) return this.addOp(OP_1 - 1 + data[0]!);
    if (n === 1 && data[0] === 0x81) return this.addOp(OP_1NEGATE);
    if (n < OP_PUSHDATA1) this.bytes.push(n);
    else if (n <= 0xff) this.bytes.push(OP_PUSHDATA1, n);
    else if (n <= 0xffff) this.bytes.push(OP_PUSHDATA2, ...le(n, 2));
    else this.bytes.push(OP_PUSHDATA4, ...le(n, 4));
    this.bytes.push(...data);
    return this;
  }

  /** A raw push of exactly these bytes, even a single small value. */
  addRawPush(data: Uint8Array): this {
    if (data.length === 0 || data.length >= OP_PUSHDATA1) return this.addData(data);
    this.bytes.push(data.length, ...data);
    return this;
  }

  script(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
