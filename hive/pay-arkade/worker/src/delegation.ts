// Renewal by a delegate service, the way the Arkade wallet renews its own coins (delegate.arkade.money
// on mainnet): the escrow's coin is presigned into a register proof that recreates the same escrow in
// a later batch, plus a forfeit for the delegate path. The service submits the proof shortly before
// the coin expires, joins the batch as a cosigner and adds its signature to the forfeit.
//
// The escrow has no single owner, so the hive agent and the provider sign together as one MuSig2 key:
// the provider builds the renewal and sends its nonces, the agent checks that it renews this escrow
// into itself and nothing else and answers with its nonces and partial signatures, and the provider
// completes the signatures and hands the renewal to the service.
import { base64, hex } from "@scure/base";
import { Address, OutScript, SigHash } from "@scure/btc-signer";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { ArkAddress, Estimator, P2A, Proof, Transaction, getNetwork, toOffchainInputFeeParams, type NetworkName } from "@arkade-os/sdk";
import { type Escrow, type EscrowParams } from "./escrow.ts";
import { finish, firstNonces, ownersKey, secondSign } from "./musig.ts";
import { tapLeafHash } from "@scure/btc-signer/payment.js";

export interface DelegateInfo {
    pubkey: string; // compressed, as the service states it
    xonly: string;
    fee: bigint;
    address: string;
}

export interface Renewal {
    message: Proof.RegisterMessage;
    proof: string; // base64 PSBT
    forfeits: string[]; // base64 PSBTs
}

/** The provider's opening: the unsigned renewal and its MuSig2 nonces, one per signature. */
export interface RenewalRequest extends Renewal {
    id: string;
    nonces: string[];
}

/** The agent's answer: its nonces and partial signatures, in the same order. */
export interface RenewalAnswer {
    id: string;
    nonces: string[];
    partials: string[];
}

// The provider's secret nonces, by request, until the agent answers. Each is used once.
const pending = new Map<string, { request: RenewalRequest; nonces: { public: Uint8Array; secret: Uint8Array }[] }>();

/** The delegate service's key, fee and fee address. */
export async function delegateInfo(url: string): Promise<DelegateInfo> {
    const res = await fetch(`${url.replace(/\/+$/, "")}/v1/delegator/info`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`delegate service: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const info = await res.json();
    const pubkey = String(info.pubkey);
    return { pubkey, xonly: pubkey.length === 66 ? pubkey.slice(2) : pubkey, fee: BigInt(info.fee ?? 0), address: String(info.delegateAddress ?? info.delegatorAddress) };
}

async function operatorInfo(operatorUrl: string) {
    const res = await fetch(`${operatorUrl.replace(/\/+$/, "")}/v1/info`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`operator info: ${res.status}`);
    return res.json();
}

/** The fee estimator with `now()` fixed at the renewal's time, as the wallet's delegation does. */
function estimatorAt(intentFee: Record<string, string>, atSeconds: number) {
    const now = `double(${atSeconds})`;
    return new Estimator({
        ...intentFee,
        offchainInput: intentFee.offchainInput?.replace("now()", now),
        offchainOutput: intentFee.offchainOutput?.replace("now()", now),
    } as never);
}

/** What a correct renewal of this escrow's current coin looks like. */
async function expected(escrow: Escrow, params: EscrowParams, operatorUrl: string, delegate: DelegateInfo, renewAt?: number) {
    if ((params.delegatePk ?? "").toLowerCase() !== delegate.xonly.toLowerCase()) {
        throw new Error("the job names a different delegate service");
    }
    const contract = escrow.contract(params);
    const coin = await escrow.onlyCoin(contract.pkScript);
    const info = await operatorInfo(operatorUrl);
    const expiry = coin.expiresAt ? Math.floor(new Date(coin.expiresAt as unknown as string).getTime() / 1000) : null;
    if (!expiry) throw new Error("the escrow coin states no expiry");
    const now = Math.floor(Date.now() / 1000);
    // Three sessions before expiry, as the wallet does; at once when that has passed.
    const target = expiry - Number(info.sessionDuration ?? 60) * 3;
    const latest = target > now ? target : now + 2;
    // Earlier than that only costs an early-renewal fee, still within the escrow's fee cap.
    const validAt = renewAt ?? latest;
    const fee = BigInt(estimatorAt(info.fees?.intentFee ?? {}, validAt).evalOffchainInput({ ...toOffchainInputFeeParams(coin as never), type: "vtxo" } as never).satoshis);
    const amount = BigInt(coin.value) - fee - delegate.fee;
    if (fee + delegate.fee > BigInt(escrow.renewal(params).maxRenewalFee)) {
        throw new Error(`renewal would cost ${fee + delegate.fee} sats, above the escrow's ${escrow.renewal(params).maxRenewalFee}`);
    }
    const network = info.network as NetworkName;
    const forfeitScript = OutScript.encode(Address(getNetwork(network)).decode(info.forfeitAddress));
    return { contract, coin, validAt, latest, amount, dust: BigInt(info.dust ?? 330), forfeitScript };
}

