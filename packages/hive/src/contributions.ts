import { type Connection, conditionWitness, type IndexedCoin, parseArkTx } from "@hive/ark";
import { hex } from "@hive/kit";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Transaction } from "@scure/btc-signer";
import type { IntakeRequest } from "./intake.js";

/**
 * Contributions are treasury outputs the hive did not create itself, credited
 * only once observed. The hive's own outputs are named by its records: send
 * change, claim remainders and refunds. Batch outputs are attributed only
 * where every complete pairing with settled treasury inputs agrees.
 * Ambiguous outputs stay uncredited until later observations resolve them.
 * Other outputs arrived from outside, and their creating transaction says how:
 *
 * - `lightning`: a solver's swap lockup claimed by preimage through the leaf
 *   `SIZE 32 EQUALVERIFY HASH160 <h> EQUAL VERIFY ...`; the revealed preimage
 *   gives the Lightning payment hash.
 * - `arkade`: a per-payment covenant destination swept through the leaf
 *   `HASH160 <h> EQUAL VERIFY ...`; the destination script, read from the
 *   checkpoint the sweep spends, identifies the payment.
 * - `direct`: anything else paid straight to the treasury address.
 *
 * Both leaves are lnurl-server 0.3.x shapes. A request the hive handed out
 * matches its output by payment hash or destination script.
 */
export type ContributionRail = "lightning" | "arkade" | "direct";

export interface Contribution {
  txid: string;
  vout: number;
  amountSats: number;
  createdAt: string;
  expiresAt: string | null;
  spent: boolean;
  rail: ContributionRail;
  paymentHash?: string;
  conditionHash?: string;
  sourceScript?: string;
  requestId?: string;
}

/** A treasury renewal: its batch and its source when the pairing is uniquely known. */
export interface Renewal {
  txid: string;
  vout: number;
  amountSats: number;
  commitmentTxid: string;
  /** Empty when the output is certainly a renewal but its exact source remains ambiguous. */
  sources: string[];
}

/** Batch outputs that cannot yet be distinguished from deposits; none is credited. */
export interface UnattributedBatch {
  commitmentTxid: string;
  coins: { txid: string; vout: number; amountSats: number }[];
  /** Null when even a complete renewal pairing cannot explain the observed batch. */
  deposits: number | null;
}

const MAX_MATCHING_SIDE = 256;
const MAX_DETAILED_SOURCES = 16;
const MAX_DETAILED_CREATED = 32;

