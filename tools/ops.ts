/**
 * Operate one hive from this checkout, on regtest or Mutinynet.
 *
 *   pnpm ops init <hive> --network <regtest|mutinynet> [--keepers <key>,<key>,<key>] [--lnurl <url>]
 *                  [--per-request-max <sats>] [--renewal-window-hours <n>] [--renewal-max-fee <sats>]
 *   pnpm ops renewal <hive>
 *   pnpm ops provider-add <hive> <provider> --model <id> --input-rate <msat> --output-rate <msat> --relay <url>
 *   pnpm ops provider-serve <hive> <provider>
 *   pnpm ops approve <hive> <label> --provider <provider> --cap <sats> --minutes <n>
 *   pnpm ops buy <hive> <label> [--pair <01|02|12>]
 *   pnpm ops escrow <hive> <label> [--upstream <url>] [--desk <url>]
 *   pnpm ops serve <hive> [--port <n>]
 *   pnpm ops listing <hive> --name <name> [--purpose <text>] [--relay <url> …]
 *   pnpm ops publish <hive> --relay <url> [--relay <url> …]
 *   pnpm ops hives --network <regtest|mutinynet> --relay <url> [--relay <url> …]
 *   pnpm ops host <hive> [<hive> …] [--port <n>]
 *   pnpm ops desk <hive> --agent-log <path> [--governance <file>] [--port <n>] [--host <addr>] [--origin <url> …]
 *   pnpm ops status <hive>
 *   pnpm ops withdraw <hive> <label> --to <ark address> --amount <sats|all> [--hours <n>] [--pair <01|02|12>]
 *   pnpm ops payout <hive> <provider> <label> --to <ark address> --amount <sats|all>
 *   pnpm ops cashout <hive> <provider> <bolt11>
 *   pnpm ops halt [--hive <hive>] <reason> | pnpm ops resume [--hive <hive>]
 *
 * Every account follows the SimpleWallet pattern: the delegatee
 * builds and submits each transaction, renews the treasury and the payout
 * wallets, and refunds escrows at their deadline; keys only sign short
 * messages. Keys stay under `.secrets/ops/<hive>/`, state and public records
 * under `.local/ops/<hive>/`. The three stewards' keys live in this checkout:
 * on one machine they protect against a misbehaving coordinator, not against
 * this machine's operator. Mainnet has no pinned delegatee, so v4 refuses it.
 *
 * With `--keepers`, the hive's keepers hold their own keys: the three keys they
 * posted in the hive's channel build the treasury, this checkout keeps none of
 * them, and each keeper signs payments and the listing in the keeper console,
 * through the signing desk (`pnpm ops desk`).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { approveAgentRequest, shareSidecarToken, writeAgentConfig } from "@hive/agent";
import {
  accountCoins,
  type Connection,
  connect,
  type Deployment,
  deploymentFor,
  type FetchLike,
  openWallet,
  PAIRS,
  type Pair,
  pairKeys,
  parseArkAddress,
  type TreasuryTerms,
  treasuryAccount,
  type Wallet,
  type WalletSendJournal,
  walletSend,
  walletTerms,
  xOnly,
} from "@hive/ark";
import type { RouteName } from "@hive/executor";
import {
  buildHiveView,
  currentHiveListings,
  type EscrowActivation,
  executeRefund,
  type FoundHiveListing,
  fetchHiveListings,
  type HiveView,
  type IntakeRegistration,
  nostrTransport,
  publishHiveListing,
  purchase,
  type RegisteredRefund,
  readPurchase,
  refundEscrow,
  refundFallbackAt,
  registerClaim,
  registerIntake,
  requestQuote,
  reservedCoins,
  type SpendJournal,
  type TransportFactory,
  type Treasury,
  withdraw,
} from "@hive/hive";
import {
  ensure,
  Fault,
  fail,
  HIVE_ID,
  haltFile,
  hex,
  localPath,
  readJson,
  readJsonIfPresent,
  readPrivateJson,
  secretPath,
  sha256Hex,
  stateExists,
  unhex,
  unixNow,
  writeJson,
  writeOnce,
  writePrivateOnce,
} from "@hive/kit";
import {
  CARD_PROFILE,
  type ComputeQuoteRequest,
  HIVE_PROFILE,
  type HiveListingBody,
  hiveListingId,
  intakeKey,
  parseComputeQuoteRequest,
  type QuoteTerms,
  quoteContextFromRequest,
  type SignedHiveListing,
  type SignedProviderCard,
  type SignedQuote,
  signHiveListing,
  signProviderCard,
  validateHiveListing,
} from "@hive/protocol";
import {
  approveProviderRequest,
  type CashoutRail,
  type ClaimDaemonLaunch,
  cashOut,
  loadPayout,
  publishedCashoutRail,
  retireExpiredCashout,
  type SidecarConfig,
  type SidecarLaunch,
  writePayoutConfig,
  writeProviderConfig,
} from "@hive/provider";
import { approveRequest, approveWithdrawal, writeStewardConfig } from "@hive/steward";
import { StewardClient, type StewardEndpoint } from "@hive/steward/client";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { type HiveRoutes, type HostedHive, startHiveHost, startHivePage } from "../app/server.js";
import { handleStewardRequest } from "../packages/steward/src/service.js";
import { freePort, type Service, startService } from "./services.js";

export interface HiveRecord {
  schema: "hive-ops-hive/v4";
  name: string;
  network: Deployment["network"];
  deployment: Deployment;
  stewardKeys: [string, string, string];
  /** True when the keepers hold these keys themselves and sign in the keeper console; none is kept here. */
  keepersHold?: boolean;
  treasury: TreasuryTerms;
  treasuryScript: string;
  treasuryAddress: string;
  /** The delegatee's renewal watch on the treasury, as registered at creation. */
  renewalWatch: { templateId: string; delegationId: string };
  payerReceiptKey: string;
  registration: IntakeRegistration | null;
  createdAt: string;
}

interface HiveSeed {
  schema: "hive-ops-seed/v4";
  /** The stewards' secret keys, or null when the hive's keepers hold their own. */
  stewards: [string, string, string] | null;
  payer: string;
}

/** Three distinct compressed keys, as keepers post them: `Hive keeper key: 02…`. */
export function parseKeeperKeys(value: string): [string, string, string] {
  const keys = value.split(",").map((k) => k.trim().toLowerCase());
  ensure(
    keys.length === 3 && keys.every((k) => /^0[23][0-9a-f]{64}$/.test(k)) && new Set(keys).size === 3,
    "INVALID",
    "--keepers takes three distinct compressed keys, comma-separated, in the hive's order",
  );
  for (const k of keys) secp256k1.Point.fromHex(k);
  return keys as [string, string, string];
}

/** The seed's steward keys, for the commands that sign with them here; a keepers' hive has none. */
function stewardSecrets(hive: string, seed: HiveSeed): [string, string, string] {
  ensure(
    seed.stewards,
    "KEEPERS_SIGN",
    `${hive}'s keepers hold its keys: they sign in the keeper console, through \`pnpm ops desk\``,
  );
  return seed.stewards;
}

interface ProviderSeed {
  schema: "hive-ops-provider/v4";
  rfq: string;
  workload: string;
  payout: string;
}

/** Test seams. Production leaves them unset. */
export interface OpsContext {
  fetch?: FetchLike;
  transport?: TransportFactory;
  /** Cash-out rail; the network's published solver market otherwise. */
  rail?: CashoutRail;
  /** Run the stewards in this process instead of one worker process per call. */
  inProcessStewards?: boolean;
}

/** How long before a coin's batch expiry the delegatee renews it, and the most a renewal may cost. */
export const RENEWAL_DEFAULTS: Record<
  "regtest" | "mutinynet" | "bitcoin",
  { windowSeconds: number; maxFeeSats: number }
> = {
  // The local stack's batches live about an hour.
  regtest: { windowSeconds: 1200, maxFeeSats: 2000 },
  mutinynet: { windowSeconds: 86_400, maxFeeSats: 500 },
  // Mainnet batches last weeks, and the Operator charges nothing to renew a coin near its expiry.
  bitcoin: { windowSeconds: 2 * 86_400, maxFeeSats: 500 },
};

