import { randomBytes } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import {
  discoverMarkets,
  type RfqQuote,
  type RfqTransport,
  requestLightningSend,
  solverLightningRendezvous,
} from "@arkade-os/swap";
import { nostrRfqTransport } from "@arkade-os/swap/nostr";
import {
  type Connection,
  parseArkAddress,
  parseArkTx,
  revealedPreimage,
  type Wallet,
  type WalletSendJournal,
  walletSend,
  xOnly,
} from "@hive/ark";
import {
  ensure,
  fail,
  guardAsync,
  hex,
  nowIso,
  readJson,
  readJsonIfPresent,
  sleep,
  stateExists,
  unhex,
  withLock,
  writeJson,
  writeOnce,
} from "@hive/kit";
import { decodeInvoice, type InvoiceNetwork, type HiveNetwork } from "@hive/protocol";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/**
 * Cash-out through the `arkade:BTC->lightning:BTC` corridor: a provider pays a
 * Lightning invoice out of its payout wallet.
 *
 * The published swap client asks a solver for a quote and derives the lockup
 * covenant locally; the quote binds only if its lockup address equals that
 * derivation, and the lockup's refund paths pay the payout wallet. The owner
 * then authorizes one fixed wallet send of the quoted amount to the lockup.
 * The configured routes execute it; new posts stop when the quote lapses. The
 * solver pays the invoice and claims the lockup with the preimage, which the
 * claim reveals: settlement is that observed spend with a preimage hashing to
 * the invoice's payment hash, never the solver's word.
 *
 * The swap client is handed a watch-only stand-in for a wallet: the owner's
 * public key, the payout address, and a recorder for the lockup contract,
 * which the journal keeps. It signs nothing; the owner signs only the send.
 */
export interface CashoutJournal {
  schema: "hive-cashout/v4";
  network: HiveNetwork;
  invoice: { bolt11: string; amountSats: number; paymentHash: string; expiresAt: number };
  payoutScript: string;
  rfqId: string;
  quote: RfqQuote;
  lockup: {
    address: string;
    script: string;
    fundAmount: number;
    refundAddress: string;
    refundLocktime: number;
    /** The VHTLC as the swap client registered it: what a refund needs. */
    contract: { type: string; params: Record<string, string> };
  };
  quotedAt: string;
  status: "quoted" | "expired" | "funded" | "settled";
  funding?: { journalPath: string; txid: string; outpoint: { txid: string; vout: number } };
  settlement?: { claimTxid: string; preimage: string; observedAt: string };
}

/** Where a cash-out finds its solver and how it talks to it; tests substitute their own. */
export interface CashoutRail {
  rendezvous(amountSats: number): Promise<{ solverPubkey: string; relays: string[] }>;
  connect(rendezvous: { solverPubkey: string; relays: string[] }, secretKey: Uint8Array): RfqTransport;
  /** Where the swap client reads the Operator's `/v1/info`; the deployment's Operator unless a test serves its own. */
  operatorUrl?: string;
}

/**
 * The published corridor: markets from the network's solver registry (the
 * swap client's default index unless `registryUrl` names another), and the
 * chosen solver over Nostr.
 */
export function publishedCashoutRail(
  conn: Connection,
  options: { registryUrl?: string; timeoutMs?: number } = {},
): CashoutRail {
  return {
    async rendezvous(amountSats) {
      const markets = await discoverMarkets({
        network: conn.deployment.network,
        registryUrl: options.registryUrl,
        useCache: false,
      });
      // A registry card without an Emulator key is taken to use the deployment's Emulator.
      const found = solverLightningRendezvous(markets, amountSats, xOnly(conn.keys.emulator));
      ensure(found, "CASHOUT_NO_SOLVER", `no solver pays ${amountSats} sats over Lightning`);
      return { solverPubkey: found.solverPubkey, relays: found.transports.nostr.relays };
    },
    connect(rendezvous, secretKey) {
      return nostrRfqTransport({
        relays: rendezvous.relays,
        solverPubkey: rendezvous.solverPubkey,
        secretKey,
        timeoutMs: options.timeoutMs ?? 20_000,
      });
    },
  };
}

export interface CashoutArgs {
  journalPath: string;
  /** The payee's BOLT11 invoice. */
  invoice: string;
  /** The provider's payout wallet and its owner's key. */
  wallet: Wallet;
  ownerSecret: Uint8Array;
  rail: CashoutRail;
  /** Fee ceiling over the invoice amount, in basis points plus a fixed allowance. */
  maxFeeBps?: number;
  maxFeeSats?: number;
  settleTimeoutMs?: number;
  pollMs?: number;
}

const now = () => Math.floor(Date.now() / 1000);

const INVOICE_NETWORK: Record<HiveNetwork, InvoiceNetwork> = {
  regtest: "regtest",
  mutinynet: "signet",
  bitcoin: "bitcoin",
};

/** The covenant lets the funding happen only this long before the quote lapses, and never after. */
const FUNDING_MARGIN_SECONDS = 5;

