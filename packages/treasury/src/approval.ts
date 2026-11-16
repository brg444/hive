import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { approvalText, type Counter, type Payment } from "./message.js";

/**
 * One keeper's approval as the contract's `pay` takes it: the Buzz message's signature, and the two
 * parts of the message Buzz chooses itself, its created_at as digits and its tags as JSON. The rest
 * of the message, the keeper's key and the text, the contract knows.
 */
export interface Approval {
  sig: Uint8Array;
  time: Uint8Array;
  tags: Uint8Array;
}

/** A signed Nostr event, as Buzz sends one and the hive's host keeps it. */
export interface BuzzEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export class ApprovalRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ApprovalRefused";
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** NIP-01: an event's id is sha256 of [0, pubkey, created_at, kind, tags, content], as JSON. */
export const serialization = (
  pubkey: string,
  createdAt: string,
  kind: number,
  tags: string,
  content: string,
) => `[0,"${pubkey}",${createdAt},${kind},${tags},${JSON.stringify(content)}]`;

function verifies(sig: Uint8Array, id: Uint8Array, key: string): boolean {
  try {
    return schnorr.verify(sig, id, hex.decode(key));
  } catch {
    return false;
  }
}

/**
 * A keeper's Buzz message, checked exactly as the contract will check it: a kind 9 event by the
 * keeper whose text is exactly this payment's approval, with a valid id and signature. Returns the
 * approval in the form `pay` takes, or throws ApprovalRefused.
 */
export function buzzApproval(
  keeper: string,
  counter: Pick<Counter, "txid" | "gidx">,
  payment: Payment,
  event: BuzzEvent,
): Approval {
  if (!event || event.pubkey !== keeper) throw new ApprovalRefused("NOT_THIS_KEEPER");
  if (event.kind !== 9) throw new ApprovalRefused("NOT_A_MESSAGE");
  if (event.content !== approvalText(counter, payment)) throw new ApprovalRefused("ANOTHER_PAYMENT");
  const time = String(event.created_at);
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0 || time.length > 10)
    throw new ApprovalRefused("NOT_A_MESSAGE");
  if (
    !Array.isArray(event.tags) ||
    !event.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))
  )
    throw new ApprovalRefused("NOT_A_MESSAGE");
  const tags = JSON.stringify(event.tags);
  const id = sha256(utf8(serialization(keeper, time, 9, tags, event.content)));
  if (hex.encode(id) !== event.id) throw new ApprovalRefused("NOT_A_MESSAGE");
  let sig: Uint8Array;
  try {
    sig = hex.decode(event.sig);
  } catch {
    throw new ApprovalRefused("BAD_SIGNATURE");
  }
  if (sig.length !== 64 || !verifies(sig, id, keeper)) throw new ApprovalRefused("BAD_SIGNATURE");
  return { sig, time: utf8(time), tags: utf8(tags) };
}

/** Rechecks a stored approval against the keeper it is filed under, before it is spent. */
export function approvalHolds(
  keeper: string,
  counter: Pick<Counter, "txid" | "gidx">,
  payment: Payment,
  a: Approval,
): boolean {
  if (a.time.length > 10) return false;
  const id = sha256(
    utf8(serialization(keeper, text(a.time), 9, text(a.tags), approvalText(counter, payment))),
  );
  return verifies(a.sig, id, keeper);
}

/** Whether an event's id is its own serialization's: cheap, and what a signature is checked against. */
export function eventIdHolds(event: BuzzEvent): boolean {
  try {
    if (!/^[0-9a-f]{64}$/.test(event.pubkey) || !/^[0-9a-f]{128}$/.test(event.sig)) return false;
    if (!Number.isSafeInteger(event.created_at) || !Number.isSafeInteger(event.kind)) return false;
    if (typeof event.content !== "string" || !Array.isArray(event.tags)) return false;
    if (!event.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))) return false;
    const id = sha256(
      utf8(
        serialization(
          event.pubkey,
          String(event.created_at),
          event.kind,
          JSON.stringify(event.tags),
          event.content,
        ),
      ),
    );
    return hex.encode(id) === event.id;
  } catch {
    return false;
  }
}

/** Whether the event's author signed its id. The id itself is `eventIdHolds`'s to check. */
export function eventSigned(event: BuzzEvent): boolean {
  try {
    return verifies(hex.decode(event.sig), hex.decode(event.id), event.pubkey);
  } catch {
    return false;
  }
}

/** Whether an event is what it says: its id is its own serialization's, and its author signed it. */
export const eventHolds = (event: BuzzEvent): boolean => eventIdHolds(event) && eventSigned(event);
