// The hive's state as a Hive plugin shows it, derived from sources the hive already has:
// the agent's pay-arkade event log (jobs, funding requests, claims and returns), the Arkade
// indexer (the treasury's balance) and the LNURL server (chip-ins to the hive's address).
// Everything here is read-only; nothing in this service holds a key.
import { bech32m, hex } from "@scure/base";

/** An Arkade address's output script: version-1 witness program of its taproot key. */
export function arkadePkScript(address) {
    const { words } = bech32m.decode(address, 1023);
    const bytes = bech32m.fromWords(words);
    if (bytes.length !== 65) throw new Error("not an Arkade address");
    return "5120" + hex.encode(bytes.slice(33, 65));
}

/**
 * Jobs from the agent's event log, newest first. The log is append-only JSON lines written by
 * pay-arkade running as buyer; unknown or malformed lines are skipped.
 */
export function jobsFromLog(text, now = Math.floor(Date.now() / 1000)) {
    const jobs = new Map();
    const job = (id) => {
        if (!jobs.has(id)) jobs.set(id, { jobId: id, status: "offered", usedSats: 0, events: 0 });
        return jobs.get(id);
    };
    for (const line of text.split("\n")) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || typeof e !== "object") continue;
        const m = e.message ?? {};
        if (e.event === "sent" && m.kind === "offer") {
            Object.assign(job(m.job_id), { model: m.model, capSats: m.cap_sats, deadline: m.deadline, providerPeer: e.to, offeredAt: e.at });
        } else if (e.event === "funding_requested" && e.request) {
            const r = e.request;
            Object.assign(job(r.job_id), {
                status: "awaiting_funding", escrowAddress: r.address, capSats: r.cap_sats, deadline: r.deadline,
                minCoinExpiry: r.min_coin_expiry ?? null, model: r.model, priceMsatPerMtok: r.price_msat_per_mtok,
                providerPeer: r.provider_peer, providerPk: r.provider_pk, requestedAt: e.at,
                ...(r.params ? { escrowParams: r.params } : {}),
            });
        } else if (e.event === "job_open") {
            Object.assign(job(e.job_id), { status: "open", openedAt: e.at });
        } else if (e.event === "receipt_signed") {
            const j = job(e.job_id);
            j.usedSats = Math.max(j.usedSats, e.amount_sats ?? 0);
        } else if (e.event === "job_closed") {
            Object.assign(job(e.job_id), e.txid
                ? { status: "claimed", paidSats: e.paid_sats, returnedSats: e.returned_sats, txid: e.txid, closedAt: e.at }
                : { status: "closing", closedAt: e.at });
        } else if (e.event === "expired") {
            Object.assign(job(e.job_id), { status: "returned", returnedSats: e.returned_sats, txid: e.txid ?? null, closedAt: e.at });
        } else if (e.event === "received" && m.kind === "decline") {
            const j = job(m.job_id);
            if (j.status === "offered" || j.status === "awaiting_funding") Object.assign(j, { status: "declined", note: m.reason });
        }
    }
    const out = [...jobs.values()].filter((j) => j.capSats !== undefined);
    for (const j of out) {
        delete j.events;
        // A request nobody funded before the provider stopped waiting is no longer actionable.
        if (j.status === "awaiting_funding" && j.deadline && now >= j.deadline) j.status = "lapsed";
    }
    return out.sort((a, b) => (b.offeredAt ?? b.requestedAt ?? 0) - (a.offeredAt ?? a.requestedAt ?? 0));
}

/**
 * Usage of approved budgets per proposal, from the agent's `member_usage` events. Per-member figures
 * stay out of this public document: a member's own usage is for them and the keepers only.
 */
export function proposalsFromLog(text) {
    const by = new Map();
    for (const line of text.split("\n")) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e?.event !== "member_usage" || e.status !== 200) continue;
        const key = e.proposal ?? "unassigned";
        const p = by.get(key) ?? { proposal: key, usedSats: 0, usedMsat: 0, requests: 0, members: new Set(), lastUsedAt: 0 };
        p.usedMsat += e.msat ?? 0;
        p.requests += 1;
        p.members.add(e.member);
        p.lastUsedAt = Math.max(p.lastUsedAt, e.at ?? 0);
        by.set(key, p);
    }
    return [...by.values()].map(({ members, usedMsat, ...p }) => ({ ...p, usedSats: Math.floor(usedMsat / 1000), members: members.size }))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** Per-provider totals across jobs: what each has earned from this hive and what is open with it. */
