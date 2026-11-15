import { Arkade, arkade, InMemoryContractRepository, networks, type VirtualCoin } from "@arkade-os/sdk-0.5.6";

/**
 * The v5 treasury's offchain spends, through the Arkade SDK's contract API: a payment two keepers
 * approved, and a merge of a chip-in or a returned escrow into the treasury coin. Neither needs a
 * key of ours: the covenant checks the keepers' approvals, and the Operator and the Emulator cosign.
 * The treasury's artifact and constructor arguments come from the caller (`@hive/treasury`).
 *
 * A payment's approvals name the treasury's counter units, so submitting the same payment twice,
 * or after the treasury moved on, is refused by the covenant: a lost answer is retried safely.
 */

export type TreasuryContract = InstanceType<typeof arkade.ArkadeContract>;
export type TreasuryClient = Awaited<ReturnType<typeof Arkade.connect>>;

/** A treasury coin as the indexer returns it, with the assets it carries. */
export type TreasuryCoin = Pick<VirtualCoin, "txid" | "vout" | "value"> & {
  assets?: { assetId: string; amount: number | bigint }[];
  isSpent?: boolean;
  isSwept?: boolean;
};

/** One keeper's approval as the covenant takes it, or null for a keeper who did not approve. */
export interface CovenantApproval {
  sig: Uint8Array;
  time: Uint8Array;
  tags: Uint8Array;
}

const NETWORKS = {
  regtest: networks.regtest,
  mutinynet: networks.mutinynet,
  bitcoin: networks.bitcoin,
} as const;

export async function treasuryClient(deployment: {
  network: keyof typeof NETWORKS;
  arkdUrl: string;
  emulatorUrl: string;
}): Promise<TreasuryClient> {
  return Arkade.connect({
    service: { operatorUrl: deployment.arkdUrl, emulatorUrl: deployment.emulatorUrl },
    storage: { contractRepository: new InMemoryContractRepository() },
    network: NETWORKS[deployment.network],
  } as never);
}

export function treasuryContract(
  client: TreasuryClient,
  artifact: unknown,
  args: Record<string, Uint8Array | bigint>,
): TreasuryContract {
  return client.contract(arkade.programFromArtifact(artifact as never), args);
}

/** The counter units on a coin: how many payments the treasury can still make. */
export function unitsOn(coin: Pick<TreasuryCoin, "assets">, assetId: string): bigint {
  const a = (coin.assets ?? []).find((x) => x.assetId === assetId);
  return a ? BigInt(a.amount) : 0n;
}

/**
 * The treasury's unspent coins: the one that holds the counter, and the others to merge into it.
 * `held` lists every coin holding counter units, which is one coin unless something is wrong.
 */
export async function treasuryCoins(contract: TreasuryContract, assetId: string) {
  const coins = ((await contract.getUtxos()) as TreasuryCoin[]).filter((c) => !c.isSpent && !c.isSwept);
  const held = coins.filter((c) => unitsOn(c, assetId) > 0n);
  return {
    treasury: held.length === 1 ? held[0]! : undefined,
    others: coins.filter((c) => unitsOn(c, assetId) === 0n),
    held,
  };
}

const p2tr = (program: Uint8Array) => new Uint8Array([0x51, 0x20, ...program]);
const empty = new Uint8Array(0);

// biome-ignore lint/suspicious/noExplicitAny: the SDK types each function's arguments from the artifact at runtime
const fn = (contract: TreasuryContract, name: string) => (contract.functions as any)[name];

/**
 * Pays `amount` sats to the Taproot `program` from the treasury coin, with one approval per keeper.
 * The change stays in the treasury with one counter unit less.
 */
export async function payFromTreasury(
  contract: TreasuryContract,
  coin: TreasuryCoin,
  assetId: string,
  payment: { amount: bigint; program: Uint8Array; validUntil: number },
  approvals: readonly (CovenantApproval | null)[],
): Promise<{ txid: string }> {
  const left = unitsOn(coin, assetId);
  if (left < 2n) throw new Error("the treasury's counter is spent");
  const pick = (f: keyof CovenantApproval) => approvals.map((a) => a?.[f] ?? empty);
  const sent = await fn(contract, "pay")(
    payment.amount,
    { program: payment.program, version: 1n },
    BigInt(payment.validUntil),
    pick("sig"),
    pick("time"),
    pick("tags"),
  )
    .from(coin)
    .to(contract.pkScript, BigInt(coin.value) - payment.amount)
    .to(p2tr(payment.program), payment.amount)
    .withAsset({ assetId, inputs: [{ vin: 0, amount: left }], outputs: [{ vout: 0, amount: left - 1n }] })
    .send();
  return { txid: sent.txid };
}

/** Folds `other` into the treasury coin; nobody signs, and the counter stays on the treasury coin. */
export async function mergeIntoTreasury(
  contract: TreasuryContract,
  coin: TreasuryCoin,
  other: TreasuryCoin,
  assetId: string,
): Promise<{ txid: string }> {
  const units = unitsOn(coin, assetId);
  const sent = await fn(contract, "merge")()
    .from([coin, other])
    .to(contract.pkScript, BigInt(coin.value + other.value))
    .withAsset({ assetId, inputs: [{ vin: 0, amount: units }], outputs: [{ vout: 0, amount: units }] })
    .send();
  return { txid: sent.txid };
}
