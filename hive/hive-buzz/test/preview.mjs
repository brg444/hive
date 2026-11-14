// Render the plugin as a member sees it in Buzz, with sample data, to an HTML file for screenshots:
// a proposal card and the status line in the hive's channel, the Propose form above the composer,
// and the hive's page. It uses Buzz's own design tokens when given a buzz-app checkout.
//
//   node test/preview.mjs <out.html> [--buzz-app <path to block/buzz-app>] [--dark]
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToString } from "react-dom/server";
import { formatProposal } from "../shared/proposal.mjs";

const argv = process.argv.slice(2);
const out = argv[0];
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const dark = argv.includes("--dark");
const root = new URL("..", import.meta.url).pathname;
const now = Math.floor(Date.now() / 1000);
const H = 3600, D = 86400;

const K = ["1e8e42649059b5885f4d35302f3a3a7e161c2e40d5e82f550341138741bd253f", "647c09f5295635acc82988a65283bce2caefb3b296dac5e658b0891873d803e2", "9a0c51e2" + "7".repeat(56)];
const ME = K[1];
const DANA = "d4" + "5".repeat(62), KOFI = "c0" + "f".repeat(62);
const base = { start: null, end: null, named: [], provider: "", reportPlan: "", declinedBy: [], reason: null, report: null, replies: 0 };
const proposals = [
    { ...base, id: "p-9a1c0f21", eventId: "9a1c0f21".padEnd(64, "0"), by: KOFI, postedAt: now - 30 * H, title: "Nightly triage of failing tests in the plugin repo", budgetSats: 12000,
        who: "me", allowanceSats: 800, purpose: "Plugin authors lose mornings reading red CI runs. A nightly summary of what broke and the likely cause lands in #plugins.",
        work: "About 300,000 tokens a night on qwen3-coder-30b.", state: "open", discussionEnds: now - 6 * H, approvedAt: null, starts: null, ends: null, usedSats: 0, support: 5, approvals: [K[0]], replies: 4 },
    { ...base, id: "p-4b7e2d10", eventId: "4b7e2d10".padEnd(64, "0"), by: DANA, postedAt: now - 9 * H, title: "Translate the Buzz docs into Spanish and Portuguese", budgetSats: 30000,
        start: now + 2 * D, end: now + 27 * D, who: "everyone", allowanceSats: 2000, purpose: "Buzz's docs exist only in English. The translated pages go to the docs repo, one pull request per language.",
        work: "About 2.4 million tokens on llama-3.3-70b.", report: "A link to each merged pull request.", state: "open", discussionEnds: now + 39 * H, approvedAt: null, starts: null, ends: null,
        usedSats: 0, support: 9, approvals: [], replies: 7 },
    { ...base, id: "p-15c3aa02", eventId: "15c3aa02".padEnd(64, "0"), by: DANA, postedAt: now - 12 * D, title: "Code review agent for plugin pull requests", budgetSats: 40000,
        who: "everyone", allowanceSats: 1500, purpose: "Every pull request to a community plugin gets a first review within an hour.", state: "running",
        discussionEnds: now - 10 * D, approvedAt: now - 10 * D, starts: now - 10 * D, ends: now + 20 * D, usedSats: 18240, support: 17, approvals: [K[0], K[2]], replies: 22 },
    { ...base, id: "p-77d10b9e", eventId: "77d10b9e".padEnd(64, "0"), by: KOFI, postedAt: now - 20 * D, title: "Avatar generator for new members", budgetSats: 15000, who: "me",
        allowanceSats: null, purpose: "Generate a starting avatar for each new member.", state: "declined", discussionEnds: now - 18 * D, approvedAt: null, starts: null, ends: null,
        usedSats: 0, support: 2, approvals: [], reason: "Image generation is outside the hive's purpose.", replies: 5 },
];
const state = {
    v: 1, name: "Buzz Builders", updatedAt: now, agent: { nodeId: "ab".repeat(32) },
    keepersDesk: { desk: "https://hive.example.org/c/chan-hive", console: "https://keeper.hive.example/" },
    chipIn: { lightningAddress: "builders@hive.example" },
    price: { usdPerBtc: 67235, at: now - 120, source: "mempool.space" },
    treasury: { address: "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3", balanceSats: 1284500 },
    funding: [{ jobId: "j42", status: "awaiting_funding", model: "qwen3-coder-30b", capSats: 20000, deadline: now + 20 * H, minCoinExpiry: now + 4 * D,
        escrowAddress: "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamecescrow0sample0address0for0the0preview0only0xr4t3", providerPk: "3c1d0b7e52" + "0".repeat(48) + "a91f04" }],
    jobs: [
        { jobId: "j42", status: "awaiting_funding", model: "qwen3-coder-30b", capSats: 20000, usedSats: 0, providerPk: "3c1d0b7e52" + "0".repeat(48) + "a91f04" },
        { jobId: "j41", status: "open", model: "llama-3.3-70b", capSats: 20000, usedSats: 6120, providerPk: "8f20aa" + "1".repeat(52) + "c3d2e1" },
        { jobId: "j40", status: "claimed", model: "llama-3.3-70b", capSats: 20000, paidSats: 12120, returnedSats: 7880, providerPk: "8f20aa" + "1".repeat(52) + "c3d2e1" },
        { jobId: "j39", status: "returned", model: "qwen3-coder-30b", capSats: 10000, returnedSats: 10000, providerPk: "3c1d0b7e52" + "0".repeat(48) + "a91f04" },
    ],
    providers: [
        { providerPk: "8f20aa" + "1".repeat(52) + "c3d2e1", earnedSats: 12120, openJobs: 1, jobs: 2, models: ["llama-3.3-70b"] },
        { providerPk: "3c1d0b7e52" + "0".repeat(48) + "a91f04", earnedSats: 0, openJobs: 0, jobs: 2, models: ["qwen3-coder-30b"] },
    ],
    payouts: [{ at: now - 2 * D, jobId: "j40", providerPk: "8f20aa" + "1".repeat(52) + "c3d2e1", sats: 12120, txid: "t40" }],
    contributions: [
        { at: now - 5 * H, sats: 21000, rail: "lightning", reference: "c1" }, { at: now - 1 * D, sats: 100000, rail: "arkade", reference: "c2" },
        { at: now - 3 * D, sats: 5000, rail: "lightning", reference: "c3" },
    ],
    proposals: [],
    governance: { channelId: "chan-hive", keepers: K, keeperKeys: K.map((_, i) => `02${String(i).repeat(64)}`), threshold: 2, smallSats: 20000, updatedAt: now, proposals, members: { [ME]: { node: "cd".repeat(32) } } },
};

