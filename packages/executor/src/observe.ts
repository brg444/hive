import { VtxoScript } from "@arkade-os/sdk";
import { ensure } from "@hive/kit";
import { hex } from "@scure/base";
import type { Action } from "./routes.js";
import { buildSpend, extensionOutput } from "./spend.js";

/** A complete spend, untouched inputs, affirmative supersession, or an incomplete indexer view. */
export type Observation = "spent" | "unspent" | "elsewhere" | "pending";

/** The indexer's transaction relationships and the coin's immutable identity. */
export interface ObservedCoin {
  txid: string;
  vout: number;
  amount: number;
  script: string;
  isSpent: boolean;
  isSwept?: boolean;
  spentBy?: string;
  settledBy?: string;
  arkTxid?: string;
}

export interface SpendObserverOptions {
  coins(query: { outpoints: string[] }, signal?: AbortSignal): Promise<ObservedCoin[]>;
  checkpointTapscript: string;
}

/**
 * Every caller observes one fixed transaction. Missing or contradictory
 * relationships keep it pending; only positive links establish another spend.
 * Payment and change outputs are checked even when already spent themselves.
 */
export function observeSpend(
  options: SpendObserverOptions,
): (action: Action, signal?: AbortSignal) => Promise<Observation> {
  return async (action, signal) => {
    if (!action.spend) return "pending";
    const spend = action.spend;
    ensure(spend.outputs.length > 0, "ACTION_MISMATCH", "a spend must name its payment outputs");
    const built = buildSpend(spend, options.checkpointTapscript);
    ensure(built.txid === action.txid, "ACTION_MISMATCH", "observation names another transaction");
    const outpoints = spend.inputs.map((input) => `${input.txid}:${input.vout}`);
    ensure(new Set(outpoints).size === outpoints.length, "ACTION_MISMATCH", "duplicate input outpoints");
    const inputs = await options.coins({ outpoints }, signal);
    if (inputs.length !== outpoints.length) return "pending";
    let mine = 0;
    let elsewhere = 0;
    for (let i = 0; i < spend.inputs.length; i++) {
      const expected = spend.inputs[i]!;
      const matches = inputs.filter((coin) => coin.txid === expected.txid && coin.vout === expected.vout);
      if (matches.length !== 1) return "pending";
      const coin = matches[0]!;
      const script = hex.encode(new VtxoScript(expected.tapscripts.map((leaf) => hex.decode(leaf))).pkScript);
      if (coin.amount !== expected.amount || coin.script !== script || coin.isSwept) return "pending";
      if (!coin.isSpent && !coin.spentBy && !coin.arkTxid && !coin.settledBy) continue;
      const checkpoint = built.checkpoints[i]!.id;
      const ours = coin.arkTxid === action.txid;
      if (coin.isSpent && ours && coin.spentBy === checkpoint && !coin.settledBy) {
        mine++;
        continue;
      }
      const viaBatch = Boolean(coin.settledBy) && coin.spentBy !== checkpoint;
      // Different Ark transactions through the same input leaf share a checkpoint;
      // the Ark transaction ID distinguishes them.
      const viaOther =
        !coin.settledBy && Boolean(coin.spentBy) && (Boolean(coin.arkTxid) || coin.spentBy !== checkpoint);
      if (!coin.isSpent || ours || (!viaBatch && !viaOther)) return "pending";
      elsewhere++;
    }
    if (mine > 0 && mine !== spend.inputs.length) return "pending";
    if (elsewhere > 0) return "elsewhere";
    if (mine === 0) return "unspent";
    const hasExtension = Boolean(extensionOutput(spend));
    const expectedOutputs = spend.outputs.map((output, index) => ({
      ...output,
      txid: action.txid,
      vout: index + (hasExtension && index >= spend.extensionIndex ? 1 : 0),
    }));
    const outputs = await options.coins(
      {
        outpoints: expectedOutputs.map((output) => `${output.txid}:${output.vout}`),
      },
      signal,
    );
    if (outputs.length !== expectedOutputs.length) return "pending";
    for (const expected of expectedOutputs) {
      const matches = outputs.filter((coin) => coin.txid === expected.txid && coin.vout === expected.vout);
      if (
        matches.length !== 1 ||
        matches[0]!.script !== expected.script ||
        matches[0]!.amount !== expected.amount
      )
        return "pending";
    }
    return "spent";
  };
}
