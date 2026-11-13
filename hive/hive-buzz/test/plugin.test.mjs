// The built plugin, activated in a stand-in for Buzz's host that follows the documented API v1
// contract (docs/plugin-authoring-guide.md), against a real hive-api over HTTP.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToString } from "react-dom/server";

const ORIGIN = "https://hive.example.org";
const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "hive-buzz-"));
const children = [];
after(() => children.forEach((c) => c.kill()));

function build(extra = []) {
    const out = execFileSync("node", [join(root, "plugin/build.mjs"), "--api", ORIGIN, "--name", "Test Hive", "--out", work, ...extra]).toString().trim();
    return out;
}

async function startApi(agentLog, extra = []) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn("node", [join(root, "api/src/server.mjs"), "--name", "Test Hive", "--agent-log", agentLog, "--port", String(port), ...extra], { stdio: "pipe" });
    children.push(child);
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return `http://127.0.0.1:${port}`; } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("hive-api did not start");
}

/** What a Buzz host gives a plugin, recording what the plugin registers and sends. */
/** A stand-in for Buzz's relay session: `observe` gives a view over the channel's events. */
function fakeSession(events = null) {
    if (!events) return {};
    const listeners = new Set();
    let snapshot = { status: "idle", events: [] };
    return {
        observe(filters) {
            const wanted = (e) => filters.some((f) => f.kinds.includes(e.kind) && (e.tags ?? []).some((t) => t[0] === "h" && f["#h"].includes(t[1])));
            return {
                snapshot: () => snapshot,
                subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
                refresh: async () => { snapshot = { status: "ready", events: events.filter(wanted) }; listeners.forEach((l) => l()); },
                dispose: () => listeners.clear(),
            };
        },
    };
}

function fakeHost(apiBase, viewer = null, events = null) {
    const seen = { pages: [], tools: [], notifications: [], categories: [], requests: [], cleanups: [], messages: [], composer: [], accessories: [], opened: [] };
    const ctx = {
        react: React,
        conversation: {
            registerMessage: (r) => seen.messages.push(r),
            registerTool: (t) => seen.composer.push(t),
            registerAccessory: (a) => seen.accessories.push(a),
        },
        relay: (() => {
            const session = fakeSession(events);
            return { snapshot: () => (viewer ? { status: "ready", generation: 1, scope: "test", viewer, session } : { status: "disconnected", generation: 0, session: {} }), subscribe: () => () => {} };
        })(),
        navigation: { open: async (t) => { seen.opened.push(t); return { status: "opened" }; } },
        pages: { register: (p) => seen.pages.push(p) },
        agents: { addTool: (t) => seen.tools.push(t) },
        notifications: {
            register: (c) => { seen.categories.push(c); return { submit: async (n) => { seen.notifications.push(n); } }; },
        },
        host: {
            // Like Buzz: only the declared origin, a string body back.
            request: async ({ url, timeoutMs }) => {
                assert.ok(url.startsWith(ORIGIN + "/"), `undeclared origin ${url}`);
                assert.ok(!timeoutMs || timeoutMs <= 180_000);
                seen.requests.push(url);
                const res = await fetch(apiBase + url.slice(ORIGIN.length));
                return { status: res.status, headers: {}, body: await res.text() };
            },
        },
        effect: (fn) => { const stop = fn(); if (stop) seen.cleanups.push(stop); },
        reflect: { get: () => undefined },
    };
    return { ctx, seen };
}

async function activate(apiBase, viewer, events, extra = []) {
    const dir = build(extra);
    // A fresh module per activation, as Buzz evaluates each revision once.
    const mod = await import(pathToFileURL(join(dir, "plugin.js")).href + `?v=${Math.random()}`);
    const { ctx, seen } = fakeHost(apiBase, viewer, events);
    for (const service of mod.inject) assert.ok(ctx[service], `host lacks ${service}`);
    const started = Date.now();
    await mod.apply(ctx);
    assert.ok(Date.now() - started < 10_000, "activation within 10 s");
    return { mod, seen, dir };
}

