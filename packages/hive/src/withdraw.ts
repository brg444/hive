import { existsSync } from "node:fs";
import type { Pair } from "@hive/ark";
import type { RouteName } from "@hive/executor";
import { withLock, writeJson } from "@hive/kit";
import type { WithdrawalTerms } from "@hive/steward/client";
import {
  driveTreasurySpend,
  newSpendJournal,
  planTreasurySend,
  type SpendJournal,
  type Treasury,
} from "./treasury.js";

/**
 * A treasury withdrawal both stewards of a pair approved in advance: the exact
 * destination, amount and posting deadline. The stewards bind the approval
 * to the first plan they sign, so a new plan needs a new approval. A resume
 * keeps the original spend until its outcome is established; passing the
 * deadline stops new posts and does not revoke earlier service signatures.
 */
export async function withdraw(
  treasury: Treasury,
  args: {
    withdrawal: WithdrawalTerms;
    journalPath: string;
    pair: Pair;
    validSeconds?: number;
    /** Coins earlier attempts may still hold (`reservedCoins`). */
    exclude?: string[];
    /** The routes to try, in order; the connection's order by default. */
    routes?: RouteName[];
  },
): Promise<SpendJournal> {
  await withLock(`${args.journalPath}.lock`, async () => {
    if (!existsSync(args.journalPath)) {
      const now = Math.floor(Date.now() / 1000);
      const plan = await planTreasurySend(treasury, {
        pair: args.pair,
        amount: args.withdrawal.amountSats,
        destination: args.withdrawal.destination,
        validSeconds: Math.min(args.validSeconds ?? 600, args.withdrawal.expiresAt - now),
        ...(args.exclude ? { exclude: args.exclude } : {}),
      });
      writeJson(
        args.journalPath,
        newSpendJournal(args.withdrawal.label, { kind: "withdrawal", withdrawal: args.withdrawal }, plan),
      );
    }
  });
  return driveTreasurySpend(treasury, args.journalPath, args.routes ? { routes: args.routes } : {});
}
