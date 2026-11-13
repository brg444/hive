// The demo hive's state, for trying the plugin without running a host: a GitHub Pages site serves
// it at <site>/demo/hive/v1/state, regenerated every few hours so its times stay current.
//
//   node demo/make-state.mjs <site dir>
//
// Every figure is sample data, and the addresses are deliberately not valid, so nobody can pay
// into them. Proposals are not here: the plugin reads those from the channel it was built for.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const site = process.argv[2] ?? "_site";
const now = Math.floor(Date.now() / 1000);
const H = 3600, D = 86400;
const fake = (label) => `ark1qdemo0${label}0not0a0real0address0do0not0pay`;
const lena = "8f20aa" + "1".repeat(52) + "c3d2e1";
const fastnode = "3c1d0b7e52" + "0".repeat(48) + "a91f04";

const jobs = [
    { jobId: "demo-4", status: "awaiting_funding", model: "qwen3-coder-30b", capSats: 20000, usedSats: 0, providerPk: fastnode, requestedAt: now - 2 * H,
        deadline: now + 20 * H, minCoinExpiry: now + 4 * D, escrowAddress: fake("escrow") },
    { jobId: "demo-3", status: "open", model: "llama-3.3-70b", capSats: 20000, usedSats: 6120, providerPk: lena, offeredAt: now - 8 * H, deadline: now + 2 * D },
    { jobId: "demo-2", status: "claimed", model: "llama-3.3-70b", capSats: 20000, paidSats: 12120, returnedSats: 7880, providerPk: lena, closedAt: now - 2 * D, txid: "demo-2" },
    { jobId: "demo-1", status: "returned", model: "qwen3-coder-30b", capSats: 10000, returnedSats: 10000, providerPk: fastnode, closedAt: now - 5 * D },
];
const state = {
    v: 1,
    name: "Hive demo",
    updatedAt: now,
    demo: true,
    agent: null,
    chipIn: { lightningAddress: null },
    treasury: { address: fake("treasury"), balanceSats: 1284500 },
    funding: jobs.filter((j) => j.status === "awaiting_funding"),
    jobs,
    providers: [
        { providerPk: lena, providerPeer: null, earnedSats: 12120, openJobs: 1, jobs: 2, models: ["llama-3.3-70b"] },
        { providerPk: fastnode, providerPeer: null, earnedSats: 0, openJobs: 0, jobs: 2, models: ["qwen3-coder-30b"] },
    ],
    payouts: [{ at: now - 2 * D, jobId: "demo-2", providerPk: lena, sats: 12120, txid: "demo-2" }],
    contributions: [
        { at: now - 5 * H, sats: 21000, rail: "lightning", reference: "demo-c1" },
        { at: now - 1 * D, sats: 100000, rail: "arkade", reference: "demo-c2" },
        { at: now - 3 * D, sats: 5000, rail: "lightning", reference: "demo-c3" },
    ],
    proposals: [],
    governance: null,
};

mkdirSync(join(site, "demo/hive/v1"), { recursive: true });
writeFileSync(join(site, "demo/hive/v1/state"), JSON.stringify(state));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset=utf-8><title>Hive demo</title>
<p>This site serves sample data for trying the Hive plugin for Buzz: <a href="demo/hive/v1/state">demo/hive/v1/state</a>.
Nothing here is a real treasury, and the addresses are deliberately invalid.</p>`);
console.log(join(site, "demo/hive/v1/state"));
