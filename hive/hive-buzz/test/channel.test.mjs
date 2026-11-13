// The channel as members' plugins forward it to a hive's host: only what the channel itself would
// show counts. A deletion only removes its author's own event, an event dated ahead of the clock is
// refused, one author cannot crowd the store, and a member's node counts once HiveBot vouched for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { governanceFrom, MAX_PER_AUTHOR, mergeEvents } from "../api/src/channel.mjs";
import { formatProposal } from "../shared/proposal.mjs";

const channel = "1a2b3c4d-0000-4000-8000-0000000000cc";
const now = Math.floor(Date.now() / 1000);
const pub = (k) => bytesToHex(schnorr.getPublicKey(k));
const sign = (key, kind, content, at, tags = []) => {
    const e = { pubkey: pub(key), created_at: at, kind, tags: [["h", channel], ...tags], content };
    e.id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
    e.sig = bytesToHex(schnorr.sign(e.id, key));
    return e;
};
const [bot, k0, k1, k2, member, stranger] = [1, 2, 3, 4, 5, 6].map(() => schnorr.utils.randomPrivateKey());
const proposal = sign(member, 9, formatProposal({ title: "Docs", budgetSats: 10000, start: null, end: null, who: "everyone", allowanceSats: 500,
    purpose: "Docs.", work: "", provider: "", report: "" }), now - 7200);
const base = [
    sign(bot, 9, "Keepers are set.", now - 9000, [["hive", "plugin"], ...[k0, k1, k2].map((k) => ["p", pub(k)])]),
    proposal,
    sign(k0, 7, "✅", now - 3600, [["e", proposal.id]]),
    sign(k1, 7, "✅", now - 3500, [["e", proposal.id]]),
];
const cfg = { channelId: channel, bot: pub(bot), threshold: 2, smallSats: 20000, discussionSeconds: 600, now };

test("a stranger's deletion removes nothing but their own events", () => {
    const { events } = mergeEvents([], [...base, sign(stranger, 5, "", now - 60, [["e", proposal.id]])], channel, now);
    const { governance } = governanceFrom(events, cfg);
    assert.equal(governance.proposals[0].state, "running");
    const own = mergeEvents(events, [sign(member, 5, "", now - 30, [["e", proposal.id]])], channel, now).events;
    assert.equal(governanceFrom(own, cfg).governance.proposals.length, 0, "its author can withdraw it");
});

test("a member's node counts only once HiveBot acknowledged it, which a stranger cannot get", () => {
    const strangerNode = sign(stranger, 9, `Hive node: ${"aa".repeat(32)}`, now - 50);
    const memberNode = sign(member, 9, `Hive node: ${"bb".repeat(32)}`, now - 40);
    let { events } = mergeEvents([], [...base, strangerNode, memberNode], channel, now);
    assert.deepEqual(governanceFrom(events, cfg).members.members, {});
    events = mergeEvents(events, [sign(bot, 9, "Got it.", now - 30, [["e", memberNode.id], ["hive", "node-ack", memberNode.id]])], channel, now).events;
    assert.deepEqual(Object.keys(governanceFrom(events, cfg).members.members), ["bb".repeat(32)]);
});

test("events dated ahead of the clock are refused, and one author keeps only a share of the store", () => {
    const ahead = sign(stranger, 7, "👍", now + 3600, [["e", proposal.id]]);
    assert.equal(mergeEvents([], [ahead], channel, now).refused, 1);
    const flood = Array.from({ length: MAX_PER_AUTHOR + 50 }, (_, i) => sign(stranger, 7, "👍", now - i, [["e", proposal.id]]));
    const { events } = mergeEvents(base, flood, channel, now);
    assert.equal(events.filter((e) => e.pubkey === pub(stranger)).length, MAX_PER_AUTHOR);
    assert.equal(governanceFrom(events, cfg).governance.proposals[0].state, "running", "the real channel is untouched");
});
