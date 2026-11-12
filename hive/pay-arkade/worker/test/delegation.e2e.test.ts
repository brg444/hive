// A job escrow renewed by the delegate service the Arkade wallet uses, from a renewal the hive agent
// and the provider presign together. Needs the regtest stack's delegate profile (DELEGATE_URL,
// default http://localhost:7012); coins there expire within minutes.
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { RestIndexerProvider, SingleKey } from "@arkade-os/sdk";
import { Escrow, type EscrowParams } from "../src/escrow.ts";
import { cosignRenewal, delegateInfo, finishRenewal, prepareRenewal, submitRenewal } from "../src/delegation.ts";
import { signReceipt } from "../src/signing.ts";

const OPERATOR_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";
const DELEGATE_URL = process.env.DELEGATE_URL ?? "http://localhost:7012";
const CAP = 20_000;

const connect = (identity: SingleKey) => Escrow.connect({ operatorUrl: OPERATOR_URL, emulatorUrl: EMULATOR_URL, network: "regtest", identity });

describe("job escrow delegated renewal", () => {
    it("is renewed into the same escrow by the delegate service from a renewal both parties signed", async () => {
        const agentSecret = schnorr.utils.randomSecretKey();
        const agentKey = SingleKey.fromPrivateKey(agentSecret);
        const providerSecret = schnorr.utils.randomSecretKey();
        const providerKey = SingleKey.fromPrivateKey(providerSecret);
        const agent = await connect(agentKey);
        const provider = await connect(providerKey);
        const treasury = await (await connect(SingleKey.fromRandomBytes())).own();
        const delegate = await delegateInfo(DELEGATE_URL);
        const params: EscrowParams = {
            agentPk: hex.encode(await agentKey.xOnlyPublicKey()),
            providerPk: hex.encode(await providerKey.xOnlyPublicKey()),
            treasuryProgram: treasury.program,
            deadline: Math.floor(Date.now() / 1000) + 3_600,
            jobId: hex.encode(crypto.getRandomValues(new Uint8Array(32))),
            delegatePk: delegate.xonly,
        };
        const { address, pkScript } = provider.address(params);
        expect(agent.address(params).address).toBe(address);

        faucetOffchain(address, CAP);
        const indexer = new RestIndexerProvider(OPERATOR_URL);
        const first = await waitFor(async () => (await live(indexer, pkScript))[0]);
        console.log(`funded ${first.txid}:${first.vout}, expires ${expiryOf(first)}`);

        // The provider opens the renewal; the agent checks it and answers with its share of each signature.
        const request = await prepareRenewal(provider, params, OPERATOR_URL, delegate, providerSecret);
        // The agent refuses a renewal timed or cosigned other than the job says.
        const tampered = { ...request, message: { ...request.message, cosigners_public_keys: ["02" + "11".repeat(32)] } };
        await expect(cosignRenewal(agent, params, OPERATOR_URL, delegate, tampered, agentSecret)).rejects.toThrow(/another cosigner/);
        const answer = await cosignRenewal(agent, params, OPERATOR_URL, delegate, request, agentSecret);
        const signed = finishRenewal(params, answer, providerSecret);
        const { validAt } = await submitRenewal(DELEGATE_URL, signed);
        console.log(`renewal scheduled at ${validAt}`);

        const renewed = await waitFor(
            async () => (await live(indexer, pkScript)).find((v) => v.txid !== first.txid),
            Math.max(240, expiryOf(first) - Math.floor(Date.now() / 1000) + 180),
        );
        console.log(`renewed into ${renewed.txid}:${renewed.vout}, expires ${expiryOf(renewed)}, value ${renewed.value}`);
        expect(renewed.value).toBeGreaterThanOrEqual(CAP - provider.renewal(params).maxRenewalFee);
        expect(expiryOf(renewed)).toBeGreaterThan(expiryOf(first));

        // The renewed coin is the same escrow: the provider claims it with the agent's receipt.
        const owed = 12_000n;
        const claimed = await provider.claim(params, owed, signReceipt(agentSecret, hex.decode(params.jobId), owed));
        console.log(`claimed after renewal: ${JSON.stringify(claimed)}`);
        expect(claimed.paidSats).toBe(12_000);
    }, 900_000);
});

async function live(indexer: RestIndexerProvider, pkScript: string) {
    const { vtxos } = await indexer.getVtxos({ scripts: [pkScript], spendableOnly: true });
    return vtxos;
}

function expiryOf(v: { expiresAt?: unknown }) {
    return v.expiresAt ? Math.floor(new Date(v.expiresAt as string).getTime() / 1000) : 0;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, seconds = 60): Promise<T> {
    for (let i = 0; i < seconds; i += 2) {
        const v = await probe();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`timed out after ${seconds}s`);
}

function faucetOffchain(address: string, amount: number) {
    const note = execSync("docker exec arkd arkd note --amount 100000").toString().trim();
    execSync(`docker exec arkd ark redeem-notes -n ${note} --password secret`, { stdio: "pipe" });
    execSync(`docker exec arkd ark send --to ${address} --amount ${amount} --password secret`, { stdio: "pipe" });
}
