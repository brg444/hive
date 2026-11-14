// Quotes and receipts. Both are BIP-340 signatures over SHA-256 digests.
//
// A receipt is exactly what the escrow's claim path checks:
//   sha256(jobId || num2bin(amountSats, 8))   (NUM2BIN is little-endian)
// A quote is the provider's offer for one job, signed over its canonical JSON.
//
// The receipt's form is the covenant's, so it carries no tag of its own. What keeps it apart from
// everything else this key signs is its shape: exactly 40 bytes, 32 of them a job id the agent drew
// at random. A quote and a hive link message are tagged text, and RECEIPT_BYTES below keeps either
// from ever being 40 bytes long.
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

export function receiptDigest(jobId: Uint8Array, amountSats: bigint): Uint8Array {
    if (jobId.length !== 32) throw new Error("jobId must be 32 bytes");
    if (amountSats <= 0n || amountSats >= 1n << 63n) throw new Error("amount out of range");
    return sha256(concat(jobId, le(amountSats, 8)));
}

export function signReceipt(secret: Uint8Array, jobId: Uint8Array, amountSats: bigint): Uint8Array {
    return schnorr.sign(receiptDigest(jobId, amountSats), secret);
}

export function verifyReceipt(agentPk: Uint8Array, jobId: Uint8Array, amountSats: bigint, sig: Uint8Array): boolean {
    try {
        return schnorr.verify(sig, receiptDigest(jobId, amountSats), agentPk);
    } catch {
        return false;
    }
}

/** Canonical JSON: keys sorted at every level, no whitespace. Values must be JSON-safe. */
export function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/** The length of a receipt's preimage: nothing else a worker signs may be this long. */
export const RECEIPT_BYTES = 40;

function tagged(text: string): Uint8Array {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length === RECEIPT_BYTES) throw new Error("a message the length of a receipt is not signed");
    return bytes;
}

export function quoteDigest(quote: unknown): Uint8Array {
    return sha256(tagged(`pay.arkade.v1/quote:${canonical(quote)}`));
}

export function signQuote(secret: Uint8Array, quote: unknown): Uint8Array {
    return schnorr.sign(quoteDigest(quote), secret);
}

export function verifyQuote(providerPk: Uint8Array, quote: unknown, sig: Uint8Array): boolean {
    try {
        return schnorr.verify(sig, quoteDigest(quote), providerPk);
    } catch {
        return false;
    }
}

export function le(n: bigint, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let v = n;
    for (let i = 0; i < size; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

export const hexBytes = (value: unknown, size: number, name: string): Uint8Array => {
    if (typeof value !== "string" || value.length !== size * 2) throw new Error(`${name} must be ${size} bytes of hex`);
    return hex.decode(value.toLowerCase());
};

/**
 * What a hive's own agent node signs to report to the Hive service and fetch its members:
 * sha256("hive-agent/v1|" + channel + "|" + at + "|" + what). The fixed prefix keeps it apart from
 * receipts and quotes, and only two forms of `what` are signed at all.
 */
export function hiveLinkDigest(channelId: string, at: number, what: string): Uint8Array {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(channelId)) throw new Error("channelId");
    if (!Number.isSafeInteger(at) || at <= 0) throw new Error("at");
    if (!(what === "members" || /^events\|\d+\|[0-9a-f]{64}$/.test(what))) throw new Error("not a hive link message");
    return sha256(tagged(`hive-agent/v1|${channelId}|${at}|${what}`));
}
