// The bot's decisions, from real agent logs through hive-api's state functions to the messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hiveState, jobsFromLog, proposalsFromLog } from "../api/src/state.mjs";
import { markSaid, plan } from "../bot/announce.mjs";
import { checkAuthTag, loadOrCreateKey, signAuthTag } from "../bot/identity.mjs";

const log = (name) => readFileSync(new URL(`./fixtures/${name}-agent.jsonl`, import.meta.url), "utf8");
const state = (text, extra = {}) => hiveState({
    name: "Test Hive", chipIn: {}, treasury: { balanceSats: 50_000 }, jobs: jobsFromLog(text, extra.now),
    contributions: extra.contributions ?? [], proposals: proposalsFromLog(text), now: extra.now,
});

/** Accept every post, as a relay would. */
function deliver(p) {
    let record = p.record;
    for (const post of p.posts) record = markSaid(record, post, p.newBudgets);
    return record;
}

test("first run stays quiet about the past and says nothing twice", () => {
    const s = state(log("mainnet"));
    const first = plan(s, null, { now: 1794500000 });
    assert.equal(first.posts.length, 0, "a paid job from before the bot is not announced");
    const again = plan(s, deliver(first), { now: 1794500100 });
    assert.equal(again.posts.length, 0);
});

test("a funding request is announced to keepers at once, even on the first run, then the job's life", () => {
    const now = 1794600000;
    const lines = [
        { at: now, event: "funding_requested", request: { job_id: "j1", address: "ark1qescrow", cap_sats: 2000, deadline: now + 900, min_coin_expiry: now + 90_000, provider_pk: "ab".repeat(32), model: "example/model" } },
    ];
    const text = (ls) => ls.map((e) => JSON.stringify(e)).join("\n") + "\n";
    let p = plan(state(text(lines), { now }), null, { now });
    assert.deepEqual(p.posts.map((x) => x.key), ["funding:j1"]);
    assert.match(p.posts[0].text, /^Keepers, a job is waiting for funding\. Send exactly 2,000 sats to ark1qescrow in one payment before /);
    assert.match(p.posts[0].text, /renew before paying: the escrow needs coins valid until at least /, "legacy mode names the coin expiry");
    let record = deliver(p);

    lines.push({ at: now + 60, event: "job_open", job_id: "j1", locked_sats: 2000 });
    p = plan(state(text(lines), { now: now + 60 }), record, { now: now + 60 });
    assert.deepEqual(p.posts.map((x) => x.key), ["open:j1"]);
    record = deliver(p);

    lines.push({ at: now + 950, event: "job_closed", job_id: "j1", txid: "2111bb32aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa41183b9", paid_sats: 1380, returned_sats: 620 });
    p = plan(state(text(lines), { now: now + 950 }), record, { now: now + 950 });
    assert.deepEqual(p.posts.map((x) => x.key), ["claimed:j1"]);
    assert.match(p.posts[0].text, /was paid 1,380 sats .* The remaining 620 sats went back to the treasury in the same transaction\. Transaction 2111bb32…83b9\.$/);
});

test("a failed post is retried on the next pass, and nothing after it is skipped", () => {
    const now = 1794600000;
    const s = { ...state("", { now }), contributions: [
        { at: now - 10, sats: 5000, rail: "lightning", reference: "a" },
        { at: now - 20, sats: 700, rail: "arkade", reference: "b" },
    ] };
    const baseline = plan({ ...s, contributions: [] }, null, { now });
    const p = plan(s, deliver(baseline), { now });
    assert.deepEqual(p.posts.map((x) => x.text.slice(0, 40)), ["Thank you: a chip-in of 700 sats arrived", "Thank you: a chip-in of 5,000 sats arriv"], "oldest first");
    const afterOne = markSaid(p.record, p.posts[0], p.newBudgets); // the second post failed
    assert.deepEqual(plan(s, afterOne, { now }).posts.map((x) => x.key), ["chip:a:" + (now - 10)]);
});