export async function cashOut(conn: Connection, args: CashoutArgs): Promise<CashoutJournal> {
  return withLock(`${args.journalPath}.lock`, async () => {
    const payoutScript = args.wallet.account.pkScript;
    ensure(
      hex(secp256k1.getPublicKey(args.ownerSecret, true)) === args.wallet.terms.owner,
      "WRONG_PAYOUT_KEY",
    );
    let journal = readJsonIfPresent<CashoutJournal>(args.journalPath);
    if (journal) {
      ensure(journal.schema === "hive-cashout/v4", "JOURNAL_SCHEMA");
      ensure(
        journal.invoice.bolt11 === args.invoice && journal.payoutScript === payoutScript,
        "JOURNAL_MISMATCH",
      );
    } else {
      journal = await quoteCashout(conn, args, payoutScript);
    }
    if (journal.status === "quoted") journal = await fundLockup(conn, args, journal);
    if (journal.status === "funded") journal = await awaitSettlement(conn, args, journal);
    return journal;
  });
}

/**
 * Set an expired cash-out aside so the next `cashOut` asks for a fresh quote.
 * It qualifies when it reads `expired` and its funding send, if any, expired
 * too: past its `validUntil` the covenant refuses that send for good. The
 * cash-out, its funding journal and its transport key move together under
 * one suffix naming the quote. Returns the archived cash-out path.
 */
export async function retireExpiredCashout(journalPath: string): Promise<string> {
  return withLock(`${journalPath}.lock`, async () => {
    const journal = readJson<CashoutJournal>(journalPath);
    ensure(journal.schema === "hive-cashout/v4", "JOURNAL_SCHEMA");
    ensure(journal.status === "expired", "CASHOUT_NOT_EXPIRED", journal.status);
    const fundingPath = `${journalPath}.funding.json`;
    const funding = readJsonIfPresent<WalletSendJournal>(fundingPath);
    ensure(!funding || funding.status === "expired", "CASHOUT_FUNDING_UNRESOLVED", funding?.status);
    const suffix = `.expired-${journal.rfqId.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 64)}`;
    const moves = [journalPath, fundingPath, `${journalPath}.transport-key.json`]
      .filter((path) => existsSync(path))
      .map((path) => [path, `${path}${suffix}`] as const);
    for (const [, to] of moves) ensure(!existsSync(to), "CASHOUT_ARCHIVE_EXISTS", to);
    // The cash-out moves last, so an interrupted archive still reads as expired and is retried.
    for (const [from, to] of moves.reverse()) renameSync(from, to);
    return `${journalPath}${suffix}`;
  });
}

/** What the swap client reads from a wallet, and nothing that can sign. */
function watchOnlyWallet(
  wallet: Wallet,
  recorded: { type: string; params: Record<string, string>; script: string }[],
) {
  const refuse = async () => fail("CASHOUT_NO_SIGNING", "the swap client signs nothing here");
  const identity = {
    xOnlyPublicKey: async () => xOnly(wallet.terms.owner),
    compressedPublicKey: async () => unhex(wallet.terms.owner),
    sign: refuse,
    signMessage: refuse,
    signerSession: refuse,
  };
  return {
    identity,
    getAddress: async () => wallet.account.address,
    getContractManager: async () => ({
      async createContract(contract: { type: string; params: Record<string, string>; script: string }) {
        recorded.push({ type: contract.type, params: contract.params, script: contract.script });
        return contract;
      },
    }),
  } as unknown as Parameters<typeof requestLightningSend>[0];
}

