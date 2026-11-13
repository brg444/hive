// The hive's channel, as members' Buzz apps forward it to the hive's host. The host has no Buzz key of
// its own (a hosted community admits only its members' apps), so the Hive plugin in each member's app
// sends the channel's signed events here, and the host keeps those whose signatures hold. A forwarded
// event cannot be forged, only left out, and every member's app forwards the same channel, so one
// open app is enough.
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
 * Adds forwarded events to what the host already has, keeping only the channel's proposals, replies,
 * reactions and deletions whose signatures hold. Returns the merged events and what was added.
 */
export function mergeEvents(known, incoming, channelId) {
    const byId = new Map(known.map((e) => [e.id, e]));
    let added = 0;
    let refused = 0;
    for (const e of Array.isArray(incoming) ? incoming : []) {
        if (!e || byId.has(e.id)) continue;
        if (!KINDS.has(e.kind) || !inChannel(e, channelId) || !verifyEvent(e)) { refused += 1; continue; }
        byId.set(e.id, plain(e));
        added += 1;
    }
    const events = [...byId.values()].sort((a, b) => a.created_at - b.created_at).slice(-MAX_EVENTS);
    return { events, added, refused };
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
        ...(cfg.discussionSeconds !== undefined ? { discussionSeconds: cfg.discussionSeconds } : {}),
    });
    const governance = {
        v: 1, channelId: cfg.channelId, keepers, threshold: cfg.threshold, smallSats: cfg.smallSats, updatedAt: now,
        ...(cfg.discussionSeconds !== undefined ? { discussionSeconds: cfg.discussionSeconds } : {}),
        proposals: result.proposals,
        members: Object.fromEntries(Object.entries(result.nodes).map(([k, v]) => [k, { node: v.node }])),
        // Each keeper's treasury key, in the order the keepers were confirmed: the order the treasury is built in.
        keeperKeys: keepers.map((k) => result.keys[k]?.key ?? null),
    };
    return { governance, members: membersFile(result, cfg.model ? { model: cfg.model } : {}) };
}
