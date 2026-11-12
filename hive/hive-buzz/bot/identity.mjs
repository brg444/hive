// The bot's own Buzz identity: a key generated and kept on the machine the bot runs on, and the
// owner's NIP-OA authorization of it, which a person creates in Buzz (Settings → Buzz → Security →
// Authorize external identity) and hands back. The key never leaves this machine.
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const CLAUSE = /^(kind=(0|[1-9]\d*)|created_at[<>](0|[1-9]\d*))$/;

/** Write a file readable by its owner only, replacing it in one step. */
function writePrivate(path, text) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}

/** The bot's key in `stateDir`, created on first use. Returns the secret and the public key, hex. */
export function loadOrCreateKey(stateDir) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, "bot.key");
    if (!existsSync(path)) writePrivate(path, bytesToHex(schnorr.utils.randomPrivateKey()) + "\n");
    const secret = readFileSync(path, "utf8").trim();
    if (!HEX64.test(secret)) throw new Error(`${path} does not hold a 64-hex secret key`);
    return { secret, pubkey: bytesToHex(schnorr.getPublicKey(hexToBytes(secret))) };
}

/**
 * Check an owner's NIP-OA `auth` tag for `agentPubkey` exactly as NIP-OA says verifiers must:
 * four elements, a valid owner key that is not the agent's, well-formed conditions, and a BIP-340
 * signature over sha256("nostr:agent-auth:" + agent + ":" + conditions). Returns the parsed tag and
 * its owner, or throws saying what is wrong.
 */
export function checkAuthTag(json, agentPubkey) {
    let tag;
    try {
        tag = typeof json === "string" ? JSON.parse(json) : json;
    } catch {
        throw new Error("the authorization is not JSON: paste it exactly as Buzz shows it");
    }
    if (!Array.isArray(tag) || tag.length !== 4 || tag.some((x) => typeof x !== "string") || tag[0] !== "auth") {
        throw new Error('the authorization must be ["auth", owner, conditions, signature]');
    }
    const [, owner, conditions, sig] = tag;
    if (!HEX64.test(owner)) throw new Error("the owner key is not 64 lowercase hex characters");
    if (!HEX128.test(sig)) throw new Error("the signature is not 128 lowercase hex characters");
    if (owner === agentPubkey) throw new Error("the owner and the bot cannot be the same key");
    if (conditions !== "" && !conditions.split("&").every((c) => CLAUSE.test(c))) {
        throw new Error(`the conditions "${conditions}" are not valid NIP-OA conditions`);
    }
    const digest = sha256(utf8ToBytes(`nostr:agent-auth:${agentPubkey}:${conditions}`));
    let valid = false;
    try {
        valid = schnorr.verify(hexToBytes(sig), digest, hexToBytes(owner));
    } catch { /* malformed point or signature */ }
    if (!valid) throw new Error("the signature does not authorize this bot's key: was it made for a different public key?");
    return { tag, owner, conditions };
}

/** Store the checked authorization beside the key. */
export function saveAuthTag(stateDir, tag) {
    writePrivate(join(stateDir, "auth-tag.json"), JSON.stringify(tag) + "\n");
}

export function loadAuthTag(stateDir, agentPubkey) {
    const path = join(stateDir, "auth-tag.json");
    if (!existsSync(path)) return null;
    return checkAuthTag(readFileSync(path, "utf8"), agentPubkey);
}

/** Sign an owner authorization: used by tests and by a local relay setup, never by the bot itself. */
export function signAuthTag(ownerSecret, agentPubkey, conditions = "") {
    const digest = sha256(utf8ToBytes(`nostr:agent-auth:${agentPubkey}:${conditions}`));
    const owner = bytesToHex(schnorr.getPublicKey(hexToBytes(ownerSecret)));
    return ["auth", owner, conditions, bytesToHex(schnorr.sign(digest, hexToBytes(ownerSecret)))];
}
