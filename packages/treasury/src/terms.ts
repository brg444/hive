import { exitDelayVar, intVar, pairKeys, sequence } from "@hive/ark";
import { hex } from "@scure/base";
import treasuryJson from "../../../contracts/v5/treasury.json" with { type: "json" };
import { type Counter, type KeeperKind, keeperPoint, sha256 } from "./message.js";

/** The v5 treasury, as arkadec compiles contracts/v5/treasury.ark. */
export const TREASURY_ARTIFACT = treasuryJson;

/** A keeper as the treasury knows them: the P-256 key that approves, and the Bitcoin key that exits. */
export interface Keeper {
  kind: KeeperKind;
  /** 0x11 ‖ compressed P-256, hex. */
  key: string;
  /** Compressed secp256k1, hex: the key on the pairs' MuSig2 exit keys. */
  bitcoinKey: string;
  /** The domain the keeper's passkey belongs to: where they made it. */
  site: string;
}

export interface TreasuryTerms {
  keepers: readonly [Keeper, Keeper, Keeper];
  counter: Counter;
  /** The host's delegatee key, compressed hex: the only cosigner a renewal may name. */
  delegateKey: string;
  renewalWindowSeconds: number;
  maxFeeSats: number;
  exitDelaySeconds: number;
}

const LETTERS = ["A", "B", "C"] as const;

/** How WebAuthn names a passkey's site in its authenticator data: sha256 of the domain. */
export const siteHash = (site: string): Uint8Array => sha256(new TextEncoder().encode(site));

/** A site a passkey can belong to: a domain name, lowercase, as WebAuthn takes an rpId. */
export const SITE = /^(localhost|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/;

function checked(t: TreasuryTerms): TreasuryTerms {
  if (t.keepers.length !== 3) throw new Error("a treasury has three keepers");
  for (const k of t.keepers) {
    keeperPoint(k.key);
    if (!SITE.test(k.site)) throw new Error("a keeper's site is a domain name");
  }
  if (new Set(t.keepers.map((k) => k.key)).size !== 3) throw new Error("three different keepers");
  if (!/^0[23][0-9a-f]{64}$/.test(t.delegateKey)) throw new Error("the delegate key is compressed hex");
  return t;
}

/** The pairs' exit keys, 33 bytes as the contract's pubkey type takes them. */
export function pairsOf(t: Pick<TreasuryTerms, "keepers">): Record<"01" | "02" | "12", string> {
  const pairs = pairKeys(t.keepers.map((k) => k.bitcoinKey) as [string, string, string]);
  return { "01": `02${pairs["01"]}`, "02": `02${pairs["02"]}`, "12": `02${pairs["12"]}` };
}

/** The constructor arguments as Hive's `instantiate` and the delegatee take them: hex, by name. */
export function treasuryArguments(terms: TreasuryTerms): Record<string, string> {
  const t = checked(terms);
  const pairs = pairsOf(t);
  return {
    ...Object.fromEntries(
      LETTERS.flatMap((l, i) => [
        [`keeper${l}`, t.keepers[i]!.key],
        [`kind${l}`, intVar(t.keepers[i]!.kind)],
      ]),
    ),
    ...Object.fromEntries(LETTERS.map((l, i) => [`site${l}`, hex.encode(siteHash(t.keepers[i]!.site))])),
    counterTxid: t.counter.txid,
    counterGidx: intVar(t.counter.gidx),
    delegateKey: hex.encode(new TextEncoder().encode(t.delegateKey)),
    renewalWindow: intVar(t.renewalWindowSeconds),
    maxFee: intVar(t.maxFeeSats),
    pair01: pairs["01"],
    pair02: pairs["02"],
    pair12: pairs["12"],
    exitDelay: exitDelayVar(t.exitDelaySeconds),
  };
}

/** The same arguments as the SDK's contract API takes them. */
export function sdkArguments(terms: TreasuryTerms): Record<string, Uint8Array | bigint> {
  const t = checked(terms);
  const pairs = pairsOf(t);
  return {
    ...Object.fromEntries(
      LETTERS.flatMap((l, i) => [
        [`keeper${l}`, hex.decode(t.keepers[i]!.key)],
        [`kind${l}`, BigInt(t.keepers[i]!.kind)],
      ]),
    ),
    ...Object.fromEntries(LETTERS.map((l, i) => [`site${l}`, siteHash(t.keepers[i]!.site)])),
    counterTxid: hex.decode(t.counter.txid),
    counterGidx: BigInt(t.counter.gidx),
    delegateKey: new TextEncoder().encode(t.delegateKey),
    renewalWindow: BigInt(t.renewalWindowSeconds),
    maxFee: BigInt(t.maxFeeSats),
    // The SDK takes a pubkey x-only.
    pair01: hex.decode(pairs["01"]).subarray(1),
    pair02: hex.decode(pairs["02"]).subarray(1),
    pair12: hex.decode(pairs["12"]).subarray(1),
    exitDelay: BigInt(sequence(t.exitDelaySeconds)),
  };
}

/**
 * The line a keeper posts in the hive's channel from their own Buzz identity, which ties their keys to
 * them: `Hive keeper key: <Bitcoin key> <passkey key> <site>`. The keeper console writes it.
 */
export const keeperLine = (k: Pick<Keeper, "bitcoinKey" | "key" | "site">): string =>
  `Hive keeper key: ${keeperToken(k)}`;

/** A keeper's three values as one string, the form the channel's governance keeps them in. */
export const keeperToken = (k: Pick<Keeper, "bitcoinKey" | "key" | "site">): string =>
  `${k.bitcoinKey} ${k.key} ${k.site}`;

const TOKEN = /^(0[23][0-9a-f]{64}) (11[0-9a-f]{66}) (\S+)$/;

/** A keeper (a passkey keeper: a raw key has no console) from the token a key line carries, or null. */
export function keeperOf(token: string): Keeper | null {
  const m = TOKEN.exec(String(token).trim().toLowerCase());
  if (!m || !SITE.test(m[3]!)) return null;
  try {
    keeperPoint(m[2]!);
  } catch {
    return null;
  }
  return { kind: 1, bitcoinKey: m[1]!, key: m[2]!, site: m[3]! };
}
