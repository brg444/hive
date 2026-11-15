import { exitDelayVar, intVar, sequence } from "@hive/ark";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import treasuryJson from "../../../contracts/v5/treasury.json" with { type: "json" };
import type { Counter } from "./message.js";

/** The v5 treasury, as arkadec compiles contracts/v5/treasury.ark. */
export const TREASURY_ARTIFACT = treasuryJson;

export interface TreasuryTerms {
  /** The keepers' Buzz keys, x-only hex, in the order the hive confirmed them. */
  keepers: readonly [string, string, string];
  counter: Counter;
  /** The host's delegatee key, compressed hex: the only cosigner a renewal may name. */
  delegateKey: string;
  renewalWindowSeconds: number;
  maxFeeSats: number;
  exitDelaySeconds: number;
}

const LETTERS = ["A", "B", "C"] as const;
const utf8 = (s: string) => new TextEncoder().encode(s);

/** A Buzz key: 64 lowercase hex characters, the x-only key of a point on the curve. */
export function isBuzzKey(key: unknown): key is string {
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) return false;
  try {
    secp256k1.Point.fromHex(`02${key}`);
    return true;
  } catch {
    return false;
  }
}

function checked(t: TreasuryTerms): TreasuryTerms {
  if (t.keepers.length !== 3) throw new Error("a treasury has three keepers");
  for (const k of t.keepers) if (!isBuzzKey(k)) throw new Error("a keeper is a Buzz key, x-only hex");
  if (new Set(t.keepers).size !== 3) throw new Error("three different keepers");
  if (!/^0[23][0-9a-f]{64}$/.test(t.delegateKey)) throw new Error("the delegate key is compressed hex");
  return t;
}

/** A keeper's Buzz key as Bitcoin's compressed form takes it: the even point BIP340 names. */
export const compressedOf = (key: string): string => `02${key}`;

/** The constructor arguments as Hive's `instantiate` and the delegatee take them: hex, by name. */
export function treasuryArguments(terms: TreasuryTerms): Record<string, string> {
  const t = checked(terms);
  return {
    ...Object.fromEntries(
      LETTERS.flatMap((l, i) => [
        [`keeper${l}`, t.keepers[i]!],
        [`hex${l}`, hex.encode(utf8(t.keepers[i]!))],
        // The exit leaves check the same key with OP_CHECKSIG, 33 bytes as the contract's pubkey takes it.
        [`exit${l}`, compressedOf(t.keepers[i]!)],
      ]),
    ),
    counterTxid: t.counter.txid,
    counterGidx: intVar(t.counter.gidx),
    delegateKey: hex.encode(new TextEncoder().encode(t.delegateKey)),
    renewalWindow: intVar(t.renewalWindowSeconds),
    maxFee: intVar(t.maxFeeSats),
    exitDelay: exitDelayVar(t.exitDelaySeconds),
  };
}

/** The same arguments as the SDK's contract API takes them. */
export function sdkArguments(terms: TreasuryTerms): Record<string, Uint8Array | bigint> {
  const t = checked(terms);
  return {
    ...Object.fromEntries(
      LETTERS.flatMap((l, i) => [
        [`keeper${l}`, hex.decode(t.keepers[i]!)],
        [`hex${l}`, utf8(t.keepers[i]!)],
        // The SDK takes a pubkey x-only, which a Buzz key already is.
        [`exit${l}`, hex.decode(t.keepers[i]!)],
      ]),
    ),
    counterTxid: hex.decode(t.counter.txid),
    counterGidx: BigInt(t.counter.gidx),
    delegateKey: new TextEncoder().encode(t.delegateKey),
    renewalWindow: BigInt(t.renewalWindowSeconds),
    maxFee: BigInt(t.maxFeeSats),
    exitDelay: BigInt(sequence(t.exitDelaySeconds)),
  };
}
