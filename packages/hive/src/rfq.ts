import { resolve } from "node:path";
import type { RfqTransport } from "@arkade-os/swap";
import { nostrRfqTransport } from "@arkade-os/swap/nostr";
import {
  type Checkpoint,
  ensure,
  ensureEqual,
  hex,
  hexField,
  noCheckpoint,
  readJson,
  readJsonIfPresent,
  stateExists,
  unhex,
  unixNow,
  withLock,
  writeJson,
  writeOnce,
} from "@hive/kit";
import {
  type ComputeQuoteRequest,
  canonicalJson,
  matchQuote,
  parseComputeQuoteRequest,
  parseQuoteWire,
  quoteContextFromRequest,
  type RfqRequestWire,
  requestWire,
  type SignedProviderCard,
  type SignedQuote,
  validateProviderCard,
  validateQuoteForFunding,
  validateRequestAgainstCard,
} from "@hive/protocol";
import { schnorr } from "@noble/curves/secp256k1.js";

/** Opens a transport to the card's solver with the hive's per-request transport key. */
export type TransportFactory = (
  card: SignedProviderCard,
  secretKey: Uint8Array,
) => Pick<RfqTransport, "requestQuote" | "close">;

export function nostrTransport(timeoutMs = 5000): TransportFactory {
  return (card, secretKey) =>
    nostrRfqTransport({
      relays: card.body.relays,
      solverPubkey: card.body.providerRfqKey,
      secretKey,
      timeoutMs,
    });
}

interface RfqRecord {
  schema: "hive-rfq/v4";
  requestJson: string;
  card: SignedProviderCard;
  wire: RfqRequestWire;
  quote?: SignedQuote;
}

export interface RequestQuoteOptions {
  transport?: TransportFactory;
  checkpoint?: Checkpoint;
  nowSeconds?: () => string;
}

/**
 * Ask the card's provider to quote exactly `request`. Negotiation only: the
 * record is saved before anything is sent, and a saved quote is returned on
 * replay without contacting the provider again.
 */
export async function requestQuote(
  value: ComputeQuoteRequest,
  signedCard: SignedProviderCard,
  stateDirectory: string,
  options: RequestQuoteOptions = {},
): Promise<SignedQuote> {
  const request = parseComputeQuoteRequest(value);
  const card = validateProviderCard(signedCard);
  const now = options.nowSeconds ?? unixNow;
  const checkpoint = options.checkpoint ?? noCheckpoint;
  const path = resolve(stateDirectory, `${request.requestId}.json`);
  return withLock(`${path}.lock`, async () => {
    const requestJson = canonicalJson(request);
    let record = readJsonIfPresent<RfqRecord>(path);
    if (record) {
      ensure(record.schema === "hive-rfq/v4", "JOURNAL_SCHEMA");
      ensure(record.requestJson === requestJson, "REQUEST_ID_REUSED");
      ensure(canonicalJson(record.card) === canonicalJson(card), "CARD_CHANGED");
      ensureEqual(record.wire, requestWire(request), "JOURNAL_MISMATCH");
      if (record.quote) return matchQuote(record.quote, request);
    } else {
      validateRequestAgainstCard(request, card, now());
      record = { schema: "hive-rfq/v4", requestJson, card, wire: requestWire(request) };
      writeJson(path, record);
    }
    await checkpoint("rfq:request-persisted");
    // A transport identity per request; it authorizes nothing but this conversation.
    const keyPath = resolve(stateDirectory, `${request.requestId}.transport-key.json`);
    const { secretKey } = writeOnce(
      keyPath,
      stateExists(keyPath)
        ? readJson<{ secretKey: string }>(keyPath)
        : {
            secretKey: hex(schnorr.utils.randomSecretKey()),
          },
    );
    const transport = (options.transport ?? nostrTransport())(
      card,
      unhex(hexField(secretKey, 32, "transport key")),
    );
    try {
      await checkpoint("rfq:before-call");
      const reply = await transport.requestQuote({ ...record.wire });
      await checkpoint("rfq:quote-received");
      const quote = parseQuoteWire(reply, request);
      // A fresh reply must be fundable now; a saved one stays usable for exact recovery.
      validateQuoteForFunding(quote, quoteContextFromRequest(request, now()));
      record.quote = quote;
      writeJson(path, record);
      await checkpoint("rfq:quote-persisted");
      return quote;
    } finally {
      await transport.close();
    }
  });
}
