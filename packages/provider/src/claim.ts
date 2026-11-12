import { resolve } from "node:path";
import { claimMessage } from "@hive/ark";
import {
  callWorker,
  ensure,
  exactObject,
  hex,
  readJsonIfPresent,
  unhex,
  withLock,
  writeJson,
} from "@hive/kit";
import {
  canonicalJson,
  requireValidReceipt,
  requireValidSignedQuote,
  type SignedQuote,
  type SignedReceipt,
} from "@hive/protocol";
import { schnorr } from "@noble/curves/secp256k1.js";
import { loadProvider, requireApprovedQuote } from "./config.js";

/** The only thing the claim daemon may ask the workload key for. */
export interface ClaimSignRequest {
  kind: "sign-escrow-claim";
  quote: SignedQuote;
  /** The payer's latest receipt: the amount claimed. */
  receipt: SignedReceipt;
}

export interface ClaimSignature {
  escrowId: string;
  amountSats: string;
  /** BIP340 over sha256(CLAIM_TAG ‖ escrow id ‖ amount), by the workload key. */
  claimSignature: string;
}

export interface ClaimSigner {
  signClaim(request: ClaimSignRequest): Promise<ClaimSignature>;
}

/** No claim is signed this close to the deadline: the hive needs time to register it. */
const SIGN_MARGIN_SECONDS = 60;

/**
 * Sign the provider's consent to close one escrow for the amount of the
 * payer's receipt. The escrow's claim covenant needs this signature and the
 * receipt for the same amount, so the hive can register no other claim. Each
 * escrow is signed once: an identical request returns the saved signature,
 * any other amount is refused.
 */
export async function signClaim(configPath: string, value: unknown): Promise<ClaimSignature> {
  const provider = loadProvider(configPath);
  exactObject(value, ["kind", "quote", "receipt"], "claim request");
  const request = value as ClaimSignRequest;
  ensure(request.kind === "sign-escrow-claim", "UNKNOWN_KIND");
  const quote = requireValidSignedQuote(request.quote);
  requireApprovedQuote(provider, quote);
  const receipt = requireValidReceipt(request.receipt, {
    escrowId: quote.quoteId,
    payerReceiptKey: quote.body.payerReceiptKey,
    capSats: quote.body.capSats,
  });
  ensure(BigInt(receipt.amountSats) > 0n, "CLAIM_EMPTY");
  const directory = resolve(provider.config.stateDirectory, "claims");
  return withLock(resolve(directory, "signing.lock"), async () => {
    const recordPath = resolve(directory, `${quote.quoteId}.json`);
    const saved = readJsonIfPresent<{ request: ClaimSignRequest; signature: ClaimSignature }>(recordPath);
    if (saved) {
      ensure(canonicalJson(saved.request) === canonicalJson(request), "CLAIM_ALREADY_SIGNED");
      return saved.signature;
    }
    ensure(
      Math.floor(Date.now() / 1000) + SIGN_MARGIN_SECONDS < Number(quote.body.timeoutAt),
      "CLAIM_DEADLINE_REACHED",
    );
    const amount = Number(receipt.amountSats);
    const secret = unhex(provider.config.workloadSecret);
    let signature: string;
    try {
      signature = hex(schnorr.sign(claimMessage(quote.quoteId, amount), secret));
    } finally {
      secret.fill(0);
    }
    ensure(
      schnorr.verify(unhex(signature), claimMessage(quote.quoteId, amount), unhex(provider.workloadKey)),
      "CLAIM_SIGNATURE",
    );
    const result: ClaimSignature = {
      escrowId: quote.quoteId,
      amountSats: receipt.amountSats,
      claimSignature: signature,
    };
    writeJson(recordPath, { request, signature: result });
    return result;
  });
}

/** The claim daemon's handle on the workload key: a process that signs claims only. */
export class ClaimClient implements ClaimSigner {
  readonly #configPath: string;
  constructor(configPath: string) {
    this.#configPath = resolve(configPath);
  }
  signClaim(request: ClaimSignRequest): Promise<ClaimSignature> {
    return callWorker(
      {
        entry: resolve(import.meta.dirname, "claim-worker.ts"),
        args: [this.#configPath],
        timeoutMs: 15_000,
        maxRequestBytes: 65_536,
        maxResponseBytes: 65_536,
      },
      request,
    );
  }
}
