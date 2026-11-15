/**
 * The v5 treasury on a host: the counter the host issues for each hive, the delegatee's renewal watch,
 * and the handle the approvals desk spends through.
 *
 * A v5 treasury is named by its counter asset, so the counter exists before the treasury's address
 * does. The host issues it from a small wallet of its own, the issuer, which holds only the host's
 * sats, and sends the whole supply to the treasury with a 330-sat carrier in the same transaction.
 * Once the treasury holds every unit, nothing outside it can stand in for its counter: the host's
 * part ends there. The issuer's key is the one key a host keeps for v5 hives, and it moves only the
 * host's own dust.
 */
import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk-0.5.6";
import {
  type Artifact,
  arkAddress,
  type Connection,
  type Deployment,
  type Instance,
  instantiate,
  verifyWatch,
} from "@hive/ark";
import {
  type TreasuryClient,
  type TreasuryContract,
  treasuryClient,
  treasuryCoins,
  treasuryContract,
  unitsOn,
} from "@hive/executor";
import { ensure, fail, hex, readPrivateJson, secretPath, stateExists, writePrivateOnce } from "@hive/kit";
import {
  type Counter,
  type Keeper,
  sdkArguments,
  TREASURY_ARTIFACT,
  type TreasuryTerms,
  treasuryArguments,
} from "@hive/treasury";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/** Payments a treasury can make: one counter unit each, and the last unit never leaves. */
export const COUNTER_SUPPLY = 1_000_000n;
/** The sats the issuer sends with the counter: the treasury coin's own carrier, above dust after a renewal's fee. */
export const CARRIER_SATS = 1_000;

/** What a hive's record keeps of its v5 treasury. */
export interface PasskeyTreasury {
  version: 5;
  keepers: [Keeper, Keeper, Keeper];
  counter: Counter;
  supply: string;
  delegateKey: string;
  renewalWindowSeconds: number;
  maxFeeSats: number;
  exitDelaySeconds: number;
  /** The issuer's transaction that sent the whole supply to the treasury. */
  fundedTxid: string;
}

export const v5Terms = (p: Omit<PasskeyTreasury, "version" | "supply" | "fundedTxid">): TreasuryTerms => ({
  keepers: p.keepers,
  counter: p.counter,
  delegateKey: p.delegateKey,
  renewalWindowSeconds: p.renewalWindowSeconds,
  maxFeeSats: p.maxFeeSats,
  exitDelaySeconds: p.exitDelaySeconds,
});

export const V5_ARTIFACT = TREASURY_ARTIFACT as unknown as Artifact;

/** The treasury these terms build on this Operator, derived here. */
export function v5Instance(conn: Pick<Connection, "deployment" | "keys">, terms: TreasuryTerms) {
  const instance = instantiate(V5_ARTIFACT, treasuryArguments(terms), conn.keys);
  return {
    instance,
    pkScript: instance.pkScript,
    address: arkAddress(conn.deployment.network, conn.keys.server, instance.pkScript),
  };
}

/**
 * The delegatee's renewal watch for a v5 treasury: v4's, with the treasury's own constructor values,
 * and the counter carried into the renewed coin.
 */
