// The keeper console's first part: a keeper creates their treasury key here, locked with a passkey,
// backs it up, and gets the line to post in the hive's channel. The page has no network access at
// all (its Content-Security-Policy says connect-src 'none'), so the key cannot leave the device.
import { backup, keeperLine, lockWithPasskey, newSecret, PRF_SALT, restore, unlockWithPasskey } from "./vault.mjs";

const STORE = "hive-keeper/v1";
const $ = (id) => document.getElementById(id);
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function stored() {
    try { return JSON.parse(localStorage.getItem(STORE) ?? "null"); } catch { return null; }
}
function store(value) {
    localStorage.setItem(STORE, JSON.stringify(value));
}

const NO_PRF = "This browser or password manager can't lock a key with a passkey here. Use a recent Chrome, Edge or Safari, with your passkeys in your browser or iCloud Keychain.";

/** A new passkey for this console, and the secret its PRF gives this site. */
async function newPasskey() {
    const cred = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Hive keeper console" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Hive keeper", displayName: "Hive keeper" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: { eval: { first: PRF_SALT } } },
    } });
    const prf = cred.getClientExtensionResults()?.prf;
    if (!prf?.enabled && !prf?.results?.first) throw new Error(NO_PRF);
    const credentialId = b64url(cred.rawId);
    // Some browsers give the secret only when the passkey is used, not when it is made.
    const first = prf.results?.first ?? (await passkeySecret(credentialId));
    return { credentialId, prf: new Uint8Array(first) };
}

/** The secret the passkey's PRF gives this site; asks the keeper to use their passkey. */
async function passkeySecret(credentialId) {
    const assertion = await navigator.credentials.get({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: unb64url(credentialId) }],
        userVerification: "required",
        extensions: { prf: { eval: { first: PRF_SALT } } },
    } });
    const first = assertion.getClientExtensionResults()?.prf?.results?.first;
    if (!first) throw new Error(NO_PRF);
    return new Uint8Array(first);
}

/**
 * How this device saves a file the keeper picks a place for. The system's own save sheet reaches
 * iCloud Drive and Google Drive with no account in this page, so the page stays offline:
 * a save dialog on desktop Chrome and Edge, the share sheet's Save to Files on phones and Safari,
 * and a plain download where neither exists.
 */
function saveMethod(file) {
    if (typeof window.showSaveFilePicker === "function") return "picker";
    try { if (navigator.canShare?.({ files: [file] })) return "share"; } catch { /* no file sharing */ }
    return "download";
}
const SAVE_HINT = {
    picker: "Choose where it goes, such as iCloud Drive or your Google Drive folder.",
    share: "Choose Save to Files, then iCloud Drive or Google Drive. On Android, choose Drive.",
    download: "It goes to your Downloads folder. Move it to iCloud Drive or Google Drive afterwards.",
};

