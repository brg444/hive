// pay-arkade worker: the contract half of the Arkade payment plugin for MeshLLM.
//
// The Rust plugin starts this process and speaks JSON lines over stdin/stdout:
//   request  {"id": 1, "op": "claim", ...}
//   response {"id": 1, "ok": {...}}  or  {"id": 1, "error": "..."}
// Requests are answered in arrival order of completion; the id ties them together.
// Every key operation lives here, so the plugin itself carries no wallet code.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createInterface } from "node:readline";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { SingleKey, type NetworkName } from "@arkade-os/sdk";
import { Escrow, type EscrowParams } from "./escrow.ts";
import { Executor } from "./executor.ts";
import { cosignRenewal, delegateInfo, finishRenewal, prepareRenewal, submitRenewal, type RenewalAnswer, type RenewalRequest } from "./delegation.ts";
import { hexBytes, signQuote, signReceipt, verifyQuote, verifyReceipt } from "./signing.ts";

interface Args {
    operator: string;
    emulator: string;
    network: NetworkName;
    keyFile: string;
    executor?: string;
    delegate?: string;
}

function parseArgs(argv: string[]): Args {
    const get = (flag: string, fallback?: string) => {
        const i = argv.indexOf(flag);
        if (i >= 0 && argv[i + 1]) return argv[i + 1];
        if (fallback !== undefined) return fallback;
        throw new Error(`missing ${flag}`);
    };
    return {
        operator: get("--operator", "http://localhost:7070"),
        emulator: get("--emulator", "http://localhost:7073"),
        network: get("--network", "regtest") as NetworkName,
        keyFile: get("--key-file"),
        executor: argv.includes("--executor") ? get("--executor") : undefined,
        delegate: argv.includes("--delegate") ? get("--delegate") : undefined,
    };
}

/** The worker's one key: the provider's claim key on a seller, the agent's receipt key on a buyer. */
function loadSecret(path: string): Uint8Array {
    if (!existsSync(path)) {
        writeFileSync(path, hex.encode(schnorr.utils.randomSecretKey()) + "\n", { mode: 0o600 });
        chmodSync(path, 0o600);
    }
    return hexBytes(readFileSync(path, "utf8").trim(), 32, "key file");
}

function params(raw: unknown): EscrowParams {
    const p = raw as Record<string, unknown>;
    if (!p || typeof p !== "object") throw new Error("params required");
    for (const [k, n] of [["agentPk", 32], ["providerPk", 32], ["treasuryProgram", 32], ["jobId", 32]] as const)
        hexBytes(p[k], n, k);
    if (!Number.isSafeInteger(p.deadline)) throw new Error("deadline must be unix seconds");
    if (p.delegatePk !== undefined) hexBytes(p.delegatePk, 32, "delegatePk");
    for (const k of ["renewalWindow", "maxRenewalFee"] as const)
        if (p[k] !== undefined && (!Number.isSafeInteger(p[k]) || (p[k] as number) < 0)) throw new Error(`${k} must be a non-negative integer`);
    return p as unknown as EscrowParams;
}