/** Bounded bipartite matching, optionally excluding an output or fixing one pair. */
function matchAll(
  edges: readonly (readonly number[])[],
  created: number,
  options: { exclude?: number; force?: [number, number] } = {},
): boolean {
  const owner = new Array<number>(created).fill(-1);
  const [forcedSource, forcedCoin] = options.force ?? [-1, -1];
  if (options.force) owner[forcedCoin] = forcedSource;
  const blocked = (j: number) => j === options.exclude || (options.force !== undefined && j === forcedCoin);
  const augment = (i: number, seen: boolean[]): boolean => {
    for (const j of edges[i]!) {
      if (seen[j] || blocked(j)) continue;
      seen[j] = true;
      if (owner[j]! < 0 || augment(owner[j]!, seen)) {
        owner[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < edges.length; i++) {
    if (i === forcedSource) continue;
    if (!augment(i, new Array<boolean>(created).fill(false))) return false;
  }
  return true;
}

/** Attribute only outputs whose role agrees in every complete, fee-bounded pairing. */
export function attributeBatches(
  coins: readonly IndexedCoin[],
  maxFeeSats: number,
  internalTxids: ReadonlySet<string> = new Set(),
): { renewals: Renewal[]; unattributed: UnattributedBatch[] } {
  const settled = new Map<string, IndexedCoin[]>();
  for (const coin of coins)
    if (coin.isSpent && coin.settledBy)
      settled.set(coin.settledBy, [...(settled.get(coin.settledBy) ?? []), coin]);
  const renewals: Renewal[] = [];
  const unattributed: UnattributedBatch[] = [];
  const ref = (coin: IndexedCoin) => ({ txid: coin.txid, vout: coin.vout, amountSats: coin.amount });
  for (const [commitment, sources] of settled) {
    const created = coins.filter(
      (coin) =>
        !coin.isPreconfirmed && !internalTxids.has(coin.txid) && coin.commitmentTxids.includes(commitment),
    );
    const unknown = () =>
      unattributed.push({ commitmentTxid: commitment, coins: created.map(ref), deposits: null });
    // Bound allocation and recursion before constructing the matching graph.
    if (sources.length > MAX_MATCHING_SIDE || created.length > MAX_MATCHING_SIDE) {
      unknown();
      continue;
    }
    const edges = sources.map((source) =>
      created.flatMap((coin, j) =>
        coin.amount <= source.amount && coin.amount + maxFeeSats >= source.amount ? [j] : [],
      ),
    );
    if (
      created.some((coin) => coin.commitmentTxids.length !== 1) ||
      created.length < sources.length ||
      edges.some((edge) => edge.length === 0) ||
      !matchAll(edges, created.length)
    ) {
      unknown();
      continue;
    }
    const renewal = (j: number, source?: IndexedCoin) => {
      renewals.push({
        ...ref(created[j]!),
        commitmentTxid: commitment,
        sources: source ? [source.txid + ":" + source.vout] : [],
      });
    };
    if (created.length === sources.length) {
      for (let j = 0; j < created.length; j++) {
        const neighbours = edges.flatMap((edge, i) => (edge.includes(j) ? [i] : []));
        renewal(j, neighbours.length === 1 ? sources[neighbours[0]!] : undefined);
      }
      continue;
    }
    if (sources.length > MAX_DETAILED_SOURCES || created.length > MAX_DETAILED_CREATED) {
      unattributed.push({
        commitmentTxid: commitment,
        coins: created.map(ref),
        deposits: created.length - sources.length,
      });
      continue;
    }
    const ambiguous: IndexedCoin[] = [];
    let certain = 0;
    created.forEach((coin, j) => {
      const neighbours = edges.flatMap((edge, i) => (edge.includes(j) ? [i] : []));
      const usable = neighbours.filter((i) => matchAll(edges, created.length, { force: [i, j] }));
      if (usable.length === 0) return;
      if (matchAll(edges, created.length, { exclude: j })) {
        ambiguous.push(coin);
        return;
      }
      certain++;
      renewal(j, usable.length === 1 ? sources[usable[0]!] : undefined);
    });
    if (ambiguous.length)
      unattributed.push({
        commitmentTxid: commitment,
        coins: ambiguous.map(ref),
        deposits: ambiguous.length - (sources.length - certain),
      });
  }
  return { renewals, unattributed };
}

const SWAP_CLAIM = /^82012088a914([0-9a-f]{40})8769/;
const DESTINATION_SWEEP = /^a914([0-9a-f]{40})8769/;

/** The rail of the transaction that created a treasury output, and the checkpoint it spends. */
export function classifyArrival(
  tx: Transaction,
): Pick<Contribution, "rail" | "paymentHash" | "conditionHash"> & { checkpointTxid?: string } {
  if (tx.inputsLength !== 1) return { rail: "direct" };
  const input = tx.getInput(0);
  const stored = input.tapLeafScript?.[0]?.[1];
  // The PSBT stores the leaf script followed by its version byte.
  const leaf = stored ? hex(stored.subarray(0, -1)) : "";
  const checkpointTxid = input.txid ? hex(input.txid) : undefined;
  const swap = SWAP_CLAIM.exec(leaf);
  if (swap) {
    const conditionHash = swap[1]!;
    const witness = conditionWitness(tx);
    const preimage = witness?.length === 1 ? witness[0] : undefined;
    const paymentHash = preimage?.length === 32 ? sha256(preimage) : undefined;
    return {
      rail: "lightning",
      conditionHash,
      ...(paymentHash && hex(ripemd160(paymentHash)) === conditionHash
        ? { paymentHash: hex(paymentHash) }
        : {}),
      ...(checkpointTxid ? { checkpointTxid } : {}),
    };
  }
  const sweep = DESTINATION_SWEEP.exec(leaf);
  if (sweep)
    return { rail: "arkade", conditionHash: sweep[1]!, ...(checkpointTxid ? { checkpointTxid } : {}) };
  return { rail: "direct" };
}

async function transactions(conn: Connection, txids: string[]): Promise<Map<string, Transaction>> {
  const found = new Map<string, Transaction>();
  const unique = [...new Set(txids)];
  if (!unique.length) return found;
  for (const psbt of await conn.arkd.virtualTxs(unique)) {
    try {
      const tx = parseArkTx(psbt);
      found.set(tx.id, tx);
    } catch {
      // A transaction we cannot read is credited as a direct payment.
    }
  }
  return found;
}

const iso = (seconds: number | null) => (seconds ? new Date(seconds * 1000).toISOString() : null);

/**
 * The treasury's coins, split into the hive's own, renewals and contributions.
 * Spent contributions stay listed: credit, once observed, is never withdrawn.
 */
export async function observeTreasury(
  conn: Connection,
  args: {
    treasuryScript: string;
    /** Transactions the hive made: send change, claim remainders, refunds. */
    internalTxids: ReadonlySet<string>;
    /** The most a renewal may take from a coin: the treasury's `maxFee`. */
    renewalMaxFeeSats: number;
    requests?: readonly IntakeRequest[];
  },
): Promise<{
  coins: IndexedCoin[];
  contributions: Contribution[];
  renewals: Renewal[];
  unattributed: UnattributedBatch[];
}> {
  const coins = (await conn.arkd.coins({ scripts: [args.treasuryScript] })).filter(
    (c) => c.script === args.treasuryScript,
  );
  const { renewals, unattributed } = attributeBatches(coins, args.renewalMaxFeeSats, args.internalTxids);
  const reserved = new Set(
    [...renewals, ...unattributed.flatMap((batch) => batch.coins)].map((c) => c.txid + ":" + c.vout),
  );
  const external = coins.filter(
    (coin) => !args.internalTxids.has(coin.txid) && !reserved.has(coin.txid + ":" + coin.vout),
  );
  const arrivals = await transactions(
    conn,
    external.map((c) => c.txid),
  );
  const classified = new Map([...arrivals].map(([txid, tx]) => [txid, classifyArrival(tx)]));
  const checkpoints = await transactions(
    conn,
    [...classified.values()].flatMap((c) =>
      c.rail !== "direct" && c.checkpointTxid ? [c.checkpointTxid] : [],
    ),
  );
  const sourceOf = (checkpointTxid?: string) => {
    const paying = checkpointTxid ? checkpoints.get(checkpointTxid)?.getInput(0).witnessUtxo : undefined;
    return paying ? hex(paying.script) : undefined;
  };
  const contributions = external
    .map((coin): Contribution => {
      const { checkpointTxid, ...arrival } = classified.get(coin.txid) ?? { rail: "direct" as const };
      const sourceScript = arrival.rail === "direct" ? undefined : sourceOf(checkpointTxid);
      const request = args.requests?.find((r) =>
        r.rail === "lightning"
          ? arrival.rail === "lightning" &&
            r.paymentHash !== undefined &&
            r.paymentHash === arrival.paymentHash
          : arrival.rail === "arkade" && sourceScript !== undefined && r.destinationScript === sourceScript,
      );
      return {
        txid: coin.txid,
        vout: coin.vout,
        amountSats: coin.amount,
        createdAt: iso(coin.createdAt) ?? "",
        expiresAt: iso(coin.expiresAt),
        spent: coin.isSpent,
        ...arrival,
        ...(sourceScript ? { sourceScript } : {}),
        ...(request ? { requestId: request.id } : {}),
      };
    })
    .sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.txid.localeCompare(b.txid) || a.vout - b.vout,
    );
  return { coins, contributions, renewals, unattributed };
}
