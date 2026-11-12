import { ensure, hex, sha256Hex, unhex } from "@hive/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { be64, concat, le, ScriptBuilder, sequence, utf8 } from "./encoding.js";
import { p2tr, taggedHash, taprootOutput } from "./taproot.js";

/**
 * The short messages owners sign. Nothing here builds a transaction: the
 * delegatee does, and the covenants accept only what these messages name.
 */
export interface Coin {
  txid: string;
  vout: number;
  amount: number;
}

export const WALLET_SEND_TAG = "simplestwallet/send/v1";
// The treasury and escrow covenants carry these two tags in their compiled scripts (contracts/v4), so
// they keep the name the contracts were built under; changing them means new contracts and addresses.
export const TREASURY_SEND_TAG = "buzzpool/treasury/send/v1";
export const RECEIPT_TAG = "arkade-metered-escrow/v1";
export const CLAIM_TAG = "buzzpool/escrow/claim/v1";

const internalTxid = (txid: string): Uint8Array => unhex(txid).reverse();

function pushData(bytes: Uint8Array): Uint8Array {
  ensure(bytes.length < 0x4c, "INVALID", "push too long");
  return concat([bytes.length], bytes);
}

/**
 * The checkpoint arkd places between a coin and the Ark transaction spending it
 * through `leaf`: one input, the checkpoint output (unroll leaf and `leaf`
 * under the unspendable key) and the zero-value anchor. Returned in internal
 * byte order, as the covenant reads it.
 */
export function checkpointTxid(coin: Coin, leaf: string, unrollScript: string): Uint8Array {
  const script = p2tr(taprootOutput([unhex(unrollScript), unhex(leaf)]));
  const tx = concat(
    le(3, 4),
    [1],
    internalTxid(coin.txid),
    le(coin.vout, 4),
    [0],
    le(0xffffffff, 4),
    [2],
    le(coin.amount, 8),
    pushData(script),
    le(0, 8),
    unhex("0451024e73"),
    le(0, 4),
  );
  return sha256(sha256(tx));
}

/** The checkpoint id as a txid string (display order). */
export const checkpointId = (coin: Coin, leaf: string, unrollScript: string): string =>
  hex(checkpointTxid(coin, leaf, unrollScript).reverse());

/** The witness version and program a P2TR or segwit script pays. */
function destination(script: Uint8Array): Uint8Array {
  const version = script[0] === 0 ? 0 : script[0]! - 0x50;
  ensure(
    version >= 0 && version <= 16 && script[1] === script.length - 2,
    "INVALID",
    "not a witness program",
  );
  return concat([version], script.slice(2));
}

/**
 * What each input's `send` covenant checks: sha256(tag ‖ prev txid ‖ vout:4 ‖
 * amount:8 ‖ change:8 ‖ valid_until:8 ‖ sha256(version ‖ program)), where prev
 * is the coin's checkpoint and vout 0.
 */
export function sendMessage(
  tag: string,
  prev: { txid: Uint8Array; vout: number },
  terms: { amount: number; change: number; validUntil: number; destination: string },
): Uint8Array {
  return sha256(
    concat(
      utf8(tag),
      prev.txid,
      le(prev.vout, 4),
      le(terms.amount, 8),
      le(terms.change, 8),
      le(terms.validUntil, 8),
      sha256(destination(unhex(terms.destination))),
    ),
  );
}

/** The payer's receipt: sha256("arkade-metered-escrow/v1" ‖ escrow id ‖ amount:8). */
export const receiptMessage = (escrowId: string, amount: number | bigint): Uint8Array =>
  sha256(concat(utf8(RECEIPT_TAG), unhex(escrowId), le(amount, 8)));

/** The provider's claim: sha256(CLAIM_TAG ‖ escrow id ‖ amount:8). */
export const claimMessage = (escrowId: string, amount: number | bigint): Uint8Array =>
  sha256(concat(utf8(CLAIM_TAG), unhex(escrowId), le(amount, 8)));

/** The delegatee's spend id: sha256(template ‖ 0 ‖ variables JSON, keys sorted ‖ 0 ‖ outpoints joined by commas). */
export function spendFingerprint(
  templateId: string,
  variables: Record<string, string>,
  outpoints: string[],
): string {
  const sorted = Object.fromEntries(Object.entries(variables).sort(([a], [b]) => (a < b ? -1 : 1)));
  return sha256Hex(
    concat(utf8(templateId), [0], utf8(JSON.stringify(sorted)), [0], utf8(outpoints.join(","))),
  );
}

/** What the exit-leaf key signs to register a spend: tagged_hash("delegatee/spend", id ‖ expires_at:8 big-endian). */
export const spendRequestMessage = (fingerprint: string, expiresAt: number): Uint8Array =>
  taggedHash("delegatee/spend", unhex(fingerprint), be64(expiresAt));

/** The exit leaf a single key must hold for the delegatee to accept its spend request. */
export const exitLeaf = (xOnlyKey: string, exitDelaySeconds: number): string =>
  hex(
    new ScriptBuilder()
      .addInt(sequence(exitDelaySeconds))
      .addOp(0xb2) // OP_CHECKSEQUENCEVERIFY
      .addOp(0x75) // OP_DROP
      .addData(unhex(xOnlyKey))
      .addOp(0xac) // OP_CHECKSIG
      .script(),
  );