test("a low treasury is announced once per fall under the floor", () => {
    const now = 1794600000;
    const at = (balance) => ({ ...state("", { now }), treasury: { balanceSats: balance } });
    let record = deliver(plan(at(50_000), null, { now, lowTreasurySats: 10_000 }));
    let p = plan(at(9_000), record, { now, lowTreasurySats: 10_000 });
    assert.deepEqual(p.posts.map((x) => x.key), ["low"]);
    record = deliver(p);
    assert.equal(plan(at(8_000), record, { now, lowTreasurySats: 10_000 }).posts.length, 0, "not again while still low");
    record = deliver(plan(at(20_000), record, { now, lowTreasurySats: 10_000 }));
    assert.deepEqual(plan(at(5_000), record, { now, lowTreasurySats: 10_000 }).posts.map((x) => x.key), ["low"], "again after recovering");
});

test("the first run in a new month sums up the month before, budgets included", () => {
    const oct = Date.UTC(2026, 9, 15) / 1000, nov = Date.UTC(2026, 10, 2) / 1000;
    const usage = (n, at) => Array.from({ length: n }, () => JSON.stringify({ at, event: "member_usage", member: "m1", proposal: "p-12", status: 200, msat: 460_000 })).join("\n") + "\n";
    const october = { ...state(usage(1, oct), { now: oct }) };
    let record = deliver(plan(october, null, { now: oct }));
    const closed = [
        JSON.stringify({ at: oct + 100, event: "funding_requested", request: { job_id: "j9", address: "x", cap_sats: 2000, deadline: oct + 900, provider_pk: "cd".repeat(32), model: "m" } }),
        JSON.stringify({ at: oct + 200, event: "job_open", job_id: "j9" }),
        JSON.stringify({ at: oct + 1000, event: "job_closed", job_id: "j9", txid: "t".repeat(64), paid_sats: 1380, returned_sats: 620 }),
    ].join("\n") + "\n";
    const text = usage(1, oct) + closed + usage(4, oct + 500);
    const s = { ...state(text, { now: nov }), contributions: [{ at: oct + 50, sats: 5000, rail: "lightning", reference: "r" }] };
    const p = plan(s, record, { now: nov });
    const month = p.posts.find((x) => x.key === "month:2026-10");
    assert.ok(month, p.posts.map((x) => x.key).join());
    assert.equal(month.text, "October in Test Hive: 1 chip-in brought 5,000 sats, providers were paid 1,380 sats across 1 job, and 620 sats came back to the treasury. Budgets used: p-12 1,840 sats. The treasury holds 50,000 sats.");
    record = deliver(p);
    assert.equal(record.month, "2026-11");
    assert.equal(plan(s, record, { now: nov + 60 }).posts.length, 0, "summed up once");
});

test("an owner's authorization is checked against this bot's key", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-bot-"));
    const bot = loadOrCreateKey(join(dir, "bot"));
    const owner = loadOrCreateKey(join(dir, "owner"));
    const other = loadOrCreateKey(join(dir, "other"));
    const tag = signAuthTag(owner.secret, bot.pubkey);
    assert.equal(checkAuthTag(JSON.stringify(tag), bot.pubkey).owner, owner.pubkey);
    assert.throws(() => checkAuthTag(JSON.stringify(tag), other.pubkey), /does not authorize this bot's key/);
    assert.throws(() => checkAuthTag(JSON.stringify(signAuthTag(bot.secret, bot.pubkey)), bot.pubkey), /cannot be the same key/);
    assert.throws(() => checkAuthTag(JSON.stringify(["auth", owner.pubkey, "kind=01", tag[3]]), bot.pubkey), /not valid NIP-OA conditions/);
    assert.throws(() => checkAuthTag("auth", bot.pubkey), /not JSON/);
    assert.equal(loadOrCreateKey(join(dir, "bot")).pubkey, bot.pubkey, "the key persists");
});
