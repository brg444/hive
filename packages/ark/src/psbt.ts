import { hex, unhex } from "@hive/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { Transaction } from "@scure/btc-signer";
import { compactSize, concat, utf8 } from "./encoding.js";

/**
 * Reading the Ark transactions the indexer returns. The hive builds none of
 * them: the delegatee does. It only reads what others revealed, such as the
 * preimage a solver's claim carries in its condition witness.
 */

/** Ark's PSBT fields: unknown input key type 222, key "condition", value a witness stack. */
export const ARK_FIELD = 222;
const CONDITION = utf8("condition");

export const parseArkTx = (psbt: string): Transaction =>
  Transaction.fromPSBT(Buffer.from(psbt, "base64"), {
    allowUnknown: true,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });

export function encodeWitness(items: Uint8Array[]): Uint8Array {
  return concat(compactSize(items.length), ...items.flatMap((item) => [compactSize(item.length), item]));
}

export function decodeWitness(bytes: Uint8Array): Uint8Array[] {
  const readSize = (at: number): [number, number] => {
    const first = bytes[at]!;
    if (first < 0xfd) return [first, at + 1];
    if (first === 0xfd) return [bytes[at + 1]! | (bytes[at + 2]! << 8), at + 3];
    throw new Error("witness too large");
  };
  let [count, at] = readSize(0);
  const items: Uint8Array[] = [];
  for (; count > 0; count--) {
    const [length, next] = readSize(at);
    items.push(bytes.slice(next, next + length));
    at = next + length;
  }
  return items;
}

type Unknown = [{ type: number; key: Uint8Array }, Uint8Array][];

/** The condition witness of one input, if it carries one. */
export function conditionWitness(tx: Transaction, index = 0): Uint8Array[] | undefined {
  const unknown = (tx.getInput(index) as { unknown?: Unknown }).unknown ?? [];
  for (const [key, value] of unknown)
    if (key.type === ARK_FIELD && hex(key.key) === hex(CONDITION)) return decodeWitness(value);
  return undefined;
}

/** The field to add to an input so it carries `items` as its condition witness. */
export const conditionField = (items: Uint8Array[]): Unknown[number] => [
  { type: ARK_FIELD, key: CONDITION },
  encodeWitness(items),
];

/**
 * The preimage a transaction reveals for `paymentHash`: a 32-byte condition
 * witness item hashing to it, on the input spending `checkpointTxid` when one
 * is named.
 */
export function revealedPreimage(
  tx: Transaction,
  paymentHash: string,
  checkpointTxid?: string,
): string | undefined {
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (checkpointTxid && input.txid && hex(input.txid) !== checkpointTxid) continue;
    for (const item of conditionWitness(tx, i) ?? [])
      if (item.length === 32 && hex(sha256(item)) === paymentHash) return hex(item);
  }
  return undefined;
}

/** For tests and tools: the bytes of a hex payment hash. */
export const paymentHashOf = (preimage: string): string => hex(sha256(unhex(preimage)));
