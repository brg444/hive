import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { RFQ_AD_KIND, RFQ_DIRECTED_KIND } from "@arkade-os/swap/nostr";
import {
  type Checkpoint,
  ensure,
  hex,
  noCheckpoint,
  readJson,
  readJsonIfPresent,
  unixNow,
  withLock,
  writeJson,
} from "@hive/kit";
import {
  type ComputeQuoteRequest,
  canonicalJson,
  matchQuote,
  parseComputeQuoteRequest,
  parseRequestWire,
  quoteWire,
  type SignedProviderCard,
  type SignedQuote,
  signQuote,
  validateProviderCard,
  validateRequestAgainstCard,
} from "@hive/protocol";
import { schnorr } from "@noble/curves/secp256k1.js";
import { type Event, finalizeEvent, getPublicKey, nip44, SimplePool, verifyEvent } from "nostr-tools";

interface QuoteRecord {
  schema: "hive-solver-record/v4";
  requestJson: string;
  quoteNonce: string;
  requester: string;
  quote?: SignedQuote;
}

export interface QuoteDeskOptions {
  secretKey: Uint8Array;
  card: SignedProviderCard;
  stateDirectory: string;
  checkpoint?: Checkpoint;
  nowSeconds?: () => string;
  /** Open quotes allowed per payer key and per transport identity. */
  maxOpenRequestsPerRequester?: number;
}

const MAX_RECORDS = 4096;

/**
 * The provider's quoting policy, independent of transport. A request id is
 * quoted once with a nonce saved before signing, so a replay returns the same
 * quote and a changed request under the same id is refused.
 */
export class QuoteDesk {
  readonly card: SignedProviderCard;
  readonly #options: QuoteDeskOptions;
  readonly #maximum: number;