/** Provider and purchase labels; a hive's name is a hive id (`HIVE_ID`). */
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const key = () => hex(schnorr.utils.randomSecretKey());
const compressed = (secret: string) => hex(secp256k1.getPublicKey(unhex(secret), true));

export const opsPaths = (hive: string) => {
  ensure(HIVE_ID.test(hive), "INVALID", "hive name");
  return {
    local: (...parts: string[]) => localPath("ops", hive, ...parts),
    secret: (...parts: string[]) => secretPath("ops", hive, ...parts),
  };
};

export function loadHive(hive: string): HiveRecord {
  const record = readJson<HiveRecord>(opsPaths(hive).local("hive.json"));
  ensure(record.schema === "hive-ops-hive/v4", "JOURNAL_SCHEMA", "a hive from another version");
  return record;
}

/** A keeper's key, held by the keeper: nothing here signs with it, so every request is refused. */
class KeeperHeld implements StewardEndpoint {
  constructor(readonly hive: string) {}
  private refuse(): never {
    return fail(
      "KEEPERS_SIGN",
      `${this.hive}'s keepers sign in the keeper console, through \`pnpm ops desk\``,
    );
  }
  describe() {
    return this.refuse();
  }
  nonce() {
    return this.refuse();
  }
  sign() {
    return this.refuse();
  }
  signLast() {
    return this.refuse();
  }
}

/** A steward run in this process through the same handler as its worker. */
class InProcessSteward implements StewardEndpoint {
  constructor(readonly path: string) {}
  describe() {
    return handleStewardRequest(this.path, { operation: "describe" }) as never;
  }
  nonce(session: Parameters<StewardEndpoint["nonce"]>[0]) {
    return handleStewardRequest(this.path, { operation: "nonce", session }) as never;
  }
  sign(session: Parameters<StewardEndpoint["sign"]>[0], peerNonces: string[]) {
    return handleStewardRequest(this.path, { operation: "sign", session, peerNonces }) as never;
  }
  signLast(session: Parameters<StewardEndpoint["signLast"]>[0], peerNonces: string[]) {
    return handleStewardRequest(this.path, { operation: "sign-last", session, peerNonces }) as never;
  }
}

/** The coordinator's handle on the treasury: the connection, the terms and three steward processes. */
export async function treasuryOf(record: HiveRecord, ctx: OpsContext = {}): Promise<Treasury> {
  const conn = await connect(record.deployment, ctx.fetch);
  const account = await treasuryAccount(conn, record.treasury);
  ensure(
    account.pkScript === record.treasuryScript,
    "DELEGATEE_MISMATCH",
    "the treasury derives differently",
  );
  const paths = opsPaths(record.name);
  const steward = (i: number): StewardEndpoint =>
    record.keepersHold
      ? new KeeperHeld(record.name)
      : ctx.inProcessStewards
        ? new InProcessSteward(paths.secret(`steward-${i}.json`))
        : new StewardClient(paths.secret(`steward-${i}.json`));
  const stewards: [StewardEndpoint, StewardEndpoint, StewardEndpoint] = [steward(0), steward(1), steward(2)];
  return {
    conn,
    terms: record.treasury,
    stewardKeys: record.stewardKeys,
    stewards,
    artifactId: account.artifactId,
    hive: record.name,
  };
}

/**
 * Create the hive's keys, steward and payer configurations, and its public
 * record. Idempotent. The treasury's renewal watch is registered, and its
 * address checked against the delegatee's derivation, before the record is
 * written.
 */
export async function initHive(
  hive: string,
  options: {
    network: string;
    lnurl?: string;
    perRequestMaxSats?: string;
    deployment?: Deployment;
    renewalWindowSeconds?: number;
    renewalMaxFeeSats?: number;
    /** The keepers' own keys: the treasury is theirs, and no steward key is made or kept here. */
    keepers?: [string, string, string];
  },
  ctx: OpsContext = {},
): Promise<HiveRecord> {
  const paths = opsPaths(hive);
  const saved = readJsonIfPresent<HiveRecord>(paths.local("hive.json"));
  if (saved) return saved;
  const deployment = options.deployment ?? deploymentFor(options.network);
  // Real funds are only ever the keepers' own: no steward key for mainnet is made or kept here.
  ensure(
    deployment.network !== "bitcoin" || options.keepers,
    "KEEPERS_SIGN",
    "a mainnet hive is built from its keepers' own keys: pass --keepers",
  );
  const conn = await connect(deployment, ctx.fetch);
  const defaults = RENEWAL_DEFAULTS[deployment.network];
  const seed = stateExists(paths.secret("seed.json"))
    ? readPrivateJson<HiveSeed>(paths.secret("seed.json"))
    : writePrivateOnce<HiveSeed>(paths.secret("seed.json"), {
        schema: "hive-ops-seed/v4",
        stewards: options.keepers ? null : [key(), key(), key()],
        payer: key(),
      });
  ensure(
    Boolean(options.keepers) === !seed.stewards,
    "INVALID",
    "this hive's seed was made for the other kind of keys; start a new hive",
  );
  const stewardKeys = options.keepers ?? (seed.stewards!.map(compressed) as [string, string, string]);
  const treasury: TreasuryTerms = {
    pairs: pairKeys(stewardKeys),
    exitDelaySeconds: conn.operator.unilateralExitDelay,
    renewalWindowSeconds: options.renewalWindowSeconds ?? defaults.windowSeconds,
    maxFeeSats: options.renewalMaxFeeSats ?? defaults.maxFeeSats,
  };
  const account = await treasuryAccount(conn, treasury);
  for (const [i, secret] of (seed.stewards ?? []).entries()) {
    writeStewardConfig(paths.secret(`steward-${i}.json`), {
      schema: "hive-steward/v4",
      secretKey: secret,
      statePath: paths.local(`steward-${i}`, "state.json"),
      deployment,
      stewardKeys,
      treasury: {
        exitDelaySeconds: treasury.exitDelaySeconds,
        renewalWindowSeconds: treasury.renewalWindowSeconds,
        maxFeeSats: treasury.maxFeeSats,
      },
      approvedRequests: [],
      approvedWithdrawals: [],
      hive: hive,
    });
  }
  writeAgentConfig(paths.secret("agent.json"), {
    schema: "hive-agent/v4",
    receiptSecret: seed.payer,
    stateDirectory: paths.local("agent"),
    approvedRequests: [],
    perRequestMaxSats: options.perRequestMaxSats ?? "5000",
    sidecarBearerTokens: {},
  });
  const registration = options.lnurl
    ? await registerIntake({
        endpoint: { baseUrl: options.lnurl, username: hive },
        treasuryAddress: account.address,
        intakeKey: intakeKey(stewardKeys),
        statePath: paths.local("intake", "registration.json"),
        tokenPath: paths.secret("intake-token.json"),
        operatorKey: hex(xOnly(conn.keys.server)),
      })
    : null;
  return writeOnce<HiveRecord>(paths.local("hive.json"), {
    schema: "hive-ops-hive/v4",
    name: hive,
    network: deployment.network,
    deployment,
    stewardKeys,
    ...(options.keepers ? { keepersHold: true } : {}),
    treasury,
    treasuryScript: account.pkScript,
    treasuryAddress: account.address,
    renewalWatch: account.watch,
    payerReceiptKey: hex(schnorr.getPublicKey(unhex(seed.payer))),
    registration,
    createdAt: new Date().toISOString(),
  });
}

/** The delegatee's own account of the treasury's watch; an unreachable delegatee is reported, not fatal. */
export async function renewalStatus(
  record: HiveRecord,
  ctx: OpsContext = {},
): Promise<Record<string, unknown>> {
  try {
    const conn = await connect(record.deployment, ctx.fetch);
    const state = await conn.delegatee.address(record.treasuryAddress);
    return {
      delegatee: record.deployment.delegateeUrl,
      watch: state.delegation.id,
      // The delegatee reports the newest watch on an address and runs the oldest; the hive's is the oldest.
      reportedIsOurs: state.delegation.id === record.renewalWatch.delegationId,
      status: state.delegation.status,
      // The delegatee disables a template whose intents keep being refused; its watches then do nothing.
      template: await conn.delegatee.templateStatus(state.delegation.templateId),
      coins: state.coins,
      attempts: state.attempts.slice(0, 10),
    };
  } catch (error) {
    return { delegatee: record.deployment.delegateeUrl, error: String(error) };
  }
}

