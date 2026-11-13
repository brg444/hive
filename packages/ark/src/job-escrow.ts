import { ensure, hex, unhex } from "@hive/kit";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as musig2 from "@scure/btc-signer/musig2.js";
import jobEscrowJson from "../../../hive/pay-arkade/contracts/job_escrow.artifact.json" with { type: "json" };
import { type Artifact, type Instance, instantiate } from "./contract.js";
import { scriptNum, sequence } from "./encoding.js";
import { arkAddress, type Network } from "./taproot.js";

/**
 * The pay-arkade job escrow, derived here from its terms with the same artifact the MeshLLM plugin
 * uses, so a keeper can check a funding request without trusting whoever sent it: the address must
 * be the escrow these terms build, which returns every unclaimed sat to this hive's treasury.
 */
export interface JobEscrowParams {
  /** x-only, hex: the hive's agent, which signs receipts. */
  agentPk: string;
  /** x-only, hex: the provider, which claims. */
  providerPk: string;
  /** The treasury's 32-byte taproot program, hex. */
  treasuryProgram: string;
  /** Unix seconds. */
  deadline: number;
  jobId: string;
  renewalWindow?: number;
  maxRenewalFee?: number;
  /** x-only key of the delegate service that renews the escrow; none when absent. */
  delegatePk?: string;
}

/** The renewal terms both plugins assume when a job states none: the escrow's address depends on them. */
export const JOB_ESCROW_RENEWAL_DEFAULTS: Record<Network, { renewalWindow: number; maxRenewalFee: number }> =
  {
    bitcoin: { renewalWindow: 2 * 86_400, maxRenewalFee: 100 },
    mutinynet: { renewalWindow: 86_400, maxRenewalFee: 100 },
    regtest: { renewalWindow: 90, maxRenewalFee: 100 },
  };

/** BIP341's unspendable point: the delegate path of an escrow that names no delegate service. */
export const NO_DELEGATE = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

/** The plugin's artifact, its keys read as the 32-byte x-only values the plugin pushes. */
const ARTIFACT: Artifact = {
  ...(jobEscrowJson as unknown as Artifact),
  constructorInputs: (jobEscrowJson as unknown as Artifact).constructorInputs.map((input) =>
    input.type === "pubkey" ? { ...input, type: "bytes32" } : input,
  ),
};

const XONLY = /^[0-9a-f]{64}$/;

/** The agent and the provider as one MuSig2 key, x-only: each x-only key lifted to its even-y point. */
export function jobEscrowOwners(agentPk: string, providerPk: string): string {
  const lift = (x: string) => {
    const point = unhex(`02${x}`);
    secp256k1.Point.fromHex(hex(point));
    return point;
  };
  return hex(musig2.keyAggExport(musig2.keyAggregate(musig2.sortKeys([lift(agentPk), lift(providerPk)]))));
}

/** The escrow these terms build on this deployment: its leaves, script and Ark address. */
export function jobEscrow(
  conn: {
    deployment: { network: Network };
    keys: { server: string; emulator: string };
    operator: { unilateralExitDelay: number };
  },
  params: JobEscrowParams,
): Instance & { address: string; renewalWindow: number; maxRenewalFee: number } {
  const keys = {
    agentPk: params.agentPk,
    providerPk: params.providerPk,
    delegatePk: params.delegatePk ?? NO_DELEGATE,
  };
  for (const [name, value] of Object.entries(keys))
    ensure(XONLY.test(value), "JOB_ESCROW_INVALID", `${name} must be a 32-byte x-only key`);
  ensure(XONLY.test(params.treasuryProgram), "JOB_ESCROW_INVALID", "treasuryProgram");
  ensure(XONLY.test(params.jobId), "JOB_ESCROW_INVALID", "jobId");
  ensure(Number.isSafeInteger(params.deadline) && params.deadline > 0, "JOB_ESCROW_INVALID", "deadline");
  const defaults = JOB_ESCROW_RENEWAL_DEFAULTS[conn.deployment.network];
  const renewalWindow = params.renewalWindow ?? defaults.renewalWindow;
  const maxRenewalFee = params.maxRenewalFee ?? defaults.maxRenewalFee;
  ensure(
    Number.isSafeInteger(renewalWindow) &&
      renewalWindow >= 0 &&
      Number.isSafeInteger(maxRenewalFee) &&
      maxRenewalFee >= 0,
    "JOB_ESCROW_INVALID",
    "renewal terms",
  );
  const int = (n: number) => hex(scriptNum(n));
  const instance = instantiate(
    ARTIFACT,
    {
      agentPk: keys.agentPk,
      providerPk: keys.providerPk,
      treasuryProgram: params.treasuryProgram,
      deadline: int(params.deadline),
      jobId: params.jobId,
      renewalWindow: int(renewalWindow),
      maxRenewalFee: int(maxRenewalFee),
      exitDelay: int(sequence(conn.operator.unilateralExitDelay)),
      delegatePk: keys.delegatePk,
      ownersPk: jobEscrowOwners(keys.agentPk, keys.providerPk),
    },
    // The escrow names its own delegate key; the service key slot is never read.
    { server: conn.keys.server, emulator: conn.keys.emulator, delegate: conn.keys.server },
  );
  return {
    ...instance,
    address: arkAddress(conn.deployment.network, conn.keys.server, instance.pkScript),
    renewalWindow,
    maxRenewalFee,
  };
}
