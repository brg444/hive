import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    arkade,
    DefaultVtxo,
    networks,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    SingleKey,
} from "@arkade-os/sdk";
import { bip68, NO_DELEGATE } from "../src/escrow.ts";
import { ownersKey } from "../src/musig.ts";
import artifact from "../../contracts/job_escrow.artifact.json" with { type: "json" };

const OPERATOR_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";
const CAP = 20_000;
const OWED = 12_000;

describe("job escrow", () => {
    it("pays the receipted amount, returns the rest, and expires to the treasury", { timeout: 240_000 }, async () => {
        // The stack answers, and the SDK's emulator key is the one the emulator serves.
        const emulatorInfo = await (await fetch(`${EMULATOR_URL}/v1/info`)).json();
        const indexer = new RestIndexerProvider(OPERATOR_URL);

        // Three parties. The provider runs the spending session; the agent only signs receipts;
        // the treasury is a key whose default address receives the remainder.
        const provider = SingleKey.fromRandomBytes();
        const agentPriv = schnorr.utils.randomSecretKey();
        const agentPk = schnorr.getPublicKey(agentPriv);
        const treasuryKey = SingleKey.fromRandomBytes();

        const client = await arkade.Arkade.connect({
            arkade: new RestArkProvider(OPERATOR_URL),
            emulator: new RestEmulatorProvider(EMULATOR_URL),
            indexer,
            network: networks.regtest,
            identity: provider,
        });
        expect(hex.encode(client.emulatorKey!)).toBe(emulatorInfo.signerPubkey);

        const treasury = defaultScript(client, await treasuryKey.xOnlyPublicKey());
        const providerWallet = defaultScript(client, await provider.xOnlyPublicKey());

        // Two jobs with the same parties and deadline, told apart only by their job ids.
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 75);
        const program = arkade.programFromArtifact(artifact);
        const providerPk = await provider.xOnlyPublicKey();
        const job = (jobId: Uint8Array) =>
            client.contract(program, {
                agentPk,
                providerPk,
                treasuryProgram: treasury.tweakedPublicKey,
                deadline,
                jobId,
                renewalWindow: 90n,
                maxRenewalFee: 100n,
                exitDelay: bip68(Number(client.serverExitDelay)),
                delegatePk: hex.decode(NO_DELEGATE),
                ownersPk: ownersKey(hex.encode(agentPk), hex.encode(providerPk)).xonly,
            });
        const jobA = randomJobId();
        const jobB = randomJobId();
        const escrowA = job(jobA);
        const escrowB = job(jobB);
        expect(escrowA.address).not.toBe(escrowB.address);

        // The treasury funds each job's cap.
        faucetOffchain(escrowA.address, CAP);
        faucetOffchain(escrowB.address, CAP);
        const [coinA] = await waitForCoins(indexer, escrowA.pkScript, 1);
        const [coinB] = await waitForCoins(indexer, escrowB.pkScript, 1);
        expect(coinA.value).toBe(CAP);

        const rest = BigInt(CAP - OWED);
        const claim = (escrow: typeof escrowA, coin: typeof coinA, amount: number, sig: Uint8Array, treasuryOut = rest, providerOut = BigInt(amount)) =>
            escrow.functions
                .claim(BigInt(amount), sig)
                .from(coin)
                .to(treasury.pkScript, treasuryOut)
                .to(providerWallet.pkScript, providerOut)
                .send();

        // A receipt signed by anyone but the hive agent is refused.
        const stranger = schnorr.utils.randomSecretKey();
        await expectRefusal(claim(escrowA, coinA, OWED, receipt(stranger, jobA, OWED)), BAD_RECEIPT);

        // Paying the treasury less than its share is refused.
        await expectRefusal(claim(escrowA, coinA, OWED, receipt(agentPriv, jobA, OWED), rest - 1_000n, BigInt(OWED) + 1_000n), VERIFY_FAILED);

        // A receipt for job A does not unlock job B.
        await expectRefusal(claim(escrowB, coinB, OWED, receipt(agentPriv, jobA, OWED)), BAD_RECEIPT);

        // The latest receipt pays the provider exactly what is owed and returns the rest.
        const { txid } = await claim(escrowA, coinA, OWED, receipt(agentPriv, jobA, OWED));
        expect(txid).toBeTruthy();
        expect(await settledValues(indexer, providerWallet.pkScript)).toEqual([OWED]);
        expect(await settledValues(indexer, treasury.pkScript)).toEqual([CAP - OWED]);
        expect(await isSpent(indexer, escrowA.pkScript, coinA)).toBe(true);

        // A receipt for more than is locked, as when a renewal fee left less, pays the provider all of it.
        const jobC = randomJobId();
        const escrowC = job(jobC);
        faucetOffchain(escrowC.address, CAP);
        const [coinC] = await waitForCoins(indexer, escrowC.pkScript, 1);
        const over = await escrowC.functions
            .claim(BigInt(CAP + 500), receipt(agentPriv, jobC, CAP + 500))
            .from(coinC)
            .to(providerWallet.pkScript, BigInt(CAP))
            .send();
        expect(over.txid).toBeTruthy();

        // Job B is never claimed. Before the deadline it cannot be returned.
        const expire = () => escrowB.functions.expire().from(coinB).to(treasury.pkScript, BigInt(CAP)).send();
        await expectRefusal(expire(), VERIFY_FAILED);

        // After the deadline anyone can return it whole to the treasury.
        await sleepUntil(Number(deadline) + 5);
        await expire();
        expect((await settledValues(indexer, treasury.pkScript)).sort((a, b) => a - b)).toEqual([CAP - OWED, CAP]);
        expect(await isSpent(indexer, escrowB.pkScript, coinB)).toBe(true);
    });
});

