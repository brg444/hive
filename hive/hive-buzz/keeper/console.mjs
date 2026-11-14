// The keeper console: a keeper creates their treasury key here, locked with a passkey, backs it up,
// and gets the line to post in the hive's channel; later, they open their hive's signing desk here
// and sign its payments. The key never leaves the page: it talks only to the desk and the Arkade
// Operator, and sends them signatures and public nonces.
import { backup, keeperLine, lockWithPasskey, newSecret, PRF_SALT, restore, unlockWithPasskey } from "./vault.mjs";
import { getUnit, money, savedDesk, setUnit, short, Sitting, UNITS, when } from "./payments.mjs";

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

// ---- Payments --------------------------------------------------------------------------------
let sitting = null;
let current = null; // the payment on screen

function lockConsole(message) {
    sitting?.lock();
    sitting = null;
    show("key");
    if (message) say("desk-msg", message, false);
}

$("desk-url").value = savedDesk();
$("desk-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    say("desk-msg", "");
    const button = e.target.querySelector("button[type=submit]");
    busy(button, true, "Waiting for your passkey…");
    try {
        const key = stored();
        const prf = await passkeySecret(key.credentialId);
        const secret = await unlockWithPasskey(key, prf);
        busy(button, true, "Opening the desk…");
        sitting = await Sitting.open($("desk-url").value, secret, prf);
        sitting.onLock = () => { if (sitting) lockConsole("The console locked itself after ten idle minutes."); };
        await showPayments();
    } catch (err) {
        say("desk-msg", err.name === "NotAllowedError" ? "The passkey was cancelled." : err.message);
    } finally {
        busy(button, false, "Unlock and open");
    }
});

function el(tag, { dataset, ...props } = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    Object.assign(node.dataset, dataset ?? {});
    for (const c of children) if (c !== null && c !== undefined) node.append(c);
    return node;
}

/** The Bitcoin price the desk last sent, for amounts in dollars. */
const usd = () => sitting?.hive?.price?.usdPerBtc ?? null;

const units = $("units");
units.replaceChildren(...UNITS.map((u) => el("option", { value: u.id, textContent: u.label, selected: u.id === getUnit() })));
units.addEventListener("change", () => {
    setUnit(units.value);
    if (sitting) showPayments().catch(() => {});
});

async function showPayments() {
    say("payments-msg", "");
    const view = await sitting.overview();
    $("hive-name").textContent = `${sitting.hive.hive}: payments`;
    const { budget } = view;
    $("hive-summary").textContent = `Approved work has ${money(budget.remainingSats, usd())} left for new jobs: ${money(budget.approvedLeftSats, usd())} across ${budget.proposals.length} running proposal${budget.proposals.length === 1 ? "" : "s"}, less ${money(budget.lockedSats, usd())} already in open jobs.`;
    const listing = view.listing;
    const myIndex = sitting.hive.keepers.indexOf(sitting.me);
    $("listing-card").hidden = !(listing && !listing.signatures[myIndex]);
    if (listing) $("listing-text").textContent = `The hive's listing waits for your signature: “${listing.body.name}”, ${listing.body.purpose || "no purpose given"}, treasury ${short(listing.body.treasuryScript.slice(4))}.`;
    const list = $("payment-list");
    list.replaceChildren();
    for (const entry of view.payments) {
        const r = entry.job.request;
        const role = sitting.role(entry);
        const open = el("button", { className: role.action ? "primary" : "quiet", type: "button", textContent: role.action ? role.label : "Details" });
        open.addEventListener("click", () => showPayment(entry, view.budget));
        list.append(el("li", {},
            el("div", { className: "row" }, el("b", { textContent: `${money(r.capSats, usd())} for ${r.model}` }), open),
            el("span", { className: "note", textContent: `${role.action ? "" : `${role.label}. `}Provider ${short(r.providerPk)}, deadline ${when(r.deadline)}.` })));
    }
    $("payments-empty").hidden = view.payments.length > 0;
    show("payments");
}

function showPayment(entry, budget) {
    current = entry;
    const r = entry.job.request;
    const role = sitting.role(entry);
    const facts = sitting.facts(r);
    $("payment-lead").textContent = role.action
        ? "The hive's agent asks the keepers to fund this job. Check the details, then sign; your console checks the rest itself."
        : `${role.label}.`;
    const rows = [
        ["Amount", `${money(r.capSats, usd(), true)}, the job's cap`],
        ["Model", r.model],
        ["Price", `${money(Math.round(r.priceMsatPerMtok / 1000), usd())} per million tokens`],
        ["Provider", r.providerPk],
        ["Deadline", `${when(r.deadline)}: whatever the job does not use comes back after it`],
        ["Escrow", r.address],
        ["Budget", `${money(budget.remainingSats, usd())} left in approved work`],
    ];
    $("payment-facts").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
    const checks = [
        [facts.escrowMatches, "The address is the escrow the job's terms build."],
        [facts.returnsHere, "Unused funds go back to this hive's treasury."],
        [r.capSats <= budget.remainingSats, "The amount fits what approved work has left."],
        [r.deadline > Date.now() / 1000 + 120, "The deadline leaves time to sign."],
    ];
    $("payment-checks").replaceChildren(...checks.map(([ok, text]) => el("li", { textContent: text, dataset: { ok: String(Boolean(ok)) } })));
    $("act").hidden = !role.action;
    $("act").textContent = role.label;
    $("act").disabled = !checks.every(([ok]) => ok);
    $("cancel-payment").hidden = !role.cancel;
    say("payment-msg", checks.every(([ok]) => ok) ? "" : "Something here does not add up. Do not sign; tell the other keepers in the hive's channel.");
    show("payment");
}

$("act").addEventListener("click", async (e) => {
    say("payment-msg", "");
    busy(e.target, true, "Checking and signing…");
    try {
        const out = await sitting.act(current);
        const status = out?.payment?.status;
        say("payment-msg", status === "submitted" ? "Signed. Both keepers have signed, and the payment is on its way to the escrow."
            : out?.payment?.first === sitting.me ? "Signed. The other keeper signs next; you sign once more after them."
            : "Signed. The other keeper finishes it.", false);
        e.target.hidden = true;
    } catch (err) {
        busy(e.target, false, "Check and sign");
        say("payment-msg", `${err.message}${err.code ? ` (${err.code})` : ""} Nothing was signed that could move funds.`);
    }
});
$("cancel-payment").addEventListener("click", async () => {
    try {
        await sitting.cancel(current.job.request.jobId);
        await showPayments();
    } catch (err) {
        say("payment-msg", err.message);
    }
});
$("back").addEventListener("click", () => showPayments().catch((err) => say("payments-msg", err.message)));
$("refresh").addEventListener("click", () => showPayments().catch((err) => say("payments-msg", err.message)));
$("lock").addEventListener("click", () => lockConsole("Locked."));
$("sign-listing").addEventListener("click", async () => {
    try {
        const { pending } = await sitting.overview().then((v) => ({ pending: v.listing }));
        await sitting.signListing(pending);
        await showPayments();
    } catch (err) {
        say("payments-msg", err.message);
    }
});

if (!window.PublicKeyCredential) {
    say("create-msg", NO_PRF);
    $("create").disabled = true;
}
show(stored() ? "key" : "start");
