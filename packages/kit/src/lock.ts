import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { statePath } from "./state.js";

/**
 * Exclusive cross-process lock. SQLite's kernel lock is released even when the
 * owning process is killed, so a crash never leaves a stale lock behind.
 */
export async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const absolute = statePath(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(absolute);
  let acquired = false;
  try {
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
    acquired = true;
    const result = await action();
    database.exec("COMMIT;");
    acquired = false;
    return result;
  } finally {
    if (acquired) database.exec("ROLLBACK;");
    database.close();
  }
}

/**
 * Serialises work inside one process (events that can land in the same turn),
 * while `withLock` excludes other processes.
 */
export function lockedQueue(path: string): <T>(action: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(action: () => Promise<T>) => {
    const result = tail.then(() => withLock(path, action));
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
