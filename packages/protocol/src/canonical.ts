import { dataProperty, Fault, plainObject } from "@hive/kit";

/** The wire format has no JSON numbers: integers travel as decimal strings. */
export type CanonicalValue =
  | null
  | boolean
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export const MAX_CANONICAL_BYTES = 65_536;
const utf8 = new TextEncoder();

function invalid(detail: string): never {
  throw new Fault("NONCANONICAL", detail);
}

/** Sorted keys, no whitespace, strings/booleans/null/arrays/objects only. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const encode = (item: unknown, depth: number): string => {
    if (depth > 32) invalid("nesting exceeds 32 levels");
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "string") {
      assertUnicode(item);
      if (item.length > MAX_CANONICAL_BYTES) invalid("string is too long");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") invalid("only strings, booleans, null, arrays and objects are permitted");
    if (active.has(item)) invalid("cycle");
    active.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (item.length > MAX_CANONICAL_BYTES || Reflect.ownKeys(item).length !== item.length + 1) {
        invalid("arrays must be dense with indexed values only");
      }
      const parts = Array.from({ length: item.length }, (_, i) =>
        encode(dataProperty(item, String(i)), depth + 1),
      );
      result = `[${parts.join(",")}]`;
    } else {
      plainObject(item);
      const keys = Reflect.ownKeys(item);
      if (keys.some((key) => typeof key !== "string")) invalid("symbol keys");
      const parts = (keys as string[]).sort().map((key) => {
        assertUnicode(key);
        return `${JSON.stringify(key)}:${encode(dataProperty(item, key), depth + 1)}`;
      });
      result = `{${parts.join(",")}}`;
    }
    active.delete(item);
    if (result.length > MAX_CANONICAL_BYTES) invalid("too large");
    return result;
  };
  const result = encode(value, 0);
  if (utf8.encode(result).length > MAX_CANONICAL_BYTES) invalid("UTF-8 size limit exceeded");
  return result;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8.encode(canonicalJson(value));
}

/** Exact canonical text also rules out duplicate keys and alternate spellings. */
export function parseCanonicalJson(text: string): CanonicalValue {
  if (typeof text !== "string" || text.length > MAX_CANONICAL_BYTES) invalid("text missing or too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid("not JSON");
  }
  if (canonicalJson(value) !== text) invalid("text is not in canonical form");
  return value as CanonicalValue;
}

/** Domain-separated digest input: UTF8(domain) ‖ separator ‖ u32be(length) ‖ payload. */
export function framed(domain: string, separator: Uint8Array, payload: Uint8Array): Uint8Array {
  const prefix = utf8.encode(domain);
  const result = new Uint8Array(prefix.length + separator.length + 4 + payload.length);
  result.set(prefix, 0);
  result.set(separator, prefix.length);
  new DataView(result.buffer).setUint32(prefix.length + separator.length, payload.length, false);
  result.set(payload, prefix.length + separator.length + 4);
  return result;
}

function assertUnicode(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("unpaired UTF-16 surrogate");
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid("unpaired UTF-16 surrogate");
  }
}
