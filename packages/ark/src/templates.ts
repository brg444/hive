import { ensure, hex } from "@hive/kit";
import boardingJson from "../../../contracts/v4/boarding.json" with { type: "json" };
import escrowJson from "../../../contracts/v4/escrow.json" with { type: "json" };
import treasuryJson from "../../../contracts/v4/treasury.json" with { type: "json" };
import walletJson from "../../../contracts/v4/wallet.json" with { type: "json" };
import type { Artifact } from "./contract.js";
import { scriptNum, sequence } from "./encoding.js";
import type { Pair } from "./musig.js";

/**
 * The three contracts and the delegatee templates that drive them.
 *
 * - `wallet` is the SimpleWallet contract, byte for byte: provider payout accounts.
 * - `treasury` is the same wallet with three owners, one MuSig2 key per pair
 *   of stewards: `exitXY`, `sendXY` and the wallet's `renew` unchanged.
 * - `escrow` holds one purchase: `claim` with the payer's receipt and the
 *   provider's claim signature, `refund` to the treasury at the deadline,
 *   and the pairs' exits.
 */
export const ARTIFACTS = {
  wallet: walletJson as Artifact,
  treasury: treasuryJson as Artifact,
  escrow: escrowJson as Artifact,
} as const;
export type ContractKind = keyof typeof ARTIFACTS;

const FORMAT = "delegateed-template/v1";
const ID = /^[0-9a-f]{64}$/;

/** Template variables are lowercase hex in their type's encoding; integers are Script numbers. */
export const intVar = (n: number | bigint): string => hex(scriptNum(n));
export const exitDelayVar = (seconds: number): string => intVar(sequence(seconds));

// ---------------------------------------------------------------- wallet (SimpleWallet's templates)

export interface WalletTerms {
  owner: string;
  exitDelaySeconds: number;
  renewalWindowSeconds: number;
  maxFeeSats: number;
}

export const walletVariables = (t: WalletTerms): Record<string, string> => ({
  owner: t.owner,
  exit_delay: exitDelayVar(t.exitDelaySeconds),
  renewal_window: intVar(t.renewalWindowSeconds),
  max_fee: intVar(t.maxFeeSats),
});

export const walletArguments = (t: WalletTerms): Record<string, string> => {
  const v = walletVariables(t);
  return { owner: v.owner!, exitDelay: v.exit_delay!, renewalWindow: v.renewal_window!, maxFee: v.max_fee! };
};

/** SimpleWallet's `contract/renewal.json` for its artifact. */
export function walletRenewalTemplate(artifactId: string): Record<string, unknown> {
  ensure(ID.test(artifactId), "INVALID", "artifact id");
  return {
    format: FORMAT,
    type: "intent",
    variables: { owner: "pubkey", exit_delay: "int", renewal_window: "int", max_fee: "int" },
    inputs: [
      {
        name: "funds",
        schedule: { before_expiry_seconds: "<renewal_window>" },
        contract: {
          definition: { artifact: artifactId },
          arguments: {
            owner: "<owner>",
            exitDelay: "<exit_delay>",
            renewalWindow: "<renewal_window>",
            maxFee: "<max_fee>",
          },
        },
        spend: { function: "renew", leaf: "renew" },
      },
    ],
    outputs: [
      {
        name: "renewed",
        index: 0,
        value: { from: "funds" },
        locking: { from: "funds" },
        assets: [{ from: "funds" }],
      },
    ],
    fees: { from: "funds", max: "<max_fee>" },
    packets: { output_index: 1 },
  };
}

/** A send from n coins: `amount` to `dest`, the rest back as change when `change` > 0 (SimpleWallet's `spendTemplate`). */
function sendTemplate(
  inputs: { name: string; definition: unknown; arguments: Record<string, string>; fn: string }[],
  variables: Record<string, string>,
  change: boolean,
): Record<string, unknown> {
  const names = inputs.map((i) => i.name);
  const payment = (index: number, fixed: boolean) => ({
    name: "payment",
    index,
    value: { from: names, ...(fixed ? { amount: "<amount>" } : {}) },
    locking: "<dest>",
  });
  const back = { name: "change", index: 0, value: { from: names }, locking: { from: names[0] } };
  const outputs = change ? [back, payment(1, true)] : [payment(0, false)];
  return {
    format: FORMAT,
    type: "offchain",
    variables,
    inputs: inputs.map((input, i) => ({
      name: input.name,
      contract: { definition: input.definition, arguments: input.arguments },
      spend: {
        function: input.fn,
        leaf: input.fn,
        arguments: ["<valid_until>", "<amount>", "<change>", `<sig_${i}>`],
      },
    })),
    outputs,
    packets: { output_index: outputs.length },
  };
}

