import { Fault } from "./fault.js";

export const MAX_SIGNED_64 = (1n << 63n) - 1n;
export const MAX_MONEY_SATS = 2_100_000_000_000_000n;

function invalid(detail: string): never {
  throw new Fault("INVALID", detail);
}

/** A plain object with exactly `fields` as own enumerable data properties. */
export function exactObject(
  value: unknown,
  fields: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  plainObject(value, name);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    invalid(`${name} has missing or unknown fields`);
  }
  for (const key of fields) dataProperty(value, key, name);
  return value as Record<string, unknown>;
}

/** Like exactObject, but `optional` fields may be absent. */
export function shapedObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  const present = optional.filter((key) => Object.hasOwn(value, key));
  return exactObject(value, [...required, ...present], name);
}

/** A canonical unsigned decimal string, as used for every integer on the wire. */
export function decimal(value: unknown, name: string, minimum = 0n, maximum = MAX_SIGNED_64): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20) {
    invalid(`${name} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > maximum) invalid(`${name} is outside its permitted range`);
  return parsed;
}

export function hexField(value: unknown, byteLength: number, name: string): string {
  if (typeof value !== "string" || value.length !== byteLength * 2 || !/^[0-9a-f]+$/.test(value)) {
    invalid(`${name} must be ${byteLength} bytes of lowercase hexadecimal`);
  }
  return value;
}

export function safeInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function oneOf<const T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid(`${name} is not supported`);
  return value as T;
}

export function plainObject(value: object, name = "value"): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${name} must be a plain object`);
}

export function dataProperty(value: object, key: string, name = "value"): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    invalid(`${name} requires own enumerable data properties`);
  }
  return descriptor.value;
}