/** The provider's payout wallet on this hive's deployment. */
async function payoutWallet(record: HiveRecord, provider: string, ctx: OpsContext): Promise<Wallet> {
  const { config, owner } = loadPayout(opsPaths(record.name).secret("providers", provider, "payout.json"));
  const conn = await connect(config.deployment, ctx.fetch);
  return openWallet(conn, walletTerms(conn, owner, config.wallet));
}

/** A provider run from this checkout: its keys, payout wallet, card, quote desk and workload configuration. */
export async function addProvider(
  hive: string,
  provider: string,
  options: {
    model: string;
    inputRate: string;
    outputRate: string;
    relay: string;
    maxCapSats?: string;
    maxDurationSeconds?: string;
    cardDays?: number;
  },
  ctx: OpsContext = {},
): Promise<{ card: SignedProviderCard; payoutAddress: string }> {
  ensure(NAME.test(provider), "INVALID", "provider name");
  const paths = opsPaths(hive);
  const record = loadHive(hive);
  const seed = stateExists(paths.secret("providers", provider, "seed.json"))
    ? readPrivateJson<ProviderSeed>(paths.secret("providers", provider, "seed.json"))
    : writePrivateOnce<ProviderSeed>(paths.secret("providers", provider, "seed.json"), {
        schema: "hive-ops-provider/v4",
        rfq: key(),
        workload: key(),
        payout: key(),
      });
  // A provider on mainnet holds its own keys, through pay-arkade's install-provider.sh.
  ensure(record.network !== "bitcoin", "PROVIDER_KEYS", "on mainnet a provider holds its own keys");
  const defaults = RENEWAL_DEFAULTS[record.network as "regtest" | "mutinynet"];
  if (!stateExists(paths.secret("providers", provider, "payout.json")))
    writePayoutConfig(paths.secret("providers", provider, "payout.json"), {
      schema: "hive-payout/v4",
      ownerSecret: seed.payout,
      deployment: record.deployment,
      wallet: { renewalWindowSeconds: defaults.windowSeconds, maxFeeSats: defaults.maxFeeSats },
      stateDirectory: paths.local("providers", provider, "payout"),
    });
  const wallet = await payoutWallet(record, provider, ctx);
  const cardPath = paths.local("providers", provider, "card.json");
  const card =
    readJsonIfPresent<SignedProviderCard>(cardPath) ??
    writeOnce(
      cardPath,
      signProviderCard(
        {
          profile: CARD_PROFILE,
          network: record.network,
          model: options.model,
          providerRfqKey: hex(schnorr.getPublicKey(unhex(seed.rfq))),
          providerWorkloadKey: hex(schnorr.getPublicKey(unhex(seed.workload))),
          providerPayoutScript: wallet.account.pkScript,
          inputRateMsatPerMillionTokens: options.inputRate,
          outputRateMsatPerMillionTokens: options.outputRate,
          maxCapSats: options.maxCapSats ?? "20000",
          maxDurationSeconds: options.maxDurationSeconds ?? "7200",
          expiresAt: String(Number(unixNow()) + (options.cardDays ?? 30) * 86_400),
          relays: [options.relay],
        },
        unhex(seed.rfq),
      ),
    );
  ensure(card.body.providerPayoutScript === wallet.account.pkScript, "CARD_CHANGED", "payout script");
  if (!stateExists(paths.secret("providers", provider, "provider.json")))
    writeProviderConfig(paths.secret("providers", provider, "provider.json"), {
      schema: "hive-provider/v4",
      workloadSecret: seed.workload,
      stateDirectory: paths.local("providers", provider, "state"),
      deployment: record.deployment,
      approvedRequests: [],
    });
  if (!stateExists(paths.secret("providers", provider, "solver.json")))
    writePrivateOnce(paths.secret("providers", provider, "solver.json"), {
      schema: "hive-solver/v4",
      rfqSecret: seed.rfq,
      card,
      stateDirectory: paths.local("providers", provider, "solver"),
    });
  return { card, payoutAddress: wallet.account.address };
}

/**
 * Build a compute request against a provider's card and approve its exact
 * terms everywhere they are checked: all three stewards (any pair may fund
 * it or register its claim), the provider and the payer.
 */
export async function approvePurchase(
  hive: string,
  label: string,
  options: { provider: string; capSats: string; timeoutSeconds: number; quoteLifetimeSeconds?: number },
  ctx: OpsContext = {},
): Promise<ComputeQuoteRequest> {
  ensure(NAME.test(label), "INVALID", "label");
  const paths = opsPaths(hive);
  const saved = paths.local("requests", `${label}.json`);
  if (stateExists(saved)) return readJson<ComputeQuoteRequest>(saved);
  const record = loadHive(hive);
  ensure(!record.keepersHold, "KEEPERS_SIGN", `${hive}'s keepers approve each payment in the keeper console`);
  const card = readJson<SignedProviderCard>(paths.local("providers", options.provider, "card.json"));
  ensure(Number.isSafeInteger(options.timeoutSeconds) && options.timeoutSeconds > 0, "INVALID", "timeout");
  const conn = await connect(record.deployment, ctx.fetch);
  const start = BigInt(unixNow());
  const request = parseComputeQuoteRequest({
    profile: "hive-metered/v2",
    pair: "arkade:BTC->compute:METERED_INFERENCE",
    network: record.network,
    requestId: sha256Hex(`hive-ops-request/v4\0${hive}\0${label}\0${randomBytes(16).toString("hex")}`),
    model: card.body.model,
    operatorKey: hex(xOnly(conn.keys.server)),
    emulatorKey: hex(xOnly(conn.keys.emulator)),
    providerRfqKey: card.body.providerRfqKey,
    providerWorkloadKey: card.body.providerWorkloadKey,
    providerPayoutScript: card.body.providerPayoutScript,
    payerReceiptKey: record.payerReceiptKey,
    treasuryScript: record.treasuryScript,
    stewardPairKeys: PAIRS.map((pair) => record.treasury.pairs[pair]),
    capSats: options.capSats,
    inputRateMsatPerMillionTokens: card.body.inputRateMsatPerMillionTokens,
    outputRateMsatPerMillionTokens: card.body.outputRateMsatPerMillionTokens,
    timeoutAt: String(start + BigInt(options.timeoutSeconds)),
    quoteExpiresAt: String(start + BigInt(options.quoteLifetimeSeconds ?? 300)),
    exitDelaySeconds: String(record.treasury.exitDelaySeconds),
  });
  const { nowSeconds: _now, ...terms } = quoteContextFromRequest(request, "1");
  for (const i of [0, 1, 2]) await approveRequest(paths.secret(`steward-${i}.json`), terms as QuoteTerms);
  await approveProviderRequest(
    paths.secret("providers", options.provider, "provider.json"),
    terms as QuoteTerms,
  );
  await approveAgentRequest(paths.secret("agent.json"), terms as QuoteTerms);
  writeOnce(paths.local("requests", `${label}.provider.json`), { provider: options.provider });
  return writeOnce(saved, request);
}

const pairOption = (value: string | undefined): Pair => {
  const pair = (value ?? "01") as Pair;
  ensure(PAIRS.includes(pair), "USAGE", "--pair is 01, 02 or 12");
  return pair;
};

/**
 * Negotiate the quote, register the escrow's refund watch, fund it from the
 * treasury through one steward pair, and hand the provider and the payer
 * their sidecar token.
 */