/** The messages the two sign together: both proof inputs on the cooperative path, the forfeit on the delegate path. */
function sighashes(proof: Transaction, forfeit: Transaction) {
    const msgs: { tx: Transaction; idx: number; hashType: number; leafHash: Uint8Array }[] = [];
    const add = (tx: Transaction, idx: number, hashType: number) => {
        const input = tx.getInput(idx);
        const leaf = input.tapLeafScript?.[0];
        if (!leaf) throw new Error(`input ${idx} names no spending path`);
        const scriptWithVersion = leaf[1];
        const script = scriptWithVersion.subarray(0, -1);
        const version = scriptWithVersion[scriptWithVersion.length - 1];
        msgs.push({ tx, idx, hashType, leafHash: tapLeafHash(script, version) });
        const prevouts = Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).witnessUtxo!);
        return tx.preimageWitnessV1(idx, prevouts.map((p) => p.script), hashType, prevouts.map((p) => p.amount), undefined, script, version);
    };
    const digests = [add(proof, 0, SigHash.DEFAULT), add(proof, 1, SigHash.DEFAULT), add(forfeit, 0, SigHash.ALL_ANYONECANPAY)];
    return { msgs, digests };
}

/** The provider builds the renewal of the escrow's coin and opens a MuSig2 session for each signature. */
export async function prepareRenewal(escrow: Escrow, params: EscrowParams, operatorUrl: string, delegate: DelegateInfo, secret: Uint8Array, renewAt?: number): Promise<RenewalRequest> {
    const { contract, coin, validAt, amount, dust, forfeitScript } = await expected(escrow, params, operatorUrl, delegate, renewAt);
    const cooperative = contract.vtxoScript.functionByName("cooperative")?.tapLeafScript;
    const delegateLeaf = contract.vtxoScript.functionByName("delegate")?.tapLeafScript;
    if (!cooperative || !delegateLeaf) throw new Error("this escrow has no delegate path");

    const outputs = [];
    if (delegate.fee > 0n) outputs.push({ script: ArkAddress.decode(delegate.address).pkScript, amount: delegate.fee });
    outputs.push({ script: contract.pkScript, amount });
    const message: Proof.RegisterMessage = {
        type: "register",
        onchain_output_indexes: [],
        valid_at: validAt,
        expire_at: 0,
        cosigners_public_keys: [delegate.pubkey],
    };
    const input = {
        txid: coin.txid,
        vout: coin.vout,
        value: coin.value,
        status: coin.status,
        tapTree: contract.tapTree,
        intentTapLeafScript: cooperative,
        forfeitTapLeafScript: delegateLeaf,
    };
    const proof = Proof.create(message, [input as never], outputs);

    const forfeit = new Transaction({ version: 3 });
    forfeit.addInput({
        txid: coin.txid,
        index: coin.vout,
        witnessUtxo: { amount: BigInt(coin.value), script: contract.pkScript },
        sighashType: SigHash.ALL_ANYONECANPAY,
        tapLeafScript: [delegateLeaf],
    });
    forfeit.addOutput({ script: forfeitScript, amount: BigInt(coin.value) + dust });
    forfeit.addOutput(P2A);

    const { digests } = sighashes(proof, forfeit);
    const nonces = firstNonces(secret, params.agentPk, params.providerPk, digests);
    const request: RenewalRequest = {
        id: hex.encode(crypto.getRandomValues(new Uint8Array(16))),
        message,
        proof: base64.encode(proof.toPSBT()),
        forfeits: [base64.encode(forfeit.toPSBT())],
        nonces: nonces.map((n) => hex.encode(n.public)),
    };
    pending.set(request.id, { request, nonces });
    return request;
}

/**
 * The agent checks a renewal against what it should be (this escrow's coin, renewed into this escrow,
 * for no more than the escrow's fee cap, cosigned by the job's delegate) and answers with its share of
 * each signature.
 */
