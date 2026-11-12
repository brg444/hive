// Proposals as Buzz messages, and the coordinator that reads them with their reactions and replies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatProposal, parseNodeClaim, parseProposal } from "../shared/proposal.mjs";
import { coordinate, membersFile, proposalId } from "../bot/coordinator.mjs";
import { plan } from "../bot/announce.mjs";

const K = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
const ALICE = "1".repeat(64), BOB = "2".repeat(64), CAROL = "3".repeat(64);
const T0 = Date.UTC(2026, 10, 12) / 1000;
let seq = 0;
const id = () => (++seq).toString(16).padStart(64, "0");
const msg = (pubkey, content, at, extra = {}) => ({ id: id(), kind: 9, pubkey, content, created_at: at, tags: [["h", "chan"], ...(extra.tags ?? [])] });
const react = (pubkey, on, emoji, at) => ({ id: id(), kind: 7, pubkey, content: emoji, created_at: at, tags: [["e", on.id]] });
const reply = (pubkey, on, content, at) => msg(pubkey, content, at, { tags: [["e", on.id, "", "root"]] });

const sample = {
    title: "Translate the Buzz docs into Spanish and Portuguese",
    budgetSats: 30000, start: Date.UTC(2026, 10, 15) / 1000, end: Date.UTC(2026, 11, 10) / 1000 + 86399,
    who: "everyone", allowanceSats: 2000, purpose: "Docs exist only in English.", work: "llama-3.3-70b", provider: "", report: "A link to the pull request.",
};

test("a proposal round-trips through its message text, and other messages are not proposals", () => {
    const text = formatProposal(sample);
    assert.match(text, /^Proposal: Translate the Buzz docs/);
    assert.match(text, /Budget: 30,000 sats from 2026-11-15 to 2026-12-10/);
    const p = parseProposal(text);
    assert.equal(p.title, sample.title);
    assert.equal(p.budgetSats, 30000);
    assert.equal(p.start, sample.start);
    assert.equal(p.end, sample.end);
    assert.equal(p.days, 26);
    assert.equal(p.who, "everyone");
    assert.equal(p.allowanceSats, 2000);
    assert.equal(p.report, sample.report);
    assert.equal(parseProposal("I have a proposal: let's meet"), null);
    assert.equal(parseProposal("Proposal: no budget\nPurpose: x"), null);
    assert.equal(parseProposal("Proposal: x\nBudget: lots\nPurpose: y"), null);
    assert.equal(parseNodeClaim(`Hive node: ${"ab".repeat(32)}`), "ab".repeat(32));
    assert.equal(parseNodeClaim("Hive node: tooshort"), null);
});

test("keepers' ✅ approve a proposal once discussion closes, and its budget runs through its period", () => {
    seq = 0;
    const p = msg(ALICE, formatProposal(sample), T0);
    const events = [
        p,
        react(BOB, p, "👍", T0 + 60), react(CAROL, p, "👍", T0 + 70), react(ALICE, p, "👍", T0 + 80), // the proposer's own does not count
        react(BOB, p, "✅", T0 + 90), // not a keeper
        react(K[0], p, "✅", T0 + 3600),
        reply(CAROL, p, "Which languages first?", T0 + 4000),
        msg(BOB, `Hive node: ${"cd".repeat(32)}`, T0 + 100),
    ];
    const cfg = { keepers: K, threshold: 2, smallSats: 20000 };
    let r = coordinate(events, { ...cfg, now: T0 + 7200 });
    assert.equal(r.proposals[0].id, proposalId(p.id));
    assert.equal(r.proposals[0].state, "open");
    assert.equal(r.proposals[0].support, 2);
    assert.equal(r.proposals[0].replies, 1);
    assert.deepEqual(r.proposals[0].approvals, [K[0]]);

    events.push(react(K[1], p, "✅", T0 + 7300));
    r = coordinate(events, { ...cfg, now: T0 + 8000 });
    assert.equal(r.proposals[0].state, "open", "two approvals, but discussion runs 48 hours for 30,000 sats");
    r = coordinate(events, { ...cfg, now: T0 + 2 * 86400 + 10 });
    assert.equal(r.proposals[0].state, "approved", "approved, waiting for its start date");
    assert.equal(r.proposals[0].approvedAt, T0 + 2 * 86400);
    r = coordinate(events, { ...cfg, now: sample.start + 10 });
    assert.equal(r.proposals[0].state, "running");
    const file = membersFile(r);
    assert.deepEqual(file.members["cd".repeat(32)], { name: BOB.slice(0, 12), proposal: proposalId(p.id), allowance_sats_per_day: 2000 });
    assert.equal(Object.keys(file.members).length, 1, "only members who named their node");

    r = coordinate(events, { ...cfg, now: sample.end + 10 });
    assert.equal(r.proposals[0].state, "lapsed");
    events.push(reply(ALICE, p, "Report: merged in docs#41.", sample.end + 20));
    r = coordinate(events, { ...cfg, now: sample.end + 30 });
    assert.equal(r.proposals[0].state, "completed");
    assert.equal(r.proposals[0].report.text, "merged in docs#41.");
});

test("a keeper's ❌ declines with the reason they reply, a withdrawn proposal stops, and a removed reaction no longer counts", () => {
    seq = 0;
    const small = { ...sample, budgetSats: 12000, start: null, end: null, title: "Nightly triage" };
    const a = msg(ALICE, formatProposal(small), T0);
    const b = msg(BOB, formatProposal({ ...small, title: "Avatars" }), T0 + 1);
    const c = msg(CAROL, formatProposal({ ...small, title: "Summaries" }), T0 + 2);
    const undo = react(K[1], c, "✅", T0 + 50);
    const events = [a, b, c,
        react(K[2], b, "❌", T0 + 30), reply(K[2], b, "Declined: image generation is outside the hive's purpose.", T0 + 31),
        reply(ALICE, a, "Withdrawn, I found another way.", T0 + 40),
        react(K[0], c, "✅", T0 + 45), undo, { id: id(), kind: 5, pubkey: K[1], content: "", created_at: T0 + 60, tags: [["e", undo.id]] },
    ];
    const r = coordinate(events, { keepers: K, threshold: 2, smallSats: 20000, now: T0 + 86400 + 10 });
    const by = Object.fromEntries(r.proposals.map((p) => [p.title, p]));
    assert.equal(by["Avatars"].state, "declined");
    assert.equal(by["Avatars"].reason, "image generation is outside the hive's purpose.");
    assert.equal(by["Nightly triage"].state, "withdrawn");
    assert.equal(by["Summaries"].state, "open", "one approval left after the other was removed");
});

test("the bot announces approvals and declines once, from the governance state", () => {
    const state = { name: "Test Hive", treasury: { balanceSats: 1 }, jobs: [], contributions: [], proposals: [], governance: { proposals: [
        { id: "p-1", title: "Docs", budgetSats: 30000, state: "running", approvedAt: T0, starts: T0, approvals: K.slice(0, 2), usedSats: 100 },
        { id: "p-2", title: "Avatars", budgetSats: 15000, state: "declined", reason: "Outside the hive's purpose", approvals: [] },
    ] } };
    const first = plan(state, { v: 1, said: [], month: "2026-11", budgetsAtMonthStart: {}, low: false }, { now: T0 });
    assert.deepEqual(first.posts.map((p) => p.key), ["approved:p-1", "declined:p-2"]);
    assert.match(first.posts[0].text, /^Approved: “Docs”, 30,000 sats\. 2 keepers approved it/);
    assert.equal(first.posts[1].text, "Declined: “Avatars”. Outside the hive's purpose.");
});