const sendVariables = (n: number): Record<string, string> => {
  const v: Record<string, string> = { amount: "int", change: "int", valid_until: "int", dest: "bytes" };
  for (let i = 0; i < n; i++) v[`sig_${i}`] = "bytes";
  return v;
};

export function walletSendTemplate(
  artifactId: string,
  coins: number,
  change: boolean,
): Record<string, unknown> {
  ensure(ID.test(artifactId) && coins >= 1 && coins <= 64, "INVALID", "wallet send template");
  return sendTemplate(
    Array.from({ length: coins }, (_, i) => ({
      name: `in${i}`,
      definition: { artifact: artifactId },
      arguments: {
        owner: "<owner>",
        exitDelay: "<exit_delay>",
        renewalWindow: "<renewal_window>",
        maxFee: "<max_fee>",
      },
      fn: "send",
    })),
    { owner: "pubkey", exit_delay: "int", renewal_window: "int", max_fee: "int", ...sendVariables(coins) },
    change,
  );
}

/**
 * SimpleWallet's `contract/boarding.json`: an onchain address the delegatee boards
 * into the wallet once a deposit confirms. The template names the wallet's
 * artifact as `SIMPLE_WALLET`; registration substitutes its id.
 */
export function walletBoardingTemplate(artifactId: string): Record<string, unknown> {
  ensure(ID.test(artifactId), "INVALID", "artifact id");
  return JSON.parse(JSON.stringify(boardingJson).replace("SIMPLE_WALLET", artifactId)) as Record<
    string,
    unknown
  >;
}

/** The boarding contract inlined in that template. */
export const BOARDING_CONTRACT = (
  boardingJson as unknown as { inputs: { contract: { definition: Artifact } }[] }
).inputs[0]!.contract.definition;

export const walletBoardingVariables = (
  t: WalletTerms,
  boardingExitDelaySeconds: number,
): Record<string, string> => ({
  ...walletVariables(t),
  boarding_exit_delay: exitDelayVar(boardingExitDelaySeconds),
});

/** The boarding contract's arguments: `renewalProgram` is the wallet's own witness program. */
export const boardingArguments = (
  t: WalletTerms,
  walletProgram: string,
  boardingExitDelaySeconds: number,
): Record<string, string> => {
  const v = walletBoardingVariables(t, boardingExitDelaySeconds);
  return {
    owner: v.owner!,
    boardingExitDelay: v.boarding_exit_delay!,
    renewalProgram: walletProgram,
    maxFee: v.max_fee!,
  };
};

// ---------------------------------------------------------------- treasury

export interface TreasuryTerms {
  /** x-only MuSig2 keys of the three steward pairs. */
  pairs: Record<Pair, string>;
  exitDelaySeconds: number;
  renewalWindowSeconds: number;
  maxFeeSats: number;
}

export const treasuryArguments = (t: TreasuryTerms): Record<string, string> => ({
  pair01: t.pairs["01"],
  pair02: t.pairs["02"],
  pair12: t.pairs["12"],
  exitDelay: exitDelayVar(t.exitDelaySeconds),
  renewalWindow: intVar(t.renewalWindowSeconds),
  maxFee: intVar(t.maxFeeSats),
});

/**
 * The treasury's renewal watch, with this hive's constructor values written
 * into the template: the template id is then the hive's own, and no stranger
 * can disable it by failing a watch of their own under the same id.
 */
export function treasuryRenewalTemplate(artifactId: string, t: TreasuryTerms): Record<string, unknown> {
  ensure(ID.test(artifactId), "INVALID", "artifact id");
  return {
    format: FORMAT,
    type: "intent",
    inputs: [
      {
        name: "funds",
        schedule: { before_expiry_seconds: t.renewalWindowSeconds },
        contract: { definition: { artifact: artifactId }, arguments: treasuryArguments(t) },
        spend: { function: "renew", leaf: "renew" },
      },
    ],
    outputs: [
      {
        name: "renewed",
        index: 0,
        value: { from: "funds" },
        locking: { from: "funds" },
        assets: [{ from: "funds" }],
      },
    ],
    fees: { from: "funds", max: t.maxFeeSats },
    packets: { output_index: 1 },
  };
}

/** A treasury send authorized by one pair, from `coins` coins, with or without change. */
export function treasurySendTemplate(
  artifactId: string,
  pair: Pair,
  coins: number,
  change: boolean,
): Record<string, unknown> {
  ensure(ID.test(artifactId) && coins >= 1 && coins <= 64, "INVALID", "treasury send template");
  const args = {
    pair01: "<pair01>",
    pair02: "<pair02>",
    pair12: "<pair12>",
    exitDelay: "<exit_delay>",
    renewalWindow: "<renewal_window>",
    maxFee: "<max_fee>",
  };
  return sendTemplate(
    Array.from({ length: coins }, (_, i) => ({
      name: `in${i}`,
      definition: { artifact: artifactId },
      arguments: args,
      fn: `send${pair}`,
    })),
    {
      pair01: "bytes32",
      pair02: "bytes32",
      pair12: "bytes32",
      exit_delay: "int",
      renewal_window: "int",
      max_fee: "int",
      ...sendVariables(coins),
    },
    change,
  );
}

