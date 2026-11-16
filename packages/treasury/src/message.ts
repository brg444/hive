import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad, bech32m, hex } from "@scure/base";

/**
 * What the treasury contract, the Hive service and the Hive plugin must agree on byte for byte: the
 * message each keeper approves, the text of the Buzz message that approves it, and the recipient's
 * Taproot program behind the address a keeper reads. Runs in Node and in Buzz.
 */

export const PAY_TAG = "hive/treasury/pay/v1";

/** How a keeper's approval opens, before the amount: the contract rebuilds exactly this. */
export const APPROVE = "I approve Hive payment of ";
/** How a keeper's decline opens: any one keeper stops the desk from paying with it. */
export const DECLINE = "I decline Hive payment of ";
/** The largest amount an approval can name: the contract writes it in at most twelve digits. */
export const MAX_AMOUNT_SATS = 10n ** 12n - 1n;

/** The counter asset: its issuance txid in the Emulator's internal byte order, and its group. */
export interface Counter {
  assetId: string;
  txid: string;
  gidx: number;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const bytes = (v: string | Uint8Array) => (typeof v === "string" ? hex.decode(v) : v);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An unsigned little-endian integer of `width` bytes, as the script's num2bin writes a positive one. */
function le(n: number | bigint, width: number): Uint8Array {
  let v = BigInt(n);
  if (v < 0n || v >= 1n << BigInt(8 * width - 1)) throw new Error(`out of range for ${width} bytes`);
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

/**
 * The counter of an asset id as the SDK writes it (txid hex, then the group as two bytes). The
 * Emulator compares a script's asset txid with the packet's in internal byte order: the reverse of
 * the hex in the asset id.
 */
export function counterOf(assetId: string): Counter {
  if (!/^[0-9a-f]{68}$/.test(assetId)) throw new Error("not an asset id");
  const txid = hex.encode(hex.decode(assetId.slice(0, 64)).reverse());
  const gidx = Number.parseInt(assetId.slice(64, 66), 16) | (Number.parseInt(assetId.slice(66, 68), 16) << 8);
  return { assetId, txid, gidx };
}

/** One payment as the keepers approve it. */
export interface Payment {
  /** The counter units on the treasury coin when it pays: the payment's number. */
  left: bigint | number;
  amount: bigint | number;
  /** Unix seconds: the approval lapses then. */
  validUntil: number;
  /** The recipient's version-1 witness program. */
  program: string | Uint8Array;
}

/**
 * What each keeper approves: the treasury (its counter), the payment while `left` counter units
 * remain, `amount` sats, the time the approval lapses, and the version-1 witness program
 * `program`. The contract's `pay` rebuilds exactly these bytes.
 */
export function payMessage(counter: Pick<Counter, "txid" | "gidx">, payment: Payment): Uint8Array {
  const { left, amount, validUntil, program } = payment;
  const p = bytes(program);
  if (p.length !== 32) throw new Error("a Taproot program is 32 bytes");
  return sha256(
    concat(
      utf8(PAY_TAG),
      bytes(counter.txid),
      le(counter.gidx, 2),
      le(left, 8),
      le(amount, 8),
      le(validUntil, 8),
      p,
      Uint8Array.of(1),
    ),
  );
}

/** A payment's code: its message in base64url, as the contract rebuilds it. */
export const codeOf = (message: Uint8Array): string => base64urlnopad.encode(message);

/**
 * The part of an approval a keeper reads: the amount in sats and the first eight hex characters of
 * the recipient's program, as the contract writes them. The code after them binds every byte.
 */
export function paymentWords(payment: Pick<Payment, "amount" | "program">): string {
  const amount = BigInt(payment.amount);
  if (amount < 0n || amount > MAX_AMOUNT_SATS) throw new Error("amount out of range");
  const p = bytes(payment.program);
  if (p.length !== 32) throw new Error("a Taproot program is 32 bytes");
  return `${amount} sats to ${hex.encode(p.subarray(0, 4))}`;
}

const said = (counter: Pick<Counter, "txid" | "gidx">, payment: Payment): string =>
  `${paymentWords(payment)} ${codeOf(payMessage(counter, payment))}`;

/** The message a keeper sends to approve a payment: `I approve Hive payment of 20000 sats to 3fa9c1d2 <code>`. */
export const approvalText = (counter: Pick<Counter, "txid" | "gidx">, payment: Payment): string =>
  APPROVE + said(counter, payment);

/** The message a keeper sends to stop the desk from paying it. */
export const declineText = (counter: Pick<Counter, "txid" | "gidx">, payment: Payment): string =>
  DECLINE + said(counter, payment);

/** What a message says about a payment: the word, and the amount, recipient and code it names. */
export interface PaymentWord {
  word: "approve" | "decline";
  code: string;
  amountSats: number;
  /** The first eight hex characters of the recipient's program. */
  recipient: string;
}

/**
 * What a message says about a payment: an approval or a decline, or null. Only the exact text
 * counts, as only the exact text pays.
 */
export function paymentWord(text: string): PaymentWord | null {
  const m =
    /^I (approve|decline) Hive payment of (0|[1-9]\d{0,11}) sats to ([0-9a-f]{8}) ([A-Za-z0-9_-]{43})$/.exec(
      String(text),
    );
  return m
    ? { word: m[1] as "approve" | "decline", amountSats: Number(m[2]), recipient: m[3]!, code: m[4]! }
    : null;
}

/**
 * A keeper asks for a withdrawal: `Hive withdrawal: 5,000 sats to <Arkade address>`. Any keeper may
 * ask; two keepers' approvals pay it, like any other payment.
 */
export const withdrawalText = (amountSats: number, address: string): string =>
  `Hive withdrawal: ${amountSats.toLocaleString("en-US")} sats to ${address}`;

export function withdrawalOf(text: string): { amountSats: number; address: string } | null {
  const plain = String(text ?? "").replace(/[`*]/g, "");
  const m = /^\s*hive withdrawal\s*:\s*([\d,_ ]+?)\s*sats?\s+to\s+([a-z0-9]+1[a-z0-9]+)\s*$/i.exec(plain);
  if (!m) return null;
  const amountSats = Number(m[1]!.replace(/[,_ ]/g, ""));
  return Number.isSafeInteger(amountSats) && amountSats > 0
    ? { amountSats, address: m[2]!.toLowerCase() }
    : null;
}

export interface Recipient {
  kind: "arkade" | "bitcoin";
  network: string;
  /** The version-1 witness program the payment output carries. */
  program: Uint8Array;
}

/**
 * The recipient's Taproot program, from the address a keeper reads: an Arkade address (version ‖
 * operator key ‖ Taproot key) or a Bitcoin Taproot address.
 */
export function recipientOf(address: string): Recipient {
  const { prefix, words } = bech32m.decode(address as `${string}1${string}`, 1023);
  if (/^(bc|tb|bcrt)$/.test(prefix)) {
    if (words[0] !== 1) throw new Error("only Taproot addresses");
    const program = Uint8Array.from(bech32m.fromWords(words.slice(1)));
    if (program.length !== 32) throw new Error("a Taproot program is 32 bytes");
    return { kind: "bitcoin", network: prefix, program };
  }
  const data = Uint8Array.from(bech32m.fromWords(words));
  if (data.length !== 65) throw new Error("not an Arkade address");
  return { kind: "arkade", network: prefix, program: data.subarray(33, 65) };
}

export { sha256 };
