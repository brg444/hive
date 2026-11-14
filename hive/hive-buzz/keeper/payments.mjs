// The keeper console's second part: a keeper opens their hive's signing desk, sees the jobs waiting
// for funding, checks each payment here against the Operator and the job's own terms, and signs it.
// Two keepers sign each payment, hours apart if they like: whoever comes first signs at once, the
// second signs both remaining steps, and the first comes back once to finish.
//
// The key is unlocked with the passkey for one sitting and dropped when the keeper locks the console
// or leaves it idle. The nonces the console shares ahead of time stay on this device, encrypted under
// the same passkey, and each one is deleted before the signature that uses it.
import { formatAmount, saveUnit, savedUnit, UNITS } from "../shared/amounts.mjs";
import { nonceKeyFromPrf, openNonces, sealNonces } from "./vault.mjs";
import { checkSession, connection, deskAuth, escrowFacts, freshNonces, publicKeyOf, signFirst, signListing, signSecond, treasuryScriptOf, withdrawalId, withdrawalScript } from "./signing.mjs";

const DESK = "hive-keeper/desk";
const IDLE_MS = 10 * 60 * 1000;
/** Below this many shared nonces the console shares a new batch. */
const LOW = 24;

const nf = new Intl.NumberFormat("en-US");
const sats = (n) => `${nf.format(n)} sats`;
// What the keeper reads amounts in, on this device: ₿ by default, or sats, BTC or US dollars.
let unit = savedUnit();
const setUnit = (u) => { unit = u; saveUnit(u); };
const getUnit = () => unit;
/** An amount in the keeper's unit. In dollars, an amount the keeper signs for also shows to the sat. */
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
    constructor(desk, secret, nonceKey, hive, conn) {
        this.desk = desk.replace(/\/+$/, "");
        this.secret = secret;
        this.nonceKey = nonceKey;
        this.hive = hive;
        this.conn = conn;
        this.me = publicKeyOf(secret);
        this.label = `${new URL(this.desk).origin}|${hive.hive}|${this.me}`;
        this.touch();
    }

    /** Opens the desk with an unlocked key: the hive must list this key among its keepers. */
    static async open(desk, secret, prf) {
        desk = desk.trim().replace(/\/+$/, "");
        if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(desk)) throw new Error("The desk's address starts with https://.");
        const hive = await getJson(`${desk}/desk/v1/hive`);
        const me = publicKeyOf(secret);
        if (!hive.keepers.includes(me)) throw new Error("This key is not one of this hive's keepers. Check you opened your own hive's desk, with the key you posted in its channel.");
        const conn = await connection(desk, hive);
        // The treasury this desk names is remembered the first time, and a desk that later names
        // another is refused: a keeper confirms the address once, against the one HiveBot posted.
        const pinned = `hive-keeper/treasury/${new URL(desk).origin}${new URL(desk).pathname}|${me}`;
        const seen = read(pinned);
        if (seen && seen !== hive.treasury.script) throw new Error("This desk now names another treasury than the one you signed for before. Nothing was signed; tell the other keepers.");
        if (!seen) write(pinned, hive.treasury.script);
        const sitting = new Sitting(desk, secret, await nonceKeyFromPrf(prf), hive, conn);
        // The treasury the keepers' keys build must be the hive's: a desk that relayed other keys fails here.
        if (treasuryScriptOf(conn, hive) !== hive.treasury.script) throw new Error("The keepers' keys build another treasury than the one this desk names.");
        write(DESK, desk);
        await sitting.topUp();
        return sitting;
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

    storeKey() {
        return `hive-keeper/nonces/${this.label}`;
    }

    async kept() {
        return openNonces(this.nonceKey, this.label, read(this.storeKey()));
    }

    async keep(secrets) {
        write(this.storeKey(), await sealNonces(this.nonceKey, this.label, secrets));
    }

    /**
     * One change to the kept nonces at a time, in this tab and across this browser's tabs: they are
     * read, changed and written back as one step, so a nonce taken out to sign is never put back by
     * a step that read the list before it left.
     */
    changeNonces(change) {
        const step = () => {
            const next = (this.nonceTail ?? Promise.resolve()).then(async () => {
                const { keep, result } = await change(await this.kept());
                if (keep) await this.keep(keep);
                return result;
            });
            this.nonceTail = next.catch(() => {});
            return next;
        };
        const locks = globalThis.navigator?.locks;
        return locks ? locks.request(`hive-keeper/nonces/${this.label}`, step) : step();
    }

    /** What the desk shows only to a keeper is asked for with this keeper's signature. */
    read(path) {
        if (!this.secret) throw new Error("The console is locked. Unlock it with your passkey.");
        const { keeper, at, signature } = deskAuth(this.secret, this.hive.hive, "read", "");
        return getJson(`${this.desk}/desk/v1/${path}`, { "x-hive-keeper": `${keeper}.${at}.${signature}` });
    }

    /** Shares a new batch of nonces when the desk is running low on this keeper's. */
    async topUp() {
        const info = await getJson(`${this.desk}/desk/v1/hive`);
        this.hive = { ...this.hive, nonces: info.nonces, price: info.price ?? this.hive.price ?? null };
        if ((info.nonces?.[this.me] ?? 0) >= LOW) return;
        const { batch, secrets } = freshNonces(this.secret, 32);
        // Kept before they are shared: a nonce the desk holds always has its secret here.
        await this.changeNonces((kept) => ({ keep: [...kept, ...secrets].slice(-256) }));
        await post(`${this.desk}/desk/v1/nonces`, { batch });
    }

    async overview() {
        this.touch();
        const [payments, listing] = await Promise.all([this.read("payments"), this.read("listing")]);
        return { ...payments, listing: listing.pending };
    }

    /** What this keeper can do with a payment now, in plain words. */
    role(entry) {
        const p = entry.payment;
        const mine = (s) => Boolean(s?.partials?.[this.me]);
        if (p?.withdrawal && ["expired", "cancelled", "failed"].includes(p.status))
            return { action: null, label: p.status === "cancelled" ? "Cancelled" : p.status === "expired" ? "Lapsed before two keepers signed" : "Did not go through" };
        if (!p || ["expired", "cancelled", "failed"].includes(p.status)) {
            // A keeper who signed an earlier payment for this job signs no other for it (see guard):
            // starting one would only be refused, so it is not offered.
            const signedBefore = Boolean(this.remembered()[entry.job.request.jobId]) || mine(p?.attest) || mine(p?.register) || Boolean(p?.signedBefore?.includes(this.me));
            if (signedBefore) return { action: null, label: "You signed an earlier payment for this job, which did not go through. Two keepers who did not can fund it; otherwise the hive's agent asks for the job again after its deadline" };
            return { action: "start", label: "Check and sign" };
        }
        const inPair = p.first === this.me || p.second === this.me;
        if (p.status === "submitted") return { action: null, label: "Signed by two keepers, on its way" };
        if (p.status === "done") return { action: null, label: p.withdrawal ? "Paid" : "Funded" };
        if (!inPair) return { action: null, label: `Two other keepers are signing it` };
        if (p.status === "attesting") {
            if (p.second === this.me && !mine(p.attest)) return { action: "second", label: "Check and sign" };
            if (p.first === this.me && !mine(p.attest)) return { action: "first-attest", label: "Check and sign" };
            return { action: null, label: "Waiting for the other keeper", cancel: true };
        }
        if (p.status === "registering") {
            if (p.second === this.me && !mine(p.register)) return { action: "second-register", label: "Check and sign" };
            if (p.first === this.me && p.register?.partials?.[p.second] && !mine(p.register)) return { action: "finish", label: "Finish: sign once more" };
            return { action: null, label: "Waiting for the other keeper", cancel: true };
        }
        return { action: null, label: p.status };
    }

    facts(request) {
        return escrowFacts(this.conn, this.hive, request);
    }

    async detail(jobId) {
        return this.read(`payments/${jobId}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    }

    /** Runs the checks on a session; the console signs only what this returns. */
    async check(session, shown, remainingSats) {
        this.touch();
        return checkSession(this.conn, this.hive, session, shown, remainingSats);
    }

    /**
     * The keeper's part, whatever it is now. A payment nobody started is started and its first step
     * signed; a second keeper signs both remaining steps in one sitting; a first keeper finishes it.
     */
    async act(entry) {
        this.touch();
        if (!this.secret) throw new Error("The console is locked. Unlock it with your passkey.");
        const jobId = entry.payment?.jobId ?? entry.job.request.jobId;
        const { action } = this.role(entry);
        let state = entry.payment && !["expired", "cancelled", "failed"].includes(entry.payment.status) ? await this.detail(jobId) : null;
        // What the keeper read on screen is what every step below must carry: the job's request, or
        // a withdrawal's address and amount.
        this.shown = entry.payment?.withdrawal ?? entry.job.request;
        if (action === "start") {
            await this.topUp();
            state = await post(`${this.desk}/desk/v1/payments/${jobId}/start`, { auth: deskAuth(this.secret, this.hive.hive, "start", jobId) });
            state = await this.signAsFirst(state, "attest");
            return state;
        }
        if (action === "first-attest") return this.signAsFirst(state, "attest");
        if (action === "second") {
            state = await this.signAsSecond(state, "attest");
            return this.signAsFirst(state, "register");
        }
        if (action === "second-register") return this.signAsFirst(state, "register");
        if (action === "finish") return this.signAsSecond(state, "register");
        return state;
    }

    remembered() {
        return read(`hive-keeper/signed/${this.label}`) ?? {};
    }

    /**
     * The agent key this keeper last signed for, when this job names another. The agent's key signs
     * the receipts that pay a job's provider, so a job that names a new one is shown to the keeper
     * before anything is signed: a hive changes its agent node rarely, and says so in its channel.
     */
    agentChanged(request) {
        const seen = read(`hive-keeper/agent/${this.label}`);
        return seen && seen !== request.params?.agentPk ? seen : null;
    }

    /** The keeper confirmed the hive's new agent key. */
    acceptAgent(request) {
        write(`hive-keeper/agent/${this.label}`, request.params.agentPk);
    }

    /**
     * Never two plans for one job. A pair's attestations alone can move the coins, so the job is
     * bound to the first plan this keeper signs anything for, and for good, as a steward binds it: a
     * job whose payment lapsed is asked for again by the agent, as a new job.
     */
    guard(jobId, checked, stage) {
        const all = this.remembered();
        const seen = all[jobId];
        if (seen && seen.holder !== checked.holder)
            throw new Error("You already signed another payment for this job, so you sign no other for it. If it lapsed, the hive's agent asks for the job again.");
        const request = this.shown;
        if (request?.params && this.agentChanged(request)) throw new Error("This job names another agent key than the one you signed for before. Confirm the hive's new agent with the other keepers first.");
        all[jobId] = { holder: checked.holder, until: checked.until, stages: [...new Set([...(seen?.stages ?? []), stage])] };
        write(`hive-keeper/signed/${this.label}`, all);
        if (request?.params?.agentPk) this.acceptAgent(request);
    }

    async signAsFirst(state, stage) {
        const session = state.sessions[stage];
        const pairSession = stage === "attest" ? state.payment.attest : state.payment.register;
        const checked = await this.check(session, this.shown ?? state.payment.request, state.payment.remainingSats);
        same(checked.messages, pairSession.messages);
        this.guard(state.payment.jobId, checked, stage);
        const { nonces, partials } = signFirst(pairSession, this.secret, checked.messages);
        return post(`${this.desk}/desk/v1/payments/${state.payment.jobId}/sign`, { keeper: this.me, stage, nonces, partials });
    }

    async signAsSecond(state, stage) {
        const session = state.sessions[stage];
        const pairSession = stage === "attest" ? state.payment.attest : state.payment.register;
        const checked = await this.check(session, this.shown ?? state.payment.request, state.payment.remainingSats);
        same(checked.messages, pairSession.messages);
        this.guard(state.payment.jobId, checked, stage);
        const ids = pairSession.pooled[this.me] ?? [];
        // A secret nonce signs once: it leaves this device's storage before the signature exists.
        const using = await this.changeNonces((kept) => {
            const found = kept.filter((n) => ids.includes(n.id));
            if (found.length !== ids.length) throw new Error("This device no longer has the nonces you shared for this payment. Ask the other keeper to cancel it and start again.");
            return { keep: kept.filter((n) => !ids.includes(n.id)), result: found };
        });
        const partials = signSecond(pairSession, this.secret, checked.messages, using);
        return post(`${this.desk}/desk/v1/payments/${state.payment.jobId}/sign`, { keeper: this.me, stage, partials });
    }

    /**
     * Starts a withdrawal from the treasury to an Arkade address and signs its first step. The other
     * keeper reads the same address and amount in their own console before signing.
     */
    async startWithdrawal(address, amountSats) {
        this.touch();
        if (!this.secret) throw new Error("The console is locked. Unlock it with your passkey.");
        address = String(address).trim().toLowerCase();
        if (!Number.isSafeInteger(amountSats) || amountSats <= 0) throw new Error("The amount is a whole number of sats.");
        const destination = withdrawalScript(this.conn, address);
        if (destination === this.hive.treasury.script) throw new Error("This is the treasury's own address.");
        await this.topUp();
        const at = Math.floor(Date.now() / 1000);
        const id = withdrawalId(this.hive.hive, destination, amountSats, at);
        const state = await post(`${this.desk}/desk/v1/withdrawals`, { auth: deskAuth(this.secret, this.hive.hive, "withdraw", id, at), address, amountSats });
        // The desk's record must be the withdrawal this keeper asked for and nothing else.
        const opened = state.payment?.withdrawal;
        if (state.payment?.jobId !== id || opened?.destination !== destination || opened?.amountSats !== amountSats)
            throw new Error("The desk opened another withdrawal than the one you asked for. Nothing was signed.");
        this.shown = opened;
        return this.signAsFirst(state, "attest");
    }

    /** Whether the address a withdrawal shows is the script it pays, by this console's own reading of it. */
    withdrawalMatches(payment) {
        try { return withdrawalScript(this.conn, payment.address) === payment.withdrawal.destination; } catch { return false; }
    }

    async cancel(jobId) {
        return post(`${this.desk}/desk/v1/payments/${jobId}/cancel`, { auth: deskAuth(this.secret, this.hive.hive, "cancel", jobId) });
    }

    async signListing(pending) {
        return post(`${this.desk}/desk/v1/listing`, { keeper: this.me, signature: signListing(this.secret, pending.listingId) });
    }
}

function same(a, b) {
    const hex = (m) => (typeof m === "string" ? m : Array.from(m, (x) => x.toString(16).padStart(2, "0")).join(""));
    if (a.length !== b.length || a.some((m, i) => hex(m) !== hex(b[i]))) throw new Error("The desk's session does not match this payment. Nothing was signed.");
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
