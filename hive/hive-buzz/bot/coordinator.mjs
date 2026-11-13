// The hive's coordinator, run by its bot: it reads the hive's Buzz channel and works out where each
// proposal stands. Everything it decides comes from signed Buzz events: a proposal is a member's
// message, support is members' 👍, approval is two keepers' ✅, a decline is a keeper's ❌ with the
// reason they reply in the thread. Pure, so it can be tested without a relay.
import { discussionSeconds, parseAgentKey, parseKeeperKey, parseNodeClaim, parseProposal } from "../shared/proposal.mjs";

const DAY = 86400;
const SUPPORT = new Set(["👍", "+", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", "❤️", "🙌"]);
const APPROVE = new Set(["✅", "✔️", "☑️"]);
const DECLINE = new Set(["❌", "✖️"]);
const DEFAULT_PERIOD = 30 * DAY;

export const proposalId = (eventId) => `p-${eventId.slice(0, 8)}`;

/** The events their own authors deleted: a deletion counts only for its author's own events. */
export function deletedIds(events) {
    const author = new Map(events.map((e) => [e.id, e.pubkey]));
    return new Set(events.filter((e) => e.kind === 5)
        .flatMap((d) => (d.tags ?? []).filter((t) => t[0] === "e" && author.get(t[1]) === d.pubkey).map((t) => t[1])));
}
const tagValues = (e, name) => (e.tags ?? []).filter((t) => t[0] === name).map((t) => t[1]);
/** The message a reply or reaction points at: its root `e` tag, else the last one. */
function target(e) {
    const es = (e.tags ?? []).filter((t) => t[0] === "e");
    return (es.find((t) => t[3] === "root") ?? es.find((t) => t[3] === "reply") ?? es[es.length - 1])?.[1] ?? null;
}

/**
 * Where every proposal stands at `now`.
 *
 * events: the channel's kind 9 messages, kind 7 reactions and kind 5 deletions, in any order.
 * cfg: { keepers: [pubkey], threshold, smallSats, now, usage: { [proposalId]: usedSats }, discussionSeconds, bot }
 *   discussionSeconds: one discussion length for every proposal, for a test hive; 48 or 24 hours otherwise.
 *   bot: HiveBot's key, when the events may come from outside the channel (forwarded to a host): a
 *     member's node then counts only once HiveBot, which reads the channel itself, acknowledged it.
 */
export function coordinate(events, cfg) {
    const { keepers = [], threshold = 2, smallSats = 20000, now = Math.floor(Date.now() / 1000), usage = {}, discussionSeconds: fixed, bot = null } = cfg;
    const keeperSet = new Set(keepers);
    const deleted = deletedIds(events);
    const live = events.filter((e) => !deleted.has(e.id)).sort((a, b) => a.created_at - b.created_at);
    // The node claims HiveBot acknowledged, when it vouches for them.
    const acked = new Set(live.filter((e) => e.kind === 9 && e.pubkey === bot)
        .flatMap((e) => (e.tags ?? []).filter((t) => t[0] === "hive" && t[1] === "node-ack").map((t) => t[2])));

    const nodes = {};
    const keys = {};
    let agent = null;
    const proposals = new Map();
    for (const e of live) {
        if (e.kind !== 9) continue;
        const node = parseNodeClaim(e.content);
        if (node) { if (!bot || acked.has(e.id)) nodes[e.pubkey] = { node, at: e.created_at, eventId: e.id }; continue; }
        // A keeper's treasury key counts only from that keeper; a later post replaces an earlier one.
        const key = parseKeeperKey(e.content);
        if (key) { if (keeperSet.has(e.pubkey)) keys[e.pubkey] = { key, at: e.created_at, eventId: e.id }; continue; }
        // The community's own agent node, named by a keeper; the latest naming stands.
        const agentKey = parseAgentKey(e.content);
        if (agentKey) { if (keeperSet.has(e.pubkey)) agent = { key: agentKey, by: e.pubkey, at: e.created_at }; continue; }
        if (target(e)) continue; // replies are read below
        const p = parseProposal(e.content, tagValues(e, "p"));
        if (!p) continue;
        proposals.set(e.id, { id: proposalId(e.id), eventId: e.id, by: e.pubkey, postedAt: e.created_at, ...p, reportPlan: p.report,
            support: new Set(), approvals: new Map(), declines: new Map(), replies: 0, reason: null, report: null, withdrawn: false });
    }
    for (const e of live) {
        const p = proposals.get(target(e));
        if (!p) continue;
        if (e.kind === 7) {
            const emoji = e.content.trim();
            if (SUPPORT.has(emoji) && e.pubkey !== p.by) p.support.add(e.pubkey);
            if (APPROVE.has(emoji) && keeperSet.has(e.pubkey)) p.approvals.set(e.pubkey, e.created_at);
            if (DECLINE.has(emoji) && keeperSet.has(e.pubkey)) p.declines.set(e.pubkey, e.created_at);
        } else if (e.kind === 9) {
            p.replies += 1;
            const text = e.content.trim();
            if (keeperSet.has(e.pubkey) && /^declined\s*:/i.test(text)) p.reason = text.replace(/^declined\s*:\s*/i, "");
            if (e.pubkey === p.by && /^withdraw(n)?\b/i.test(text)) p.withdrawn = true;
            if (e.pubkey === p.by && /^report\s*:/i.test(text)) p.report = { text: text.replace(/^report\s*:\s*/i, ""), at: e.created_at };
        }
    }

    const out = [];
    for (const p of proposals.values()) {
        const discussionEnds = p.postedAt + (fixed ?? discussionSeconds(p.budgetSats, smallSats));
        const approvalTimes = [...p.approvals.values()].sort((a, b) => a - b);
        const approvedAt = approvalTimes.length >= threshold ? Math.max(discussionEnds, approvalTimes[threshold - 1]) : null;
        const starts = approvedAt === null ? null : Math.max(approvedAt, p.start ?? approvedAt);
        const ends = approvedAt === null ? null : p.end ?? starts + DEFAULT_PERIOD;
        const used = usage[p.id] ?? 0;
        let state;
        if (p.withdrawn) state = "withdrawn";
        else if (p.declines.size) state = "declined";
        else if (approvedAt === null || now < approvedAt) state = "open";
        else if (now < starts) state = "approved";
        else if (now < ends && used < p.budgetSats) state = "running";
        else state = p.report ? "completed" : "lapsed";
        out.push({
            id: p.id, eventId: p.eventId, by: p.by, postedAt: p.postedAt,
            title: p.title, budgetSats: p.budgetSats, start: p.start, end: p.end, who: p.who, named: p.named,
            allowanceSats: p.allowanceSats, purpose: p.purpose, work: p.work, provider: p.provider, reportPlan: p.reportPlan,
            state, discussionEnds, approvedAt, starts, ends, usedSats: used,
            support: p.support.size, replies: p.replies,
            approvals: [...p.approvals.keys()], declinedBy: [...p.declines.keys()], reason: p.reason,
            report: p.report,
        });
    }
    out.sort((a, b) => b.postedAt - a.postedAt);
    return { proposals: out, nodes, keys, agent };
}

/**
 * The agent's members file: each member's node with the running proposal it may use and that
 * proposal's daily allowance. A member on several running proposals uses the most recently approved.
 */
export function membersFile(result, { defaultAllowanceSats = 500, model } = {}) {
    const members = {};
    const running = result.proposals.filter((p) => p.state === "running").sort((a, b) => a.approvedAt - b.approvedAt);
    const memberKeys = Object.keys(result.nodes);
    for (const p of running) {
        const who = p.who === "everyone" ? memberKeys : p.who === "named" ? p.named : [p.by];
        for (const pubkey of who) {
            const n = result.nodes[pubkey];
            if (!n) continue;
            members[n.node] = { name: pubkey.slice(0, 12), proposal: p.id, allowance_sats_per_day: p.allowanceSats ?? defaultAllowanceSats };
        }
    }
    return { ...(model ? { model } : {}), members };
}