// Build and activate the plugin against the sample state.
const work = mkdtempSync(join(tmpdir(), "hive-preview-"));
const dir = execFileSync("node", [join(root, "plugin/build.mjs"), "--api", "https://hive.example.org", "--name", "Buzz Builders", "--out", work]).toString().trim();
const mod = await import(pathToFileURL(join(dir, "plugin.js")).href);
const seen = { pages: [], messages: [], tools: [], accessories: [], settings: [] };
const stops = [];
mod.apply({
    react: React,
    pages: { register: (p) => seen.pages.push(p) }, agents: { addTool: () => {} }, settingsCards: { register: (c) => seen.settings.push(c) },
    notifications: { register: () => ({ submit: async () => {} }) },
    conversation: { registerMessage: (r) => seen.messages.push(r), registerTool: (t) => seen.tools.push(t), registerAccessory: (a) => seen.accessories.push(a) },
    relay: { snapshot: () => ({ status: "ready", generation: 1, viewer: ME, session: {} }) },
    navigation: { open: async () => ({ status: "opened" }) },
    host: { request: async () => ({ status: 200, headers: {}, body: JSON.stringify(state) }) },
    effect: (fn) => { const stop = fn(); if (stop) stops.push(stop); },
});
await new Promise((r) => setTimeout(r, 1500));

const e = React.createElement;
const render = (el) => renderToString(el);
const msgFor = (p, reactions) => ({ id: p.eventId, channelId: "chan-hive", authorId: p.by, createdAt: p.postedAt, mentions: [], reactions,
    content: formatProposal({ ...p, start: p.start, end: p.end }) });
const reactions = (support, keepers) => [
    { content: "👍", events: Array.from({ length: support }, (_, i) => ({ id: `s${i}`, authorId: `${i}`.padStart(64, "a") })) },
    { content: "✅", events: keepers.map((k, i) => ({ id: `k${i}`, authorId: k })) },
];
const Card = seen.messages[0].component;
const Tool = seen.tools[0].component;
const Status = seen.accessories[0].component;
const toolProps = { channelId: "chan-hive", disabled: false, insertText: () => true, focus: () => {} };

const message = (who, ago, body) => `<div class="msg"><span class="av">${who.slice(0, 2)}</span><div class="mb"><div class="mh"><b>${who}</b><span>${ago}</span></div>${body}</div></div>`;
const composer = (accessory, toolHtml) => `<div class="composer-area">${accessory}<div class="composer"><div class="ph">Message #hive</div><div class="tb"><span class="ib">+</span><span class="ib">☺</span>${toolHtml}<span class="send">↑</span></div></div></div>`;

