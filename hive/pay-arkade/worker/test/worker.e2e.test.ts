// Drives the compiled worker binary over its line protocol against a local Arkade regtest stack.
// Three workers play the three roles: the provider (claims), the hive agent (signs receipts) and
// the treasury (only its address matters). Run `bun run build` first; see the README for the stack.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { RestIndexerProvider } from "@arkade-os/sdk";

const BIN = resolve(__dirname, "../dist/pay-arkade-worker");
const CAP = 20_000;
const OWED = 12_000;

class Worker {
    private next = 1;
    private waiting = new Map<number, (msg: any) => void>();
    private constructor(readonly proc: ChildProcessWithoutNullStreams) {
        createInterface({ input: proc.stdout }).on("line", (line) => {
            const msg = JSON.parse(line);
            this.waiting.get(msg.id)?.(msg);
            this.waiting.delete(msg.id);
        });
        proc.stderr.on("data", (d) => process.stderr.write(d));
    }
    static start(keyFile: string) {
        return new Worker(spawn(BIN, ["--key-file", keyFile, "--network", "regtest"]));
    }
    call(op: string, body: Record<string, unknown> = {}): Promise<any> {
        const id = this.next++;
        return new Promise((ok, fail) => {
            this.waiting.set(id, (msg) => ("ok" in msg ? ok(msg.ok) : fail(new Error(msg.error))));
            this.proc.stdin.write(JSON.stringify({ id, op, ...body }) + "\n");
        });
    }
    stop() {
        this.proc.stdin.end();
    }
}