export function v5RenewalTemplate(artifactId: string, terms: TreasuryTerms): Record<string, unknown> {
  ensure(/^[0-9a-f]{64}$/.test(artifactId), "INVALID", "artifact id");
  return {
    format: "delegateed-template/v1",
    type: "intent",
    inputs: [
      {
        name: "funds",
        schedule: { before_expiry_seconds: terms.renewalWindowSeconds },
        contract: { definition: { artifact: artifactId }, arguments: treasuryArguments(terms) },
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
    fees: { from: "funds", max: terms.maxFeeSats },
    packets: { output_index: 1 },
  };
}

/**
 * The artifact as the delegatee reads it. The delegatee only renews, and it takes scalar witness
 * inputs only, so `pay`'s witness is declared as the scalar items it flattens to: the recipient's
 * program and version, and one item per keeper. The scripts, and so the address, are unchanged,
 * which the watch's leaf-for-leaf check confirms.
 */
export function delegateeArtifact(): Record<string, unknown> {
  type Input = { name: string; type: string };
  const flatten = (i: Input): Input[] => {
    if (i.type === "ScriptPubKey")
      return [
        { name: `${i.name}_program`, type: "bytes" },
        { name: `${i.name}_version`, type: "int" },
      ];
    const array = /^(\w+)\[(\d+)\]$/.exec(i.type);
    if (array)
      return Array.from({ length: Number(array[2]) }, (_, n) => ({
        name: `${i.name}_${n}`,
        type: array[1]!,
      }));
    return [i];
  };
  const a = structuredClone(TREASURY_ARTIFACT) as unknown as {
    functions: { arkade?: { inputs: Input[] } }[];
  };
  for (const f of a.functions) if (f.arkade) f.arkade.inputs = f.arkade.inputs.flatMap(flatten);
  return a as unknown as Record<string, unknown>;
}

/** Registers the treasury and its renewal watch with the delegatee, checked leaf for leaf. */
export async function v5Account(
  conn: Connection,
  terms: TreasuryTerms,
): Promise<{
  instance: Instance;
  pkScript: string;
  address: string;
  artifactId: string;
  watch: { templateId: string; delegationId: string };
}> {
  const derived = v5Instance(conn, terms);
  const artifactId = await conn.delegatee.registerArtifact(delegateeArtifact());
  const templateId = await conn.delegatee.registerTemplate(v5RenewalTemplate(artifactId, terms));
  const delegation = await conn.delegatee.watch(templateId, {});
  verifyWatch(derived.instance, delegation, derived.address, { templateId });
  return { ...derived, artifactId, watch: { templateId, delegationId: delegation.id } };
}

/** Where the host's Emulator is: a v5 treasury's payments are executed here, through it. */
export function emulatorOf(deployment: Deployment): string {
  const url = deployment.emulatorUrl ?? process.env.BUZZ_EMULATOR_URL;
  if (!url) fail("NO_EMULATOR", "a v5 treasury needs the Emulator's address: set BUZZ_EMULATOR_URL");
  return url;
}

/**
 * The Emulator the treasury's payments go through must be the one its covenants commit to: on mainnet
 * the pinned key, which the deployment's connection already holds the delegatee to.
 */
export async function checkEmulator(deployment: Deployment, expectedKey: string): Promise<void> {
  const res = await fetch(`${emulatorOf(deployment)}/v1/info`, { signal: AbortSignal.timeout(10_000) });
  ensure(res.ok, "EMULATOR", String(res.status));
  const { signerPubkey } = (await res.json()) as { signerPubkey?: string };
  ensure(
    signerPubkey === expectedKey,
    "EMULATOR_KEY_MISMATCH",
    "the Emulator is not the one the treasury names",
  );
}

/** The SDK's view of the treasury, for the desk's payments and merges. */
export async function v5Contract(
  deployment: Deployment,
  terms: TreasuryTerms,
): Promise<{ client: TreasuryClient; contract: TreasuryContract }> {
  const client = await treasuryClient({
    network: deployment.network,
    arkdUrl: deployment.arkdUrl,
    emulatorUrl: emulatorOf(deployment),
  });
  return { client, contract: treasuryContract(client, TREASURY_ARTIFACT, sdkArguments(terms)) };
}

/** The host's issuer wallet on this network, its key made once and kept with the host's secrets. */
export async function issuerWallet(deployment: Deployment) {
  const path = secretPath("issuer", `${deployment.network}.json`);
  const { secretKey } = stateExists(path)
    ? readPrivateJson<{ secretKey: string }>(path)
    : writePrivateOnce(path, { secretKey: hex(secp256k1.utils.randomSecretKey()) });
  return Wallet.create({
    identity: SingleKey.fromHex(secretKey),
    service: { operatorUrl: deployment.arkdUrl, emulatorUrl: emulatorOf(deployment) },
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlement: false,
  } as never);
}

/** Issues a hive's counter from the host's issuer: a fixed supply and no control asset. */
export async function issueCounter(deployment: Deployment): Promise<{ assetId: string; supply: bigint }> {
  const wallet = await issuerWallet(deployment);
  const { available } = await wallet.getBalance();
  if (available < 2 * CARRIER_SATS)
    fail(
      "ISSUER_UNFUNDED",
      `the host's issuer has ${available} sats; send it a few thousand at ${await wallet.getAddress()}`,
    );
  const { assetId } = await wallet.assetManager.issue({ amount: COUNTER_SUPPLY } as never);
  return { assetId, supply: COUNTER_SUPPLY };
}

/** Sends the whole counter, with its carrier, from the issuer to the treasury. */
export async function fundWithCounter(deployment: Deployment, address: string, counter: Counter) {
  const wallet = await issuerWallet(deployment);
  return wallet.send({
    recipients: [
      { address, amount: CARRIER_SATS, assets: [{ assetId: counter.assetId, amount: COUNTER_SUPPLY }] },
    ],
  } as never) as Promise<string>;
}

/**
 * Waits until the treasury holds the counter: one coin with the whole supply, and no unit anywhere
 * else on the treasury's script.
 */
export async function counterHome(contract: TreasuryContract, counter: Counter, seconds = 60): Promise<void> {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const { held } = await treasuryCoins(contract, counter.assetId).catch(() => ({ held: [] }));
    if (held.length === 1 && unitsOn(held[0]!, counter.assetId) === COUNTER_SUPPLY) return;
    ensure(held.length <= 1, "COUNTER_SPLIT", "the counter sits on more than one coin");
    if (Date.now() > end) fail("COUNTER_MISSING", "the treasury does not hold its whole counter");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
