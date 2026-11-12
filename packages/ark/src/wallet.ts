import {
  type Attempt,
  buildSpend,
  type RouteName,
  type ExecutionState,
  executionState,
  executionAttempts,
} from "@hive/executor";
import { ensure, ensureEqual, fail, readJsonIfPresent, withLock, writeJson } from "@hive/kit";
import { type Account, accountCoins, deriveAccount, lookupSpendCoins, walletAccount } from "./accounts.js";
import { instantiate } from "./contract.js";
import { type CovenantSpend, sendSpend } from "./covenant.js";
import type { Connection } from "./deployment.js";
import type { SpendRequest } from "./services.js";
import {
  AUTHORIZATION_GRACE_SECONDS,
  pickCoins,
  type SendPlan,
  type SendTerms,
  sendSignatures,
  walletPlanVariables,
  walletSendRequest,
} from "./spends.js";
import { taprootAddress } from "./taproot.js";
import {
  BOARDING_CONTRACT,
  boardingArguments,
  type WalletTerms,
  walletArguments,
  walletBoardingTemplate,
  walletBoardingVariables,
  walletSendTemplate,
} from "./templates.js";

/**
 * A single-owner account on the SimpleWallet contract: the provider's payout
 * account and any other key that only receives and sends. The delegatee
 * renews its coins under the wallet's watch; each send its owner signs is
 * executed by the wallet itself through the Emulator or by the delegatee.
 * The owner's key signs the send's terms and nothing else.
 */
export interface Wallet {
  conn: Connection;
  terms: WalletTerms;
  account: Account;
}

/** The wallet's terms on this deployment: the Operator's exit delay and the owner's renewal settings. */
export function walletTerms(
  conn: Pick<Connection, "operator">,
  owner: string,
  settings: { renewalWindowSeconds: number; maxFeeSats: number },
): WalletTerms {
  ensure(/^0[23][0-9a-f]{64}$/.test(owner), "INVALID", "a wallet owner is a compressed public key");
  ensure(
    Number.isSafeInteger(settings.renewalWindowSeconds) &&
      settings.renewalWindowSeconds > 0 &&
      Number.isSafeInteger(settings.maxFeeSats) &&
      settings.maxFeeSats >= 0,
    "INVALID",
    "wallet settings",
  );
  return { owner, exitDelaySeconds: conn.operator.unilateralExitDelay, ...settings };
}

/** Register the wallet's renewal watch (idempotent) and check the delegatee derives our address. */
export async function openWallet(conn: Connection, terms: WalletTerms): Promise<Wallet> {
  return { conn, terms, account: await walletAccount(conn, terms) };
}

/**
 * The wallet's boarding address: bitcoin sent there is boarded into the
 * wallet by the delegatee once it confirms, for a fee within the wallet's
 * limit. The address is checked against our own derivation, leaf for leaf.
 */
export async function walletBoarding(wallet: Wallet): Promise<{ address: string; pkScript: string }> {
  const { conn, terms } = wallet;
  const exitDelay = conn.operator.boardingExitDelay;
  const instance = instantiate(
    BOARDING_CONTRACT,
    boardingArguments(terms, wallet.account.pkScript.slice(4), exitDelay),
    conn.keys,
  );
  const templateId = await conn.delegatee.registerTemplate(walletBoardingTemplate(wallet.account.artifactId));
  const delegation = await conn.delegatee.watch(templateId, walletBoardingVariables(terms, exitDelay));
  const address = taprootAddress(conn.deployment.network, instance.pkScript);
  ensure(delegation.address === address, "DELEGATEE_MISMATCH", "the delegatee boards from another address");
  ensure(
    JSON.stringify(delegation.slots[0]?.tapscripts) === JSON.stringify(instance.tapscripts),
    "DELEGATEE_MISMATCH",
    "the delegatee derives other boarding leaves",
  );
  return { address, pkScript: instance.pkScript };
}

/** The wallet's script without asking the delegatee: what a provider card names as its payout script. */
export const walletScript = (conn: Pick<Connection, "deployment" | "keys">, terms: WalletTerms): string =>
  deriveAccount(conn, "wallet", walletArguments(terms)).pkScript;