export function providersFromJobs(jobs) {
    const by = new Map();
    for (const j of jobs) {
        const key = j.providerPk ?? j.providerPeer;
        if (!key) continue;
        const p = by.get(key) ?? { providerPk: j.providerPk ?? null, providerPeer: j.providerPeer ?? null, earnedSats: 0, openJobs: 0, jobs: 0, models: [] };
        p.jobs += 1;
        if (j.status === "claimed") p.earnedSats += j.paidSats ?? 0;
        if (j.status === "open") p.openJobs += 1;
        if (j.model && !p.models.includes(j.model)) p.models.push(j.model);
        by.set(key, p);
    }
    return [...by.values()].sort((a, b) => b.earnedSats - a.earnedSats);
}

/** Settled chip-ins from the LNURL server's payment list for the hive's address. */
export function contributionsFromPayments(body) {
    return (body?.payments ?? [])
        .filter((p) => p.settled)
        .map((p) => ({
            at: Math.floor((p.settledAt ?? p.createdAt) / 1000),
            sats: Math.floor((p.amountMsat ?? 0) / 1000),
            rail: p.paymentOption ?? "lightning",
            reference: p.payoutReference ?? p.paymentReference ?? null,
        }))
        .sort((a, b) => b.at - a.at);
}

/** The document the plugin reads: `GET /hive/v1/state`. */
/**
 * The agent's node, from its console's `/api/status`: the full node id members install with, and
 * the invite that currently lets a node join the hive's mesh. The invite is base64url JSON
 * `{id, addrs}` and changes whenever the agent restarts.
 */
export function agentFromStatus(status) {
    const token = typeof status?.token === "string" ? status.token : null;
    if (!token) return null;
    let nodeId = null;
    try {
        const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
        if (typeof decoded.id === "string" && /^[0-9a-f]{64}$/i.test(decoded.id)) nodeId = decoded.id.toLowerCase();
    } catch { /* not an invite we understand */ }
    return nodeId ? { nodeId, invite: token } : null;
}

export function hiveState({ name, chipIn, treasury, jobs, contributions, proposals = [], agent = null, governance = null, keepersDesk = null, now = Math.floor(Date.now() / 1000) }) {
    return {
        v: 1,
        name,
        updatedAt: now,
        // Members install with this id; the invite itself is served separately, only when enabled.
        agent: agent ? { nodeId: agent.nodeId } : null,
        chipIn,
        treasury,
        // Keepers act on these: move exactly capSats to escrowAddress from a coin expiring after minCoinExpiry.
        funding: jobs.filter((j) => j.status === "awaiting_funding"),
        // Where keepers sign: the hive's signing desk and the keeper console that talks to it.
        keepersDesk,
        jobs,
        providers: providersFromJobs(jobs),
        payouts: jobs.filter((j) => j.status === "claimed").map((j) => ({ at: j.closedAt, jobId: j.jobId, providerPk: j.providerPk, sats: j.paidSats, txid: j.txid })),
        contributions,
        proposals,
        // Proposals as the community decided them in the channel, with keepers and members' nodes; null until the bot coordinates.
        governance: governance ? {
            channelId: governance.channelId, keepers: governance.keepers, threshold: governance.threshold, smallSats: governance.smallSats,
            ...(governance.keeperKeys ? { keeperKeys: governance.keeperKeys } : {}),
            ...(governance.discussionSeconds !== undefined ? { discussionSeconds: governance.discussionSeconds } : {}),
            updatedAt: governance.updatedAt, members: governance.members ?? {},
            // The agent's log is fresher than the bot's last pass, so usage comes from it when it has more.
            proposals: (governance.proposals ?? []).map((p) => {
                const used = proposals.find((u) => u.proposal === p.id)?.usedSats ?? 0;
                return used > (p.usedSats ?? 0) ? { ...p, usedSats: used } : p;
            }),
        } : null,
    };
}
