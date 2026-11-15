// The keeper console: a keeper creates their keeper passkey here and gets the line to post in the
// hive's channel; later, they open their hive's desk here and approve its payments with the same
// passkey. Nothing secret is kept in the page or the browser: the passkey stays in the keeper's
// password manager, and the page talks only to the desk and the Arkade Operator.
import { adoptPasskey, createPasskey, forget, lineOf, NO_PRF, passkeySecret, stored } from "./passkey.mjs";
import { getUnit, money, savedDesk, setUnit, short, Sitting, UNITS, when } from "./payments.mjs";

const $ = (id) => document.getElementById(id);

function show(view) {
    for (const el of document.querySelectorAll("[data-view]")) el.hidden = el.dataset.view !== view;
    const key = stored();
    if (key) {
        const line = lineOf(key);
        $("line-box").hidden = !line;
        $("line").textContent = line ?? "";
        $("no-line").hidden = Boolean(line);
        $("created").textContent = new Date(key.created).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
        $("site").textContent = key.site;
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

const cancelled = (err, what) => (err.name === "NotAllowedError" ? `The passkey was cancelled. ${what}` : err.message);

$("create").addEventListener("click", async (e) => {
    say("create-msg", "");
    busy(e.target, true, "Waiting for your passkey…");
    try {
        await createPasskey();
        show("key");
    } catch (err) {
        say("create-msg", cancelled(err, "Nothing was created."));
    } finally {
        busy(e.target, false, "Create my keeper passkey");
    }
});

$("adopt").addEventListener("click", async (e) => {
    say("create-msg", "");
    busy(e.target, true, "Waiting for your passkey…");
    try {
        await adoptPasskey();
        show("key");
    } catch (err) {
        say("create-msg", cancelled(err, ""));
    } finally {
        busy(e.target, false, "I made my passkey on another device");
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

$("remove").addEventListener("click", () => {
    if (!confirm("Forget the passkey in this browser? The passkey itself stays in your password manager, and this console finds it again with “I made my passkey on another device”.")) return;
    forget();
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
        const passkey = stored();
        const { prf } = await passkeySecret(passkey.credentialId);
        busy(button, true, "Opening the desk…");
        sitting = await Sitting.open($("desk-url").value, prf, passkey);
        prf.fill(0);
        sitting.onLock = () => { if (sitting) lockConsole("The console locked itself after ten idle minutes."); };
        await showPayments();
    } catch (err) {
        say("desk-msg", cancelled(err, ""));
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
    const withdrawals = $("withdrawal-list");
    withdrawals.replaceChildren();
    for (const entry of view.withdrawals ?? []) {
        const p = entry.payment;
        const role = sitting.role(entry);
        const open = el("button", { className: role.action ? "primary" : "quiet", type: "button", textContent: role.action ? role.label : "Details" });
        open.addEventListener("click", () => showWithdrawal(entry));
        withdrawals.append(el("li", {},
            el("div", { className: "row" }, el("b", { textContent: `Withdraw ${money(p.amountSats, usd())}` }), open),
            el("span", { className: "note", textContent: `${role.action ? "" : `${role.label}. `}To ${short(p.address)}, started ${when(p.createdAt)}.` })));
    }
    show("payments");
}

const JOB_NOTE = $("payment-note").textContent;

/** Who approved a payment so far, for the keeper to read. */
function approvedBy(p) {
    const names = p.approved.map((yes, i) => (yes ? (i === sitting.index ? "you" : `keeper ${i + 1}`) : null)).filter(Boolean);
    return names.length ? names.join(" and ") : "nobody yet";
}

/** A withdrawal on screen: where the treasury pays and how much, for the keeper to read before approving. */
function showWithdrawal(entry) {
    current = entry;
    const p = entry.payment;
    const role = sitting.role(entry);
    $("payment-title").textContent = "Withdraw from the treasury";
    $("payment-note").textContent = "Two keepers approve a withdrawal. Your console works out what the address pays itself, and your passkey approves that address and amount only.";
    $("payment-lead").textContent = role.action
        ? "A keeper asks the treasury to pay this address. Approve only if the keepers agreed on it in the hive's channel: the whole address, to its last character, and the amount."
        : `${role.label}.`;
    const rows = [
        ["Amount", money(p.amountSats, usd(), true)],
        ["To", p.address],
        ["Started by", p.startedBy === sitting.me ? "you" : short(p.startedBy)],
        ["Approved by", approvedBy(p)],
        ["Until", `${when(p.validUntil)}: without two approvals by then, it lapses`],
    ];
    $("payment-facts").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
    const checks = [
        [sitting.withdrawalMatches(p), "The address shown is the one this withdrawal pays."],
        [p.validUntil > Date.now() / 1000 + 120, "There is time left to approve."],
    ];
    $("payment-checks").replaceChildren(...checks.map(([ok, text]) => el("li", { textContent: text, dataset: { ok: String(Boolean(ok)) } })));
    const sound = checks.every(([ok]) => ok);
    $("act").hidden = !role.action;
    $("act").textContent = role.label;
    $("act").disabled = !sound;
    $("cancel-payment").hidden = !role.cancel;
    say("payment-msg", sound || !role.action ? "" : "Something here does not add up. Do not approve; tell the other keepers in the hive's channel.");
    show("payment");
}

$("withdraw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    say("withdraw-msg", "");
    const address = $("w-address").value.trim();
    const amount = Number($("w-amount").value);
    if (!confirm(`Withdraw ${money(amount, usd(), true)} from the treasury to\n\n${address}\n\nAnother keeper must read and approve the same address and amount. Go on only if the keepers agreed on this in the hive's channel.`)) return;
    const button = e.target.querySelector("button[type=submit]");
    busy(button, true, "Checking…");
    try {
        await sitting.startWithdrawal(address, amount);
        e.target.reset();
        $("withdraw").open = false;
        await showPayments();
        say("payments-msg", "Approved. Another keeper approves next, and the treasury pays.", false);
    } catch (err) {
        say("withdraw-msg", `${cancelled(err, "Nothing was approved.")}${err.code ? ` (${err.code})` : ""}`);
    } finally {
        busy(button, false, "Check and approve the withdrawal");
    }
});

function showPayment(entry, budget) {
    current = entry;
    $("payment-title").textContent = "Fund a job";
    $("payment-note").textContent = JOB_NOTE;
    const r = entry.job.request;
    const p = entry.payment;
    const role = sitting.role(entry);
    const facts = sitting.facts(r);
    $("payment-lead").textContent = role.action
        ? "The hive's agent asks the keepers to fund this job. Check the details, then approve; your console checks the rest itself."
        : `${role.label}.`;
    const rows = [
        ["Amount", `${money(r.capSats, usd(), true)}, the job's cap`],
        ["Model", r.model],
        ["Price", `${money(Math.round(r.priceMsatPerMtok / 1000), usd())} per million tokens`],
        ["Provider", r.providerPk],
        ["Agent", `${r.params?.agentPk ?? "not named"}: the key that signs this job's receipts`],
        ["Deadline", `${when(r.deadline)}: whatever the job does not use comes back after it`],
        ["Escrow", r.address],
        ["Budget", `${money(budget.remainingSats, usd())} left in approved work, as the hive's desk counts it`],
        ...(p ? [["Approved by", approvedBy(p)], ["Payment", `number ${p.left}, approvals lapse ${when(p.validUntil)}`]] : []),
    ];
    $("payment-facts").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
    const checks = [
        [facts.escrowMatches, "The address is the escrow the job's terms build."],
        [facts.returnsHere, "Unused funds go back to this hive's treasury."],
        [r.capSats <= budget.remainingSats, "The amount fits what approved work has left, by the desk's count: check the proposal in the hive's channel."],
        [!sitting.agentChanged(r), "The agent's key is the one you approved for before, or you confirm the new one when you approve."],
        [r.deadline > Date.now() / 1000 + 120, "The deadline leaves time to approve."],
    ];
    $("payment-checks").replaceChildren(...checks.map(([ok, text]) => el("li", { textContent: text, dataset: { ok: String(Boolean(ok)) } })));
    $("act").hidden = !role.action;
    $("act").textContent = role.label;
    // A new agent key is the keeper's to confirm; anything else that fails is not approved at all.
    const sound = checks.every(([ok], i) => ok || i === 3);
    $("act").disabled = !sound;
    $("cancel-payment").hidden = !role.cancel;
    say("payment-msg", !sound ? "Something here does not add up. Do not approve; tell the other keepers in the hive's channel."
        : sitting.agentChanged(r) ? "This job names a new agent key. Approve only if the hive changed its agent node and said so in its channel." : "");
    show("payment");
}

$("act").addEventListener("click", async (e) => {
    say("payment-msg", "");
    const before = current.job ? sitting.agentChanged(current.job.request) : null;
    if (before) {
        if (!confirm(`This job's receipts are signed by a new agent key.\n\nBefore: ${before}\nNow: ${current.job.request.params.agentPk}\n\nApprove only if the hive changed its agent node and said so in its channel.`)) return;
        sitting.acceptAgent(current.job.request);
    }
    busy(e.target, true, "Waiting for your passkey…");
    try {
        const out = await sitting.act(current);
        const status = out?.payment?.status;
        say("payment-msg", status === "ready" ? `Approved. Two keepers have approved, and the desk sends the payment${current.payment?.withdrawal ? "" : " to the escrow"}.`
            : "Approved. Another keeper approves next.", false);
        e.target.hidden = true;
    } catch (err) {
        busy(e.target, false, "Check and approve");
        say("payment-msg", `${cancelled(err, "")}${err.code ? ` (${err.code})` : ""} Nothing was approved.`);
    }
});
$("cancel-payment").addEventListener("click", async () => {
    try {
        await sitting.cancel(current.payment.id);
        await showPayments();
    } catch (err) {
        say("payment-msg", err.message);
    }
});
$("back").addEventListener("click", () => showPayments().catch((err) => say("payments-msg", err.message)));
$("refresh").addEventListener("click", () => showPayments().catch((err) => say("payments-msg", err.message)));
$("lock").addEventListener("click", () => lockConsole("Locked."));

if (!window.PublicKeyCredential) {
    say("create-msg", NO_PRF);
    $("create").disabled = true;
}
show(stored() ? "key" : "start");