  constructor(options: QuoteDeskOptions) {
    this.#options = options;
    this.card = validateProviderCard(options.card, (options.nowSeconds ?? unixNow)());
    ensure(hex(schnorr.getPublicKey(options.secretKey)) === this.card.body.providerRfqKey, "CARD_SIGNER");
    this.#maximum = options.maxOpenRequestsPerRequester ?? 32;
    ensure(
      Number.isSafeInteger(this.#maximum) && this.#maximum >= 1 && this.#maximum <= 256,
      "INVALID_LIMIT",
    );
  }

  async answer(value: ComputeQuoteRequest, requester: string): Promise<SignedQuote> {
    const { stateDirectory } = this.#options;
    const now = this.#options.nowSeconds ?? unixNow;
    const checkpoint = this.#options.checkpoint ?? noCheckpoint;
    const request = parseComputeQuoteRequest(value);
    const path = resolve(stateDirectory, `${request.requestId}.json`);
    return withLock(resolve(stateDirectory, "admission.lock"), async () => {
      const requestJson = canonicalJson(request);
      let record = readJsonIfPresent<QuoteRecord>(path);
      if (record) {
        ensure(
          record.schema === "hive-solver-record/v4" && record.requestJson === requestJson,
          "REQUEST_ID_REUSED",
        );
        if (record.quote) {
          const quote = matchQuote(record.quote, request);
          ensure(quote.body.quoteNonce === record.quoteNonce, "JOURNAL_MISMATCH");
          return quote;
        }
      } else {
        validateRequestAgainstCard(request, this.card, now());
        this.#admit(request, requester, BigInt(now()));
        record = {
          schema: "hive-solver-record/v4",
          requestJson,
          quoteNonce: hex(randomBytes(32)),
          requester,
        };
        writeJson(path, record);
      }
      await checkpoint("solver:request-persisted");
      // The saved nonce fixes the quote id; deterministic signing fixes the signature.
      const quote = signQuote(
        { ...request, quoteNonce: record.quoteNonce },
        this.#options.secretKey,
        new Uint8Array(32),
      );
      record.quote = quote;
      writeJson(path, record);
      await checkpoint("solver:quote-persisted");
      return quote;
    });
  }

  /** Bound open quotes per payer key and per transport identity. */
  #admit(request: ComputeQuoteRequest, requester: string, now: bigint): void {
    const names = readdirSync(this.#options.stateDirectory).filter((name) =>
      /^[0-9a-f]{64}\.json$/.test(name),
    );
    ensure(names.length < MAX_RECORDS, "RFQ_RECORD_LIMIT");
    let payerOpen = 0;
    let requesterOpen = 0;
    for (const name of names) {
      const record = readJson<QuoteRecord>(resolve(this.#options.stateDirectory, name));
      const saved = JSON.parse(record.requestJson) as ComputeQuoteRequest;
      if (BigInt(saved.quoteExpiresAt) <= now) continue;
      if (saved.payerReceiptKey === request.payerReceiptKey) payerOpen++;
      if (record.requester === requester) requesterOpen++;
    }
    ensure(payerOpen < this.#maximum && requesterOpen < this.#maximum, "REQUESTER_LIMIT");
  }
}

export interface SolverHandle {
  card: SignedProviderCard;
  close(): Promise<void>;
}

/** Serve the desk over Nostr: addressed, NIP-44 encrypted requests in; signed quotes out. */
export async function startNostrSolver(
  desk: QuoteDesk,
  secretKey: Uint8Array,
  options: { checkpoint?: Checkpoint; onError?: (code: string) => void } = {},
): Promise<SolverHandle> {
  const { card } = desk;
  ensure(getPublicKey(secretKey) === card.body.providerRfqKey, "CARD_SIGNER");
  const checkpoint = options.checkpoint ?? noCheckpoint;
  const hive = new SimplePool();
  let queue: Promise<void> = Promise.resolve();
  let queued = 0;
  let closed = false;
  const handle = async (event: Event): Promise<void> => {
    if (closed) return;
    ensure(verifyEvent(event) && event.kind === RFQ_DIRECTED_KIND, "INVALID_EVENT");
    ensure(
      event.tags.some((tag) => tag.length === 2 && tag[0] === "p" && tag[1] === card.body.providerRfqKey),
      "NOT_ADDRESSED",
    );
    ensure(Math.abs(Number(unixNow()) - event.created_at) <= 300, "STALE_EVENT");
    const conversation = nip44.v2.utils.getConversationKey(secretKey, event.pubkey);
    const plaintext = nip44.v2.decrypt(event.content, conversation);
    ensure(Buffer.byteLength(plaintext) <= 65_536, "RFQ_TOO_LARGE");
    const request = parseRequestWire(JSON.parse(plaintext));
    const quote = await desk.answer(request, event.pubkey);
    const reply = finalizeEvent(
      {
        kind: RFQ_DIRECTED_KIND,
        created_at: Number(unixNow()),
        tags: [["p", event.pubkey]],
        content: nip44.v2.encrypt(JSON.stringify(quoteWire(quote)), conversation),
      },
      secretKey,
    );
    await checkpoint("solver:before-reply");
    await Promise.any(hive.publish(card.body.relays, reply));
    await checkpoint("solver:after-reply");
  };
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("solver subscription not ready")), 5000);
    hive.subscribeMany(
      card.body.relays,
      { kinds: [RFQ_DIRECTED_KIND], "#p": [card.body.providerRfqKey] },
      {
        oneose: () => {
          clearTimeout(timer);
          resolveReady();
        },
        onclose: () => {
          clearTimeout(timer);
          if (!closed) rejectReady(new Error("solver subscription closed"));
        },
        onevent(event: Event) {
          if (queued >= 256) return options.onError?.("RFQ_QUEUE_FULL");
          queued++;
          queue = queue
            .then(() => handle(event))
            .catch((error) => options.onError?.((error as { code?: string }).code ?? "RFQ_FAILED"))
            .finally(() => {
              queued--;
            });
        },
      },
    );
  });
  try {
    await ready;
    const advertisement = finalizeEvent(
      {
        kind: RFQ_AD_KIND,
        created_at: Number(unixNow()),
        tags: [["d", `${card.body.profile}:${card.body.model}`]],
        content: canonicalJson(card),
      },
      secretKey,
    );
    await Promise.any(hive.publish(card.body.relays, advertisement));
  } catch (error) {
    closed = true;
    hive.close(card.body.relays);
    throw error;
  }
  return {
    card,
    async close() {
      closed = true;
      await queue;
      hive.close(card.body.relays);
    },
  };
}
