// The hive's channel, as members' Buzz apps forward it to the hive's host. The host has no Buzz key of
// its own (a hosted community admits only its members' apps), so the Hive plugin in each member's app
// sends the channel's signed events here, and the host keeps those whose signatures hold. A forwarded
// event cannot be forged, only left out, and every member's app forwards the same channel, so one
// open app is enough.
//
// Anyone can sign an event that names the channel, though, and the host cannot see who is in it. So
// the events the hive itself stands behind keep their place whatever else arrives: those of its bot
// and keepers, and of everyone one of them has mentioned, answered or acknowledged. The rest share a
// smaller space of their own, and a flood of them pushes out only each other.
//
// From the events the host works out where proposals stand, which keepers posted which treasury key,
// and the agent's members file, exactly as the hive's bot would from the relay.
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { coordinate, membersFile } from "../../bot/coordinator.mjs";
import { recordFromChannel } from "../../bot/onboard.mjs";

const KINDS = new Set([5, 7, 9]);
const HEX64 = /^[0-9a-f]{64}$/;
/** At most this many events are kept per channel; the oldest go first. */
export const MAX_EVENTS = 20_000;
/** At most this many from one author, so one key cannot crowd the channel out. */
export const MAX_PER_AUTHOR = 1_000;
/** Authors the hive has not answered keep this many each, and this many between them all. */
export const MAX_PER_UNVOUCHED_AUTHOR = 200;
export const MAX_UNVOUCHED = 4_000;
/** At most this many in one forward; a plugin sends only what is new. */
export const MAX_PER_REQUEST = 3_000;
/** A server checks this many signatures before it lets other requests in. */
const VERIFY_SLICE = 25;
/** How far ahead of this clock an event may be dated. */
const SKEW_SECONDS = 600;

/** NIP-01: the id is the hash of the serialized event, and the signature is the author's over it. */
export function verifyEvent(e) {
    try {
        if (!e || typeof e !== "object" || !HEX64.test(e.id) || !HEX64.test(e.pubkey) || !/^[0-9a-f]{128}$/.test(e.sig)) return false;
        if (!Number.isSafeInteger(e.created_at) || !Number.isSafeInteger(e.kind) || typeof e.content !== "string" || !Array.isArray(e.tags)) return false;
        if (!e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))) return false;
        const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
        return id === e.id && schnorr.verify(hexToBytes(e.sig), hexToBytes(id), hexToBytes(e.pubkey));
    } catch {
        return false;
    }
}

const inChannel = (e, channelId) => (e.tags ?? []).some((t) => t[0] === "h" && t[1] === channelId);
const plain = ({ id, pubkey, created_at, kind, tags, content, sig }) => ({ id, pubkey, created_at, kind, tags, content, sig });

/**
 * How far the hive stands behind each author: 2 for its bot and keepers, 1 for everyone one of them
 * has mentioned, answered, reacted to or acknowledged. Authors missing from the map are strangers to it.
 *
 * trust: { bot?, keepers? }: the keepers as the host names them, or as the bot's setup recorded them.
 */
export function vouchedAuthors(events, { bot, keepers } = {}) {
    const named = keepers?.length ? keepers : bot ? recordFromChannel(events, bot).keepers ?? [] : [];
    const rank = new Map([...(bot ? [bot] : []), ...named].map((k) => [k, 2]));
    const author = new Map(events.map((e) => [e.id, e.pubkey]));
    const vouch = (key) => { if (key && !rank.has(key)) rank.set(key, 1); };
    for (const e of events) {
        if (rank.get(e.pubkey) !== 2 || e.kind === 5) continue;
        for (const t of e.tags ?? []) {
            if (t[0] === "p" && HEX64.test(t[1] ?? "")) vouch(t[1]);
            if (t[0] === "e") vouch(author.get(t[1]));
            if (t[0] === "hive" && /-ack$/.test(t[1] ?? "")) vouch(author.get(t[2]));
        }
    }
    return rank;
}

/**
 * Adds forwarded events to what the host already has, keeping only the channel's proposals, replies,
 * reactions and deletions whose signatures hold. Returns the merged events and what was added.
 *
 * trust: { bot?, keepers? } on a host, where events may come from outside the channel: the authors
 * the hive stands behind then keep their place ahead of everyone else's. Without it every author
 * counts the same, as for a bot that reads the channel from its relay.
 */
