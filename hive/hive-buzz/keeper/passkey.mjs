// A keeper's passkey in the keeper console. The passkey is the keeper's key, and the only thing to
// keep: it approves the hive's payments itself, with its own P-256 key, and through WebAuthn's PRF
// extension it gives this site a secret from which the console derives the keeper's Bitcoin key, the
// one on the treasury's exit and the one the desk knows the keeper by. A passkey saved in iCloud
// Keychain, Google Password Manager or another manager that syncs is on the keeper's other devices
// too. Nothing secret is stored in the browser: only the passkey's id and its public keys.
import { bitcoinKeyOf, KEY_SALT, keeperKeyFromSpki, keeperLine } from "../../../packages/treasury/src/index.ts";

const STORE = "hive-keeper/v2";
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const NO_PRF = "This browser or password manager can't derive a key from a passkey here. Use a recent Chrome, Edge or Safari, with your passkeys in iCloud Keychain, Google Password Manager or a manager that supports PRF.";

/** The passkey this browser knows: its id, its public keys and the site it belongs to. */
export function stored() {
    try { return JSON.parse(localStorage.getItem(STORE) ?? "null"); } catch { return null; }
}
function store(value) {
    localStorage.setItem(STORE, JSON.stringify(value));
}
export function forget() {
    localStorage.removeItem(STORE);
}

/** The line the keeper posts in the hive's channel, from their own Buzz identity. */
export const lineOf = (record) => (record?.key ? keeperLine(record) : null);

/** The PRF output of an assertion, or of a creation that already evaluated it. */
function prfOf(credential) {
    const first = credential.getClientExtensionResults()?.prf?.results?.first;
    return first ? new Uint8Array(first) : null;
}

/** Uses the passkey once for its PRF secret; `credentialId` names it, or the keeper picks one. */
export async function passkeySecret(credentialId) {
    const assertion = await navigator.credentials.get({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        ...(credentialId ? { allowCredentials: [{ type: "public-key", id: unb64url(credentialId) }] } : {}),
        userVerification: "required",
        extensions: { prf: { eval: { first: KEY_SALT } } },
    } });
    const prf = prfOf(assertion);
    if (!prf) throw new Error(NO_PRF);
    return { credentialId: b64url(assertion.rawId), prf };
}

/**
 * A new keeper passkey for this site: ES256, so the treasury contract can check its signatures, and
 * discoverable, so the keeper's other devices find it. Returns what this browser keeps of it.
 */
export async function createPasskey() {
    const cred = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { id: location.hostname, name: "Hive keeper console" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Hive keeper", displayName: "Hive keeper" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: { eval: { first: KEY_SALT } } },
    } });
    const ext = cred.getClientExtensionResults()?.prf;
    if (!ext?.enabled && !ext?.results?.first) throw new Error(NO_PRF);
    const credentialId = b64url(cred.rawId);
    // Some browsers give the secret only when the passkey is used, not when it is made.
    const prf = prfOf(cred) ?? (await passkeySecret(credentialId)).prf;
    const record = {
        v: 2,
        kind: "hive-keeper-passkey",
        credentialId,
        site: location.hostname,
        key: hex(keeperKeyFromSpki(new Uint8Array(cred.response.getPublicKey()))),
        bitcoinKey: hex(bitcoinKeyOf(prf)),
        created: new Date().toISOString(),
    };
    prf.fill(0);
    store(record);
    return record;
}

/**
 * A passkey the keeper made on another device and synced here: it derives the same Bitcoin key. Its
 * P-256 key only comes with its creation, so the line to post stays on the device that made it; the
 * hive already knows it.
 */
export async function adoptPasskey() {
    const { credentialId, prf } = await passkeySecret(null);
    const record = { v: 2, kind: "hive-keeper-passkey", credentialId, site: location.hostname, key: null, bitcoinKey: hex(bitcoinKeyOf(prf)), created: new Date().toISOString() };
    prf.fill(0);
    store(record);
    return record;
}

/** The keeper's approval of one payment: the passkey signs the message the console rebuilt. */
export async function approveWith(credentialId, message) {
    const a = await navigator.credentials.get({ publicKey: {
        challenge: message,
        rpId: location.hostname,
        allowCredentials: [{ type: "public-key", id: unb64url(credentialId) }],
        userVerification: "required",
    } });
    return {
        authenticatorData: b64url(a.response.authenticatorData),
        clientDataJSON: new TextDecoder().decode(a.response.clientDataJSON),
        signature: b64url(a.response.signature),
    };
}
