import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ClaimPlan,
  type Connection,
  claimSpend,
  deriveAccount,
  type EscrowTerms,
  escrowArguments,
  refundSpend,
} from "@hive/ark";
import { type Action, buildSpend, observeSpend } from "@hive/executor";
import { readJson } from "@hive/kit";
import { escrowTermsFromQuote, type SignedReceipt, verifyReceipt } from "@hive/protocol";
import { type Contribution, observeTreasury, type Renewal, type UnattributedBatch } from "./contributions.js";
import type { IntakeRegistration, IntakeRequest } from "./intake.js";
import type { PurchaseRecord } from "./purchase.js";
import type { SpendJournal } from "./treasury.js";

/**
 * What the hive page shows, derived from observed outputs, the hive's own
 * records and signed receipts. Nothing is credited,
 * paid or refunded before its output exists.
 */
export interface HiveView {
  schema: "hive-view/v4";
  generatedAt: string;
  treasury: {
    address: string;
    script: string;
    lightningAddress: string | null;
    balanceSats: number;
    coins: { txid: string; vout: number; amountSats: number; expiresAt: string | null }[];
  };
  contributions: Contribution[];
  /** Coins renewed into a new batch: never counted as contributions. */
  renewals: Renewal[];
  /** Ambiguous batch outputs are excluded from contribution totals. */
  unattributed: UnattributedBatch[];
  escrows: EscrowView[];
  totals: { contributedSats: number; inEscrowSats: number; paidSats: number; refundedSats: number };
}

export interface EscrowView {
  escrowId: string;
  model: string;
  providerPayoutScript: string;
  capSats: number;
  timeoutAt: string;
  address: string;
  coin: { txid: string; vout: number; amountSats: number } | null;
  status: "funding" | "open" | "claimed" | "refunded" | "closed";
  /** The latest receipt the payer signed for this escrow, checked against the quote's receipt key. */
  receipt: { amountSats: number; signature: string } | null;
  close: { kind: "claim" | "refund"; txid: string; providerSats: number; treasurySats: number } | null;
}

type Found = { path: string; value: { schema?: string } };

function walk(roots: readonly string[]): Found[] {
  const found: Found[] = [];
  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".json"))
        try {
          found.push({ path, value: readJson<{ schema?: string }>(path) });
        } catch {
          // Locks, partial files and other state are skipped.
        }
    }
  };
  for (const root of roots) visit(root);
  return found;
}

