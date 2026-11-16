// Hive for Buzz (API v1): a hive inside its community. Members follow the treasury, propose work and
// use their allowances; keepers see what waits for them and approve it. It shows and routes and holds
// no keys: every proposal, support and approval is an ordinary Buzz message or reaction signed by its
// author, and a keeper's approval of a payment is a message the treasury's covenant checks itself.
//
// Where proposals stand, the plugin works out itself from the hive's channel, with the same rules
// the hive's bot uses. The treasury, jobs and payouts come from the hive's host over the one origin
// its manifest declares.
export const inject = ["react", "pages", "host", "notifications", "agents", "conversation", "relay", "navigation", "settingsCards"];

// One hive's own host, or, with SERVICE, the shared Hive service, where each hive lives under its
// channel: the plugin then finds its community's hive and talks to `<service>/c/<channel ID>`.
const SERVICE = null;
let hiveApi = SERVICE ? null : "https://brg444.github.io/hive/demo";
const PLUGIN_ID = "hive-demo.hive";
const HIVE_NAME = "Hive demo";
// The hive's channel and keepers, when the plugin was built with them; otherwise the host says.
const CONFIG = {"channelId":"7c745ff4-02b3-47c1-b081-8b321828f390","keepers":["1e8e42649059b5885f4d35302f3a3a7e161c2e40d5e82f550341138741bd253f","647c09f5295635acc82988a65283bce2caefb3b296dac5e658b0891873d803e2"],"threshold":2,"smallSats":20000};
const POLL_MS = 30_000;
const LOOKBACK_DAYS = 90;

// A proposal is an ordinary Buzz message in the hive's channel, readable in any client:
//
//   Proposal: Translate the Buzz docs into Spanish and Portuguese
//   Budget: 30,000 sats from 2026-11-15 to 2026-12-10
//   For: only me, 2,000 sats a day
//   Purpose: Buzz's docs exist only in English. The translated pages go to the docs repo.
//   Work: About 2.4 million tokens on llama-3.3-70b.
//   Provider: Lena's node, for the 70B model
//   Report: A link to the merged pull request.
//
// The plugin draws it as a card, the bot reads it as the record, and both use these two
// functions, so the text a member sends is exactly what the hive acts on. This file is also
// inlined into the plugin, so it imports nothing.

const FIELDS = ["proposal", "budget", "for", "purpose", "work", "provider", "report"];
const LABEL = { proposal: "Proposal", budget: "Budget", for: "For", purpose: "Purpose", work: "Work", provider: "Provider", report: "Report" };
const DAY = 86400;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const toUnix = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
const num = (s) => Number(String(s).replace(/[,\s_]/g, ""));

/** The proposal in a message's text, or null when the text is not a well-formed proposal. */
function parseProposal(text, mentions = []) {
    if (typeof text !== "string" || text.length > 6000) return null;
    const lines = text.replace(/\r/g, "").split("\n");
    const fields = {};
    let current = null;
    for (const raw of lines) {
        const m = /^\s*(?:\*\*)?([A-Za-z]+)(?:\*\*)?\s*:\s*(.*)$/.exec(raw);
        const key = m && m[1].toLowerCase();
        if (key && FIELDS.includes(key) && !(key in fields)) {
            current = key;
            fields[key] = m[2].trim();
        } else if (current && raw.trim()) {
            fields[current] += (fields[current] ? "\n" : "") + raw.trim();
        }
    }
    if (!fields.proposal || !fields.budget || !fields.purpose) return null;
    if (!/^\s*(?:\*\*)?proposal(?:\*\*)?\s*:/i.test(lines.find((l) => l.trim()) ?? "")) return null;

    const b = /^([\d,\s_]+)\s*sats?\b(?:\s+from\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2}))?/i.exec(fields.budget);
    if (!b) return null;
    const budgetSats = num(b[1]);
    if (!Number.isSafeInteger(budgetSats) || budgetSats <= 0) return null;
    let start = null, end = null;
    if (b[2] && b[3] && isoDay.test(b[2]) && isoDay.test(b[3])) {
        start = toUnix(b[2]);
        end = toUnix(b[3]) + DAY - 1;
        if (!(end > start)) return null;
    }

    const f = (fields.for ?? "only me").toLowerCase();
    const who = /every/.test(f) ? "everyone" : /named|@|members/.test(f) && mentions.length ? "named" : "me";
    const a = /([\d,\s_]+)\s*sats?\s*(?:a|per)\s*day/i.exec(fields.for ?? "");
    const allowanceSats = a ? num(a[1]) : null;

    return {
        title: fields.proposal.slice(0, 200),
        budgetSats,
        start,
        end,
        days: start && end ? Math.round((end + 1 - start) / DAY) : null,
        who,
        named: who === "named" ? [...mentions] : [],
        allowanceSats: Number.isSafeInteger(allowanceSats) && allowanceSats > 0 ? allowanceSats : null,
        purpose: fields.purpose,
        work: fields.work ?? "",
        provider: fields.provider ?? "",
        report: fields.report ?? "",
    };
}

/** The message text for a proposal; `parseProposal(formatProposal(p))` gives `p` back. */
function formatProposal(p) {
    const fmt = (n) => Number(n).toLocaleString("en-US");
    const day = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);
    const forText = p.who === "everyone" ? "everyone" : p.who === "named" ? "named members" : "only me";
    const lines = [
        `${LABEL.proposal}: ${p.title.trim()}`,
        `${LABEL.budget}: ${fmt(p.budgetSats)} sats${p.start && p.end ? ` from ${day(p.start)} to ${day(p.end)}` : ""}`,
        `${LABEL.for}: ${forText}${p.allowanceSats ? `, ${fmt(p.allowanceSats)} sats a day` : ""}`,
        `${LABEL.purpose}: ${p.purpose.trim()}`,
    ];
    if (p.work?.trim()) lines.push(`${LABEL.work}: ${p.work.trim()}`);
    if (p.provider?.trim()) lines.push(`${LABEL.provider}: ${p.provider.trim()}`);
    if (p.report?.trim()) lines.push(`${LABEL.report}: ${p.report.trim()}`);
    return lines.join("\n");
}

/** A member tells the hive which MeshLLM node is theirs: `Hive node: <64 hex>`. */
function parseNodeClaim(text) {
    const m = /^\s*hive node\s*:\s*([0-9a-f]{64})\s*$/i.exec(text ?? "");
    return m ? m[1].toLowerCase() : null;
}

/**
 * A keeper naming the MeshLLM node that runs the hive's agent, when the community runs its own:
 * `Hive agent: <the agent's x-only key>`, the key its pay-arkade plugin prints. Formatting the
 * line as code is fine; anything else is not a claim.
 */
function parseAgentKey(text) {
    const plain = String(text ?? "").replace(/[`*_]/g, "");
    const m = /^\s*hive agent\s*:\s*([0-9a-f]{64})\s*$/i.exec(plain);
    return m ? m[1].toLowerCase() : null;
}

/** How long discussion stays open: 48 hours, or 24 under the small-proposal threshold. */
function discussionSeconds(budgetSats, smallSats) {
    return budgetSats < smallSats ? DAY : 2 * DAY;
}

/**
 * A proposal from the Propose form's fields, as the message text to send, or the first thing missing.
 * fields: { title, purpose, budget, start, end, who, allowance, work, provider, report }, all strings
 * as typed; dates are YYYY-MM-DD and go together.
 */
function proposalFromForm(fields) {
    const f = (k) => String(fields[k] ?? "").trim();
    const budgetSats = num(f("budget"));
    const allowance = f("allowance") ? num(f("allowance")) : null;
    if (!f("title")) return { text: null, problem: "Give the work a title." };
    if (!Number.isSafeInteger(budgetSats) || budgetSats <= 0) return { text: null, problem: "Set a budget in sats." };
    if (!f("purpose")) return { text: null, problem: "Say what the work is for and what it produces." };
    if (Boolean(f("start")) !== Boolean(f("end"))) return { text: null, problem: "Give both dates, or neither for 30 days from approval." };
    let start = null, end = null;
    if (f("start")) {
        if (!isoDay.test(f("start")) || !isoDay.test(f("end"))) return { text: null, problem: "Dates are YYYY-MM-DD." };
        start = toUnix(f("start"));
        end = toUnix(f("end")) + DAY - 1;
        if (!(end > start)) return { text: null, problem: "The end date comes after the start." };
    }
    if (allowance !== null && (!Number.isSafeInteger(allowance) || allowance <= 0)) return { text: null, problem: "A daily allowance is a whole number of sats." };
    const who = ["me", "everyone", "named"].includes(f("who")) ? f("who") : "me";
    const text = formatProposal({ title: f("title"), budgetSats, start, end, who, allowanceSats: allowance,
        purpose: f("purpose").replace(/\s*\n+\s*/g, " "), work: f("work"), provider: f("provider"), report: f("report") });
    return { text, problem: null };
}


const { coordinate } = (() => {
// The hive's coordinator, run by its bot: it reads the hive's Buzz channel and works out where each
// proposal stands. Everything it decides comes from signed Buzz events: a proposal is a member's
// message, support is members' 👍, approval is two keepers' ✅, a decline is a keeper's ❌ with the
// reason they reply in the thread. Pure, so it can be tested without a relay.


const DAY = 86400;
const SUPPORT = new Set(["👍", "+", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", "❤️", "🙌"]);
const APPROVE = new Set(["✅", "✔️", "☑️"]);
const DECLINE = new Set(["❌", "✖️"]);
const DEFAULT_PERIOD = 30 * DAY;

const proposalId = (eventId) => `p-${eventId.slice(0, 8)}`;

/** The events their own authors deleted: a deletion counts only for its author's own events. */
function deletedIds(events) {
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
 *   forwarded: the events may come from outside the channel, whether or not the host knows a bot: a
 *     member's node then also counts once a keeper reacted ✅ to the message that names it.
 */
function coordinate(events, cfg) {
    const { keepers = [], threshold = 2, smallSats = 20000, now = Math.floor(Date.now() / 1000), usage = {}, discussionSeconds: fixed, bot = null, forwarded = Boolean(bot) } = cfg;
    const keeperSet = new Set(keepers);
    const deleted = deletedIds(events);
    const live = events.filter((e) => !deleted.has(e.id)).sort((a, b) => a.created_at - b.created_at);
    // The node claims HiveBot acknowledged, when it vouches for them.
    const acked = new Set(live.filter((e) => e.kind === 9 && e.pubkey === bot)
        .flatMap((e) => (e.tags ?? []).filter((t) => t[0] === "hive" && t[1] === "node-ack").map((t) => t[2])));
    for (const e of live) if (e.kind === 7 && keeperSet.has(e.pubkey) && APPROVE.has(e.content.trim())) acked.add(target(e));

    const nodes = {};
    let agent = null;
    const proposals = new Map();
    for (const e of live) {
        if (e.kind !== 9) continue;
        const node = parseNodeClaim(e.content);
        if (node) { if (!forwarded || acked.has(e.id)) nodes[e.pubkey] = { node, at: e.created_at, eventId: e.id }; continue; }
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
    return { proposals: out, nodes, agent };
}

/**
 * The agent's members file: each member's node with the running proposal it may use and that
 * proposal's daily allowance. A member on several running proposals uses the most recently approved.
 */
function membersFile(result, { defaultAllowanceSats = 500, model } = {}) {
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

return { coordinate };
})();

const { onboardingPlan, recordFromChannel } = (() => {
// Setting up a hive in its community's channel, one message or reaction at a time. The bot asks,
// members answer with ✅ or a message, and every answer is a signed Buzz event, so nobody copies
// anyone else's key or a channel ID:
//
//   1. Keepers: the bot asks who will keep the treasury; each keeper reacts ✅.
//   2. Confirm: once enough have, the member who authorized the bot confirms them with ✅.
//   3. Plugin: the bot says where to get the plugin. Each keeper's Buzz account is their key: the
//      ✅ they signed to volunteer named it, and every payment they approve is a message they send.
//   4. Treasury: the host builds it from the keepers' Buzz keys, and the bot posts its address once
//      the host reports one.
//   5. First proposal: the bot shows the format and closes the setup when one arrives.
//
// Pure, like the announcer: it reads the channel's events and the record of what it already said,
// and returns what to say next. The caller posts, then stores each message's event ID.

const YES = new Set(["✅", "✔️", "☑️"]);

const tagValues = (e, name) => (e.tags ?? []).filter((t) => t[0] === name).map((t) => t[1]);
/** Who reacted ✅ to `eventId`, in the order they first did, with removed reactions left out. */
function yesVotes(events, eventId, { exclude = [], until = Infinity } = {}) {
    // A deletion counts only for its author's own events.
    const author = new Map(events.map((e) => [e.id, e.pubkey]));
    const deleted = new Set(events.filter((e) => e.kind === 5).flatMap((d) => tagValues(d, "e").filter((id) => author.get(id) === d.pubkey)));
    const first = new Map();
    for (const e of [...events].sort((a, b) => a.created_at - b.created_at)) {
        if (e.kind !== 7 || deleted.has(e.id) || !YES.has(e.content.trim()) || e.created_at > until) continue;
        if (!tagValues(e, "e").includes(eventId) || exclude.includes(e.pubkey) || first.has(e.pubkey)) continue;
        first.set(e.pubkey, e.created_at);
    }
    return [...first.keys()];
}

/** "@A", "@A and @B", "@A, @B and @C". */
function people(keys, name) {
    const at = keys.map((k) => `@${name(k)}`);
    return at.length <= 1 ? at.join("") : `${at.slice(0, -1).join(", ")} and ${at[at.length - 1]}`;
}

const EMPTY = Object.freeze({ v: 1, posts: {}, keepers: null, treasuryReady: false, done: false });

/**
 * What to post next.
 *
 * record: what the bot has said and decided (EMPTY to start).
 * cfg: { events, bot, founder, needed, threshold, smallSats, state, proposals, name(pubkey), botName, install }
 *   events: the channel's kind 9, 7 and 5 events; state: hive-api's state or null;
 *   proposals: the coordinator's proposals, once keepers are set; name: a display name for a key.
 * Returns { posts: [{ key, text, mentions, plugin }], record }: the record as it stands once the
 * posts are sent; the caller adds each post's event ID under record.posts[key].
 */
function onboardingPlan(record, cfg) {
    const { events = [], bot, founder, needed = 3, threshold = 2, smallSats = 20000, state = null, proposals = [], name = (k) => k.slice(0, 8), botName = "Hive",
        install = "Download the attachment and unzip it, then in Buzz open Settings → Plugins → Manage plugins → Add → Browse and pick the folder." } = cfg;
    const next = { ...record, posts: { ...record.posts } };
    const posts = [];
    if (next.done) return { posts, record: next };

    if (!next.posts.call) {
        posts.push({ key: "call", text: [
            `Hi, I'm ${botName}. I'll set up a shared treasury for this community here in this channel, and each step is a message or a reaction.`,
            "",
            `First, keepers. Keepers hold the treasury together: any ${threshold} of them approve work and payments, each with a message from their own Buzz account, so nobody moves funds alone. If you'll keep this hive's treasury, react ✅ to this message. It needs ${needed}.`,
        ].join("\n") });
        return { posts, record: next };
    }

    if (!next.keepers) {
        const volunteers = yesVotes(events, next.posts.call, { exclude: [bot] });
        if (!next.posts.confirm) {
            if (volunteers.length >= needed) {
                posts.push({ key: "confirm", mentions: [...volunteers, founder], text:
                    `${volunteers.length} keepers so far: ${people(volunteers, name)}. ${people([founder], name)}, react ✅ here to confirm them. If someone is missing, have them react ✅ above first.` });
            }
            return { posts, record: next };
        }
        // Confirmed by the member who authorized the bot; keepers are whoever had volunteered by then.
        const confirmedAt = events.find((e) => e.kind === 7 && e.pubkey === founder && YES.has(e.content.trim()) && tagValues(e, "e").includes(next.posts.confirm))?.created_at;
        if (!yesVotes(events, next.posts.confirm, { exclude: [bot] }).includes(founder) || confirmedAt === undefined) return { posts, record: next };
        const keepers = yesVotes(events, next.posts.call, { exclude: [bot], until: confirmedAt });
        if (keepers.length < Math.max(needed, threshold)) return { posts, record: next };
        next.keepers = keepers;
        next.threshold = threshold;
        posts.push({ key: "plugin", plugin: true, mentions: keepers, text: [
            `Keepers are set: ${people(keepers, name)}. Any ${threshold} of them approve.`,
            "",
            `Next, the Hive plugin. It shows proposals as cards and adds a Propose button to this channel. ${install} Anyone here can install it, and the hive works without it too.`,
        ].join("\n") });
        posts.push({ key: "keys", mentions: keepers, text: [
            "Keepers, your Buzz account is your key to the treasury: there is nothing to create or copy. You approve each payment by sending a message here, signed by Buzz like every message you send. The plugin's Approve button writes it for you once you have checked the payment, and Decline stops one.",
            "",
            "If you haven't yet, back up your Buzz key in Settings → Identity: it is now also your share of the treasury.",
        ].join("\n") });
    }

    // The treasury the host reports is announced only when it is this hive's: built from the keepers
    // this channel confirmed and, on a shared service, kept there under this bot's own key. A host
    // that answers for some other hive is not taken at its word.
    const same = (a, b) => a.length === b.length && [...a].join() === [...b].join();
    const ours = (s) => {
        if (s.hive?.bot && s.hive.bot !== bot) return false;
        const g = s.governance;
        return !g?.keepers?.length || same(g.keepers, next.keepers);
    };
    const treasury = state?.treasury?.address && !state.demo && ours(state) ? state.treasury : null;
    const chipIn = (t) => {
        const ln = state?.chipIn?.lightningAddress;
        return `The treasury is ready. ${ln ? `Chip in at ${ln}, or send to ${t.address}` : `Chip in by sending to ${t.address}`} from any Lightning or Arkade wallet. Every chip-in lands in the treasury as Bitcoin.`;
    };
    if (!next.posts.treasury) {
        next.treasuryReady = Boolean(treasury);
        posts.push({ key: "treasury", text: treasury
            ? chipIn(treasury)
            : "Next, the treasury: the address chip-ins go to and approved work is paid from. The hive's host builds it from the keepers' Buzz keys, and I'll post its address here once it's ready." });
    } else if (next.posts.treasury && !next.treasuryReady && treasury) {
        next.treasuryReady = true;
        posts.push({ key: "treasury-ready", text: chipIn(treasury) });
    }

    if (!next.posts.propose) {
        posts.push({ key: "propose", text: [
            "Last step, the first proposal. Press Propose under the message box, or post a message like this one:",
            "",
            "Proposal: What the work is, in a few words",
            "Budget: 20,000 sats",
            "For: everyone, 500 sats a day",
            "Purpose: Why it serves this community and what it produces",
            "",
            `Members react 👍 to support it. Discussion runs 48 hours, or 24 under ${smallSats.toLocaleString("en-US")} sats, and then ${threshold} keepers' ✅ approve it.`,
        ].join("\n") });
    } else if (proposals.length) {
        const first = [...proposals].sort((a, b) => a.postedAt - b.postedAt)[0];
        next.done = true;
        posts.push({ key: "done", text: `The first proposal is in: “${first.title}”. That's the setup done. From here I'll post approvals, payouts and chip-ins in this channel.` });
    }
    return { posts, record: next };
}

/**
 * The record, read back from the bot's own messages in the channel: each onboarding post carries a
 * ["hive", key] tag, and the plugin post names the keepers in its "p" tags. So a bot that keeps no
 * state of its own picks up where it left off.
 */
function recordFromChannel(events, bot, threshold) {
    const record = { ...EMPTY, posts: {} };
    for (const e of [...events].filter((e) => e.kind === 9 && e.pubkey === bot).sort((a, b) => a.created_at - b.created_at)) {
        const tag = (e.tags ?? []).find((t) => t[0] === "hive");
        if (!tag || record.posts[tag[1]]) continue;
        record.posts[tag[1]] = e.id;
        if (tag[1] === "plugin") {
            record.keepers = (e.tags ?? []).filter((t) => t[0] === "p").map((t) => t[1]);
            record.threshold = threshold;
        }
        if (tag[1] === "treasury-ready" || (tag[1] === "treasury" && tag[2] === "ready")) record.treasuryReady = true;
        if (tag[1] === "done") record.done = true;
    }
    return record;
}

return { onboardingPlan, recordFromChannel };
})();

// What the Hive guide knows about how a hive works, and the instructions it starts with. The guide
// is a Goose agent the community owner adds in Buzz; the Hive plugin gives it this through the
// hive_guide tool and live figures through hive_status and hive_proposals. Inlined into the plugin.

const GUIDE_NAME = "Hive guide";
const GOOSE_TYPE = "buzz.goose/goose";

/** How a hive works, in the plugin's own words: what the guide answers questions from. */
const HOW_IT_WORKS = `
How a hive works

A hive is a community's shared Bitcoin treasury for open AI. Members chip in, propose work, and
spend approved budgets on AI models that MeshLLM providers serve. Keepers hold the treasury's keys
together; any two of them approve each payment.

Proposals. A member posts a message starting with "Proposal:" in the hive's channel, with Budget,
For and Purpose lines (Work, Provider and Report are optional), or presses the hexagon button under
the message box. Members react 👍 to support it. Discussion runs 48 hours, or 24 hours under the
small-proposal threshold (20,000 sats unless the hive set another). Then two keepers react ✅ to
approve it; one keeper's ❌ with "Declined: <reason>" in the thread declines it. The proposer can
reply "Withdrawn" to stop it, and "Report: <link or text>" to close it out. An approved budget runs
from its dates, or 30 days from approval.

Allowances. A running proposal for "everyone", for named members or for the proposer gives each
of them a daily allowance. A member spends it through the hive's agent: from their own MeshLLM node
after posting "Hive node: <node id>" in the channel, or by asking the hive's agent.

Keepers. Keepers volunteer when HiveBot asks during setup, by reacting ✅, and the community owner
confirms them. A keeper's Buzz account is their key: the treasury is built from the three keepers'
Buzz keys, the same keys that sign every message they send, so there is nothing to create or copy.
The same key can take the treasury onchain with another keeper if the Arkade Operator ever goes
away, so a keeper backs it up in Buzz's Settings → Identity.

Payments. Approving a proposal and paying for its work are separate decisions. Payments are
approved one at a time: the hive's desk opens the next one once the one before it is paid, declined
or lapsed, jobs before withdrawals. When a job needs funding, keepers are notified in Buzz. The
plugin checks the payment for them, the treasury, the escrow, the amount against the budgets the
channel approved and the agent that signs the job's receipts, and shows the amount, the provider and
what is left of the budget on the hive's Keepers tab and above the message box. A keeper presses
Approve: the plugin writes the approval, "I approve Hive payment of <amount> sats to <recipient>
<code>", into the message box, and the keeper reads it and sends it as it is. The words say the
amount and the start of the recipient, the code names exactly that payment, and the treasury itself
checks the keeper's signature on the message. Two keepers approve, in any order and hours apart if
they like, and the hive's desk then sends the payment. Decline, which sends "I decline Hive payment
of <amount> sats to <recipient> <code>", stops the desk from paying it. It does not undo approvals
two keepers have already sent, which stay valid until they lapse, within a day. A keeper sends no
approval the plugin did not write for them, whoever asks. A keeper asks for a withdrawal with the
Withdraw form, or a message "Hive withdrawal: <amount> sats to <Arkade address>", one request at a
time, and two keepers approve it the same way.
Nobody, and nothing, approves for a keeper. Each job's
money sits in an escrow: the provider is paid what the agent's signed receipts show, the rest goes
back to the treasury, and an unclaimed escrow returns whole at its deadline with no one's signature.

Chipping in. Anyone can send sats to the hive's Lightning address or its treasury address from any
Lightning or Arkade wallet. Chip-ins are donations toward the hive's purpose and land in the
treasury as Bitcoin.

What nobody can do. No one moves treasury funds alone, keepers included. The plugin, HiveBot and the
guide hold no keys and cannot sign or move money.
`.trim();

/** The instructions the guide is created with. */
const GUIDE_INSTRUCTIONS = `
You are the Hive guide for this community's hive: a shared Bitcoin treasury for open AI, kept in
this Buzz community. You answer members' and keepers' questions about how the hive works and where
it stands, and help them take the next step themselves.

Before you answer, call hive_guide for how the hive works, and hive_status or hive_proposals for
anything about the treasury, proposals, budgets, jobs or keepers. For details the guide does not
cover, such as safeguards, escrows, providers or the treasury's covenant, call hive_docs with a topic: it
reads Hive's own documentation, and you can point people to the repository it comes from. Never state a number, a date, a
name or a decision you did not just read from those tools. If they do not have it, say you do not
know and who would: the keepers, or the community owner.

You cannot sign, move money or decide anything, and you never will. Never ask for, accept or repeat
a private key, a backup file, a passphrase or a recovery phrase; if someone shares one, tell them to
treat it as exposed and to tell the other keepers at once. Point keepers to the Keepers tab for
payments, and members to the Propose button or a "Proposal:" message for proposals.

Write the way Buzz does: plain, second person and short, a few sentences at most, in flowing prose
rather than lists unless someone asks for steps, never opening a sentence with "And" or "But", and
always writing "Bitcoin" with a capital B.
`.trim();


const { UNITS, savedUnit, saveUnit, amountParts, formatAmount } = (() => {
// How Hive shows an amount, in the unit the viewer chose: ₿ (Bitcoin's smallest unit written the way
// Spiral proposes, so ₿1 is one sat and ₿20,000 is twenty thousand of them), sats, BTC, or US dollars
// at the current Bitcoin price. Amounts are kept and sent in sats everywhere; only the display changes.
// The Buzz plugin build inlines this file.

/** The units a viewer can choose, with a sample of each. */
const UNITS = [
    { id: "bitcoin", label: "Bitcoin (₿)", sample: "₿20,000", note: "Bitcoin's smallest unit, as Spiral writes it: ₿1 is one sat." },
    { id: "sats", label: "Sats", sample: "20,000 sats", note: "The same unit, by its usual name." },
    { id: "btc", label: "BTC", sample: "0.0002 BTC", note: "Whole Bitcoin, to eight decimal places." },
    { id: "usd", label: "US dollars", sample: "$13.45", note: "At the current Bitcoin price, rounded to the cent." },
];
const DEFAULT_UNIT = "bitcoin";
const UNIT_KEY = "hive.amounts.v1";
const known = (u) => UNITS.some((x) => x.id === u);

/** The viewer's unit, kept in this browser. */
function savedUnit(storage = globalThis.localStorage) {
    try {
        const u = storage?.getItem(UNIT_KEY);
        return known(u) ? u : DEFAULT_UNIT;
    } catch {
        return DEFAULT_UNIT;
    }
}

function saveUnit(u, storage = globalThis.localStorage) {
    if (!known(u)) return;
    try {
        storage?.setItem(UNIT_KEY, u);
    } catch {
        // private browsing: the choice lasts until the page closes
    }
}

const whole = new Intl.NumberFormat();
const btc = new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 });
const usd = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * An amount in sats as its parts, so a page can set the number apart from its unit. `exact` asks for a
 * unit that states the amount to the sat: dollars then give way to ₿, as they do with no price.
 */
function amountParts(sats, unit, usdPerBtc, exact = false) {
    if (sats === null || sats === undefined || !Number.isFinite(sats)) return { pre: "", num: "–", post: "" };
    const u = unit === "usd" && (exact || !(usdPerBtc > 0)) ? DEFAULT_UNIT : unit;
    if (u === "sats") return { pre: "", num: whole.format(sats), post: " sats" };
    if (u === "btc") return { pre: "", num: btc.format(sats / 1e8), post: " BTC" };
    if (u === "usd") {
        const v = (sats / 1e8) * usdPerBtc;
        return v > 0 && v < 0.01 ? { pre: "<$", num: "0.01", post: "" } : { pre: "$", num: usd.format(v), post: "" };
    }
    return { pre: "₿", num: whole.format(sats), post: "" };
}

function formatAmount(sats, unit, usdPerBtc, exact = false) {
    const p = amountParts(sats, unit, usdPerBtc, exact);
    return `${p.pre}${p.num}${p.post}`;
}

return { UNITS, savedUnit, saveUnit, amountParts, formatAmount };
})();