// The receipt the hive agent signs: this job and the cumulative sats owed (NUM2BIN is little-endian).
function receipt(agentPriv: Uint8Array, jobId: Uint8Array, amount: number): Uint8Array {
    return schnorr.sign(sha256(concat(jobId, le(amount, 8))), agentPriv);
}

function randomJobId(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(32));
}

// The emulator answers every refusal with "internal error" and logs only the failing opcode
// class, not the require message. A bad receipt fails its signature check; a claim whose
// receipt verifies and is still refused failed one of the later requires (cap, treasury, clock).
const BAD_RECEIPT = "signature verification failed";
const VERIFY_FAILED = "op_verify failed";
async function expectRefusal(spend: Promise<unknown>, reason: string) {
    const since = new Date().toISOString();
    await expect(spend).rejects.toThrow();
    const log = execSync(`docker logs --since ${since} emulator 2>&1`).toString();
    expect(log.toLowerCase()).toContain(reason);
}

function le(n: number, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let v = BigInt(n);
    for (let i = 0; i < size; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

function defaultScript(client: arkade.Arkade, pubKey: Uint8Array) {
    const delay = Number(client.serverExitDelay);
    return new DefaultVtxo.Script({
        pubKey,
        serverPubKey: client.serverKey,
        csvTimelock: { type: delay < 512 ? "blocks" : "seconds", value: BigInt(delay) },
    });
}

async function waitForCoins(indexer: RestIndexerProvider, pkScript: Uint8Array, count: number) {
    for (let i = 0; i < 30; i++) {
        const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(pkScript)], spendableOnly: true });
        if (vtxos.length >= count) return vtxos;
        await sleep(1000);
    }
    throw new Error(`timed out waiting for ${count} coins`);
}

async function settledValues(indexer: RestIndexerProvider, pkScript: Uint8Array): Promise<number[]> {
    for (let i = 0; i < 15; i++) {
        const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(pkScript)], spendableOnly: true });
        if (vtxos.length > 0) return vtxos.map((v) => v.value);
        await sleep(1000);
    }
    return [];
}

async function isSpent(indexer: RestIndexerProvider, pkScript: Uint8Array, coin: { txid: string; vout: number }) {
    const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(pkScript)] });
    return vtxos.find((v) => v.txid === coin.txid && v.vout === coin.vout)?.isSpent ?? false;
}

// Coins expire within minutes on this stack, so each funding redeems a fresh note first.
// Note redemption pays no intent fee: run `docker exec arkd arkd fees clear` once per stack.
function faucetOffchain(address: string, amount: number) {
    const note = execSync("docker exec arkd arkd note --amount 100000").toString().trim();
    execSync(`docker exec arkd ark redeem-notes -n ${note} --password secret`, { stdio: "pipe" });
    execSync(`docker exec arkd ark send --to ${address} --amount ${amount} --password secret`, { stdio: "pipe" });
}

async function sleepUntil(unixSeconds: number) {
    const ms = unixSeconds * 1000 - Date.now();
    if (ms > 0) await sleep(ms);
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
