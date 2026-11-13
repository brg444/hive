import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentFromStatus, arkadePkScript, contributionsFromPayments, hiveState, jobsFromLog, proposalsFromLog } from "../api/src/state.mjs";

const log = (name) => readFileSync(new URL(`./fixtures/${name}-agent.jsonl`, import.meta.url), "utf8");

test("a mainnet job claimed against its last receipt", () => {
    const [job] = jobsFromLog(log("mainnet"));
    assert.equal(job.status, "claimed");
    assert.deepEqual([job.capSats, job.usedSats, job.paidSats, job.returnedSats], [2000, 1380, 1380, 620]);
    assert.match(job.txid, /^2111bb32/);
});

test("regtest: one claimed, one unused returned, one late-funded returned", () => {
    const jobs = jobsFromLog(log("regtest"));
    assert.deepEqual(jobs.map((j) => j.status).sort(), ["claimed", "returned", "returned"]);
    const state = hiveState({ name: "Test", chipIn: {}, treasury: { address: "x", balanceSats: 0 }, jobs, contributions: [] });
    assert.equal(state.funding.length, 0);
    assert.equal(state.providers.length, 1);
    assert.equal(state.providers[0].earnedSats, 1380);
    assert.deepEqual(state.payouts.map((p) => p.sats), [1380]);
});

test("a funding request is waiting until it opens, and lapses at its deadline", () => {
    const now = 1_000_000;
    const line = (event) => JSON.stringify({ at: now, ...event });
    const text = [
        line({ event: "sent", to: "peer", message: { kind: "offer", job_id: "j1", model: "m", cap_sats: 2000, deadline: now + 600 } }),
        line({ event: "funding_requested", request: { job_id: "j1", address: "ark1x", cap_sats: 2000, deadline: now + 600, min_coin_expiry: now + 90_000, provider_pk: "pk", provider_peer: "peer", model: "m" } }),
    ].join("\n");
    assert.equal(jobsFromLog(text, now)[0].status, "awaiting_funding");
    assert.equal(jobsFromLog(text, now + 601)[0].status, "lapsed");
    assert.equal(jobsFromLog(text + "\n" + line({ event: "job_open", job_id: "j1" }), now)[0].status, "open");
    // The job's own provider's refusal ends the request; another mesh peer's changes nothing, nor do malformed lines.
    const decline = (from) => line({ event: "received", from, message: { kind: "decline", job_id: "j1", reason: "coin expires too soon" } });
    assert.equal(jobsFromLog(`${text}\nnot json\n${decline("stranger")}`, now)[0].status, "awaiting_funding");
    assert.equal(jobsFromLog(`${text}\nnot json\n${decline("peer")}`, now)[0].status, "declined");
});

test("chip-ins are the settled payments, newest first", () => {
    const got = contributionsFromPayments({ payments: [
        { settled: true, settledAt: 2000_000, amountMsat: 2_000_000, paymentOption: "arkade", payoutReference: "b" },
        { settled: false, createdAt: 3000_000, amountMsat: 5_000_000 },
        { settled: true, settledAt: 4000_000, amountMsat: 1_000_000, paymentOption: "lightning", paymentReference: "c" },
    ] });
    assert.deepEqual(got.map((c) => [c.sats, c.rail]), [[1000, "lightning"], [2000, "arkade"]]);
});

test("an Arkade address decodes to its taproot output script", () => {
    const addr = "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3";
    assert.equal(arkadePkScript(addr), "51205798c08381403fe3cf5d3acbf7fd6619da16a7fe301adc7be97aeacbaefdd448");
});

test("members' usage adds up per proposal, without naming members", () => {
    const text = log("gateway");
    const [p] = proposalsFromLog(text);
    assert.deepEqual([p.proposal, p.requests, p.members, p.usedSats], ["p-test", 3, 1, 1380]);
    assert.ok(!("member" in p), "no member ids in the public document");
    // The paid job behind it matches: what members used is what the provider was paid.
    assert.equal(jobsFromLog(text).find((j) => j.usedSats).usedSats, 1380);
});

test("the agent's node id comes from its current invite, and the invite is not in the state", () => {
    const id = "ab".repeat(32);
    const token = Buffer.from(JSON.stringify({ id, addrs: [{ Ip: "10.0.0.1:41234" }] })).toString("base64url");
    const agent = agentFromStatus({ node_id: "abababab", token });
    assert.deepEqual(agent, { nodeId: id, invite: token });
    assert.equal(agentFromStatus({ token: "not-an-invite" }), null);
    assert.equal(agentFromStatus({}), null);
    const state = hiveState({ name: "H", chipIn: {}, treasury: {}, jobs: [], contributions: [], agent });
    assert.deepEqual(state.agent, { nodeId: id });
    assert.ok(!JSON.stringify(state).includes(token), "the invite stays out of the public state");
});