async function quoteCashout(
  conn: Connection,
  args: CashoutArgs,
  payoutScript: string,
): Promise<CashoutJournal> {
  const network = conn.deployment.network as HiveNetwork;
  const facts = decodeInvoice(args.invoice);
  ensure(facts.network === INVOICE_NETWORK[network], "CASHOUT_INVOICE", "invoice for another network");
  ensure(facts.expiresAt > now() + 600, "CASHOUT_INVOICE", "invoice expires within ten minutes");
  const rendezvous = await args.rail.rendezvous(facts.amountSats);
  // A fresh transport key per quote, kept like the RFQ transport keys so evidence scans cover it.
  const keyPath = `${args.journalPath}.transport-key.json`;
  const transportKey = writeOnce(
    keyPath,
    stateExists(keyPath) ? readJson<{ secretKey: string }>(keyPath) : { secretKey: hex(randomBytes(32)) },
  );
  const transport = args.rail.connect(rendezvous, unhex(transportKey.secretKey));
  const recorded: { type: string; params: Record<string, string>; script: string }[] = [];
  let sent: Awaited<ReturnType<typeof requestLightningSend>>;
  try {
    sent = await guardAsync("CASHOUT_QUOTE", () =>
      requestLightningSend(
        watchOnlyWallet(args.wallet, recorded),
        args.rail.operatorUrl ?? conn.deployment.arkdUrl,
        transport,
        {
          invoice: {
            raw: args.invoice,
            paymentHash: facts.paymentHash,
            amountSats: facts.amountSats,
            expiresAt: facts.expiresAt,
          },
          emulatorPubkey: conn.keys.emulator,
        },
      ),
    );
  } finally {
    await transport.close();
  }
  const lockupScript = hex(sent.swapPkScript);
  const lockupAddress = parseArkAddress(sent.address);
  ensure(
    lockupAddress.pkScript === lockupScript && lockupAddress.serverKey === hex(xOnly(conn.keys.server)),
    "CASHOUT_LOCKUP",
  );
  ensure(parseArkAddress(sent.refundAddress).pkScript === payoutScript, "CASHOUT_REFUND_ADDRESS");
  const contract = recorded.find((c) => c.script === lockupScript);
  ensure(contract, "CASHOUT_LOCKUP", "the swap client registered no lockup contract");
  const fee = sent.fundAmount - facts.amountSats;
  const maxFee = Math.ceil((facts.amountSats * (args.maxFeeBps ?? 100)) / 10_000) + (args.maxFeeSats ?? 10);
  ensure(fee >= 0 && fee <= maxFee, "CASHOUT_FEE", `${fee} sats over a ${maxFee}-sat ceiling`);
  ensure(sent.quote.refund_locktime !== undefined, "CASHOUT_QUOTE");
  const journal: CashoutJournal = {
    schema: "hive-cashout/v4",
    network,
    invoice: {
      bolt11: args.invoice,
      amountSats: facts.amountSats,
      paymentHash: facts.paymentHash,
      expiresAt: facts.expiresAt,
    },
    payoutScript,
    rfqId: sent.rfqId,
    quote: sent.quote,
    lockup: {
      address: sent.address,
      script: lockupScript,
      fundAmount: sent.fundAmount,
      refundAddress: sent.refundAddress,
      refundLocktime: sent.quote.refund_locktime,
      contract: { type: contract.type, params: contract.params },
    },
    quotedAt: nowIso(),
    status: "quoted",
  };
  writeJson(args.journalPath, journal);
  return journal;
}

async function fundLockup(
  conn: Connection,
  args: CashoutArgs,
  journal: CashoutJournal,
): Promise<CashoutJournal> {
  const fundingPath = `${args.journalPath}.funding.json`;
  const validUntil = journal.quote.valid_until - FUNDING_MARGIN_SECONDS;
  // A send needs half a minute to be worth signing; a quote closer to lapsing is let go unsigned.
  if (!stateExists(fundingPath) && validUntil <= now() + 30) {
    journal.status = "expired";
    writeJson(args.journalPath, journal);
    return journal;
  }
  const send = await walletSend(args.wallet, args.ownerSecret, {
    journalPath: fundingPath,
    destination: journal.lockup.script,
    amount: journal.lockup.fundAmount,
    validUntil,
    purpose: { kind: "cashout", rfqId: journal.rfqId, lockupScript: journal.lockup.script },
    beforeSubmit: () => ensure(now() < validUntil, "CASHOUT_QUOTE_LAPSED"),
    ...(args.pollMs ? { pollMs: args.pollMs } : {}),
  });
  if (send.status === "expired") {
    journal.status = "expired";
    writeJson(args.journalPath, journal);
    return journal;
  }
  ensure(send.status === "done" && send.txid, "CASHOUT_FUNDING_UNRESOLVED", send.status);
  const [output] = (await conn.arkd.coins({ scripts: [journal.lockup.script] })).filter(
    (c) => c.txid === send.txid && c.script === journal.lockup.script,
  );
  ensure(output && output.amount === journal.lockup.fundAmount, "CASHOUT_FUNDING_MISMATCH");
  journal.funding = {
    journalPath: fundingPath,
    txid: send.txid,
    outpoint: { txid: output.txid, vout: output.vout },
  };
  journal.status = "funded";
  writeJson(args.journalPath, journal);
  return journal;
}

/** Settled means the lockup was spent by a transaction revealing the invoice's preimage. */
async function awaitSettlement(
  conn: Connection,
  args: CashoutArgs,
  journal: CashoutJournal,
): Promise<CashoutJournal> {
  const outpoint = journal.funding!.outpoint;
  const deadline = Date.now() + (args.settleTimeoutMs ?? 300_000);
  while (Date.now() < deadline) {
    const [coin] = await conn.arkd.coins({ outpoints: [`${outpoint.txid}:${outpoint.vout}`] });
    if (coin?.isSpent && coin.arkTxid) {
      const [psbt] = await conn.arkd.virtualTxs([coin.arkTxid]);
      ensure(psbt, "CASHOUT_CLAIM_UNKNOWN", coin.arkTxid);
      const claim = parseArkTx(psbt);
      const preimage = revealedPreimage(claim, journal.invoice.paymentHash, coin.spentBy || undefined);
      ensure(preimage, "CASHOUT_SPENT_WITHOUT_PREIMAGE", coin.arkTxid);
      journal.settlement = { claimTxid: coin.arkTxid, preimage, observedAt: nowIso() };
      journal.status = "settled";
      writeJson(args.journalPath, journal);
      return journal;
    }
    await sleep(args.pollMs ?? 2_000);
  }
  return journal;
}
