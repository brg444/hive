// The job escrow on Arkade: its address, its coins, and the two spends a plugin makes.
import { hex } from "@scure/base";
import {
    ArkAddress,
    arkade,
    DefaultVtxo,
    networks,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    SingleKey,
    type NetworkName,
} from "@arkade-os/sdk";
import artifact from "../../contracts/job_escrow.artifact.json" with { type: "json" };
import { hexBytes } from "./signing.ts";
import { ownersKey } from "./musig.ts";

/** The escrow's constructor, as the plugins exchange it. All keys and hashes are hex. */
export interface EscrowParams {
    agentPk: string; // 32-byte x-only: signs receipts
    providerPk: string; // 32-byte x-only: signs the claim
    treasuryProgram: string; // 32-byte taproot program of the treasury's address
    deadline: number; // unix seconds, on the emulator clock
    jobId: string; // 32 bytes, unique per job
    renewalWindow?: number; // seconds before batch expiry the executor may renew; network default if absent
    maxRenewalFee?: number; // sats a renewal may take; network default if absent
    delegatePk?: string; // x-only key of the delegate service that renews the escrow; none if absent
}

/** BIP341's unspendable point: the escrow's delegate path when a job names no delegate service. */
export const NO_DELEGATE = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

/**
 * Renewal terms both sides derive the same way when a job does not state them: the escrow's address
 * depends on them. Mainnet charges nothing to renew a coin close to its expiry, so the fee cap is a
 * margin, never the expected cost.
 */
export const RENEWAL_DEFAULTS: Record<string, { renewalWindow: number; maxRenewalFee: number }> = {
    bitcoin: { renewalWindow: 2 * 86_400, maxRenewalFee: 100 },
    mutinynet: { renewalWindow: 86_400, maxRenewalFee: 100 },
    regtest: { renewalWindow: 90, maxRenewalFee: 100 },
};

/** BIP68 sequence for a relative delay given as arkd states it: blocks below 512, else seconds. */
export function bip68(delay: number): bigint {
    return delay < 512 ? BigInt(delay) : (1n << 22n) | BigInt(delay >> 9);
}

/** The smallest output arkd accepts; the contract leaves a remainder at or below it unpinned. */
export const DUST = 330n;

export interface WorkerConfig {
    operatorUrl: string;
    emulatorUrl: string;
    network: NetworkName;
    identity: SingleKey;
}

export class Escrow {
    private constructor(
        readonly client: arkade.Arkade,
        readonly indexer: RestIndexerProvider,
        readonly identity: SingleKey,
        readonly network: NetworkName,
    ) {}

    static async connect(config: WorkerConfig): Promise<Escrow> {
        const indexer = new RestIndexerProvider(config.operatorUrl);
        const client = await arkade.Arkade.connect({
            arkade: new RestArkProvider(config.operatorUrl),
            emulator: new RestEmulatorProvider(config.emulatorUrl),
            indexer,
            network: networks[config.network],
            identity: config.identity,
        });
        return new Escrow(client, indexer, config.identity, config.network);
    }

    /** This key's own default Arkade address: where a provider is paid, or a treasury receives. */
    async own() {
        const pubKey = await this.identity.xOnlyPublicKey();
        const script = this.defaultScript(pubKey);
        return {
            pubkey: hex.encode(pubKey),
            address: script.address(networks[this.network].hrp, this.client.serverKey).encode(),
            pkScript: hex.encode(script.pkScript),
            program: hex.encode(script.tweakedPublicKey),
        };
    }

    contract(params: EscrowParams) {
        const program = arkade.programFromArtifact(artifact);
        const renewal = this.renewal(params);
        return this.client.contract(program, {
            agentPk: hexBytes(params.agentPk, 32, "agentPk"),
            providerPk: hexBytes(params.providerPk, 32, "providerPk"),
            treasuryProgram: hexBytes(params.treasuryProgram, 32, "treasuryProgram"),
            deadline: BigInt(params.deadline),
            jobId: hexBytes(params.jobId, 32, "jobId"),
            renewalWindow: BigInt(renewal.renewalWindow),
            maxRenewalFee: BigInt(renewal.maxRenewalFee),
            exitDelay: this.exitDelay(),
            delegatePk: hexBytes(params.delegatePk ?? NO_DELEGATE, 32, "delegatePk"),
            ownersPk: ownersKey(params.agentPk, params.providerPk).xonly,
        });
    }

    /** The renewal terms of a job: its own, or the network's defaults. */
    renewal(params: EscrowParams) {
        const d = RENEWAL_DEFAULTS[this.network] ?? RENEWAL_DEFAULTS.regtest;
        return { renewalWindow: params.renewalWindow ?? d.renewalWindow, maxRenewalFee: params.maxRenewalFee ?? d.maxRenewalFee };
    }

    /** The Arkade server's unilateral exit delay as the escrow's exit leaf states it. */
    exitDelay(): bigint {
        return bip68(Number(this.client.serverExitDelay));
    }

    address(params: EscrowParams) {
        const contract = this.contract(params);
        return { address: contract.address, pkScript: hex.encode(contract.pkScript) };
    }

