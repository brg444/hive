import { decimal, exactObject, fail, hexField, MAX_MONEY_SATS, mainnetEnabled } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalBytes, canonicalJson, framed } from "./canonical.js";
import { modelId, p2trScript, xOnlyKey } from "./keys.js";
import type { HiveNetwork } from "./quote.js";

/** A provider's signed offer: model, rates, limits and where to send RFQs. */
export const CARD_PROFILE = "hive-provider-card/v1";

export interface ProviderCardBody {
  profile: typeof CARD_PROFILE;
  network: HiveNetwork;
  model: string;
  providerRfqKey: string;
  providerWorkloadKey: string;
  providerPayoutScript: string;
  inputRateMsatPerMillionTokens: string;
  outputRateMsatPerMillionTokens: string;
  maxCapSats: string;
  maxDurationSeconds: string;
  expiresAt: string;
  relays: string[];
}

export interface SignedProviderCard {
  body: ProviderCardBody;
  cardId: string;
  signature: string;
}

const CARD_FIELDS = [
  "profile",
  "network",
  "model",
  "providerRfqKey",
  "providerWorkloadKey",
  "providerPayoutScript",
  "inputRateMsatPerMillionTokens",
  "outputRateMsatPerMillionTokens",
  "maxCapSats",
  "maxDurationSeconds",
  "expiresAt",
  "relays",
] as const;

export function parseProviderCardBody(value: unknown): ProviderCardBody {
  canonicalJson(value);
  const raw = exactObject(value, CARD_FIELDS, "provider card body");
  if (raw.profile !== CARD_PROFILE) fail("INVALID", "card profile");
  if (
    raw.network !== "regtest" &&
    raw.network !== "mutinynet" &&
    !(raw.network === "bitcoin" && mainnetEnabled())
  )
    fail("INVALID", "card network");
  modelId(raw.model);
  const rfq = xOnlyKey(raw.providerRfqKey, "providerRfqKey");
  const workload = xOnlyKey(raw.providerWorkloadKey, "providerWorkloadKey");
  if (rfq === workload) fail("INVALID", "RFQ and workload keys must differ");
  const payout = p2trScript(raw.providerPayoutScript, "providerPayoutScript");
  if ([rfq, workload].includes(payout.slice(4)))
    fail("INVALID", "payout must differ from RFQ and workload keys");
  const input = decimal(raw.inputRateMsatPerMillionTokens, "input rate");
  const output = decimal(raw.outputRateMsatPerMillionTokens, "output rate");
  if (input === 0n && output === 0n) fail("INVALID", "card must charge a positive rate");
  decimal(raw.maxCapSats, "maximum cap", 1n, MAX_MONEY_SATS);
  decimal(raw.maxDurationSeconds, "maximum duration", 1n);
  decimal(raw.expiresAt, "card expiry", 1n);
  if (!Array.isArray(raw.relays) || raw.relays.length === 0 || raw.relays.length > 4) {
    fail("INVALID", "one to four relay URLs required");
  }
  for (const relay of raw.relays) relayUrl(relay, raw.network);
  if (new Set(raw.relays).size !== raw.relays.length) fail("INVALID", "duplicate relay URL");
  return raw as unknown as ProviderCardBody;
}

/** Regtest relays are local plain WebSocket; public networks require TLS. */
export function relayUrl(value: unknown, network: HiveNetwork): string {
  if (typeof value !== "string") fail("INVALID", "relay URL must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("INVALID", "relay URL");
  }
  if (url.username || url.password || url.hash || url.search)
    fail("INVALID", "relay URL has unsupported parts");
  if (network === "regtest") {
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      fail("INVALID", "regtest relay must be local");
    }
  } else if (url.protocol !== "wss:") fail("INVALID", "public network relay requires TLS");
  if (url.href !== value) fail("INVALID", "relay URL must use canonical spelling");
  return value;
}

export function cardDigest(body: ProviderCardBody): string {
  return bytesToHex(sha256(framed(CARD_PROFILE, Uint8Array.of(0), canonicalBytes(body))));
}

export function signProviderCard(body: ProviderCardBody, secretKey: Uint8Array): SignedProviderCard {
  const parsed = parseProviderCardBody(body);
  if (bytesToHex(schnorr.getPublicKey(secretKey)) !== parsed.providerRfqKey) fail("CARD_SIGNER");
  const cardId = cardDigest(parsed);
  const signature = bytesToHex(schnorr.sign(hexToBytes(cardId), secretKey, new Uint8Array(32)));
  return { body: parsed, cardId, signature };
}

export function validateProviderCard(value: unknown, nowSeconds?: string): SignedProviderCard {
  canonicalJson(value);
  const raw = exactObject(value, ["body", "cardId", "signature"], "provider card");
  const body = parseProviderCardBody(raw.body);
  if (raw.cardId !== cardDigest(body)) fail("CARD_DIGEST");
  const signature = hexField(raw.signature, 64, "card signature");
  if (
    !schnorr.verify(hexToBytes(signature), hexToBytes(raw.cardId as string), hexToBytes(body.providerRfqKey))
  ) {
    fail("CARD_SIGNATURE");
  }
  if (nowSeconds !== undefined && decimal(nowSeconds, "current time", 1n) >= BigInt(body.expiresAt)) {
    fail("CARD_EXPIRED");
  }
  return { body, cardId: raw.cardId as string, signature };
}
