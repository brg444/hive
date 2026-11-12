import {
  buildOffchainTx,
  ConditionWitness,
  CSVMultisigTapscript,
  EmulatorPacket,
  Extension,
  setArkPsbtField,
  type Transaction,
  VtxoScript,
} from "@arkade-os/sdk";
import { ensure } from "@hive/kit";
import { hex } from "@scure/base";

/**
 * One offchain spend of contract coins, described independently of who
 * executes it. The delegatee builds the same transaction from its template
 * and variables; an online participant builds it from this description. Both
 * get the same txid, which is how either recognizes the outcome.
 */
export interface CovenantSpend {
  inputs: SpendInput[];
  /** The outputs in order, without the extension and the anchor. */
  outputs: { script: string; amount: number }[];
  /** Where the extension output goes among the outputs: the template's `packets.output_index`. */
  extensionIndex: number;
}

export interface SpendInput {
  txid: string;
  vout: number;
  amount: number;
  /** Every leaf of the coin's contract, hex, in the contract's order. */
  tapscripts: string[];
  /** The leaf this spend uses, hex. */
  leaf: string;
  /** The leaf's witness items other than signatures, bottom of the stack first. */
  condition?: string[];
  /** The Arkade Script the Emulator runs for this input, and its witness, bottom of the stack first. */
  covenant?: { script: string; witness: string[] };
}

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
}

/** A witness stack as Bitcoin serializes it: the item count, then each item with its length. */
export function encodeWitness(items: Uint8Array[]): Uint8Array {
  const parts = [compactSize(items.length), ...items.flatMap((i) => [compactSize(i.length), i])];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The extension output: one Emulator entry per covenant input, in input order. */
export function extensionOutput(spend: CovenantSpend): { script: Uint8Array; amount: bigint } | undefined {
  const entries = spend.inputs.flatMap((input, vin) =>
    input.covenant
      ? [
          {
            vin,
            script: hex.decode(input.covenant.script),
            witness: encodeWitness(input.covenant.witness.map((w) => hex.decode(w))),
          },
        ]
      : [],
  );
  if (entries.length === 0) return undefined;
  return Extension.create([EmulatorPacket.create(entries)]).txOut();
}

export interface BuiltSpend {
  txid: string;
  arkTx: Transaction;
  checkpoints: Transaction[];
}

/**
 * The ark transaction and its checkpoints, exactly as the delegatee builds
 * them: the outputs with the extension at its index, one checkpoint per
 * input, and each input's condition witness on both.
 */
export function buildSpend(spend: CovenantSpend, checkpointTapscript: string): BuiltSpend {
  ensure(spend.inputs.length > 0 && spend.inputs.length <= 64, "INVALID", "inputs");
  const extension = extensionOutput(spend);
  ensure(
    extension ? spend.extensionIndex >= 0 && spend.extensionIndex <= spend.outputs.length : true,
    "INVALID",
    "extension index",
  );
  const outputs: { script: Uint8Array; amount: bigint }[] = spend.outputs.map((o) => {
    ensure(Number.isSafeInteger(o.amount) && o.amount >= 0, "INVALID", "output amount");
    return { script: hex.decode(o.script), amount: BigInt(o.amount) };
  });
  if (extension) outputs.splice(spend.extensionIndex, 0, extension);
  const inputs = spend.inputs.map((input) => {
    const tree = new VtxoScript(input.tapscripts.map((s) => hex.decode(s)));
    ensure(input.tapscripts.includes(input.leaf), "INVALID", "the leaf is not one of the contract's");
    return {
      txid: input.txid,
      vout: input.vout,
      value: input.amount,
      tapLeafScript: tree.findLeaf(input.leaf),
      tapTree: tree.encode(),
    };
  });
  const unroll = CSVMultisigTapscript.decode(hex.decode(checkpointTapscript));
  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, unroll);
  spend.inputs.forEach((input, i) => {
    if (!input.condition?.length) return;
    const items = input.condition.map((w) => hex.decode(w));
    setArkPsbtField(arkTx, i, ConditionWitness, items);
    setArkPsbtField(checkpoints[i]!, 0, ConditionWitness, items);
  });
  return { txid: arkTx.id, arkTx, checkpoints };
}