    /** Coins at the escrow's address. A job is funded by exactly one; a second is an error. */
    async status(params: EscrowParams) {
        const { pkScript } = this.contract(params);
        const { vtxos } = await this.indexer.getVtxos({ scripts: [hex.encode(pkScript)] });
        const coins = vtxos.map((v) => ({
            txid: v.txid,
            vout: v.vout,
            value: v.value,
            spent: Boolean(v.isSpent),
            // When the operator sweeps this coin's batch: a time on mainnet, a block height on regtest.
            expiresAt: v.expiresAt ? Math.floor(new Date(v.expiresAt).getTime() / 1000) : null,
            expiresAtHeight: v.expiresAtHeight ?? null,
        }));
        const open = coins.filter((c) => !c.spent);
        const times = open.map((c) => c.expiresAt).filter((t): t is number => t !== null);
        return {
            coins,
            open: open.length,
            lockedSats: open.reduce((n, c) => n + c.value, 0),
            // The soonest expiry among unspent coins; null when none states a time.
            expiresAt: times.length ? Math.min(...times) : null,
        };
    }

    /**
     * The provider closes the job with the agent's latest receipt. The treasury's share goes to the
     * treasury's address; the provider's share goes to its own address unless another is named.
     */
    async claim(params: EscrowParams, amountSats: bigint, agentSig: Uint8Array, payoutPkScript?: string) {
        const providerPk = hex.encode(await this.identity.xOnlyPublicKey());
        if (providerPk !== params.providerPk.toLowerCase()) throw new Error("this worker's key is not the job's provider key");
        const contract = this.contract(params);
        const coin = await this.onlyCoin(contract.pkScript);
        const locked = BigInt(coin.value);
        if (amountSats < DUST) throw new Error("amount below dust; let the job expire");
        // Renewal fees can leave less locked than the receipt owes: the provider then takes it all.
        const rest = amountSats >= locked ? 0n : locked - amountSats;
        const payout = payoutPkScript ? hex.decode(payoutPkScript) : hex.decode((await this.own()).pkScript);
        const treasury = treasuryPkScript(params.treasuryProgram);
        let spend = contract.functions.claim(amountSats, agentSig).from(coin);
        // A remainder at or below dust cannot be its own output: the provider takes the coin whole.
        spend = rest > DUST ? spend.to(treasury, rest).to(payout, amountSats) : spend.to(payout, locked);
        const { txid } = await spend.send();
        return { txid, paidSats: Number(rest > DUST ? amountSats : locked), returnedSats: Number(rest > DUST ? rest : 0n) };
    }

    /** An Arkade address on this operator, as the program and script an escrow pays it with. */
    addressInfo(address: string) {
        const decoded = ArkAddress.decode(address);
        if (hex.encode(decoded.serverPubKey) !== hex.encode(this.serverXOnly())) {
            throw new Error("address belongs to another Arkade operator");
        }
        const program = hex.encode(decoded.vtxoTaprootKey);
        return { program, pkScript: hex.encode(treasuryPkScript(program)) };
    }

    /** Is this the operator and emulator we think, and can the escrow's spends go through as built? */
    async preflight(operatorUrl: string, emulatorUrl: string) {
        const operator = await (await fetch(`${operatorUrl}/v1/info`)).json();
        const emulator = await (await fetch(`${emulatorUrl}/v1/info`)).json();
        const problems: string[] = [];
        if (operator.network !== this.network) problems.push(`operator is on ${operator.network}, worker on ${this.network}`);
        // Claims and expiries pay every sat out; a fee on offchain spends would have to come from somewhere.
        if (String(operator.fees?.txFeeRate ?? "0") !== "0") problems.push(`offchain tx fee rate is ${operator.fees.txFeeRate}`);
        if (!this.client.emulatorKey || hex.encode(this.client.emulatorKey).slice(-64) !== String(emulator.signerPubkey).slice(-64)) {
            problems.push("emulator key does not match the SDK's view of it");
        }
        return {
            ok: problems.length === 0,
            problems,
            operator: { version: operator.version, network: operator.network, dust: operator.dust, txFeeRate: operator.fees?.txFeeRate },
            emulator: { signerPubkey: emulator.signerPubkey, version: emulator.version ?? null },
        };
    }

    private serverXOnly(): Uint8Array {
        const key = this.client.serverKey;
        return key.length === 33 ? key.slice(1) : key;
    }

    /** After the deadline anyone may return an unclaimed escrow whole to the treasury. */
    async expire(params: EscrowParams) {
        const contract = this.contract(params);
        const coin = await this.onlyCoin(contract.pkScript);
        const { txid } = await contract.functions
            .expire()
            .from(coin)
            .to(treasuryPkScript(params.treasuryProgram), BigInt(coin.value))
            .send();
        return { txid, returnedSats: coin.value };
    }

    async onlyCoin(pkScript: Uint8Array) {
        const { vtxos } = await this.indexer.getVtxos({ scripts: [hex.encode(pkScript)], spendableOnly: true });
        if (vtxos.length === 0) throw new Error("escrow holds no coin");
        if (vtxos.length > 1) throw new Error("escrow holds more than one coin; a job is funded once");
        return vtxos[0];
    }

    private defaultScript(pubKey: Uint8Array) {
        const delay = Number(this.client.serverExitDelay);
        return new DefaultVtxo.Script({
            pubKey,
            serverPubKey: this.client.serverKey,
            csvTimelock: { type: delay < 512 ? "blocks" : "seconds", value: BigInt(delay) },
        });
    }
}

/** A version-1 witness program as the script an output pays: OP_1, push 32, program. */
export function treasuryPkScript(program: string): Uint8Array {
    const bytes = hexBytes(program, 32, "treasuryProgram");
    const out = new Uint8Array(34);
    out[0] = 0x51;
    out[1] = 0x20;
    out.set(bytes, 2);
    return out;
}
