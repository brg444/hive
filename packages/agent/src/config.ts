import {
  decimal,
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
  DEFAULT_OUTPUT_TOKENS,
  type QuoteTerms,
  type SignedQuote,
  validateQuoteTerms,
} from "@hive/protocol";
import { schnorr } from "@noble/curves/secp256k1.js";

/** The payer's private configuration. The receipt key signs receipts and nothing else. */
export interface AgentConfig {
  schema: "hive-agent/v4";
  receiptSecret: string;
  /** Receipt ledgers, one per escrow, under `.local/`. */
  stateDirectory: string;
  approvedRequests: QuoteTerms[];
  /** No single request may be charged more than this. */
  perRequestMaxSats: string;
  defaultOutputTokens?: number;
  /** The sidecar bearer token for each escrow id. */
  sidecarBearerTokens: Record<string, string>;
}

export interface Agent {
  config: AgentConfig;
  receiptKey: string;
  defaultOutputTokens: number;
}

export function loadAgent(path: string): Agent {
  const config = parseConfig(readPrivateJson<unknown>(path));
  return {
    config,
    receiptKey: hex(schnorr.getPublicKey(unhex(config.receiptSecret))),
    defaultOutputTokens: config.defaultOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
  };
}

export function writeAgentConfig(path: string, config: AgentConfig): void {
  ensure(isSecretPath(path), "PRIVATE_CONFIG_PATH");
  writePrivateOnce(path, parseConfig(config));
}

/** The payer approves one more request's terms before any quote for it exists. */
export async function approveAgentRequest(path: string, terms: QuoteTerms): Promise<void> {
  await updateConfig(path, (config) => {
    const existing = config.approvedRequests.find((approved) => approved.requestId === terms.requestId);
    if (existing) ensure(canonicalJson(existing) === canonicalJson(terms), "REQUEST_ALREADY_APPROVED");
    else config.approvedRequests.push(terms);
  });
}

/** Record the sidecar bearer token the provider issued for one escrow. */
export async function shareSidecarToken(path: string, escrowId: string, token: string): Promise<void> {
  hexField(escrowId, 32, "escrow id");
  hexField(token, 32, "bearer token");
  await updateConfig(path, (config) => {
    const existing = config.sidecarBearerTokens[escrowId];
    ensure(existing === undefined || existing === token, "TOKEN_ALREADY_SET");
    config.sidecarBearerTokens[escrowId] = token;
  });
}

async function updateConfig(path: string, change: (config: AgentConfig) => void): Promise<void> {
  await withLock(`${statePath(path)}.lock`, async () => {
    const config = parseConfig(readPrivateJson<unknown>(path));
    change(config);
    writePrivateJson(path, parseConfig(config));
  });
}

/** The quote's terms were approved by the payer, it names this receipt key, and its sidecar token is known. */
export function requireAgentQuote(agent: Agent, quote: SignedQuote): string {
  const terms = agent.config.approvedRequests.find((approved) => approved.requestId === quote.body.requestId);
  ensure(terms, "UNAPPROVED_REQUEST");
  validateQuoteTerms(quote, terms);
  ensure(quote.body.payerReceiptKey === agent.receiptKey, "WRONG_RECEIPT_KEY");
  const token = agent.config.sidecarBearerTokens[quote.quoteId];
  ensure(typeof token === "string" && /^[0-9a-f]{64}$/.test(token), "MISSING_SIDECAR_TOKEN");
  return token;
}

function parseConfig(value: unknown): AgentConfig {
  const raw = value as AgentConfig;
  const config = exactObject(
    value,
    [
      "schema",
      "receiptSecret",
      "stateDirectory",
      "approvedRequests",
      "perRequestMaxSats",
      "sidecarBearerTokens",
      ...(raw?.defaultOutputTokens === undefined ? [] : ["defaultOutputTokens"]),
    ],
    "agent config",
  ) as unknown as AgentConfig;
  ensure(config.schema === "hive-agent/v4", "INVALID_CONFIG");
  hexField(config.receiptSecret, 32, "receipt secret");
  statePath(config.stateDirectory);
  ensure(!isSecretPath(config.stateDirectory), "INVALID_CONFIG");
  decimal(config.perRequestMaxSats, "per-request ceiling", 1n);
  if (config.defaultOutputTokens !== undefined) {
    ensure(
      Number.isSafeInteger(config.defaultOutputTokens) &&
        config.defaultOutputTokens > 0 &&
        config.defaultOutputTokens <= 65_536,
      "INVALID_CONFIG",
    );
  }
  ensure(Array.isArray(config.approvedRequests) && config.approvedRequests.length <= 1000, "INVALID_CONFIG");
  ensure(
    config.sidecarBearerTokens &&
      typeof config.sidecarBearerTokens === "object" &&
      !Array.isArray(config.sidecarBearerTokens),
    "INVALID_CONFIG",
  );
  return config;
}