function hiveChecks() {
    if (hiveChecks.loaded) return hiveChecks.loaded;
    "use strict";var HiveChecks=(()=>{var kt=Object.defineProperty;var Uo=Object.getOwnPropertyDescriptor;var Co=Object.getOwnPropertyNames;var Do=Object.prototype.hasOwnProperty;var ko=(t,e)=>{for(var n in e)kt(t,n,{get:e[n],enumerable:!0})},vo=(t,e,n,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let o of Co(e))!Do.call(t,o)&&o!==n&&kt(t,o,{get:()=>e[o],enumerable:!(r=Uo(e,o))||r.enumerable});return t};var Bo=t=>vo(kt({},"__esModule",{value:!0}),t);var Oi={};ko(Oi,{MAX_VALIDITY_SECONDS:()=>Kn,checkPayment:()=>Pi,paymentWord:()=>bo,treasuryScript:()=>No,withdrawalOf:()=>Vn,withdrawalRequest:()=>hi});var $n=new TextEncoder,Lo=new TextDecoder,b=class t extends Uint8Array{static from(e,n){if(typeof e=="string"){if(n==="hex"){if(e.length%2)throw new Error("odd hex");let r=new t(e.length/2);for(let o=0;o<r.length;o++){let s=Number.parseInt(e.slice(2*o,2*o+2),16);if(Number.isNaN(s))break;r[o]=s}return r}return n==="base64"?t.wrap(Uint8Array.from(atob(e),r=>r.charCodeAt(0))):t.wrap($n.encode(e))}return t.wrap(Uint8Array.from(e))}static wrap(e){let n=new t(e.length);return n.set(e),n}static concat(e){let n=new t(e.reduce((o,s)=>o+s.length,0)),r=0;for(let o of e)n.set(o,r),r+=o.length;return n}static alloc(e){return new t(e)}static byteLength(e){return typeof e=="string"?$n.encode(e).length:e.length}static isBuffer(e){return e instanceof t}toString(e){return e==="hex"?Array.from(this,n=>n.toString(16).padStart(2,"0")).join(""):e==="base64"?btoa(String.fromCharCode(...this)):Lo.decode(this)}};var F=t=>()=>{throw new Error(`${t} is not available in the Hive plugin`)};var Wn=F("readFileSync"),Vo=F("writeFileSync"),Fn=F("mkdirSync"),Ko=F("renameSync"),wi=F("rmSync"),Mo=F("openSync"),Ho=F("closeSync"),$o=F("fsyncSync"),bi=F("writeSync"),Ei=F("readdirSync"),Wo=F("statSync"),Ai=F("chmodSync"),Ce=(...t)=>t.filter(Boolean).join("/");var Fo=F("spawn");var Si=F("createServer");var Go=F("unlinkSync"),Ti=F("lstatSync");var Q=class extends Error{code;constructor(e,n,r){super(n?`${e}: ${n}`:e,r),this.name="Fault",this.code=e}};function ie(t,e){throw new Q(t,e)}function I(t,e,n){if(!t)throw new Q(e,n)}function B(t){return b.from(t).toString("hex")}function z(t){if(typeof t!="string"||!/^(?:[0-9a-f]{2})*$/.test(t))throw new Q("INVALID","not lowercase hex");return Uint8Array.from(b.from(t,"hex"))}var vt=Ce("/","../../.."),Yn=Ce(vt,".local"),Zi=Ce(vt,".secrets");var zi=16*1024*1024;var Ka=(1n<<63n)-1n;function We(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function ne(t,e=""){if(!Number.isSafeInteger(t)||t<0){let n=e&&`"${e}" `;throw new Error(`${n}expected integer >= 0, got ${t}`)}}function U(t,e,n=""){let r=We(t),o=t?.length,s=e!==void 0;if(!r||s&&o!==e){let i=n&&`"${n}" `,a=s?` of length ${e}`:"",u=r?`length=${o}`:`type=${typeof t}`;throw new Error(i+"expected Uint8Array"+a+", got "+u)}return t}function ct(t){if(typeof t!="function"||typeof t.create!="function")throw new Error("Hash must wrapped by utils.createHasher");ne(t.outputLen),ne(t.blockLen)}function De(t,e=!0){if(t.destroyed)throw new Error("Hash instance has been destroyed");if(e&&t.finished)throw new Error("Hash#digest() has already been called")}function jn(t,e){U(t,void 0,"digestInto() output");let n=e.outputLen;if(t.length<n)throw new Error('"digestInto() output" expected to be of length >='+n)}function ye(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function ut(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}function re(t,e){return t<<32-e|t>>>e}var Zn=typeof Uint8Array.from([]).toHex=="function"&&typeof Uint8Array.fromHex=="function",zo=Array.from({length:256},(t,e)=>e.toString(16).padStart(2,"0"));function xe(t){if(U(t),Zn)return t.toHex();let e="";for(let n=0;n<t.length;n++)e+=zo[t[n]];return e}var ce={_0:48,_9:57,A:65,F:70,a:97,f:102};function qn(t){if(t>=ce._0&&t<=ce._9)return t-ce._0;if(t>=ce.A&&t<=ce.F)return t-(ce.A-10);if(t>=ce.a&&t<=ce.f)return t-(ce.a-10)}function we(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);if(Zn)return Uint8Array.fromHex(t);let e=t.length,n=e/2;if(e%2)throw new Error("hex string expected, got unpadded hex of length "+e);let r=new Uint8Array(n);for(let o=0,s=0;o<n;o++,s+=2){let i=qn(t.charCodeAt(s)),a=qn(t.charCodeAt(s+1));if(i===void 0||a===void 0){let u=t[s]+t[s+1];throw new Error('hex string expected, got non-hex character "'+u+'" at index '+s)}r[o]=i*16+a}return r}function Y(...t){let e=0;for(let r=0;r<t.length;r++){let o=t[r];U(o),e+=o.length}let n=new Uint8Array(e);for(let r=0,o=0;r<t.length;r++){let s=t[r];n.set(s,o),o+=s.length}return n}function zn(t,e={}){let n=(o,s)=>t(s).update(o).digest(),r=t(void 0);return n.outputLen=r.outputLen,n.blockLen=r.blockLen,n.create=o=>t(o),Object.assign(n,e),Object.freeze(n)}function le(t=32){let e=typeof globalThis=="object"?globalThis.crypto:null;if(typeof e?.getRandomValues!="function")throw new Error("crypto.getRandomValues must be defined");return e.getRandomValues(new Uint8Array(t))}var Qn=t=>({oid:Uint8Array.from([6,9,96,134,72,1,101,3,4,2,t])});function Xn(t,e,n){return t&e^~t&n}function Jn(t,e,n){return t&e^t&n^e&n}var dt=class{blockLen;outputLen;padOffset;isLE;buffer;view;finished=!1;length=0;pos=0;destroyed=!1;constructor(e,n,r,o){this.blockLen=e,this.outputLen=n,this.padOffset=r,this.isLE=o,this.buffer=new Uint8Array(e),this.view=ut(this.buffer)}update(e){De(this),U(e);let{view:n,buffer:r,blockLen:o}=this,s=e.length;for(let i=0;i<s;){let a=Math.min(o-this.pos,s-i);if(a===o){let u=ut(e);for(;o<=s-i;i+=o)this.process(u,i);continue}r.set(e.subarray(i,i+a),this.pos),this.pos+=a,i+=a,this.pos===o&&(this.process(n,0),this.pos=0)}return this.length+=e.length,this.roundClean(),this}digestInto(e){De(this),jn(e,this),this.finished=!0;let{buffer:n,view:r,blockLen:o,isLE:s}=this,{pos:i}=this;n[i++]=128,ye(this.buffer.subarray(i)),this.padOffset>o-i&&(this.process(r,0),i=0);for(let p=i;p<o;p++)n[p]=0;r.setBigUint64(o-8,BigInt(this.length*8),s),this.process(r,0);let a=ut(e),u=this.outputLen;if(u%4)throw new Error("_sha2: outputLen must be aligned to 32bit");let c=u/4,d=this.get();if(c>d.length)throw new Error("_sha2: outputLen bigger than state");for(let p=0;p<c;p++)a.setUint32(4*p,d[p],s)}digest(){let{buffer:e,outputLen:n}=this;this.digestInto(e);let r=e.slice(0,n);return this.destroy(),r}_cloneInto(e){e||=new this.constructor,e.set(...this.get());let{blockLen:n,buffer:r,length:o,finished:s,destroyed:i,pos:a}=this;return e.destroyed=i,e.finished=s,e.length=o,e.pos=a,o%n&&e.buffer.set(r),e}clone(){return this._cloneInto()}},ue=Uint32Array.from([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]);var Qo=Uint32Array.from([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),pe=new Uint32Array(64),Bt=class extends dt{constructor(e){super(64,e,8,!1)}get(){let{A:e,B:n,C:r,D:o,E:s,F:i,G:a,H:u}=this;return[e,n,r,o,s,i,a,u]}set(e,n,r,o,s,i,a,u){this.A=e|0,this.B=n|0,this.C=r|0,this.D=o|0,this.E=s|0,this.F=i|0,this.G=a|0,this.H=u|0}process(e,n){for(let p=0;p<16;p++,n+=4)pe[p]=e.getUint32(n,!1);for(let p=16;p<64;p++){let f=pe[p-15],l=pe[p-2],m=re(f,7)^re(f,18)^f>>>3,g=re(l,17)^re(l,19)^l>>>10;pe[p]=g+pe[p-7]+m+pe[p-16]|0}let{A:r,B:o,C:s,D:i,E:a,F:u,G:c,H:d}=this;for(let p=0;p<64;p++){let f=re(a,6)^re(a,11)^re(a,25),l=d+f+Xn(a,u,c)+Qo[p]+pe[p]|0,g=(re(r,2)^re(r,13)^re(r,22))+Jn(r,o,s)|0;d=c,c=u,u=a,a=i+l|0,i=s,s=o,o=r,r=l+g|0}r=r+this.A|0,o=o+this.B|0,s=s+this.C|0,i=i+this.D|0,a=a+this.E|0,u=u+this.F|0,c=c+this.G|0,d=d+this.H|0,this.set(r,o,s,i,a,u,c,d)}roundClean(){ye(pe)}destroy(){this.set(0,0,0,0,0,0,0,0),ye(this.buffer)}},Lt=class extends Bt{A=ue[0]|0;B=ue[1]|0;C=ue[2]|0;D=ue[3]|0;E=ue[4]|0;F=ue[5]|0;G=ue[6]|0;H=ue[7]|0;constructor(){super(32)}};var Pe=zn(()=>new Lt,Qn(1));var Kt=BigInt(0),Vt=BigInt(1);function Fe(t,e=""){if(typeof t!="boolean"){let n=e&&`"${e}" `;throw new Error(n+"expected boolean, got type="+typeof t)}return t}function er(t){if(typeof t=="bigint"){if(!ft(t))throw new Error("positive bigint expected, got "+t)}else ne(t);return t}function Ge(t){let e=er(t).toString(16);return e.length&1?"0"+e:e}function tr(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);return t===""?Kt:BigInt("0x"+t)}function he(t){return tr(xe(t))}function Mt(t){return tr(xe(Xo(U(t)).reverse()))}function Ye(t,e){ne(e),t=er(t);let n=we(t.toString(16).padStart(e*2,"0"));if(n.length!==e)throw new Error("number too large");return n}function Ht(t,e){return Ye(t,e).reverse()}function lt(t,e){if(t.length!==e.length)return!1;let n=0;for(let r=0;r<t.length;r++)n|=t[r]^e[r];return n===0}function Xo(t){return Uint8Array.from(t)}function nr(t){return Uint8Array.from(t,(e,n)=>{let r=e.charCodeAt(0);if(e.length!==1||r>127)throw new Error(`string contains non-ASCII character "${t[n]}" with code ${r} at position ${n}`);return r})}var ft=t=>typeof t=="bigint"&&Kt<=t;function Jo(t,e,n){return ft(t)&&ft(e)&&ft(n)&&e<=t&&t<n}function pt(t,e,n,r){if(!Jo(e,n,r))throw new Error("expected valid "+t+": "+n+" <= n < "+r+", got "+e)}function $t(t){let e;for(e=0;t>Kt;t>>=Vt,e+=1);return e}var qe=t=>(Vt<<BigInt(t))-Vt;function rr(t,e,n){if(ne(t,"hashLen"),ne(e,"qByteLen"),typeof n!="function")throw new Error("hmacFn must be a function");let r=x=>new Uint8Array(x),o=Uint8Array.of(),s=Uint8Array.of(0),i=Uint8Array.of(1),a=1e3,u=r(t),c=r(t),d=0,p=()=>{u.fill(1),c.fill(0),d=0},f=(...x)=>n(c,Y(u,...x)),l=(x=o)=>{c=f(s,x),u=f(),x.length!==0&&(c=f(i,x),u=f())},m=()=>{if(d++>=a)throw new Error("drbg: tried max amount of iterations");let x=0,R=[];for(;x<e;){u=f();let j=u.slice();R.push(j),x+=u.length}return Y(...R)};return(x,R)=>{p(),l(x);let j;for(;!(j=R(m()));)l();return p(),j}}function je(t,e={},n={}){if(!t||typeof t!="object")throw new Error("expected valid options object");function r(s,i,a){let u=t[s];if(a&&u===void 0)return;let c=typeof u;if(c!==i||u===null)throw new Error(`param "${s}" is invalid: expected ${i}, got ${c}`)}let o=(s,i)=>Object.entries(s).forEach(([a,u])=>r(a,u,i));o(e,!1),o(n,!0)}function Wt(t){let e=new WeakMap;return(n,...r)=>{let o=e.get(n);if(o!==void 0)return o;let s=t(n,...r);return e.set(n,s),s}}var q=BigInt(0),G=BigInt(1),be=BigInt(2),ir=BigInt(3),ar=BigInt(4),cr=BigInt(5),es=BigInt(7),ur=BigInt(8),ts=BigInt(9),dr=BigInt(16);function oe(t,e){let n=t%e;return n>=q?n:e+n}function X(t,e,n){let r=t;for(;e-- >q;)r*=r,r%=n;return r}function or(t,e){if(t===q)throw new Error("invert: expected non-zero number");if(e<=q)throw new Error("invert: expected positive modulus, got "+e);let n=oe(t,e),r=e,o=q,s=G,i=G,a=q;for(;n!==q;){let c=r/n,d=r%n,p=o-i*c,f=s-a*c;r=n,n=d,o=i,s=a,i=p,a=f}if(r!==G)throw new Error("invert: does not exist");return oe(o,e)}function Gt(t,e,n){if(!t.eql(t.sqr(e),n))throw new Error("Cannot find square root")}function fr(t,e){let n=(t.ORDER+G)/ar,r=t.pow(e,n);return Gt(t,r,e),r}function ns(t,e){let n=(t.ORDER-cr)/ur,r=t.mul(e,be),o=t.pow(r,n),s=t.mul(e,o),i=t.mul(t.mul(s,be),o),a=t.mul(s,t.sub(i,t.ONE));return Gt(t,a,e),a}function rs(t){let e=ke(t),n=lr(t),r=n(e,e.neg(e.ONE)),o=n(e,r),s=n(e,e.neg(r)),i=(t+es)/dr;return(a,u)=>{let c=a.pow(u,i),d=a.mul(c,r),p=a.mul(c,o),f=a.mul(c,s),l=a.eql(a.sqr(d),u),m=a.eql(a.sqr(p),u);c=a.cmov(c,d,l),d=a.cmov(f,p,m);let g=a.eql(a.sqr(d),u),x=a.cmov(c,d,g);return Gt(a,x,u),x}}function lr(t){if(t<ir)throw new Error("sqrt is not defined for small field");let e=t-G,n=0;for(;e%be===q;)e/=be,n++;let r=be,o=ke(t);for(;sr(o,r)===1;)if(r++>1e3)throw new Error("Cannot find square root: probably non-prime P");if(n===1)return fr;let s=o.pow(r,e),i=(e+G)/be;return function(u,c){if(u.is0(c))return c;if(sr(u,c)!==1)throw new Error("Cannot find square root");let d=n,p=u.mul(u.ONE,s),f=u.pow(c,e),l=u.pow(c,i);for(;!u.eql(f,u.ONE);){if(u.is0(f))return u.ZERO;let m=1,g=u.sqr(f);for(;!u.eql(g,u.ONE);)if(m++,g=u.sqr(g),m===d)throw new Error("Cannot find square root");let x=G<<BigInt(d-m-1),R=u.pow(p,x);d=m,p=u.sqr(R),f=u.mul(f,p),l=u.mul(l,R)}return l}}function os(t){return t%ar===ir?fr:t%ur===cr?ns:t%dr===ts?rs(t):lr(t)}var ss=["create","isValid","is0","neg","inv","sqrt","sqr","eql","add","sub","mul","pow","div","addN","subN","mulN","sqrN"];function Yt(t){let e={ORDER:"bigint",BYTES:"number",BITS:"number"},n=ss.reduce((r,o)=>(r[o]="function",r),e);return je(t,n),t}function is(t,e,n){if(n<q)throw new Error("invalid exponent, negatives unsupported");if(n===q)return t.ONE;if(n===G)return e;let r=t.ONE,o=e;for(;n>q;)n&G&&(r=t.mul(r,o)),o=t.sqr(o),n>>=G;return r}function Pt(t,e,n=!1){let r=new Array(e.length).fill(n?t.ZERO:void 0),o=e.reduce((i,a,u)=>t.is0(a)?i:(r[u]=i,t.mul(i,a)),t.ONE),s=t.inv(o);return e.reduceRight((i,a,u)=>t.is0(a)?i:(r[u]=t.mul(i,r[u]),t.mul(i,a)),s),r}function sr(t,e){let n=(t.ORDER-G)/be,r=t.pow(e,n),o=t.eql(r,t.ONE),s=t.eql(r,t.ZERO),i=t.eql(r,t.neg(t.ONE));if(!o&&!s&&!i)throw new Error("invalid Legendre symbol result");return o?1:s?0:-1}function as(t,e){e!==void 0&&ne(e);let n=e!==void 0?e:t.toString(2).length,r=Math.ceil(n/8);return{nBitLength:n,nByteLength:r}}var Ft=class{ORDER;BITS;BYTES;isLE;ZERO=q;ONE=G;_lengths;_sqrt;_mod;constructor(e,n={}){if(e<=q)throw new Error("invalid field: expected ORDER > 0, got "+e);let r;this.isLE=!1,n!=null&&typeof n=="object"&&(typeof n.BITS=="number"&&(r=n.BITS),typeof n.sqrt=="function"&&(this.sqrt=n.sqrt),typeof n.isLE=="boolean"&&(this.isLE=n.isLE),n.allowedLengths&&(this._lengths=n.allowedLengths?.slice()),typeof n.modFromBytes=="boolean"&&(this._mod=n.modFromBytes));let{nBitLength:o,nByteLength:s}=as(e,r);if(s>2048)throw new Error("invalid field: expected ORDER of <= 2048 bytes");this.ORDER=e,this.BITS=o,this.BYTES=s,this._sqrt=void 0,Object.preventExtensions(this)}create(e){return oe(e,this.ORDER)}isValid(e){if(typeof e!="bigint")throw new Error("invalid field element: expected bigint, got "+typeof e);return q<=e&&e<this.ORDER}is0(e){return e===q}isValidNot0(e){return!this.is0(e)&&this.isValid(e)}isOdd(e){return(e&G)===G}neg(e){return oe(-e,this.ORDER)}eql(e,n){return e===n}sqr(e){return oe(e*e,this.ORDER)}add(e,n){return oe(e+n,this.ORDER)}sub(e,n){return oe(e-n,this.ORDER)}mul(e,n){return oe(e*n,this.ORDER)}pow(e,n){return is(this,e,n)}div(e,n){return oe(e*or(n,this.ORDER),this.ORDER)}sqrN(e){return e*e}addN(e,n){return e+n}subN(e,n){return e-n}mulN(e,n){return e*n}inv(e){return or(e,this.ORDER)}sqrt(e){return this._sqrt||(this._sqrt=os(this.ORDER)),this._sqrt(this,e)}toBytes(e){return this.isLE?Ht(e,this.BYTES):Ye(e,this.BYTES)}fromBytes(e,n=!1){U(e);let{_lengths:r,BYTES:o,isLE:s,ORDER:i,_mod:a}=this;if(r){if(!r.includes(e.length)||e.length>o)throw new Error("Field.fromBytes: expected "+r+" bytes, got "+e.length);let c=new Uint8Array(o);c.set(e,s?0:c.length-e.length),e=c}if(e.length!==o)throw new Error("Field.fromBytes: expected "+o+" bytes, got "+e.length);let u=s?Mt(e):he(e);if(a&&(u=oe(u,i)),!n&&!this.isValid(u))throw new Error("invalid field element: outside of range 0..ORDER");return u}invertBatch(e){return Pt(this,e)}cmov(e,n,r){return r?n:e}};function ke(t,e={}){return new Ft(t,e)}function pr(t){if(typeof t!="bigint")throw new Error("field order must be bigint");let e=t.toString(2).length;return Math.ceil(e/8)}function qt(t){let e=pr(t);return e+Math.ceil(e/2)}function ht(t,e,n=!1){U(t);let r=t.length,o=pr(e),s=qt(e);if(r<16||r<s||r>1024)throw new Error("expected "+s+"-1024 bytes of input, got "+r);let i=n?Mt(t):he(t),a=oe(i,e-G)+G;return n?Ht(a,o):Ye(a,o)}var ve=BigInt(0),Ee=BigInt(1);function Ze(t,e){let n=e.negate();return t?n:e}function Qt(t,e){let n=Pt(t.Fp,e.map(r=>r.Z));return e.map((r,o)=>t.fromAffine(r.toAffine(n[o])))}function gr(t,e){if(!Number.isSafeInteger(t)||t<=0||t>e)throw new Error("invalid window size, expected [1.."+e+"], got W="+t)}function jt(t,e){gr(t,e);let n=Math.ceil(e/t)+1,r=2**(t-1),o=2**t,s=qe(t),i=BigInt(t);return{windows:n,windowSize:r,mask:s,maxNumber:o,shiftBy:i}}function Pr(t,e,n){let{windowSize:r,mask:o,maxNumber:s,shiftBy:i}=n,a=Number(t&o),u=t>>i;a>r&&(a-=s,u+=Ee);let c=e*r,d=c+Math.abs(a)-1,p=a===0,f=a<0,l=e%2!==0;return{nextN:u,offset:d,isZero:p,isNeg:f,isNegF:l,offsetF:c}}var Zt=new WeakMap,mr=new WeakMap;function zt(t){return mr.get(t)||1}function hr(t){if(t!==ve)throw new Error("invalid wNAF")}var Ot=class{BASE;ZERO;Fn;bits;constructor(e,n){this.BASE=e.BASE,this.ZERO=e.ZERO,this.Fn=e.Fn,this.bits=n}_unsafeLadder(e,n,r=this.ZERO){let o=e;for(;n>ve;)n&Ee&&(r=r.add(o)),o=o.double(),n>>=Ee;return r}precomputeWindow(e,n){let{windows:r,windowSize:o}=jt(n,this.bits),s=[],i=e,a=i;for(let u=0;u<r;u++){a=i,s.push(a);for(let c=1;c<o;c++)a=a.add(i),s.push(a);i=a.double()}return s}wNAF(e,n,r){if(!this.Fn.isValid(r))throw new Error("invalid scalar");let o=this.ZERO,s=this.BASE,i=jt(e,this.bits);for(let a=0;a<i.windows;a++){let{nextN:u,offset:c,isZero:d,isNeg:p,isNegF:f,offsetF:l}=Pr(r,a,i);r=u,d?s=s.add(Ze(f,n[l])):o=o.add(Ze(p,n[c]))}return hr(r),{p:o,f:s}}wNAFUnsafe(e,n,r,o=this.ZERO){let s=jt(e,this.bits);for(let i=0;i<s.windows&&r!==ve;i++){let{nextN:a,offset:u,isZero:c,isNeg:d}=Pr(r,i,s);if(r=a,!c){let p=n[u];o=o.add(d?p.negate():p)}}return hr(r),o}getPrecomputes(e,n,r){let o=Zt.get(n);return o||(o=this.precomputeWindow(n,e),e!==1&&(typeof r=="function"&&(o=r(o)),Zt.set(n,o))),o}cached(e,n,r){let o=zt(e);return this.wNAF(o,this.getPrecomputes(o,e,r),n)}unsafe(e,n,r,o){let s=zt(e);return s===1?this._unsafeLadder(e,n,o):this.wNAFUnsafe(s,this.getPrecomputes(s,e,r),n,o)}createCache(e,n){gr(n,this.bits),mr.set(e,n),Zt.delete(e)}hasCache(e){return zt(e)!==1}};function _r(t,e,n,r){let o=e,s=t.ZERO,i=t.ZERO;for(;n>ve||r>ve;)n&Ee&&(s=s.add(o)),r&Ee&&(i=i.add(o)),o=o.double(),n>>=Ee,r>>=Ee;return{p1:s,p2:i}}function Or(t,e,n){if(e){if(e.ORDER!==t)throw new Error("Field.ORDER must match order: Fp == p, Fn == n");return Yt(e),e}else return ke(t,{isLE:n})}function yr(t,e,n={},r){if(r===void 0&&(r=t==="edwards"),!e||typeof e!="object")throw new Error(`expected valid ${t} CURVE object`);for(let u of["p","n","h"]){let c=e[u];if(!(typeof c=="bigint"&&c>ve))throw new Error(`CURVE.${u} must be positive bigint`)}let o=Or(e.p,n.Fp,r),s=Or(e.n,n.Fn,r),a=["Gx","Gy","a",t==="weierstrass"?"b":"d"];for(let u of a)if(!o.isValid(e[u]))throw new Error(`CURVE.${u} must be valid field element of CURVE.Fp`);return e=Object.freeze(Object.assign({},e)),{CURVE:e,Fp:o,Fn:s}}function gt(t,e){return function(r){let o=t(r);return{secretKey:o,publicKey:e(o)}}}var mt=class{oHash;iHash;blockLen;outputLen;finished=!1;destroyed=!1;constructor(e,n){if(ct(e),U(n,void 0,"key"),this.iHash=e.create(),typeof this.iHash.update!="function")throw new Error("Expected instance of class which extends utils.Hash");this.blockLen=this.iHash.blockLen,this.outputLen=this.iHash.outputLen;let r=this.blockLen,o=new Uint8Array(r);o.set(n.length>r?e.create().update(n).digest():n);for(let s=0;s<o.length;s++)o[s]^=54;this.iHash.update(o),this.oHash=e.create();for(let s=0;s<o.length;s++)o[s]^=106;this.oHash.update(o),ye(o)}update(e){return De(this),this.iHash.update(e),this}digestInto(e){De(this),U(e,this.outputLen,"output"),this.finished=!0,this.iHash.digestInto(e),this.oHash.update(e),this.oHash.digestInto(e),this.destroy()}digest(){let e=new Uint8Array(this.oHash.outputLen);return this.digestInto(e),e}_cloneInto(e){e||=Object.create(Object.getPrototypeOf(this),{});let{oHash:n,iHash:r,finished:o,destroyed:s,blockLen:i,outputLen:a}=this;return e=e,e.finished=o,e.destroyed=s,e.blockLen=i,e.outputLen=a,e.oHash=n._cloneInto(e.oHash),e.iHash=r._cloneInto(e.iHash),e}clone(){return this._cloneInto()}destroy(){this.destroyed=!0,this.oHash.destroy(),this.iHash.destroy()}},Xt=(t,e,n)=>new mt(t,e).update(n).digest();Xt.create=(t,e)=>new mt(t,e);var xr=(t,e)=>(t+(t>=0?e:-e)/wr)/e;function cs(t,e,n){let[[r,o],[s,i]]=e,a=xr(i*t,n),u=xr(-o*t,n),c=t-a*r-u*s,d=-a*o-u*i,p=c<de,f=d<de;p&&(c=-c),f&&(d=-d);let l=qe(Math.ceil($t(n)/2))+Be;if(c<de||c>=l||d<de||d>=l)throw new Error("splitScalar (endomorphism): failed, k="+t);return{k1neg:p,k1:c,k2neg:f,k2:d}}function en(t){if(!["compact","recovered","der"].includes(t))throw new Error('Signature format must be "compact", "recovered", or "der"');return t}function Jt(t,e){let n={};for(let r of Object.keys(e))n[r]=t[r]===void 0?e[r]:t[r];return Fe(n.lowS,"lowS"),Fe(n.prehash,"prehash"),n.format!==void 0&&en(n.format),n}var tn=class extends Error{constructor(e=""){super(e)}},Oe={Err:tn,_tlv:{encode:(t,e)=>{let{Err:n}=Oe;if(t<0||t>256)throw new n("tlv.encode: wrong tag");if(e.length&1)throw new n("tlv.encode: unpadded data");let r=e.length/2,o=Ge(r);if(o.length/2&128)throw new n("tlv.encode: long form length too big");let s=r>127?Ge(o.length/2|128):"";return Ge(t)+s+o+e},decode(t,e){let{Err:n}=Oe,r=0;if(t<0||t>256)throw new n("tlv.encode: wrong tag");if(e.length<2||e[r++]!==t)throw new n("tlv.decode: wrong tlv");let o=e[r++],s=!!(o&128),i=0;if(!s)i=o;else{let u=o&127;if(!u)throw new n("tlv.decode(long): indefinite length not supported");if(u>4)throw new n("tlv.decode(long): byte length is too big");let c=e.subarray(r,r+u);if(c.length!==u)throw new n("tlv.decode: length bytes not complete");if(c[0]===0)throw new n("tlv.decode(long): zero leftmost byte");for(let d of c)i=i<<8|d;if(r+=u,i<128)throw new n("tlv.decode(long): not minimal encoding")}let a=e.subarray(r,r+i);if(a.length!==i)throw new n("tlv.decode: wrong value length");return{v:a,l:e.subarray(r+i)}}},_int:{encode(t){let{Err:e}=Oe;if(t<de)throw new e("integer: negative integers are not allowed");let n=Ge(t);if(Number.parseInt(n[0],16)&8&&(n="00"+n),n.length&1)throw new e("unexpected DER parsing assertion: unpadded hex");return n},decode(t){let{Err:e}=Oe;if(t[0]&128)throw new e("invalid signature integer: negative");if(t[0]===0&&!(t[1]&128))throw new e("invalid signature integer: unnecessary leading zero");return he(t)}},toSig(t){let{Err:e,_int:n,_tlv:r}=Oe,o=U(t,void 0,"signature"),{v:s,l:i}=r.decode(48,o);if(i.length)throw new e("invalid signature: left bytes after parsing");let{v:a,l:u}=r.decode(2,s),{v:c,l:d}=r.decode(2,u);if(d.length)throw new e("invalid signature: left bytes after parsing");return{r:n.decode(a),s:n.decode(c)}},hexFromSig(t){let{_tlv:e,_int:n}=Oe,r=e.encode(2,n.encode(t.r)),o=e.encode(2,n.encode(t.s)),s=r+o;return e.encode(48,s)}},de=BigInt(0),Be=BigInt(1),wr=BigInt(2),_t=BigInt(3),us=BigInt(4);function br(t,e={}){let n=yr("weierstrass",t,e),{Fp:r,Fn:o}=n,s=n.CURVE,{h:i,n:a}=s;je(e,{},{allowInfinityPoint:"boolean",clearCofactor:"function",isTorsionFree:"function",fromBytes:"function",toBytes:"function",endo:"object"});let{endo:u}=e;if(u&&(!r.is0(s.a)||typeof u.beta!="bigint"||!Array.isArray(u.basises)))throw new Error('invalid endo: expected "beta": bigint and "basises": array');let c=Ar(r,o);function d(){if(!r.isOdd)throw new Error("compression is not supported: Field does not have .isOdd()")}function p(D,O,h){let{x:P,y:_}=O.toAffine(),w=r.toBytes(P);if(Fe(h,"isCompressed"),h){d();let A=!r.isOdd(_);return Y(Er(A),w)}else return Y(Uint8Array.of(4),w,r.toBytes(_))}function f(D){U(D,void 0,"Point");let{publicKey:O,publicKeyUncompressed:h}=c,P=D.length,_=D[0],w=D.subarray(1);if(P===O&&(_===2||_===3)){let A=r.fromBytes(w);if(!r.isValid(A))throw new Error("bad point: is not on curve, wrong x");let E=g(A),y;try{y=r.sqrt(E)}catch(K){let v=K instanceof Error?": "+K.message:"";throw new Error("bad point: is not on curve, sqrt error"+v)}d();let S=r.isOdd(y);return(_&1)===1!==S&&(y=r.neg(y)),{x:A,y}}else if(P===h&&_===4){let A=r.BYTES,E=r.fromBytes(w.subarray(0,A)),y=r.fromBytes(w.subarray(A,A*2));if(!x(E,y))throw new Error("bad point: is not on curve");return{x:E,y}}else throw new Error(`bad point: got length ${P}, expected compressed=${O} or uncompressed=${h}`)}let l=e.toBytes||p,m=e.fromBytes||f;function g(D){let O=r.sqr(D),h=r.mul(O,D);return r.add(r.add(h,r.mul(D,s.a)),s.b)}function x(D,O){let h=r.sqr(O),P=g(D);return r.eql(h,P)}if(!x(s.Gx,s.Gy))throw new Error("bad curve params: generator point");let R=r.mul(r.pow(s.a,_t),us),j=r.mul(r.sqr(s.b),BigInt(27));if(r.is0(r.add(R,j)))throw new Error("bad curve params: a or b");function te(D,O,h=!1){if(!r.isValid(O)||h&&r.is0(O))throw new Error(`bad point coordinate ${D}`);return O}function Z(D){if(!(D instanceof k))throw new Error("Weierstrass Point expected")}function me(D){if(!u||!u.basises)throw new Error("no endo");return cs(D,u.basises,o.ORDER)}let fe=Wt((D,O)=>{let{X:h,Y:P,Z:_}=D;if(r.eql(_,r.ONE))return{x:h,y:P};let w=D.is0();O==null&&(O=w?r.ONE:r.inv(_));let A=r.mul(h,O),E=r.mul(P,O),y=r.mul(_,O);if(w)return{x:r.ZERO,y:r.ZERO};if(!r.eql(y,r.ONE))throw new Error("invZ was invalid");return{x:A,y:E}}),Dt=Wt(D=>{if(D.is0()){if(e.allowInfinityPoint&&!r.is0(D.Y))return;throw new Error("bad point: ZERO")}let{x:O,y:h}=D.toAffine();if(!r.isValid(O)||!r.isValid(h))throw new Error("bad point: x or y not field elements");if(!x(O,h))throw new Error("bad point: equation left != right");if(!D.isTorsionFree())throw new Error("bad point: not in prime-order subgroup");return!0});function $e(D,O,h,P,_){return h=new k(r.mul(h.X,D),h.Y,h.Z),O=Ze(P,O),h=Ze(_,h),O.add(h)}class k{static BASE=new k(s.Gx,s.Gy,r.ONE);static ZERO=new k(r.ZERO,r.ONE,r.ZERO);static Fp=r;static Fn=o;X;Y;Z;constructor(O,h,P){this.X=te("x",O),this.Y=te("y",h,!0),this.Z=te("z",P),Object.freeze(this)}static CURVE(){return s}static fromAffine(O){let{x:h,y:P}=O||{};if(!O||!r.isValid(h)||!r.isValid(P))throw new Error("invalid affine point");if(O instanceof k)throw new Error("projective point not allowed");return r.is0(h)&&r.is0(P)?k.ZERO:new k(h,P,r.ONE)}static fromBytes(O){let h=k.fromAffine(m(U(O,void 0,"point")));return h.assertValidity(),h}static fromHex(O){return k.fromBytes(we(O))}get x(){return this.toAffine().x}get y(){return this.toAffine().y}precompute(O=8,h=!0){return _e.createCache(this,O),h||this.multiply(_t),this}assertValidity(){Dt(this)}hasEvenY(){let{y:O}=this.toAffine();if(!r.isOdd)throw new Error("Field doesn't support isOdd");return!r.isOdd(O)}equals(O){Z(O);let{X:h,Y:P,Z:_}=this,{X:w,Y:A,Z:E}=O,y=r.eql(r.mul(h,E),r.mul(w,_)),S=r.eql(r.mul(P,E),r.mul(A,_));return y&&S}negate(){return new k(this.X,r.neg(this.Y),this.Z)}double(){let{a:O,b:h}=s,P=r.mul(h,_t),{X:_,Y:w,Z:A}=this,E=r.ZERO,y=r.ZERO,S=r.ZERO,N=r.mul(_,_),K=r.mul(w,w),v=r.mul(A,A),C=r.mul(_,w);return C=r.add(C,C),S=r.mul(_,A),S=r.add(S,S),E=r.mul(O,S),y=r.mul(P,v),y=r.add(E,y),E=r.sub(K,y),y=r.add(K,y),y=r.mul(E,y),E=r.mul(C,E),S=r.mul(P,S),v=r.mul(O,v),C=r.sub(N,v),C=r.mul(O,C),C=r.add(C,S),S=r.add(N,N),N=r.add(S,N),N=r.add(N,v),N=r.mul(N,C),y=r.add(y,N),v=r.mul(w,A),v=r.add(v,v),N=r.mul(v,C),E=r.sub(E,N),S=r.mul(v,K),S=r.add(S,S),S=r.add(S,S),new k(E,y,S)}add(O){Z(O);let{X:h,Y:P,Z:_}=this,{X:w,Y:A,Z:E}=O,y=r.ZERO,S=r.ZERO,N=r.ZERO,K=s.a,v=r.mul(s.b,_t),C=r.mul(h,w),L=r.mul(P,A),H=r.mul(_,E),se=r.add(h,P),V=r.add(w,A);se=r.mul(se,V),V=r.add(C,L),se=r.sub(se,V),V=r.add(h,_);let W=r.add(w,E);return V=r.mul(V,W),W=r.add(C,H),V=r.sub(V,W),W=r.add(P,_),y=r.add(A,E),W=r.mul(W,y),y=r.add(L,H),W=r.sub(W,y),N=r.mul(K,V),y=r.mul(v,H),N=r.add(y,N),y=r.sub(L,N),N=r.add(L,N),S=r.mul(y,N),L=r.add(C,C),L=r.add(L,C),H=r.mul(K,H),V=r.mul(v,V),L=r.add(L,H),H=r.sub(C,H),H=r.mul(K,H),V=r.add(V,H),C=r.mul(L,V),S=r.add(S,C),C=r.mul(W,V),y=r.mul(se,y),y=r.sub(y,C),C=r.mul(se,L),N=r.mul(W,N),N=r.add(N,C),new k(y,S,N)}subtract(O){return this.add(O.negate())}is0(){return this.equals(k.ZERO)}multiply(O){let{endo:h}=e;if(!o.isValidNot0(O))throw new Error("invalid scalar: out of range");let P,_,w=A=>_e.cached(this,A,E=>Qt(k,E));if(h){let{k1neg:A,k1:E,k2neg:y,k2:S}=me(O),{p:N,f:K}=w(E),{p:v,f:C}=w(S);_=K.add(C),P=$e(h.beta,N,v,A,y)}else{let{p:A,f:E}=w(O);P=A,_=E}return Qt(k,[P,_])[0]}multiplyUnsafe(O){let{endo:h}=e,P=this;if(!o.isValid(O))throw new Error("invalid scalar: out of range");if(O===de||P.is0())return k.ZERO;if(O===Be)return P;if(_e.hasCache(this))return this.multiply(O);if(h){let{k1neg:_,k1:w,k2neg:A,k2:E}=me(O),{p1:y,p2:S}=_r(k,P,w,E);return $e(h.beta,y,S,_,A)}else return _e.unsafe(P,O)}toAffine(O){return fe(this,O)}isTorsionFree(){let{isTorsionFree:O}=e;return i===Be?!0:O?O(k,this):_e.unsafe(this,a).is0()}clearCofactor(){let{clearCofactor:O}=e;return i===Be?this:O?O(k,this):this.multiplyUnsafe(i)}isSmallOrder(){return this.multiplyUnsafe(i).is0()}toBytes(O=!0){return Fe(O,"isCompressed"),this.assertValidity(),l(k,this,O)}toHex(O=!0){return xe(this.toBytes(O))}toString(){return`<Point ${this.is0()?"ZERO":this.toHex()}>`}}let it=o.BITS,_e=new Ot(k,e.endo?Math.ceil(it/2):it);return k.BASE.precompute(8),k}function Er(t){return Uint8Array.of(t?2:3)}function Ar(t,e){return{secretKey:e.BYTES,publicKey:1+t.BYTES,publicKeyUncompressed:1+2*t.BYTES,publicKeyHasPrefix:!0,signature:2*e.BYTES}}function ds(t,e={}){let{Fn:n}=t,r=e.randomBytes||le,o=Object.assign(Ar(t.Fp,n),{seed:qt(n.ORDER)});function s(l){try{let m=n.fromBytes(l);return n.isValidNot0(m)}catch{return!1}}function i(l,m){let{publicKey:g,publicKeyUncompressed:x}=o;try{let R=l.length;return m===!0&&R!==g||m===!1&&R!==x?!1:!!t.fromBytes(l)}catch{return!1}}function a(l=r(o.seed)){return ht(U(l,o.seed,"seed"),n.ORDER)}function u(l,m=!0){return t.BASE.multiply(n.fromBytes(l)).toBytes(m)}function c(l){let{secretKey:m,publicKey:g,publicKeyUncompressed:x}=o;if(!We(l)||"_lengths"in n&&n._lengths||m===g)return;let R=U(l,void 0,"key").length;return R===g||R===x}function d(l,m,g=!0){if(c(l)===!0)throw new Error("first arg must be private key");if(c(m)===!1)throw new Error("second arg must be public key");let x=n.fromBytes(l);return t.fromBytes(m).multiply(x).toBytes(g)}let p={isValidSecretKey:s,isValidPublicKey:i,randomSecretKey:a},f=gt(a,u);return Object.freeze({getPublicKey:u,getSharedSecret:d,keygen:f,Point:t,utils:p,lengths:o})}function Sr(t,e,n={}){ct(e),je(n,{},{hmac:"function",lowS:"boolean",randomBytes:"function",bits2int:"function",bits2int_modN:"function"}),n=Object.assign({},n);let r=n.randomBytes||le,o=n.hmac||((h,P)=>Xt(e,h,P)),{Fp:s,Fn:i}=t,{ORDER:a,BITS:u}=i,{keygen:c,getPublicKey:d,getSharedSecret:p,utils:f,lengths:l}=ds(t,n),m={prehash:!0,lowS:typeof n.lowS=="boolean"?n.lowS:!0,format:"compact",extraEntropy:!1},g=a*wr<s.ORDER;function x(h){let P=a>>Be;return h>P}function R(h,P){if(!i.isValidNot0(P))throw new Error(`invalid signature ${h}: out of range 1..Point.Fn.ORDER`);return P}function j(){if(g)throw new Error('"recovered" sig type is not supported for cofactor >2 curves')}function te(h,P){en(P);let _=l.signature,w=P==="compact"?_:P==="recovered"?_+1:void 0;return U(h,w)}class Z{r;s;recovery;constructor(P,_,w){if(this.r=R("r",P),this.s=R("s",_),w!=null){if(j(),![0,1,2,3].includes(w))throw new Error("invalid recovery id");this.recovery=w}Object.freeze(this)}static fromBytes(P,_=m.format){te(P,_);let w;if(_==="der"){let{r:S,s:N}=Oe.toSig(U(P));return new Z(S,N)}_==="recovered"&&(w=P[0],_="compact",P=P.subarray(1));let A=l.signature/2,E=P.subarray(0,A),y=P.subarray(A,A*2);return new Z(i.fromBytes(E),i.fromBytes(y),w)}static fromHex(P,_){return this.fromBytes(we(P),_)}assertRecovery(){let{recovery:P}=this;if(P==null)throw new Error("invalid recovery id: must be present");return P}addRecoveryBit(P){return new Z(this.r,this.s,P)}recoverPublicKey(P){let{r:_,s:w}=this,A=this.assertRecovery(),E=A===2||A===3?_+a:_;if(!s.isValid(E))throw new Error("invalid recovery id: sig.r+curve.n != R.x");let y=s.toBytes(E),S=t.fromBytes(Y(Er((A&1)===0),y)),N=i.inv(E),K=fe(U(P,void 0,"msgHash")),v=i.create(-K*N),C=i.create(w*N),L=t.BASE.multiplyUnsafe(v).add(S.multiplyUnsafe(C));if(L.is0())throw new Error("invalid recovery: point at infinify");return L.assertValidity(),L}hasHighS(){return x(this.s)}toBytes(P=m.format){if(en(P),P==="der")return we(Oe.hexFromSig(this));let{r:_,s:w}=this,A=i.toBytes(_),E=i.toBytes(w);return P==="recovered"?(j(),Y(Uint8Array.of(this.assertRecovery()),A,E)):Y(A,E)}toHex(P){return xe(this.toBytes(P))}}let me=n.bits2int||function(P){if(P.length>8192)throw new Error("input is too large");let _=he(P),w=P.length*8-u;return w>0?_>>BigInt(w):_},fe=n.bits2int_modN||function(P){return i.create(me(P))},Dt=qe(u);function $e(h){return pt("num < 2^"+u,h,de,Dt),i.toBytes(h)}function k(h,P){return U(h,void 0,"message"),P?U(e(h),void 0,"prehashed message"):h}function it(h,P,_){let{lowS:w,prehash:A,extraEntropy:E}=Jt(_,m);h=k(h,A);let y=fe(h),S=i.fromBytes(P);if(!i.isValidNot0(S))throw new Error("invalid private key");let N=[$e(S),$e(y)];if(E!=null&&E!==!1){let L=E===!0?r(l.secretKey):E;N.push(U(L,void 0,"extraEntropy"))}let K=Y(...N),v=y;function C(L){let H=me(L);if(!i.isValidNot0(H))return;let se=i.inv(H),V=t.BASE.multiply(H).toAffine(),W=i.create(V.x);if(W===de)return;let at=i.create(se*i.create(v+W*S));if(at===de)return;let Mn=(V.x===W?0:2)|Number(V.y&Be),Hn=at;return w&&x(at)&&(Hn=i.neg(at),Mn^=1),new Z(W,Hn,g?void 0:Mn)}return{seed:K,k2sig:C}}function _e(h,P,_={}){let{seed:w,k2sig:A}=it(h,P,_);return rr(e.outputLen,i.BYTES,o)(w,A).toBytes(_.format)}function D(h,P,_,w={}){let{lowS:A,prehash:E,format:y}=Jt(w,m);if(_=U(_,void 0,"publicKey"),P=k(P,E),!We(h)){let S=h instanceof Z?", use sig.toBytes()":"";throw new Error("verify expects Uint8Array signature"+S)}te(h,y);try{let S=Z.fromBytes(h,y),N=t.fromBytes(_);if(A&&S.hasHighS())return!1;let{r:K,s:v}=S,C=fe(P),L=i.inv(v),H=i.create(C*L),se=i.create(K*L),V=t.BASE.multiplyUnsafe(H).add(N.multiplyUnsafe(se));return V.is0()?!1:i.create(V.x)===K}catch{return!1}}function O(h,P,_={}){let{prehash:w}=Jt(_,m);return P=k(P,w),Z.fromBytes(h,"recovered").recoverPublicKey(P).toBytes()}return Object.freeze({keygen:c,getPublicKey:d,getSharedSecret:p,utils:f,lengths:l,Point:t,sign:_e,verify:D,recoverPublicKey:O,Signature:Z,hash:e})}var wt={p:BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),n:BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),h:BigInt(1),a:BigInt(0),b:BigInt(7),Gx:BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),Gy:BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")},fs={beta:BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),basises:[[BigInt("0x3086d221a7d46bcde86c90e49284eb15"),-BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],[BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"),BigInt("0x3086d221a7d46bcde86c90e49284eb15")]]},ls=BigInt(0),nn=BigInt(2);function ps(t){let e=wt.p,n=BigInt(3),r=BigInt(6),o=BigInt(11),s=BigInt(22),i=BigInt(23),a=BigInt(44),u=BigInt(88),c=t*t*t%e,d=c*c*t%e,p=X(d,n,e)*d%e,f=X(p,n,e)*d%e,l=X(f,nn,e)*c%e,m=X(l,o,e)*l%e,g=X(m,s,e)*m%e,x=X(g,a,e)*g%e,R=X(x,u,e)*x%e,j=X(R,a,e)*g%e,te=X(j,n,e)*d%e,Z=X(te,i,e)*m%e,me=X(Z,r,e)*c%e,fe=X(me,nn,e);if(!yt.eql(yt.sqr(fe),t))throw new Error("Cannot find square root");return fe}var yt=ke(wt.p,{sqrt:ps}),Ae=br(wt,{Fp:yt,endo:fs}),$=Sr(Ae,Pe),Tr={};function xt(t,...e){let n=Tr[t];if(n===void 0){let r=Pe(nr(t));n=Y(r,r),Tr[t]=n}return Pe(Y(n,...e))}var on=t=>t.toBytes(!0).slice(1),sn=t=>t%nn===ls;function rn(t){let{Fn:e,BASE:n}=Ae,r=e.fromBytes(t),o=n.multiply(r);return{scalar:sn(o.y)?r:e.neg(r),bytes:on(o)}}function Rr(t){let e=yt;if(!e.isValidNot0(t))throw new Error("invalid x: Fail if x \u2265 p");let n=e.create(t*t),r=e.create(n*t+BigInt(7)),o=e.sqrt(r);sn(o)||(o=e.neg(o));let s=Ae.fromAffine({x:t,y:o});return s.assertValidity(),s}var ze=he;function Nr(...t){return Ae.Fn.create(ze(xt("BIP0340/challenge",...t)))}function Ir(t){return rn(t).bytes}function Ps(t,e,n=le(32)){let{Fn:r}=Ae,o=U(t,void 0,"message"),{bytes:s,scalar:i}=rn(e),a=U(n,32,"auxRand"),u=r.toBytes(i^ze(xt("BIP0340/aux",a))),c=xt("BIP0340/nonce",u,s,o),{bytes:d,scalar:p}=rn(c),f=Nr(d,s,o),l=new Uint8Array(64);if(l.set(d,0),l.set(r.toBytes(r.create(p+f*i)),32),!Ur(l,o,s))throw new Error("sign: Invalid signature produced");return l}function Ur(t,e,n){let{Fp:r,Fn:o,BASE:s}=Ae,i=U(t,64,"signature"),a=U(e,void 0,"message"),u=U(n,32,"publicKey");try{let c=Rr(ze(u)),d=ze(i.subarray(0,32));if(!r.isValidNot0(d))return!1;let p=ze(i.subarray(32,64));if(!o.isValidNot0(p))return!1;let f=Nr(o.toBytes(d),on(c),a),l=s.multiplyUnsafe(p).add(c.multiplyUnsafe(o.neg(f))),{x:m,y:g}=l.toAffine();return!(l.is0()||!sn(g)||m!==d)}catch{return!1}}var J=(()=>{let n=(r=le(48))=>ht(r,wt.n);return{keygen:gt(n,Ir),getPublicKey:Ir,sign:Ps,verify:Ur,Point:Ae,utils:{randomSecretKey:n,taggedHash:xt,lift_x:Rr,pointToBytes:on},lengths:{secretKey:32,publicKey:32,publicKeyHasPrefix:!1,signature:64,seed:48}}})();var Cr={OP_0:0,OP_0NOTEQUAL:146,OP_1:81,OP_10:90,OP_11:91,OP_12:92,OP_13:93,OP_14:94,OP_15:95,OP_16:96,OP_1ADD:139,OP_1NEGATE:79,OP_1SUB:140,OP_2:82,OP_2DIV:142,OP_2DROP:109,OP_2DUP:110,OP_2MUL:141,OP_2OVER:112,OP_2ROT:113,OP_2SWAP:114,OP_3:83,OP_3DUP:111,OP_4:84,OP_5:85,OP_6:86,OP_7:87,OP_8:88,OP_9:89,OP_ABS:144,OP_ADD:147,OP_AND:132,OP_BIN2NUM:216,OP_BOOLAND:154,OP_BOOLOR:155,OP_CAT:126,OP_CHECKLOCKTIMEVERIFY:177,OP_CHECKMULTISIG:174,OP_CHECKMULTISIGVERIFY:175,OP_CHECKSEQUENCEVERIFY:178,OP_CHECKSIG:172,OP_CHECKSIGADD:186,OP_CHECKSIGFROMSTACK:204,OP_CHECKSIGVERIFY:173,OP_CHECKTIME:220,OP_CODESEPARATOR:171,OP_DATA_1:1,OP_DATA_10:10,OP_DATA_11:11,OP_DATA_12:12,OP_DATA_13:13,OP_DATA_14:14,OP_DATA_15:15,OP_DATA_16:16,OP_DATA_17:17,OP_DATA_18:18,OP_DATA_19:19,OP_DATA_2:2,OP_DATA_20:20,OP_DATA_21:21,OP_DATA_22:22,OP_DATA_23:23,OP_DATA_24:24,OP_DATA_25:25,OP_DATA_26:26,OP_DATA_27:27,OP_DATA_28:28,OP_DATA_29:29,OP_DATA_3:3,OP_DATA_30:30,OP_DATA_31:31,OP_DATA_32:32,OP_DATA_33:33,OP_DATA_34:34,OP_DATA_35:35,OP_DATA_36:36,OP_DATA_37:37,OP_DATA_38:38,OP_DATA_39:39,OP_DATA_4:4,OP_DATA_40:40,OP_DATA_41:41,OP_DATA_42:42,OP_DATA_43:43,OP_DATA_44:44,OP_DATA_45:45,OP_DATA_46:46,OP_DATA_47:47,OP_DATA_48:48,OP_DATA_49:49,OP_DATA_5:5,OP_DATA_50:50,OP_DATA_51:51,OP_DATA_52:52,OP_DATA_53:53,OP_DATA_54:54,OP_DATA_55:55,OP_DATA_56:56,OP_DATA_57:57,OP_DATA_58:58,OP_DATA_59:59,OP_DATA_6:6,OP_DATA_60:60,OP_DATA_61:61,OP_DATA_62:62,OP_DATA_63:63,OP_DATA_64:64,OP_DATA_65:65,OP_DATA_66:66,OP_DATA_67:67,OP_DATA_68:68,OP_DATA_69:69,OP_DATA_7:7,OP_DATA_70:70,OP_DATA_71:71,OP_DATA_72:72,OP_DATA_73:73,OP_DATA_74:74,OP_DATA_75:75,OP_DATA_8:8,OP_DATA_9:9,OP_DEPTH:116,OP_DIGEST:195,OP_DIV:150,OP_DROP:117,OP_DUP:118,OP_ECADD:224,OP_ECMUL:225,OP_ECMULSCALARVERIFY:227,OP_ECPAIRING:226,OP_ELSE:103,OP_ENDIF:104,OP_EQUAL:135,OP_EQUALVERIFY:136,OP_FALSE:0,OP_FINDASSETGROUPBYASSETID:232,OP_FROMALTSTACK:108,OP_GREATERTHAN:160,OP_GREATERTHANOREQUAL:162,OP_HASH160:169,OP_HASH256:170,OP_IF:99,OP_IFDUP:115,OP_INSPECTASSETGROUP:235,OP_INSPECTASSETGROUPASSETID:230,OP_INSPECTASSETGROUPCTRL:231,OP_INSPECTASSETGROUPMETADATAHASH:233,OP_INSPECTASSETGROUPNUM:234,OP_INSPECTASSETGROUPSUM:236,OP_INSPECTINASSETAT:241,OP_INSPECTINASSETCOUNT:240,OP_INSPECTINASSETLOOKUP:242,OP_INSPECTINPUTARKADESCRIPTHASH:200,OP_INSPECTINPUTARKADEWITNESSHASH:206,OP_INSPECTINPUTOUTPOINT:199,OP_INSPECTINPUTPACKET:245,OP_INSPECTINPUTSCRIPTPUBKEY:202,OP_INSPECTINPUTSEQUENCE:203,OP_INSPECTINPUTVALUE:201,OP_INSPECTINTENTMESSAGE:248,OP_INSPECTLOCKTIME:211,OP_INSPECTNUMASSETGROUPS:229,OP_INSPECTNUMINPUTS:212,OP_INSPECTNUMOUTPUTS:213,OP_INSPECTOUTASSETAT:238,OP_INSPECTOUTASSETCOUNT:237,OP_INSPECTOUTASSETLOOKUP:239,OP_INSPECTOUTPUTSCRIPTPUBKEY:209,OP_INSPECTOUTPUTVALUE:207,OP_INSPECTPACKET:244,OP_INSPECTVERSION:210,OP_INVALIDOPCODE:255,OP_INVERT:131,OP_LEFT:128,OP_LESSTHAN:159,OP_LESSTHANOREQUAL:161,OP_LSHIFT:152,OP_MAX:164,OP_MERKLEBRANCHVERIFY:179,OP_MIN:163,OP_MOD:151,OP_MODEXP:218,OP_MUL:149,OP_NEGATE:143,OP_NIP:119,OP_NOP:97,OP_NOP1:176,OP_NOP10:185,OP_NOP2:177,OP_NOP3:178,OP_NOP5:180,OP_NOP6:181,OP_NOP7:182,OP_NOP8:183,OP_NOP9:184,OP_NOT:145,OP_NOTIF:100,OP_NUM2BIN:215,OP_NUMEQUAL:156,OP_NUMEQUALVERIFY:157,OP_NUMNOTEQUAL:158,OP_OR:133,OP_OVER:120,OP_PICK:121,OP_PUBKEY:254,OP_PUBKEYHASH:253,OP_PUBKEYS:251,OP_PUSHCURRENTINPUTINDEX:205,OP_PUSHDATA1:76,OP_PUSHDATA2:77,OP_PUSHDATA4:78,OP_PUSHEXPIRY:219,OP_PUT:187,OP_RESERVED:80,OP_RESERVED1:137,OP_RESERVED2:138,OP_RETURN:106,OP_REVERSEBYTES:217,OP_RIGHT:129,OP_RIPEMD160:166,OP_ROLL:122,OP_ROT:123,OP_RSHIFT:153,OP_SHA1:167,OP_SHA256:168,OP_SHA256FINALIZE:198,OP_SHA256INITIALIZE:196,OP_SHA256UPDATE:197,OP_SIGHASH:246,OP_SIZE:130,OP_SMALLINTEGER:250,OP_SUB:148,OP_SUBSTR:127,OP_SWAP:124,OP_TOALTSTACK:107,OP_TRUE:81,OP_TUCK:125,OP_TUNNEL:247,OP_TWEAKVERIFY:228,OP_TXID:243,OP_TXWEIGHT:214,OP_UNKNOWN188:188,OP_UNKNOWN189:189,OP_UNKNOWN190:190,OP_UNKNOWN191:191,OP_UNKNOWN192:192,OP_UNKNOWN193:193,OP_UNKNOWN194:194,OP_UNKNOWN208:208,OP_UNKNOWN221:221,OP_UNKNOWN222:222,OP_UNKNOWN223:223,OP_UNKNOWN249:249,OP_UNKNOWN252:252,OP_VER:98,OP_VERIF:101,OP_VERIFY:105,OP_VERNOTIF:102,OP_WITHIN:165,OP_XOR:134};var cn=t=>new TextEncoder().encode(t);function Se(...t){let e=new Uint8Array(t.reduce((r,o)=>r+o.length,0)),n=0;for(let r of t)e.set(r,n),n+=r.length;return e}function Qe(t,e){let n=BigInt(t);(n<0n||n>=1n<<BigInt(8*e))&&ie("INVALID",`value does not fit ${e} bytes`);let r=new Uint8Array(e);for(let o=0;o<e;o++,n>>=8n)r[o]=Number(n&0xffn);return r}function Je(t){let e=BigInt(t);if(e===0n)return new Uint8Array;let n=e<0n;n&&(e=-e);let r=[];for(;e>0n;e>>=8n)r.push(Number(e&0xffn));return r[r.length-1]&128?r.push(n?128:0):n&&(r[r.length-1]|=128),Uint8Array.from(r)}function un(t){if(t.length===0)return 0n;let e=t[t.length-1];(e&127)===0&&(t.length===1||!(t[t.length-2]&128))&&ie("INVALID","non-minimal script number");let n=0n;for(let r=t.length-1;r>=0;r--)n=n<<8n|BigInt(r===t.length-1?e&127:t[r]);return e&128?-n:n}function dn(t){return t<253?Uint8Array.of(t):t<=65535?Se([253],Qe(t,2)):Se([254],Qe(t,4))}function Le(t){return t>=512?1<<22|Math.floor(t/512):t}var Dr=0,an=76,Os=77,gs=78,kr=79,vr=81,Xe=class{bytes=[];addOp(e){return this.bytes.push(e),this}addInt(e){let n=BigInt(e);return n===0n?this.addOp(Dr):n===-1n?this.addOp(kr):n>=1n&&n<=16n?this.addOp(vr-1+Number(n)):this.addData(Je(n))}addData(e){let n=e.length;return n===0||n===1&&e[0]===0?this.addOp(Dr):n===1&&e[0]<=16?this.addOp(vr-1+e[0]):n===1&&e[0]===129?this.addOp(kr):(n<an?this.bytes.push(n):n<=255?this.bytes.push(an,n):n<=65535?this.bytes.push(Os,...Qe(n,2)):this.bytes.push(gs,...Qe(n,4)),this.bytes.push(...e),this)}addRawPush(e){return e.length===0||e.length>=an?this.addData(e):(this.bytes.push(e.length,...e),this)}script(){return Uint8Array.from(this.bytes)}};function Pn(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function ms(t){if(!Pn(t))throw new Error("Uint8Array expected")}function Kr(t,e){return Array.isArray(e)?e.length===0?!0:t?e.every(n=>typeof n=="string"):e.every(n=>Number.isSafeInteger(n)):!1}function Mr(t){if(typeof t!="function")throw new Error("function expected");return!0}function Ve(t,e){if(typeof e!="string")throw new Error(`${t}: string expected`);return!0}function Hr(t){if(!Number.isSafeInteger(t))throw new Error(`invalid integer: ${t}`)}function fn(t){if(!Array.isArray(t))throw new Error("array expected")}function $r(t,e){if(!Kr(!0,e))throw new Error(`${t}: array of strings expected`)}function Wr(t,e){if(!Kr(!1,e))throw new Error(`${t}: array of numbers expected`)}function hn(...t){let e=s=>s,n=(s,i)=>a=>s(i(a)),r=t.map(s=>s.encode).reduceRight(n,e),o=t.map(s=>s.decode).reduce(n,e);return{encode:r,decode:o}}function On(t){let e=typeof t=="string"?t.split(""):t,n=e.length;$r("alphabet",e);let r=new Map(e.map((o,s)=>[o,s]));return{encode:o=>(fn(o),o.map(s=>{if(!Number.isSafeInteger(s)||s<0||s>=n)throw new Error(`alphabet.encode: digit index outside alphabet "${s}". Allowed: ${t}`);return e[s]})),decode:o=>(fn(o),o.map(s=>{Ve("alphabet.decode",s);let i=r.get(s);if(i===void 0)throw new Error(`Unknown letter: "${s}". Allowed: ${t}`);return i}))}}function gn(t=""){return Ve("join",t),{encode:e=>($r("join.decode",e),e.join(t)),decode:e=>(Ve("join.decode",e),e.split(t))}}function _s(t){return Mr(t),{encode:e=>e,decode:e=>t(e)}}var Fr=(t,e)=>e===0?t:Fr(e,t%e),Et=(t,e)=>t+(e-Fr(t,e)),bt=(()=>{let t=[];for(let e=0;e<40;e++)t.push(2**e);return t})();function ln(t,e,n,r){if(fn(t),e<=0||e>32)throw new Error(`convertRadix2: wrong from=${e}`);if(n<=0||n>32)throw new Error(`convertRadix2: wrong to=${n}`);if(Et(e,n)>32)throw new Error(`convertRadix2: carry overflow from=${e} to=${n} carryBits=${Et(e,n)}`);let o=0,s=0,i=bt[e],a=bt[n]-1,u=[];for(let c of t){if(Hr(c),c>=i)throw new Error(`convertRadix2: invalid data word=${c} from=${e}`);if(o=o<<e|c,s+e>32)throw new Error(`convertRadix2: carry overflow pos=${s} from=${e}`);for(s+=e;s>=n;s-=n)u.push((o>>s-n&a)>>>0);let d=bt[s];if(d===void 0)throw new Error("invalid carry");o&=d-1}if(o=o<<n-s&a,!r&&s>=e)throw new Error("Excess padding");if(!r&&o>0)throw new Error(`Non-zero padding: ${o}`);return r&&s>0&&u.push(o>>>0),u}function mn(t,e=!1){if(Hr(t),t<=0||t>32)throw new Error("radix2: bits should be in (0..32]");if(Et(8,t)>32||Et(t,8)>32)throw new Error("radix2: carry overflow");return{encode:n=>{if(!Pn(n))throw new Error("radix2.encode input should be Uint8Array");return ln(Array.from(n),8,t,!e)},decode:n=>(Wr("radix2.decode",n),Uint8Array.from(ln(n,t,8,e)))}}function Br(t){return Mr(t),function(...e){try{return t.apply(null,e)}catch{}}}var Gr=hn(mn(6),On("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"),gn(""));var pn=hn(On("qpzry9x8gf2tvdw0s3jn54khce6mua7l"),gn("")),Lr=[996825010,642813549,513874426,1027748829,705979059];function et(t){let e=t>>25,n=(t&33554431)<<5;for(let r=0;r<Lr.length;r++)(e>>r&1)===1&&(n^=Lr[r]);return n}function Vr(t,e,n=1){let r=t.length,o=1;for(let s=0;s<r;s++){let i=t.charCodeAt(s);if(i<33||i>126)throw new Error(`Invalid prefix (${t})`);o=et(o)^i>>5}o=et(o);for(let s=0;s<r;s++)o=et(o)^t.charCodeAt(s)&31;for(let s of e)o=et(o)^s;for(let s=0;s<6;s++)o=et(o);return o^=n,pn.encode(ln([o%bt[30]],30,5,!1))}function ys(t){let e=t==="bech32"?1:734539939,n=mn(5),r=n.decode,o=n.encode,s=Br(r);function i(p,f,l=90){Ve("bech32.encode prefix",p),Pn(f)&&(f=Array.from(f)),Wr("bech32.encode",f);let m=p.length;if(m===0)throw new TypeError(`Invalid prefix length ${m}`);let g=m+7+f.length;if(l!==!1&&g>l)throw new TypeError(`Length ${g} exceeds limit ${l}`);let x=p.toLowerCase(),R=Vr(x,f,e);return`${x}1${pn.encode(f)}${R}`}function a(p,f=90){Ve("bech32.decode input",p);let l=p.length;if(l<8||f!==!1&&l>f)throw new TypeError(`invalid string length: ${l} (${p}). Expected (8..${f})`);let m=p.toLowerCase();if(p!==m&&p!==p.toUpperCase())throw new Error("String must be lowercase or uppercase");let g=m.lastIndexOf("1");if(g===0||g===-1)throw new Error('Letter "1" must be present between prefix and data only');let x=m.slice(0,g),R=m.slice(g+1);if(R.length<6)throw new Error("Data must be at least 6 characters long");let j=pn.decode(R).slice(0,-6),te=Vr(x,j,e);if(!R.endsWith(te))throw new Error(`Invalid checksum in ${p}: expected "${te}"`);return{prefix:x,words:j}}let u=Br(a);function c(p){let{prefix:f,words:l}=a(p,!1);return{prefix:f,words:l,bytes:r(l)}}function d(p,f){return i(p,o(f))}return{encode:i,decode:a,encodeFromBytes:d,decodeToBytes:c,decodeUnsafe:u,fromWords:r,fromWordsUnsafe:s,toWords:o}}var Ke=ys("bech32m");var xs=typeof Uint8Array.from([]).toHex=="function"&&typeof Uint8Array.fromHex=="function",ws={encode(t){return ms(t),t.toHex()},decode(t){return Ve("hex",t),Uint8Array.fromHex(t)}},ae=xs?ws:hn(mn(4),On("0123456789abcdef"),gn(""),_s(t=>{if(typeof t!="string"||t.length%2!==0)throw new TypeError(`hex.decode: expected string, got ${typeof t} with length ${t.length}`);return t.toLowerCase()}));var nt=(t,...e)=>J.utils.taggedHash(t,...e),Yr=z("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"),qr=$.Point.CURVE().n,tt=t=>BigInt(`0x${B(t)||"0"}`);function Te(t){let e=z(t);return e.length===32?(J.utils.lift_x(tt(e)),e):(I(e.length===33,"INVALID","key must be 32 or 33 bytes"),$.Point.fromHex(t),e.slice(1))}var bs=t=>nt("TapLeaf",Uint8Array.of(192),dn(t.length),t);function _n(t,e){let[n,r]=B(t)<B(e)?[t,e]:[e,t];return nt("TapBranch",n,r)}function Es(t){let e=t.map(bs);if(e.length===1)return e[0];let n=[];for(let r=0;r<e.length;r+=2)r===e.length-1?n[n.length-1]=_n(n[n.length-1],e[r]):n.push(_n(e[r],e[r+1]));for(;n.length>1;)n.push(_n(n.shift(),n.shift()));return n[0]}function yn(t){let e=J.utils.lift_x(tt(Yr)),n=tt(nt("TapTweak",Yr,Es(t)))%qr;return e.add($.Point.BASE.multiply(n)).toBytes(!0).slice(1)}function jr(t,e){let n=J.utils.lift_x(tt(Te(t))),r=tt(nt("ArkScriptHash",e))%qr;return n.add($.Point.BASE.multiply(r)).toBytes(!0).slice(1)}var Zr=t=>Se([81,32],t),As=t=>t==="bitcoin"?"ark":"tark";function xn(t,e,n){let r=z(n);return I(r.length===34&&r[0]===81&&r[1]===32,"INVALID","not a P2TR script"),Ke.encode(As(t),Ke.toWords(Se([0],Te(e),r.slice(2))),1023)}function At(t){let e=t.trim().toLowerCase();I(e.startsWith("ark1")||e.startsWith("tark1"),"ADDRESS_INVALID","not an Ark address");let n;try{n=Ke.fromWords(Ke.decode(e,1023).words)}catch{return ie("ADDRESS_INVALID","bad Ark address")}return I(n.length===65&&n[0]===0,"ADDRESS_INVALID","unknown Ark address version"),{serverKey:B(n.slice(1,33)),pkScript:B(Zr(n.slice(33)))}}var Ss=Cr,Ts=/^(0|-?[1-9][0-9]*)$/,Is=/^0x([0-9a-f]{2})+$/,Rs=/^<([^<>]+)>$/,St=2n**53n-1n,Xr=520;function Ns(t){let e=Ss[t];return I(e!==void 0,"CONTRACT_INVALID",`unknown opcode ${t}`),I(e===0||e>78,"CONTRACT_INVALID",`push opcode ${t}`),e}function zr(t,e,n){I(n.length<=Xr,"CONTRACT_INVALID",`${e}: push too large`),n.length===1&&n[0]===0?t.addRawPush(n):t.addData(n)}function Qr(t,e){let n=new Xe;for(let r of t)if(r.startsWith("OP_"))n.addOp(Ns(r));else if(Ts.test(r)){let o=BigInt(r);I(o<=St&&o>=-St,"CONTRACT_INVALID",`number ${r} out of range`),n.addInt(o)}else if(Is.test(r))zr(n,r,z(r.slice(2)));else{let o=Rs.exec(r)?.[1];I(o,"CONTRACT_INVALID",`unsupported token ${r}`);let s=e(o);s.type==="int"?n.addInt(un(s.raw)):zr(n,r,s.raw)}return n.script()}function Us(t,e){let n=z(e);switch(t){case"pubkey":return I(n.length===33,"CONTRACT_ARGUMENT","pubkey must be 33 bytes"),$.Point.fromHex(e),n;case"bytes32":return I(n.length===32,"CONTRACT_ARGUMENT","bytes32 must be 32 bytes"),n;case"bytes20":return I(n.length===20,"CONTRACT_ARGUMENT","bytes20 must be 20 bytes"),n;case"int":{let r=un(n);return I(r<=St&&r>=-St,"CONTRACT_ARGUMENT","int out of range"),n}case"bool":return I(e===""||e==="01","CONTRACT_ARGUMENT","bool must be empty or 01"),n;case"bytes":return I(n.length<=Xr,"CONTRACT_ARGUMENT","bytes too long"),n}}function Me(t,e,n){let r=new Map;for(let f of t.constructorInputs){let l=e[f.name];I(l!==void 0,"CONTRACT_ARGUMENT",`missing ${f.name}`),r.set(f.name,{type:f.type,raw:Us(f.type,l)})}I(Object.keys(e).every(f=>r.has(f)),"CONTRACT_ARGUMENT","unknown constructor argument");let o=f=>{let l=r.get(f);return I(l,"CONTRACT_INVALID",`unknown constructor value ${f}`),l},s=f=>f==="DELEGATE_KEY"?{type:"bytes",raw:new TextEncoder().encode(n.delegate)}:o(f),i={};for(let f of t.functions)f.arkade&&(i[f.name]=Qr(f.arkade.asm,s));let a=(f,l)=>{let m=i[l];return I(m,"CONTRACT_INVALID",`function ${l} has no covenant`),{type:"bytes32",raw:jr(f,m)}},u=f=>{let l=f.split(":");if(f==="SERVER_KEY")return{type:"bytes32",raw:Te(n.server)};if(f==="DELEGATE_KEY")return{type:"bytes32",raw:Te(n.delegate)};if(l.length===2&&l[0]==="EMULATOR_KEY")return a(n.emulator,l[1]);if(l.length===3&&l[0]==="TWEAK")return a(B(o(l[1]).raw),l[2]);I(l.length===1,"CONTRACT_INVALID",`unsupported placeholder ${f}`);let m=o(f);return m.type==="pubkey"?{type:"bytes32",raw:Te(B(m.raw))}:m},c=[],d=[];for(let f of t.functions)for(let l of f.leaves){let m=B(Qr(l.asm,u));I(!c.includes(m),"CONTRACT_INVALID",`duplicate leaf ${f.name}/${l.name}`),c.push(m),d.push([f.name,l.name])}I(c.length>0,"CONTRACT_INVALID","no leaves");let p=yn(c.map(z));return{covenants:i,tapscripts:c,leafNames:d,pkScript:`5120${B(p)}`,outputKey:B(p)}}var Jr={format:"delegateed-template/v1",type:"intent",variables:{owner:"pubkey",boarding_exit_delay:"int",exit_delay:"int",renewal_window:"int",max_fee:"int"},inputs:[{name:"deposit",type:"onchain",schedule:{min_confirmations:1},contract:{definition:{contractName:"DelegatedBoarding",constructorInputs:[{name:"owner",type:"pubkey"},{name:"boardingExitDelay",type:"int"},{name:"renewalProgram",type:"bytes32"},{name:"maxFee",type:"int"}],structs:[],functions:[{name:"forfeit",leaves:[{name:"forfeit",asm:["<owner>","OP_CHECKSIGVERIFY","<SERVER_KEY>","OP_CHECKSIG"],witness:[{name:"ownerSig",type:"signature",encoding:"schnorr-64"},{name:"serverSig",type:"signature",encoding:"schnorr-64",injected:!0}]}]},{name:"exit",leaves:[{name:"exit",asm:["<boardingExitDelay>","OP_CHECKSEQUENCEVERIFY","OP_DROP","<owner>","OP_CHECKSIG"],witness:[{name:"ownerSig",type:"signature",encoding:"schnorr-64"}]}]},{name:"board",arkade:{inputs:[],asm:["0x74797065","OP_INSPECTINTENTMESSAGE","OP_VERIFY","0x7265676973746572","OP_EQUALVERIFY","0x6f6e636861696e5f6f75747075745f696e6465786573","OP_INSPECTINTENTMESSAGE","OP_VERIFY","0x5b5d","OP_EQUALVERIFY","0x636f7369676e6572735f7075626c69635f6b6579732e30","OP_INSPECTINTENTMESSAGE","OP_VERIFY","<DELEGATE_KEY>","OP_EQUALVERIFY","0x636f7369676e6572735f7075626c69635f6b6579732e31","OP_INSPECTINTENTMESSAGE","OP_NOT","OP_VERIFY","OP_DROP","OP_PUSHCURRENTINPUTINDEX","OP_1SUB","OP_INSPECTOUTPUTSCRIPTPUBKEY","1","OP_EQUALVERIFY","<renewalProgram>","OP_EQUALVERIFY","OP_PUSHCURRENTINPUTINDEX","OP_1SUB","OP_INSPECTOUTPUTVALUE","<maxFee>","OP_ADD","OP_PUSHCURRENTINPUTINDEX","OP_INSPECTINPUTVALUE","OP_GREATERTHANOREQUAL"]},leaves:[{name:"board",asm:["<SERVER_KEY>","OP_CHECKSIGVERIFY","<EMULATOR_KEY:board>","OP_CHECKSIG"],witness:[{name:"serverSig",type:"signature",encoding:"schnorr-64",injected:!0},{name:"emulatorSig",type:"signature",encoding:"schnorr-64",injected:!0}]}]}]},arguments:{owner:"<owner>",boardingExitDelay:"<boarding_exit_delay>",renewalProgram:{program:"funds"},maxFee:"<max_fee>"}},spend:{function:"board",leaf:"board"}}],outputs:[{name:"funds",index:0,value:{from:"deposit"},locking:{contract:{definition:{artifact:"SIMPLE_WALLET"},arguments:{owner:"<owner>",exitDelay:"<exit_delay>",renewalWindow:"<renewal_window>",maxFee:"<max_fee>"}}}}],fees:{from:"deposit",max:"<max_fee>"},packets:{output_index:1}};var Ie=t=>B(Je(t)),eo=t=>Ie(Le(t));var Ds=Jr.inputs[0].contract.definition;var Tt={operatorKey:"038202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c",emulatorKey:"0239c196415da47b26456a101daaa12ba9e445bfe153197f1e2b750bf40e52092e",exitDelaySeconds:605184};var Ls={escrowSats:5e4,contributionSats:1e5,treasurySats:1e6},to=t=>t==="bitcoin"?Ls:void 0,Nd={regtest:600,mutinynet:1800,bitcoin:3*3600};function no(t,e){if(t.length!==e.length)return!1;for(let n=0;n<t.length;n++)if(t[n]!==e[n])return!1;return!0}function He(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function Vs(...t){let e=0;for(let r=0;r<t.length;r++){let o=t[r];if(!He(o))throw new Error("Uint8Array expected");e+=o.length}let n=new Uint8Array(e);for(let r=0,o=0;r<t.length;r++){let s=t[r];n.set(s,o),o+=s.length}return n}var An=t=>new DataView(t.buffer,t.byteOffset,t.byteLength);function It(t){return Object.prototype.toString.call(t)==="[object Object]"}function rt(t){return Number.isSafeInteger(t)}var Rt={equalBytes:no,isBytes:He,isCoder:Re,checkBounds:ro,concatBytes:Vs,createView:An,isPlainObject:It},Ks=t=>{if(t!==null&&typeof t!="string"&&!Re(t)&&!He(t)&&!rt(t))throw new Error(`lengthCoder: expected null | number | Uint8Array | CoderType, got ${t} (${typeof t})`);return{encodeStream(e,n){if(t===null)return;if(Re(t))return t.encodeStream(e,n);let r;if(typeof t=="number"?r=t:typeof t=="string"&&(r=Ne.resolve(e.stack,t)),typeof r=="bigint"&&(r=Number(r)),r===void 0||r!==n)throw e.err(`Wrong length: ${r} len=${t} exp=${n} (${typeof n})`)},decodeStream(e){let n;if(Re(t)?n=Number(t.decodeStream(e)):typeof t=="number"?n=t:typeof t=="string"&&(n=Ne.resolve(e.stack,t)),typeof n=="bigint"&&(n=Number(n)),typeof n!="number")throw e.err(`Wrong length: ${n}`);return n}}},M={BITS:32,FULL_MASK:-1>>>0,len:t=>Math.ceil(t/32),create:t=>new Uint32Array(M.len(t)),clean:t=>t.fill(0),debug:t=>Array.from(t).map(e=>(e>>>0).toString(2).padStart(32,"0")),checkLen:(t,e)=>{if(M.len(e)!==t.length)throw new Error(`wrong length=${t.length}. Expected: ${M.len(e)}`)},chunkLen:(t,e,n)=>{if(e<0)throw new Error(`wrong pos=${e}`);if(e+n>t)throw new Error(`wrong range=${e}/${n} of ${t}`)},set:(t,e,n,r=!0)=>!r&&(t[e]&n)!==0?!1:(t[e]|=n,!0),pos:(t,e)=>({chunk:Math.floor((t+e)/32),mask:1<<32-(t+e)%32-1}),indices:(t,e,n=!1)=>{M.checkLen(t,e);let{FULL_MASK:r,BITS:o}=M,s=o-e%o,i=s?r>>>s<<s:r,a=[];for(let u=0;u<t.length;u++){let c=t[u];if(n&&(c=~c),u===t.length-1&&(c&=i),c!==0)for(let d=0;d<o;d++){let p=1<<o-d-1;c&p&&a.push(u*o+d)}}return a},range:t=>{let e=[],n;for(let r of t)n===void 0||r!==n.pos+n.length?e.push(n={pos:r,length:1}):n.length+=1;return e},rangeDebug:(t,e,n=!1)=>`[${M.range(M.indices(t,e,n)).map(r=>`(${r.pos}/${r.length})`).join(", ")}]`,setRange:(t,e,n,r,o=!0)=>{M.chunkLen(e,n,r);let{FULL_MASK:s,BITS:i}=M,a=n%i?Math.floor(n/i):void 0,u=n+r,c=u%i?Math.floor(u/i):void 0;if(a!==void 0&&a===c)return M.set(t,a,s>>>i-r<<i-r-n,o);if(a!==void 0&&!M.set(t,a,s>>>n%i,o))return!1;let d=a!==void 0?a+1:n/i,p=c!==void 0?c:u/i;for(let f=d;f<p;f++)if(!M.set(t,f,s,o))return!1;return!(c!==void 0&&a!==c&&!M.set(t,c,s<<i-u%i,o))}},Ne={pushObj:(t,e,n)=>{let r={obj:e};t.push(r),n((o,s)=>{r.field=o,s(),r.field=void 0}),t.pop()},path:t=>{let e=[];for(let n of t)n.field!==void 0&&e.push(n.field);return e.join("/")},err:(t,e,n)=>{let r=new Error(`${t}(${Ne.path(e)}): ${typeof n=="string"?n:n.message}`);return n instanceof Error&&n.stack&&(r.stack=n.stack),r},resolve:(t,e)=>{let n=e.split("/"),r=t.map(i=>i.obj),o=0;for(;o<n.length&&n[o]==="..";o++)r.pop();let s=r.pop();for(;o<n.length;o++){if(!s||s[n[o]]===void 0)return;s=s[n[o]]}return s}},wn=class t{pos=0;data;opts;stack;parent;parentOffset;bitBuf=0;bitPos=0;bs;view;constructor(e,n={},r=[],o=void 0,s=0){this.data=e,this.opts=n,this.stack=r,this.parent=o,this.parentOffset=s,this.view=An(e)}_enablePointers(){if(this.parent)return this.parent._enablePointers();this.bs||(this.bs=M.create(this.data.length),M.setRange(this.bs,this.data.length,0,this.pos,this.opts.allowMultipleReads))}markBytesBS(e,n){return this.parent?this.parent.markBytesBS(this.parentOffset+e,n):!n||!this.bs?!0:M.setRange(this.bs,this.data.length,e,n,!1)}markBytes(e){let n=this.pos;this.pos+=e;let r=this.markBytesBS(n,e);if(!this.opts.allowMultipleReads&&!r)throw this.err(`multiple read pos=${this.pos} len=${e}`);return r}pushObj(e,n){return Ne.pushObj(this.stack,e,n)}readView(e,n){if(!Number.isFinite(e))throw this.err(`readView: wrong length=${e}`);if(this.pos+e>this.data.length)throw this.err("readView: Unexpected end of buffer");let r=n(this.view,this.pos);return this.markBytes(e),r}absBytes(e){if(e>this.data.length)throw new Error("Unexpected end of buffer");return this.data.subarray(e)}finish(){if(!this.opts.allowUnreadBytes){if(this.bitPos)throw this.err(`${this.bitPos} bits left after unpack: ${ae.encode(this.data.slice(this.pos))}`);if(this.bs&&!this.parent){let e=M.indices(this.bs,this.data.length,!0);if(e.length){let n=M.range(e).map(({pos:r,length:o})=>`(${r}/${o})[${ae.encode(this.data.subarray(r,r+o))}]`).join(", ");throw this.err(`unread byte ranges: ${n} (total=${this.data.length})`)}else return}if(!this.isEnd())throw this.err(`${this.leftBytes} bytes ${this.bitPos} bits left after unpack: ${ae.encode(this.data.slice(this.pos))}`)}}err(e){return Ne.err("Reader",this.stack,e)}offsetReader(e){if(e>this.data.length)throw this.err("offsetReader: Unexpected end of buffer");return new t(this.absBytes(e),this.opts,this.stack,this,e)}bytes(e,n=!1){if(this.bitPos)throw this.err("readBytes: bitPos not empty");if(!Number.isFinite(e))throw this.err(`readBytes: wrong length=${e}`);if(this.pos+e>this.data.length)throw this.err("readBytes: Unexpected end of buffer");let r=this.data.subarray(this.pos,this.pos+e);return n||this.markBytes(e),r}byte(e=!1){if(this.bitPos)throw this.err("readByte: bitPos not empty");if(this.pos+1>this.data.length)throw this.err("readBytes: Unexpected end of buffer");let n=this.data[this.pos];return e||this.markBytes(1),n}get leftBytes(){return this.data.length-this.pos}get totalBytes(){return this.data.length}isEnd(){return this.pos>=this.data.length&&!this.bitPos}bits(e){if(e>32)throw this.err("BitReader: cannot read more than 32 bits in single call");let n=0;for(;e;){this.bitPos||(this.bitBuf=this.byte(),this.bitPos=8);let r=Math.min(e,this.bitPos);this.bitPos-=r,n=n<<r|this.bitBuf>>this.bitPos&2**r-1,this.bitBuf&=2**this.bitPos-1,e-=r}return n>>>0}find(e,n=this.pos){if(!He(e))throw this.err(`find: needle is not bytes! ${e}`);if(this.bitPos)throw this.err("findByte: bitPos not empty");if(!e.length)throw this.err("find: needle is empty");for(let r=n;(r=this.data.indexOf(e[0],r))!==-1;r++){if(r===-1||this.data.length-r<e.length)return;if(no(e,this.data.subarray(r,r+e.length)))return r}}},bn=class{pos=0;stack;buffers=[];ptrs=[];bitBuf=0;bitPos=0;viewBuf=new Uint8Array(8);view;finished=!1;constructor(e=[]){this.stack=e,this.view=An(this.viewBuf)}pushObj(e,n){return Ne.pushObj(this.stack,e,n)}writeView(e,n){if(this.finished)throw this.err("buffer: finished");if(!rt(e)||e>8)throw new Error(`wrong writeView length=${e}`);n(this.view),this.bytes(this.viewBuf.slice(0,e)),this.viewBuf.fill(0)}err(e){if(this.finished)throw this.err("buffer: finished");return Ne.err("Reader",this.stack,e)}bytes(e){if(this.finished)throw this.err("buffer: finished");if(this.bitPos)throw this.err("writeBytes: ends with non-empty bit buffer");this.buffers.push(e),this.pos+=e.length}byte(e){if(this.finished)throw this.err("buffer: finished");if(this.bitPos)throw this.err("writeByte: ends with non-empty bit buffer");this.buffers.push(new Uint8Array([e])),this.pos++}finish(e=!0){if(this.finished)throw this.err("buffer: finished");if(this.bitPos)throw this.err("buffer: ends with non-empty bit buffer");let n=this.buffers.concat(this.ptrs.map(s=>s.buffer)),r=n.map(s=>s.length).reduce((s,i)=>s+i,0),o=new Uint8Array(r);for(let s=0,i=0;s<n.length;s++){let a=n[s];o.set(a,i),i+=a.length}for(let s=this.pos,i=0;i<this.ptrs.length;i++){let a=this.ptrs[i];o.set(a.ptr.encode(s),a.pos),s+=a.buffer.length}if(e){this.buffers=[];for(let s of this.ptrs)s.buffer.fill(0);this.ptrs=[],this.finished=!0,this.bitBuf=0}return o}bits(e,n){if(n>32)throw this.err("writeBits: cannot write more than 32 bits in single call");if(e>=2**n)throw this.err(`writeBits: value (${e}) >= 2**bits (${n})`);for(;n;){let r=Math.min(n,8-this.bitPos);this.bitBuf=this.bitBuf<<r|e>>n-r,this.bitPos+=r,n-=r,e&=2**n-1,this.bitPos===8&&(this.bitPos=0,this.buffers.push(new Uint8Array([this.bitBuf])),this.pos++)}}},En=t=>Uint8Array.from(t).reverse();function ro(t,e,n){if(n){let r=2n**(e-1n);if(t<-r||t>=r)throw new Error(`value out of signed bounds. Expected ${-r} <= ${t} < ${r}`)}else if(0n>t||t>=2n**e)throw new Error(`value out of unsigned bounds. Expected 0 <= ${t} < ${2n**e}`)}function oo(t){return{encodeStream:t.encodeStream,decodeStream:t.decodeStream,size:t.size,encode:e=>{let n=new bn;return t.encodeStream(n,e),n.finish()},decode:(e,n={})=>{let r=new wn(e,n),o=t.decodeStream(r);return r.finish(),o}}}function Sn(t,e){if(!Re(t))throw new Error(`validate: invalid inner value ${t}`);if(typeof e!="function")throw new Error("validate: fn should be function");return oo({size:t.size,encodeStream:(n,r)=>{let o;try{o=e(r)}catch(s){throw n.err(s)}t.encodeStream(n,o)},decodeStream:n=>{let r=t.decodeStream(n);try{return e(r)}catch(o){throw n.err(o)}}})}var Nt=t=>{let e=oo(t);return t.validate?Sn(e,t.validate):e},so=t=>It(t)&&typeof t.decode=="function"&&typeof t.encode=="function";function Re(t){return It(t)&&so(t)&&typeof t.encodeStream=="function"&&typeof t.decodeStream=="function"&&(t.size===void 0||rt(t.size))}var Ms=(t,e=!1,n=!1,r=!0)=>{if(!rt(t))throw new Error(`bigint/size: wrong value ${t}`);if(typeof e!="boolean")throw new Error(`bigint/le: expected boolean, got ${typeof e}`);if(typeof n!="boolean")throw new Error(`bigint/signed: expected boolean, got ${typeof n}`);if(typeof r!="boolean")throw new Error(`bigint/sized: expected boolean, got ${typeof r}`);let o=BigInt(t),s=2n**(8n*o-1n);return Nt({size:r?t:void 0,encodeStream:(i,a)=>{n&&a<0&&(a=a|s);let u=[];for(let d=0;d<t;d++)u.push(Number(a&255n)),a>>=8n;let c=new Uint8Array(u).reverse();if(!r){let d=0;for(d=0;d<c.length&&c[d]===0;d++);c=c.subarray(d)}i.bytes(e?c.reverse():c)},decodeStream:i=>{let a=i.bytes(r?t:Math.min(t,i.leftBytes)),u=e?a:En(a),c=0n;for(let d=0;d<u.length;d++)c|=BigInt(u[d])<<8n*BigInt(d);return n&&c&s&&(c=(c^s)-s),c},validate:i=>{if(typeof i!="bigint")throw new Error(`bigint: invalid value: ${i}`);return ro(i,8n*o,!!n),i}})};var io=Ms(32,!1);var Tn=(t,e=!1)=>{if(typeof e!="boolean")throw new Error(`bytes/le: expected boolean, got ${typeof e}`);let n=Ks(t),r=He(t);return Nt({size:typeof t=="number"?t:void 0,encodeStream:(o,s)=>{r||n.encodeStream(o,s.length),o.bytes(e?En(s):s),r&&o.bytes(t)},decodeStream:o=>{let s;if(r){let i=o.find(t);if(!i)throw o.err("bytes: cannot find terminator");s=o.bytes(i-o.pos),o.bytes(t.length)}else s=o.bytes(t===null?o.leftBytes:n.decodeStream(o));return e?En(s):s},validate:o=>{if(!He(o))throw new Error(`bytes: invalid value ${o}`);return o}})};function ao(t,e){if(!Re(t))throw new Error(`apply: invalid inner value ${t}`);if(!so(e))throw new Error(`apply: invalid base value ${t}`);return Nt({size:t.size,encodeStream:(n,r)=>{let o;try{o=e.decode(r)}catch(s){throw n.err(""+s)}return t.encodeStream(n,o)},decodeStream:n=>{let r=t.decodeStream(n);try{return e.encode(r)}catch(o){throw n.err(""+o)}}})}function Hs(t){let e=0;for(let n of t){if(n.size===void 0)return;if(!rt(n.size))throw new Error(`sizeof: wrong element size=${e}`);e+=n.size}return e}function In(t){if(!It(t))throw new Error(`struct: expected plain object, got ${t}`);for(let e in t)if(!Re(t[e]))throw new Error(`struct: field ${e} is not CoderType`);return Nt({size:Hs(Object.values(t)),encodeStream:(e,n)=>{e.pushObj(n,r=>{for(let o in t)r(o,()=>t[o].encodeStream(e,n[o]))})},decodeStream:e=>{let n={};return e.pushObj(n,r=>{for(let o in t)r(o,()=>n[o]=t[o].decodeStream(e))}),n},validate:e=>{if(typeof e!="object"||e===null)throw new Error(`struct: invalid value ${e}`);return e}})}var Rn=$.Point,$d=Rn.Fn,Wd=Rn.Fn.ORDER,uo=t=>t%2n===0n,co=Rt.isBytes,Fd=Rt.concatBytes,Gd=Rt.equalBytes;var Yd=J.utils.randomSecretKey,qd=J.getPublicKey,jd=$.getPublicKey;var Zd=J.sign,zd=J.utils.taggedHash;var Qd=Pe(Rn.BASE.toBytes(!1));function fo(t,e){if(!co(t)||!co(e))throw new Error(`cmp: wrong type a=${typeof t} b=${typeof e}`);let n=Math.min(t.length,e.length);for(let r=0;r<n;r++)if(t[r]!=e[r])return Math.sign(t[r]-e[r]);return Math.sign(t.length-e.length)}var Nn=class extends Error{idx;constructor(e,n){super(n),this.idx=e}},{taggedHash:Po,pointToBytes:Ws}=J.utils,Ue=$.Point,ee=Ue.Fn,ge=$.lengths.publicKey,Un=new Uint8Array(ge),lo=ao(Tn(33),{decode:t=>ho(t)?Un:t.toBytes(!0),encode:t=>lt(t,Un)?Ue.ZERO:Ue.fromBytes(t)}),po=Sn(io,t=>(pt("n",t,1n,ee.ORDER),t)),sf=In({R1:lo,R2:lo}),af=In({k1:po,k2:po,publicKey:Tn(ge)});function ot(t,...e){if(!Array.isArray(t))throw new Error("expected array");t.forEach(n=>U(n,...e))}var Fs=(t,...e)=>ee.create(ee.fromBytes(Po(t,...e),!0));function Gs(t){return Ue.BASE.multiply(t)}function ho(t){return t.equals(Ue.ZERO)}function Oo(t){return ot(t,ge),t.sort(fo)}function Ys(t){ot(t,ge);for(let e=1;e<t.length;e++)if(!lt(t[e],t[0]))return t[e];return Un}function qs(t){return ot(t,ge),Po("KeyAgg list",...t)}function js(t,e,n){return U(t,ge),U(e,ge),lt(t,e)?1n:Fs("KeyAgg coefficient",n,t)}function go(t,e=[],n=[]){if(ot(t,ge),ot(e,32),e.length!==n.length)throw new Error("The tweaks and isXonly arrays must have the same length");let r=Ys(t),o=qs(t),s=Ue.ZERO;for(let u=0;u<t.length;u++){let c;try{c=Ue.fromBytes(t[u])}catch{throw new Nn(u,"pubkey")}s=s.add(c.multiply(js(t[u],r,o)))}let i=ee.ONE,a=ee.ZERO;for(let u=0;u<e.length;u++){let c=n[u]&&!uo(s.y)?ee.neg(ee.ONE):ee.ONE,d=ee.fromBytes(e[u]);if(s=s.multiply(c).add(Gs(d)),ho(s))throw new Error("The result of tweaking cannot be infinity");i=ee.mul(c,i),a=ee.add(d,ee.mul(c,a))}return{aggPublicKey:s,gAcc:i,tweakAcc:a}}function mo(t){return Ws(t.aggPublicKey)}var Cn={formatVersion:1,contractName:"JobEscrow",constructorInputs:[{name:"agentPk",type:"pubkey"},{name:"providerPk",type:"pubkey"},{name:"treasuryProgram",type:"bytes32"},{name:"deadline",type:"int"},{name:"jobId",type:"bytes32"},{name:"renewalWindow",type:"int"},{name:"maxRenewalFee",type:"int"},{name:"exitDelay",type:"int"},{name:"delegatePk",type:"pubkey"},{name:"ownersPk",type:"pubkey"}],functions:[{name:"claim",arkade:{inputs:[{name:"amount",type:"int"},{name:"agentSig",type:"bytes"}],asm:["OP_PUSHCURRENTINPUTINDEX","0","OP_NUMEQUALVERIFY","<jobId>","OP_OVER","8","OP_NUM2BIN","OP_CAT","OP_SHA256","OP_ROT","<agentPk>","OP_ROT","OP_SWAP","OP_CHECKSIGFROMSTACK","OP_VERIFY","OP_PUSHCURRENTINPUTINDEX","OP_INSPECTINPUTVALUE","OP_OVER","0","OP_GREATERTHAN","OP_VERIFY","OP_SWAP","OP_SUB","OP_DUP","330","OP_GREATERTHAN","OP_IF","0","OP_INSPECTOUTPUTVALUE","OP_OVER","OP_GREATERTHANOREQUAL","OP_VERIFY","0","OP_INSPECTOUTPUTSCRIPTPUBKEY","1","OP_NUMEQUAL","OP_IF","OP_DUP","<treasuryProgram>","OP_EQUAL","OP_ELSE","OP_0","OP_ENDIF","OP_VERIFY","OP_DROP","OP_ENDIF","OP_1","OP_NIP"]},leaves:[{name:"claim",witness:[{name:"serverSig",type:"signature",encoding:"schnorr-64",injected:!0},{name:"providerSig",type:"signature",encoding:"schnorr-64"},{name:"emulatorSig",type:"signature",encoding:"schnorr-64",injected:!0}],asm:["<SERVER_KEY>","OP_CHECKSIGVERIFY","<providerPk>","OP_CHECKSIGVERIFY","<EMULATOR_KEY:claim>","OP_CHECKSIG"]}]},{name:"expire",arkade:{inputs:[],asm:["OP_INSPECTNUMINPUTS","1","OP_NUMEQUALVERIFY","<deadline>","OP_CHECKTIME","OP_VERIFY","0","OP_INSPECTOUTPUTVALUE","OP_PUSHCURRENTINPUTINDEX","OP_INSPECTINPUTVALUE","OP_GREATERTHANOREQUAL","OP_VERIFY","0","OP_INSPECTOUTPUTSCRIPTPUBKEY","1","OP_NUMEQUAL","OP_IF","OP_DUP","<treasuryProgram>","OP_EQUAL","OP_ELSE","OP_0","OP_ENDIF","OP_NIP"]},leaves:[{name:"expire",witness:[{name:"serverSig",type:"signature",encoding:"schnorr-64",injected:!0},{name:"emulatorSig",type:"signature",encoding:"schnorr-64",injected:!0}],asm:["<SERVER_KEY>","OP_CHECKSIGVERIFY","<EMULATOR_KEY:expire>","OP_CHECKSIG"]}]},{name:"renew",arkade:{inputs:[],asm:["OP_PUSHEXPIRY","<renewalWindow>","OP_SUB","OP_CHECKTIME","OP_VERIFY","0x74797065","OP_INSPECTINTENTMESSAGE","OP_VERIFY","0x7265676973746572","OP_EQUALVERIFY","0x6f6e636861696e5f6f75747075745f696e6465786573","OP_INSPECTINTENTMESSAGE","OP_VERIFY","0x5b5d","OP_EQUALVERIFY","OP_PUSHCURRENTINPUTINDEX","1","OP_SUB","OP_DUP","OP_INSPECTOUTPUTVALUE","<maxRenewalFee>","OP_ADD","OP_PUSHCURRENTINPUTINDEX","OP_INSPECTINPUTVALUE","OP_GREATERTHANOREQUAL","OP_VERIFY","5","0","OP_TUNNEL"]},leaves:[{name:"renew",witness:[{name:"serverSig",type:"signature",encoding:"schnorr-64",injected:!0},{name:"emulatorSig",type:"signature",encoding:"schnorr-64",injected:!0}],asm:["<SERVER_KEY>","OP_CHECKSIGVERIFY","<EMULATOR_KEY:renew>","OP_CHECKSIG"]}]},{name:"cooperative",leaves:[{name:"cooperative",witness:[{name:"serverSig",type:"signature",encoding:"schnorr-64",injected:!0},{name:"ownersSig",type:"signature",encoding:"schnorr-64"}],asm:["<SERVER_KEY>","OP_CHECKSIGVERIFY","<ownersPk>","OP_CHECKSIG"]}]},{name:"delegate",leaves:[{name:"delegate",witness:[{name:"serverSig",type:"signature",encoding:"schnorr-64",injected:!0},{name:"ownersSig",type:"signature",encoding:"schnorr-64"},{name:"delegateSig",type:"signature",encoding:"schnorr-64"}],asm:["<SERVER_KEY>","OP_CHECKSIGVERIFY","<ownersPk>","OP_CHECKSIGVERIFY","<delegatePk>","OP_CHECKSIG"]}]},{name:"unilateral",leaves:[{name:"unilateral",witness:[{name:"agentSig",type:"signature",encoding:"schnorr-64"},{name:"providerSig",type:"signature",encoding:"schnorr-64"}],asm:["<exitDelay>","OP_CHECKSEQUENCEVERIFY","OP_DROP","<agentPk>","OP_CHECKSIGVERIFY","<providerPk>","OP_CHECKSIG"]}]}],source:{entry:"job_escrow.ark",files:{"job_escrow.ark":`pragma arkade ^0.1.0;

// A job escrow holds one job's cap between a hive and a provider.
// The provider claims what the hive agent's latest receipt says, and the
// rest returns to the treasury. Unclaimed at the deadline, it returns whole.

contract JobEscrow(
  // Hive agent key. Signs one cumulative receipt per answer.
  pubkey agentPk,
  // Provider key. Signs the claim, and co-signs the unilateral exit.
  pubkey providerPk,
  // Where the remainder and an expired escrow go: the treasury's taproot (segwit v1) program.
  bytes32 treasuryProgram,
  // Unix seconds, read from the emulator clock.
  int deadline,
  // Unique per job, so each job has its own address and its own receipts.
  bytes32 jobId,
  // How long before the coin's batch expires the executor may renew it, in seconds.
  int renewalWindow,
  // The most a renewal may take from the escrow in fees, in sats.
  int maxRenewalFee,
  // The Arkade server's unilateral exit delay (BIP68 sequence), stated so the escrow's script is fully
  // determined by its arguments.
  int exitDelay,
  // The delegate service that renews the escrow before its batch expires (delegate.arkade.money on
  // mainnet), from a renewal the agent and the provider presign together.
  pubkey delegatePk,
  // The MuSig2 aggregate of agentPk and providerPk: one key the two sign with together, since the
  // delegate service accepts exactly one owner signature.
  pubkey ownersPk
) {
  const int DUST = 330;

  // The covenant checks the receipt and the treasury's share. The matching
  // tapscript below makes the provider's signature the authorization, so
  // nobody else can close the job with an older, smaller receipt.
  // The receipt signature travels as plain bytes so that template tooling, which knows only scalar
  // covenant inputs, can carry it; the cast below adds no opcodes.
  function claim(int amount, bytes agentSig) {
    require(this.activeInputIndex == 0, "escrow first");

    // The receipt binds this job and the cumulative sats owed. It cannot name
    // the coin: an Arkade spend evaluates a checkpoint built at spend time, so
    // the outpoint seen here is not one the agent could have signed.
    let receipt = sha256(jobId + num2bin(amount, 8));
    require(checkSigFromStack(signature(agentSig), agentPk, receipt), "receipt");

    int locked = tx.input.current.value;
    require(amount > 0, "nothing owed");
    // Renewal fees can leave less locked than the receipt owes; the provider then takes it all.
    int rest = locked - amount;

    // The provider signs this spend, so it chooses where its own share goes.
    if (rest > DUST) {
      require(tx.outputs[0].value >= rest, "treasury short");
      let paidTo = tx.outputs[0].script;
      require(paidTo.version == 1 && paidTo.program == treasuryProgram, "treasury script");
    }
  }

  function claim(signature serverSig, signature providerSig, signature emulatorSig) tapscript {
    require(checkMultisig([server, providerPk, emulator], [serverSig, providerSig, emulatorSig]));
  }

  @allow(unsigned-spend-path, "anyone may return the escrow after the deadline, and the output pays the treasury")
  function expire() {
    require(tx.numInputs == 1, "escrow alone");
    require(checkTime(deadline), "not yet");
    require(tx.outputs[0].value >= tx.input.current.value, "treasury short");
    let paidTo = tx.outputs[0].script;
    require(paidTo.version == 1 && paidTo.program == treasuryProgram, "treasury script");
  }

  // The executor renews the escrow before its batch expires, into the same escrow: the same script and
  // value less at most maxRenewalFee, in a register intent with no onchain output. The covenant leaves
  // nothing to choose, so the spend needs no signature from the hive or the provider.
  @allow(unsigned-spend-path, "renewal recreates this escrow unchanged; only a capped fee leaves it")
  function renew() {
    require(checkTime(this.expiry - renewalWindow), "too early to renew");
    require(tx.intent.field("type") == "register", "register intent");
    require(tx.intent.field("onchain_output_indexes") == "[]", "offchain only");
    int out = this.activeInputIndex - 1;
    require(tx.outputs[out].value + maxRenewalFee >= tx.input.current.value, "fee over cap");
    require(this.tunnel(out, {script: true, value: false, assets: true}), "same escrow");
  }

  // The agent and the provider together, through their aggregate key. A delegated renewal's proof is
  // signed on this path; the agent could already hand the provider the whole cap with a receipt, so it
  // adds no new trust.
  function cooperative(signature serverSig, signature ownersSig) tapscript {
    require(checkMultisig([server, ownersPk], [serverSig, ownersSig]));
  }

  // The delegated renewal's forfeit: the agent and the provider presign it, the delegate service adds
  // its signature when it renews the escrow into the same escrow in a new batch.
  function delegate(signature serverSig, signature ownersSig, signature delegateSig) tapscript {
    require(checkMultisig([server, ownersPk, delegatePk], [serverSig, ownersSig, delegateSig]));
  }

  function unilateral(signature agentSig, signature providerSig) tapscript {
    require(older(exitDelay));
    require(checkMultisig([agentPk, providerPk], [agentSig, providerSig], 2));
  }
}
`}},compiler:{name:"arkadec",version:"0.1.0-rc.1",options:{optimize:!0}},updatedAt:"2026-11-12T11:31:58.699767722+00:00",fingerprint:"sha256:59bf7e514edc008ddfb144f70257288469fed74bdcb8fa3d2a16ca7a6c6b7bed"};var Qs={bitcoin:{renewalWindow:2*86400,maxRenewalFee:100},mutinynet:{renewalWindow:86400,maxRenewalFee:100},regtest:{renewalWindow:90,maxRenewalFee:100}},Xs="50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",Js={...Cn,constructorInputs:Cn.constructorInputs.map(t=>t.type==="pubkey"?{...t,type:"bytes32"}:t)},Dn=/^[0-9a-f]{64}$/;function ei(t,e){let n=r=>{let o=z(`02${r}`);return $.Point.fromHex(B(o)),o};return B(mo(go(Oo([n(t),n(e)]))))}function _o(t,e){let n={agentPk:e.agentPk,providerPk:e.providerPk,delegatePk:e.delegatePk??Xs};for(let[u,c]of Object.entries(n))I(Dn.test(c),"JOB_ESCROW_INVALID",`${u} must be a 32-byte x-only key`);I(Dn.test(e.treasuryProgram),"JOB_ESCROW_INVALID","treasuryProgram"),I(Dn.test(e.jobId),"JOB_ESCROW_INVALID","jobId"),I(Number.isSafeInteger(e.deadline)&&e.deadline>0,"JOB_ESCROW_INVALID","deadline");let r=Qs[t.deployment.network],o=e.renewalWindow??r.renewalWindow,s=e.maxRenewalFee??r.maxRenewalFee;I(Number.isSafeInteger(o)&&o>=0&&Number.isSafeInteger(s)&&s>=0,"JOB_ESCROW_INVALID","renewal terms");let i=u=>B(Je(u)),a=Me(Js,{agentPk:n.agentPk,providerPk:n.providerPk,treasuryProgram:e.treasuryProgram,deadline:i(e.deadline),jobId:e.jobId,renewalWindow:i(o),maxRenewalFee:i(s),exitDelay:i(Le(t.operator.unilateralExitDelay)),delegatePk:n.delegatePk,ownersPk:ei(n.agentPk,n.providerPk)},{server:t.keys.server,emulator:t.keys.emulator,delegate:t.keys.server});return{...a,address:xn(t.deployment.network,t.keys.server,a.pkScript),renewalWindow:o,maxRenewalFee:s}}var ti="hive/treasury/pay/v1",ni="I approve Hive payment of ",ri="I decline Hive payment of ",vn=10n**12n-1n,oi=t=>new TextEncoder().encode(t),kn=t=>typeof t=="string"?ae.decode(t):t;function si(...t){let e=new Uint8Array(t.reduce((r,o)=>r+o.length,0)),n=0;for(let r of t)e.set(r,n),n+=r.length;return e}function Ut(t,e){let n=BigInt(t);if(n<0n||n>=1n<<BigInt(8*e-1))throw new Error(`out of range for ${e} bytes`);let r=new Uint8Array(e);for(let o=0;o<e;o++,n>>=8n)r[o]=Number(n&0xffn);return r}function Bn(t,e){let{left:n,amount:r,validUntil:o,program:s}=e,i=kn(s);if(i.length!==32)throw new Error("a Taproot program is 32 bytes");return Pe(si(oi(ti),kn(t.txid),Ut(t.gidx,2),Ut(n,8),Ut(r,8),Ut(o,8),i,Uint8Array.of(1)))}var Ln=t=>Gr.encode(t);function ii(t){let e=BigInt(t.amount);if(e<0n||e>vn)throw new Error("amount out of range");let n=kn(t.program);if(n.length!==32)throw new Error("a Taproot program is 32 bytes");return`${e} sats to ${ae.encode(n.subarray(0,4))}`}var yo=(t,e)=>`${ii(e)} ${Ln(Bn(t,e))}`,xo=(t,e)=>ni+yo(t,e),wo=(t,e)=>ri+yo(t,e);function bo(t){let e=/^I (approve|decline) Hive payment of (0|[1-9]\d{0,11}) sats to ([0-9a-f]{8}) ([A-Za-z0-9_-]{43})$/.exec(String(t));return e?{word:e[1],amountSats:Number(e[2]),recipient:e[3],code:e[4]}:null}var Eo=(t,e)=>`Hive withdrawal: ${t.toLocaleString("en-US")} sats to ${e}`;function Vn(t){let e=String(t??"").replace(/[`*]/g,""),n=/^\s*hive withdrawal\s*:\s*([\d,_ ]+?)\s*sats?\s+to\s+([a-z0-9]+1[a-z0-9]+)\s*$/i.exec(e);if(!n)return null;let r=Number(n[1].replace(/[,_ ]/g,""));return Number.isSafeInteger(r)&&r>0?{amountSats:r,address:n[2].toLowerCase()}:null}var tl=cn("condition");var Ao={formatVersion:1,contractName:"HiveTreasury",constructorInputs:[{name:"keeperA",type:"bytes"},{name:"keeperB",type:"bytes"},{name:"keeperC",type:"bytes"},{name:"hexA",type:"bytes"},{name:"hexB",type:"bytes"},{name:"hexC",type:"bytes"},{name:"counterTxid",type:"bytes32"},{name:"counterGidx",type:"int"},{name:"delegateKey",type:"bytes"},{name:"renewalWindow",type:"int"},{name:"maxFee",type:"int"},{name:"exitA",type:"pubkey"},{name:"exitB",type:"pubkey"},{name:"exitC",type:"pubkey"},{name:"exitDelay",type:"int"}],functions:[{name:"pay",arkade:{inputs:[{name:"amount",type:"int"},{name:"to",type:"ScriptPubKey"},{name:"validUntil",type:"int"},{name:"sigs",type:"bytes[3]"},{name:"times",type:"bytes[3]"},{name:"tags",type:"bytes[3]"}],asm:["<counterGidx>","<counterTxid>","0x74797065","OP_INSPECTINTENTMESSAGE","OP_NIP","OP_NOT","OP_VERIFY","OP_5","OP_PICK","OP_CHECKTIME","OP_NOT","OP_VERIFY","OP_INSPECTNUMINPUTS","1","OP_NUMEQUALVERIFY","OP_INSPECTNUMOUTPUTS","4","OP_NUMEQUALVERIFY","OP_2","OP_PICK","330","OP_GREATERTHANOREQUAL","OP_VERIFY","OP_2","OP_PICK","1000000000000","OP_LESSTHAN","OP_VERIFY","0","OP_OVER","OP_3","OP_PICK","OP_INSPECTINASSETLOOKUP","OP_VERIFY","OP_DUP","1","OP_GREATERTHAN","OP_VERIFY","0x686976652f74726561737572792f7061792f7631","OP_2","OP_PICK","OP_CAT","OP_3","OP_PICK","2","OP_NUM2BIN","OP_CAT","OP_OVER","8","OP_NUM2BIN","OP_CAT","OP_4","OP_PICK","8","OP_NUM2BIN","OP_CAT","OP_7","OP_ROLL","8","OP_NUM2BIN","OP_CAT","OP_5","OP_PICK","OP_CAT","OP_6","OP_PICK","1","OP_NUM2BIN","OP_CAT","OP_SHA256","0x4920617070726f76652048697665207061796d656e74206f6620","OP_0","0","10","100","1000","10000","100000","1000000","10000000","100000000","1000000000","10000000000","100000000000","18","OP_PICK","OP_OVER","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_DROP","18","OP_PICK","OP_2","OP_PICK","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_DROP","18","OP_PICK","OP_3","OP_PICK","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_DROP","18","OP_PICK","OP_4","OP_PICK","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_DROP","18","OP_PICK","OP_5","OP_PICK","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_DROP","18","OP_PICK","OP_6","OP_PICK","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_DROP","18","OP_PICK","OP_7","OP_PICK","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_DROP","18","OP_PICK","OP_8","OP_PICK","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_DROP","18","OP_PICK","OP_9","OP_PICK","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_DROP","18","OP_PICK","OP_10","OP_PICK","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_DROP","18","OP_PICK","OP_11","OP_PICK","OP_DIV","10","OP_MOD","OP_12","OP_PICK","OP_OVER","OP_ADD","OP_12","OP_PUT","OP_12","OP_PICK","0","OP_GREATERTHAN","OP_IF","OP_13","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","1","OP_SUBSTR","OP_CAT","OP_13","OP_PUT","OP_ENDIF","OP_2DROP","OP_2DROP","OP_2DROP","OP_2DROP","OP_2DROP","OP_2DROP","OP_SWAP","0x30313233343536373839616263646566","OP_8","OP_PICK","10","OP_MOD","1","OP_SUBSTR","OP_CAT","OP_NIP","OP_CAT","0x207361747320746f20","OP_CAT","OP_6","OP_PICK","OP_0","3","2","1","0","OP_5","OP_PICK","OP_OVER","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_5","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","16","OP_DIV","1","OP_SUBSTR","OP_CAT","0x30313233343536373839616263646566","OP_ROT","16","OP_MOD","1","OP_SUBSTR","OP_CAT","OP_4","OP_PUT","OP_5","OP_PICK","OP_2","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_5","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","16","OP_DIV","1","OP_SUBSTR","OP_CAT","0x30313233343536373839616263646566","OP_ROT","16","OP_MOD","1","OP_SUBSTR","OP_CAT","OP_4","OP_PUT","OP_5","OP_PICK","OP_3","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_5","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","16","OP_DIV","1","OP_SUBSTR","OP_CAT","0x30313233343536373839616263646566","OP_ROT","16","OP_MOD","1","OP_SUBSTR","OP_CAT","OP_4","OP_PUT","OP_5","OP_PICK","OP_4","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_5","OP_PICK","0x30313233343536373839616263646566","OP_2","OP_PICK","16","OP_DIV","1","OP_SUBSTR","OP_CAT","0x30313233343536373839616263646566","OP_ROT","16","OP_MOD","1","OP_SUBSTR","OP_CAT","OP_4","OP_PUT","OP_2DROP","OP_2DROP","OP_NIP","OP_CAT","0x20","OP_CAT","OP_0","27","24","21","18","15","12","9","6","3","0","OP_12","OP_PICK","OP_OVER","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","65536","OP_MUL","OP_OVER","OP_1ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","256","OP_MUL","OP_ADD","OP_OVER","2","OP_ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_ADD","OP_11","OP_PICK","OP_OVER","262144","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","4096","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_11","OP_PUT","OP_DROP","OP_12","OP_PICK","OP_2","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","65536","OP_MUL","OP_2","OP_PICK","OP_1ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","256","OP_MUL","OP_ADD","OP_2","OP_PICK","2","OP_ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_ADD","OP_11","OP_PICK","OP_OVER","262144","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","4096","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_11","OP_PUT","OP_DROP","OP_12","OP_PICK","OP_3","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","65536","OP_MUL","OP_3","OP_PICK","OP_1ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","256","OP_MUL","OP_ADD","OP_3","OP_PICK","2","OP_ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_ADD","OP_11","OP_PICK","OP_OVER","262144","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","4096","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_11","OP_PUT","OP_DROP","OP_12","OP_PICK","OP_4","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","65536","OP_MUL","OP_4","OP_PICK","OP_1ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","256","OP_MUL","OP_ADD","OP_4","OP_PICK","2","OP_ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_ADD","OP_11","OP_PICK","OP_OVER","262144","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","4096","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_11","OP_PUT","OP_DROP","OP_12","OP_PICK","OP_5","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","65536","OP_MUL","OP_5","OP_PICK","OP_1ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","256","OP_MUL","OP_ADD","OP_5","OP_PICK","2","OP_ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_ADD","OP_11","OP_PICK","OP_OVER","262144","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","4096","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_11","OP_PUT","OP_DROP","OP_12","OP_PICK","OP_6","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","65536","OP_MUL","OP_6","OP_PICK","OP_1ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","256","OP_MUL","OP_ADD","OP_6","OP_PICK","2","OP_ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_ADD","OP_11","OP_PICK","OP_OVER","262144","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","4096","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_11","OP_PUT","OP_DROP","OP_12","OP_PICK","OP_7","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","65536","OP_MUL","OP_7","OP_PICK","OP_1ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","256","OP_MUL","OP_ADD","OP_7","OP_PICK","2","OP_ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_ADD","OP_11","OP_PICK","OP_OVER","262144","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","4096","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_11","OP_PUT","OP_DROP","OP_12","OP_PICK","OP_8","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","65536","OP_MUL","OP_8","OP_PICK","OP_1ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","256","OP_MUL","OP_ADD","OP_8","OP_PICK","2","OP_ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_ADD","OP_11","OP_PICK","OP_OVER","262144","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","4096","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_11","OP_PUT","OP_DROP","OP_12","OP_PICK","OP_9","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","65536","OP_MUL","OP_9","OP_PICK","OP_1ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","256","OP_MUL","OP_ADD","OP_9","OP_PICK","2","OP_ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_ADD","OP_11","OP_PICK","OP_OVER","262144","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","4096","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_11","OP_PUT","OP_DROP","OP_12","OP_PICK","OP_10","OP_PICK","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","65536","OP_MUL","OP_10","OP_PICK","OP_1ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","256","OP_MUL","OP_ADD","OP_10","OP_PICK","2","OP_ADD","OP_14","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","OP_ADD","OP_11","OP_PICK","OP_OVER","262144","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","4096","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_11","OP_PUT","OP_2DROP","OP_2DROP","OP_2DROP","OP_2DROP","OP_2DROP","OP_DROP","30","OP_3","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","1024","OP_MUL","31","OP_4","OP_PICK","OP_SWAP","1","OP_SUBSTR","0x00","OP_CAT","OP_BIN2NUM","4","OP_MUL","OP_ADD","OP_2DUP","4096","OP_DIV","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_DIV","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_OVER","64","OP_MOD","0x4142434445464748494a4b4c4d4e4f505152535455565758595a6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738392d5f","OP_SWAP","1","OP_SUBSTR","OP_CAT","OP_1","OP_PUT","OP_SWAP","OP_NIP","OP_CAT","<keeperC>","<keeperB>","<keeperA>","<hexC>","<hexB>","<hexA>","0","OP_15","OP_PICK","OP_SIZE","OP_NIP","0","OP_GREATERTHAN","OP_IF","18","OP_PICK","OP_SIZE","OP_NIP","10","OP_LESSTHANOREQUAL","OP_VERIFY","0x5b302c22","OP_2","OP_PICK","OP_CAT","0x222c","OP_CAT","19","OP_PICK","OP_CAT","0x2c392c","OP_CAT","22","OP_PICK","OP_CAT","0x2c22","OP_CAT","OP_8","OP_PICK","OP_CAT","0x225d","OP_CAT","OP_SHA256","OP_16","OP_PICK","OP_6","OP_PICK","OP_ROT","OP_SWAP","OP_CHECKSIGFROMSTACK","OP_VERIFY","OP_DUP","OP_1ADD","OP_NIP","OP_ENDIF","OP_16","OP_PICK","OP_SIZE","OP_NIP","0","OP_GREATERTHAN","OP_IF","19","OP_PICK","OP_SIZE","OP_NIP","10","OP_LESSTHANOREQUAL","OP_VERIFY","0x5b302c22","OP_3","OP_PICK","OP_CAT","0x222c","OP_CAT","20","OP_PICK","OP_CAT","0x2c392c","OP_CAT","23","OP_PICK","OP_CAT","0x2c22","OP_CAT","OP_8","OP_PICK","OP_CAT","0x225d","OP_CAT","OP_SHA256","17","OP_PICK","OP_7","OP_PICK","OP_ROT","OP_SWAP","OP_CHECKSIGFROMSTACK","OP_VERIFY","OP_DUP","OP_1ADD","OP_NIP","OP_ENDIF","17","OP_PICK","OP_SIZE","OP_NIP","0","OP_GREATERTHAN","OP_IF","20","OP_PICK","OP_SIZE","OP_NIP","10","OP_LESSTHANOREQUAL","OP_VERIFY","0x5b302c22","OP_4","OP_PICK","OP_CAT","0x222c","OP_CAT","21","OP_PICK","OP_CAT","0x2c392c","OP_CAT","24","OP_PICK","OP_CAT","0x2c22","OP_CAT","OP_8","OP_PICK","OP_CAT","0x225d","OP_CAT","OP_SHA256","18","OP_PICK","OP_8","OP_PICK","OP_ROT","OP_SWAP","OP_CHECKSIGFROMSTACK","OP_VERIFY","OP_DUP","OP_1ADD","OP_NIP","OP_ENDIF","2","OP_GREATERTHANOREQUAL","OP_VERIFY","OP_PUSHCURRENTINPUTINDEX","OP_INSPECTINPUTSCRIPTPUBKEY","OP_SWAP","0","OP_INSPECTOUTPUTSCRIPTPUBKEY","OP_SWAP","OP_2SWAP","OP_ROT","OP_EQUALVERIFY","OP_NUMEQUALVERIFY","0","OP_INSPECTOUTPUTVALUE","OP_PUSHCURRENTINPUTINDEX","OP_INSPECTINPUTVALUE","OP_13","OP_PICK","OP_SUB","OP_GREATERTHANOREQUAL","OP_VERIFY","0","OP_10","OP_PICK","OP_12","OP_PICK","OP_INSPECTOUTASSETLOOKUP","OP_VERIFY","OP_9","OP_ROLL","1","OP_SUB","OP_NUMEQUALVERIFY","1","OP_INSPECTOUTPUTSCRIPTPUBKEY","OP_SWAP","OP_14","OP_ROLL","OP_14","OP_ROLL","OP_ROT","OP_EQUALVERIFY","OP_NUMEQUALVERIFY","1","OP_INSPECTOUTPUTVALUE","OP_11","OP_ROLL","OP_NUMEQUALVERIFY","1","OP_9","OP_ROLL","OP_10","OP_ROLL","OP_INSPECTOUTASSETLOOKUP","OP_NIP","OP_NOT","OP_VERIFY","OP_2DROP","OP_2DROP","OP_2DROP","OP_2DROP","OP_2DROP","OP_2DROP","OP_2DROP","OP_2DROP","OP_DROP","OP_1"]},leaves:[{name:"pay",witness:[{name:"serverSig",type:"signature",encoding:"schnorr-64",injected:!0},{name:"emulatorSig",type:"signature",encoding:"schnorr-64",injected:!0}],asm:["<SERVER_KEY>","OP_CHECKSIGVERIFY","<EMULATOR_KEY:pay>","OP_CHECKSIG"]}]},{name:"merge",arkade:{inputs:[],asm:["<counterGidx>","<counterTxid>","0x74797065","OP_INSPECTINTENTMESSAGE","OP_NIP","OP_NOT","OP_VERIFY","OP_INSPECTNUMINPUTS","2","OP_NUMEQUALVERIFY","OP_PUSHCURRENTINPUTINDEX","OP_INSPECTINPUTSCRIPTPUBKEY","OP_SWAP","0","OP_INSPECTINPUTSCRIPTPUBKEY","OP_SWAP","OP_3","OP_PICK","OP_3","OP_PICK","OP_ROT","OP_EQUALVERIFY","OP_NUMEQUALVERIFY","1","OP_INSPECTINPUTSCRIPTPUBKEY","OP_SWAP","OP_3","OP_PICK","OP_3","OP_PICK","OP_ROT","OP_EQUALVERIFY","OP_NUMEQUALVERIFY","OP_INSPECTNUMOUTPUTS","3","OP_NUMEQUALVERIFY","0","OP_INSPECTOUTPUTSCRIPTPUBKEY","OP_SWAP","OP_2SWAP","OP_ROT","OP_EQUALVERIFY","OP_NUMEQUALVERIFY","0","OP_INSPECTOUTPUTVALUE","0","OP_INSPECTINPUTVALUE","1","OP_INSPECTINPUTVALUE","OP_ADD","OP_GREATERTHANOREQUAL","OP_VERIFY","1","OP_OVER","OP_3","OP_PICK","OP_INSPECTINASSETLOOKUP","OP_NIP","OP_NOT","OP_VERIFY","0","OP_OVER","OP_3","OP_PICK","OP_INSPECTINASSETLOOKUP","OP_VERIFY","0","OP_2SWAP","OP_SWAP","OP_INSPECTOUTASSETLOOKUP","OP_VERIFY","OP_SWAP","OP_NUMEQUAL"]},leaves:[{name:"merge",witness:[{name:"serverSig",type:"signature",encoding:"schnorr-64",injected:!0},{name:"emulatorSig",type:"signature",encoding:"schnorr-64",injected:!0}],asm:["<SERVER_KEY>","OP_CHECKSIGVERIFY","<EMULATOR_KEY:merge>","OP_CHECKSIG"]}]},{name:"renew",arkade:{inputs:[],asm:["OP_PUSHEXPIRY","<renewalWindow>","OP_SUB","OP_CHECKTIME","OP_VERIFY","0x74797065","OP_INSPECTINTENTMESSAGE","OP_VERIFY","0x7265676973746572","OP_EQUALVERIFY","0x6f6e636861696e5f6f75747075745f696e6465786573","OP_INSPECTINTENTMESSAGE","OP_VERIFY","0x5b5d","OP_EQUALVERIFY","0x636f7369676e6572735f7075626c69635f6b6579732e30","OP_INSPECTINTENTMESSAGE","OP_VERIFY","<delegateKey>","OP_EQUALVERIFY","0x636f7369676e6572735f7075626c69635f6b6579732e31","OP_INSPECTINTENTMESSAGE","OP_NIP","OP_NOT","OP_VERIFY","OP_PUSHCURRENTINPUTINDEX","1","OP_SUB","OP_DUP","5","0","OP_TUNNEL","OP_VERIFY","OP_INSPECTOUTPUTVALUE","<maxFee>","OP_ADD","OP_PUSHCURRENTINPUTINDEX","OP_INSPECTINPUTVALUE","OP_GREATERTHANOREQUAL"]},leaves:[{name:"renew",witness:[{name:"serverSig",type:"signature",encoding:"schnorr-64",injected:!0},{name:"emulatorSig",type:"signature",encoding:"schnorr-64",injected:!0}],asm:["<SERVER_KEY>","OP_CHECKSIGVERIFY","<EMULATOR_KEY:renew>","OP_CHECKSIG"]}]},{name:"exit01",leaves:[{name:"exit01",witness:[{name:"sigA",type:"signature",encoding:"schnorr-64"},{name:"sigB",type:"signature",encoding:"schnorr-64"}],asm:["<exitDelay>","OP_CHECKSEQUENCEVERIFY","OP_DROP","<exitA>","OP_CHECKSIGVERIFY","<exitB>","OP_CHECKSIG"]}]},{name:"exit02",leaves:[{name:"exit02",witness:[{name:"sigA",type:"signature",encoding:"schnorr-64"},{name:"sigC",type:"signature",encoding:"schnorr-64"}],asm:["<exitDelay>","OP_CHECKSEQUENCEVERIFY","OP_DROP","<exitA>","OP_CHECKSIGVERIFY","<exitC>","OP_CHECKSIG"]}]},{name:"exit12",leaves:[{name:"exit12",witness:[{name:"sigB",type:"signature",encoding:"schnorr-64"},{name:"sigC",type:"signature",encoding:"schnorr-64"}],asm:["<exitDelay>","OP_CHECKSEQUENCEVERIFY","OP_DROP","<exitB>","OP_CHECKSIGVERIFY","<exitC>","OP_CHECKSIG"]}]}],source:{entry:"treasury.ark",files:{"treasury.ark":`pragma arkade ^0.1.0;

// A Buzz community's treasury, kept by three keepers: any two of them approve each payment, each by
// sending a message in the hive's channel. A keeper's approval is an ordinary Buzz message, signed by
// their Buzz identity's key like every message they send: a kind 9 event whose text is exactly
// "I approve Hive payment of <amount> sats to <the recipient's first eight hex characters> " and the
// payment's code, so a keeper reads what they approve in the message they send. The covenant rebuilds
// the event from the keeper's key, the payment's amount, recipient and code, and the two parts of the
// event Buzz chooses itself, its created_at and its tags, and checks the keeper's signature over its
// id. The two approvals are independent messages, sent from any device at any time, in any order.
//
// Only the text binds the approval: JSON writes a quote inside a string as \\", so the last unescaped
// quote before the end of an event's serialization opens its content, and an event whose text says
// anything more, or anything else, has another id.
//
// The payment number is a counter asset: a fixed supply issued once and held only by the treasury
// coin, one unit burned by each payment. An approval names the treasury (the counter's asset id),
// the number of units left, the amount, the recipient and the time it lapses, so it pays once and
// only before then, and a merge or a renewal, which keep the units, leaves every pending approval
// valid. A merge takes the count of the treasury coin and of no other: the coin folded in holds no
// unit of the counter, so nothing merged into the treasury can set its payment number.
//
// Payments and merges run offchain only. Renewal runs in an intent that only the host's delegatee
// may cosign, as in the v4 treasury: whoever cosigns a batch holds its new coins together with the
// Arkade Operator. When the operator is gone, any two keepers take the coin onchain after the exit
// delay, each signing with their own Buzz key: one leaf per pair, two plain signatures, so neither
// keeper waits on the other and no signing rounds pass between them.
contract HiveTreasury(
  bytes keeperA,        // each keeper's Buzz key: the x-only key their Buzz identity signs with
  bytes keeperB,
  bytes keeperC,
  bytes hexA,           // the same key as Buzz writes it in every event: 64 lowercase hex characters
  bytes hexB,
  bytes hexC,
  bytes32 counterTxid,  // the counter asset: its issuance transaction, in internal byte order
  int counterGidx,      // and its group in that transaction
  bytes delegateKey,    // the host's delegatee, as an intent names its cosigner: 66 hex characters
  int renewalWindow,    // how long before its expiry, in seconds, the coin may be renewed
  int maxFee,           // the most a renewal may pay the operator, in sats
  pubkey exitA,         // each keeper's Buzz key again, as the exit leaves check it
  pubkey exitB,
  pubkey exitC,
  int exitDelay
) {
  const bytes ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes DIGITS = "0123456789abcdef";
  const bytes APPROVE = "I approve Hive payment of ";

  static function byteAt(bytes data, int i) int {
    return bin2num(substr(data, i, 1) + 0x00);
  }

  static function char(int v) bytes {
    return substr(ALPHABET, v, 1);
  }

  // base64url without padding: the payment's code, 43 characters for 32 bytes.
  static function b64url(bytes32 m) bytes {
    bytes out = "";
    for (g, start) in [0, 3, 6, 9, 12, 15, 18, 21, 24, 27] {
      int v = byteAt(m, start) * 65536 + byteAt(m, start + 1) * 256 + byteAt(m, start + 2);
      out = out + char(v / 262144) + char(v / 4096 % 64) + char(v / 64 % 64) + char(v % 64);
    }
    int t = byteAt(m, 30) * 1024 + byteAt(m, 31) * 4;
    out = out + char(t / 4096) + char(t / 64 % 64) + char(t % 64);
    return out;
  }

  // An amount as a keeper reads it: decimal digits, no leading zero. Below 10^12 sats.
  static function decimal(int n) bytes {
    bytes out = "";
    int seen = 0;
    for (g, power) in [100000000000, 10000000000, 1000000000, 100000000, 10000000, 1000000, 100000, 10000, 1000, 100, 10] {
      int digit = n / power % 10;
      seen = seen + digit;
      if (seen > 0) {
        out = out + substr(DIGITS, digit, 1);
      }
    }
    return out + substr(DIGITS, n % 10, 1);
  }

  // The first four bytes of a program in hex: enough for a keeper, or their plugin, to tell one
  // recipient from another in the approval's text. The code binds all 32 bytes.
  static function hex4(bytes data) bytes {
    bytes out = "";
    for (g, at) in [0, 1, 2, 3] {
      int v = byteAt(data, at);
      out = out + substr(DIGITS, v / 16, 1) + substr(DIGITS, v % 16, 1);
    }
    return out;
  }

  // Two keepers approve this: the treasury, the payment's number, its amount and recipient, and the
  // time the approval lapses. Each passes their message's signature, created_at (as its digits) and
  // tags (as JSON); a keeper who did not approve passes an empty signature.
  @allow(unsigned-spend-path, "two keepers' Buzz messages sign the treasury, payment number, amount, recipient and lapse time")
  function pay(int amount, ScriptPubKey to, int validUntil, bytes[3] sigs, bytes[3] times, bytes[3] tags) {
    require(!tx.intent.has("type"), "offchain");
    require(!checkTime(validUntil), "approval lapsed");
    require(tx.numInputs == 1, "one coin");
    // Change and payment, then the packets and the anchor every Arkade transaction carries.
    require(tx.numOutputs == 4, "payment and change");
    require(amount >= 330, "dust");
    require(amount < 1000000000000, "amount");
    int left = tx.inputs[0].assets.lookup(counterTxid, counterGidx);
    require(left > 1, "counter");
    bytes32 message = sha256("hive/treasury/pay/v1" + counterTxid + num2bin(counterGidx, 2) + num2bin(left, 8) + num2bin(amount, 8) + num2bin(validUntil, 8) + to.program + num2bin(to.version, 1));
    // What each keeper's message says: the amount and the recipient in words, then the code.
    bytes text = APPROVE + decimal(amount) + " sats to " + hex4(to.program) + " " + b64url(message);
    bytes[3] keys = [keeperA, keeperB, keeperC];
    bytes[3] names = [hexA, hexB, hexC];
    int valid = 0;
    for (i, sig) in sigs {
      if (size(sig) > 0) {
        require(size(times[i]) <= 10, "created_at");
        // NIP-01: the event's id is sha256 of [0, pubkey, created_at, kind, tags, content].
        bytes32 id = sha256("[0,\\"" + names[i] + "\\"," + times[i] + ",9," + tags[i] + ",\\"" + text + "\\"]");
        signature keeperSig = signature(sig);
        require(checkSigFromStack(keeperSig, keys[i], id), "keeper's message");
        valid = valid + 1;
      }
    }
    require(valid >= 2, "two keepers");
    let me = tx.input.current.script;
    require(tx.outputs[0].script == me, "change stays");
    require(tx.outputs[0].value >= tx.input.current.value - amount, "change");
    require(tx.outputs[0].assets.lookup(counterTxid, counterGidx) == left - 1, "one unit burned");
    require(tx.outputs[1].script == to, "recipient");
    require(tx.outputs[1].value == amount, "amount");
    require(!tx.outputs[1].assets.has(counterTxid, counterGidx), "counter stays home");
  }

  // Anyone folds a chip-in or a returned escrow (input 1) into the treasury coin (input 0). The
  // order of the inputs is the submitter's, so the covenant holds them to it: the coin folded in
  // carries no unit of the counter, and the merged coin carries the treasury coin's count.
  @allow(unsigned-spend-path, "value only grows and the counter stays on this script")
  function merge() {
    require(!tx.intent.has("type"), "offchain");
    require(tx.numInputs == 2, "two coins");
    let me = tx.input.current.script;
    require(tx.inputs[0].script == me, "treasury coin");
    require(tx.inputs[1].script == me, "chip-in");
    require(tx.numOutputs == 3, "one coin, packets and anchor");
    require(tx.outputs[0].script == me, "stays");
    require(tx.outputs[0].value >= tx.inputs[0].value + tx.inputs[1].value, "all of it");
    require(!tx.inputs[1].assets.has(counterTxid, counterGidx), "the coin folded in holds no counter");
    int units = tx.inputs[0].assets.lookup(counterTxid, counterGidx);
    require(tx.outputs[0].assets.lookup(counterTxid, counterGidx) == units, "counter kept");
  }

  // The host's delegatee renews the treasury into a new batch near its expiry, and the treasury
  // pays the operator's fee, up to maxFee. Proof input k+1 continues as proof output k.
  @allow(unsigned-spend-path, "the delegatee cosigns; the coin continues on this script, its counter intact, paying at most maxFee")
  function renew() {
    require(checkTime(this.expiry - renewalWindow), "not yet");
    require(tx.intent.field("type") == "register", "a registration");
    require(tx.intent.field("onchain_output_indexes") == "[]", "stays offchain");
    require(tx.intent.field("cosigners_public_keys.0") == delegateKey, "the delegatee cosigns");
    require(!tx.intent.has("cosigners_public_keys.1"), "only the delegatee");
    int k = this.activeInputIndex - 1;
    require(this.tunnel(k, {script: true, value: false, assets: true}), "continues");
    require(tx.outputs[k].value + maxFee >= tx.input.current.value, "fee");
  }

  // When the operator is gone: any two keepers, after the exit delay.
  function exit01(signature sigA, signature sigB) tapscript {
    require(older(exitDelay));
    require(checkMultisig([exitA, exitB], [sigA, sigB]));
  }

  function exit02(signature sigA, signature sigC) tapscript {
    require(older(exitDelay));
    require(checkMultisig([exitA, exitC], [sigA, sigC]));
  }

  function exit12(signature sigB, signature sigC) tapscript {
    require(older(exitDelay));
    require(checkMultisig([exitB, exitC], [sigB, sigC]));
  }
}
`}},compiler:{name:"arkadec",version:"0.1.0-rc.1",options:{optimize:!0}},updatedAt:"2026-11-15T13:29:04.573750407+00:00",fingerprint:"sha256:b05a723c39b59a9c46561c37d9b5e4b46dea9ce8f02344b0a6174d5b03ad47ef"};var So=Ao,ui=["A","B","C"],di=t=>new TextEncoder().encode(t);function fi(t){if(typeof t!="string"||!/^[0-9a-f]{64}$/.test(t))return!1;try{return $.Point.fromHex(`02${t}`),!0}catch{return!1}}function li(t){if(t.keepers.length!==3)throw new Error("a treasury has three keepers");for(let e of t.keepers)if(!fi(e))throw new Error("a keeper is a Buzz key, x-only hex");if(new Set(t.keepers).size!==3)throw new Error("three different keepers");if(!/^0[23][0-9a-f]{64}$/.test(t.delegateKey))throw new Error("the delegate key is compressed hex");return t}var pi=t=>`02${t}`;function To(t){let e=li(t);return{...Object.fromEntries(ui.flatMap((n,r)=>[[`keeper${n}`,e.keepers[r]],[`hex${n}`,ae.encode(di(e.keepers[r]))],[`exit${n}`,pi(e.keepers[r])]])),counterTxid:e.counter.txid,counterGidx:Ie(e.counter.gidx),delegateKey:ae.encode(new TextEncoder().encode(e.delegateKey)),renewalWindow:Ie(e.renewalWindowSeconds),maxFee:Ie(e.maxFeeSats),exitDelay:eo(e.exitDelaySeconds)}}var Ct=t=>String(t??"").slice(-64),Kn=86400,Io=2e3;function Ro(t){let e=t?.operator;if(!e?.server||!e?.emulator)throw new Error("The hive's host did not say which Operator its treasury is on.");if(e.network==="bitcoin"&&(e.server!==Tt.operatorKey||e.emulator!==Tt.emulatorKey||e.exitDelay!==Tt.exitDelaySeconds))throw new Error("The hive's host names an Operator other than Arkade's.");return{deployment:{network:e.network},keys:{server:e.server,emulator:e.emulator},operator:{unilateralExitDelay:e.exitDelay}}}var st=new Map;function No(t,e){let n=Ro(t),r=t?.terms;if(!r?.delegateKey)throw new Error("The hive's host did not state its treasury's terms.");let o={keepers:e,counter:t.counter,delegateKey:r.delegateKey,renewalWindowSeconds:r.renewalWindowSeconds,maxFeeSats:r.maxFeeSats,exitDelaySeconds:r.exitDelaySeconds},s=JSON.stringify([o,n.keys]);return st.has(s)||(st.size>8&&st.clear(),st.set(s,Me(So,To(o),{...n.keys,delegate:r.delegateKey}).pkScript)),st.get(s)}function Pi({payments:t,payment:e,keepers:n,treasury:r,budgetSats:o=null,agent:s=null,events:i=null,approved:a=[],now:u=Math.floor(Date.now()/1e3)}){let c=[],d=null;try{d=Ro(t)}catch(g){c.push(g.message)}n?.length&&(t?.keepers??[]).join()!==n.join()&&c.push("The hive's host names other keepers than this channel confirmed.");let p=null;if(d)try{p=No(t,n?.length===3?n:t.keepers),p!==t.treasuryScript&&c.push("The treasury the host pays from is not the one the keepers' keys and its terms build."),d.deployment.network==="bitcoin"&&!(t.terms.maxFeeSats<=Io)&&c.push(`The treasury's terms let a renewal take more than ${Io} sats.`)}catch(g){c.push(g?.message?.startsWith("The hive's host")?g.message:"The treasury cannot be rebuilt from the terms the hive's host states.")}try{let g=At(String(r??""));p&&g.pkScript!==p&&c.push("The address members chip in to is not this hive's treasury.")}catch{c.push("The hive's treasury address is missing or not an Arkade address.")}let f=null,l=null;if(e.kind==="withdrawal"){try{let g=At(e.address);d&&Ct(g.serverKey)!==Ct(d.keys.server)&&c.push("The withdrawal pays an address on another Operator."),p&&g.pkScript===p&&c.push("The withdrawal pays the treasury itself."),f=g.pkScript.slice(4)}catch{c.push("The withdrawal's address is not an Arkade address.")}if(e.withdrawal?.amountSats!==e.amountSats&&c.push("The amount is not the one the keeper asked for."),i){let g=i.find(R=>R.id===e.id&&R.kind===9&&(n??[]).includes(R.pubkey)),x=g?Vn(g.content):null;x?(x.amountSats!==e.amountSats||x.address!==String(e.address).toLowerCase())&&c.push("The keeper's message asks for another amount or address."):c.push("No keeper's message in this channel asks for this withdrawal.")}}else{let g=e.request;if(!g)c.push("The job's terms are missing.");else if(d){try{let R=_o(d,g.params);(R.address!==String(g.address).toLowerCase()||R.address!==e.address)&&c.push("The address is not the escrow the job's terms build."),(g.params.jobId!==g.jobId||g.params.providerPk!==g.providerPk||g.params.deadline!==g.deadline)&&c.push("The job's terms disagree with themselves."),p&&g.params.treasuryProgram!==p.slice(4)&&c.push("The escrow gives back to another treasury than this hive's."),f=R.pkScript.slice(4),l=g.params.agentPk}catch{c.push("The job's terms do not build an escrow.")}g.capSats!==e.amountSats&&c.push("The amount is not the job's cap."),g.deadline>u||c.push("The job's deadline has passed.");let x=to(d.deployment.network);x&&e.amountSats>x.escrowSats&&c.push(`The job asks more than the ${x.escrowSats.toLocaleString("en-US")} sats an escrow may hold on mainnet.`),o!==null&&e.amountSats>o&&c.push(`The job asks more than approved proposals have left: ${Math.max(0,o).toLocaleString("en-US")} sats.`),s&&l&&l!==s&&c.push(`The job's receipts would be signed by another agent (${l.slice(0,8)}\u2026) than this hive's (${s.slice(0,8)}\u2026).`)}}e.validUntil>u+60||c.push("The payment's approvals lapse too soon."),e.validUntil<=u+Kn||c.push("The payment's approvals would stay valid for more than a day."),Number.isSafeInteger(e.amountSats)&&e.amountSats>0&&BigInt(e.amountSats)<=vn||c.push("The amount is not one an approval can name."),f&&e.program!==f&&c.push("The desk would pay another script than the one checked here."),(e.left===null||e.left===void 0||String(t?.units)!==String(e.left))&&c.push("It is not this payment's turn: the treasury stands at another number.");let m=null;try{if(!f)throw new Error;let g={left:BigInt(e.left),amount:BigInt(e.amountSats),validUntil:e.validUntil,program:f};m=Ln(Bn(t.counter,g)),e.code&&e.code!==m&&c.push("The desk asks for another approval than the one checked here.");let x=a.find(R=>R.code!==m&&R.amountSats===e.amountSats&&R.recipient===f.slice(0,8)&&R.at>u-Kn);return x&&c.push(`You approved this amount to this recipient under another number on ${new Date(x.at*1e3).toLocaleString()}. That approval can still pay for up to a day after it; approving again could pay twice.`),{problems:c,code:m,agentPk:l,mine:a.some(R=>R.code===m),approve:xo(t.counter,g),decline:wo(t.counter,g)}}catch{return c.length||c.push("The payment could not be rebuilt."),{problems:c,code:m,agentPk:l,mine:!1,approve:null,decline:null}}}function hi(t,e,n){let r=String(e??"").trim().toLowerCase(),o=Number(String(t??"").replace(/[,_\s]/g,""));if(!Number.isSafeInteger(o)||o<=0)return{text:null,problem:"Give the amount in whole sats."};try{let s=At(r),i=n?.operator?.server;if(i&&Ct(s.serverKey)!==Ct(i))return{text:null,problem:"That address is on another Arkade Operator than the hive's."}}catch{return{text:null,problem:"That is not an Arkade address."}}return{text:Eo(o,r),problem:null}}return Bo(Oi);})();
    return (hiveChecks.loaded = HiveChecks);
}

// Where members install this plugin from, when it was built with --install: "<repository>#<branch>".
const INSTALL = "https://github.com/brg444/hive#plugin";
// The repository's documentation as one Markdown file, for the Hive guide, when built with --docs.
const HIVE_DOCS = "https://brg444.github.io/hive/docs/hive-docs.md";

const STATUS = {
    offered: "Offered",
    awaiting_funding: "Awaiting funding",
    open: "Open",
    closing: "Closing",
    claimed: "Paid",
    returned: "Returned",
    declined: "Declined",
    lapsed: "Lapsed",
};
const STAGE = {
    open: "Open for discussion",
    approved: "Approved",
    running: "Running",
    completed: "Completed",
    lapsed: "Ended",
    declined: "Declined",
    withdrawn: "Withdrawn",
};
const APPROVE = ["✅", "✔️", "☑️"];
const SUPPORT = ["👍", "+", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", "❤️", "🙌"];

const nf = new Intl.NumberFormat();
// Sats for what agents read and what the bot posts, the unit every client parses. What a member sees
// on screen reads in the unit they chose in Settings, through `amount`.
const sats = (n) => (n === null || n === undefined ? "–" : `${nf.format(n)} sats`);
let unit = savedUnit();
let usdPerBtc = null;
const amount = (n, exact = false) => formatAmount(n, unit, usdPerBtc, exact);
const short = (s, head = 10, tail = 6) => (!s ? "–" : s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`);
const modelName = (m) => (m ? (m.startsWith("local-gguf/sha256-") ? `local model ${m.slice(18, 26)}` : m) : "–");
const RAIL = { lightning: "Lightning", arkade: "Arkade", onchain: "on-chain Bitcoin" };
const rail = (r) => RAIL[r] ?? (r?.startsWith("ff-") ? "a stablecoin deposit" : r ?? "–");
const when = (unix) => (unix ? new Date(unix * 1000).toLocaleString() : "–");
const stamp = (unix) => (unix ? new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
const day = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "–");
const nowS = () => Math.floor(Date.now() / 1000);
function until(unix) {
    if (!unix) return "–";
    const s = unix - nowS();
    const abs = Math.abs(s);
    const text = abs < 3600 ? `${Math.max(1, Math.round(abs / 60))} min` : abs < 172800 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} days`;
    return s >= 0 ? `in ${text}` : `${text} ago`;
}

/** Proposals a member may spend from: everyone's, those naming them, and their own. */
function allowancesFor(gov, viewer) {
    if (!gov || !viewer) return [];
    return gov.proposals.filter((p) => p.state === "running" && (p.who === "everyone" || p.by === viewer || (p.who === "named" && p.named.includes(viewer))));
}

/** The hive's channel and keepers: built into the plugin, or as the host reports them. */
function configFrom(state) {
    const c = CONFIG ?? (state?.governance?.channelId ? state.governance : null);
    if (!c?.channelId) return null;
    return { channelId: c.channelId, keepers: c.keepers ?? [], threshold: c.threshold ?? 2, smallSats: c.smallSats ?? 20000,
        // A test hive discusses every proposal for the same short time.
        ...(Number.isSafeInteger(c.discussionSeconds) ? { discussionSeconds: c.discussionSeconds } : {}) };
}

/**
 * Where proposals stand. From the channel's own events when the plugin can read them, which is
 * live and needs nothing else running; from the host's record otherwise.
 */
function governanceFrom(state, events) {
    const cfg = configFrom(state);
    if (!cfg) return null;
    if (events) {
        const usage = Object.fromEntries((state?.proposals ?? []).map((b) => [b.proposal, b.usedSats]));
        const r = coordinate(events, { ...cfg, now: nowS(), usage });
        const members = Object.fromEntries(Object.entries(r.nodes).map(([k, v]) => [k, { node: v.node }]));
        return { ...cfg, proposals: r.proposals, members, agentKey: r.agent?.key ?? null, source: "channel" };
    }
    const g = state?.governance;
    if (g?.channelId === cfg.channelId) return { ...cfg, proposals: g.proposals ?? [], members: g.members ?? {}, agentKey: g.agentKey ?? null, source: "host" };
    return { ...cfg, proposals: [], members: {}, agentKey: null, source: "none" };
}

/** The payments waiting for keepers' approvals, as the hive's approvals desk reports them. */
const waitingPayments = (state) => (state?.payments?.payments ?? []).filter((p) => p.status === "approving" || p.status === "ready");

/** A one-line account of the hive, for agents in the community. */
function summarize(state, gov) {
    if (!state && !gov) return "The hive's state has not loaded yet.";
    const lines = [];
    if (state) {
        const open = state.jobs.filter((j) => j.status === "open");
        lines.push(
            `${state.name}: treasury ${sats(state.treasury.balanceSats)}.`,
            state.chipIn?.lightningAddress ? `Chip in at ${state.chipIn.lightningAddress}.` : null,
            `${open.length} open job(s), ${state.funding.length} awaiting funding by keepers.`,
            ...state.funding.map((j) => `- Fund ${sats(j.capSats)} to ${j.escrowAddress} for ${modelName(j.model)} (deadline ${when(j.deadline)}).`),
            ...waitingPayments(state).map((p) => `- Payment of ${sats(p.amountSats)} ${p.kind === "withdrawal" ? `withdrawn to ${p.address}` : `to fund job ${short(p.id)}`}: ${p.approvedBy.length} of ${gov?.threshold ?? 2} keepers approved, until ${when(p.validUntil)}.`),
        );
    }
    lines.push(...(gov?.proposals ?? []).filter((p) => ["open", "approved", "running"].includes(p.state)).map((p) =>
        `- Proposal ${p.id} "${p.title}": ${STAGE[p.state]}, ${sats(p.budgetSats)}${p.state === "running" ? `, ${sats(p.usedSats)} used` : ""}, ${p.support} support, ${p.approvals.length} keeper approval(s).`));
    if (state) {
        lines.push(
            ...(gov ? [] : (state.proposals ?? []).map((b) => `- Budget ${b.proposal}: ${sats(b.usedSats)} used by ${b.members} member(s) over ${b.requests} request(s).`)),
            state.agent ? `Members install with the hive's agent's node id ${state.agent.nodeId}.` : null,
            ...state.providers.map((p) => `- Provider ${short(p.providerPk ?? p.providerPeer)}: earned ${sats(p.earnedSats)}, ${p.openJobs} open.`),
        );
    }
    lines.push(`Members propose work in the hive's channel with a message starting "Proposal:"; 👍 supports it and ${gov?.threshold ?? 2} keepers' ✅ approve it.`);
    return lines.filter(Boolean).join("\n");
}

export function apply(ctx) {
    const React = ctx.react;
    const h = React.createElement;

    // One snapshot shared by every view, the agent tool and notifications.
    let snapshot = { state: null, error: null, loadedAt: 0, gov: null };
    let channelEvents = null;
    const listeners = new Set();
    const publish = (next) => {
        if (next.state?.price?.usdPerBtc > 0) usdPerBtc = next.state.price.usdPerBtc;
        snapshot = { ...next, gov: governanceFrom(next.state, channelEvents) };
        for (const listener of listeners) listener(snapshot);
        notify();
    };
    function useSnapshot() {
        const [view, setView] = React.useState(snapshot);
        React.useEffect(() => {
            listeners.add(setView);
            setView(snapshot);
            return () => listeners.delete(setView);
        }, []);
        return view;
    }
    /** The Buzz key of whoever is looking, when the community is connected. */
    function viewer() {
        try {
            const s = ctx.relay?.snapshot?.();
            return s?.viewer ?? s?.session?.viewer ?? null;
        } catch {
            return null;
        }
    }
    const isHiveChannel = (channelId) => Boolean(channelId && snapshot.gov?.channelId === channelId);

    const funding = ctx.notifications.register({ id: "funding", label: "Hive funding requests" });
    const decisions = ctx.notifications.register({ id: "decisions", label: "Hive proposals waiting for keepers" });
    const approvals = ctx.notifications.register({ id: "approvals", label: "Hive payments waiting for your approval" });
    const announced = new Set();
    const pageTarget = { version: 1, kind: "plugin", pluginId: PLUGIN_ID, pageId: "main" };

    /** Each job that needs keepers, and each proposal waiting on this keeper, is announced once. */
    function notify() {
        const { state, gov } = snapshot;
        const name = state?.name ?? HIVE_NAME;
        for (const job of state?.funding ?? []) {
            if (announced.has(`f:${job.jobId}`)) continue;
            announced.add(`f:${job.jobId}`);
            funding.submit({ sourceKey: `funding:${job.jobId}`, target: pageTarget,
                title: `${name}: a job needs funding`, body: `${amount(job.capSats)} for ${modelName(job.model)}, before ${when(job.deadline)}.` })?.catch?.(() => {});
        }
        const me = viewer();
        if (!me || !gov?.keepers.includes(me)) return;
        for (const p of waitingPayments(state)) {
            if (p.approvedBy.includes(me) || !p.code || announced.has(`a:${p.code}`)) continue;
            announced.add(`a:${p.code}`);
            approvals.submit({ sourceKey: `approve:${p.code}`, target: pageTarget,
                title: `${name}: a payment waits for your approval`,
                body: `${amount(p.amountSats)} ${p.kind === "withdrawal" ? "to withdraw" : "to fund a job"}. Check it and approve it from the hive's channel.` })?.catch?.(() => {});
        }
        for (const p of gov.proposals) {
            if (p.state !== "open" || p.discussionEnds > nowS() || p.approvals.includes(me) || announced.has(`d:${p.id}`)) continue;
            announced.add(`d:${p.id}`);
            decisions.submit({ sourceKey: `decide:${p.id}`, target: pageTarget,
                title: `${name}: “${p.title}” is ready for keepers`, body: `${amount(p.budgetSats)}, ${p.support} members support it. React ✅ to approve or ❌ to decline.` })?.catch?.(() => {});
        }
    }

    // ---- Finding the hive on the shared service ---------------------------------------------
    // The community's hive is the one HiveBot set up in one of its channels. The plugin asks the
    // service for its community's hives, and checks each channel it is shown, once.
    const probed = new Set();
    const community = () => {
        try { return String(ctx.relay?.snapshot?.()?.scope ?? ""); } catch { return ""; }
    };
    async function tryChannel(channelId) {
        if (!SERVICE || hiveApi || !channelId || probed.has(channelId)) return false;
        probed.add(channelId);
        try {
            const res = await ctx.host.request({ url: `${SERVICE}/c/${channelId}/hive/v1/state`, timeoutMs: 15_000 });
            if (res.status !== 200) return false;
            hiveApi = `${SERVICE}/c/${channelId}`;
            return true;
        } catch { return false; }
    }
    async function findHive() {
        if (!SERVICE || hiveApi) return;
        try {
            const res = await ctx.host.request({ url: `${SERVICE}/hives?community=${encodeURIComponent(community())}`, timeoutMs: 15_000 });
            if (res.status === 200) for (const h of JSON.parse(res.body).hives ?? []) if (await tryChannel(h.channelId)) return;
        } catch { /* asked again on the next poll */ }
    }
    /** A channel the member is looking at: the hive's, perhaps. */
    function noteChannel(channelId) {
        if (SERVICE && !hiveApi && channelId && !probed.has(channelId)) void tryChannel(channelId).then((found) => found && load());
    }
    /** HiveBot's setup asks the service for a hive in its channel, with its first setup message as proof. */
    async function askForHive(handle, channelId, events) {
        if (!SERVICE) return;
        const call = events.find((e) => e.pubkey === handle.pubkey && (e.tags ?? []).some((t) => t[0] === "hive" && t[1] === "call"));
        if (!call?.sig) return;
        try {
            const res = await ctx.host.request({ url: `${SERVICE}/hives`, method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ channelId, community: community(), name: HIVE_NAME, call }), timeoutMs: 15_000 });
            // A hive the service opened in this channel under another key is not this bot's: left alone.
            const asked = res.status === 200 ? JSON.parse(res.body) : null;
            if (asked?.status === "approved" && asked.bot !== handle.pubkey) return;
            probed.delete(channelId);
            if (await tryChannel(channelId)) void load();
        } catch { /* asked again on the next pass */ }
    }

    async function load() {
        try {
            if (!hiveApi) await findHive();
            if (!hiveApi) return publish({ ...snapshot, state: null, error: null, loadedAt: Date.now() });
            const res = await ctx.host.request({ url: `${hiveApi}/hive/v1/state`, timeoutMs: 15_000 });
            if (res.status !== 200) throw new Error(`the hive's host answered ${res.status}`);
            const state = JSON.parse(res.body);
            if (state?.v !== 1) throw new Error("the hive's host speaks another version");
            // A new hive has no treasury until its keepers are confirmed.
            state.treasury ??= { address: null, balanceSats: null };
            publish({ ...snapshot, state, error: null, loadedAt: Date.now() });
            // Whatever the host has not taken yet is sent again: a hive just opened on the service
            // gets its channel without waiting for the next message in it.
            if (channelEvents) forward(channelEvents);
        } catch (e) {
            publish({ ...snapshot, error: String(e?.message ?? e) });
        }
    }

    ctx.effect(() => {
        let timer;
        let stopped = false;
        const tick = async () => {
            await load();
            // A little jitter so a community's clients do not all ask the host at once.
            if (!stopped) timer = setTimeout(tick, POLL_MS + Math.floor(Math.random() * 5_000));
        };
        timer = setTimeout(tick, Math.floor(Math.random() * 1_000));
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    });

    // The hive's host has no Buzz key of its own, so each member's plugin forwards the channel's
    // signed events to it: the host checks every signature and works out proposals and members
    // itself. Only events it has not been sent are sent, a few seconds after they arrive.
    const forwarded = new Set();
    let forwardTimer = null;
    let forwarding = true;
    function forward(events) {
        if (!forwarding) return;
        // A hive still waiting for the service's operator keeps nothing: sent once it is open.
        if (snapshot.state?.hive && snapshot.state.hive.status !== "approved") return;
        clearTimeout(forwardTimer);
        forwardTimer = setTimeout(async () => {
            const fresh = events.filter((e) => e.sig && e.id && !forwarded.has(e.id));
            if (!fresh.length) return;
            try {
                if (!hiveApi) return;
                const res = await ctx.host.request({ url: `${hiveApi}/hive/v1/channel`, method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ events: fresh.map(({ id, pubkey, created_at, kind, tags, content, sig }) => ({ id, pubkey, created_at, kind, tags, content, sig })) }),
                    timeoutMs: 30_000 });
                // A host that does not take the channel says so once; this plugin then stops asking.
                if (res.status === 404) { forwarding = false; return; }
                if (res.status === 200) for (const e of fresh) forwarded.add(e.id);
            } catch { /* tried again with the next event */ }
        }, 3_000 + Math.floor(Math.random() * 4_000));
    }

    // The hive's channel, read through the community connection Buzz already has: proposals,
    // reactions and deletions from the last few months, kept live as new ones arrive.
    ctx.effect(() => {
        let view = null;
        let stopView = null;
        let key = null;
        const recompute = () => {
            const events = (view?.snapshot().events ?? []).filter((e) => e.delivery !== "failed");
            channelEvents = view ? events : null;
            publish(snapshot);
            if (view) forward(events);
        };
        const detach = () => {
            stopView?.();
            view?.dispose?.();
            view = stopView = null;
            if (channelEvents) {
                channelEvents = null;
                publish(snapshot);
            }
        };
        const attach = () => {
            let relay;
            try { relay = ctx.relay?.snapshot?.(); } catch { relay = null; }
            const cfg = configFrom(snapshot.state);
            const session = relay?.session;
            const next = cfg && typeof session?.observe === "function" ? `${relay.scope ?? relay.generation}:${cfg.channelId}` : null;
            if (next === key) return;
            key = next; // before detaching, which publishes and calls back here
            detach();
            if (!next) return;
            const since = nowS() - LOOKBACK_DAYS * 86400;
            const channel = [cfg.channelId];
            try {
                view = session.observe([
                    { kinds: [9], "#h": channel, since, limit: 1000 },
                    { kinds: [7], "#h": channel, since, limit: 2000 },
                    { kinds: [5], "#h": channel, since, limit: 500 },
                ]);
            } catch {
                view = null;
                return;
            }
            stopView = view.subscribe(recompute);
            recompute();
            view.refresh?.();
        };
        const stopRelay = ctx.relay?.subscribe?.(attach);
        listeners.add(attach);
        attach();
        // Live events reach the view while Buzz follows the channel; a refresh catches the rest.
        const refresher = setInterval(() => view?.refresh?.(), 120_000);
        return () => {
            clearInterval(refresher);
            listeners.delete(attach);
            stopRelay?.();
            detach();
        };
    });

    // ---- HiveBot: an agent of the plugin's own type --------------------------------------
    // The owner creates it on the Agents page and adds it to the hive's channel. Buzz holds its key
    // and signs it into the community, so it posts as itself wherever the community requires
    // sign-in. It needs no model: it answers mentions with the hive's status, and says hello once.
    const BOT_TYPE = `${PLUGIN_ID}/bot`;
    const botTag = (key) => ["hive", key];
    /** A line or two about where the hive stands, for a mention or the hello. */
    function statusText() {
        const { state, gov } = snapshot;
        const open = (gov?.proposals ?? []).filter((p) => p.state === "open");
        const running = (gov?.proposals ?? []).filter((p) => p.state === "running");
        const parts = [
            state ? `The treasury holds ${sats(state.treasury.balanceSats)}.` : null,
            open.length ? `${open.length} proposal${open.length === 1 ? " is" : "s are"} open: ${open.map((p) => `“${p.title}”`).join(", ")}.` : "No proposal is open.",
            running.length ? `${running.length} budget${running.length === 1 ? " is" : "s are"} running.` : null,
            state?.funding.length ? `${state.funding.length} job${state.funding.length === 1 ? " is" : "s are"} waiting for keepers to fund.` : null,
        ];
        return parts.filter(Boolean).join(" ");
    }
    /** Reply tags for a message: its thread's root, the message itself, and its author. */
    function replyTags(event, channelId) {
        const root = (event.tags ?? []).find((t) => t[0] === "e" && t[3] === "root")?.[1] ?? event.id;
        return [["h", channelId], ["e", root, "", "root"], ["e", event.id, "", "reply"], ["p", event.pubkey]];
    }
    ctx.agents.register?.({
        id: "bot",
        title: "Hive bot",
        description: "Posts what happens in the hive into its channel as itself, and answers mentions with the hive's status. It needs no model and runs while Buzz is open on this computer.",
        defaults: () => ({ config: {} }),
        summary: () => "Hive bot",
        async run(delivery) {
            const t = delivery.trigger;
            if (t?.type !== "mention" || !delivery.channelId) {
                delivery.ignored?.();
                return;
            }
            delivery.acknowledged?.();
            if (!snapshot.state) await load();
            const handle = delivery.agent;
            if (SETUP.test(t.event.content ?? "")) {
                if (t.event.pubkey !== handle.owner) {
                    await handle.publish({ kind: 9, content: "Only the member who created me can start a hive's setup.", tags: replyTags(t.event, delivery.channelId) });
                    return;
                }
                const needed = Math.max(2, Math.min(9, Number(/(\d+)\s*keepers?/i.exec(t.event.content)?.[1] ?? 3)));
                const posted = await onboardIn({ pubkey: handle.pubkey, name: handle.name, owner: handle.owner }, handle, delivery.channelId, { start: true, needed });
                if (!posted) await handle.publish({ kind: 9, content: "Setup is already under way in this channel: react ✅ to my message above if you'll keep the treasury.", tags: replyTags(t.event, delivery.channelId) });
                return;
            }
            if (ADD_GUIDE.test(t.event.content ?? "")) {
                await handle.publish({ kind: 9, content: await addGuide(handle, t.event), tags: replyTags(t.event, delivery.channelId) });
                return;
            }
            if (UPDATE_GUIDE.test(t.event.content ?? "")) {
                await handle.publish({ kind: 9, content: await updateGuide(handle, t.event), tags: replyTags(t.event, delivery.channelId) });
                return;
            }
            // Questions go to the guide, when the owner has one; HiveBot itself only states where the hive stands.
            const guide = guideFor(handle.owner);
            if (guide && !STATUS.test(t.event.content ?? "")) {
                const root = replyTags(t.event, delivery.channelId)[1][1];
                ctx.agents.wake(guide.key, { channel: delivery.channelId, root, text:
                    `A member asked HiveBot in this thread: “${(t.event.content ?? "").slice(0, 2000)}”. Answer them here, using the hive tools.` });
                await handle.publish({ kind: 7, content: "👀", tags: [["h", delivery.channelId], ["e", t.event.id], ["p", t.event.pubkey]] }).catch(() => {});
                return;
            }
            await handle.publish({ kind: 9, content: guide ? statusText() : `${statusText()} For other questions, the community owner can add a guide: mention me with “add a guide”.`,
                tags: replyTags(t.event, delivery.channelId) });
        },
    });
    const STATUS = /\b(status|where|treasury|balance|budget)\b/i;
    const ADD_GUIDE = /\badd\b.*\bguide\b/i;
    const UPDATE_GUIDE = /\bupdate\b.*\bguide\b/i;
    /** Asks Buzz, for the owner to review, to give the guide the current instructions. */
    async function updateGuide(handle, event) {
        if (event.pubkey !== handle.owner) return "Only the member who created me can update the guide.";
        if (!guideFor(handle.owner)) return `There is no ${GUIDE_NAME} here yet: mention me with “add a guide”.`;
        if (typeof handle.updateAgent !== "function") return `This Buzz can't change agents for me. Paste the instructions from shared/guide.mjs in the Hive repository into ${GUIDE_NAME}'s settings.`;
        await handle.updateAgent({ agent: GUIDE_NAME, instructions: GUIDE_INSTRUCTIONS });
        return `I've asked Buzz to give ${GUIDE_NAME} the current instructions. Review the change on the Agents page.`;
    }
    /** The owner's Hive guide running on this computer: a Goose agent by that name. */
    function guideFor(owner) {
        if (typeof ctx.agents.snapshot !== "function" || typeof ctx.agents.wake !== "function") return null;
        return (ctx.agents.snapshot()?.running ?? []).find((a) => a.type === GOOSE_TYPE && a.name === GUIDE_NAME && (!owner || a.owner === owner)) ?? null;
    }
    /** Asks Buzz, for the owner to review, to create the guide with its instructions. */
    async function addGuide(handle, event) {
        if (event.pubkey !== handle.owner) return "Only the member who created me can add a guide.";
        if (guideFor(handle.owner)) return `${GUIDE_NAME} is already here. Mention it, or me, with a question; mention me with “update the guide” to give it the current instructions.`;
        if (typeof handle.createAgent !== "function") {
            return `This Buzz can't create agents for me. Create a Goose agent named ${GUIDE_NAME} on the Agents page, give it the Hive guide instructions from the Hive repository, and add it to this channel.`;
        }
        await handle.createAgent({ type: GOOSE_TYPE, name: GUIDE_NAME, instructions: GUIDE_INSTRUCTIONS });
        return `I've asked Buzz to create ${GUIDE_NAME}, a Goose agent with the hive's instructions and tools. Review it on the Agents page and add it to this channel; from then on I'll pass questions to it.`;
    }
    // Onboarding: the owner mentions HiveBot asking to set up, and HiveBot walks the channel through
    // keepers, the plugin, the treasury and the first proposal. Where it stands is read back from
    // its own tagged messages, so a restart, another computer or a reload picks up where it left off.
    const SETUP = /\b(set\s*up|setup|onboard)\b/i;
    function installText() {
        if (!INSTALL) return "The community owner shares it; in Buzz it installs from Settings → Plugins → Manage plugins → Add.";
        const [repository, ref] = INSTALL.split("#");
        return `In Buzz, open Settings → Plugins → Manage plugins → Add → Add from Git, with ${repository} and the branch ${ref}.`;
    }
    /** Display names from Buzz profiles, as the bot reads them. */
    async function profileNames(handle, keys) {
        if (!keys.length) return {};
        const events = await handle.query([{ kinds: [0], authors: keys, limit: keys.length * 2 }]).catch(() => []);
        const out = {};
        for (const e of [...events].sort((a, b) => a.created_at - b.created_at)) {
            try {
                const p = JSON.parse(e.content);
                const name = p.display_name || p.displayName || p.name;
                if (name) out[e.pubkey] = String(name).slice(0, 60);
            } catch { /* not a profile */ }
        }
        return out;
    }
    const busy = new Set();
    /** One onboarding pass in a channel; returns how many messages it posted. */
    async function onboardIn(bot, handle, channelId, { start = false, needed: asked } = {}) {
        const key = `${bot.pubkey}:${channelId}`;
        if (busy.has(key)) return 0;
        busy.add(key);
        try {
            const since = nowS() - 30 * 86400;
            const channel = [channelId];
            const events = await handle.query([
                { kinds: [9], "#h": channel, since, limit: 500 },
                { kinds: [7], "#h": channel, since, limit: 1000 },
                { kinds: [5], "#h": channel, since, limit: 200 },
            ]);
            const cfg = configFrom(snapshot.state);
            const threshold = cfg?.channelId === channelId ? cfg.threshold : 2;
            const smallSats = cfg?.smallSats ?? 20000;
            const record = recordFromChannel(events, bot.pubkey, threshold);
            if (!record.posts.call && !start) return 0;
            if (record.done) return 0;
            const call = events.find((e) => e.id === record.posts.call);
            const needed = Number(/needed=(\d+)/.exec((call?.tags ?? []).find((t) => t[0] === "hive")?.[2] ?? "")?.[1] ?? asked ?? 3);
            const proposals = record.keepers ? coordinate(events, { keepers: record.keepers, threshold, smallSats }).proposals : [];
            const founder = handle.owner ?? bot.owner;
            const names = await profileNames(handle, [...new Set([founder, ...events.filter((e) => e.kind === 7).map((e) => e.pubkey)])]);
            const { posts, record: next } = onboardingPlan(record, { events, bot: bot.pubkey, founder, needed, threshold, smallSats,
                state: snapshot.state, proposals, name: (k) => names[k] ?? k.slice(0, 8), botName: bot.name, install: installText() });
            for (const post of posts) {
                const extra = post.key === "call" ? [`needed=${needed}`] : post.key === "treasury" && next.treasuryReady ? ["ready"] : [];
                await handle.publish({ kind: 9, content: post.text,
                    tags: [["h", channelId], ["hive", post.key, ...extra], ...(post.mentions ?? []).map((k) => ["p", k])] });
            }
            // On the shared service, the setup asks for this channel's hive, proving it with HiveBot's first message.
            if (SERVICE && !hiveApi) {
                const mine = posts.some((p) => p.key === "call")
                    ? await handle.query([{ kinds: [9], "#h": channel, authors: [bot.pubkey], since, limit: 50 }]).catch(() => [])
                    : events;
                await askForHive({ ...handle, pubkey: handle.pubkey ?? bot.pubkey }, channelId, mine);
            }
            return posts.length;
        } finally {
            busy.delete(key);
        }
    }
    /** Every channel where a bot of this type has a setup under way. */
    async function driveOnboarding() {
        if (typeof ctx.agents.snapshot !== "function" || typeof ctx.agents.handle !== "function") return;
        for (const bot of (ctx.agents.snapshot()?.running ?? []).filter((a) => a.type === BOT_TYPE)) {
            const handle = ctx.agents.handle(bot.pubkey);
            if (!handle) continue;
            const mine = await handle.query([{ kinds: [9], authors: [bot.pubkey], since: nowS() - 30 * 86400, limit: 200 }]).catch(() => []);
            const tagged = (key) => new Set(mine.filter((e) => (e.tags ?? []).some((t) => t[0] === "hive" && t[1] === key))
                .map((e) => (e.tags ?? []).find((t) => t[0] === "h")?.[1]).filter(Boolean));
            const done = tagged("done");
            for (const channelId of tagged("call")) {
                if (!done.has(channelId)) await onboardIn(bot, handle, channelId).catch(() => {});
            }
            // Members' nodes: the hive's own channel, and every channel this bot set up.
            const channels = new Set([...tagged("call"), ...(snapshot.gov?.channelId ? [snapshot.gov.channelId] : [])]);
            for (const channelId of channels) await acknowledgeNodes(bot, handle, channelId, mine).catch(() => {});
        }
    }

    /**
     * Members' nodes, acknowledged once each. HiveBot reads the channel itself, so its acknowledgement
     * tells the hive's host, which gets the channel forwarded, that the member really posted it here.
     */
    async function acknowledgeNodes(bot, handle, channelId, mine) {
        const since = nowS() - 30 * 86400;
        const events = await handle.query([{ kinds: [9], "#h": [channelId], since, limit: 500 }]);
        const answered = new Set(mine.flatMap((e) => (e.tags ?? []).filter((t) => t[0] === "hive" && t[1] === "node-ack").map((t) => t[2])));
        const posts = events.filter((e) => e.pubkey !== bot.pubkey && parseNodeClaim(e.content) && !answered.has(e.id)).sort((a, b) => a.created_at - b.created_at);
        if (!posts.length) return;
        const names = await profileNames(handle, [...new Set(posts.map((e) => e.pubkey))]);
        for (const post of posts) {
            const name = `@${names[post.pubkey] ?? post.pubkey.slice(0, 8)}`;
            await handle.publish({ kind: 9, content: `Got it, ${name}: your node is in, and uses the budgets running for you from now on.`,
                tags: [...replyTags(post, channelId), ["hive", "node-ack", post.id]] });
        }
    }

    // Once per channel, the bot introduces itself, so the owner sees it posting. What it has said
    // is read back from the channel, so nothing is stored here.
    const greeted = new Set();
    const tried = new Map();
    async function greet() {
        const gov = snapshot.gov;
        if (!gov?.channelId || typeof ctx.agents.snapshot !== "function" || typeof ctx.agents.handle !== "function") return;
        const bots = (ctx.agents.snapshot()?.running ?? []).filter((a) => a.type === BOT_TYPE);
        for (const bot of bots) {
            const key = `${bot.pubkey}:${gov.channelId}`;
            if (greeted.has(key) || Date.now() - (tried.get(key) ?? 0) < 60_000) continue;
            const handle = ctx.agents.handle(bot.pubkey);
            if (!handle) continue;
            greeted.add(key);
            tried.set(key, Date.now());
            try {
                const said = await handle.query([{ kinds: [9], authors: [bot.pubkey], "#h": [gov.channelId], limit: 50 }]);
                if (said.some((e) => (e.tags ?? []).some((tag) => tag[0] === "hive" && (tag[1] === "hello" || tag[1] === "call")))) continue;
                await handle.publish({ kind: 9, tags: [["h", gov.channelId], botTag("hello")], content:
                    `Hi, I'm ${bot.name}, this hive's bot. I'll post proposals' decisions, payouts and chip-ins here as they happen. Mention me any time for where the hive stands. ${statusText()}` });
            } catch {
                greeted.delete(key); // not in the channel yet, or offline: try again later
            }
        }
    }
    ctx.effect(() => {
        const stop = ctx.agents.subscribe?.(() => { greet(); driveOnboarding(); });
        listeners.add(greet);
        greet();
        driveOnboarding();
        // Reactions and replies reach the bot here every half minute, with a little jitter.
        const steps = setInterval(() => driveOnboarding().catch(() => {}), 30_000 + Math.floor(Math.random() * 5_000));
        const retry = setInterval(greet, 60_000);
        return () => {
            clearInterval(retry);
            clearInterval(steps);
            listeners.delete(greet);
            stop?.();
        };
    });

    ctx.agents.addTool({
        name: "hive_status",
        description: `The ${HIVE_NAME} hive's treasury, chip-in address, proposals, open jobs, jobs awaiting funding and provider earnings.`,
        inputSchema: { type: "object", properties: {} },
        async call() {
            if (!snapshot.state) await load();
            return summarize(snapshot.state, snapshot.gov);
        },
    });
    /** This hive's own settings, ahead of the general account of how a hive works. */
    function hiveFacts() {
        const { state, gov } = snapshot;
        return [
            `This hive: ${state?.name ?? HIVE_NAME}.`,
            gov ? `It has ${gov.keepers.length} keepers, any ${gov.threshold} of whom approve a proposal and a payment. ${gov.discussionSeconds ? `Discussion runs ${Math.round(gov.discussionSeconds / 60)} minutes on this test hive.` : `Discussion runs 24 hours for proposals under ${nf.format(gov.smallSats)} sats, 48 hours otherwise.`}` : "Its keepers are not set yet.",
            state?.payments ? `${waitingPayments(state).length} payment(s) wait for keepers' approvals.` : null,
            INSTALL ? `Members install the Hive plugin from ${INSTALL.split("#")[0]}, branch ${INSTALL.split("#")[1]}, with Add from Git in Buzz's plugin settings. That repository is also Hive's source and documentation.` : null,
            state?.chipIn?.lightningAddress ? `Its Lightning address is ${state.chipIn.lightningAddress}.` : null,
            state?.demo ? "Its treasury figures are sample data for trying Hive." : null,
        ].filter(Boolean).join(" ");
    }
    ctx.agents.addTool({
        name: "hive_guide",
        description: `How the ${HIVE_NAME} hive works: proposals and approvals, allowances, keepers and how they approve payments, chip-ins, with this hive's own settings. Read it before answering any question about the hive.`,
        inputSchema: { type: "object", properties: {} },
        async call() {
            return `${hiveFacts()}\n\n${HOW_IT_WORKS}`;
        },
    });
    const STOP = new Set(["the", "and", "are", "what", "how", "does", "for", "with", "that", "this", "who", "why", "when", "can", "you", "our", "its", "from", "about", "work", "works", "hive"]);
    // The repository's documentation, read once in a while and handed over a section at a time.
    let docsCache = { at: 0, sections: null };
    async function docSections() {
        if (docsCache.sections && Date.now() - docsCache.at < 15 * 60_000) return docsCache.sections;
        const res = await ctx.host.request({ url: HIVE_DOCS, timeoutMs: 15_000 });
        if (res.status !== 200) throw new Error(`the docs answered ${res.status}`);
        const sections = [];
        let source = "", current = null, fenced = false;
        for (const line of res.body.split("\n")) {
            const src = /^<!-- source: (.+) -->$/.exec(line);
            if (src) { source = src[1]; continue; }
            if (/^\s*```/.test(line)) fenced = !fenced;
            if (!fenced && /^#{1,3} /.test(line)) {
                current = { source, title: line.replace(/^#+ /, "").trim(), lines: [] };
                sections.push(current);
            } else if (current) current.lines.push(line);
        }
        docsCache = { at: Date.now(), sections: sections.map((s) => ({ ...s, text: s.lines.join("\n").trim() })).filter((s) => s.text) };
        return docsCache.sections;
    }
    ctx.agents.addTool({
        name: "hive_docs",
        description: `The Hive repository's documentation, for details hive_guide does not cover: how Hive works end to end, its safeguards, the plugin and HiveBot, keepers' approvals, and how providers serve a hive. Give a topic in a few words; without one it lists the sections.`,
        inputSchema: { type: "object", properties: { topic: { type: "string", description: "What to look up, in a few words" } } },
        async call(_client, _context, args) {
            if (!HIVE_DOCS) return "This hive's plugin was built without the repository's docs.";
            const sections = await docSections();
            // Words of the topic, cut to their stems so "claimed" finds "claim" and "keepers" "keeper".
            const words = String(args?.topic ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w))
                .map((w) => (w.length > 5 ? w.slice(0, 5) : w.replace(/s$/, "")));
            if (!words.length) return `Sections, by document:\n${sections.map((s) => `- ${s.source}: ${s.title}`).join("\n")}`;
            const scored = sections.map((s) => {
                const hay = `${s.title} ${s.text}`.toLowerCase();
                const title = s.title.toLowerCase();
                // A word in the title counts most; mentions in the text count up to three times, so long
                // sections do not win on length alone.
                return { s, score: words.reduce((n, w) => n + (title.includes(w) ? 6 : 0) + Math.min(3, hay.split(w).length - 1), 0) };
            }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
            // Sections that matter as much as the best one, not every passing mention.
            const best = scored[0]?.score ?? 0;
            scored.splice(0, scored.length, ...scored.filter((x) => x.score * 3 >= best));
            if (!scored.length) return `Nothing in the docs mentions ${args.topic}.`;
            let out = "", budget = 12_000;
            for (const { s } of scored) {
                const block = `## ${s.title} (${s.source})\n\n${s.text}\n\n`;
                if (block.length > budget) { if (!out) out = block.slice(0, budget); break; }
                out += block;
                budget -= block.length;
            }
            return out.trim();
        },
    });
    ctx.agents.addTool({
        name: "hive_proposals",
        description: `Every proposal in the ${HIVE_NAME} hive's channel: its title, budget, period, who it is for and their daily allowance, purpose, where it stands, support, keepers' approvals, discussion deadline and what it has used.`,
        inputSchema: { type: "object", properties: {} },
        async call() {
            if (!snapshot.state) await load();
            const gov = snapshot.gov;
            if (!gov) return "The hive's channel and keepers are not set up yet, so there are no proposals to read.";
            if (!gov.proposals.length) return "No proposal has been posted in the hive's channel yet.";
            return gov.proposals.map((p) => [
                `"${p.title}" (${p.id}): ${STAGE[p.state] ?? p.state}.`,
                `Budget ${sats(p.budgetSats)}${p.start ? `, ${day(p.start)} to ${day(p.end)}` : ""}${p.state === "running" ? `, ${sats(p.usedSats)} used, until ${day(p.ends)}` : ""}.`,
                `For ${p.who === "everyone" ? "everyone" : p.who === "named" ? `${p.named.length} named members` : "the proposer"}${p.allowanceSats ? `, ${sats(p.allowanceSats)} a day each` : ""}.`,
                `Purpose: ${p.purpose}`,
                `${p.support} support, ${p.approvals.length} of ${gov.threshold} keepers approved${p.state === "open" ? `, discussion ${p.discussionEnds > nowS() ? `closes ${until(p.discussionEnds)}` : "closed"}` : ""}.`,
                p.reason ? `Declined: ${p.reason}` : null,
                p.report ? `Report: ${p.report.text}` : null,
            ].filter(Boolean).join(" ")).join("\n");
        },
    });


    // ---- Look ---------------------------------------------------------------------------
    // Buzz's own tokens throughout, so light and dark both hold; honey is Buzz's amber scale, used
    // for the hive's mark, progress and anything still waiting on the community.

    const C = {
        text: "var(--text-standard)",
        subtle: "var(--text-subtle)",
        line: "var(--border-standard)",
        strong: "var(--border-prominent)",
        inset: "var(--surface-inset)",
        panel: "var(--surface-panel)",
        honey: "var(--amber-9)",
        honeyTint: "var(--amber-3)",
        honeyInk: "var(--amber-11)",
        goodTint: "var(--surface-status-success)",
        good: "var(--text-success)",
        badTint: "var(--surface-status-danger)",
        bad: "var(--text-danger)",
        radius: "var(--radius-container)",
        chip: "var(--radius-chip)",
        pill: "var(--radius-pill)",
    };
    const muted = { color: C.subtle };
    const small = { fontSize: "0.857em" };
    const tnum = { fontVariantNumeric: "tabular-nums" };
    const row = { display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "baseline", justifyContent: "space-between" };
    const stack = (gap = "var(--space-2)") => ({ display: "flex", flexDirection: "column", gap });
    const list = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" };
    const item = { padding: "var(--space-3) 0", borderTop: `1px solid ${C.line}`, display: "flex", flexDirection: "column", gap: 6 };
    const p0 = { margin: 0 };

    /** The hive's mark: one cell of the comb. */
    function Hex({ size = 14, filled = true, color = C.honey, title }) {
        return h("svg", { width: size, height: size, viewBox: "0 0 24 24", role: title ? "img" : undefined, "aria-hidden": title ? undefined : true,
            "aria-label": title, style: { flex: "none", display: "block" } },
            h("path", { d: "M12 1.8 21 7v10l-9 5.2L3 17V7z", fill: filled ? color : "none", stroke: color, strokeWidth: filled ? 0 : 1.8, strokeLinejoin: "round" }));
    }

    const TONE = {
        honey: { background: C.honeyTint, color: C.honeyInk },
        good: { background: C.goodTint, color: C.good },
        bad: { background: C.badTint, color: C.bad },
        quiet: { background: C.inset, color: C.subtle },
    };
    const STAGE_TONE = { open: "honey", approved: "good", running: "good", completed: "quiet", lapsed: "quiet", declined: "bad", withdrawn: "quiet" };
    function Pill({ tone = "quiet", children }) {
        return h("span", { style: { ...TONE[tone], padding: "2px 10px", borderRadius: C.pill, fontSize: "0.8em", fontWeight: 550, whiteSpace: "nowrap", lineHeight: 1.6 } }, children);
    }

    function Meter({ value, total, tone = "honey", label }) {
        const pct = total > 0 ? Math.max(0, Math.min(100, (100 * value) / total)) : 0;
        return h("div", { role: "img", "aria-label": label, style: { height: 6, borderRadius: C.pill, background: C.inset, overflow: "hidden" } },
            h("div", { style: { width: `${pct}%`, minWidth: pct > 0 ? 6 : 0, height: "100%", borderRadius: C.pill, background: tone === "good" ? C.good : C.honey } }));
    }

    /** n of `of` keepers approved, as cells filling in. */
    function Pips({ n, of }) {
        return h("span", { style: { display: "inline-flex", gap: 3, alignItems: "center" }, "aria-hidden": true },
            Array.from({ length: Math.max(of, n) }, (_, i) => h(Hex, { key: i, size: 12, filled: i < n, color: i < n ? C.honey : C.strong })));
    }

    function Card({ title, aside, children, tight }) {
        return h("section", { className: "ui-card", style: { padding: tight ? "var(--space-3) var(--space-4)" : "var(--space-panel-inset)", ...stack("var(--space-3)"), minWidth: 0 } },
            title ? h("div", { style: { ...row, alignItems: "center" } }, h("h2", { style: { ...p0, fontSize: "1.07em" } }, title), aside ?? null) : null,
            children);
    }

    function Empty({ children }) {
        return h("p", { style: { ...p0, ...muted } }, children);
    }

    function Copy({ text, label = "Copy" }) {
        const [done, setDone] = React.useState(false);
        return h("button", {
            type: "button",
            style: { flex: "none" },
            onClick: async () => {
                try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard refused */ }
            },
        }, done ? "Copied" : label);
    }

    /** A value to send or paste, in a well with its copy button. */
    function Well({ label, value, copy, mono = true }) {
        return h("div", { style: stack(4) },
            label ? h("span", { style: { ...muted, ...small } }, label) : null,
            h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", background: C.inset, borderRadius: C.chip, padding: "6px 6px 6px 12px", minWidth: 0 } },
                h(mono ? "code" : "span", { style: { flex: 1, minWidth: 0, overflowWrap: "anywhere", fontSize: mono ? "0.86em" : undefined } }, value),
                copy ? h(Copy, { text: copy }) : null));
    }

    const btn = {
        primary: { background: "var(--affordance-prominent)", color: "var(--text-on-prominent)", border: "1px solid transparent", borderRadius: C.pill, padding: "6px 16px", fontWeight: 550, cursor: "pointer" },
        quiet: { background: "transparent", color: C.subtle, border: 0, padding: "2px 4px", cursor: "pointer", font: "inherit" },
    };

    // ---- Proposals as cards in the channel ------------------------------------------------

    const reactors = (message, emojis) =>
        new Set((message.reactions ?? []).filter((r) => emojis.includes(r.content)).flatMap((r) => r.events.map((e) => e.authorId)));

    function ProposalCard({ message }) {
        const { gov } = useSnapshot();
        const [open, setOpen] = React.useState(false);
        const p = parseProposal(message.content, message.mentions ?? []);
        if (!p) return h("p", { style: p0 }, message.content);
        const record = gov?.proposals.find((x) => x.eventId === message.id);
        const keepers = gov?.keepers ?? [];
        const threshold = gov?.threshold ?? 2;
        // Live from the message itself, so a reaction shows at once; the record says what was decided.
        const support = [...reactors(message, SUPPORT)].filter((k) => k !== message.authorId).length;
        const approvals = [...reactors(message, APPROVE)].filter((k) => keepers.includes(k)).length;
        const stage = record?.state ?? "open";
        const postedAt = record?.postedAt ?? message.createdAt;
        const ends = record?.discussionEnds ?? postedAt + (gov?.discussionSeconds ?? discussionSeconds(p.budgetSats, gov?.smallSats ?? 20000));
        const forText = p.who === "everyone" ? "Everyone in the hive" : p.who === "named" ? `${p.named.length || "Named"} member${p.named.length === 1 ? "" : "s"}` : "The proposer";
        const period = p.start ? `${day(p.start)} – ${day(p.end)}` : record?.starts ? `${day(record.starts)} – ${day(record.ends)}` : "30 days from approval";
        const extra = [["Work", p.work], ["Provider", p.provider], ["Report", p.report]].filter(([, v]) => v);

        let progress = null;
        if (stage === "open") {
            const left = ends - nowS();
            progress = h("div", { style: stack(6) },
                h(Meter, { value: nowS() - postedAt, total: ends - postedAt, label: "Discussion time used" }),
                h("span", { style: { ...small, ...muted } },
                    left > 0 ? `Discussion closes ${until(ends)}` : approvals >= threshold ? "Approved, recorded on the bot's next pass" : "Discussion closed, waiting for keepers"));
        } else if (stage === "running" && record) {
            progress = h("div", { style: stack(6) },
                h(Meter, { value: record.usedSats, total: p.budgetSats, tone: "good", label: `${amount(record.usedSats)} of ${amount(p.budgetSats)} used` }),
                h("div", { style: { ...row, ...small, ...muted } },
                    h("span", { style: tnum }, `${amount(record.usedSats)} used of ${amount(p.budgetSats)}`),
                    h("span", null, `until ${day(record.ends)}`)));
        } else if (stage === "approved" && record) {
            progress = h("p", { style: { ...p0, ...small, ...muted } }, `Approved. The budget opens ${day(record.starts)}, once keepers fund its first job.`);
        } else if (stage === "declined") {
            progress = h("p", { style: { ...p0, ...small, color: C.bad } }, record?.reason ? `Declined: ${record.reason}` : "Declined by a keeper.");
        } else if (stage === "completed" && record?.report) {
            progress = h("p", { style: { ...p0, ...small } }, h("span", { style: muted }, "Report: "), record.report.text);
        }

        return h("div", { className: "ui-card", style: { ...stack("var(--space-3)"), padding: "var(--space-3) var(--space-4) var(--space-3)", maxWidth: 560, boxSizing: "border-box" } },
            h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "flex-start", justifyContent: "space-between" } },
                h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "flex-start", minWidth: 0 } },
                    h("div", { style: { paddingTop: 3 } }, h(Hex, { size: 16, title: "Hive proposal" })),
                    h("strong", { style: { fontSize: "1.07em", lineHeight: 1.35 } }, p.title)),
                h(Pill, { tone: STAGE_TONE[stage] }, STAGE[stage] ?? stage)),
            h("div", { style: { display: "flex", flexWrap: "wrap", columnGap: "var(--space-4)", rowGap: 4 } },
                h("span", { style: { fontWeight: 600, ...tnum } }, amount(p.budgetSats)),
                h("span", { style: muted }, period),
                h("span", { style: muted }, `${forText}${p.allowanceSats ? `, ${amount(p.allowanceSats)} a day` : ""}`)),
            h("p", { style: { ...p0, lineHeight: 1.5 } }, p.purpose),
            open && extra.length ? h("dl", { style: { ...p0, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "var(--space-3)", rowGap: 4 } },
                extra.flatMap(([k, v]) => [h("dt", { key: `${k}t`, style: muted }, k), h("dd", { key: `${k}d`, style: p0 }, v)])) : null,
            progress,
            h("div", { style: { ...row, alignItems: "center", paddingTop: "var(--space-2)", borderTop: `1px solid ${C.line}` } },
                h("span", { style: { display: "inline-flex", gap: "var(--space-3)", alignItems: "center", ...small } },
                    h("span", { style: tnum, title: "Members who support it" }, `👍 ${support}`),
                    h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" }, title: "Keepers who approved it" },
                        h(Pips, { n: approvals, of: threshold }), h("span", { style: { ...muted, ...tnum } }, `${approvals} of ${threshold} keepers`))),
                extra.length ? h("button", { type: "button", style: { ...btn.quiet, ...small }, "aria-expanded": open, onClick: () => setOpen(!open) }, open ? "Less" : "Details") : null),
            stage === "open" ? h("span", { style: { ...muted, ...small } }, "React 👍 to support it. Keepers react ✅ to approve, or ❌ with the reason in the thread.") : null);
    }

    ctx.conversation.registerMessage({
        id: "proposal",
        title: "Hive proposal",
        // Only in the hive's own channel once known; any well-formed proposal until then.
        matches: (message) => {
            const gov = snapshot.gov;
            if (gov?.channelId && message.channelId !== gov.channelId) return false;
            return parseProposal(message.content) !== null;
        },
        component: ProposalCard,
    });

    // ---- In the hive's channel: Propose opens a form above the composer ---------------------

    // The composer tool owns insertText; the form above the composer borrows it while both are up.
    const composers = new Map();
    let proposing = null;
    const proposingListeners = new Set();
    const setProposing = (channelId) => {
        proposing = channelId;
        for (const listener of proposingListeners) listener(channelId);
    };
    function useProposing() {
        const [value, setValue] = React.useState(proposing);
        React.useEffect(() => {
            proposingListeners.add(setValue);
            setValue(proposing);
            return () => proposingListeners.delete(setValue);
        }, []);
        return value;
    }

    function ProposeTool(props) {
        useSnapshot(); // shown once the hive's channel is known
        const open = useProposing() === props.channelId;
        const here = isHiveChannel(props.channelId) && !props.threadRootId;
        React.useEffect(() => {
            if (!here) return undefined;
            const entry = { insertText: props.insertText, focus: props.focus };
            composers.set(props.channelId, entry);
            return () => { if (composers.get(props.channelId) === entry) composers.delete(props.channelId); };
        }, [here, props.channelId, props.insertText, props.focus]);
        if (!here) return null;
        // Just the hive's mark, like the composer's other tools; its name is in the label and tooltip.
        return h("button", {
            type: "button",
            title: "Propose work to the hive",
            "aria-label": "Propose work to the hive",
            "aria-pressed": open,
            disabled: props.disabled,
            style: { display: "inline-grid", placeItems: "center", width: 28, height: 28, padding: 0, border: 0, borderRadius: C.pill, cursor: "pointer",
                background: open ? C.honeyTint : "transparent" },
            onClick: () => setProposing(open ? null : props.channelId),
        }, h(Hex, { size: 16 }));
    }
    ctx.conversation.registerTool({ id: "propose", title: "Propose work to the hive", order: 50, component: ProposeTool });

    const field = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
    const input = { font: "inherit", color: "inherit", background: C.panel, border: `1px solid ${C.strong}`, borderRadius: C.chip, padding: "7px 10px", minWidth: 0, width: "100%", boxSizing: "border-box" };
    const label = { ...small, ...muted, fontWeight: 550 };
    const WHO = [["me", "Only me"], ["everyone", "Everyone"], ["named", "Named members"]];

    function ProposeForm({ channelId }) {
        const { state, gov } = useSnapshot();
        const [f, setF] = React.useState({ title: "", purpose: "", budget: "", start: "", end: "", who: "me", allowance: "", work: "", provider: "", report: "" });
        const [more, setMore] = React.useState(false);
        const [tried, setTried] = React.useState(false);
        const [failed, setFailed] = React.useState(null);
        const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
        const { text, problem } = proposalFromForm(f);
        const budget = Number(String(f.budget).replace(/[,\s_]/g, ""));
        const hours = budget > 0 ? (gov?.discussionSeconds ?? discussionSeconds(budget, gov?.smallSats ?? 20000)) / 3600 : null;
        const submit = (e) => {
            e?.preventDefault?.();
            setTried(true);
            if (!text) return;
            const c = composers.get(channelId);
            if (c?.insertText(text + (f.who === "named" ? "\n" : ""))) {
                c.focus?.();
                setProposing(null);
            } else {
                setFailed("The message box is not ready. Click into it and try again.");
            }
        };
        const control = (k, props = {}) => h(props.multiline ? "textarea" : "input", {
            id: `hive-${k}`, value: f[k], onChange: set(k), style: { ...input, ...(props.multiline ? { resize: "vertical", minHeight: 56 } : {}) },
            ...(props.multiline ? { rows: 2 } : { type: props.type ?? "text", inputMode: props.inputMode }), placeholder: props.placeholder,
        });
        const labelled = (k, text, el, flex) => h("label", { htmlFor: `hive-${k}`, style: { ...field, ...(flex ? { flex } : {}) } }, h("span", { style: label }, text), el);
        return h("form", { onSubmit: submit, style: { ...stack("var(--space-3)"), padding: "var(--space-3) var(--space-4)", margin: "0 0 var(--space-2)", background: C.panel,
            border: `1px solid ${C.line}`, borderRadius: C.radius, boxShadow: "var(--shadow-xs)" } },
            h("div", { style: { ...row, alignItems: "center" } },
                h("strong", { style: { display: "inline-flex", gap: 8, alignItems: "center" } }, h(Hex, { size: 16 }), `Propose work to ${state?.name ?? HIVE_NAME}`),
                h("button", { type: "button", style: { ...btn.quiet, ...small }, onClick: () => setProposing(null) }, "Cancel")),
            labelled("title", "Title", control("title", { placeholder: "What the work is, in a few words" })),
            labelled("purpose", "Purpose and output", control("purpose", { multiline: true, placeholder: "Why it serves the hive, what it produces and where the results go" })),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-3)" } },
                labelled("budget", unit === "bitcoin" ? "Budget in ₿" : "Budget in sats", control("budget", { inputMode: "numeric", placeholder: "20,000" }), "1 1 120px"),
                labelled("start", "Starts", control("start", { type: "date" }), "1 1 140px"),
                labelled("end", "Ends", control("end", { type: "date" }), "1 1 140px")),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "flex-end" } },
                h("div", { role: "radiogroup", "aria-label": "Who uses it", style: { ...field, flex: "2 1 260px" } },
                    h("span", { style: label }, "Who uses it"),
                    h("div", { style: { display: "inline-flex", flexWrap: "wrap", gap: 4, padding: 3, background: C.inset, borderRadius: C.pill, alignSelf: "flex-start" } },
                        WHO.map(([k, text]) => h("button", { key: k, type: "button", role: "radio", "aria-checked": f.who === k,
                            style: { border: 0, borderRadius: C.pill, padding: "4px 12px", font: "inherit", cursor: "pointer", fontSize: "0.93em",
                                background: f.who === k ? C.panel : "transparent", color: f.who === k ? C.text : C.subtle, boxShadow: f.who === k ? "var(--shadow-xs)" : "none" },
                            onClick: () => setF({ ...f, who: k }) }, text)))),
                labelled("allowance", "Daily allowance per member", control("allowance", { inputMode: "numeric", placeholder: "500" }), "1 1 150px")),
            more ? h(React.Fragment, null,
                labelled("work", "Work", control("work", { placeholder: "The model and roughly how much, for example 2 million tokens on llama-3.3-70b" })),
                labelled("provider", "Provider", control("provider", { placeholder: "A member's node, if the work needs one" })),
                labelled("report", "Report", control("report", { placeholder: "How the community sees the result" }))) : null,
            h("div", { style: { ...row, alignItems: "center" } },
                h("span", { style: { display: "inline-flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap" } },
                    h("button", { type: "submit", style: btn.primary }, "Add to message"),
                    more ? null : h("button", { type: "button", style: { ...btn.quiet, ...small }, onClick: () => setMore(true) }, "Add work, provider and report")),
                h("span", { style: { ...small, ...(tried && problem ? { color: C.bad } : muted) }, role: tried && problem ? "alert" : undefined },
                    failed ?? (tried && problem ? problem
                        : `${hours ? `Discussion runs ${hours >= 1 ? `${Math.round(hours)} hours` : `${Math.round(hours * 60)} minutes`}, then ` : ""}${gov?.threshold ?? 2} keepers' ✅ approve it.${f.who === "named" ? " Mention the members before you send." : ""}`))));
    }

    function ChannelStatus(props) {
        noteChannel(props.channelId);
        const { state, gov } = useSnapshot();
        const form = useProposing();
        if (!gov || !isHiveChannel(props.channelId) || props.threadRootId) return null;
        if (form === props.channelId) return h(ProposeForm, { channelId: props.channelId });
        const open = gov.proposals.filter((p) => p.state === "open");
        const running = gov.proposals.filter((p) => p.state === "running");
        const soonest = open.map((p) => p.discussionEnds).filter((t) => t > nowS()).sort((a, b) => a - b)[0];
        const parts = [
            state ? h("span", { key: "t", style: tnum }, h("span", { style: { color: C.text, fontWeight: 600 } }, amount(state.treasury.balanceSats)), " in the treasury") : null,
            open.length ? h("span", { key: "o" }, `${open.length} proposal${open.length === 1 ? "" : "s"} open${soonest ? `, next decision ${until(soonest)}` : ""}`) : null,
            !open.length && running.length ? h("span", { key: "r" }, `${running.length} budget${running.length === 1 ? "" : "s"} running`) : null,
            state?.funding.length ? h("span", { key: "f", style: { color: C.honeyInk } }, `${state.funding.length} job${state.funding.length === 1 ? "" : "s"} waiting for keepers`) : null,
            !open.length && !running.length && !state ? h("span", { key: "n" }, "Propose work with the button below") : null,
        ].filter(Boolean);
        return h("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap", ...muted, ...small, padding: "4px 6px 4px 12px", margin: "0 0 var(--space-2)",
            background: C.inset, borderRadius: C.pill } },
            h(Hex, { size: 13 }),
            h("span", { style: { display: "inline-flex", gap: "var(--space-3)", flexWrap: "wrap", flex: 1, minWidth: 0 } },
                parts.flatMap((part, i) => (i ? [h("span", { key: `s${i}`, "aria-hidden": true }, "·"), part] : [part]))),
            h("button", { type: "button", style: { ...btn.quiet, ...small, color: C.text, fontWeight: 550 }, onClick: () => ctx.navigation.open(pageTarget) }, `Open ${state?.name ?? HIVE_NAME}`));
    }
    ctx.conversation.registerAccessory({ id: "status", title: "Hive status", order: 50, component: ChannelStatus });

    // ---- The hive's page ------------------------------------------------------------------

    function Head({ state, loadedAt }) {
        const chip = state?.chipIn ?? {};
        return h("header", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-4)", alignItems: "flex-end", justifyContent: "space-between" } },
            h("div", { style: { display: "flex", gap: "var(--space-3)", alignItems: "center", minWidth: 0 } },
                h(Hex, { size: 40 }),
                h("div", { style: stack(2) },
                    h("h1", { style: { ...p0, lineHeight: 1.15, display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" } }, state?.name ?? HIVE_NAME,
                        state?.demo ? h(Pill, { tone: "quiet" }, "Sample data") : null),
                    h("span", { style: { ...muted, ...small } },
                        loadedAt ? `Updated ${new Date(loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ` : "",
                        h("button", { type: "button", style: { ...btn.quiet, ...small, padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }, onClick: () => load() }, "Refresh")))),
            state ? h("div", { style: { ...stack(2), alignItems: "flex-end", textAlign: "right" } },
                h("span", { style: { ...muted, ...small } }, "Treasury"),
                (() => {
                    // The number large, its unit small: "₿1,284,500", "1,284,500 sats", "0.012845 BTC", "$863.71".
                    const a = amountParts(state.treasury.balanceSats, unit, usdPerBtc);
                    const unitStyle = { fontSize: "0.5em", fontWeight: 500, ...muted };
                    return h("span", { style: { fontSize: "1.9em", fontWeight: 650, lineHeight: 1.1, letterSpacing: "-0.01em", ...tnum } },
                        a.pre ? h("span", { style: { ...unitStyle, fontSize: "0.8em", marginRight: "0.05em" } }, a.pre) : null,
                        a.num,
                        a.post ? h("span", { style: unitStyle }, a.post) : null);
                })(),
                chip.lightningAddress ? h("span", { style: { ...small, ...muted } }, "Chip in at ", h("span", { style: { color: C.text } }, chip.lightningAddress)) : null) : null);
    }

    function Treasury({ state }) {
        const chip = state.chipIn ?? {};
        return h(Card, { title: "Chip in" },
            chip.lightningAddress ? h(Well, { label: "Lightning address", value: chip.lightningAddress, copy: chip.lightningAddress }) : null,
            state.treasury.address
                ? h(Well, { label: "Treasury address", value: short(state.treasury.address, 14, 8), copy: state.treasury.address })
                : h(Empty, null, "The treasury is built from the keepers' Buzz keys once they are confirmed, and its address shows here."),
            h("p", { style: { ...p0, ...muted, ...small } },
                "Pay from any Lightning or Arkade wallet. Chip-ins are donations toward the hive's purpose, and every one lands in the treasury as Bitcoin."));
    }

    function YourPart({ state, gov }) {
        const me = viewer();
        if (!gov) return null;
        const mine = allowancesFor(gov, me);
        const node = me ? gov.members?.[me]?.node : null;
        return h(Card, { title: "Your allowances", aside: mine.length ? h("span", { style: { ...muted, ...small } }, `${mine.length} running`) : null },
            !me ? h(Empty, null, "Connect to the community to see your allowances.")
                : mine.length === 0 ? h(Empty, null, "No running proposal includes you yet. Propose work from the hive's channel, or ask to be named on one.")
                : h("ul", { style: list }, mine.map((p, i) => h("li", { key: p.id, style: { ...item, ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("div", { style: row }, h("strong", null, p.title), h("span", { style: { fontWeight: 600, ...tnum } }, `${amount(p.allowanceSats ?? 500)} a day`)),
                    h(Meter, { value: p.usedSats, total: p.budgetSats, tone: "good", label: `${amount(p.usedSats)} of ${amount(p.budgetSats)} used` }),
                    h("div", { style: { ...row, ...muted, ...small } }, h("span", { style: tnum }, `${amount(p.usedSats)} of ${amount(p.budgetSats)} used by the hive`), h("span", null, `until ${day(p.ends)}`))))),
            me ? h("div", { style: { ...small, ...muted, padding: "var(--space-2) var(--space-3)", background: C.inset, borderRadius: C.chip } },
                node
                    ? ["Your node ", h("code", { key: "n" }, short(node)), " calls the model ", h("code", { key: "m" }, "hive"), " from any OpenAI-compatible tool. You can also ask the hive's agent in the channel."]
                    : ["To spend from your own MeshLLM node, set it up as a member",
                        state.agent ? [" with ", h("code", { key: "c" }, `install-member.sh --agent ${state.agent.nodeId}`)] : null,
                        ", then post ", h("code", { key: "p" }, "Hive node: <your node id>"), " in the hive's channel. You can always ask the hive's agent instead."]) : null);
    }

    /** Before the bot coordinates, budgets are known only by what members used from them. */
    function Budgets({ state }) {
        const used = state.proposals ?? [];
        return h(Card, { title: "Budgets in use" },
            used.length === 0
                ? h(Empty, null, "No member has used a budget yet.")
                : h("ul", { style: list }, used.map((b, i) => h("li", { key: b.proposal, style: { ...item, ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("div", { style: row }, h("code", null, b.proposal), h("span", { style: { fontWeight: 600, ...tnum } }, `${amount(b.usedSats)} used`)),
                    h("span", { style: { ...muted, ...small } }, `${b.members} member${b.members === 1 ? "" : "s"}, ${b.requests} request${b.requests === 1 ? "" : "s"}, last ${when(b.lastUsedAt)}`)))),
            state.agent ? h("p", { style: { ...p0, ...muted, ...small } }, "Members set up their node with ", h("code", null, `install-member.sh --agent ${state.agent.nodeId}`), ".") : null);
    }

    function ProposalRow({ p, gov, me, first }) {
        const keeper = Boolean(me && gov.keepers.includes(me));
        const needsMe = keeper && p.state === "open" && p.discussionEnds <= nowS() && !p.approvals.includes(me);
        const right = p.state === "open" ? (p.discussionEnds > nowS() ? `closes ${until(p.discussionEnds)}` : "waiting for keepers")
            : p.state === "running" ? `until ${day(p.ends)}`
            : p.state === "approved" ? `opens ${day(p.starts)}`
            : day(p.postedAt);
        return h("li", { style: { ...item, ...(first ? { borderTop: 0, paddingTop: 0 } : {}) } },
            h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "flex-start", justifyContent: "space-between" } },
                h("strong", { style: { lineHeight: 1.35 } }, p.title),
                h(Pill, { tone: needsMe ? "honey" : STAGE_TONE[p.state] }, needsMe ? "Needs your decision" : STAGE[p.state] ?? p.state)),
            p.state === "running" ? h(Meter, { value: p.usedSats, total: p.budgetSats, tone: "good", label: `${amount(p.usedSats)} of ${amount(p.budgetSats)} used` }) : null,
            h("div", { style: { ...row, ...muted, ...small, alignItems: "center" } },
                h("span", { style: { display: "inline-flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap", ...tnum } },
                    h("span", { style: { color: C.text, fontWeight: 600 } }, p.state === "running" ? `${amount(p.usedSats)} of ${amount(p.budgetSats)}` : amount(p.budgetSats)),
                    h("span", null, `👍 ${p.support}`),
                    h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" } }, h(Pips, { n: p.approvals.length, of: gov.threshold }), `${p.approvals.length} of ${gov.threshold}`)),
                h("span", null, right)),
            p.state === "declined" && p.reason ? h("span", { style: { ...small, color: C.bad } }, p.reason) : null);
    }

    function Proposals({ state, gov, filter, title = "Proposals", empty }) {
        const me = viewer();
        if (!gov) return state ? h(Budgets, { state }) : null;
        const shown = gov.proposals.filter(filter);
        return h(Card, { title, aside: h("span", { style: { ...muted, ...small } }, `${shown.length}`) },
            shown.length === 0
                ? h(Empty, null, empty ?? "Nothing here. Propose work with the Propose button in the hive's channel.")
                : h("ul", { style: list }, shown.map((p, i) => h(ProposalRow, { key: p.id, p, gov, me, first: i === 0 }))));
    }

    // ---- Payments: checked here, approved with a message in the hive's channel -------------------

    const PAYMENT_STATUS = { queued: "Waiting its turn", approving: "Waiting for keepers", ready: "Approved, paying", submitted: "Paying", done: "Paid", lapsed: "Lapsed", declined: "Declined", failed: "Not paid" };
    const PAYMENT_TONE = { queued: "quiet", approving: "honey", ready: "good", submitted: "good", done: "good", lapsed: "quiet", declined: "bad", failed: "bad" };
    const paymentTitle = (p) => p.kind === "withdrawal"
        ? `${amount(p.amountSats)} withdrawn to ${short(p.address, 12, 6)}`
        : `${amount(p.amountSats)} for ${modelName(p.request?.model)}`;

    // What this plugin remembers on this device: the key of the hive's agent, and the approvals it
    // wrote for this keeper, for when it cannot read them back from the channel.
    const memory = new Map();
    function remembered(key, fallback) {
        try {
            const raw = globalThis.localStorage?.getItem(key);
            if (raw) return JSON.parse(raw);
        } catch { /* no storage here: what was remembered lasts until the page closes */ }
        return memory.get(key) ?? fallback;
    }
    function remember(key, value) {
        memory.set(key, value);
        try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* as above */ }
    }
    const agentSlot = (gov) => `hive.agent.${gov?.channelId ?? ""}`;
    const writtenSlot = (gov, me) => `hive.approvals.${gov?.channelId ?? ""}.${me ?? ""}`;
    /** The key this hive's agent signs receipts with: as a keeper named it in the channel, or as this plugin first saw it. */
    const agentOf = (gov) => gov?.agentKey ?? remembered(agentSlot(gov), null);
    /** This keeper's approvals of the last day: read from the channel when the plugin can, and those it wrote itself. */
    function approvedBy(gov, me) {
        const since = nowS() - 86_400;
        const c = hiveChecks();
        const sent = (channelEvents ?? []).filter((e) => e.kind === 9 && e.pubkey === me && e.created_at > since)
            .map((e) => ({ said: c.paymentWord(e.content), at: e.created_at })).filter((x) => x.said?.word === "approve")
            .map(({ said, at }) => ({ code: said.code, amountSats: said.amountSats, recipient: said.recipient, at }));
        const written = remembered(writtenSlot(gov, me), []).filter((a) => a.at > since);
        return [...sent, ...written.filter((w) => !sent.some((x) => x.code === w.code))];
    }
    /**
     * What approved proposals have left for a job: the proposals' budgets as this plugin reads them,
     * less the usage the host reports, and never more than the desk's own count when the job's turn came.
     */
    function budgetFor(gov, p) {
        if (!gov || gov.source === "none") return null;
        const own = gov.proposals.filter((x) => x.state === "approved" || x.state === "running")
            .reduce((n, x) => n + Math.max(0, x.budgetSats - (x.usedSats ?? 0)), 0);
        return Number.isFinite(p.remainingSats) ? Math.min(own, p.remainingSats) : own;
    }

    /**
     * A payment as this plugin checks it, with the hive's own code: the treasury the keepers' keys
     * build, the escrow the job's terms build or the address the withdrawal pays, the limits it must
     * stay within, and the exact approval the treasury's covenant will accept.
     */
    const checked = new Map();
    function checkOf(state, gov, p, me) {
        const approved = approvedBy(gov, me);
        const agent = agentOf(gov);
        const budgetSats = p.kind === "job" ? budgetFor(gov, p) : null;
        const key = JSON.stringify([p.id, p.left, p.validUntil, state.payments?.units, agent, budgetSats, approved.map((a) => a.code), channelEvents ? channelEvents.length : -1]);
        if (!checked.has(key)) {
            if (checked.size > 64) checked.clear();
            let result;
            try {
                result = hiveChecks().checkPayment({ payments: state.payments, payment: p, keepers: gov?.keepers ?? [], treasury: state.treasury?.address,
                    budgetSats, agent, events: channelEvents, approved });
            } catch (e) {
                result = { problems: [String(e?.message ?? e)], code: null, agentPk: null, mine: false, approve: null, decline: null };
            }
            checked.set(key, result);
        }
        return checked.get(key);
    }
    /** The payment waiting for this keeper's approval: the one whose turn it is, unless they approved it. */
    const waitingFor = (state, me) => waitingPayments(state).filter((p) => !p.approvedBy.includes(me));

    // Withdraw opens a form above the composer, as Propose does.
    let withdrawing = null;
    const withdrawingListeners = new Set();
    const setWithdrawing = (channelId) => {
        withdrawing = channelId;
        for (const listener of withdrawingListeners) listener(channelId);
    };
    function useWithdrawing() {
        const [value, setValue] = React.useState(withdrawing);
        React.useEffect(() => {
            withdrawingListeners.add(setValue);
            setValue(withdrawing);
            return () => withdrawingListeners.delete(setValue);
        }, []);
        return value;
    }
    /** Writes a keeper's message into the hive channel's message box, for them to send. */
    function compose(channelId, text) {
        const c = composers.get(channelId);
        if (!c?.insertText(text)) return false;
        c.focus?.();
        return true;
    }

    function PaymentRow({ p, state, gov, me, channelId, first }) {
        const [note, setNote] = React.useState(null);
        const [, again] = React.useState(0);
        const keeper = Boolean(me && gov?.keepers.includes(me));
        const active = p.status === "approving" || p.status === "ready";
        const threshold = gov?.threshold ?? 2;
        const c = keeper && active ? checkOf(state, gov, p, me) : null;
        const mine = p.approvedBy.includes(me) || Boolean(c?.mine);
        const agent = agentOf(gov);
        const write = (text, said) => setNote(compose(channelId, text) ? said : "The message box is not ready. Click into it and try again.");
        const approve = () => {
            // The first agent this keeper funds is the one the plugin holds later jobs to.
            if (c.agentPk && !agent) remember(agentSlot(gov), c.agentPk);
            const slot = writtenSlot(gov, me);
            remember(slot, [...remembered(slot, []).filter((a) => a.at > nowS() - 86_400 && a.code !== c.code),
                { code: c.code, amountSats: p.amountSats, recipient: p.program.slice(0, 8), at: nowS() }]);
            write(c.approve, "Your approval is in the message box. Read it and send it as it is: the treasury checks every character.");
        };
        // A hive that changed its agent node: the keeper says so here, and later jobs are held to the new one.
        const otherAgent = c?.agentPk && agent && c.agentPk !== agent && !gov?.agentKey;
        const budget = p.kind === "job" && active ? budgetFor(gov, p) : null;
        return h("li", { style: { ...item, ...(first ? { borderTop: 0, paddingTop: 0 } : {}) } },
            h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "flex-start", justifyContent: "space-between" } },
                h("strong", { style: { lineHeight: 1.35, ...tnum } }, paymentTitle(p)),
                h(Pill, { tone: PAYMENT_TONE[p.status] }, PAYMENT_STATUS[p.status] ?? p.status)),
            h("div", { style: { ...row, ...muted, ...small, alignItems: "center" } },
                h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center", ...tnum } }, h(Pips, { n: p.approvedBy.length, of: threshold }), `${p.approvedBy.length} of ${threshold} keepers`),
                h("span", null, active ? `approvals lapse ${until(p.validUntil)}` : p.status === "queued" ? "after the payment ahead of it" : p.status === "done" && p.txid ? `paid in ${short(p.txid, 8, 4)}` : stamp(p.updatedAt))),
            p.kind === "withdrawal" ? h(Well, { label: "To", value: p.address, copy: p.address }) : p.request
                ? h("span", { style: { ...muted, ...small } }, `Escrow ${short(p.address, 14, 8)} for provider ${short(p.request.providerPk)}, before ${when(p.request.deadline)}. The agent that signs its receipts is ${short(p.request.params?.agentPk, 8, 4)}. What the job does not use comes back to the treasury.`) : null,
            budget !== null ? h("span", { style: { ...muted, ...small, ...tnum } }, `Approved proposals have ${amount(budget)} left for it.`) : null,
            p.status === "queued" ? h("span", { style: { ...small, ...muted } }, p.detail ?? "One payment is approved at a time. This one gets its number, and its approval to send, when its turn comes.") : null,
            (p.status === "failed" || p.status === "lapsed" || p.status === "done") && p.detail ? h("span", { style: { ...small, ...(p.status === "failed" ? { color: C.bad } : muted) } }, p.detail) : null,
            p.status === "declined" ? h("span", { style: { ...small, ...muted } }, `Declined by ${p.declinedBy === me ? "you" : short(p.declinedBy, 8, 4)}${p.detail ? `: ${p.detail}` : ""}.`) : null,
            c && c.problems.length ? h("div", { role: "alert", style: { ...small, color: C.bad } }, "Don't approve this payment: ", c.problems.join(" ")) : null,
            otherAgent ? h("button", { type: "button", style: { ...btn.quiet, ...small, alignSelf: "flex-start" }, onClick: () => { remember(agentSlot(gov), c.agentPk); again((n) => n + 1); } },
                `The hive changed its agent: hold jobs to ${short(c.agentPk, 8, 4)} from now on`) : null,
            c && !c.problems.length && mine ? h("span", { style: { ...small, color: C.good } }, "You approved it.") : null,
            c && !c.problems.length && !mine && channelId ? h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" } },
                h("button", { type: "button", style: btn.primary, onClick: approve }, "Approve"),
                h("button", { type: "button", style: { ...btn.quiet, ...small }, onClick: () => write(c.decline, "Your decline is in the message box. Sending it stops the desk from paying it; approvals other keepers already sent stay valid until they lapse.") }, "Decline"),
                note ? h("span", { style: { ...small, ...muted } }, note) : null) : null,
            c && !c.problems.length && !mine && channelId && !note ? h("span", { style: { ...small, ...muted, overflowWrap: "anywhere" } }, "Approve writes ", h("code", null, c.approve), " for you to send.") : null,
            c && !c.problems.length && !mine && !channelId ? h("span", { style: { ...small, ...muted } },
                `${p.kind === "withdrawal" ? "Checked here: the address is on the hive's Operator, a keeper asked for it in the channel, and the approval pays exactly what it says." : "Checked here against the job's own terms, the hive's treasury and what approved proposals have left."} Approve it from the hive's channel, where the Hive line above the message box writes your approval.`) : null);
    }

    function Payments({ state, gov, title = "Payments", only }) {
        const me = viewer();
        const all = (state?.payments?.payments ?? []).filter(only ?? (() => true)).slice().reverse();
        return h(Card, { title, aside: h("span", { style: { ...muted, ...small } }, `${all.length}`) },
            !state?.payments ? h(Empty, null, "The hive's approvals desk starts once its treasury is built.")
                : all.length === 0 ? h(Empty, null, "No payment is waiting.")
                : h("ul", { style: list }, all.map((p, i) => h(PaymentRow, { key: p.id, p, state, gov, me, first: i === 0 }))));
    }

    /** Above the hive channel's message box, for a keeper: what waits for their approval, and Withdraw. */
    function KeeperBar(props) {
        const { state, gov } = useSnapshot();
        const form = useWithdrawing();
        const me = viewer();
        if (!gov || !isHiveChannel(props.channelId) || props.threadRootId || !me || !gov.keepers.includes(me) || !state?.payments) return null;
        if (form === props.channelId) return h(WithdrawForm, { channelId: props.channelId });
        const waiting = waitingFor(state, me);
        const queued = (state.payments.payments ?? []).filter((p) => p.status === "queued").length;
        return h("div", { style: { ...stack("var(--space-2)"), padding: "var(--space-2) var(--space-3)", margin: "0 0 var(--space-2)", background: C.panel,
            border: `1px solid ${waiting.length ? C.honey : C.line}`, borderRadius: C.radius } },
            h("div", { style: { ...row, alignItems: "center" } },
                h("strong", { style: { display: "inline-flex", gap: 8, alignItems: "center", ...small } }, h(Hex, { size: 13 }),
                    `${waiting.length ? "A payment waits for your approval" : "No payment waits for you"}${queued ? `; ${queued} more wait${queued === 1 ? "s its" : " their"} turn` : ""}`),
                h("button", { type: "button", style: { ...btn.quiet, ...small, color: C.text, fontWeight: 550 }, onClick: () => setWithdrawing(props.channelId) }, "Withdraw")),
            waiting.length ? h("ul", { style: list }, waiting.map((p, i) => h(PaymentRow, { key: p.id, p, state, gov, me, channelId: props.channelId, first: i === 0 }))) : null);
    }
    ctx.conversation.registerAccessory({ id: "keeper", title: "Hive payments for keepers", order: 40, component: KeeperBar });

    function WithdrawForm({ channelId }) {
        const { state } = useSnapshot();
        const [f, setF] = React.useState({ amount: "", address: "" });
        const [tried, setTried] = React.useState(false);
        const [failed, setFailed] = React.useState(null);
        const { text, problem } = hiveChecks().withdrawalRequest(f.amount, f.address, state?.payments);
        const submit = (e) => {
            e?.preventDefault?.();
            setTried(true);
            if (!text) return;
            if (compose(channelId, text)) setWithdrawing(null);
            else setFailed("The message box is not ready. Click into it and try again.");
        };
        const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
        return h("form", { onSubmit: submit, style: { ...stack("var(--space-3)"), padding: "var(--space-3) var(--space-4)", margin: "0 0 var(--space-2)", background: C.panel,
            border: `1px solid ${C.line}`, borderRadius: C.radius, boxShadow: "var(--shadow-xs)" } },
            h("div", { style: { ...row, alignItems: "center" } },
                h("strong", { style: { display: "inline-flex", gap: 8, alignItems: "center" } }, h(Hex, { size: 16 }), "Withdraw from the treasury"),
                h("button", { type: "button", style: { ...btn.quiet, ...small }, onClick: () => setWithdrawing(null) }, "Cancel")),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-3)" } },
                h("label", { htmlFor: "hive-w-amount", style: { ...field, flex: "1 1 120px" } }, h("span", { style: label }, "Amount in sats"),
                    h("input", { id: "hive-w-amount", value: f.amount, onChange: set("amount"), inputMode: "numeric", placeholder: "5,000", style: input })),
                h("label", { htmlFor: "hive-w-address", style: { ...field, flex: "3 1 260px" } }, h("span", { style: label }, "Arkade address"),
                    h("input", { id: "hive-w-address", value: f.address, onChange: set("address"), placeholder: "ark1…", autoCorrect: "off", autoCapitalize: "none", spellCheck: false, style: input }))),
            h("div", { style: { ...row, alignItems: "center" } },
                h("button", { type: "submit", style: btn.primary }, "Add to message"),
                h("span", { style: { ...small, ...(tried && problem ? { color: C.bad } : muted) }, role: tried && problem ? "alert" : undefined },
                    failed ?? (tried && problem ? problem : `Two keepers approve it like any payment; ${amount(state?.treasury?.balanceSats)} in the treasury.`))));
    }

    /** A keeper's approval, decline or withdrawal in the channel, drawn with the payment it names. */
    function PaymentMessage({ message }) {
        const { state, gov } = useSnapshot();
        const c = hiveChecks();
        const said = c.paymentWord(message.content);
        const asked = said ? null : c.withdrawalOf(message.content);
        const all = state?.payments?.payments ?? [];
        const p = said ? all.find((x) => x.code === said.code) : all.find((x) => x.id === message.id);
        const keeper = Boolean(gov?.keepers.includes(message.authorId));
        const verb = said?.word === "approve" ? "Approved" : said?.word === "decline" ? "Declined" : "Asked to withdraw";
        // A payment the desk does not list is described by the message's own words: the covenant holds the keeper to them.
        const what = p?.kind === "job" ? paymentTitle(p) : p || asked ? `${amount((p ?? asked).amountSats)} to ${short((p ?? asked).address, 12, 6)}`
            : said ? `${amount(said.amountSats)} to ${said.recipient}…` : "a Hive payment";
        const refused = asked && !p ? (state?.payments?.refused ?? []).find((r) => r.id === message.id) : null;
        return h("div", { className: "ui-card", style: { ...stack(6), padding: "var(--space-2) var(--space-3)", maxWidth: 520, boxSizing: "border-box" } },
            h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", justifyContent: "space-between" } },
                h("span", { style: { display: "inline-flex", gap: 8, alignItems: "center", minWidth: 0 } }, h(Hex, { size: 14, filled: said?.word !== "decline" }),
                    h("span", null, h("strong", null, verb), " ", h("span", { style: tnum }, what))),
                p ? h(Pill, { tone: PAYMENT_TONE[p.status] }, PAYMENT_STATUS[p.status] ?? p.status) : null),
            !keeper ? h("span", { style: { ...small, color: C.bad } }, "Only this hive's keepers approve its payments: this message counts for nothing.")
                : p ? h("span", { style: { ...small, ...muted, ...tnum } }, `${p.approvedBy.length} of ${gov?.threshold ?? 2} keepers approved`)
                : said?.word === "approve" ? h("span", { style: { ...small, color: C.bad } }, "Not the payment the hive's desk has open. If its code names a payment of this treasury, the approval still counts toward it until it lapses.")
                : said ? h("span", { style: { ...small, ...muted } }, "Not the payment the hive's desk has open.")
                : refused ? h("span", { style: { ...small, ...muted } }, `The desk did not take it up: ${refused.reason}.`) : null);
    }
    ctx.conversation.registerMessage({
        id: "payment",
        title: "Hive payment",
        matches: (message) => {
            const gov = snapshot.gov;
            if (!gov?.channelId || message.channelId !== gov.channelId) return false;
            try {
                const c = hiveChecks();
                return Boolean(c.paymentWord(message.content) || c.withdrawalOf(message.content));
            } catch { return false; }
        },
        component: PaymentMessage,
    });

    function Funding({ state }) {
        const desk = Boolean(state.payments);
        const byId = new Map((state.payments?.payments ?? []).map((p) => [p.id, p]));
        const why = new Map((state.payments?.waiting ?? []).map((w) => [w.jobId, w.reason]));
        return h(Card, { title: "Jobs to fund", aside: state.funding.length ? h(Pill, { tone: "honey" }, `${state.funding.length} waiting`) : null },
            state.funding.length === 0
                ? h(Empty, null, "No job is waiting for funding.")
                : h("ul", { style: list }, state.funding.map((j, i) => h("li", { key: j.jobId, style: { ...item, gap: "var(--space-3)", ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("div", { style: { ...row, alignItems: "center" } },
                        h("strong", { style: tnum }, `${amount(j.capSats)} for ${modelName(j.model)}`),
                        h("span", { style: { ...muted, ...small } }, `deadline ${until(j.deadline)}`)),
                    // With an approvals desk, keepers approve in the channel and the desk pays. Without one,
                    // someone sends the payment by hand.
                    desk
                        ? h("span", { style: { ...small, ...muted } }, byId.get(j.jobId)
                            ? `${byId.get(j.jobId).approvedBy.length} of ${snapshot.gov?.threshold ?? 2} keepers approved it. Keepers approve it from the hive's channel, after the plugin checks it against the escrow's own terms.`
                            : why.get(j.jobId) ? `Not yet a payment: ${why.get(j.jobId)}.` : "The desk turns it into a payment on its next round.")
                        : h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-3)" } },
                            h("div", { style: { flex: "1 1 170px" } }, h(Well, { label: "Send exactly", value: amount(j.capSats, true), copy: String(j.capSats), mono: false })),
                            h("div", { style: { flex: "3 1 260px", minWidth: 0 } }, h(Well, { label: "To escrow", value: short(j.escrowAddress, 14, 8), copy: j.escrowAddress }))),
                    desk ? null : h("p", { style: { ...p0, ...muted, ...small } },
                        `For provider ${short(j.providerPk)}. Send it in one payment from the treasury; anything else comes back after the deadline.${j.minCoinExpiry ? ` The coins you send must be valid until ${day(j.minCoinExpiry)}, so renew the wallet first if it has not renewed in a few weeks.` : ""}`)))));
    }

    function Keepers({ gov }) {
        if (!gov) return null;
        const me = viewer();
        return h(Card, { title: "Keepers", aside: h("span", { style: { ...muted, ...small } }, `${gov.threshold} of ${gov.keepers.length} approve`) },
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-2)" } },
                gov.keepers.map((k) => h("span", { key: k, style: { display: "inline-flex", gap: 8, alignItems: "center", padding: "5px 12px 5px 8px", background: C.inset, borderRadius: C.pill } },
                    h(Hex, { size: 14 }), h("code", { style: small }, short(k, 8, 4)),
                    k === me ? h("span", { style: { ...small, ...muted } }, "you") : null))),
            h("p", { style: { ...p0, ...muted, ...small } }, `Keepers approve proposals with ✅, and each payment with a message in the hive's channel that the plugin writes for them once it has checked the payment. The message says the amount and the recipient, their Buzz key signs it like any message, and the treasury checks the signature itself. Payments are approved one at a time, any ${gov.threshold} keepers together. An approval cannot be taken back once it is sent: it pays until it lapses, so send none the plugin did not write.`),
            me && gov.keepers.includes(me) ? h("p", { style: { ...p0, ...muted, ...small } }, "Your Buzz key is your share of the treasury: back it up in Settings → Identity if you haven't.") : null);
    }

    function Jobs({ state }) {
        const shown = state.jobs.slice(0, 20);
        const tone = { claimed: "good", returned: "quiet", open: "honey", awaiting_funding: "honey", declined: "bad", lapsed: "quiet" };
        return h(Card, { title: "Jobs" },
            shown.length === 0
                ? h(Empty, null, "No jobs yet.")
                : h("ul", { style: list }, shown.map((j, i) => h("li", { key: j.jobId, style: { ...item, ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("div", { style: { ...row, alignItems: "center" } }, h("strong", null, modelName(j.model)), h(Pill, { tone: tone[j.status] }, STATUS[j.status] ?? j.status)),
                    h("div", { style: { ...row, ...muted, ...small } },
                        h("span", null, `Provider ${short(j.providerPk ?? j.providerPeer)}`),
                        h("span", { style: tnum }, j.status === "claimed" ? `paid ${amount(j.paidSats)}, returned ${amount(j.returnedSats)}`
                            : j.status === "returned" ? `returned ${amount(j.returnedSats)}` : `used ${amount(j.usedSats)} of ${amount(j.capSats)}`))))));
    }

    function Providers({ state }) {
        return h(Card, { title: "Providers" },
            state.providers.length === 0
                ? h(Empty, null, "No provider has served this hive yet.")
                : h("ul", { style: list }, state.providers.map((p, i) => h("li", { key: p.providerPk ?? p.providerPeer, style: { ...item, ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("div", { style: row }, h("code", null, short(p.providerPk ?? p.providerPeer)), h("span", { style: { fontWeight: 600, ...tnum } }, `earned ${amount(p.earnedSats)}`)),
                    h("div", { style: { ...row, ...muted, ...small } }, h("span", null, p.models.map(modelName).join(", ")), h("span", null, `${p.openJobs} open, ${p.jobs} total`))))));
    }

    function Flows({ state }) {
        const recent = [
            ...state.contributions.map((c) => ({ at: c.at, sats: c.sats, in: true, text: `Chip-in over ${rail(c.rail)}`, key: `c${c.reference}${c.at}` })),
            ...state.payouts.map((p) => ({ at: p.at, sats: p.sats, in: false, text: `Paid provider ${short(p.providerPk)}`, key: `p${p.txid}` })),
        ].sort((a, b) => b.at - a.at).slice(0, 15);
        return h(Card, { title: "Chip-ins and payouts" },
            recent.length === 0
                ? h(Empty, null, "Nothing yet.")
                : h("ul", { style: list }, recent.map((r, i) => h("li", { key: r.key, style: { ...item, ...row, flexDirection: "row", alignItems: "baseline", ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("span", { style: stack(2) }, h("span", null, r.text), h("span", { style: { ...muted, ...small } }, stamp(r.at))),
                    h("span", { style: { fontWeight: 600, ...tnum, color: r.in ? C.good : C.text } }, `${r.in ? "+" : "−"}${amount(r.sats)}`)))));
    }

    const TABS = [["home", "Overview"], ["proposals", "Proposals"], ["keepers", "Keepers"], ["money", "Treasury"]];
    const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: "var(--space-4)", alignItems: "start" };

    function HivePage(props) {
        const view = useSnapshot();
        const [tab, setTab] = React.useState(TABS.some(([k]) => k === props?.initialTab) ? props.initialTab : "home");
        React.useEffect(() => { if (!snapshot.state) load(); }, []);
        const { state, gov, error, loadedAt } = view;
        const me = viewer();
        const keeper = Boolean(me && gov?.keepers.includes(me));
        const decide = keeper ? gov.proposals.filter((p) => p.state === "open" && p.discussionEnds <= nowS() && !p.approvals.includes(me)) : [];
        const waiting = keeper ? decide.length + (state?.payments ? waitingFor(state, me).length : state?.funding.length ?? 0) : 0;
        const live = (p) => ["open", "approved", "running"].includes(p.state);
        const col = (...children) => h("div", { style: stack("var(--space-4)") }, ...children);
        const needsHost = h(Card, null, h(Empty, null, error ? "The hive's host is out of reach, so the treasury and jobs are not shown." : "Loading the treasury…"));
        let body = null;
        if (state || gov) {
            body = tab === "home" ? h("div", { style: grid },
                    col(h(YourPart, { state: state ?? {}, gov }), gov || state ? h(Proposals, { state, gov, filter: live, title: "Live proposals" }) : null),
                    col(state?.funding.length ? h(Funding, { state }) : null, state ? h(Treasury, { state }) : needsHost))
                : tab === "proposals" ? col(
                    h(Proposals, { state, gov, filter: live, title: "Live proposals" }),
                    gov ? h(Proposals, { state, gov, filter: (p) => !live(p), title: "Past proposals", empty: "None yet." }) : null)
                : tab === "keepers" ? col(
                    keeper ? h(Proposals, { state, gov, filter: (p) => decide.includes(p), title: "Waiting for your decision", empty: "No proposal needs your decision." }) : null,
                    state?.payments ? h(Payments, { state, gov }) : null,
                    state ? h(Funding, { state }) : needsHost, h(Keepers, { gov }))
                : state ? h("div", { style: grid }, col(h(Flows, { state }), h(Jobs, { state })), col(h(Providers, { state })))
                : needsHost;
        }
        return h("div", { style: { padding: "var(--space-panel-inset)", ...stack("var(--space-5, 20px)"), width: "100%", maxWidth: 1080, boxSizing: "border-box" } },
            h(Head, { state, loadedAt }),
            h("div", { role: "tablist", style: { display: "inline-flex", flexWrap: "wrap", gap: 4, padding: 3, background: C.inset, borderRadius: C.pill, alignSelf: "flex-start" } },
                TABS.map(([k, text]) => h("button", { key: k, type: "button", role: "tab", "aria-selected": tab === k,
                    style: { border: 0, borderRadius: C.pill, padding: "5px 14px", font: "inherit", cursor: "pointer", display: "inline-flex", gap: 6, alignItems: "center",
                        background: tab === k ? C.panel : "transparent", color: tab === k ? C.text : C.subtle, fontWeight: tab === k ? 600 : 500, boxShadow: tab === k ? "var(--shadow-xs)" : "none" },
                    onClick: () => setTab(k) }, text,
                    k === "keepers" && waiting ? h("span", { style: { ...TONE.honey, borderRadius: C.pill, padding: "0 7px", fontSize: "0.8em", fontWeight: 600, ...tnum } }, `${waiting}`) : null))),
            error ? h("p", { role: "alert", style: { ...p0, color: C.bad } }, `Could not reach the hive: ${error}`) : null,
            !state && !gov ? h("p", { style: muted }, error ? "" : "Loading the hive…") : body);
    }

    // The hive's mark beside the page in Buzz's navigation: Buzz's amber, the same in both themes.
    const MARK = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 1.8 21 7v10l-9 5.2L3 17V7z" fill="#FFC53D"/></svg>')}`;
    ctx.pages.register({ id: "main", title: HIVE_NAME, primary: true, icon: MARK, component: HivePage });

    // ---- Settings: the unit amounts read in ---------------------------------------------------

    /** Shows every amount in another unit, at once and from then on, in this app. */
    function setUnit(next) {
        unit = next;
        saveUnit(next);
        for (const listener of listeners) listener({ ...snapshot });
    }

    function AmountSettings() {
        const { state } = useSnapshot();
        const price = state?.price?.usdPerBtc > 0 ? state.price : null;
        return h("div", { style: stack("var(--space-4)") },
            h("div", { style: stack(2) },
                h("h2", { style: { ...p0, fontSize: "1.15em" } }, "Amounts"),
                h("p", { style: { ...p0, ...muted } },
                    "How the Hive plugin shows amounts on this device. Proposals and the bot's messages in the channel keep sats, which every Buzz client reads.")),
            h("div", { role: "radiogroup", "aria-label": "Show amounts in", style: stack(2) },
                UNITS.map((u) => {
                    const on = unit === u.id;
                    return h("label", { key: u.id, style: { display: "flex", gap: "var(--space-3)", alignItems: "flex-start", padding: "10px 12px", cursor: "pointer",
                        borderRadius: C.chip, border: `1px solid ${on ? C.honey : C.line}`, background: on ? C.honeyTint : "transparent" } },
                        h("input", { type: "radio", name: "hive-unit", value: u.id, checked: on, onChange: () => setUnit(u.id), style: { marginTop: 3 } }),
                        h("span", { style: stack(1) },
                            h("span", null, h("strong", null, u.label), h("span", { style: { ...muted, ...tnum } }, `  ${u.sample}`)),
                            h("span", { style: { ...muted, ...small } }, u.note)));
                })),
            unit === "usd"
                ? h("p", { style: { ...p0, ...muted, ...small } }, price
                    ? `1 BTC = $${nf.format(Math.round(price.usdPerBtc))}, from ${price.source ?? "the hive's host"}${price.at ? ` at ${stamp(price.at)}` : ""}. Amounts to send stay in ₿, to the sat.`
                    : "The hive's host has not sent a Bitcoin price yet, so amounts show in ₿ until it does.")
                : null);
    }

    ctx.settingsCards.register({ id: "amounts", title: HIVE_NAME, group: "Plugins", component: AmountSettings });
}