test("the manifest follows Buzz's contract", () => {
    const manifest = JSON.parse(readFileSync(join(build(), "manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest).sort(), ["apiVersion", "description", "discovery", "host", "id", "name"]);
    assert.equal(manifest.apiVersion, 1);
    assert.match(manifest.id, /^[a-z][a-z0-9.-]*$/);
    assert.ok(Buffer.byteLength(manifest.description) <= 280);
    assert.deepEqual(manifest.host, { networkOrigins: [ORIGIN] });
    const js = readFileSync(join(build(), "plugin.js"), "utf8");
    assert.doesNotMatch(js, /^\s*import\s/m, "no runtime imports");
    assert.doesNotMatch(js, /__[A-Z_]+__/, "every placeholder filled");
});

test("mainnet: the page shows the treasury, the paid job and the provider's earnings", async () => {
    const api = await startApi(join(root, "test/fixtures/mainnet-agent.jsonl"), [
        "--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3",
        "--operator", "https://arkade.computer",
        "--lightning-address", "wise-comet@lnurl.arkade.sh",
        ...(process.env.HIVE_LNURL_TOKEN_FILE ? ["--lnurl-token-file", process.env.HIVE_LNURL_TOKEN_FILE] : []),
    ]);
    const { seen } = await activate(api);
    assert.equal(seen.pages.length, 1);
    assert.equal(seen.pages[0].id, "main");
    assert.equal(seen.pages[0].primary, true);
    assert.match(seen.pages[0].icon, /^data:image\/svg\+xml,/, "the hive's mark in Buzz's navigation");
    assert.equal(seen.tools[0].name, "hive_status");

    const status = await seen.tools[0].call();
    console.log(status);
    assert.match(status, /treasury [\d,.]+ sats/);
    assert.match(status, /Chip in at wise-comet@lnurl\.arkade\.sh/);
    assert.match(status, /earned 1,380 sats/);

    const page = (initialTab) => renderToString(React.createElement(seen.pages[0].component, { initialTab }));
    const html = page("home") + page("keepers") + page("money");
    for (const text of ["Treasury", "wise-comet@lnurl.arkade.sh", "No job is waiting for funding.", "Paid", "paid 1,380 sats, returned 620 sats", "earned 1,380 sats"]) {
        assert.ok(html.includes(text), `page shows ${text}`);
    }
    assert.equal(seen.notifications.length, 0, "nothing to fund, nothing announced");
    seen.cleanups.forEach((stop) => stop());
});

test("keepers: a job awaiting funding is listed and announced once", async () => {
    const now = Math.floor(Date.now() / 1000);
    const log = join(work, "pending.jsonl");
    writeFileSync(log, [
        { at: now, event: "sent", to: "peer", message: { kind: "offer", job_id: "j1", model: "example/model", cap_sats: 2000, deadline: now + 900 } },
        { at: now, event: "funding_requested", request: { job_id: "j1", address: "ark1qescrowexampleaddress", cap_sats: 2000, deadline: now + 900, min_coin_expiry: now + 90_000, provider_pk: "pk".repeat(32), provider_peer: "peer", model: "example/model" } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const api = await startApi(log, ["--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3", "--operator", "http://127.0.0.1:9"]);
    const { seen } = await activate(api);
    await seen.tools[0].call();
    await new Promise((r) => setTimeout(r, 1500)); // the first poll after activation
    const html = renderToString(React.createElement(seen.pages[0].component));  // on the overview while it waits
    assert.ok(html.includes("2,000 sats for example/model"), "the request is listed");
    assert.ok(html.includes("ark1qescrowe"), "with its escrow address");
    assert.ok(html.includes("–"), "an unreachable indexer shows an unknown balance, not a wrong one");
    assert.equal(seen.notifications.length, 1, "announced once across two loads");
    assert.equal(seen.notifications[0].sourceKey, "funding:j1");
    assert.deepEqual(seen.notifications[0].target, { version: 1, kind: "plugin", pluginId: "test-hive.hive", pageId: "main" });
    seen.cleanups.forEach((stop) => stop());
});

test("an unreachable host shows an error, not a blank page", async () => {
    const { seen } = await activate("http://127.0.0.1:9");
    await seen.tools[0].call();
    const html = renderToString(React.createElement(seen.pages[0].component));
    assert.ok(html.includes("Could not reach the hive"), html.slice(0, 300));
    seen.cleanups.forEach((stop) => stop());
});

test("members' usage shows per proposal on the page and in the agent tool", async () => {
    const api = await startApi(join(root, "test/fixtures/gateway-agent.jsonl"), ["--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3", "--operator", "http://127.0.0.1:9"]);
    const { seen } = await activate(api);
    const status = await seen.tools[0].call();
    assert.match(status, /Budget p-test: 1,380 sats used by 1 member\(s\) over 3 request\(s\)/);
    const html = renderToString(React.createElement(seen.pages[0].component));
    assert.ok(html.includes("Budgets in use") && html.includes("p-test") && html.includes("1,380 sats used"), "budget card");
    seen.cleanups.forEach((stop) => stop());
});

test("with the agent's console, members see the id to install with, and the invite is served only when enabled", async () => {
    const id = "cd".repeat(32);
    const token = Buffer.from(JSON.stringify({ id, addrs: [] })).toString("base64url");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const console_ = http.createServer((req, res) => {
        res.writeHead(req.url === "/api/status" ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ node_id: id.slice(0, 10), token }));
    }).listen(port, "127.0.0.1");
    after(() => console_.close());
    const common = ["--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3", "--operator", "http://127.0.0.1:9", "--agent-console", `http://127.0.0.1:${port}`];
    const closed = await startApi(join(root, "test/fixtures/gateway-agent.jsonl"), common);
    assert.equal((await fetch(`${closed}/hive/v1/invite`)).status, 404, "off unless asked for");
    const { seen } = await activate(closed);
    assert.match(await seen.tools[0].call(), new RegExp(`agent's node id ${id}`));
    const html = renderToString(React.createElement(seen.pages[0].component));
    assert.ok(html.includes(`--agent ${id}`), "the Budgets card shows the install line");
    seen.cleanups.forEach((stop) => stop());
    const open = await startApi(join(root, "test/fixtures/gateway-agent.jsonl"), [...common, "--serve-invite"]);
    const res = await fetch(`${open}/hive/v1/invite`);
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), token);
});

test("in the hive's channel: proposals draw as cards with live counts, Propose starts one, and a status line sits above the composer", async () => {
    const { formatProposal } = await import("../shared/proposal.mjs");
    const K = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    const ALICE = "1".repeat(64), BOB = "2".repeat(64);
    const now = Math.floor(Date.now() / 1000);
    const text = formatProposal({ title: "Translate the docs", budgetSats: 30000, start: null, end: null, who: "everyone", allowanceSats: 2000,
        purpose: "Docs exist only in English.", work: "llama-3.3-70b", provider: "", report: "A link to the pull request." });
    const eventId = "e1".repeat(32);
    const gov = { v: 1, channelId: "chan", keepers: K, threshold: 2, smallSats: 20000, updatedAt: now, members: { [BOB]: { node: "cd".repeat(32) } },
        proposals: [
            { id: "p-e1e1e1e1", eventId, by: ALICE, postedAt: now - 3 * 86400, title: "Translate the docs", budgetSats: 30000, start: null, end: null, who: "everyone", named: [],
                allowanceSats: 2000, purpose: "Docs exist only in English.", work: "", provider: "", reportPlan: "", state: "running", discussionEnds: now - 86400,
                approvedAt: now - 86400, starts: now - 86400, ends: now + 29 * 86400, usedSats: 0, support: 2, replies: 1, approvals: K.slice(0, 2), declinedBy: [], reason: null, report: null },
            { id: "p-0f0f0f0f", eventId: "0f".repeat(32), by: BOB, postedAt: now - 3600, title: "Nightly triage", budgetSats: 12000, start: null, end: null, who: "me", named: [],
                allowanceSats: null, purpose: "Triage new issues.", work: "", provider: "", reportPlan: "", state: "open", discussionEnds: now + 82800,
                approvedAt: null, starts: null, ends: null, usedSats: 0, support: 0, replies: 0, approvals: [], declinedBy: [], reason: null, report: null },
        ] };
    const govFile = join(work, "governance.json");
    writeFileSync(govFile, JSON.stringify(gov));
    const api = await startApi(join(root, "test/fixtures/gateway-agent.jsonl"), ["--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3", "--operator", "http://127.0.0.1:9", "--governance", govFile]);
    const { seen } = await activate(api, BOB);
    const status = await seen.tools[0].call();
    assert.match(status, /Proposal p-e1e1e1e1 "Translate the docs": Running, 30,000 sats/);
    assert.match(status, /2 keepers' ✅ approve it/);

    // The card: what was proposed, where it stands, and the reactions as Buzz shows them.
    const [card] = seen.messages;
    const message = { id: eventId, channelId: "chan", authorId: ALICE, createdAt: now - 3 * 86400, content: text, mentions: [],
        reactions: [{ content: "👍", events: [{ id: "r1", authorId: BOB }, { id: "r2", authorId: ALICE }] }, { content: "✅", events: K.slice(0, 2).map((k, i) => ({ id: `k${i}`, authorId: k })) }] };
    assert.ok(card.matches(message));
    assert.ok(!card.matches({ ...message, channelId: "elsewhere" }), "only in the hive's channel");
    assert.ok(!card.matches({ ...message, content: "a proposal: lunch?" }));
    const cardHtml = renderToString(React.createElement(card.component, { message }));
    for (const t of ["Translate the docs", "30,000 sats", "Running", "👍 1", "2 of 2 keepers", "2,000 sats a day"]) assert.ok(cardHtml.includes(t), `card shows ${t}`);

    // Propose: only in the hive's channel, and it fills the composer with a proposal to complete.
    const [propose] = seen.composer;
    let inserted = null;
    const toolProps = { channelId: "chan", disabled: false, insertText: (t) => { inserted = t; return true; }, focus: () => {} };
    assert.equal(renderToString(React.createElement(propose.component, { ...toolProps, channelId: "elsewhere" })), "");
    assert.match(renderToString(React.createElement(propose.component, toolProps)), /aria-label="Propose work to the hive"/);
    assert.equal(seen.accessories[0].placement, undefined, "the status line sits above the composer");
    const line = renderToString(React.createElement(seen.accessories[0].component, { channelId: "chan" }));
    assert.match(line, /1 proposal open, next decision in 23 h/);
    // Rendering cannot click, so the button the tool returns is captured and its handler called:
    // Propose opens the form in place of the status line, and Cancel would close it.
    let el;
    renderToString(React.createElement(() => (el = propose.component(toolProps))));
    el.props.onClick();
    const form = renderToString(React.createElement(seen.accessories[0].component, { channelId: "chan" }));
    for (const t of ["Propose work to Test Hive", "Purpose and output", "Budget in sats", "Who uses it", "Add to message"]) assert.ok(form.includes(t), `form shows ${t}`);
    assert.equal(renderToString(React.createElement(seen.accessories[0].component, { channelId: "elsewhere" })), "", "only in the hive's channel");
    assert.equal(inserted, null, "nothing goes into the message until the form is filled in");
    el.props.onClick();

    // The page: Bob is a member with a node, and the running proposal is for everyone.
    const home = renderToString(React.createElement(seen.pages[0].component, {}));
    for (const t of ["Your allowances", "Translate the docs", "2,000 sats a day", "Nightly triage", "closes in 23 h"]) assert.ok(home.includes(t), `page shows ${t}`);
    assert.ok(home.includes("Your node"), "Bob named his node");
    seen.cleanups.forEach((stop) => stop());
});

test("a keeper hears once about a proposal whose discussion closed without their decision", async () => {
    const K = ["a".repeat(64), "b".repeat(64)];
    const now = Math.floor(Date.now() / 1000);
    const govFile = join(work, "governance-keeper.json");
    writeFileSync(govFile, JSON.stringify({ v: 1, channelId: "chan", keepers: K, threshold: 2, smallSats: 20000, updatedAt: now, members: {}, proposals: [
        { id: "p-12345678", eventId: "12".repeat(32), by: "1".repeat(64), postedAt: now - 2 * 86400, title: "Docs", budgetSats: 30000, who: "me", named: [], state: "open",
            discussionEnds: now - 60, approvals: [K[0]], support: 3, usedSats: 0, declinedBy: [] },
    ] }));
    const api = await startApi(join(root, "test/fixtures/gateway-agent.jsonl"), ["--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3", "--operator", "http://127.0.0.1:9", "--governance", govFile]);
    const { seen } = await activate(api, K[1]);
    await seen.tools[0].call();
    await new Promise((r) => setTimeout(r, 1500));
    const decide = seen.notifications.filter((n) => n.sourceKey.startsWith("decide:"));
    assert.equal(decide.length, 1);
    assert.match(decide[0].title, /“Docs” is ready for keepers/);
    const keepers = renderToString(React.createElement(seen.pages[0].component, { initialTab: "keepers" }));
    assert.match(keepers, /Keepers<span[^>]*>1<\/span>/, "the tab counts what waits for this keeper");
    assert.ok(keepers.includes("Waiting for your decision") && keepers.includes("Needs your decision"));
    seen.cleanups.forEach((stop) => stop());
});

test("with the channel and keepers built in, the plugin works out proposals from the channel itself, with no record from the host", async () => {
    const { formatProposal } = await import("../shared/proposal.mjs");
    const { bech32 } = await import("@scure/base");
    const K = ["a".repeat(64), "b".repeat(64)];
    const ALICE = "1".repeat(64), BOB = "2".repeat(64);
    const channel = "7c745ff4-02b3-47c1-b081-8b321828f390";
    const now = Math.floor(Date.now() / 1000);
    let n = 0;
    const id = () => (++n).toString(16).padStart(64, "0");
    const ev = (kind, pubkey, content, at, tags = []) => ({ id: id(), kind, pubkey, content, created_at: at, tags: [["h", channel], ...tags] });
    const proposal = ev(9, ALICE, formatProposal({ title: "Weekly summaries", budgetSats: 12000, start: null, end: null, who: "everyone", allowanceSats: 700,
        purpose: "A weekly summary of the channel.", work: "", provider: "", report: "" }), now - 2 * 86400);
    const events = [
        proposal,
        ev(7, BOB, "👍", now - 2 * 86400 + 60, [["e", proposal.id]]),
        ev(7, K[0], "✅", now - 86400, [["e", proposal.id]]),
        ev(7, K[1], "✅", now - 86400 + 30, [["e", proposal.id]]),
        ev(9, BOB, `Hive node: ${"cd".repeat(32)}`, now - 3600),
        ev(9, ALICE, "not a proposal", now - 60),
    ];
    // The host has no governance at all: the plugin needs only the channel.
    const api = await startApi(join(root, "test/fixtures/gateway-agent.jsonl"), ["--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3", "--operator", "http://127.0.0.1:9"]);
    const npub = bech32.encode("npub", bech32.toWords(Buffer.from(K[0], "hex")));
    const { seen } = await activate(api, BOB, events, ["--channel", channel, "--keepers", `${npub},${K[1]}`]);
    await seen.tools[0].call();
    await new Promise((r) => setTimeout(r, 300));
    const status = await seen.tools[0].call();
    assert.match(status, /"Weekly summaries": Running, 12,000 sats/, "approved after its 24 hours, and running");
    const home = renderToString(React.createElement(seen.pages[0].component, {}));
    for (const t of ["Your allowances", "Weekly summaries", "700 sats a day", "Your node"]) assert.ok(home.includes(t), `page shows ${t}`);
    const line = renderToString(React.createElement(seen.accessories[0].component, { channelId: channel }));
    assert.match(line, /1 budget running/);
    const card = renderToString(React.createElement(seen.messages[0].component, { message: { id: proposal.id, channelId: channel, authorId: ALICE, createdAt: proposal.created_at,
        content: proposal.content, mentions: [], reactions: [{ content: "✅", events: K.map((k, i) => ({ id: `k${i}`, authorId: k })) }] } }));
    assert.ok(card.includes("Running") && card.includes("2 of 2 keepers"), "the card shows the decision");
    assert.ok(seen.messages[0].matches({ channelId: channel, content: proposal.content }));
    assert.ok(!seen.messages[0].matches({ channelId: "elsewhere", content: proposal.content }));
    seen.cleanups.forEach((stop) => stop());
});

test("HiveBot: an agent of the plugin's own type says hello once in the hive's channel and answers mentions with the hive's status", async () => {
    const channel = "7c745ff4-02b3-47c1-b081-8b321828f390";
    const BOT = "b0".repeat(32), ALICE = "1".repeat(64);
    const api = await startApi(join(root, "test/fixtures/gateway-agent.jsonl"), ["--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3", "--operator", "http://127.0.0.1:9"]);
    const dir = build(["--channel", channel, "--keepers", `${"a".repeat(64)},${"c".repeat(64)}`]);
    const mod = await import(pathToFileURL(join(dir, "plugin.js")).href + `?v=${Math.random()}`);
    const { ctx, seen } = fakeHost(api, ALICE, []);
    const published = [];
    const types = [];
    const agentListeners = new Set();
    let running = [];
    const handle = {
        query: async () => published.map((p) => ({ ...p, pubkey: BOT })),
        publish: async (event) => { published.push(event); return { id: String(published.length).padStart(64, "0"), ...event }; },
    };
    ctx.agents = {
        ...ctx.agents,
        register: (t) => types.push(t),
        snapshot: () => ({ status: "ready", running, agents: running }),
        subscribe: (l) => { agentListeners.add(l); return () => agentListeners.delete(l); },
        handle: (pubkey) => (pubkey === BOT ? handle : undefined),
    };
    await mod.apply(ctx);
    assert.equal(types.length, 1);
    assert.equal(types[0].id, "bot");
    assert.equal(types[0].title, "Hive bot");
    assert.deepEqual(types[0].defaults(), { config: {} });

    // The owner creates HiveBot: it says hello in the channel, once.
    running = [{ pubkey: BOT, name: "HiveBot", type: "test-hive.hive/bot" }];
    agentListeners.forEach((l) => l());
    await new Promise((r) => setTimeout(r, 300));
    agentListeners.forEach((l) => l());
    await new Promise((r) => setTimeout(r, 100));
    const hellos = published.filter((e) => e.tags.some((t) => t[0] === "hive" && t[1] === "hello"));
    assert.equal(hellos.length, 1, "said once");
    assert.deepEqual(hellos[0].tags[0], ["h", channel]);
    assert.match(hellos[0].content, /^Hi, I'm HiveBot, this hive's bot\./);

    // A mention gets the hive's status in its thread.
    const mention = { id: "9".repeat(64), pubkey: ALICE, kind: 9, content: "@HiveBot where are we?", tags: [["h", channel]] };
    let ack = 0;
    await types[0].run({ trigger: { type: "mention", event: mention }, channelId: channel, agent: handle, config: {}, signal: new AbortController().signal,
        workingUntil() {}, acknowledged: () => { ack += 1; } });
    const reply = published.at(-1);
    assert.equal(ack, 1);
    assert.deepEqual(reply.tags, [["h", channel], ["e", mention.id, "", "root"], ["e", mention.id, "", "reply"], ["p", ALICE]]);
    assert.match(reply.content, /No proposal is open\./);
    let ignored = 0;
    await types[0].run({ trigger: { type: "wake" }, channelId: channel, agent: handle, config: {}, signal: new AbortController().signal, workingUntil() {}, ignored: () => { ignored += 1; } });
    assert.equal(ignored, 1, "only mentions are answered");
    seen.cleanups.forEach((stop) => stop());
});
