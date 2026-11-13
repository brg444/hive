// The keeper console's second part: a keeper opens their hive's signing desk, sees the jobs waiting
// for funding, checks each payment here against the Operator and the job's own terms, and signs it.
// Two keepers sign each payment, hours apart if they like: whoever comes first signs at once, the
// second signs both remaining steps, and the first comes back once to finish.
//
// The key is unlocked with the passkey for one sitting and dropped when the keeper locks the console
// or leaves it idle. The nonces the console shares ahead of time stay on this device, encrypted under
// the same passkey, and each one is deleted before the signature that uses it.
import { nonceKeyFromPrf, openNonces, sealNonces } from "./vault.mjs";
import { checkSession, connection, deskAuth, escrowFacts, freshNonces, publicKeyOf, signFirst, signListing, signSecond, treasuryScriptOf } from "./signing.mjs";

const DESK = "hive-keeper/desk";
const IDLE_MS = 10 * 60 * 1000;
/** Below this many shared nonces the console shares a new batch. */
const LOW = 24;

const nf = new Intl.NumberFormat("en-US");
const sats = (n) => `${nf.format(n)} sats`;
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

    /** Shares a new batch of nonces when the desk is running low on this keeper's. */
    async topUp() {
        const info = await getJson(`${this.desk}/desk/v1/hive`);
        this.hive = { ...this.hive, nonces: info.nonces };
        if ((info.nonces?.[this.me] ?? 0) >= LOW) return;
        const { batch, secrets } = freshNonces(this.secret, 32);
        // Kept before they are shared: a nonce the desk holds always has its secret here.
        await this.keep([...(await this.kept()), ...secrets].slice(-256));
        await post(`${this.desk}/desk/v1/nonces`, { batch });
    }

    async overview() {
        this.touch();
        const [payments, listing] = await Promise.all([getJson(`${this.desk}/desk/v1/payments`), getJson(`${this.desk}/desk/v1/listing`)]);
        return { ...payments, listing: listing.pending };
    }

    /** What this keeper can do with a payment now, in plain words. */
    role(entry) {
        const p = entry.payment;
        if (!p || ["expired", "cancelled", "failed"].includes(p.status)) return { action: "start", label: "Check and sign" };
        const mine = (s) => Boolean(s?.partials?.[this.me]);
        const inPair = p.first === this.me || p.second === this.me;
        if (p.status === "submitted") return { action: null, label: "Signed by two keepers, on its way" };
        if (p.status === "done") return { action: null, label: "Funded" };
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
        return getJson(`${this.desk}/desk/v1/payments/${jobId}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    }

    /** Runs the checks on a session; the console signs only what this returns. */
    async check(session, remainingSats) {
        this.touch();
        return checkSession(this.conn, this.hive, session, remainingSats);
    }

    /**
     * The keeper's part, whatever it is now. A payment nobody started is started and its first step
     * signed; a second keeper signs both remaining steps in one sitting; a first keeper finishes it.
     */
    async act(entry) {
        this.touch();
        if (!this.secret) throw new Error("The console is locked. Unlock it with your passkey.");
        const jobId = entry.job.request.jobId;
        const { action } = this.role(entry);
        let state = entry.payment && !["expired", "cancelled", "failed"].includes(entry.payment.status) ? await this.detail(jobId) : null;
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
     * Never two plans for one job: once this keeper has signed a payment's last step, it signs no
     * other plan for that job until the first can no longer be registered.
     */
    guard(jobId, checked, stage) {
        const all = this.remembered();
        const seen = all[jobId];
        if (seen && seen.holder !== checked.holder && seen.register && seen.until > Math.floor(Date.now() / 1000))
            throw new Error("You already signed another payment for this job. It can be replaced once it lapses.");
        all[jobId] = { holder: checked.holder, until: checked.until, register: (seen?.holder === checked.holder && seen.register) || stage === "register" };
        write(`hive-keeper/signed/${this.label}`, all);
    }

    async signAsFirst(state, stage) {
        const session = state.sessions[stage];
        const pairSession = stage === "attest" ? state.payment.attest : state.payment.register;
        const checked = await this.check(session, state.payment.remainingSats);
        same(checked.messages, pairSession.messages);
        this.guard(state.payment.jobId, checked, stage);
        const { nonces, partials } = signFirst(pairSession, this.secret, checked.messages);
        return post(`${this.desk}/desk/v1/payments/${state.payment.jobId}/sign`, { keeper: this.me, stage, nonces, partials });
    }

    async signAsSecond(state, stage) {
        const session = state.sessions[stage];
        const pairSession = stage === "attest" ? state.payment.attest : state.payment.register;
        const checked = await this.check(session, state.payment.remainingSats);
        same(checked.messages, pairSession.messages);
        this.guard(state.payment.jobId, checked, stage);
        const ids = pairSession.pooled[this.me] ?? [];
        const kept = await this.kept();
        const using = kept.filter((n) => ids.includes(n.id));
        if (using.length !== ids.length) throw new Error("This device no longer has the nonces you shared for this payment. Ask the other keeper to cancel it and start again.");
        // A secret nonce signs once: it leaves this device's storage before the signature exists.
        await this.keep(kept.filter((n) => !ids.includes(n.id)));
        const partials = signSecond(pairSession, this.secret, checked.messages, using);
        return post(`${this.desk}/desk/v1/payments/${state.payment.jobId}/sign`, { keeper: this.me, stage, partials });
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

async function getJson(url) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
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

export { sats, when, short };
