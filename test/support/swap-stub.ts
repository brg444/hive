import { createHash, randomBytes } from "node:crypto";
import {
  LIGHTNING_SEND_PAIR,
  lightningSendVtxoScript,
  type RfqQuote,
  type RfqTransport,
  unilateralClaimDelay,
} from "@arkade-os/swap";
import { conditionField, parseArkAddress, xOnly } from "@hive/ark";
import { hex, unhex } from "@hive/kit";
import { decodeInvoice } from "@hive/protocol";
import type { CashoutRail } from "@hive/provider";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Transaction } from "@scure/btc-signer";
import { encodeInvoice } from "./bolt11.js";
import type { FakeNetwork } from "./fake-network.js";

/**
 * A stand-in for the `arkade:BTC->lightning:BTC` solver and the Lightning
 * payee behind it. The solver quotes exactly as the published client expects,
 * deriving the lockup with the same builder; `settle` then claims a funded
 * lockup through a transaction revealing the invoice's preimage, as a solver
 * does after paying the invoice.
 */
export interface SwapStub {
  rail: CashoutRail;
  /** A payee invoice on regtest whose preimage the stub knows. */
  invoice(amountSats: number): string;
  /** Claim every funded lockup whose invoice the stub issued; returns the claims made. */
  settle(): number;
  /** Quotes answered so far. */
  quotes: RfqQuote[];
}

const REFUND_HEADROOM_SECONDS = 7_200;

export function startSwapStub(
  fake: FakeNetwork,
  options: { feeSats?: number; validSeconds?: number } = {},
): SwapStub {
  const solverSecret = schnorr.utils.randomSecretKey();
  const solverPubkey = hex(schnorr.getPublicKey(solverSecret));
  const receiverPkScript = `5120${hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))}`;
  const preimages = new Map<string, Buffer>();
  const lockups = new Map<string, { paymentHash: string; script: string }>();
  const quotes: RfqQuote[] = [];
  const serverKey = xOnly(fake.serverKey);

  const transport = (): RfqTransport => ({
    async requestQuote(payload) {
      const request = payload as {
        rfq_id: string;
        pair: string;
        profile: { invoice: string; refund_address: string; client_refund_pubkey: string };
      };
      if (request.pair !== LIGHTNING_SEND_PAIR) throw new Error("unsupported pair");
      const facts = decodeInvoice(request.profile.invoice);
      const now = Math.floor(Date.now() / 1000);
      const claimDelay = unilateralClaimDelay(fake.exitDelaySeconds);
      const refundLocktime = now + REFUND_HEADROOM_SECONDS;
      const refundWithoutReceiverDelay = Math.ceil((REFUND_HEADROOM_SECONDS + 600) / 512) * 512;
      const script = lightningSendVtxoScript({
        solverPubkey: unhex(solverPubkey),
        refundLocktime,
        serverPubkey: serverKey,
        paymentHash: facts.paymentHash,
        claimDelay,
        refundWithoutReceiverDelay,
        emulatorPubkey: xOnly(fake.emulatorKey),
        refundPkScript: unhex(parseArkAddress(request.profile.refund_address).pkScript),
        senderPubkey: unhex(request.profile.client_refund_pubkey),
        receiverPkScript: unhex(receiverPkScript),
      });
      const lockupAddress = script.address("tark", serverKey).encode();
      lockups.set(hex(script.pkScript), { paymentHash: facts.paymentHash, script: hex(script.pkScript) });
      const quote: RfqQuote = {
        v: 1,
        type: "rfq_quote",
        rfq_id: request.rfq_id,
        pair: LIGHTNING_SEND_PAIR,
        from_amount: facts.amountSats + (options.feeSats ?? 7),
        to_amount: facts.amountSats,
        solver_pubkey: solverPubkey,
        valid_until: now + (options.validSeconds ?? 120),
        refund_locktime: refundLocktime,
        profile: {
          payment_hash: facts.paymentHash,
          lockup_address: lockupAddress,
          refund_without_receiver_delay: refundWithoutReceiverDelay,
          receiver_pk_script: receiverPkScript,
        },
      };
      quotes.push(quote);
      return quote;
    },
    async status() {
      return null;
    },
    async close() {},
  });

  return {
    rail: {
      rendezvous: async () => ({ solverPubkey, relays: ["wss://relay.invalid/"] }),
      connect: () => transport(),
    },
    invoice(amountSats) {
      const preimage = randomBytes(32);
      const paymentHash = createHash("sha256").update(preimage).digest("hex");
      preimages.set(paymentHash, preimage);
      return encodeInvoice({
        prefix: "bcrt",
        amount: `${amountSats * 10}n`,
        paymentHash,
        createdAt: Math.floor(Date.now() / 1000),
      });
    },
    settle() {
      let claims = 0;
      for (const { paymentHash, script } of lockups.values()) {
        const preimage = preimages.get(paymentHash);
        const [coin] = preimage ? fake.unspent(script) : [];
        if (!coin || !preimage) continue;
        const checkpoint = new Transaction({ version: 3, allowUnknownOutputs: true });
        checkpoint.addInput({ txid: unhex(coin.txid), index: coin.vout });
        checkpoint.addOutput({ script: unhex(script), amount: BigInt(coin.amount) });
        const claim = new Transaction({
          version: 3,
          allowUnknown: true,
          allowUnknownOutputs: true,
          allowUnknownInputs: true,
        });
        claim.addInput({ txid: unhex(checkpoint.id), index: 0 });
        claim.updateInput(0, { unknown: [conditionField([preimage])] });
        claim.addOutput({ script: unhex(receiverPkScript), amount: BigInt(coin.amount) });
        fake.spendWith(
          `${coin.txid}:${coin.vout}`,
          {
            psbt: Buffer.from(claim.toPSBT()).toString("base64"),
            txid: claim.id,
            checkpointTxid: checkpoint.id,
          },
          [{ script: receiverPkScript, amount: coin.amount }],
        );
        claims++;
      }
      return claims;
    },
    quotes,
  };
}
