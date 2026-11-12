import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  AUTHORIZATION_GRACE_SECONDS,
  type EscrowTerms,
  escrowAccount,
  type Pair,
  REFUND_MARGIN_SECONDS,
  requireCoinExpiry,
} from "@hive/ark";
import {
  ensure,
  nowIso,
  readJson,
  readJsonIfPresent,
  requireNotHalted,
  withLock,
  writeJson,
  writeOnce,
} from "@hive/kit";
import { escrowTermsFromQuote, requireValidSignedQuote, type SignedQuote } from "@hive/protocol";
import {
  driveTreasurySpend,
  newSpendJournal,
  planTreasurySend,
  type SpendJournal,
  type Treasury,
} from "./treasury.js";

/**
 * One purchase: an escrow for a provider's quote, its deadline refund watched
 * by the delegatee before a sat moves, and its funding from the treasury by
 * one pair of stewards. Inference may start once the hive itself observes the
 * escrow coin with the quoted cap and a batch expiry past the deadline.
 */
export interface PurchaseRecord {
  schema: "hive-purchase/v4";
  quote: SignedQuote;
  escrow: { terms: EscrowTerms; address: string; pkScript: string; artifactId: string; refundWatch: string };
  createdAt: string;
}

export interface EscrowActivation {
  schema: "hive-activation/v4";
  quoteId: string;
  coin: { txid: string; vout: number; amountSats: number; expiresAt: number };
  activatedAt: string;
}

export const PURCHASE_FILE = "purchase.json";
export const ACTIVATION_FILE = "activation.json";

/** Funding journals in order: `funding.json`, then `funding-2.json` after an expired attempt. */
export function fundingJournals(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^funding(-\d+)?\.json$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)?.[0] ?? 1) - Number(/\d+/.exec(b)?.[0] ?? 1))
    .map((name) => resolve(directory, name));
}

export async function purchase(
  treasury: Treasury,
  args: { quote: SignedQuote; directory: string; pair?: Pair; validSeconds?: number; attempts?: number },
): Promise<{ record: PurchaseRecord; funding: SpendJournal; activation: EscrowActivation }> {
  const quote = requireValidSignedQuote(args.quote);
  const terms = escrowTermsFromQuote(quote) as EscrowTerms;
  const recordPath = resolve(args.directory, PURCHASE_FILE);
  let record = readJsonIfPresent<PurchaseRecord>(recordPath);
  if (!record) {
    // A halted hive starts nothing new; a purchase already under way still finishes.
    requireNotHalted(treasury.hive);
    // The refund watch first: an escrow is never funded without it.
    const escrow = await escrowAccount(treasury.conn, terms);
    record = writeOnce<PurchaseRecord>(recordPath, {
      schema: "hive-purchase/v4",
      quote,
      escrow: {
        terms,
        address: escrow.address,
        pkScript: escrow.pkScript,
        artifactId: escrow.artifactId,
        refundWatch: escrow.watch.delegationId,
      },
      createdAt: nowIso(),
    });
  }
  ensure(record.quote.quoteId === quote.quoteId, "PURCHASE_CHANGED");
  let funding: SpendJournal | undefined;
  const earlier: SpendJournal[] = [];
  for (let attempt = 1; attempt <= (args.attempts ?? 3); attempt++) {
    const path = resolve(args.directory, attempt === 1 ? "funding.json" : `funding-${attempt}.json`);
    await withLock(`${path}.lock`, async () => {
      if (!existsSync(path)) {
        const plan = await planTreasurySend(treasury, {
          pair: args.pair ?? "01",
          amount: Number(quote.body.capSats),
          destination: record.escrow.pkScript,
          validSeconds: Math.min(
            args.validSeconds ?? 600,
            Number(quote.body.quoteExpiresAt) - Math.floor(Date.now() / 1000) - 5,
          ),
          // An unresolved submitted action keeps its inputs excluded on every resume.
          exclude: reservedCoins(earlier),
        });
        writeJson(
          path,
          newSpendJournal(
            `purchase-${quote.quoteId.slice(0, 12)}-${attempt}`,
            { kind: "allocation", quote },
            plan,
          ),
        );
      }
    });
    funding = await driveTreasurySpend(treasury, path);
    if (funding.status === "done") break;
    earlier.push(funding);
  }
  ensure(funding?.status === "done", "FUNDING_EXPIRED");
  const activationPath = resolve(args.directory, ACTIVATION_FILE);
  const saved = readJsonIfPresent<EscrowActivation>(activationPath);
  if (saved) return { record, funding, activation: saved };
  const coin = (await treasury.conn.arkd.coins({ scripts: [record.escrow.pkScript] })).find(
    (c) => c.txid === funding.txid && c.script === record.escrow.pkScript,
  );
  ensure(coin && !coin.isSpent, "ESCROW_UNAVAILABLE");
  ensure(coin.amount === Number(quote.body.capSats), "ESCROW_MISMATCH");
  ensure(
    requireCoinExpiry(coin) >= terms.timeoutAt + REFUND_MARGIN_SECONDS[treasury.conn.deployment.network],
    "ESCROW_EXPIRES_TOO_SOON",
  );
  const activation = writeOnce<EscrowActivation>(activationPath, {
    schema: "hive-activation/v4",
    quoteId: quote.quoteId,
    coin: { txid: coin.txid, vout: coin.vout, amountSats: coin.amount, expiresAt: requireCoinExpiry(coin) },
    activatedAt: nowIso(),
  });
  return { record, funding, activation };
}

/** Coordinator exclusions outlive the steward admission window when posting remains ambiguous. */
export function reservedCoins(
  journals: SpendJournal[],
  nowSeconds = Math.floor(Date.now() / 1000),
): string[] {
  return journals
    .filter((j) => {
      if (j.status === "done") return false;
      const uncertain = j.execution
        ? j.execution.legacyUnknown || j.execution.attempts.length > 0
        : Boolean(j.request || j.attempts?.length || j.status === "registered");
      return uncertain || nowSeconds < j.plan.validUntil + AUTHORIZATION_GRACE_SECONDS;
    })
    .flatMap((j) => j.plan.coins.map((c) => `${c.txid}:${c.vout}`));
}

export const readPurchase = (directory: string): PurchaseRecord =>
  readJson<PurchaseRecord>(resolve(directory, PURCHASE_FILE));