export function mergeEvents(known, incoming, channelId, now = Math.floor(Date.now() / 1000), trust = null, verify = verifyEvent) {
    const byId = new Map(known.map((e) => [e.id, e]));
    let added = 0;
    let refused = 0;
    const list = Array.isArray(incoming) ? incoming : [];
    if (list.length > MAX_PER_REQUEST) throw Object.assign(new Error(`at most ${MAX_PER_REQUEST} events at once`), { status: 413 });
    for (const e of list) {
        if (!e || byId.has(e.id)) continue;
        // Dated ahead of the clock, it could outlive the real channel in the store: refused.
        if (!acceptable(e, channelId, now) || !verify(e)) { refused += 1; continue; }
        byId.set(e.id, plain(e));
        added += 1;
    }
    // Each author keeps their newest events, up to a share: a smaller one for authors the hive has
    // not answered, who also share one space between them.
    const newestFirst = [...byId.values()].sort((a, b) => b.created_at - a.created_at);
    const rank = trust ? vouchedAuthors(newestFirst, trust) : null;
    const stranger = (e) => Boolean(rank) && !rank.has(e.pubkey);
    const byAuthor = new Map();
    let strangers = 0;
    for (const e of newestFirst) {
        const n = byAuthor.get(e.pubkey) ?? 0;
        const outside = stranger(e);
        if (n >= (outside ? MAX_PER_UNVOUCHED_AUTHOR : MAX_PER_AUTHOR) || (outside && strangers >= MAX_UNVOUCHED)) { byId.delete(e.id); continue; }
        byAuthor.set(e.pubkey, n + 1);
        if (outside) strangers += 1;
    }
    // Then the channel as a whole: strangers' oldest leave first, the bot's and keepers' last.
    let events = [...byId.values()];
    if (events.length > MAX_EVENTS) {
        const standing = (e) => rank?.get(e.pubkey) ?? 0;
        events = events.sort((a, b) => standing(b) - standing(a) || b.created_at - a.created_at).slice(0, MAX_EVENTS);
    }
    events.sort((a, b) => a.created_at - b.created_at);
    return { events, added, refused };
}

const acceptable = (e, channelId, now) => KINDS.has(e.kind) && inChannel(e, channelId) && e.created_at <= now + SKEW_SECONDS;

/**
 * mergeEvents for a server: signatures are checked a few at a time, with other requests let in
 * between, so one large forward does not hold everyone else up while it is verified.
 */
export async function mergeForwarded(known, incoming, channelId, trust = null, now = Math.floor(Date.now() / 1000)) {
    const list = Array.isArray(incoming) ? incoming : [];
    if (list.length > MAX_PER_REQUEST) throw Object.assign(new Error(`at most ${MAX_PER_REQUEST} events at once`), { status: 413 });
    const have = new Set(known.map((e) => e.id));
    const checked = new Map();
    let n = 0;
    for (const e of list) {
        if (!e || typeof e !== "object" || have.has(e.id) || checked.has(e.id) || !acceptable(e, channelId, now)) continue;
        checked.set(e.id, verifyEvent(e) ? e : null);
        n += 1;
        if (n % VERIFY_SLICE === 0) await new Promise((next) => setImmediate(next));
    }
    // The id is the hash of everything signed, so an event checked under its id is the one merged.
    return mergeEvents(known, list, channelId, now, trust, (e) => checked.get(e.id) === e);
}

/**
 * Where the hive stands, from its channel: the keepers (named by the host, or as the hive's bot
 * recorded them during setup), the proposals, each keeper's treasury key, and the agent's members file.
 *
 * cfg: { channelId, keepers?, bot?, threshold, smallSats, discussionSeconds?, model?, now }
 * usage: { [proposalId]: usedSats }, from the agent's log.
 */
export function governanceFrom(events, cfg, usage = {}) {
    const now = cfg.now ?? Math.floor(Date.now() / 1000);
    const keepers = cfg.keepers?.length ? cfg.keepers : cfg.bot ? recordFromChannel(events, cfg.bot, cfg.threshold).keepers ?? [] : [];
    const result = coordinate(events, {
        keepers, threshold: cfg.threshold, smallSats: cfg.smallSats, now, usage,
        // Forwarded events may come from outside the channel: a member's node counts once HiveBot
        // acknowledged it or, on a host that names its keepers itself, once a keeper reacted ✅ to it.
        forwarded: true,
        ...(cfg.bot ? { bot: cfg.bot } : {}),
        ...(cfg.discussionSeconds !== undefined ? { discussionSeconds: cfg.discussionSeconds } : {}),
    });
    const governance = {
        v: 1, channelId: cfg.channelId, keepers, threshold: cfg.threshold, smallSats: cfg.smallSats, updatedAt: now,
        ...(cfg.discussionSeconds !== undefined ? { discussionSeconds: cfg.discussionSeconds } : {}),
        proposals: result.proposals,
        members: Object.fromEntries(Object.entries(result.nodes).map(([k, v]) => [k, { node: v.node }])),
        // Each keeper's treasury key, in the order the keepers were confirmed: the order the treasury is built in.
        keeperKeys: keepers.map((k) => result.keys[k]?.key ?? null),
        // The community's own agent node, when a keeper named one; the service's own otherwise.
        agentKey: result.agent?.key ?? null,
    };
    return { governance, members: membersFile(result, cfg.model ? { model: cfg.model } : {}) };
}
