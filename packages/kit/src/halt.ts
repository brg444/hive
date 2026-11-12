import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensure, Fault } from "./fault.js";
import { LOCAL_ROOT } from "./state.js";

/** A hive's name: its directory under `.local/ops/` and its path on a hive host. */
export const HIVE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function requireHiveId(id: string): string {
  ensure(typeof id === "string" && HIVE_ID.test(id), "INVALID", "hive id");
  return id;
}

/**
 * The kill switches. While a halt file exists, nothing new starts: stewards
 * approve no allocation and the hive page accepts no contribution. Claims,
 * refunds and cash-outs continue, because they only finish what was already
 * funded. The operator's file halts every hive this checkout runs
 * (`BUZZ_HALT_FILE` moves it); a hive's own file, `.local/halts/<hive>`,
 * halts that hive alone. A file's text is the reason.
 */
export function haltFile(hive?: string): string {
  if (hive === undefined) return resolve(process.env.BUZZ_HALT_FILE ?? resolve(LOCAL_ROOT, "HALT"));
  return resolve(LOCAL_ROOT, "halts", requireHiveId(hive));
}

function reasonIn(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim().slice(0, 200) || "halted";
}

/** Why new work is refused for this hive, or for every hive without one. */
export function haltReason(hive?: string): string | undefined {
  return reasonIn(haltFile()) ?? (hive === undefined ? undefined : reasonIn(haltFile(hive)));
}

export function requireNotHalted(hive?: string): void {
  const reason = haltReason(hive);
  if (reason !== undefined) throw new Fault("HALTED", reason);
}

/**
 * Real funds are refused in every process unless its operator opted in for
 * that process with `BUZZ_MAINNET=enabled`. Without it, mainnet deployments,
 * quotes and cards are invalid, as the protocol vectors require.
 */
export function mainnetEnabled(): boolean {
  return process.env.BUZZ_MAINNET === "enabled";
}
