// The executor keeps a job escrow alive past its batch: against a local Arkade regtest stack and an
// executord on EXECUTOR_URL (default http://localhost:7090), whose coins expire within minutes.
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { RestIndexerProvider, SingleKey } from "@arkade-os/sdk";
import { Escrow, type EscrowParams } from "../src/escrow.ts";
import { Executor } from "../src/executor.ts";
import { signReceipt } from "../src/signing.ts";

const OPERATOR_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";
const EXECUTOR_URL = process.env.EXECUTOR_URL ?? "http://localhost:7090";
const CAP = 20_000;

describe("job escrow renewal", () => {
    it("is renewed by the executor into the same escrow before its batch expires", async () => {
        const escrow = await Escrow.connect({
            operatorUrl: OPERATOR_URL,
            emulatorUrl: EMULATOR_URL,
            network: "regtest",
            identity: SingleKey.fromRandomBytes(),
        });
        const executor = new Executor(EXECUTOR_URL);
        const { templateId, status } = await executor.setup();
        expect(status).not.toBe("disabled");

        const treasury = await (await Escrow.connect({ operatorUrl: OPERATOR_URL, emulatorUrl: EMULATOR_URL, network: "regtest", identity: SingleKey.fromRandomBytes() })).own();
        const agentKey = schnorr.utils.randomSecretKey();
        const providerKey = SingleKey.fromRandomBytes();
        const params: EscrowParams = {
            agentPk: hex.encode(schnorr.getPublicKey(agentKey)),
            providerPk: hex.encode(await providerKey.xOnlyPublicKey()),
            treasuryProgram: treasury.program,
            // Far enough out that only a renewal, never a return, can move the coin during the test.
            deadline: Math.floor(Date.now() / 1000) + 3_600,
            jobId: hex.encode(crypto.getRandomValues(new Uint8Array(32))),
        };
        const { address, pkScript } = escrow.address(params);

        // The agent registers the renewal before the job is funded, as a funding request does.
        const delegation = await executor.register(escrow, params, templateId, params.deadline + 600);
        expect(delegation.address).toBe(address);

        faucetOffchain(address, CAP);
        const indexer = new RestIndexerProvider(OPERATOR_URL);
        const first = await waitFor(async () => (await live(indexer, pkScript))[0]);
        const firstExpiry = expiryOf(first);
        console.log(`funded ${first.txid}:${first.vout}, expires ${firstExpiry}`);

        // Before its batch expires the coin is spent into a new coin at the same address.
        const renewed = await waitFor(
            async () => (await live(indexer, pkScript)).find((v) => v.txid !== first.txid),
            Math.max(240, firstExpiry - Math.floor(Date.now() / 1000) + 120),
        );
        console.log(`renewed into ${renewed.txid}:${renewed.vout}, expires ${expiryOf(renewed)}`);
        expect(renewed.value).toBeGreaterThanOrEqual(CAP - escrow.renewal(params).maxRenewalFee);
        expect(expiryOf(renewed)).toBeGreaterThan(firstExpiry);
        const status2 = await executor.status(address);
        expect(status2.registered).toBe(true);

        // The renewed escrow is the same escrow: the provider claims it with the agent's receipt.
        const provider = await Escrow.connect({ operatorUrl: OPERATOR_URL, emulatorUrl: EMULATOR_URL, network: "regtest", identity: providerKey });
        const owed = 12_000n;
        const claimed = await provider.claim(params, owed, signReceipt(agentKey, hex.decode(params.jobId), owed));
        console.log(`claimed after renewal: ${JSON.stringify(claimed)}`);
        expect(claimed.paidSats).toBe(12_000);
        expect(claimed.returnedSats).toBe(renewed.value - 12_000);
    }, 900_000);
});

async function live(indexer: RestIndexerProvider, pkScript: string) {
    const { vtxos } = await indexer.getVtxos({ scripts: [pkScript], spendableOnly: true });
    return vtxos;
}

function expiryOf(v: { expiresAt?: unknown; expiresAtHeight?: unknown }) {
    if (v.expiresAt) return Math.floor(new Date(v.expiresAt as string).getTime() / 1000);
    return Number(v.expiresAtHeight ?? 0);
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
