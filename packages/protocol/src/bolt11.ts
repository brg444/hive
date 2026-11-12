import { ensure, hex } from "@hive/kit";

/**
 * The three facts the hive reads from a BOLT11 invoice: the network its prefix
 * names, its amount, and its payment hash. The bech32 checksum is verified and
 * exactly one well-formed payment hash field is required. The node signature
 * is not checked: the payee is lnurl-server's swap provider, which the hive
 * cannot name in advance, and credit follows the observed treasury output.
 */
export type InvoiceNetwork = "bitcoin" | "testnet" | "signet" | "regtest";

export interface InvoiceFacts {
  network: InvoiceNetwork;
  amountSats: number;
  paymentHash: string;
  /** Unix seconds the invoice was created and stops being payable (BOLT11 default expiry: one hour). */
  createdAt: number;
  expiresAt: number;
}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const PREFIXES: Record<string, InvoiceNetwork> = {
  bc: "bitcoin",
  tb: "testnet",
  tbs: "signet",
  bcrt: "regtest",
};
const PICO_BTC_PER_UNIT: Record<string, bigint> = {
  "": 10n ** 12n,
  m: 10n ** 9n,
  u: 10n ** 6n,
  n: 10n ** 3n,
  p: 1n,
};
const TIMESTAMP_WORDS = 7;
const SIGNATURE_WORDS = 104;
const CHECKSUM_WORDS = 6;
const PAYMENT_HASH_TAG = 1;
const EXPIRY_TAG = 6;
const DEFAULT_EXPIRY_SECONDS = 3600;
const PAYMENT_HASH_WORDS = 52;
const MAX_INVOICE = 7089;

function bech32Polymod(values: Iterable<number>): number {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) check ^= GENERATOR[i]!;
  }
  return check;
}

function hrpWords(hrp: string): number[] {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
}

/** 5-bit words to bytes, dropping the trailing padding bits. */
function wordsToBytes(words: readonly number[]): Uint8Array {
  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const word of words) {
    accumulator = ((accumulator << 5) | word) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function decodeInvoice(invoice: string): InvoiceFacts {
  ensure(
    typeof invoice === "string" && invoice.length <= MAX_INVOICE,
    "INTAKE_INVOICE",
    "not a BOLT11 invoice",
  );
  const lower = invoice.toLowerCase();
  ensure(invoice === lower || invoice === invoice.toUpperCase(), "INTAKE_INVOICE", "mixed case");
  const separator = lower.lastIndexOf("1");
  const hrp = lower.slice(0, separator);
  const match = /^ln(bcrt|tbs|tb|bc)([0-9]*)([munp]?)$/.exec(hrp);
  ensure(separator > 0 && match, "INTAKE_INVOICE", "not a BOLT11 invoice");
  ensure(match[2] !== "" && !match[2]!.startsWith("0"), "INTAKE_INVOICE", "amountless invoice");
  const words = [...lower.slice(separator + 1)].map((c) => CHARSET.indexOf(c));
  ensure(
    words.length >= TIMESTAMP_WORDS + SIGNATURE_WORDS + CHECKSUM_WORDS && words.every((w) => w >= 0),
    "INTAKE_INVOICE",
    "malformed data part",
  );
  ensure(bech32Polymod([...hrpWords(hrp), ...words]) === 1, "INTAKE_INVOICE", "bad checksum");

  const pico = BigInt(match[2]!) * PICO_BTC_PER_UNIT[match[3]!]!;
  ensure(pico % 10_000n === 0n, "INTAKE_INVOICE", "sub-satoshi amount");
  const amountSats = pico / 10_000n;
  ensure(amountSats <= BigInt(Number.MAX_SAFE_INTEGER), "INTAKE_INVOICE", "amount out of range");

  const number = (part: readonly number[]) => part.reduce((value, word) => value * 32 + word, 0);
  const createdAt = number(words.slice(0, TIMESTAMP_WORDS));
  let expiry = DEFAULT_EXPIRY_SECONDS;
  const tagged = words.slice(TIMESTAMP_WORDS, -(SIGNATURE_WORDS + CHECKSUM_WORDS));
  const hashes: string[] = [];
  for (let i = 0; i < tagged.length; ) {
    ensure(i + 3 <= tagged.length, "INTAKE_INVOICE", "truncated field");
    const tag = tagged[i]!;
    const length = tagged[i + 1]! * 32 + tagged[i + 2]!;
    const data = tagged.slice(i + 3, i + 3 + length);
    ensure(data.length === length, "INTAKE_INVOICE", "truncated field");
    // BOLT11: a reader skips a payment hash field whose length is not 52.
    if (tag === PAYMENT_HASH_TAG && length === PAYMENT_HASH_WORDS)
      hashes.push(hex(wordsToBytes(data).subarray(0, 32)));
    if (tag === EXPIRY_TAG && length > 0 && length <= 7) expiry = number(data);
    i += 3 + length;
  }
  ensure(hashes.length === 1, "INTAKE_INVOICE", "needs exactly one payment hash");
  return {
    network: PREFIXES[match[1]!]!,
    amountSats: Number(amountSats),
    paymentHash: hashes[0]!,
    createdAt,
    expiresAt: createdAt + expiry,
  };
}