export async function walletBalance(
  wallet: Wallet,
): Promise<{ spendableSats: number; renewingSats: number; coins: number }> {
  const { spendable, renewing } = await accountCoins(
    wallet.conn,
    wallet.account.pkScript,
    wallet.terms.renewalWindowSeconds,
  );
  const sum = (coins: { amount: number }[]) => coins.reduce((n, c) => n + c.amount, 0);
  return {
    spendableSats: sum(spendable),
    renewingSats: sum(renewing),
    coins: spendable.length + renewing.length,
  };
}

/**
 * A wallet send from its signed request to its observed outcome. The owner's
 * signatures are not deterministic, so the request and the spend they make
 * are saved before anything is posted, and every resume posts the same bytes.
 * The router hands the spend to its first route that takes it: the wallet
 * itself through the Emulator, or the delegatee from the request. Both build
 * the transaction `arkTxid` names, and the delegatee answers a repeated
 * request with the same spend.
 */
export interface WalletSendJournal {
  schema: "hive-wallet-send/v4";
  purpose: Record<string, unknown>;
  plan: SendPlan;
  request: SpendRequest;
  /** The same send as data, for a route that builds it itself. */
  spend?: CovenantSpend;
  /** The txid every route builds. */
  arkTxid?: string;
  status: "signed" | "registered" | "done" | "expired";
  /** The delegatee's spend id, once the delegatee took it. */
  spendId?: string;
  /** Each route's answer, in order. */
  attempts?: Attempt[];
  execution?: ExecutionState;
  txid?: string;
}

export interface WalletSendArgs {
  journalPath: string;
  /** The P2TR script paid. */
  destination: string;
  /** Exact sats, or "all": the largest spendable coins, at most 16, with no change. */
  amount: number | "all";
  /** The local posting deadline; a previous submission still requires reconciliation. */
  validUntil: number;
  /** What the send is for; a resumed journal must name the same purpose. */
  purpose: Record<string, unknown>;
  /** Admission for each new post; throwing prevents that post. */
  beforeSubmit?: () => void;
  /** The routes to try, in order; the connection's order by default. */
  routes?: RouteName[];
  pollMs?: number;
  timeoutMs?: number;
}

export async function walletSend(
  wallet: Wallet,
  secretKey: Uint8Array,
  args: WalletSendArgs,
): Promise<WalletSendJournal> {
  return withLock(`${args.journalPath}.lock`, async () => {
    let journal = readJsonIfPresent<WalletSendJournal>(args.journalPath);
    if (journal) {
      ensure(journal.schema === "hive-wallet-send/v4", "JOURNAL_SCHEMA");
      ensureEqual(journal.purpose, args.purpose, "JOURNAL_MISMATCH", "purpose");
      ensure(journal.plan.destination === args.destination, "JOURNAL_MISMATCH", "destination");
    } else {
      journal = await signSend(wallet, secretKey, args);
      writeJson(args.journalPath, journal);
    }
    return driveWalletSend(wallet, args.journalPath, journal, args);
  });
}

async function signSend(
  wallet: Wallet,
  secretKey: Uint8Array,
  args: WalletSendArgs,
): Promise<WalletSendJournal> {
  const now = Math.floor(Date.now() / 1000);
  ensure(
    Number.isSafeInteger(args.validUntil) && args.validUntil > now + 30 && args.validUntil <= now + 86_400,
    "INVALID",
    "a send is valid for 30 seconds to a day",
  );
  ensure(/^5120[0-9a-f]{64}$/.test(args.destination), "INVALID", "a wallet pays P2TR scripts only");
  const coins = await accountCoins(wallet.conn, wallet.account.pkScript, wallet.terms.renewalWindowSeconds);
  const dust = wallet.conn.operator.dust;
  let picked: typeof coins.spendable;
  let change: number;
  let amount: number;
  if (args.amount === "all") {
    picked = [...coins.spendable].sort((a, b) => b.amount - a.amount).slice(0, 16);
    amount = picked.reduce((n, c) => n + c.amount, 0);
    change = 0;
    if (amount < dust && coins.renewing.length)
      fail("COINS_RENEWING", "every coin waits for its renewal; send again once it lands");
    if (amount < dust) fail("INSUFFICIENT_FUNDS", `${amount} sats spendable`);
  } else {
    ({ picked, change } = pickCoins(coins, args.amount, dust));
    amount = args.amount;
  }
  const templateId = await wallet.conn.delegatee.registerTemplate(
    walletSendTemplate(wallet.account.artifactId, picked.length, change > 0),
  );
  const terms: SendTerms = { amount, change, validUntil: args.validUntil, destination: args.destination };
  const plan: SendPlan = {
    account: "wallet",
    coins: picked.map((c) => ({ txid: c.txid, vout: c.vout, amount: c.amount, script: c.script })),
    templateId,
    variables: walletPlanVariables(wallet.terms, terms),
    ...terms,
  };
  await lookupSpendCoins(
    wallet.conn,
    plan.coins,
    Math.floor(Date.now() / 1000) + wallet.terms.renewalWindowSeconds + AUTHORIZATION_GRACE_SECONDS + 1,
  );
  const unroll = wallet.conn.operator.checkpointTapscript;
  const signatures = sendSignatures(plan, wallet.account.instance, unroll, secretKey);
  const request = walletSendRequest(plan, signatures, secretKey);
  const spend = sendSpend(plan, wallet.account.instance, signatures);
  return {
    schema: "hive-wallet-send/v4",
    purpose: args.purpose,
    plan,
    request,
    spend,
    arkTxid: buildSpend(spend, unroll).txid,
    execution: executionState(
      { txid: buildSpend(spend, unroll).txid, spend, request, validUntil: plan.validUntil },
      args.routes ?? wallet.conn.router.routes,
    ),
    status: "signed",
  };
}

