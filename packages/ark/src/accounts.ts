import { ensure } from "@hive/kit";
import { type Instance, instantiate } from "./contract.js";
import type { Connection } from "./deployment.js";
import { type Delegation, type IndexedCoin, requireCoinExpiry } from "./services.js";
import { arkAddress } from "./taproot.js";
import {
  ARTIFACTS,
  type ContractKind,
  type EscrowTerms,
  escrowArguments,
  escrowRefundTemplate,
  type TreasuryTerms,
  treasuryArguments,
  treasuryRenewalTemplate,
  type WalletTerms,
  walletArguments,
  walletRenewalTemplate,
  walletVariables,
} from "./templates.js";

/**
 * An account is a contract instance with its one delegatee watch: renewal for
 * the treasury and the wallets, the deadline refund for an escrow. Every
 * address the delegatee reports is checked against our own derivation, leaf
 * for leaf, before anything is paid to it.
 */
export interface Account {
  kind: ContractKind;
  args: Record<string, string>;
  instance: Instance;
  address: string;
  pkScript: string;
  artifactId: string;
  watch: { templateId: string; delegationId: string };
}

export function verifyWatch(
  instance: Instance,
  delegation: Delegation,
  address: string,
  expected?: { templateId: string },
): void {
  ensure(delegation.status === "active", "DELEGATEE_MISMATCH", `watch is ${delegation.status}`);
  ensure(delegation.address === address, "DELEGATEE_MISMATCH", "the delegatee watches another address");
  if (expected) {
    // Our template, with no expiry of its own: a watch that lapses would leave the coin unwatched.
    ensure(
      delegation.templateId === expected.templateId,
      "DELEGATEE_MISMATCH",
      "another template watches it",
    );
    ensure(delegation.expiresAt === 0, "DELEGATEE_MISMATCH", "the watch expires");
  }
  const slot = delegation.slots[0];
  ensure(
    slot && JSON.stringify(slot.tapscripts) === JSON.stringify(instance.tapscripts),
    "DELEGATEE_MISMATCH",
    "the delegatee derives other leaves",
  );
}

async function register(
  conn: Connection,
  kind: ContractKind,
  args: Record<string, string>,
  template: (artifactId: string) => Record<string, unknown>,
  variables: Record<string, string>,
): Promise<Account> {
  const instance = instantiate(ARTIFACTS[kind], args, conn.keys);
  const address = arkAddress(conn.deployment.network, conn.keys.server, instance.pkScript);
  const artifactId = await conn.delegatee.registerArtifact(ARTIFACTS[kind]);
  const templateId = await conn.delegatee.registerTemplate(template(artifactId));
  const delegation = await conn.delegatee.watch(templateId, variables);
  verifyWatch(instance, delegation, address, { templateId });
  return {
    kind,
    args,
    instance,
    address,
    pkScript: instance.pkScript,
    artifactId,
    watch: { templateId, delegationId: delegation.id },
  };
}

/** The treasury and its renewal watch; the template carries this hive's own constructor values. */
export const treasuryAccount = (conn: Connection, terms: TreasuryTerms): Promise<Account> =>
  register(conn, "treasury", treasuryArguments(terms), (id) => treasuryRenewalTemplate(id, terms), {});

/** One escrow and its deadline refund, registered before the escrow is funded. */
export const escrowAccount = (conn: Connection, terms: EscrowTerms): Promise<Account> =>
  register(conn, "escrow", escrowArguments(terms), (id) => escrowRefundTemplate(id, terms), {});

/** A payout wallet: the SimpleWallet contract and its renewal template. */
export const walletAccount = (conn: Connection, terms: WalletTerms): Promise<Account> =>
  register(conn, "wallet", walletArguments(terms), walletRenewalTemplate, walletVariables(terms));

/** The same account derived locally, without asking the delegatee. */
export function deriveAccount(
  conn: Pick<Connection, "deployment" | "keys">,
  kind: ContractKind,
  args: Record<string, string>,
): Pick<Account, "kind" | "args" | "instance" | "address" | "pkScript"> {
  const instance = instantiate(ARTIFACTS[kind], args, conn.keys);
  return {
    kind,
    args,
    instance,
    address: arkAddress(conn.deployment.network, conn.keys.server, instance.pkScript),
    pkScript: instance.pkScript,
  };
}

/**
 * An account's unspent coins, split by whether a spend may take them. A coin
 * inside its renewal window, or within `marginSeconds` of it, belongs to the
 * renewal watch: the delegatee takes it for the next batch, and a spend of it
 * would only be skipped. Once renewed, its successor is spendable again.
 */
export async function accountCoins(
  conn: Connection,
  pkScript: string,
  renewalWindowSeconds: number,
  marginSeconds = 600,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ spendable: IndexedCoin[]; renewing: IndexedCoin[] }> {
  const coins = (await conn.arkd.coins({ scripts: [pkScript], spendableOnly: true })).filter(
    (c) => c.script === pkScript && !c.isSpent && !c.isSwept,
  );
  for (const coin of coins) requireCoinExpiry(coin);
  const held = (c: IndexedCoin) => requireCoinExpiry(c) - nowSeconds <= renewalWindowSeconds + marginSeconds;
  return { spendable: coins.filter((c) => !held(c)), renewing: coins.filter(held) };
}

/** Coins a spend may take: unspent, not swept, and not about to renew. */
export async function spendableCoins(
  conn: Connection,
  pkScript: string,
  renewalWindowSeconds: number,
  marginSeconds = 600,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IndexedCoin[]> {
  return (await accountCoins(conn, pkScript, renewalWindowSeconds, marginSeconds, nowSeconds)).spendable;
}

/** Re-read exactly the selected inputs before authorizing a spend. */
export async function lookupSpendCoins(
  conn: Connection,
  selected: readonly { txid: string; vout: number; amount: number; script: string }[],
  minimumExpiry = 0,
  signal?: AbortSignal,
): Promise<(IndexedCoin & { expiresAt: number })[]> {
  const outpoint = (coin: { txid: string; vout: number }) => coin.txid + ":" + coin.vout;
  const expected = selected.map(outpoint);
  const indexed = await conn.arkd.coins({ outpoints: expected }, signal);
  const seen = new Map(indexed.map((coin) => [outpoint(coin), coin]));
  ensure(
    new Set(expected).size === expected.length &&
      indexed.length === expected.length &&
      seen.size === expected.length &&
      expected.every((key) => seen.has(key)),
    "COIN_UNKNOWN",
    "the input lookup is incomplete or duplicated",
  );
  return selected.map((coin) => {
    const observation = seen.get(outpoint(coin))!;
    ensure(
      observation.script === coin.script && observation.amount === coin.amount,
      "COIN_UNKNOWN",
      outpoint(coin),
    );
    ensure(
      !observation.isSpent &&
        !observation.isSwept &&
        !observation.spentBy &&
        !observation.settledBy &&
        !observation.arkTxid,
      "COIN_SPENT",
      outpoint(coin),
    );
    const expiresAt = requireCoinExpiry(observation);
    ensure(expiresAt >= minimumExpiry, "COIN_EXPIRES_TOO_SOON", outpoint(coin));
    return { ...observation, expiresAt };
  });
}
