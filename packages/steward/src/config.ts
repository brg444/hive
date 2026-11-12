import { type Deployment, type Pair, PAIRS, pairKeys, type TreasuryTerms } from "@hive/ark";
import {
  ensure,
  guard,
  hex,
  hexField,
  isSecretPath,
  readPrivateJson,
  requireHiveId,
  safeInteger,
  shapedObject,
  statePath,
  unhex,
  withLock,
  writePrivateJson,
  writePrivateOnce,
} from "@hive/kit";
import { canonicalJson, type QuoteTerms } from "@hive/protocol";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sameWithdrawal, type WithdrawalTerms } from "./purpose.js";

export type { WithdrawalTerms };

/**
 * Written by the steward's own administrator under `.secrets/`, never received
 * over the worker's stdin. Only the two approval lists may change after
 * creation, and only through `approveRequest` and `approveWithdrawal`.
 */
export interface StewardConfig {
  schema: "hive-steward/v4";
  secretKey: string;
  /** Sessions and reservations, under `.local/`. */
  statePath: string;
  deployment: Deployment;
  stewardKeys: [string, string, string];
  treasury: Omit<TreasuryTerms, "pairs">;
  /** Purchase terms approved one by one, before any quote exists. */
  approvedRequests: QuoteTerms[];
  /** Treasury withdrawals approved one by one: exact destination, amount and expiry. */
  approvedWithdrawals: WithdrawalTerms[];
  /** The hive this steward keeps: its own halt switch applies besides the operator's. */
  hive?: string;
}

export interface Steward {
  config: StewardConfig;
  secretKey: Uint8Array;
  publicKey: string;
  index: 0 | 1 | 2;
  pairs: Record<Pair, string>;
  treasuryTerms: TreasuryTerms;
}

const FIELDS = [
  "schema",
  "secretKey",
  "statePath",
  "deployment",
  "stewardKeys",
  "treasury",
  "approvedRequests",
  "approvedWithdrawals",
] as const;

export function loadSteward(path: string): Steward {
  const config = guard("INVALID_CONFIG", () => parseConfig(readPrivateJson<unknown>(path)));
  const secretKey = unhex(config.secretKey);
  const publicKey = hex(secp256k1.getPublicKey(secretKey, true));
  const index = config.stewardKeys.indexOf(publicKey);
  ensure(index >= 0, "INVALID_CONFIG", "the key is not one of the stewards");
  const pairs = pairKeys(config.stewardKeys);
  return {
    config,
    secretKey,
    publicKey,
    index: index as 0 | 1 | 2,
    pairs,
    treasuryTerms: { ...config.treasury, pairs },
  };
}

/** The pairs this steward belongs to. */
export const ownPairs = (steward: Steward): Pair[] => PAIRS.filter((p) => p.includes(String(steward.index)));

/** Create a steward's configuration once; a second call must match exactly. */
export function writeStewardConfig(path: string, config: StewardConfig): void {
  ensure(isSecretPath(path), "PRIVATE_CONFIG_PATH");
  writePrivateOnce(path, parseConfig(config));
}

async function amend(path: string, change: (config: StewardConfig) => boolean): Promise<void> {
  await withLock(`${statePath(path)}.lock`, async () => {
    const config = parseConfig(readPrivateJson<unknown>(path));
    if (change(config)) writePrivateJson(path, parseConfig(config));
  });
}

/** The administrator approves one more request's terms. */
export function approveRequest(path: string, terms: QuoteTerms): Promise<void> {
  return amend(path, (config) => {
    const existing = config.approvedRequests.find((approved) => approved.requestId === terms.requestId);
    if (existing) {
      ensure(canonicalJson(existing) === canonicalJson(terms), "REQUEST_ALREADY_APPROVED");
      return false;
    }
    config.approvedRequests.push(terms);
    return true;
  });
}

/** The administrator approves one treasury withdrawal. */
export function approveWithdrawal(path: string, terms: WithdrawalTerms): Promise<void> {
  const parsed = parseWithdrawal(terms);
  return amend(path, (config) => {
    const existing = config.approvedWithdrawals.find((w) => w.label === parsed.label);
    if (existing) {
      ensure(sameWithdrawal(existing, parsed), "WITHDRAWAL_ALREADY_APPROVED");
      return false;
    }
    config.approvedWithdrawals.push(parsed);
    return true;
  });
}

export function parseWithdrawal(value: unknown): WithdrawalTerms {
  const raw = shapedObject(
    value,
    ["label", "destination", "amountSats", "expiresAt"],
    [],
    "withdrawal",
  ) as unknown as WithdrawalTerms;
  ensure(
    typeof raw.label === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.label),
    "INVALID",
    "withdrawal label",
  );
  ensure(/^5120[0-9a-f]{64}$/.test(raw.destination), "INVALID", "destination must be a P2TR script");
  safeInteger(raw.amountSats, "amountSats", 330, Number.MAX_SAFE_INTEGER);
  safeInteger(raw.expiresAt, "expiresAt", 1, Number.MAX_SAFE_INTEGER);
  return raw;
}

function parseConfig(value: unknown): StewardConfig {
  const config = shapedObject(value, [...FIELDS], ["hive"], "steward config") as unknown as StewardConfig;
  ensure(config.schema === "hive-steward/v4", "INVALID_CONFIG");
  if (config.hive !== undefined) guard("INVALID_CONFIG", () => requireHiveId(config.hive as string));
  hexField(config.secretKey, 32, "secret key");
  statePath(config.statePath);
  ensure(!isSecretPath(config.statePath), "INVALID_CONFIG");
  ensure(["regtest", "mutinynet", "bitcoin"].includes(config.deployment?.network), "INVALID_CONFIG");
  ensure(Array.isArray(config.stewardKeys) && config.stewardKeys.length === 3, "INVALID_CONFIG");
  for (const key of config.stewardKeys) {
    hexField(key, 33, "steward key");
    guard("INVALID_CONFIG", () => secp256k1.Point.fromHex(key).assertValidity());
  }
  ensure(new Set(config.stewardKeys.map((key) => key.slice(2))).size === 3, "INVALID_CONFIG");
  const t = config.treasury;
  safeInteger(t?.exitDelaySeconds, "exitDelaySeconds", 512, 65535 * 512);
  safeInteger(t?.renewalWindowSeconds, "renewalWindowSeconds", 60, 30 * 86_400);
  safeInteger(t?.maxFeeSats, "maxFeeSats", 0, 1_000_000);
  ensure(Array.isArray(config.approvedRequests) && config.approvedRequests.length <= 1000, "INVALID_CONFIG");
  ensure(
    new Set(config.approvedRequests.map((terms) => terms.requestId)).size === config.approvedRequests.length,
    "INVALID_CONFIG",
  );
  ensure(
    Array.isArray(config.approvedWithdrawals) && config.approvedWithdrawals.length <= 1000,
    "INVALID_CONFIG",
  );
  for (const w of config.approvedWithdrawals) guard("INVALID_CONFIG", () => parseWithdrawal(w));
  ensure(
    new Set(config.approvedWithdrawals.map((w) => w.label)).size === config.approvedWithdrawals.length,
    "INVALID_CONFIG",
  );
  return config;
}