function sats(raw: unknown, name = "amountSats"): bigint {
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0) throw new Error(`${name} must be a positive integer`);
    return BigInt(raw as number);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const secret = loadSecret(args.keyFile);
    const pubkey = hex.encode(schnorr.getPublicKey(secret));
    // Connecting is lazy: signing works with the operator down; spends wait for it.
    let escrow: Promise<Escrow> | undefined;
    const connect = () =>
        (escrow ??= Escrow.connect({
            operatorUrl: args.operator,
            emulatorUrl: args.emulator,
            network: args.network,
            identity: SingleKey.fromPrivateKey(secret),
        }).catch((e) => {
            escrow = undefined;
            throw e;
        }));

    const delegate = () => {
        if (!args.delegate) throw new Error("no delegate service: start the worker with --delegate <url>");
        return args.delegate;
    };
    const executor = () => {
        if (!args.executor) throw new Error("no executor: start the worker with --executor <url>");
        return new Executor(args.executor);
    };

    const ops: Record<string, (req: Record<string, unknown>) => unknown> = {
        ping: () => ({ pubkey }),
        info: async () => (await connect()).own(),
        escrow: async (r) => (await connect()).address(params(r.params)),
        escrow_status: async (r) => (await connect()).status(params(r.params)),
        sign_quote: (r) => ({ sig: hex.encode(signQuote(secret, r.quote)) }),
        verify_quote: (r) => ({ valid: verifyQuote(hexBytes(r.providerPk, 32, "providerPk"), r.quote, hexBytes(r.sig, 64, "sig")) }),
        sign_receipt: (r) => ({ sig: hex.encode(signReceipt(secret, hexBytes(r.jobId, 32, "jobId"), sats(r.amountSats))) }),
        verify_receipt: (r) => ({
            valid: verifyReceipt(hexBytes(r.agentPk, 32, "agentPk"), hexBytes(r.jobId, 32, "jobId"), sats(r.amountSats), hexBytes(r.sig, 64, "sig")),
        }),
        claim: async (r) => {
            const p = params(r.params);
            const amount = sats(r.amountSats);
            const sig = hexBytes(r.agentSig, 64, "agentSig");
            // Refuse locally what the emulator would refuse anyway, with a reason the plugin can log.
            if (!verifyReceipt(hexBytes(p.agentPk, 32, "agentPk"), hexBytes(p.jobId, 32, "jobId"), amount, sig))
                throw new Error("receipt does not verify");
            const payout = r.payoutPkScript === undefined ? undefined : hex.encode(hexBytes(r.payoutPkScript, 34, "payoutPkScript"));
            return (await connect()).claim(p, amount, sig, payout);
        },
        expire: async (r) => (await connect()).expire(params(r.params)),
        address_info: async (r) => {
            if (typeof r.address !== "string") throw new Error("address required");
            return (await connect()).addressInfo(r.address);
        },
        preflight: async () => (await connect()).preflight(args.operator, args.emulator),
        // Renewal by the executor, when the worker was given one.
        renewal_setup: async () => executor().setup(),
        renewal_register: async (r) => {
            if (typeof r.templateId !== "string") throw new Error("templateId required");
            if (!Number.isSafeInteger(r.expiresAt)) throw new Error("expiresAt must be unix seconds");
            return executor().register(await connect(), params(r.params), r.templateId, r.expiresAt as number);
        },
        renewal_status: async (r) => executor().status((await connect()).address(params(r.params)).address),
        // Renewal by the delegate service (the Arkade wallet's), presigned by agent and provider together.
        delegate_info: async () => {
            const d = await delegateInfo(delegate());
            return { pubkey: d.pubkey, xonly: d.xonly, fee: Number(d.fee), address: d.address };
        },
        renewal_prepare: async (r) => {
            if (r.renewAt !== undefined && !Number.isSafeInteger(r.renewAt)) throw new Error("renewAt must be unix seconds");
            return prepareRenewal(await connect(), params(r.params), args.operator, await delegateInfo(delegate()), secret, r.renewAt as number | undefined);
        },
        renewal_cosign: async (r) =>
            cosignRenewal(await connect(), params(r.params), args.operator, await delegateInfo(delegate()), r.request as RenewalRequest, secret),
        renewal_finish: async (r) => submitRenewal(delegate(), finishRenewal(params(r.params), r.answer as RenewalAnswer, secret)),
    };

    const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const pending = new Set<Promise<unknown>>();
    for await (const line of lines) {
        if (!line.trim()) continue;
        let req: Record<string, unknown>;
        try {
            req = JSON.parse(line);
        } catch {
            write({ id: null, error: "bad json" });
            continue;
        }
        const id = req.id ?? null;
        const op = ops[String(req.op)];
        if (!op) {
            write({ id, error: `unknown op: ${String(req.op)}` });
            continue;
        }
        const task: Promise<unknown> = Promise.resolve()
            .then(() => op(req))
            .then(
                (ok) => void write({ id, ok }),
                (e) => void write({ id, error: e instanceof Error ? e.message : String(e) }),
            )
            .finally(() => pending.delete(task));
        pending.add(task);
    }
    // Stdin closed: the plugin is shutting down. Finish what is in flight, then exit.
    await Promise.all(pending);
    process.exit(0);
}

main().catch((e) => {
    process.stderr.write(`pay-arkade-worker: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
