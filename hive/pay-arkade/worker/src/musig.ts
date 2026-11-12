// The hive agent and the provider as one key: a MuSig2 aggregate, so a spend both must approve carries
// a single signature, which is all the delegate service accepts for a coin's owner.
//
// Keys travel x-only, so each signer works with the even-y form of its key (negating its secret when
// needed) and every party lifts the other's x-only key the same way.
import { hex } from "@scure/base";
import * as musig from "@scure/btc-signer/musig2.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hexBytes } from "./signing.ts";

const N = secp256k1.Point.CURVE().n;

/** The even-y compressed key for an x-only key. */
export function lift(xonly: string | Uint8Array): Uint8Array {
    const x = typeof xonly === "string" ? hexBytes(xonly, 32, "pubkey") : xonly;
    const out = new Uint8Array(33);
    out[0] = 0x02;
    out.set(x, 1);
    return out;
}

/** The signer's secret for its even-y key, the one that matches `lift(x-only key)`. */
export function evenSecret(secret: Uint8Array): Uint8Array {
    const pub = secp256k1.getPublicKey(secret, true);
    if (pub[0] === 0x02) return secret;
    const d = (N - BigInt("0x" + hex.encode(secret))) % N;
    return hex.decode(d.toString(16).padStart(64, "0"));
}

/** The participants, in MuSig2's sorted order, and their aggregate as an x-only key. */
export function ownersKey(agentPk: string, providerPk: string) {
    const keys = musig.sortKeys([lift(agentPk), lift(providerPk)]);
    const agg = musig.keyAggExport(musig.keyAggregate(keys));
    return { keys, xonly: agg };
}

/** First signer: fresh nonces for each message; the secret nonces must be used once and then dropped. */
export function firstNonces(secret: Uint8Array, agentPk: string, providerPk: string, msgs: Uint8Array[]) {
    const s = evenSecret(secret);
    const pub = secp256k1.getPublicKey(s, true);
    const { xonly } = ownersKey(agentPk, providerPk);
    return msgs.map((msg) => musig.nonceGen(pub, s, xonly, msg));
}

/** Second signer: signs each message deterministically against the first signer's public nonce. */
export function secondSign(secret: Uint8Array, agentPk: string, providerPk: string, msgs: Uint8Array[], theirNonces: Uint8Array[]) {
    const s = evenSecret(secret);
    const { keys } = ownersKey(agentPk, providerPk);
    return msgs.map((msg, i) => {
        const r = musig.deterministicSign(s, theirNonces[i], keys, msg);
        return { nonce: r.publicNonce, partial: r.partialSig };
    });
}

/** First signer again: its partial signatures, checks of the other's, and the final signatures. */
export function finish(
    secret: Uint8Array,
    agentPk: string,
    providerPk: string,
    msgs: Uint8Array[],
    mine: { public: Uint8Array; secret: Uint8Array }[],
    theirs: { nonce: Uint8Array; partial: Uint8Array }[],
) {
    const s = evenSecret(secret);
    const { keys, xonly } = ownersKey(agentPk, providerPk);
    const myPub = secp256k1.getPublicKey(s, true);
    const meFirstInKeys = hex.encode(keys[0]) === hex.encode(myPub);
    return msgs.map((msg, i) => {
        const nonces = [mine[i].public, theirs[i].nonce];
        const session = new musig.Session(musig.nonceAggregate(nonces), keys, msg);
        const myPartial = session.sign(mine[i].secret, s);
        // Partial signatures go in key order; nonces were aggregated, so their order does not matter.
        const theirIdx = meFirstInKeys ? 1 : 0;
        const orderedNonces = meFirstInKeys ? [mine[i].public, theirs[i].nonce] : [theirs[i].nonce, mine[i].public];
        if (!session.partialSigVerify(theirs[i].partial, orderedNonces, theirIdx)) throw new Error("the other party's partial signature does not verify");
        const sig = session.partialSigAgg(meFirstInKeys ? [myPartial, theirs[i].partial] : [theirs[i].partial, myPartial]);
        if (!schnorr.verify(sig, msg, xonly)) throw new Error("the aggregate signature does not verify");
        return sig;
    });
}