export async function cosignRenewal(escrow: Escrow, params: EscrowParams, operatorUrl: string, delegate: DelegateInfo, request: RenewalRequest, secret: Uint8Array): Promise<RenewalAnswer> {
    const m = request.message;
    const want = await expected(escrow, params, operatorUrl, delegate, m.valid_at);
    if (m.type !== "register" || m.onchain_output_indexes.length !== 0 || m.expire_at !== 0) throw new Error("not a plain register proof");
    if (m.cosigners_public_keys.length !== 1 || m.cosigners_public_keys[0] !== delegate.pubkey) throw new Error("the proof names another cosigner");
    const now = Math.floor(Date.now() / 1000);
    if (m.valid_at > want.latest + 3_600 || m.valid_at < now - 600) throw new Error("the proof is not timed before the coin expires");

    const proof = Transaction.fromPSBT(base64.decode(request.proof));
    if (proof.inputsLength !== 2) throw new Error("the proof must spend the escrow's one coin");
    const spent = proof.getInput(1);
    if (hex.encode(spent.txid!) !== want.coin.txid || spent.index !== want.coin.vout) throw new Error("the proof spends another coin");
    // The proof's message is what the server reads; it must be the one presented.
    const rebuilt = Proof.create(m, [{ txid: want.coin.txid, vout: want.coin.vout, value: want.coin.value, status: want.coin.status, tapTree: want.contract.tapTree,
        intentTapLeafScript: want.contract.vtxoScript.functionByName("cooperative")!.tapLeafScript, forfeitTapLeafScript: want.contract.vtxoScript.functionByName("delegate")!.tapLeafScript } as never], []);
    if (hex.encode(rebuilt.getInput(0).txid!) !== hex.encode(proof.getInput(0).txid!)) throw new Error("the proof commits to another message");
    const outs = Array.from({ length: proof.outputsLength }, (_, i) => proof.getOutput(i));
    const toEscrow = outs.filter((o) => o.script && equalBytes(o.script, want.contract.pkScript));
    const toDelegate = delegate.fee > 0n ? outs.filter((o) => o.script && equalBytes(o.script, ArkAddress.decode(delegate.address).pkScript)) : [];
    if (toEscrow.length !== 1 || toEscrow[0].amount! < want.amount) throw new Error("the proof does not renew the whole escrow into itself");
    if (toDelegate.length !== (delegate.fee > 0n ? 1 : 0) || (toDelegate[0] && toDelegate[0].amount! > delegate.fee)) throw new Error("the delegate fee is not what the service asks");
    if (outs.length !== toEscrow.length + toDelegate.length) throw new Error("the proof pays somewhere else");

    if (request.forfeits.length !== 1) throw new Error("one forfeit expected");
    const forfeit = Transaction.fromPSBT(base64.decode(request.forfeits[0]));
    const fin = forfeit.getInput(0);
    if (forfeit.inputsLength !== 1 || hex.encode(fin.txid!) !== want.coin.txid || fin.index !== want.coin.vout) throw new Error("the forfeit spends another coin");
    if (fin.sighashType !== SigHash.ALL_ANYONECANPAY) throw new Error("the forfeit sighash is not ALL|ANYONECANPAY");
    const f0 = forfeit.getOutput(0);
    if (forfeit.outputsLength !== 2 || !equalBytes(f0.script!, want.forfeitScript)) throw new Error("the forfeit does not pay the server's forfeit address");

    // Sign exactly the paths this escrow defines, whatever leaves the request names.
    const coopLeaf = want.contract.vtxoScript.functionByName("cooperative")!.tapLeafScript;
    const delegateLeaf = want.contract.vtxoScript.functionByName("delegate")!.tapLeafScript;
    for (const [tx, idx, leaf] of [[proof, 0, coopLeaf], [proof, 1, coopLeaf], [forfeit, 0, delegateLeaf]] as const) {
        const named = tx.getInput(idx).tapLeafScript?.[0];
        if (!named || !equalBytes(named[1], leaf[1])) throw new Error(`input ${idx} names a path this escrow does not sign there`);
    }
    if (request.nonces.length !== 3) throw new Error("three nonces expected");
    const { digests } = sighashes(proof, forfeit);
    const signed = secondSign(secret, params.agentPk, params.providerPk, digests, request.nonces.map((n) => hex.decode(n)));
    return { id: request.id, nonces: signed.map((s) => hex.encode(s.nonce)), partials: signed.map((s) => hex.encode(s.partial)) };
}

/** The provider completes each signature with the agent's share and returns the renewal ready to submit. */
export function finishRenewal(params: EscrowParams, answer: RenewalAnswer, secret: Uint8Array): Renewal {
    const open = pending.get(answer.id);
    if (!open) throw new Error("no renewal is waiting for this answer");
    pending.delete(answer.id); // secret nonces are single-use, whatever happens next
    const proof = Transaction.fromPSBT(base64.decode(open.request.proof));
    const forfeit = Transaction.fromPSBT(base64.decode(open.request.forfeits[0]));
    const { msgs, digests } = sighashes(proof, forfeit);
    const sigs = finish(secret, params.agentPk, params.providerPk, digests, open.nonces,
        answer.nonces.map((n, i) => ({ nonce: hex.decode(n), partial: hex.decode(answer.partials[i]) })));
    const owners = ownersKey(params.agentPk, params.providerPk).xonly;
    msgs.forEach((m, i) => {
        const sig = m.hashType === SigHash.DEFAULT ? sigs[i] : new Uint8Array([...sigs[i], m.hashType]);
        m.tx.updateInput(m.idx, { tapScriptSig: [[{ pubKey: owners, leafHash: m.leafHash }, sig]] });
    });
    return { message: open.request.message, proof: base64.encode(proof.toPSBT()), forfeits: [base64.encode(forfeit.toPSBT())] };
}

/** Hand the fully signed renewal to the delegate service. */
export async function submitRenewal(url: string, renewal: Renewal) {
    const res = await fetch(`${url.replace(/\/+$/, "")}/v1/delegate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            intent: { message: Proof.encodeMessage(renewal.message), proof: renewal.proof },
            forfeit_txs: renewal.forfeits,
            reject_replace: false,
        }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`delegate service refused the renewal: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return { validAt: renewal.message.valid_at };
}
