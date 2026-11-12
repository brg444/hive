import { ensure, hex } from "@hive/kit";
import { type Instance, leafOf } from "./contract.js";
import { type ClaimPlan, claimHasRemainder, type RefundPlan, type SendPlan, signedSend } from "./spends.js";
import { intVar } from "./templates.js";

/**
 * A spend as data: the coins with the leaf and covenant each uses, and the
 * outputs in order. It is the same transaction the delegatee builds from the
 * template and variables, so whoever executes it, the txid is the same.
 * `@hive/executor` builds and submits it.
 */
export interface CovenantSpend {
  inputs: {
    txid: string;
    vout: number;
    amount: number;
    tapscripts: string[];
    leaf: string;
    condition?: string[];
    covenant?: { script: string; witness: string[] };
  }[];
  outputs: { script: string; amount: number }[];
  extensionIndex: number;
}

/** A covenant's arguments in declared order become its witness, the first declared on top. */
const witness = (args: string[]): string[] => [...args].reverse();

function covenantInput(
  instance: Instance,
  fn: string,
  coin: { txid: string; vout: number; amount: number; script: string },
  args: string[],
): CovenantSpend["inputs"][number] {
  ensure(coin.script === instance.pkScript, "INVALID", "a coin is not the contract's");
  const script = instance.covenants[fn];
  ensure(script, "CONTRACT_INVALID", `function ${fn} has no covenant`);
  return {
    txid: coin.txid,
    vout: coin.vout,
    amount: coin.amount,
    tapscripts: instance.tapscripts,
    leaf: leafOf(instance, fn),
    covenant: { script: hex(script), witness: witness(args) },
  };
}

/**
 * A wallet or treasury send with its signatures, one per coin, as the send
 * templates lay it out: change back to the account first when there is any,
 * then the payment, then the extension.
 */
export function sendSpend(plan: SendPlan, instance: Instance, signatures: string[]): CovenantSpend {
  const { variables } = signedSend(plan, signatures);
  const fn = plan.account === "treasury" ? `send${plan.pair}` : "send";
  const inputs = plan.coins.map((coin, i) =>
    covenantInput(instance, fn, coin, [
      variables.valid_until!,
      variables.amount!,
      variables.change!,
      variables[`sig_${i}`]!,
    ]),
  );
  const outputs =
    plan.change > 0
      ? [
          { script: instance.pkScript, amount: plan.change },
          { script: plan.destination, amount: plan.amount },
        ]
      : [{ script: plan.destination, amount: plan.amount }];
  return { inputs, outputs, extensionIndex: outputs.length };
}

/** An escrow claim: the amount to the provider and the remainder to the treasury above 330 sats. */
export function claimSpend(plan: ClaimPlan, instance: Instance): CovenantSpend {
  const input = covenantInput(instance, "claim", plan.coin, [
    intVar(plan.amount),
    plan.receiptSig,
    plan.claimSig,
  ]);
  const provider = `5120${plan.escrow.providerProgram}`;
  const outputs = claimHasRemainder(plan)
    ? [
        { script: provider, amount: plan.amount },
        { script: `5120${plan.escrow.treasuryProgram}`, amount: plan.coin.amount - plan.amount },
      ]
    : [{ script: provider, amount: plan.coin.amount }];
  return { inputs: [input], outputs, extensionIndex: outputs.length };
}

/** An escrow refund after its deadline: the whole coin back to the treasury. */
export function refundSpend(plan: RefundPlan, instance: Instance): CovenantSpend {
  const input = covenantInput(instance, "refund", plan.coin, []);
  const outputs = [{ script: `5120${plan.escrow.treasuryProgram}`, amount: plan.coin.amount }];
  return { inputs: [input], outputs, extensionIndex: outputs.length };
}