async function driveWalletSend(
  wallet: Wallet,
  path: string,
  journal: WalletSendJournal,
  args: Pick<WalletSendArgs, "beforeSubmit" | "pollMs" | "timeoutMs" | "routes">,
): Promise<WalletSendJournal> {
  if (journal.status === "done") return journal;
  const now = () => Math.floor(Date.now() / 1000);
  // Stop new posts at the local deadline; any earlier uncertain submission still needs observation.
  const posting = journal.status !== "signed" || now() < journal.plan.validUntil;
  if (!journal.spend) {
    const signatures = journal.plan.coins.map((_coin, index) => journal.request.variables[`sig_${index}`]!);
    ensure(
      signatures.every((signature) => /^[0-9a-f]{128}$/.test(signature ?? "")),
      "JOURNAL_MISMATCH",
    );
    journal.spend = sendSpend(journal.plan, wallet.account.instance, signatures);
    const txid = buildSpend(journal.spend, wallet.conn.operator.checkpointTapscript).txid;
    ensure(!journal.arkTxid || journal.arkTxid === txid, "ACTION_MISMATCH");
    journal.arkTxid = txid;
    writeJson(path, journal);
  }
  const action = {
    txid: journal.arkTxid ?? "",
    ...(journal.spend ? { spend: journal.spend } : {}),
    request: journal.request,
    validUntil: journal.plan.validUntil,
  };
  if (!journal.execution) {
    journal.execution = executionState(
      action,
      args.routes ?? wallet.conn.router.routes,
      journal.attempts,
      true,
    );
    writeJson(path, journal);
  }
  const outcome = await wallet.conn.router.execute(action, {
    timeoutMs: args.timeoutMs ?? 120_000,
    ...(args.beforeSubmit ? { beforeSubmit: args.beforeSubmit } : {}),
    ...(posting ? (args.routes ? { routes: args.routes } : {}) : { routes: [] }),
    execution: journal.execution,
    onState: (state) => {
      journal.execution = state;
      journal.attempts = executionAttempts(state);
      const accepted = journal.attempts.filter((attempt) => attempt.result === "accepted");
      if (accepted.length) journal.status = "registered";
      const registered = accepted.find((attempt) => attempt.route === "delegatee");
      if (registered?.reference) journal.spendId = registered.reference;
      writeJson(path, journal);
    },
  });
  if (outcome.status === "elsewhere")
    fail("SEND_SUPERSEDED", "an input is affirmatively linked to another spend");
  if (outcome.status === "invalid") fail(journal.attempts?.at(-1)?.detail ?? "SEND_INVALID");
  if (outcome.status === "pending") {
    const last = outcome.attempts.at(-1) ?? journal.attempts?.at(-1);
    fail("SEND_PENDING", last?.detail || "no observed outcome");
  }
  if (outcome.status === "done") {
    journal.status = "done";
    journal.txid = journal.arkTxid;
  } else journal.status = "expired";
  writeJson(path, journal);
  return journal;
}