/** Saves the file where the keeper chooses; resolves once it is saved, throws if they cancel. */
async function saveFile(file) {
    const method = saveMethod(file);
    if (method === "picker") {
        const handle = await window.showSaveFilePicker({ suggestedName: file.name, types: [{ description: "Keeper backup", accept: { "application/json": [".json"] } }] });
        const writable = await handle.createWritable();
        await writable.write(file);
        await writable.close();
        return;
    }
    if (method === "share") {
        await navigator.share({ files: [file], title: "Hive keeper backup" });
        return;
    }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function show(view) {
    for (const el of document.querySelectorAll("[data-view]")) el.hidden = el.dataset.view !== view;
    const key = stored();
    if (key) {
        $("line").textContent = keeperLine(key.publicKey);
        $("created").textContent = new Date(key.created).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    }
    const focus = document.querySelector(`[data-view="${view}"] h1`);
    focus?.focus();
}

function busy(button, on, text) {
    button.disabled = on;
    if (text) button.textContent = text;
}

function say(id, message, bad = true) {
    const el = $(id);
    el.textContent = message ?? "";
    el.dataset.tone = bad ? "bad" : "good";
}

/**
 * Encrypts the backup, then shows the step that saves it: saving needs a fresh tap, which the
 * system's save sheet asks for, so it cannot follow the encryption on its own.
 */
async function prepareBackup(secret, form, after) {
    const a = form.elements.passphrase.value, b = form.elements.again.value;
    if (a !== b) throw new Error("The two passphrases differ.");
    const contents = await backup(secret, a);
    form.reset();
    prepared = { file: new File([JSON.stringify(contents, null, 2) + "\n"], `hive-keeper-backup-${contents.publicKey.slice(0, 8)}.json`, { type: "application/json" }), after };
    $("save-hint").textContent = SAVE_HINT[saveMethod(prepared.file)];
    say("save-msg", "");
    show("save");
}
let prepared = null;

let pending = null; // the new key between creating it and saving its backup

$("create").addEventListener("click", async (e) => {
    say("create-msg", "");
    busy(e.target, true, "Waiting for your passkey…");
    try {
        const { credentialId, prf } = await newPasskey();
        const secret = newSecret();
        store(await lockWithPasskey(secret, prf, credentialId));
        pending = secret;
        show("backup");
    } catch (err) {
        say("create-msg", err.name === "NotAllowedError" ? "The passkey was cancelled. Nothing was created." : err.message);
    } finally {
        busy(e.target, false, "Create my key");
    }
});

$("backup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    say("backup-msg", "");
    const button = e.target.querySelector("button[type=submit]");
    busy(button, true, "Encrypting…");
    try {
        await prepareBackup(pending, e.target, () => { pending?.fill(0); pending = null; show("key"); });
    } catch (err) {
        say("backup-msg", err.message);
    } finally {
        busy(button, false, "Encrypt the backup");
    }
});

$("save").addEventListener("click", async (e) => {
    say("save-msg", "");
    try {
        await saveFile(prepared.file);
        const { after } = prepared;
        prepared = null;
        after();
    } catch (err) {
        say("save-msg", err.name === "AbortError" || err.name === "NotAllowedError" ? "The backup was not saved. Save it before you go on." : err.message);
    }
});

$("copy").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText($("line").textContent);
        say("copy-msg", "Copied. Post it in the hive's channel.", false);
    } catch {
        say("copy-msg", "Select the line and copy it.");
    }
});

$("again-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    say("again-msg", "");
    const button = e.target.querySelector("button[type=submit]");
    busy(button, true, "Waiting for your passkey…");
    try {
        const key = stored();
        const secret = await unlockWithPasskey(key, await passkeySecret(key.credentialId));
        busy(button, true, "Encrypting…");
        await prepareBackup(secret, e.target, () => { show("key"); say("again-msg", "Backup saved.", false); });
        secret.fill(0);
    } catch (err) {
        say("again-msg", err.name === "NotAllowedError" ? "The passkey was cancelled." : err.message);
    } finally {
        busy(button, false, "Encrypt another backup");
    }
});

$("restore-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    say("restore-msg", "");
    const button = e.target.querySelector("button[type=submit]");
    try {
        const file = e.target.elements.file.files[0];
        if (!file) throw new Error("Choose your backup file.");
        busy(button, true, "Opening the backup…");
        const secret = await restore(JSON.parse(await file.text()), e.target.elements.passphrase.value);
        busy(button, true, "Waiting for your passkey…");
        const { credentialId, prf } = await newPasskey();
        store(await lockWithPasskey(secret, prf, credentialId));
        secret.fill(0);
        e.target.reset();
        show("key");
    } catch (err) {
        say("restore-msg", err instanceof SyntaxError ? "That file is not a keeper backup." : err.name === "NotAllowedError" ? "The passkey was cancelled. Nothing was restored." : err.message);
    } finally {
        busy(button, false, "Restore my key");
    }
});

$("to-restore").addEventListener("click", () => show("restore"));
$("to-start").addEventListener("click", () => show("start"));
$("remove").addEventListener("click", () => {
    if (!confirm("Remove the key from this browser? Without your backup file it cannot be recovered.")) return;
    localStorage.removeItem(STORE);
    show("start");
});

if (!window.PublicKeyCredential) {
    say("create-msg", NO_PRF);
    $("create").disabled = true;
}
show(stored() ? "key" : "start");