export const treasuryVariables = (t: TreasuryTerms): Record<string, string> => ({
  pair01: t.pairs["01"],
  pair02: t.pairs["02"],
  pair12: t.pairs["12"],
  exit_delay: exitDelayVar(t.exitDelaySeconds),
  renewal_window: intVar(t.renewalWindowSeconds),
  max_fee: intVar(t.maxFeeSats),
});

// ---------------------------------------------------------------- escrow

export interface EscrowTerms {
  /** x-only key the payer's agent signs receipts with. */
  payer: string;
  /** x-only key the provider signs its claim with. */
  provider: string;
  /** Witness programs (32 bytes) of the provider's payout script and the treasury. */
  providerProgram: string;
  treasuryProgram: string;
  escrowId: string;
  /** Unix seconds: claims close and the refund opens. */
  timeoutAt: number;
  exitDelaySeconds: number;
  pairs: Record<Pair, string>;
}

export const escrowArguments = (t: EscrowTerms): Record<string, string> => ({
  payer: t.payer,
  provider: t.provider,
  providerProgram: t.providerProgram,
  treasuryProgram: t.treasuryProgram,
  escrowId: t.escrowId,
  timeoutAt: intVar(t.timeoutAt),
  exitDelay: exitDelayVar(t.exitDelaySeconds),
  pair01: t.pairs["01"],
  pair02: t.pairs["02"],
  pair12: t.pairs["12"],
});

/** The escrow's one watch: at the deadline the delegatee returns everything to the treasury. */
export function escrowRefundTemplate(artifactId: string, t: EscrowTerms): Record<string, unknown> {
  ensure(ID.test(artifactId), "INVALID", "artifact id");
  return {
    format: FORMAT,
    type: "offchain",
    inputs: [
      {
        name: "escrow",
        contract: { definition: { artifact: artifactId }, arguments: escrowArguments(t) },
        spend: { function: "refund", leaf: "refund" },
      },
    ],
    outputs: [{ name: "treasury", index: 0, value: { from: "escrow" }, locking: `5120${t.treasuryProgram}` }],
    packets: { output_index: 1 },
  };
}

/**
 * A claim of `amount` with the payer's receipt and the provider's claim
 * signature: `amount` to the provider and, when it exceeds 330 sats, the
 * remainder to the treasury; otherwise the provider takes the whole coin.
 */
export function escrowClaimTemplate(artifactId: string, remainder: boolean): Record<string, unknown> {
  ensure(ID.test(artifactId), "INVALID", "artifact id");
  const outputs = remainder
    ? [
        {
          name: "provider",
          index: 0,
          value: { from: "escrow", amount: "<amount>" },
          locking: "5120<provider_program>",
        },
        { name: "treasury", index: 1, value: { from: "escrow" }, locking: "5120<treasury_program>" },
      ]
    : [{ name: "provider", index: 0, value: { from: "escrow" }, locking: "5120<provider_program>" }];
  return {
    format: FORMAT,
    type: "offchain",
    variables: {
      payer: "bytes32",
      provider: "bytes32",
      provider_program: "bytes32",
      treasury_program: "bytes32",
      escrow_id: "bytes32",
      timeout_at: "int",
      exit_delay: "int",
      pair01: "bytes32",
      pair02: "bytes32",
      pair12: "bytes32",
      amount: "int",
      receipt_sig: "bytes",
      claim_sig: "bytes",
    },
    inputs: [
      {
        name: "escrow",
        contract: {
          definition: { artifact: artifactId },
          arguments: {
            payer: "<payer>",
            provider: "<provider>",
            providerProgram: "<provider_program>",
            treasuryProgram: "<treasury_program>",
            escrowId: "<escrow_id>",
            timeoutAt: "<timeout_at>",
            exitDelay: "<exit_delay>",
            pair01: "<pair01>",
            pair02: "<pair02>",
            pair12: "<pair12>",
          },
        },
        spend: { function: "claim", leaf: "claim", arguments: ["<amount>", "<receipt_sig>", "<claim_sig>"] },
      },
    ],
    outputs,
    packets: { output_index: outputs.length },
  };
}

export const escrowVariables = (t: EscrowTerms): Record<string, string> => ({
  payer: t.payer,
  provider: t.provider,
  provider_program: t.providerProgram,
  treasury_program: t.treasuryProgram,
  escrow_id: t.escrowId,
  timeout_at: intVar(t.timeoutAt),
  exit_delay: exitDelayVar(t.exitDelaySeconds),
  pair01: t.pairs["01"],
  pair02: t.pairs["02"],
  pair12: t.pairs["12"],
});
