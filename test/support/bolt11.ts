/**
 * A BOLT11 writer for tests, written apart from the reader in
 * `packages/hive/src/bolt11.ts` so each checks the other. The signature is
 * zeros: the hive does not verify it.
 */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    generator.forEach((g, i) => {
      if ((top >>> i) & 1) check ^= g;
    });
  }
  return check;
}

function toWords(bytes: Uint8Array): number[] {
  const bits = [...bytes].map((b) => b.toString(2).padStart(8, "0")).join("");
  const padded = bits.padEnd(Math.ceil(bits.length / 5) * 5, "0");
  return padded.match(/.{5}/g)!.map((chunk) => Number.parseInt(chunk, 2));
}

function field(tag: number, words: number[]): number[] {
  return [tag, words.length >> 5, words.length & 31, ...words];
}

export function encodeInvoice(args: {
  /** `bcrt`, `tbs`, `tb` or `bc`. */
  prefix: string;
  /** The amount part as written, e.g. `300u` or `30000n`. */
  amount: string;
  paymentHash: string;
  /** Extra tagged fields, written before the payment hash. */
  extra?: { tag: number; words: number[] }[];
  /** Write the payment hash this many times. */
  hashes?: number;
  /** An explicit expiry field; absent means BOLT11's one-hour default. */
  expirySeconds?: number;
  /** Creation time, unix seconds; a fixed past time unless given. */
  createdAt?: number;
}): string {
  const hrp = `ln${args.prefix}${args.amount}`;
  const created = args.createdAt ?? 1_760_000_000;
  const timestamp = Array.from({ length: 7 }, (_, i) => Math.floor(created / 32 ** (6 - i)) % 32);
  const expiry =
    args.expirySeconds === undefined
      ? []
      : field(
          6,
          Array.from({ length: 4 }, (_, i) => Math.floor(args.expirySeconds! / 32 ** (3 - i)) % 32),
        );
  const hash = toWords(Buffer.from(args.paymentHash, "hex"));
  const fields = [
    ...(args.extra ?? []).flatMap((f) => field(f.tag, f.words)),
    ...expiry,
    ...Array.from({ length: args.hashes ?? 1 }, () => field(1, hash)).flat(),
  ];
  const data = [...timestamp, ...fields, ...new Array<number>(104).fill(0)];
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  const expanded = [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
  const check = polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (check >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((w) => CHARSET[w]).join("")}`;
}