describe("pay-arkade worker", () => {
    const dir = mkdtempSync(join(tmpdir(), "pay-arkade-"));
    let provider: Worker, agent: Worker, treasury: Worker;
    beforeAll(() => {
        provider = Worker.start(join(dir, "provider.key"));
        agent = Worker.start(join(dir, "agent.key"));
        treasury = Worker.start(join(dir, "treasury.key"));
    });
    afterAll(() => {
        for (const w of [provider, agent, treasury]) w?.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    it("signs and checks quotes and receipts offline", async () => {
        const { pubkey: providerPk } = await provider.call("ping");
        const { pubkey: agentPk } = await agent.call("ping");
        const quote = { jobId: "11".repeat(32), model: "m", priceMsatPerMtok: 2_000_000, capSats: CAP, providerPk };
        const { sig } = await provider.call("sign_quote", { quote });
        // Key order does not change the signed digest.
        const reordered = Object.fromEntries(Object.entries(quote).reverse());
        expect((await agent.call("verify_quote", { providerPk, quote: reordered, sig })).valid).toBe(true);
        expect((await agent.call("verify_quote", { providerPk, quote: { ...quote, capSats: CAP + 1 }, sig })).valid).toBe(false);

        const r = await agent.call("sign_receipt", { jobId: quote.jobId, amountSats: OWED });
        expect((await provider.call("verify_receipt", { agentPk, jobId: quote.jobId, amountSats: OWED, sig: r.sig })).valid).toBe(true);
        expect((await provider.call("verify_receipt", { agentPk, jobId: quote.jobId, amountSats: OWED + 1, sig: r.sig })).valid).toBe(false);
        await expect(agent.call("sign_receipt", { jobId: quote.jobId, amountSats: 0 })).rejects.toThrow(/positive/);
    });

    it("funds three jobs: one claimed by receipt, one taken whole at the dust edge, one expired", { timeout: 300_000 }, async () => {
        const { pubkey: providerPk, pkScript: providerScript } = await provider.call("info");
        const { pubkey: agentPk } = await agent.call("info");
        const { program: treasuryProgram, pkScript: treasuryScript } = await treasury.call("info");
        const deadline = Math.floor(Date.now() / 1000) + 60;
        const params = (jobId: string) => ({ agentPk, providerPk, treasuryProgram, deadline, jobId });
        const jobA = params(randomHex(32));
        const jobB = params(randomHex(32));
        const jobC = params(randomHex(32));

        // Buyer and seller derive the same escrow address from the same terms.
        const escrowA = await provider.call("escrow", { params: jobA });
        expect((await agent.call("escrow", { params: jobA })).address).toBe(escrowA.address);
        const escrowB = await provider.call("escrow", { params: jobB });

        faucet(escrowA.address, CAP);
        faucet(escrowB.address, CAP);
        faucet((await provider.call("escrow", { params: jobC })).address, CAP);
        await until(async () => (await provider.call("escrow_status", { params: jobA })).lockedSats === CAP);
        await until(async () => (await provider.call("escrow_status", { params: jobB })).lockedSats === CAP);

        // The provider's worker refuses what the contract would refuse, before touching the network.
        const sigFor = async (job: { jobId: string }, amountSats: number) =>
            (await agent.call("sign_receipt", { jobId: job.jobId, amountSats })).sig;
        const goodSig = await sigFor(jobA, OWED);
        await expect(provider.call("claim", { params: jobB, amountSats: OWED, agentSig: goodSig })).rejects.toThrow(/does not verify/);
        await expect(provider.call("claim", { params: jobA, amountSats: 300, agentSig: await sigFor(jobA, 300) })).rejects.toThrow(/dust/);
        // Only the job's provider can claim it.
        await expect(agent.call("claim", { params: jobA, amountSats: OWED, agentSig: goodSig })).rejects.toThrow(/provider key/);

        // The latest receipt pays the provider and returns the rest to the treasury.
        const claimed = await provider.call("claim", { params: jobA, amountSats: OWED, agentSig: goodSig });
        expect(claimed).toMatchObject({ paidSats: OWED, returnedSats: CAP - OWED });
        expect((await provider.call("escrow_status", { params: jobA })).open).toBe(0);
        expect(await values(providerScript)).toEqual([OWED]);
        expect(await values(treasuryScript)).toEqual([CAP - OWED]);

        // A remainder at or below 330 sats cannot be its own output: the provider takes the coin whole.
        await until(async () => (await provider.call("escrow_status", { params: jobC })).lockedSats === CAP);
        const nearCap = CAP - 200;
        const whole = await provider.call("claim", { params: jobC, amountSats: nearCap, agentSig: await sigFor(jobC, nearCap) });
        expect(whole).toMatchObject({ paidSats: CAP, returnedSats: 0 });
        expect((await values(providerScript, 2)).sort((a, b) => a - b)).toEqual([OWED, CAP]);

        // Job B cannot be returned before its deadline; after it, any worker can return it whole.
        await expect(agent.call("expire", { params: jobB })).rejects.toThrow();
        await sleepUntil(deadline + 5);
        const expired = await agent.call("expire", { params: jobB });
        expect(expired.returnedSats).toBe(CAP);
        expect((await values(treasuryScript, 2)).sort((a, b) => a - b)).toEqual([CAP - OWED, CAP]);
    });
});

// Fresh regtest funds: a note from arkd, redeemed by the stack's CLI wallet, then sent on.
function faucet(address: string, amount: number) {
    const note = execSync("docker exec arkd arkd note --amount 100000").toString().trim();
    execSync(`docker exec arkd ark redeem-notes -n ${note} --password secret`, { stdio: "pipe" });
    execSync(`docker exec arkd ark send --to ${address} --amount ${amount} --password secret`, { stdio: "pipe" });
}

// Spendable coin values at a script, waiting briefly for the indexer to catch up.
const indexer = new RestIndexerProvider("http://localhost:7070");
async function values(pkScript: string, count = 1): Promise<number[]> {
    for (let i = 0; i < 15; i++) {
        const { vtxos } = await indexer.getVtxos({ scripts: [pkScript], spendableOnly: true });
        if (vtxos.length >= count) return vtxos.map((v) => v.value);
        await new Promise((r) => setTimeout(r, 1000));
    }
    return [];
}

function randomHex(n: number) {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex");
}

async function until(check: () => Promise<boolean>, ms = 60_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check().catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("timed out");
}

async function sleepUntil(unixSeconds: number) {
    const wait = unixSeconds * 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
