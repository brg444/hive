import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ensure, Fault } from "./fault.js";

/** Journals live under `.local/`, keys under `.secrets/`; both are ignored by git. */
export const repositoryRoot = resolve(import.meta.dirname, "../../..");
export const LOCAL_ROOT = resolve(repositoryRoot, ".local");
export const SECRET_ROOT = resolve(repositoryRoot, ".secrets");
const localRoot = LOCAL_ROOT;
const secretRoot = SECRET_ROOT;
const MAX_STATE_BYTES = 16 * 1024 * 1024;

export function localPath(...segments: string[]): string {
  return statePath(resolve(localRoot, ...segments));
}

export function secretPath(...segments: string[]): string {
  return statePath(resolve(secretRoot, ...segments));
}

/** Refuse paths outside the ignored state roots or reached through a symlink. */
export function statePath(path: string): string {
  const absolute = resolve(path);
  ensure(
    [localRoot, secretRoot].some((root) => absolute.startsWith(root + sep)),
    "STATE_PATH",
    "state must stay in the repository's .local or .secrets directory",
  );
  let ancestor = dirname(absolute);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  ensure(realpathSync(ancestor) === ancestor, "STATE_PATH", "state ancestors cannot pass through a symlink");
  if (existsSync(absolute))
    ensure(realpathSync(absolute) === absolute, "STATE_PATH", "state file is a symlink");
  return absolute;
}

export function isSecretPath(path: string): boolean {
  return resolve(path).startsWith(secretRoot + sep);
}

/** Atomic replacement with the file and its directory entry flushed. */
export function writeJson(path: string, value: unknown): void {
  const absolute = statePath(path);
  const body = JSON.stringify(value, null, 2) + "\n";
  ensure(Buffer.byteLength(body) <= MAX_STATE_BYTES, "STATE_TOO_LARGE");
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp-${randomBytes(12).toString("hex")}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, body);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, absolute);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  syncDirectory(dirname(absolute));
}

export function readJson<T>(path: string): T {
  const absolute = statePath(path);
  const body = readFileSync(absolute, "utf8");
  ensure(Buffer.byteLength(body) <= MAX_STATE_BYTES, "STATE_TOO_LARGE");
  return JSON.parse(body) as T;
}

export function readJsonIfPresent<T>(path: string): T | undefined {
  return existsSync(statePath(path)) ? readJson<T>(path) : undefined;
}

/** First write wins; a later call must present the identical value. */
export function writeOnce<T>(path: string, value: T): T {
  if (existsSync(statePath(path))) {
    const stored = readJson<unknown>(path);
    if (!isDeepStrictEqual(stored, JSON.parse(JSON.stringify(value)))) {
      throw new Fault("STATE_CHANGED", `persisted context differs: ${path}`);
    }
  } else writeJson(path, value);
  return value;
}

/** Private configuration: under `.secrets/`, a regular file, readable by its owner only. */
export function readPrivateJson<T>(path: string): T {
  const absolute = statePath(path);
  ensure(isSecretPath(absolute), "PRIVATE_CONFIG_PATH");
  const stat = statSync(absolute);
  ensure(stat.isFile() && (stat.mode & 0o077) === 0, "PRIVATE_CONFIG_MODE");
  return readJson<T>(absolute);
}

export function writePrivateJson(path: string, value: unknown): void {
  ensure(isSecretPath(path), "PRIVATE_CONFIG_PATH");
  writeJson(path, value);
}

/** Like writeOnce for private files; mismatches never echo private values. */
export function writePrivateOnce<T>(path: string, value: T): T {
  ensure(isSecretPath(path), "PRIVATE_CONFIG_PATH");
  if (existsSync(statePath(path))) {
    const stored = readPrivateJson<unknown>(path);
    ensure(isDeepStrictEqual(stored, JSON.parse(JSON.stringify(value))), "PRIVATE_CONFIG_CHANGED");
  } else writeJson(path, value);
  return value;
}

export function stateExists(path: string): boolean {
  return existsSync(statePath(path));
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