export async function buildHiveView(
  conn: Connection,
  args: {
    treasuryAddress: string;
    treasuryScript: string;
    journalRoots: readonly string[];
    registration?: IntakeRegistration | null;
    /** The treasury's renewal fee limit, by which renewals are told from deposits. */
    renewalMaxFeeSats: number;
  },
): Promise<HiveView> {
  const found = walk(args.journalRoots);
  const of = <T>(schema: string) =>
    found.filter((f) => f.value.schema === schema).map((f) => f.value as unknown as T);
  const purchases = of<PurchaseRecord>("hive-purchase/v4");
  const spends = of<SpendJournal>("hive-spend/v4");
  const requests = of<IntakeRequest>("hive-intake-request/v4");
  const ledgers = of<{ escrowId: string; latestReceipt: SignedReceipt | null }>("hive-agent-ledger/v4");

  // Escrow coins and the transactions that closed them.
  const escrowScripts = purchases.map((p) => p.escrow.pkScript);
  const escrowCoins = escrowScripts.length ? await conn.arkd.coins({ scripts: escrowScripts }) : [];
  const closingTxids = new Set(escrowCoins.filter((c) => c.isSpent && c.arkTxid).map((c) => c.arkTxid));
  const internal = new Set<string>([
    ...spends.filter((s) => s.status === "done" && s.txid).map((s) => s.txid!),
    ...closingTxids,
  ]);
  const { coins, contributions, renewals, unattributed } = await observeTreasury(conn, {
    treasuryScript: args.treasuryScript,
    internalTxids: internal,
    renewalMaxFeeSats: args.renewalMaxFeeSats,
    requests,
  });
  const unspent = coins.filter((c) => !c.isSpent);

  const claims = of<{ escrowId: string; claimAction?: Action }>("hive-provider-claim/v4");
  const deskClaims = found.map((item) => item.value as { escrow?: string; claim?: ClaimPlan });
  const observe = observeSpend({
    coins: (query) => conn.arkd.coins(query),
    checkpointTapscript: conn.operator.checkpointTapscript,
  });
  const escrows = await Promise.all(
    purchases.map(async (p): Promise<EscrowView> => {
      const quote = p.quote;
      // The escrow's own coin is the one of exactly the cap; anything else at its address is not the purchase.
      const coin =
        escrowCoins.find((c) => c.script === p.escrow.pkScript && c.amount === Number(quote.body.capSats)) ??
        null;
      const context = {
        escrowId: quote.quoteId,
        payerReceiptKey: quote.body.payerReceiptKey,
        capSats: quote.body.capSats,
      };
      const signed = ledgers.find((l) => l.escrowId === quote.quoteId)?.latestReceipt ?? null;
      const receipt =
        signed && verifyReceipt(signed, context)
          ? { amountSats: Number(signed.amountSats), signature: signed.signature }
          : null;
      let status: EscrowView["status"] = "funding";
      let close: EscrowView["close"] = null;
      if (coin && !coin.isSpent) status = "open";
      else if (coin?.isSpent) {
        status = "closed";
        const terms = escrowTermsFromQuote(quote) as EscrowTerms;
        const instance = deriveAccount(conn, "escrow", escrowArguments(terms)).instance;
        const source = { txid: coin.txid, vout: coin.vout, amount: coin.amount, script: coin.script };
        let claim = claims.find((journal) => journal.escrowId === quote.quoteId)?.claimAction;
        if (!claim) {
          const recorded = deskClaims.find(
            (journal) =>
              journal.escrow === p.escrow.pkScript &&
              journal.claim?.escrow?.escrowId === quote.quoteId &&
              journal.claim.coin.txid === coin.txid &&
              journal.claim.coin.vout === coin.vout,
          )?.claim;
          if (recorded) {
            const spend = claimSpend(recorded, instance);
            claim = {
              txid: buildSpend(spend, conn.operator.checkpointTapscript).txid,
              spend,
              validUntil: recorded.expiresAt,
            };
          }
        }
        const input = claim?.spend?.inputs;
        if (
          claim?.spend &&
          input?.length === 1 &&
          input[0]!.txid === coin.txid &&
          input[0]!.vout === coin.vout &&
          (await observe(claim)) === "spent"
        ) {
          const providerSats = claim.spend.outputs
            .filter((output) => output.script === quote.body.providerPayoutScript)
            .reduce((sum, output) => sum + output.amount, 0);
          const treasurySats = claim.spend.outputs
            .filter((output) => output.script === args.treasuryScript)
            .reduce((sum, output) => sum + output.amount, 0);
          if (providerSats > 0 && providerSats + treasurySats === coin.amount) {
            status = "claimed";
            close = { kind: "claim", txid: claim.txid, providerSats, treasurySats };
          }
        }
        if (!close) {
          // A historical refund has no expiry argument in its covenant. No post is made here.
          const spend = refundSpend(
            { escrow: terms, coin: source, templateId: "", expiresAt: terms.timeoutAt },
            instance,
          );
          const refund = {
            txid: buildSpend(spend, conn.operator.checkpointTapscript).txid,
            spend,
            validUntil: terms.timeoutAt,
          };
          if ((await observe(refund)) === "spent") {
            status = "refunded";
            close = { kind: "refund", txid: refund.txid, providerSats: 0, treasurySats: coin.amount };
          }
        }
      }
      return {
        escrowId: quote.quoteId,
        model: quote.body.model,
        providerPayoutScript: quote.body.providerPayoutScript,
        capSats: Number(quote.body.capSats),
        timeoutAt: new Date(Number(quote.body.timeoutAt) * 1000).toISOString(),
        address: p.escrow.address,
        coin: coin ? { txid: coin.txid, vout: coin.vout, amountSats: coin.amount } : null,
        status,
        receipt,
        close,
      };
    }),
  );

  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    schema: "hive-view/v4",
    generatedAt: new Date().toISOString(),
    treasury: {
      address: args.treasuryAddress,
      script: args.treasuryScript,
      lightningAddress: args.registration?.lightningAddress ?? null,
      balanceSats: sum(unspent.map((c) => c.amount)),
      coins: unspent.map((c) => ({
        txid: c.txid,
        vout: c.vout,
        amountSats: c.amount,
        expiresAt: c.expiresAt ? new Date(c.expiresAt * 1000).toISOString() : null,
      })),
    },
    contributions,
    renewals,
    unattributed,
    escrows,
    totals: {
      contributedSats: sum(contributions.map((c) => c.amountSats)),
      inEscrowSats: sum(escrows.filter((e) => e.status === "open").map((e) => e.coin?.amountSats ?? 0)),
      paidSats: sum(escrows.map((e) => (e.close?.kind === "claim" ? e.close.providerSats : 0))),
      refundedSats: sum(escrows.map((e) => (e.close?.kind === "refund" ? e.close.treasurySats : 0))),
    },
  };
}