export async function buyEscrow(
  hive: string,
  label: string,
  options: { pair?: Pair } = {},
  ctx: OpsContext = {},
): Promise<EscrowActivation> {
  const paths = opsPaths(hive);
  const record = loadHive(hive);
  const request = readJson<ComputeQuoteRequest>(paths.local("requests", `${label}.json`));
  const { provider } = readJson<{ provider: string }>(paths.local("requests", `${label}.provider.json`));
  const card = readJson<SignedProviderCard>(paths.local("providers", provider, "card.json"));
  const quote = await requestQuote(request, card, paths.local("rfq"), {
    transport: ctx.transport ?? nostrTransport(20_000),
  });
  const treasury = await treasuryOf(record, ctx);
  const { activation } = await purchase(treasury, {
    quote,
    directory: paths.local("purchases", label),
    pair: options.pair ?? "01",
  });
  const tokenPath = paths.secret("providers", provider, `bearer-${quote.quoteId}.json`);
  const { token } = stateExists(tokenPath)
    ? readPrivateJson<{ token: string }>(tokenPath)
    : writePrivateOnce(tokenPath, { token: hex(randomBytes(32)) });
  await shareSidecarToken(paths.secret("agent.json"), quote.quoteId, token);
  return activation;
}

/** One escrow's processes: the provider's sidecar, the payer's agent and, on request, the claim daemon. */
export interface EscrowServices {
  quote: SignedQuote;
  sidecarUrl: string;
  agentUrl: string;
  bearerToken: string;
  /** Where the claim daemon keeps its decision and its journal. */
  claimDirectory: string;
  startPair(): Promise<void>;
  stopPair(): Promise<void>;
  startClaimDaemon(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_LIMITS: SidecarConfig["limits"] = {
  maxRequestBytes: 65_536,
  maxResponseBytes: 2 * 1024 * 1024,
  maxOutputTokens: 1024,
  requestTimeoutMs: 120_000,
  deadlineGuardSeconds: 120,
};

/**
 * Write one escrow's launch files and return handles that start its
 * services, each as its own process: neither the sidecar nor the agent
 * touches the network, and the claim daemon holds no key itself.
 */
export async function escrowServices(
  hive: string,
  label: string,
  options: {
    upstream: string;
    desk: string;
    limits?: SidecarConfig["limits"];
    log?: { append(line: string): void };
  },
): Promise<EscrowServices> {
  const paths = opsPaths(hive);
  const record = loadHive(hive);
  const { provider } = readJson<{ provider: string }>(paths.local("requests", `${label}.provider.json`));
  const quote: SignedQuote = readPurchase(paths.local("purchases", label)).quote;
  const { token } = readPrivateJson<{ token: string }>(
    paths.secret("providers", provider, `bearer-${quote.quoteId}.json`),
  );
  const ports =
    readJsonIfPresent<{ sidecar: number; agent: number }>(paths.local("escrows", label, "ports.json")) ??
    writeOnce(paths.local("escrows", label, "ports.json"), {
      sidecar: await freePort(),
      agent: await freePort(),
    });
  const sidecarUrl = `http://127.0.0.1:${ports.sidecar}/`;
  writeOnce(paths.local("escrows", label, "quote.json"), quote);
  writeOnce<SidecarConfig>(paths.local("escrows", label, "sidecar-config.json"), {
    quote,
    upstreamBaseUrl: options.upstream,
    stateDirectory: paths.local("escrows", label, "sidecar"),
    limits: options.limits ?? DEFAULT_LIMITS,
    port: ports.sidecar,
  });
  const providerConfigPath = paths.secret("providers", provider, "provider.json");
  writePrivateOnce<SidecarLaunch>(paths.secret("escrows", label, "sidecar-launch.json"), {
    schema: "hive-sidecar-launch/v4",
    bearerToken: token,
    providerConfigPath,
  });
  writeOnce(paths.local("escrows", label, "agent-launch.json"), {
    configPath: paths.secret("agent.json"),
    quote,
    sidecarUrl,
    port: ports.agent,
  });
  writePrivateOnce<ClaimDaemonLaunch>(paths.secret("escrows", label, "claim-daemon.json"), {
    schema: "hive-claim-daemon/v4",
    deployment: record.deployment,
    providerConfigPath,
    quotePath: paths.local("escrows", label, "quote.json"),
    stateDirectory: paths.local("escrows", label, "claim"),
    sidecarUrl,
    bearerToken: token,
    claimDeskUrl: options.desk,
  });
  const log = options.log ?? { append: (line: string) => process.stderr.write(line) };
  const pair: Service[] = [];
  const daemon: Service[] = [];
  const stopAll = async (services: Service[]) => {
    for (const service of services.splice(0).reverse()) await service.close();
  };
  return {
    quote,
    sidecarUrl,
    agentUrl: `http://127.0.0.1:${ports.agent}`,
    bearerToken: token,
    claimDirectory: paths.local("escrows", label, "claim"),
    async startPair() {
      pair.push(
        await startService(
          "packages/provider/src/sidecar-main.ts",
          [
            paths.local("escrows", label, "sidecar-config.json"),
            paths.secret("escrows", label, "sidecar-launch.json"),
          ],
          log,
        ),
      );
      pair.push(
        await startService(
          "packages/agent/src/proxy-main.ts",
          [paths.local("escrows", label, "agent-launch.json")],
          log,
        ),
      );
    },
    stopPair: () => stopAll(pair),
    async startClaimDaemon() {
      daemon.push(
        await startService(
          "packages/provider/src/claim-daemon-main.ts",
          [paths.secret("escrows", label, "claim-daemon.json")],
          log,
        ),
      );
    },
    async close() {
      await stopAll(daemon);
      await stopAll(pair);
    },
  };
}

/** Run the provider's sidecar and claim daemon and the payer's agent for one escrow until it closes. */
export async function runEscrow(
  hive: string,
  label: string,
  options: { upstream: string; desk: string },
): Promise<void> {
  const services = await escrowServices(hive, label, options);
  const { quote } = services;
  try {
    await services.startPair();
    process.stdout.write(
      `${JSON.stringify({ escrowId: quote.quoteId, agentUrl: `${services.agentUrl}/v1`, timeoutAt: quote.body.timeoutAt })}\n`,
    );
    await services.startClaimDaemon();
    // The daemon claims before the deadline; after it, the delegatee refunds what was not claimed.
    const until = (Number(quote.body.timeoutAt) + 120) * 1000;
    const claimed = () =>
      readJsonIfPresent<{ status: string }>(resolve(services.claimDirectory, "claim.json"));
    while (Date.now() < until && !["paid", "refunded"].includes(claimed()?.status ?? "")) {
      await new Promise((done) => setTimeout(done, 5_000));
    }
  } finally {
    await services.close();
  }
}

/**
 * A hive's routes, as one page or one hive on a host: its view, its Lightning
 * address intake and its claim desk.
 */
async function hiveRoutes(
  hive: string,
  options: { maxLightningSats?: number },
  ctx: OpsContext,
): Promise<{ routes: HiveRoutes; record: HiveRecord; treasury: Treasury }> {
  const paths = opsPaths(hive);
  const record = loadHive(hive);
  const treasury = await treasuryOf(record, ctx);
  const listing = existsSync(paths.local("listings")) ? loadListing(hive) : undefined;
  const routes: HiveRoutes = {
    hive: hive,
    ...(listing ? { listing } : {}),
    view: () => hiveView(record, treasury.conn),
    claimDesk: async (claim) => {
      const label = purchaseLabel(record, claim.quote.quoteId);
      ensure(label, "UNKNOWN_ESCROW");
      const bought = readPurchase(paths.local("purchases", label));
      const registered = await registerClaim(treasury, claim, {
        escrowArtifactId: bought.escrow.artifactId,
        journalPath: paths.local("claim-executions", `${label}.json`),
      });
      // The fixed signed registration is retained by its execution journal.
      const claimPath = paths.local("claims", `${label}-${registered.spendId.slice(0, 16)}.json`);
      if (!stateExists(claimPath)) writeOnce(claimPath, registered);
      return registered;
    },
    ...(record.registration
      ? {
          intake: {
            endpoint: record.registration.endpoint,
            network: record.network,
            operatorKey: hex(xOnly(treasury.conn.keys.server)),
            requestsDirectory: paths.local("intake", "requests"),
            minSats: 1_000,
            ...(options.maxLightningSats ? { maxLightningSats: options.maxLightningSats } : {}),
          },
        }
      : {}),
  };
  return { routes, record, treasury };
}

/**
 * The hive page with its claim desk, and the refund fallback. The delegatee's
 * refund watch returns each escrow at its deadline; should it not have done so
 * by half the network's refund margin later, a pair registers the refund
 * itself (`hive/refund`). Every claim and refund a pair registers is recorded
 * under `claims/` and `refunds/`.
 */
export async function serveHive(
  hive: string,
  options: { port?: number; host?: string; maxLightningSats?: number; scanMs?: number },
  ctx: OpsContext = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const { routes, treasury } = await hiveRoutes(hive, options, ctx);
  const page = await startHivePage({
    ...routes,
    ...(options.port ? { port: options.port } : {}),
    ...(options.host ? { host: options.host } : {}),
  });
  const timer = setInterval(() => void refundOverdue(hive, treasury), options.scanMs ?? 30_000);
  return {
    url: page.url,
    async close() {
      clearInterval(timer);
      await page.close();
    },
  };
}

/**
 * Its keepers' listing of a hive: name, purpose, keys, treasury and Lightning
 * address, signed by all three. In this checkout the three steward keys sign
 * it, as they sign everything else here; once keepers hold their own keys,
 * each signs the same text in their wallet. Every listing is kept, and a host
 * shows the newest.
 */
export function writeListing(
  hive: string,
  text: { name: string; purpose?: string },
  now = unixNow(),
): SignedHiveListing {
  const paths = opsPaths(hive);
  const record = loadHive(hive);
  const seed = readPrivateJson<HiveSeed>(paths.secret("seed.json"));
  const body: HiveListingBody = {
    profile: HIVE_PROFILE,
    network: record.network,
    hive: hive,
    name: text.name,
    purpose: text.purpose ?? "",
    stewardKeys: record.stewardKeys,
    treasuryScript: record.treasuryScript,
    lightningAddress: record.registration?.lightningAddress ?? null,
    createdAt: String(now),
  };
  const signatures = ["", "", ""];
  for (const secret of stewardSecrets(hive, seed)) {
    const signed = signHiveListing(body, unhex(secret));
    signatures[signed.keeper] = signed.signature;
  }
  const listing = validateHiveListing({ body, listingId: hiveListingId(body), signatures });
  writeOnce(paths.local("listings", `${body.createdAt}-${listing.listingId.slice(0, 16)}.json`), listing);
  return listing;
}

/** A keepers' hive's listing while its keepers sign it in their consoles, one signature at a time. */
export interface PendingListing {
  body: HiveListingBody;
  listingId: string;
  signatures: [string, string, string];
}

/**
 * The listing a keepers' hive asks its keepers to sign: the same text a stewards' hive signs here,
 * left for each keeper to sign in the keeper console through the desk. A new one replaces any still
 * waiting.
 */
export function proposeListing(
  hive: string,
  text: { name: string; purpose?: string },
  now = unixNow(),
): PendingListing {
  const record = loadHive(hive);
  ensure(record.keepersHold, "INVALID", `${hive}'s listing is signed here: use writeListing`);
  const body: HiveListingBody = {
    profile: HIVE_PROFILE,
    network: record.network,
    hive,
    name: text.name,
    purpose: text.purpose ?? "",
    stewardKeys: record.stewardKeys,
    treasuryScript: record.treasuryScript,
    lightningAddress: record.registration?.lightningAddress ?? null,
    createdAt: String(now),
  };
  const pending: PendingListing = { body, listingId: hiveListingId(body), signatures: ["", "", ""] };
  writeJson(opsPaths(hive).local("listings", "pending.json"), pending);
  return pending;
}

/** Adds one keeper's signature to the pending listing; with the third, the listing is kept like any other. */
export function signPendingListing(
  hive: string,
  keeper: string,
  signature: string,
): { pending: PendingListing; listing?: SignedHiveListing } {
  const paths = opsPaths(hive);
  const pending = readJsonIfPresent<PendingListing>(paths.local("listings", "pending.json"));
  ensure(pending, "NO_LISTING", "no listing is waiting for its keepers");
  const index = pending.body.stewardKeys.indexOf(keeper);
  ensure(index >= 0, "NOT_A_KEEPER");
  ensure(
    /^[0-9a-f]{128}$/.test(signature) &&
      schnorr.verify(unhex(signature), unhex(pending.listingId), unhex(keeper.slice(2))),
    "LISTING_SIGNATURE",
  );
  pending.signatures[index] = signature;
  writeJson(paths.local("listings", "pending.json"), pending);
  if (pending.signatures.some((s) => !s)) return { pending };
  const listing = validateHiveListing({
    body: pending.body,
    listingId: pending.listingId,
    signatures: pending.signatures,
  });
  writeOnce(
    paths.local("listings", `${pending.body.createdAt}-${listing.listingId.slice(0, 16)}.json`),
    listing,
  );
  rmSync(paths.local("listings", "pending.json"), { force: true });
  return { pending, listing };
}

/**
 * Publishes the hive's newest listing to Nostr relays, the way a provider
 * advertises its card. The event is signed with this hive's own publishing
 * key, created once and kept beside its other secrets; the key vouches for
 * nothing, since readers check the keepers' signatures inside the listing.
 */
export async function publishListing(
  hive: string,
  relays: string[],
): Promise<{ hive: string; listingId: string; eventId: string; publisher: string; relays: string[] }> {
  const paths = opsPaths(hive);
  const listing = loadListing(hive);
  const record = loadHive(hive);
  const publisher = stateExists(paths.secret("listing-publisher.json"))
    ? readPrivateJson<{ secretKey: string }>(paths.secret("listing-publisher.json"))
    : writePrivateOnce(paths.secret("listing-publisher.json"), {
        schema: "hive-listing-publisher/v4",
        secretKey: key(),
      });
  // Each publish is later than the last, so relays replace the earlier event.
  const last = readJsonIfPresent<{ createdAt: number }>(paths.local("listing-published.json"));
  const createdAt = Math.max(Number(unixNow()), (last?.createdAt ?? 0) + 1);
  const event = await publishHiveListing(
    listing,
    {
      exitDelaySeconds: record.treasury.exitDelaySeconds,
      renewalWindowSeconds: record.treasury.renewalWindowSeconds,
      maxFeeSats: record.treasury.maxFeeSats,
    },
    unhex(publisher.secretKey),
    relays,
    createdAt,
  );
  writeJson(paths.local("listing-published.json"), {
    createdAt,
    eventId: event.id,
    listingId: listing.listingId,
  });
  return { hive: hive, listingId: listing.listingId, eventId: event.id, publisher: event.pubkey, relays };
}

/**
 * The hives listed on these relays for one network: each listing whose
 * keepers' keys derive the treasury it names, newest per treasury.
 */
export async function findHives(
  network: string,
  relays: string[],
  options: { deployment?: Deployment; maxWaitMs?: number } = {},
  ctx: OpsContext = {},
): Promise<{ found: number; hives: FoundHiveListing[] }> {
  const deployment = options.deployment ?? deploymentFor(network);
  const conn = await connect(deployment, ctx.fetch);
  const found = await fetchHiveListings(relays, deployment.network, {
    ...(options.maxWaitMs ? { maxWaitMs: options.maxWaitMs } : {}),
  });
  return { found: found.length, hives: currentHiveListings(conn, found) };
}

/** The newest listing of a hive, checked against its signatures and its own record. */
export function loadListing(hive: string): SignedHiveListing {
  const paths = opsPaths(hive);
  const directory = paths.local("listings");
  const names = existsSync(directory) ? readdirSync(directory).filter((n) => n.endsWith(".json")) : [];
  ensure(names.length > 0, "NO_LISTING", `pnpm ops listing ${hive} --name <name>`);
  const listing = validateHiveListing(readJson(resolve(directory, names.sort().at(-1)!)));
  const record = loadHive(hive);
  ensure(
    listing.body.hive === hive &&
      listing.body.network === record.network &&
      listing.body.treasuryScript === record.treasuryScript &&
      listing.body.stewardKeys.every((key, i) => key === record.stewardKeys[i]),
    "LISTING_MISMATCH",
    "the listing names another hive's keys or treasury",
  );
  return listing;
}

/**
 * Many hives on one server: each keeps its own routes, refund scanner and
 * halt switch, under `/h/<hive>/`, and the host lists them with their signed
 * listings and takes claims for all of them at one desk.
 */
export async function serveHost(
  names: string[],
  options: { port?: number; host?: string; maxLightningSats?: number; scanMs?: number },
  ctx: OpsContext = {},
): Promise<{ url: string; close(): Promise<void> }> {
  ensure(names.length > 0 && new Set(names).size === names.length, "USAGE", "name each hive once");
  const hives: HostedHive[] = [];
  const timers: NodeJS.Timeout[] = [];
  try {
    for (const name of names) {
      const { routes, treasury } = await hiveRoutes(name, options, ctx);
      const { hive: _, listing: __, ...hosted } = routes;
      hives.push({ ...hosted, listing: loadListing(name) });
      timers.push(setInterval(() => void refundOverdue(name, treasury), options.scanMs ?? 30_000));
    }
    const host = await startHiveHost({
      hives,
      ...(options.port ? { port: options.port } : {}),
      ...(options.host ? { host: options.host } : {}),
    });
    return {
      url: host.url,
      async close() {
        for (const timer of timers) clearInterval(timer);
        await host.close();
      },
    };
  } catch (error) {
    for (const timer of timers) clearInterval(timer);
    throw error;
  }
}

/**
 * Stop new work: for one hive, or for every hive this checkout runs. Claims,
 * refunds and withdrawals still finish. Each halt is also kept in a history.
 */
export function haltNewWork(reason: string, hive?: string): string {
  if (hive !== undefined) loadHive(hive);
  const file = haltFile(hive);
  mkdirSync(dirname(file), { recursive: true });
  writeOnce(resolve(dirname(file), "halt-history", `${hive ?? "all"}-${Date.now()}.json`), {
    hive: hive ?? null,
    reason,
    at: new Date().toISOString(),
  });
  writeFileSync(file, reason, { mode: 0o600 });
  return file;
}

export function resumeNewWork(hive?: string): void {
  rmSync(haltFile(hive), { force: true });
}

/** Hives whose refund scan is running: one scan per hive at a time, and never one hive waiting on another. */
const scanning = new Set<string>();

/** A pair refunds every escrow its watch left unrefunded past the fallback time. */
export async function refundOverdue(hive: string, treasury: Treasury): Promise<string[]> {
  if (scanning.has(hive)) return [];
  scanning.add(hive);
  const paths = opsPaths(hive);
  const refunded: string[] = [];
  try {
    const directory = paths.local("purchases");
    for (const label of stateExists(directory) ? readdirSync(directory) : []) {
      try {
        const bought = readPurchase(resolve(directory, label));
        const now = Date.now() / 1000;
        if (now < Number(bought.quote.body.timeoutAt)) continue;
        const done = readJsonIfPresent<Partial<RegisteredRefund> & { txid?: string }>(
          paths.local("refunds", `${label}.json`),
        );
        if (done?.txid) continue;
        // From the deadline the coordinator executes the refund itself; a pair registers it later if needed.
        const journalPath = paths.local("refund-executions", `${label}.json`);
        const legacyRegistration = done?.spendId ? (done as RegisteredRefund) : undefined;
        const atFallback = now >= refundFallbackAt(treasury, bought.quote);
        const own = await executeRefund(treasury, bought.quote, {
          journalPath,
          observeOnly: atFallback,
          ...(legacyRegistration ? { legacyRegistration } : {}),
        });
        if (own?.txid) {
          writeJson(paths.local("refunds", `${label}.json`), {
            ...done,
            route:
              own.attempts.filter((attempt) => attempt.result === "accepted").at(-1)?.route ?? "elsewhere",
            txid: own.txid,
            attempts: own.attempts,
          });
          refunded.push(label);
          continue;
        }
        if (!atFallback) continue;
        const registered = await refundEscrow(treasury, bought.quote, {
          journalPath,
          ...(legacyRegistration ? { legacyRegistration } : {}),
          escrowArtifactId: bought.escrow.artifactId,
        });
        if (registered) {
          const registrationPath = paths.local("refund-registrations", `${label}.json`);
          if (!stateExists(registrationPath)) writeOnce(registrationPath, registered);
        }
      } catch (error) {
        process.stderr.write(`refund ${label}: ${String(error)}\n`);
      }
    }
  } finally {
    scanning.delete(hive);
  }
  return refunded;
}

/** The purchase this hive made for an escrow id, by its label. */
function purchaseLabel(record: HiveRecord, escrowId: string): string | undefined {
  const directory = opsPaths(record.name).local("purchases");
  if (!stateExists(directory)) return undefined;
  return readdirSync(directory).find((label) => {
    try {
      return readPurchase(resolve(directory, label)).quote.quoteId === escrowId;
    } catch {
      return false;
    }
  });
}

export function hiveView(record: HiveRecord, conn: Connection): Promise<HiveView> {
  return buildHiveView(conn, {
    treasuryAddress: record.treasuryAddress,
    treasuryScript: record.treasuryScript,
    journalRoots: [opsPaths(record.name).local()],
    registration: record.registration,
    renewalMaxFeeSats: record.treasury.maxFeeSats,
  });
}

/** An Arkade address on this hive's own Operator, as a script. */
function destinationScript(conn: Connection, address: string): string {
  let decoded: { serverKey: string; pkScript: string };
  try {
    decoded = parseArkAddress(address);
  } catch {
    throw new Fault("INVALID_DESTINATION", "not an Arkade address");
  }
  ensure(decoded.serverKey === hex(xOnly(conn.keys.server)), "INVALID_DESTINATION", "another Operator");
  ensure(/^5120[0-9a-f]{64}$/.test(decoded.pkScript), "INVALID_DESTINATION", "not a P2TR script");
  return decoded.pkScript;
}

/** What a withdrawal or payout command did: one send per part, and what is still spendable. */
export interface Sweep<T> {
  parts: T[];
  remainingSats: number;
  /** Of `remainingSats`, what waits for its renewal: run the command again once that lands. */
  renewingSats: number;
  /** Every part landed and, for `all`, nothing spendable is left behind. */
  complete: boolean;
}

const sumSats = (coins: { amount: number }[]) => coins.reduce((n, c) => n + c.amount, 0);

/** Part 1 keeps the command's label; later parts of an `all` sweep add `.2`, `.3`, … */
const partLabel = (label: string, part: number) => (part === 1 ? label : `${label}.${part}`);

/**
 * Pay treasury coins to one Arkade address. The pair's two administrators
 * approve the exact terms (this checkout holds both), then the pair signs the
 * send those terms allow through the configured routes. One send spends at
 * most 16 coins, so `"all"` withdraws in parts until nothing spendable is
 * left; rerunning resumes each fixed part. A part may be replaced only after
 * its journal closes without an unresolved submission. Passing its posting
 * deadline does not revoke signatures already issued by a service.
 * A halt does not block a withdrawal.
 */
export async function withdrawTreasury(
  hive: string,
  label: string,
  options: { to: string; amount: string; hours?: number; pair?: Pair; routes?: RouteName[] },
  ctx: OpsContext = {},
): Promise<Sweep<SpendJournal>> {
  ensure(NAME.test(label), "INVALID", "label");
  const paths = opsPaths(hive);
  const record = loadHive(hive);
  ensure(!record.keepersHold, "KEEPERS_SIGN", `${hive}'s keepers sign each payment in the keeper console`);
  const treasury = await treasuryOf(record, ctx);
  const destination = destinationScript(treasury.conn, options.to);
  const pair = options.pair ?? "01";
  const wanted = options.amount === "all" ? undefined : Number(options.amount);
  const dust = treasury.conn.operator.dust;
  ensure(wanted === undefined || (Number.isSafeInteger(wanted) && wanted >= dust), "INVALID", "amount");
  const coins = () =>
    accountCoins(treasury.conn, record.treasuryScript, record.treasury.renewalWindowSeconds);
  const spendable = async () =>
    (await coins()).spendable
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 16)
      .reduce((n, c) => n + c.amount, 0);
  type Terms = { label: string; destination: string; amountSats: number; expiresAt: number };
  const parts: SpendJournal[] = [];
  for (let part = 1; ; part++) {
    const name = partLabel(label, part);
    // An approval pays once. An attempt that expired unsent is followed by another under a new
    // approval, with the coins the stewards still hold for the earlier one left out.
    let journal: SpendJournal | undefined;
    const earlier: SpendJournal[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const attemptName = attempt === 1 ? name : `${name}-${attempt}`;
      const termsPath = paths.local("withdrawals", `${attemptName}.terms.json`);
      let terms = readJsonIfPresent<Terms>(termsPath);
      if (!terms) {
        const available = await spendable();
        if (part > 1 && attempt === 1 && available < dust) break;
        const amount = wanted ?? available;
        if (amount < dust && (await coins()).renewing.length)
          fail("COINS_RENEWING", "the treasury's coins wait for their renewal; withdraw once it lands");
        ensure(amount >= dust, "TREASURY_INSUFFICIENT", `${available} sats spendable`);
        terms = writeOnce<Terms>(termsPath, {
          label: `${hive}.${attemptName}`,
          destination,
          amountSats: amount,
          expiresAt: Number(unixNow()) + Math.round((options.hours ?? 1) * 3600),
        });
        for (const i of pair.split("").map(Number))
          await approveWithdrawal(paths.secret(`steward-${i}.json`), terms);
      }
      ensure(terms.destination === destination, "JOURNAL_MISMATCH", "another destination");
      ensure(wanted === undefined || terms.amountSats === wanted, "JOURNAL_MISMATCH", "another amount");
      journal = await withdraw(treasury, {
        withdrawal: terms,
        journalPath: paths.local("withdrawals", `${attemptName}.json`),
        pair,
        exclude: reservedCoins(earlier),
        ...(options.routes ? { routes: options.routes } : {}),
      });
      if (journal.status !== "expired") break;
      earlier.push(journal);
    }
    if (!journal) break;
    parts.push(journal);
    if (wanted !== undefined || journal.status !== "done") break;
  }
  const left = await coins();
  const remainingSats = sumSats(left.spendable) + sumSats(left.renewing);
  return {
    parts,
    remainingSats,
    renewingSats: sumSats(left.renewing),
    complete: parts.every((p) => p.status === "done") && (wanted !== undefined || remainingSats === 0),
  };
}

/** Pay a provider's earnings from its payout wallet to an Arkade address; `"all"` pays in parts. */
export async function withdrawPayout(
  hive: string,
  provider: string,
  label: string,
  options: { to: string; amount: string; hours?: number },
  ctx: OpsContext = {},
): Promise<Sweep<WalletSendJournal>> {
  ensure(NAME.test(label), "INVALID", "label");
  const paths = opsPaths(hive);
  const record = loadHive(hive);
  const wallet = await payoutWallet(record, provider, ctx);
  const destination = destinationScript(wallet.conn, options.to);
  const amount = options.amount === "all" ? ("all" as const) : Number(options.amount);
  ensure(amount === "all" || Number.isSafeInteger(amount), "INVALID", "amount");
  const ownerSecret = unhex(
    readPrivateJson<ProviderSeed>(paths.secret("providers", provider, "seed.json")).payout,
  );
  const coins = () => accountCoins(wallet.conn, wallet.account.pkScript, wallet.terms.renewalWindowSeconds);
  const spendable = async () => (await coins()).spendable.length;
  const parts: WalletSendJournal[] = [];
  for (let part = 1; ; part++) {
    const journalPath = paths.local("providers", provider, "withdrawals", `${partLabel(label, part)}.json`);
    if (part > 1 && !stateExists(journalPath) && (await spendable()) === 0) break;
    const journal = await walletSend(wallet, ownerSecret, {
      journalPath,
      destination,
      amount,
      validUntil: Number(unixNow()) + Math.round((options.hours ?? 0.5) * 3600),
      purpose: { kind: "payout", destination, amount: String(amount) },
    });
    parts.push(journal);
    if (amount !== "all" || journal.status !== "done") break;
  }
  const left = await coins();
  const remainingSats = sumSats(left.spendable) + sumSats(left.renewing);
  return {
    parts,
    remainingSats,
    renewingSats: sumSats(left.renewing),
    complete: parts.every((p) => p.status === "done") && (amount !== "all" || remainingSats === 0),
  };
}

/** Pay a Lightning invoice from a provider's payout wallet; an expired quote is set aside and asked again once. */
export async function cashoutProvider(
  hive: string,
  provider: string,
  invoice: string,
  ctx: OpsContext = {},
  options: { settleTimeoutMs?: number; pollMs?: number } = {},
) {
  const paths = opsPaths(hive);
  const record = loadHive(hive);
  const wallet = await payoutWallet(record, provider, ctx);
  const ownerSecret = unhex(
    readPrivateJson<ProviderSeed>(paths.secret("providers", provider, "seed.json")).payout,
  );
  const args = {
    journalPath: paths.local("providers", provider, "cashouts", `${sha256Hex(invoice).slice(0, 16)}.json`),
    invoice,
    wallet,
    ownerSecret,
    rail: ctx.rail ?? publishedCashoutRail(wallet.conn),
    ...options,
  };
  let journal = await cashOut(wallet.conn, args);
  if (journal.status === "expired") {
    await retireExpiredCashout(args.journalPath);
    journal = await cashOut(wallet.conn, args);
  }
  return journal;
}

/**
 * Treasury coins whose batch ends soon. The delegatee renews them inside the
 * renewal window; one still unrenewed an hour before expiry means the renewal
 * is overdue and the coin should leave first.
 */
export function expiryWarnings(view: HiveView, withinSeconds = 3600): string[] {
  const horizon = Date.now() + withinSeconds * 1000;
  return view.treasury.coins
    .filter((coin) => coin.expiresAt && Date.parse(coin.expiresAt) < horizon)
    .map(
      (coin) =>
        `${coin.amountSats} sats at ${coin.txid}:${coin.vout} reach batch expiry ${coin.expiresAt} unrenewed: check \`pnpm ops renewal\``,
    );
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function every(args: string[], name: string): string[] {
  return args.flatMap((arg, i) => (arg === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  ensure(value, "USAGE", `--${name} is required`);
  return value;
}

async function main(argv: string[]): Promise<void> {
  const [command, hive, ...rest] = argv;
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  switch (command) {
    case "init": {
      const hours = option(rest, "renewal-window-hours");
      const maxFee = option(rest, "renewal-max-fee");
      const record = await initHive(hive!, {
        network: required(rest, "network"),
        ...(option(rest, "keepers") ? { keepers: parseKeeperKeys(option(rest, "keepers")!) } : {}),
        ...(option(rest, "lnurl") ? { lnurl: option(rest, "lnurl")! } : {}),
        ...(option(rest, "per-request-max") ? { perRequestMaxSats: option(rest, "per-request-max")! } : {}),
        ...(hours ? { renewalWindowSeconds: Math.round(Number(hours) * 3600) } : {}),
        ...(maxFee ? { renewalMaxFeeSats: Number(maxFee) } : {}),
      });
      print({
        hive: record.name,
        network: record.network,
        treasuryAddress: record.treasuryAddress,
        // The hive's agent takes this as --treasury-program: where every escrow returns.
        treasuryProgram: record.treasuryScript.slice(4),
        lightningAddress: record.registration?.lightningAddress ?? null,
        stewardKeys: record.stewardKeys,
        keepersHold: record.keepersHold ?? false,
        pairKeys: record.treasury.pairs,
        renewal: {
          windowSeconds: record.treasury.renewalWindowSeconds,
          maxFeeSats: record.treasury.maxFeeSats,
          delegatee: record.deployment.delegateeUrl,
          watch: record.renewalWatch.delegationId,
        },
      });
      return;
    }
    case "desk": {
      const { startDesk } = await import("./desk.js");
      const port = option(rest, "port");
      const desk = await startDesk(hive!, {
        agentLog: required(rest, "agent-log"),
        ...(option(rest, "governance") ? { governance: option(rest, "governance")! } : {}),
        ...(port ? { port: Number(port) } : {}),
        ...(option(rest, "host") ? { host: option(rest, "host")! } : {}),
        origins: every(rest, "origin"),
      });
      print({ hive, desk: `${desk.url}/desk/v1`, keepers: desk.desk.keepers });
      await new Promise(() => {});
      return;
    }
    case "renewal": {
      print(await renewalStatus(loadHive(hive!)));
      return;
    }
    case "provider-add": {
      const [provider] = rest;
      const { card, payoutAddress } = await addProvider(hive!, provider!, {
        model: required(rest, "model"),
        inputRate: required(rest, "input-rate"),
        outputRate: required(rest, "output-rate"),
        relay: required(rest, "relay"),
        ...(option(rest, "max-cap") ? { maxCapSats: option(rest, "max-cap")! } : {}),
      });
      print({ provider, cardId: card.cardId, payoutAddress });
      return;
    }
    case "provider-serve": {
      const [provider] = rest;
      const service = await startService(
        "packages/provider/src/solver-main.ts",
        [opsPaths(hive!).secret("providers", provider!, "solver.json")],
        { append: (line) => process.stderr.write(line) },
      );
      print({ provider, status: "serving quotes; Ctrl-C to stop" });
      await new Promise<void>((done) => process.once("SIGINT", () => done()));
      await service.close();
      return;
    }
    case "approve": {
      const [label] = rest;
      const minutes = Number(required(rest, "minutes"));
      ensure(Number.isSafeInteger(minutes) && minutes >= 5, "USAGE", "--minutes must be at least 5");
      const request = await approvePurchase(hive!, label!, {
        provider: required(rest, "provider"),
        capSats: required(rest, "cap"),
        timeoutSeconds: minutes * 60,
      });
      print({ label, requestId: request.requestId, capSats: request.capSats, timeoutAt: request.timeoutAt });
      return;
    }
    case "buy": {
      const [label] = rest;
      const activation = await buyEscrow(hive!, label!, { pair: pairOption(option(rest, "pair")) });
      print({
        label,
        escrowId: activation.quoteId,
        escrow: activation.coin,
        next: `pnpm ops escrow ${hive} ${label}`,
      });
      return;
    }
    case "escrow": {
      const [label] = rest;
      await runEscrow(hive!, label!, {
        upstream: option(rest, "upstream") ?? "http://127.0.0.1:9337/v1",
        desk: option(rest, "desk") ?? "http://127.0.0.1:8080/api/claim",
      });
      return;
    }
    case "serve": {
      const port = Number(option(rest, "port") ?? "8080");
      const served = await serveHive(hive!, {
        port,
        maxLightningSats: Number(option(rest, "max-lightning") ?? "25000"),
      });
      print({ page: served.url, claimDesk: `${served.url}/api/claim`, status: "serving; Ctrl-C to stop" });
      await new Promise<void>((done) => process.once("SIGINT", () => done()));
      await served.close();
      return;
    }
    case "status": {
      const record = loadHive(hive!);
      const view = await hiveView(record, await connect(record.deployment));
      const renewal = await renewalStatus(record);
      const warnings = expiryWarnings(view);
      if (renewal.template !== undefined && renewal.template !== "active")
        warnings.unshift(
          `RENEWALS_DISABLED: the delegatee's renewal template is ${renewal.template}; coins expire unrenewed until its administrator enables it`,
        );
      print({ ...view, renewal, warnings });
      return;
    }
    case "cashout": {
      const [provider, invoice] = rest;
      const journal = await cashoutProvider(hive!, provider!, invoice!);
      print({
        status: journal.status,
        fundAmount: journal.lockup.fundAmount,
        settlement: journal.settlement ?? null,
      });
      return;
    }
    case "withdraw": {
      const [label] = rest;
      const sweep = await withdrawTreasury(hive!, label!, {
        to: required(rest, "to"),
        amount: required(rest, "amount"),
        pair: pairOption(option(rest, "pair")),
        ...(option(rest, "hours") ? { hours: Number(option(rest, "hours")) } : {}),
      });
      print({
        label,
        complete: sweep.complete,
        remainingSats: sweep.remainingSats,
        renewingSats: sweep.renewingSats,
        parts: sweep.parts.map((p) => ({ status: p.status, txid: p.txid ?? null, amount: p.plan.amount })),
      });
      return;
    }
    case "payout": {
      const [provider, label] = rest;
      const sweep = await withdrawPayout(hive!, provider!, label!, {
        to: required(rest, "to"),
        amount: required(rest, "amount"),
      });
      print({
        provider,
        label,
        complete: sweep.complete,
        remainingSats: sweep.remainingSats,
        renewingSats: sweep.renewingSats,
        parts: sweep.parts.map((p) => ({ status: p.status, txid: p.txid ?? null, amount: p.plan.amount })),
      });
      return;
    }
    case "halt": {
      const only = hive === "--hive" ? rest[0] : undefined;
      const words = hive === "--hive" ? rest.slice(1) : [hive, ...rest];
      const reason = words.filter(Boolean).join(" ") || "halted by the operator";
      const file = haltNewWork(reason, only);
      print({ halted: true, hive: only ?? "all", reason, file });
      return;
    }
    case "resume": {
      const only = hive === "--hive" ? rest[0] : undefined;
      resumeNewWork(only);
      print({ halted: false, hive: only ?? "all" });
      return;
    }
    case "listing": {
      const purpose = option(rest, "purpose");
      const text = { name: required(rest, "name"), ...(purpose ? { purpose } : {}) };
      if (loadHive(hive!).keepersHold) {
        print({ pending: proposeListing(hive!, text), next: "each keeper signs it in the keeper console" });
        return;
      }
      const listing = writeListing(hive!, text);
      const relays = every(rest, "relay");
      print(relays.length > 0 ? { listing, published: await publishListing(hive!, relays) } : listing);
      return;
    }
    case "publish": {
      const relays = every(rest, "relay");
      ensure(relays.length > 0, "USAGE", "--relay is required");
      print(await publishListing(hive!, relays));
      return;
    }
    case "hives": {
      const args = [hive!, ...rest];
      const relays = every(args, "relay");
      ensure(relays.length > 0, "USAGE", "--relay is required");
      const { found, hives } = await findHives(required(args, "network"), relays);
      print({
        found,
        hives: hives.map(({ listing, publisher, publishedAt }) => ({
          hive: listing.body.hive,
          name: listing.body.name,
          purpose: listing.body.purpose,
          listingId: listing.listingId,
          treasuryScript: listing.body.treasuryScript,
          lightningAddress: listing.body.lightningAddress,
          signedAt: listing.body.createdAt,
          publisher,
          publishedAt,
        })),
      });
      return;
    }
    case "host": {
      const names = [hive!, ...rest];
      const cut = names.findIndex((arg) => arg.startsWith("--"));
      const hives = cut < 0 ? names : names.slice(0, cut);
      const served = await serveHost(hives, {
        port: Number(option(rest, "port") ?? "8080"),
        maxLightningSats: Number(option(rest, "max-lightning") ?? "25000"),
      });
      print({
        directory: served.url,
        hives: hives.map((p) => `${served.url}/h/${p}/`),
        claimDesk: `${served.url}/api/claim`,
        status: "serving; Ctrl-C to stop",
      });
      await new Promise<void>((done) => process.once("SIGINT", () => done()));
      await served.close();
      return;
    }
    default:
      process.stderr.write(
        "usage: pnpm ops <init|renewal|provider-add|provider-serve|approve|buy|escrow|serve|listing|publish|hives|host|status|withdraw|payout|cashout|halt|resume> …\n",
      );
      process.exitCode = 2;
  }
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`ops stopped: ${(error as { code?: string }).code ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
