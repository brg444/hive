// A keeper's treasury key in the keeper console: created on the keeper's own device, kept there
// encrypted, and never sent anywhere. Two locks open it:
//
// - the keeper's passkey, through WebAuthn's PRF extension, which gives the page a secret only that
//   passkey can produce on this site; the console stores the key encrypted under it, and
// - a backup passphrase the keeper chooses, for a backup file that restores the key on another
//   device or after the passkey is gone.
//
// Pure apart from Web Crypto and the secp256k1 curve, so it runs the same in the browser and in
// Node's tests. Nothing here talks to WebAuthn itself; console.mjs does.
import { secp256k1 } from "@noble/curves/secp256k1";

const te = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
    if (typeof s !== "string" || s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("not hex");
    return Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
};
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The salt the console asks the passkey's PRF to evaluate: fixed, so the same passkey gives the same secret. */
export const PRF_SALT = te.encode("hive keeper console / treasury key / v1");
/** Iterations for the backup passphrase (OWASP's figure for PBKDF2-HMAC-SHA256). */
export const BACKUP_ITERATIONS = 600_000;

/** A new treasury key: 32 random bytes that are a valid secp256k1 secret. */
export function newSecret() {
    return secp256k1.utils.randomPrivateKey();
}

/** The key keepers publish: compressed, hex. */
export function publicKeyOf(secret) {
    return hex(secp256k1.getPublicKey(secret, true));
}

/** The line a keeper posts in the hive's channel, from their own Buzz identity. */
export const keeperLine = (publicKey) => `Hive keeper key: ${publicKey}`;

/** An AES-GCM key from the passkey's PRF output. */
export async function keyFromPrf(prf) {
    const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode("hive keeper key wrap v1") },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** An AES-GCM key from the backup passphrase. */
export async function keyFromPassphrase(passphrase, salt, iterations = BACKUP_ITERATIONS) {
    const base = await crypto.subtle.importKey("raw", te.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** The secret, encrypted under `aesKey` and bound to its public key, so a box cannot be swapped for another key's. */
async function seal(aesKey, secret) {
    const publicKey = publicKeyOf(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(publicKey) }, aesKey, secret);
    return { publicKey, iv: b64(iv), ciphertext: b64(new Uint8Array(data)) };
}

async function open(aesKey, box) {
    let secret;
    try {
        secret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv), additionalData: te.encode(box.publicKey) }, aesKey, unb64(box.ciphertext)));
    } catch {
        throw new Error("This lock does not open this key.");
    }
    if (publicKeyOf(secret) !== box.publicKey) throw new Error("The key does not match its public key.");
    return secret;
}

/** An AES-GCM key for the nonces the console keeps between signing sessions, from the same passkey. */
export async function nonceKeyFromPrf(prf) {
    const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode("hive keeper nonces v1") },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** The secret halves of shared nonces, encrypted for this device's storage; `label` binds them to one hive. */
export async function sealNonces(aesKey, label, secrets) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(label) }, aesKey, te.encode(JSON.stringify(secrets)));
    return { v: 1, iv: b64(iv), ciphertext: b64(new Uint8Array(data)) };
}

export async function openNonces(aesKey, label, box) {
    if (!box) return [];
    try {
        const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv), additionalData: te.encode(label) }, aesKey, unb64(box.ciphertext));
        return JSON.parse(new TextDecoder().decode(data));
    } catch {
        // Nonces this passkey cannot open are useless here: the desk's copies just go unanswered.
        return [];
    }
}

/** What the console keeps on the device: the key, encrypted under the passkey that created it. */
export async function lockWithPasskey(secret, prf, credentialId) {
    return { v: 1, kind: "hive-keeper-key", credentialId, created: new Date().toISOString(), ...(await seal(await keyFromPrf(prf), secret)) };
}

export async function unlockWithPasskey(stored, prf) {
    if (stored?.v !== 1 || stored.kind !== "hive-keeper-key") throw new Error("Not a keeper key.");
    return open(await keyFromPrf(prf), stored);
}

/** The backup file's contents. */
export async function backup(secret, passphrase, iterations = BACKUP_ITERATIONS) {
    if ((passphrase ?? "").length < 12) throw new Error("Use a passphrase of at least 12 characters.");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const box = await seal(await keyFromPassphrase(passphrase, salt, iterations), secret);
    return { v: 1, kind: "hive-keeper-backup", kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64(salt) }, ...box };
}

export async function restore(file, passphrase) {
    if (file?.v !== 1 || file.kind !== "hive-keeper-backup" || file.kdf?.name !== "PBKDF2" || file.kdf.hash !== "SHA-256") throw new Error("Not a keeper backup.");
    if (!Number.isSafeInteger(file.kdf.iterations) || file.kdf.iterations < 100_000 || file.kdf.iterations > 10_000_000) throw new Error("This backup's settings are not ones the console uses.");
    try {
        return await open(await keyFromPassphrase(passphrase, unb64(file.kdf.salt), file.kdf.iterations), file);
    } catch (e) {
        throw new Error(e.message === "This lock does not open this key." ? "That passphrase does not open this backup." : e.message);
    }
}

export { hex, unhex };
