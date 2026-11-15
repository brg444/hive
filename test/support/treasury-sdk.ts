import { execFileSync } from "node:child_process";
import {
  arkade,
  Batch,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  SingleKey,
  Wallet,
  createAssetPacket,
  EmulatorPacket,
  Estimator,
  Extension,
  Proof,
  TreeSignerSession,
  toOffchainInputFeeParams,
  withPrevTxs,
} from "@arkade-os/sdk-0.5.6";
import type { TreasuryClient, TreasuryCoin, TreasuryContract } from "@hive/executor";
import { hex as hexOf } from "@hive/kit";
import { RawWitness } from "@scure/btc-signer";

/**
 * Renews the treasury coin into a new batch as the host's delegatee does: the delegate key cosigns
 * the batch's tree, and the treasury pays the operator's intent fee, up to `maxFee` sats. On a
 * host the delegatee does this from its template; this is the same intent, for a regtest stack.
 */
export async function renewAsDelegatee(
  client: TreasuryClient,
  contract: TreasuryContract,
  coin: TreasuryCoin,
  options: { delegate: Uint8Array; maxFee: number; signal?: AbortSignal },
) {
  // biome-ignore lint/suspicious/noExplicitAny: the client's providers are not part of its public type
  const { emulator, indexer, network, arkProvider } = client as any;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  const c = contract as any;
  const compiled = c.vtxoScript.functionByName("renew");
  const stack = (compiled.def.arkadeScript.witness ?? []).map((r: unknown) =>
    arkade.witnessRefToBytes(r as never, {}, c.args),
  );
  const { fees } = await arkProvider.getInfo();
  const fee = new Estimator(fees?.intentFee ?? {}).evaluate(
    [toOffchainInputFeeParams({ ...coin, isSwept: coin.isSwept ?? false } as never)],
    [],
    [{ amount: BigInt(coin.value), script: hexOf(contract.pkScript) }],
    [],
  ).satoshis;
  if (fee > options.maxFee)
    throw new Error(`the operator charges ${fee} sats to renew, above ${options.maxFee}`);
  const [prepared] = await withPrevTxs(
    [
      {
        ...coin,
        tapTree: c.tapTree,
        forfeitTapLeafScript: compiled.tapLeafScript,
        proofTapLeafScript: compiled.tapLeafScript,
      } as never,
    ],
    indexer,
  );
  const recipients = [
    {
      address: contract.address,
      amount: coin.value - fee,
      ...(coin.assets?.length ? { assets: coin.assets } : {}),
    },
  ];
  const packets = [];
  if (coin.assets?.length)
    packets.push(createAssetPacket(new Map([[1, coin.assets as never]]), recipients as never));
  packets.push(
    EmulatorPacket.create([{ vin: 1, script: compiled.arkadeScript, witness: RawWitness.encode(stack) }]),
  );
  // A fresh session, so fresh nonces, under the delegate's standing key.
  const session = new TreeSignerSession(options.delegate);
  const sessionKey = hexOf(await session.getPublicKey());
  const message = {
    type: "register" as const,
    onchain_output_indexes: [],
    valid_at: 0,
    expire_at: 0,
    cosigners_public_keys: [sessionKey],
  };
  const outputs = [
    { script: contract.pkScript, amount: BigInt(coin.value - fee) },
    Extension.create(packets).txOut(),
  ];
  // Only a registration passes the covenant, so an intent that fails is left to lapse, not deleted.
  const proof = await emulator.submitIntent({
    proof: Buffer.from(Proof.create(message, [prepared!], outputs).toPSBT()).toString("base64"),
    message,
  });
  const abort = new AbortController();
  options.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  try {
    const events = Batch.prime(
      arkProvider.getEventStream(abort.signal, [sessionKey, `${coin.txid}:${coin.vout}`]),
    );
    const intentId = await arkProvider.registerIntent({ proof, message });
    const handler = arkade.createArkadeBatchHandler(
      intentId,
      [{ ...(prepared as unknown as object), arkadeScriptBytes: compiled.arkadeScript } as never],
      undefined,
      proof,
      message as never,
      session,
      arkProvider,
      emulator,
      network,
      recipients as never,
    );
    const commitmentTxid = await Batch.join(events, handler, { abortController: abort });
    return { commitmentTxid, intentId, fee };
  } finally {
    abort.abort();
  }
}

/** A fresh SDK wallet on the stack: the host's issuer in a test, a member, a recipient. */
export const newWallet = (arkdUrl: string, emulatorUrl: string) =>
  Wallet.create({
    identity: SingleKey.fromRandomBytes(),
    service: { operatorUrl: arkdUrl, emulatorUrl },
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlement: false,
  } as never);

/**
 * Sends from the regtest stack's own wallet (the `ark` client in the `arkd` container). It settles
 * first, since a regtest stack's batches expire within hours. With HIVE_REGTEST_CLI naming the
 * stack's CLI (ArkLabsHQ's arkade-regtest `regtest.mjs`), a block then confirms what the Operator
 * broadcast; a stack that mines on its own needs none.
 */
export function sendOffchain(address: string, sats: number) {
  const ark = (...args: string[]) =>
    execFileSync("docker", ["exec", "arkd", "ark", ...args, "--password", "secret"], { encoding: "utf8" });
  ark("settle");
  ark("send", "--to", address, "--amount", String(sats));
  if (process.env.HIVE_REGTEST_CLI)
    execFileSync("node", [process.env.HIVE_REGTEST_CLI, "mine", "1"], { stdio: "ignore" });
}

export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined | false> | T | undefined | false,
  seconds = 60,
): Promise<T> {
  const end = Date.now() + seconds * 1000;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}
