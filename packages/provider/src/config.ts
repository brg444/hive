import type { Deployment } from "@hive/ark";
import {
  ensure,
  exactObject,
  hex,
  hexField,
  isSecretPath,
  readPrivateJson,
  statePath,
  unhex,
  withLock,
  writePrivateJson,
  writePrivateOnce,
} from "@hive/kit";
import {
  canonicalJson,
  type QuoteTerms,
  type SignedProviderCard,
  type SignedQuote,
  validateQuoteTerms,
} from "@hive/protocol";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";

/**
 * The provider workload key's private configuration. Only the challenge and
 * claim workers read it; the sidecar, solver and daemon never do.
 */
export interface ProviderConfig {
  schema: "hive-provider/v4";
  workloadSecret: string;
  /** Challenge and claim records, under `.local/`. */
  stateDirectory: string;
  deployment: Deployment;
  approvedRequests: QuoteTerms[];
}

export interface Provider {
  config: ProviderConfig;
  workloadKey: string;
}

/** Private sidecar launch settings: the escrow's bearer token and the workload worker's config. */
export interface SidecarLaunch {
  schema: "hive-sidecar-launch/v4";
  bearerToken: string;
  providerConfigPath: string;
}

/** Private claim daemon launch settings. The daemon never reads the workload key itself. */
export interface ClaimDaemonLaunch {
  schema: "hive-claim-daemon/v4";
  deployment: Deployment;
  providerConfigPath: string;
  /** The quote the escrow was funded for. */
  quotePath: string;
  stateDirectory: string;
  sidecarUrl: string;
  bearerToken: string;
  /** The hive's claim desk: where the provider hands in its signed claim. */
  claimDeskUrl: string;
}

/**
 * The payout key's private configuration: the owner of the provider's payout
 * wallet, a SimpleWallet the delegatee renews. Only the provider's own tools
 * read it, to cash out or send; no daemon does.
 */
export interface PayoutConfig {
  schema: "hive-payout/v4";
  ownerSecret: string;
  deployment: Deployment;
  wallet: { renewalWindowSeconds: number; maxFeeSats: number };
  /** Cash-out and send journals, under `.local/`. */
  stateDirectory: string;
}

const PAYOUT_FIELDS = ["schema", "ownerSecret", "deployment", "wallet", "stateDirectory"];

export function loadPayout(path: string): { config: PayoutConfig; owner: string } {
  const config = parsePayout(readPrivateJson<unknown>(path));
  return { config, owner: hex(secp256k1.getPublicKey(unhex(config.ownerSecret), true)) };
}

export function writePayoutConfig(path: string, config: PayoutConfig): void {
  ensure(isSecretPath(path), "PRIVATE_CONFIG_PATH");
  writePrivateOnce(path, parsePayout(config));
}

function parsePayout(value: unknown): PayoutConfig {
  const config = exactObject(value, PAYOUT_FIELDS, "payout config") as unknown as PayoutConfig;
  ensure(config.schema === "hive-payout/v4", "INVALID_CONFIG");
  hexField(config.ownerSecret, 32, "payout secret");
  exactObject(config.wallet, ["renewalWindowSeconds", "maxFeeSats"], "payout wallet");
  ensure(
    Number.isSafeInteger(config.wallet.renewalWindowSeconds) &&
      config.wallet.renewalWindowSeconds > 0 &&
      Number.isSafeInteger(config.wallet.maxFeeSats) &&
      config.wallet.maxFeeSats >= 0,
    "INVALID_CONFIG",
  );
  statePath(config.stateDirectory);
  ensure(!isSecretPath(config.stateDirectory), "INVALID_CONFIG");
  ensure(["regtest", "mutinynet", "bitcoin"].includes(config.deployment?.network), "INVALID_CONFIG");
  return config;
}

/** The RFQ key's private configuration. It can quote but cannot spend or claim. */
export interface SolverConfig {
  schema: "hive-solver/v4";
  rfqSecret: string;
  card: SignedProviderCard;
  stateDirectory: string;
}

const FIELDS = ["schema", "workloadSecret", "stateDirectory", "deployment", "approvedRequests"];

export function loadProvider(path: string): Provider {
  const config = parseConfig(readPrivateJson<unknown>(path));
  return { config, workloadKey: hex(schnorr.getPublicKey(unhex(config.workloadSecret))) };
}

export function writeProviderConfig(path: string, config: ProviderConfig): void {
  ensure(isSecretPath(path), "PRIVATE_CONFIG_PATH");
  writePrivateOnce(path, parseConfig(config));
}

/** The provider administrator approves each request's terms before quoting or signing for it. */
export async function approveProviderRequest(path: string, terms: QuoteTerms): Promise<void> {
  await withLock(`${statePath(path)}.lock`, async () => {
    const config = parseConfig(readPrivateJson<unknown>(path));
    const existing = config.approvedRequests.find((approved) => approved.requestId === terms.requestId);
    if (existing) {
      ensure(canonicalJson(existing) === canonicalJson(terms), "REQUEST_ALREADY_APPROVED");
      return;
    }
    config.approvedRequests.push(terms);
    writePrivateJson(path, parseConfig(config));
  });
}

/** The quote must carry approved terms and name this provider's workload key. */
export function requireApprovedQuote(provider: Provider, quote: SignedQuote): QuoteTerms {
  const terms = provider.config.approvedRequests.find(
    (approved) => approved.requestId === quote.body.requestId,
  );
  ensure(terms, "UNAPPROVED_REQUEST");
  validateQuoteTerms(quote, terms);
  ensure(quote.body.providerWorkloadKey === provider.workloadKey, "WRONG_WORKLOAD_KEY");
  return terms;
}

function parseConfig(value: unknown): ProviderConfig {
  const config = exactObject(value, FIELDS, "provider config") as unknown as ProviderConfig;
  ensure(config.schema === "hive-provider/v4", "INVALID_CONFIG");
  hexField(config.workloadSecret, 32, "workload secret");
  statePath(config.stateDirectory);
  ensure(!isSecretPath(config.stateDirectory), "INVALID_CONFIG");
  ensure(["regtest", "mutinynet", "bitcoin"].includes(config.deployment?.network), "INVALID_CONFIG");
  ensure(Array.isArray(config.approvedRequests) && config.approvedRequests.length <= 1000, "INVALID_CONFIG");
  ensure(
    new Set(config.approvedRequests.map((terms) => terms.requestId)).size === config.approvedRequests.length,
    "INVALID_CONFIG",
  );
  return config;
}