const channel = `<div class="chan"><div class="ch">#hive</div><div class="feed">
  ${message("Dana Whitfield", "9:12", render(e(Card, { message: msgFor(proposals[1], reactions(9, [])) })))}
  ${message("Kofi Mensah", "Yesterday", render(e(Card, { message: msgFor(proposals[0], reactions(5, [K[0]])) })))}
  ${message("Hive", "Yesterday", `<p style="margin:0">Paid 12,120 sats to provider 8f20aa1111…c3d2e1 for job j40; 7,880 sats went back to the treasury.</p>`)}
  </div>${composer(render(e(Status, { channelId: "chan-hive" })), render(e(Tool, toolProps)))}</div>`;
const running = `<div class="chan"><div class="feed">${message("Dana Whitfield", "Nov 1", render(e(Card, { message: msgFor(proposals[2], reactions(17, [K[0], K[2]])) })))}</div></div>`;

// The form, as it shows once Propose is pressed.
const toolEl = (() => { let el; render(e(() => (el = Tool(toolProps)))); return el; })();
toolEl.props.onClick();
await new Promise((r) => setTimeout(r, 50));
const form = `<div class="chan"><div class="feed" style="padding-bottom:0"></div>${composer(render(e(Status, { channelId: "chan-hive" })), render(e(Tool, toolProps)))}</div>`;

const Page = seen.pages[0].component;
const page = (tab) => `<div class="pagewrap">${render(e(Page, { initialTab: tab }))}</div>`;

// Buzz's tokens, from a buzz-app checkout when given one.
const app = arg("--buzz-app");
let tokens = ":root{--space-2:8px;--space-3:12px;--space-4:16px;--space-panel-inset:20px}";
if (app && existsSync(join(app, "src/shared/design-system/styles/tokens.css"))) {
    const ds = readFileSync(join(app, "src/shared/design-system/styles/tokens.css"), "utf8");
    tokens = ds.slice(0, ds.indexOf("@theme inline")) + readFileSync(join(app, "src/shared/styles/tokens.css"), "utf8");
}
writeFileSync(out, `<!doctype html><html class="${dark ? "dark" : ""}" ${dark ? 'data-color-mode="dark"' : ""}><meta charset=utf-8><style>${tokens}
:root{--font-sans:"Inter Variable",Inter,ui-sans-serif,system-ui,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace}
html{font-family:var(--font-sans);-webkit-font-smoothing:antialiased}
body{margin:0;background:var(--surface-base);color:var(--text-standard);font-size:14px;line-height:1.45}
h1{font-size:22px;font-weight:650;letter-spacing:-0.01em}h2{font-weight:600}code{font-family:var(--font-mono);font-size:0.92em}
button{font:inherit;font-size:13px;color:var(--text-standard);background:var(--affordance-subtle);border:1px solid var(--border-standard);border-radius:var(--radius-pill);padding:4px 12px}
.ui-card{border:1px solid var(--border-standard);border-radius:var(--radius-panel);background:var(--surface-panel);box-shadow:var(--shadow-sm)}
.shot{padding:24px;display:block;width:fit-content}
.chan{width:720px;background:var(--surface-panel);border:1px solid var(--border-standard);border-radius:24px;overflow:hidden}
.ch{padding:14px 20px;font-weight:650;border-bottom:1px solid var(--border-standard)}
.feed{padding:16px 20px;display:flex;flex-direction:column;gap:18px}
.msg{display:grid;grid-template-columns:36px 1fr;gap:12px}.av{width:36px;height:36px;border-radius:12px;background:var(--surface-inset);display:grid;place-items:center;font-weight:600;font-size:12px;color:var(--text-subtle)}
.mh{display:flex;gap:8px;align-items:baseline;margin-bottom:6px}.mh span{color:var(--text-subtle);font-size:12px}
.composer-area{padding:0 16px 16px}.composer{border:1px solid var(--border-prominent);border-radius:22px;padding:10px 12px;background:var(--surface-composer, var(--surface-panel))}
.ph{color:var(--text-subtle);padding:4px 4px 10px}.tb{display:flex;gap:6px;align-items:center}.ib{width:28px;height:28px;display:grid;place-items:center;color:var(--text-subtle)}
.send{margin-left:auto;width:30px;height:30px;border-radius:999px;background:var(--affordance-prominent);color:var(--text-on-prominent);display:grid;place-items:center}
.pagewrap{width:1000px;background:var(--surface-base)}
.settings{width:560px;padding:24px;background:var(--surface-panel);border:1px solid var(--border-standard);border-radius:24px}
</style><body>
<div class="shot" id="channel">${channel}</div>
<div class="shot" id="running">${running}</div>
<div class="shot" id="form">${form}</div>
<div class="shot" id="overview">${page("home")}</div>
<div class="shot" id="keepers">${page("keepers")}</div>
<div class="shot" id="money">${page("money")}</div>
<div class="shot" id="settings"><div class="settings">${render(e(seen.settings[0].component, { active: () => true }))}</div></div>
</body></html>`);
stops.forEach((s) => s());
console.log(out);
process.exit(0);
