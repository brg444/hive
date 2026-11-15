// The keeper console's second part: a keeper opens their hive's desk, sees the jobs waiting for
// funding, checks each payment here against the Operator and the job's own terms, and approves it
// with their passkey. Two keepers approve each payment, hours apart if they like and in any order;
// the desk pays it once both are in.
//
// The keeper's Bitcoin key, which the desk knows them by, is derived from the passkey for one sitting
// and dropped when the keeper locks the console or leaves it idle. An approval is the passkey's own
// signature over the payment's message, which the console rebuilds itself from what the keeper read.
import { formatAmount, saveUnit, savedUnit, UNITS } from "../shared/amounts.mjs";
import { approveWith } from "./passkey.mjs";
import { approvalMessage, bitcoinSecret, connection, deskAuth, escrowFacts, publicKeyOf, treasuryScriptOf, withdrawalId, withdrawalScript } from "./signing.mjs";

const DESK = "hive-keeper/desk";
const IDLE_MS = 10 * 60 * 1000;
/** A payment the keeper approves must leave the other keepers this long. */
const MIN_LEFT_SECONDS = 120;

const nf = new Intl.NumberFormat("en-US");
const sats = (n) => `${nf.format(n)} sats`;
// What the keeper reads amounts in, on this device: ₿ by default, or sats, BTC or US dollars.
let unit = savedUnit();
const setUnit = (u) => { unit = u; saveUnit(u); };
const getUnit = () => unit;
/** An amount in the keeper's unit. In dollars, an amount the keeper approves also shows to the sat. */
function money(n, price, signed = false) {
    const shown = formatAmount(n, unit, price);
    return signed && unit === "usd" && price > 0 ? `${shown} (${formatAmount(n, "bitcoin")})` : shown;
}
const when = (t) => new Date(t * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
const short = (k) => `${k.slice(0, 8)}…${k.slice(-6)}`;

function read(key) {
    try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}
function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

export function savedDesk() {
    return new URL(location.href).searchParams.get("desk") ?? read(DESK) ?? "";
}

/** One unlocked sitting at the hive's desk. */
export class Sitting {
    constructor(desk, secret, passkey, hive, conn) {
        this.desk = desk.replace(/\/+$/, "");
        this.secret = secret;
        this.passkey = passkey;
        this.hive = hive;
        this.conn = conn;
        this.me = publicKeyOf(secret);
        this.index = hive.keepers.indexOf(this.me);
        this.label = `${new URL(this.desk).origin}|${hive.hive}|${this.me}`;
        this.touch();
    }

    /** Opens the desk with the keeper's Bitcoin key, from their passkey: the hive must list it. */
    static async open(desk, prf, passkey) {
        desk = desk.trim().replace(/\/+$/, "");
        if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(desk)) throw new Error("The desk's address starts with https://.");
        const hive = await getJson(`${desk}/desk/v1/hive`);
        if (hive.version !== 5) throw new Error("This hive's keepers sign with keys of their own, in an earlier console. This console approves with passkeys.");
        const secret = bitcoinSecret(prf);
        const me = publicKeyOf(secret);
        const at = hive.keepers.indexOf(me);
        if (at < 0) throw new Error("This passkey is not one of this hive's keepers. Check you opened your own hive's desk, with the passkey whose line you posted in its channel.");
        const mine = hive.passkeys[at];
        if (mine.site !== location.hostname) throw new Error(`Your passkey belongs to ${mine.site}: approve this hive's payments in the console there.`);
        if (passkey.key && mine.key !== passkey.key) throw new Error("The hive lists another passkey for you than this one. Nothing was approved; tell the other keepers.");
        const conn = await connection(desk, hive);
        // The treasury this desk names is remembered the first time, and a desk that later names
        // another is refused: a keeper confirms the address once, against the one HiveBot posted.
        const pinned = `hive-keeper/treasury/${new URL(desk).origin}${new URL(desk).pathname}|${me}`;
        const seen = read(pinned);
        if (seen && seen !== hive.treasury.script) throw new Error("This desk now names another treasury than the one you approved for before. Nothing was approved; tell the other keepers.");
        // The treasury the keepers' keys build must be the hive's: a desk that relayed other keys fails here.
        if (treasuryScriptOf(conn, hive) !== hive.treasury.script) throw new Error("The keepers' keys build another treasury than the one this desk names.");
        if (!seen) write(pinned, hive.treasury.script);
        write(DESK, desk);
        return new Sitting(desk, secret, passkey, hive, conn);
    }

    touch() {
        clearTimeout(this.idle);
        this.idle = setTimeout(() => this.lock(), IDLE_MS);
    }

    lock() {
        clearTimeout(this.idle);
        this.secret?.fill(0);
        this.secret = null;
        this.onLock?.();
    }

    /** What the desk shows only to a keeper is asked for with this keeper's signature. */
    read(path) {
        if (!this.secret) throw new Error("The console is locked. Unlock it with your passkey.");
        const { keeper, at, signature } = deskAuth(this.secret, this.hive.hive, "read", "");
        return getJson(`${this.desk}/desk/v1/${path}`, { "x-hive-keeper": `${keeper}.${at}.${signature}` });
    }

    async overview() {
        this.touch();
        const info = await getJson(`${this.desk}/desk/v1/hive`);
        this.hive = { ...this.hive, price: info.price ?? this.hive.price ?? null };
        return this.read("payments");
    }

    /** What this keeper can do with a payment now, in plain words. */
    role(entry) {
        const p = entry.payment;
        const done = { done: p?.withdrawal ? "Paid" : "Funded", lapsed: "Lapsed before two keepers approved", cancelled: "Cancelled", failed: `Did not go through${p?.detail ? `: ${p.detail}` : ""}` };
        if (p && done[p.status] && (p.withdrawal || p.status === "done")) return { action: null, label: done[p.status] };
        if (!p || ["lapsed", "cancelled", "failed"].includes(p.status)) {
            const earlier = this.approvedBefore(entry.job.request.jobId);
            if (earlier) return { action: null, label: `You approved an earlier payment for this job, which can still pay until ${when(earlier.validUntil)}. Approve a new one after that` };
            return { action: "start", label: "Check and approve" };
        }
        if (p.status === "submitted") return { action: null, label: "Approved by two keepers, on its way" };
        if (p.approved[this.index]) return { action: null, label: p.status === "ready" ? "Approved by two keepers, waiting its turn" : "You approved. Waiting for another keeper", cancel: true };
        return { action: "approve", label: p.status === "ready" ? "Approve too" : "Check and approve", cancel: true };
    }

    facts(request) {
        return escrowFacts(this.conn, this.hive, request);
    }

    /** The approvals this keeper made on this device, by payment: a payment approved is never approved under another number while that approval can pay. */
    remembered() {
        return read(`hive-keeper/approved/${this.label}`) ?? {};
    }

    approvedBefore(id, left) {
        const seen = this.remembered()[id];
        return seen && seen.left !== left && seen.validUntil > Date.now() / 1000 ? seen : null;
    }

    /**
     * The agent key this keeper last approved for, when this job names another. The agent's key signs
     * the receipts that pay a job's provider, so a job that names a new one is shown to the keeper
     * before anything is approved: a hive changes its agent node rarely, and says so in its channel.
     */
    agentChanged(request) {
        const seen = read(`hive-keeper/agent/${this.label}`);
        return seen && seen !== request.params?.agentPk ? seen : null;
    }

    acceptAgent(request) {
        write(`hive-keeper/agent/${this.label}`, request.params.agentPk);
    }

    /**
     * Checks a payment as the keeper read it and returns the program its output must pay: a job's
     * escrow as its terms build it, or a withdrawal's address as this console reads it.
     */
    check(payment, shown) {
        const now = Date.now() / 1000;
        if (payment.validUntil < now + MIN_LEFT_SECONDS) throw new Error("This payment lapses too soon for another keeper to approve it.");
        if (payment.withdrawal) {
            const destination = withdrawalScript(this.conn, payment.address);
            if (destination !== payment.withdrawal.destination || destination.slice(4) !== payment.program || payment.amountSats !== shown.amountSats)
                throw new Error("The desk's withdrawal does not match the address and amount you read. Nothing was approved.");
            if (payment.validUntil > now + 24 * 3600) throw new Error("This withdrawal's approval would last more than a day.");
            return payment.program;
        }
        const request = shown;
        const facts = this.facts(request);
        if (!facts.escrowMatches || !facts.returnsHere) throw new Error("The escrow is not the one this job's terms build, or it does not return to this treasury.");
        if (payment.id !== request.jobId || payment.program !== facts.program || payment.amountSats !== request.capSats)
            throw new Error("The desk's payment is not this job's escrow and cap. Nothing was approved.");
        if (payment.validUntil > request.deadline) throw new Error("This payment's approval would outlast the job's deadline.");
        if (payment.validUntil > now + 24 * 3600) throw new Error("This payment's approval would last more than a day.");
        return facts.program;
    }

    /** The keeper's part, whatever it is now: start the payment if nobody has, then approve it. */
    async act(entry) {
        this.touch();
        if (!this.secret) throw new Error("The console is locked. Unlock it with your passkey.");
        const { action } = this.role(entry);
        let payment = entry.payment;
        const id = payment?.id ?? entry.job.request.jobId;
        if (action === "start") {
            payment = (await post(`${this.desk}/desk/v1/payments/${id}/start`, { auth: deskAuth(this.secret, this.hive.hive, "start", id) })).payment;
        }
        return this.approve(payment, payment.withdrawal ? { amountSats: payment.withdrawal.amountSats } : entry.job.request);
    }

    async approve(payment, shown) {
        const program = this.check(payment, shown);
        const earlier = this.approvedBefore(payment.id, payment.left);
        if (earlier) throw new Error(`You approved this payment before under another number, and that approval can pay until ${when(earlier.validUntil)}. Nothing was approved.`);
        if (!payment.withdrawal && this.agentChanged(shown)) throw new Error("This job names another agent key than the one you approved for before. Confirm the hive's new agent with the other keepers first.");
        const message = approvalMessage(this.hive, payment, program);
        // Remembered before the passkey signs: an approval this device made is always on record here.
        write(`hive-keeper/approved/${this.label}`, { ...this.remembered(), [payment.id]: { left: payment.left, validUntil: payment.validUntil } });
        if (!payment.withdrawal && shown.params?.agentPk) this.acceptAgent(shown);
        const assertion = await approveWith(this.passkey.credentialId, message);
        return post(`${this.desk}/desk/v1/payments/${payment.id}/approve`, { assertion });
    }

    /**
     * Starts a withdrawal from the treasury to an Arkade address and approves it. The other keeper
     * reads the same address and amount in their own console before approving.
     */
    async startWithdrawal(address, amountSats) {
        this.touch();
        if (!this.secret) throw new Error("The console is locked. Unlock it with your passkey.");
        address = String(address).trim().toLowerCase();
        if (!Number.isSafeInteger(amountSats) || amountSats <= 0) throw new Error("The amount is a whole number of sats.");
        const destination = withdrawalScript(this.conn, address);
        if (destination === this.hive.treasury.script) throw new Error("This is the treasury's own address.");
        const at = Math.floor(Date.now() / 1000);
        const id = withdrawalId(this.hive.hive, destination, amountSats, at);
        const { payment } = await post(`${this.desk}/desk/v1/withdrawals`, { auth: deskAuth(this.secret, this.hive.hive, "withdraw", id, at), address, amountSats });
        if (payment?.id !== id || payment.withdrawal?.destination !== destination || payment.withdrawal?.amountSats !== amountSats)
            throw new Error("The desk opened another withdrawal than the one you asked for. Nothing was approved.");
        return this.approve(payment, { amountSats });
    }

    /** Whether the address a withdrawal shows is the script it pays, by this console's own reading of it. */
    withdrawalMatches(payment) {
        try { return withdrawalScript(this.conn, payment.address) === payment.withdrawal.destination; } catch { return false; }
    }

    async cancel(id) {
        return post(`${this.desk}/desk/v1/payments/${id}/cancel`, { auth: deskAuth(this.secret, this.hive.hive, "cancel", id) });
    }
}

async function getJson(url, headers = {}) {
    const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.detail || body.error || `The desk answered ${res.status}.`), { status: res.status, code: body.error });
    return body;
}

async function post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.detail || out.error || `The desk answered ${res.status}.`), { status: res.status, code: out.error });
    return out;
}

export { getUnit, money, sats, setUnit, short, UNITS, when };
