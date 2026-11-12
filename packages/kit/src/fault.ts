import { isDeepStrictEqual } from "node:util";

/**
 * A stable, machine-readable failure. Only `code` crosses process and HTTP
 * boundaries; `detail` is for local diagnostics and never carries secrets.
 */
export class Fault extends Error {
  readonly code: string;

  constructor(code: string, detail?: string, options?: ErrorOptions) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "Fault";
    this.code = code;
  }
}

export function fail(code: string, detail?: string): never {
  throw new Fault(code, detail);
}

export function ensure(condition: unknown, code: string, detail?: string): asserts condition {
  if (!condition) throw new Fault(code, detail);
}

export function ensureEqual<T>(
  actual: unknown,
  expected: T,
  code: string,
  detail?: string,
): asserts actual is T {
  if (!isDeepStrictEqual(actual, expected)) throw new Fault(code, detail);
}

/** Run `action`, keeping Fault codes and replacing any other error with `code`. */
export function guard<T>(code: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(code, undefined, { cause: error });
  }
}

export async function guardAsync<T>(code: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(code, undefined, { cause: error });
  }
}

export function faultCode(error: unknown, fallback = "INTERNAL"): string {
  return error instanceof Fault ? error.code : fallback;
}

export function isFault(error: unknown, code?: string): error is Fault {
  return error instanceof Fault && (code === undefined || error.code === code);
}

/** Succeeds when `action` does not throw. */
export function holds(action: () => unknown): boolean {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}
