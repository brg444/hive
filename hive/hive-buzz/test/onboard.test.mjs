// Setting a hive up in its channel: keepers volunteer with ✅, the founder confirms, and the bot
// walks the community through the plugin, the treasury and the first proposal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY, onboardingPlan, yesVotes } from "../bot/onboard.mjs";
import { formatProposal } from "../shared/proposal.mjs";

const BOT = "b0".repeat(32), FOUNDER = "f0".repeat(32), A = "a1".repeat(32), B = "b2".repeat(32), C = "c3".repeat(32);
const T0 = 1_800_000_000;
let n = 0;
const id = () => (++n).toString(16).padStart(64, "0");
const react = (pubkey, on, emoji, at) => ({ id: id(), kind: 7, pubkey, content: emoji, created_at: at, tags: [["h", "chan"], ["e", on]] });
const names = { [FOUNDER]: "Maya", [A]: "Ari", [B]: "Bo", [C]: "Cy" };
const cfg = (events, extra = {}) => ({ events, bot: BOT, founder: FOUNDER, needed: 2, threshold: 2, name: (k) => names[k], ...extra });

/** Run a plan and record each post under an event ID, as the bot does once the relay accepts it. */
function step(record, c) {
    const { posts, record: next } = onboardingPlan(record, c);
    const ids = Object.fromEntries(posts.map((p) => [p.key, `${p.key}-id`]));
    return { posts, record: { ...next, posts: { ...next.posts, ...ids } } };
}

test("keepers volunteer with ✅, the founder confirms, and the plugin follows with the keepers built in", () => {
    let { posts, record } = step(EMPTY, cfg([]));
    assert.deepEqual(posts.map((p) => p.key), ["call"]);
    assert.match(posts[0].text, /react ✅ to this message\. It needs 2\./);

    // One volunteer, the bot's own reaction, and a removed one: not enough yet.
    const undo = react(B, "call-id", "✅", T0 + 5);
    const events = [react(A, "call-id", "✅", T0), react(BOT, "call-id", "✅", T0 + 1), undo, { id: id(), kind: 5, pubkey: B, content: "", created_at: T0 + 6, tags: [["e", undo.id]] }];
    ({ posts, record } = step(record, cfg(events)));
    assert.deepEqual(posts, []);

    events.push(react(C, "call-id", "👍", T0 + 7), react(C, "call-id", "✅", T0 + 8));
    ({ posts, record } = step(record, cfg(events)));
    assert.deepEqual(posts.map((p) => p.key), ["confirm"]);
    assert.equal(posts[0].text, "2 keepers so far: @Ari and @Cy. @Maya, react ✅ here to confirm them. If someone is missing, have them react ✅ above first.");
    assert.deepEqual(posts[0].mentions, [A, C, FOUNDER]);

    // Someone else's ✅ on the confirmation does not count; a late volunteer before the founder's does.
    events.push(react(A, "confirm-id", "✅", T0 + 10), react(B, "call-id", "✅", T0 + 11));
    ({ posts, record } = step(record, cfg(events)));
    assert.deepEqual(posts, [], "waits for the founder");
    events.push(react(FOUNDER, "confirm-id", "✅", T0 + 12), react(FOUNDER, "call-id", "✅", T0 + 13));
    ({ posts, record } = step(record, cfg(events)));
    assert.deepEqual(record.keepers, [A, C, B], "keepers who volunteered before the founder confirmed, in order");
    assert.deepEqual(posts.map((p) => p.key), ["plugin", "treasury", "propose"]);
    assert.ok(posts[0].plugin);
    assert.match(posts[0].text, /^Keepers are set: @Ari, @Cy and @Bo\. Any 2 of them approve\./);
    assert.match(posts[1].text, /I'll post its address here once it's ready/);
    assert.match(posts[2].text, /\nProposal: What the work is, in a few words\nBudget: 20,000 sats\n/);
    assert.match(posts[2].text, /Discussion runs 48 hours, or 24 under 20,000 sats, and then 2 keepers' ✅ approve it\.$/);
});

test("the treasury is announced once the host has one, and the first proposal closes the setup", () => {
    let record = { ...EMPTY, keepers: [A, C], threshold: 2, posts: { call: "call-id", confirm: "confirm-id", plugin: "plugin-id", treasury: "t-id", propose: "p-id" } };
    let r = step(record, cfg([], { state: { demo: true, treasury: { address: "ark1qdemo" } } }));
    assert.deepEqual(r.posts, [], "sample data is not a treasury");
    r = step(record, cfg([], { state: { treasury: { address: "ark1qreal" }, chipIn: { lightningAddress: "hive@example.org" } } }));
    assert.deepEqual(r.posts.map((p) => p.key), ["treasury-ready"]);
    assert.equal(r.posts[0].text, "The treasury is ready. Chip in at hive@example.org, or send to ark1qreal from any Lightning or Arkade wallet. Every chip-in lands in the treasury as Bitcoin.");
    record = r.record;
    assert.deepEqual(step(record, cfg([], { state: { treasury: { address: "ark1qreal" } } })).posts, [], "said once");

    r = step(record, cfg([], { proposals: [{ title: "Later", postedAt: T0 + 50 }, { title: "Weekly summaries", postedAt: T0 }] }));
    assert.deepEqual(r.posts.map((p) => p.key), ["done"]);
    assert.match(r.posts[0].text, /^The first proposal is in: “Weekly summaries”\. That's the setup done\./);
    assert.ok(r.record.done);
    assert.deepEqual(step(r.record, cfg([], { proposals: [{ title: "x", postedAt: 1 }] })).posts, [], "nothing after the setup is done");
});

test("the proposal example in the bot's own message is not itself a proposal", async () => {
    const { parseProposal } = await import("../shared/proposal.mjs");
    const { posts } = onboardingPlan({ ...EMPTY, keepers: [A, C], threshold: 2, posts: { call: 1, confirm: 1, plugin: 1, treasury: 1 } }, cfg([]));
    const text = posts.find((p) => p.key === "propose").text;
    assert.equal(parseProposal(text), null);
    assert.ok(parseProposal(formatProposal({ title: "x", budgetSats: 1, start: null, end: null, who: "me", purpose: "y" })));
    assert.deepEqual(yesVotes([react(A, "m", "✔️", 1)], "m"), [A], "other check marks count too");
});
