import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "./bytes.js";
import { ensure } from "./fault.js";
import { LOCAL_ROOT, readJson, writeJson } from "./state.js";

/** Called after each durable state change so tests can interrupt the process there. */
export type Checkpoint = (label: string) => Promise<void>;
export const noCheckpoint: Checkpoint = async () => {};

/**
 * Test-only crash probe. With `BUZZ_CRASH_DIRECTORY` set (under `.local/`), the
 * first visit to each label records a marker and exits with code 75; later
 * visits pass. `BUZZ_CRASH_AT` limits the probe to one label and
 * `BUZZ_CRASH_SCOPE` to labels with that prefix. Service runs never set them.
 */
export function crashProbe(label: string): void {
  const directory = process.env.BUZZ_CRASH_DIRECTORY;
  if (!directory) return;
  const at = process.env.BUZZ_CRASH_AT;
  const scope = process.env.BUZZ_CRASH_SCOPE;
  if (at && at !== label) return;
  if (scope && !label.startsWith(scope)) return;
  const absolute = resolve(directory);
  ensure(absolute.startsWith(LOCAL_ROOT + "/"), "CRASH_PROBE_PATH");
  ensure(label.length > 0 && label.length <= 1024, "CRASH_PROBE_LABEL");
  const marker = resolve(absolute, `${sha256Hex(label)}.json`);
  if (existsSync(marker)) {
    ensure(readJson<{ label: string }>(marker).label === label, "CRASH_PROBE_COLLISION");
    return;
  }
  writeJson(marker, { label, interruptedAt: new Date().toISOString(), pid: process.pid });
  process.exit(75);
}

export const crashCheckpoint: Checkpoint = async (label) => crashProbe(label);
