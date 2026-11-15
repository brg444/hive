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
export function yesVotes(events, eventId, { exclude = [], until = Infinity } = {}) {
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

export const EMPTY = Object.freeze({ v: 1, posts: {}, keepers: null, treasuryReady: false, done: false });

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
export function onboardingPlan(record, cfg) {
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
export function recordFromChannel(events, bot, threshold) {
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
