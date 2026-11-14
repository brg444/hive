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
    const seen = { pages: [], tools: [], notifications: [], categories: [], requests: [], cleanups: [], messages: [], composer: [], accessories: [], opened: [], settings: [] };
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
        settingsCards: { register: (c) => seen.settings.push(c) },
        agents: { addTool: (t) => seen.tools.push(t) },
        notifications: {
            register: (c) => { seen.categories.push(c); return { submit: async (n) => { seen.notifications.push(n); } }; },
        },
        host: {
            // Like Buzz: only the declared origin, a string body back.
            request: async ({ url, method, headers, body, timeoutMs }) => {
                assert.ok(url.startsWith(ORIGIN + "/"), `undeclared origin ${url}`);
                assert.ok(!timeoutMs || timeoutMs <= 180_000);
                seen.requests.push(method && method !== "GET" ? `${method} ${url}` : url);
                const res = await fetch(apiBase + url.slice(ORIGIN.length), { method: method ?? "GET", headers, body });
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
    for (const text of ["Treasury", "wise-comet@lnurl.arkade.sh", "No job is waiting for funding.", "Paid", "paid ₿1,380, returned ₿620", "earned ₿1,380"]) {
        assert.ok(html.includes(text), `page shows ${text}`);
    }
    assert.equal(seen.notifications.length, 0, "nothing to fund, nothing announced");
    seen.cleanups.forEach((stop) => stop());
});

test("Settings: a member picks how amounts read, and the page follows on this device", async () => {
    const api = await startApi(join(root, "test/fixtures/mainnet-agent.jsonl"));
    const store = new Map([["hive.amounts.v1", "btc"]]);
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });
    try {
        const { seen } = await activate(api);
        assert.equal(seen.settings.length, 1, "one settings card");
        const card = renderToString(React.createElement(seen.settings[0].component, { active: () => true }));
        for (const t of ["Amounts", "₿", "sats", "BTC", "US dollars", "Spiral"]) assert.ok(card.includes(t), `settings show ${t}`);
        // The agent's tools keep sats, whatever the member reads; asking also loads the hive.
        assert.match(await seen.tools.find((t) => t.name === "hive_status").call({}), /earned 1,380 sats/);
        const money = ["money"].map((initialTab) => renderToString(React.createElement(seen.pages[0].component, { initialTab }))).join("");
        assert.ok(money.includes("earned 0.0000138 BTC"), `amounts in BTC: ${money.match(/earned[^<]*/)}`);
        seen.cleanups.forEach((stop) => stop());
    } finally {
        if (previous) Object.defineProperty(globalThis, "localStorage", previous);
        else delete globalThis.localStorage;
    }
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
    assert.ok(html.includes("₿2,000 for example/model"), "the request is listed");
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
    assert.ok(html.includes("Budgets in use") && html.includes("p-test") && html.includes("₿1,380 used"), "budget card");
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
    for (const t of ["Translate the docs", "₿30,000", "Running", "👍 1", "2 of 2 keepers", "₿2,000 a day"]) assert.ok(cardHtml.includes(t), `card shows ${t}`);

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
    for (const t of ["Propose work to Test Hive", "Purpose and output", "Budget in ₿", "Who uses it", "Add to message"]) assert.ok(form.includes(t), `form shows ${t}`);
    assert.equal(renderToString(React.createElement(seen.accessories[0].component, { channelId: "elsewhere" })), "", "only in the hive's channel");
    assert.equal(inserted, null, "nothing goes into the message until the form is filled in");
    el.props.onClick();

    // The page: Bob is a member with a node, and the running proposal is for everyone.
    const home = renderToString(React.createElement(seen.pages[0].component, {}));
    for (const t of ["Your allowances", "Translate the docs", "₿2,000 a day", "Nightly triage", "closes in 23 h"]) assert.ok(home.includes(t), `page shows ${t}`);
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
    for (const t of ["Your allowances", "Weekly summaries", "₿700 a day", "Your node"]) assert.ok(home.includes(t), `page shows ${t}`);
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
    const dir = build(["--channel", channel, "--keepers", `${"a".repeat(64)},${"c".repeat(64)}`, "--docs", `${ORIGIN}/docs/hive-docs.md`]);
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
    assert.match(reply.content, /the community owner can add a guide: mention me with “add a guide”\.$/);
    let ignored = 0;
    await types[0].run({ trigger: { type: "wake" }, channelId: channel, agent: handle, config: {}, signal: new AbortController().signal, workingUntil() {}, ignored: () => { ignored += 1; } });
    assert.equal(ignored, 1, "only mentions are answered");

    // The owner adds a guide: a Goose agent with the hive's instructions, for the owner to review.
    const created = [];
    handle.owner = ALICE;
    handle.createAgent = async (input) => { created.push(input); return { requestId: "r1", saved: false }; };
    const mentionRun = (content) => types[0].run({ trigger: { type: "mention", event: { id: String(published.length + 100).padStart(64, "0"), pubkey: ALICE, kind: 9, content, tags: [["h", channel]] } },
        channelId: channel, agent: handle, config: {}, signal: new AbortController().signal, workingUntil() {}, acknowledged() {} });
    await mentionRun("@HiveBot add a guide please");
    assert.equal(created.length, 1);
    assert.equal(created[0].type, "buzz.goose/goose");
    assert.equal(created[0].name, "Hive guide");
    assert.match(created[0].instructions, /call hive_guide/);
    assert.match(published.at(-1).content, /^I've asked Buzz to create Hive guide/);

    // With the guide running, questions go to it in the thread; status stays HiveBot's.
    const woken = [];
    running = [...running, { key: "guide-key", pubkey: "9a".repeat(32), name: "Hive guide", owner: ALICE, type: "buzz.goose/goose" }];
    ctx.agents.wake = (key, wake) => woken.push({ key, wake });
    const before = published.length;
    await mentionRun("@HiveBot how do I back up my keeper key?");
    assert.equal(woken.length, 1);
    assert.equal(woken[0].key, "guide-key");
    assert.equal(woken[0].wake.channel, channel);
    assert.match(woken[0].wake.text, /how do I back up my keeper key\?/);
    assert.deepEqual(published.slice(before).map((e) => e.kind), [7], "HiveBot only marks the question as seen");
    await mentionRun("@HiveBot status");
    assert.equal(woken.length, 1, "status is HiveBot's own");
    assert.match(published.at(-1).content, /No proposal is open\.$/);

    // The tools any agent here can use, the guide included.
    const tool = (name) => seen.tools.find((t) => t.name === name);
    assert.match(await tool("hive_guide").call(), /^This hive: Test Hive\. It has 2 keepers, any 2 of whom approve/);
    assert.match(await tool("hive_guide").call(), /iCloud Drive or Google Drive/);
    assert.equal(await tool("hive_proposals").call(), "No proposal has been posted in the hive's channel yet.");

    // The repository's docs, a section at a time, from the hive's own origin.
    const docs = ["<!-- source: README.md -->", "", "# Hive", "", "A shared treasury.", "", "## Safeguards", "", "One keeper alone moves nothing.",
        "", "<!-- source: hive/pay-arkade/README.md -->", "", "## Mainnet", "", "Providers name the peers they serve."].join("\n");
    const fetched = [];
    const request = ctx.host.request;
    ctx.host.request = async (r) => { if (r.url.endsWith("/docs/hive-docs.md")) { fetched.push(r.url); return { status: 200, headers: {}, body: docs }; } return request(r); };
    const safeguards = await tool("hive_docs").call(null, null, { topic: "what are the safeguards" });
    assert.match(safeguards, /^## Safeguards \(README\.md\)\n\nOne keeper alone moves nothing\./);
    assert.ok(!safeguards.includes("Providers name"), "only what the topic needs");
    assert.match(await tool("hive_docs").call(null, null, {}), /- hive\/pay-arkade\/README\.md: Mainnet/);
    assert.match(await tool("hive_docs").call(null, null, { topic: "zebra" }), /^Nothing in the docs mentions zebra\./);
    assert.equal(fetched.length, 1, "read once, then kept a while");
    assert.equal(fetched[0], `${ORIGIN}/docs/hive-docs.md`);

    // The owner gives an existing guide the current instructions.
    const updates = [];
    handle.updateAgent = async (input) => { updates.push(input); return { requestId: "u1", saved: false }; };
    await mentionRun("@HiveBot update the guide");
    assert.equal(updates[0].agent, "Hive guide");
    assert.match(updates[0].instructions, /call hive_docs with a topic/);
    seen.cleanups.forEach((stop) => stop());
});

test("HiveBot onboarding: the owner asks it to set up, keepers volunteer with ✅, the owner confirms, and it walks the channel to the first proposal", async () => {
    const { formatProposal } = await import("../shared/proposal.mjs");
    const channel = "5e1f0c2a-7d3b-4e8f-9a6c-1b2d3e4f5a6b";
    const BOT = "b0".repeat(32), OWNER = "0e".repeat(32), KA = "a1".repeat(32), KB = "b2".repeat(32);
    const api = await startApi(join(root, "test/fixtures/gateway-agent.jsonl"), ["--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3", "--operator", "http://127.0.0.1:9"]);
    const dir = build(["--install", "https://github.com/example/hive#plugin", "--console", "https://keepers.example.org"]);
    const mod = await import(pathToFileURL(join(dir, "plugin.js")).href + `?v=${Math.random()}`);
    const { ctx, seen } = fakeHost(api, OWNER, []);
    // The community, as the bot reads and writes it.
    let clock = Math.floor(Date.now() / 1000) - 3600, n = 0;
    const events = [];
    const add = (pubkey, kind, content, tags) => { const e = { id: (++n).toString(16).padStart(64, "0"), pubkey, kind, content, created_at: ++clock, tags: [["h", channel], ...tags] }; events.push(e); return e; };
    const matches = (e, f) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (!f["#h"] || (e.tags ?? []).some((t) => t[0] === "h" && f["#h"].includes(t[1])));
    events.push({ id: "f".repeat(64), pubkey: KA, kind: 0, content: JSON.stringify({ display_name: "Ari" }), created_at: 1, tags: [] });
    const handle = {
        pubkey: BOT, name: "HiveBot", owner: OWNER,
        query: async (filters) => events.filter((e) => filters.some((f) => matches(e, f))),
        publish: async (t) => add(BOT, t.kind, t.content, t.tags.filter((tag) => tag[0] !== "h")),
    };
    const types = [];
    const agentListeners = new Set();
    ctx.agents = { ...ctx.agents, register: (t) => types.push(t), snapshot: () => ({ running: [{ pubkey: BOT, name: "HiveBot", owner: OWNER, type: "test-hive.hive/bot" }] }),
        subscribe: (l) => { agentListeners.add(l); return () => agentListeners.delete(l); }, handle: (k) => (k === BOT ? handle : undefined) };
    await mod.apply(ctx);
    const pass = async () => { agentListeners.forEach((l) => l()); await new Promise((r) => setTimeout(r, 150)); };
    const run = (event) => types[0].run({ trigger: { type: "mention", event }, channelId: channel, agent: handle, config: {}, signal: new AbortController().signal, workingUntil() {}, acknowledged() {} });
    const fromBot = (key) => events.find((e) => e.pubkey === BOT && e.tags.some((t) => t[0] === "hive" && t[1] === key));

    await run(add(KA, 9, "@HiveBot set up a hive here", [["p", BOT]]));
    assert.match(events.at(-1).content, /^Only the member who created me/, "only the owner starts it");
    await run(add(OWNER, 9, "@HiveBot set up a hive here with 2 keepers", [["p", BOT]]));
    const call = fromBot("call");
    assert.ok(call, "the keeper call");
    assert.match(call.content, /^Hi, I'm HiveBot\./);
    assert.match(call.content, /It needs 2\.$/);

    add(KA, 7, "✅", [["e", call.id]]);
    add(KB, 7, "✅", [["e", call.id]]);
    await pass();
    const confirm = fromBot("confirm");
    assert.ok(confirm, "asks the owner to confirm");
    assert.match(confirm.content, /^2 keepers so far: @Ari and @b2b2b2b2\./);
    await pass();
    assert.equal(events.filter((e) => e.pubkey === BOT && e.tags.some((t) => t[1] === "confirm")).length, 1, "said once across passes");

    add(OWNER, 7, "✅", [["e", confirm.id]]);
    await pass();
    const plugin = fromBot("plugin");
    assert.deepEqual(plugin.tags.filter((t) => t[0] === "p").map((t) => t[1]), [KA, KB], "the keepers, as the record");
    assert.match(plugin.content, /Add from Git, with https:\/\/github\.com\/example\/hive and the branch plugin\./);
    assert.match(fromBot("keys").content, /in the keeper console at https:\/\/keepers\.example\.org\./);
    assert.ok(fromBot("propose") && !fromBot("treasury"), "the treasury waits for the keepers' keys");
    const keyA = add(KA, 9, `Hive keeper key: 02${"a".repeat(64)}`, []);
    await pass();
    // Each key is answered in its thread, once.
    const ackA = events.find((e) => e.pubkey === BOT && e.tags.some((t) => t[0] === "hive" && t[1] === "key-ack" && t[2] === keyA.id));
    assert.equal(ackA.content, "Got it, @Ari: your keeper key is in. 1 of 2 keepers have posted theirs.");
    assert.ok(ackA.tags.some((t) => t[0] === "e" && t[1] === keyA.id), "in the key's thread");
    const outsider = add(OWNER, 9, `Hive keeper key: 02${"0".repeat(64)}`, []);
    add(KB, 9, `Hive keeper key: 03${"b".repeat(64)}`, []);
    await pass();
    await pass();
    const acks = events.filter((e) => e.pubkey === BOT && e.tags.some((t) => t[0] === "hive" && t[1] === "key-ack"));
    assert.equal(acks.length, 3, "one answer per post, never twice");
    assert.match(acks.find((e) => e.tags.some((t) => t[2] === outsider.id)).content, /only this hive's keepers post treasury keys here, so this one doesn't count\./);
    assert.match(acks.at(-1).content, /2 of 2 keepers have posted theirs, so every key is in\.$/);
    assert.match(fromBot("keys-in").content, /^All 2 keys are in, from @Ari and @b2b2b2b2\./);
    assert.ok(fromBot("treasury"));

    add(KB, 9, formatProposal({ title: "Weekly summaries", budgetSats: 12000, start: null, end: null, who: "everyone", allowanceSats: 500, purpose: "A weekly summary.", work: "", provider: "", report: "" }), []);
    await pass();
    assert.match(fromBot("done").content, /^The first proposal is in: “Weekly summaries”/);
    const count = events.length;
    await pass();
    assert.equal(events.length, count, "nothing more once the setup is done");
    seen.cleanups.forEach((stop) => stop());
});

test("each member's plugin forwards the channel's signed events, and the host works out the hive from them", async () => {
    const { schnorr } = await import("@noble/curves/secp256k1");
    const { sha256 } = await import("@noble/hashes/sha2");
    const { bytesToHex } = await import("@noble/hashes/utils");
    const { formatProposal } = await import("../shared/proposal.mjs");
    const channel = "5a0c1e2d-0000-4000-8000-00000000c0de";
    const keys = [1, 2, 3].map(() => schnorr.utils.randomPrivateKey());
    const pub = (k) => bytesToHex(schnorr.getPublicKey(k));
    const [K0, K1, ALICE] = keys.map(pub);
    const now = Math.floor(Date.now() / 1000);
    const sign = (key, kind, content, at, tags = []) => {
        const e = { pubkey: pub(key), created_at: at, kind, tags: [["h", channel], ...tags], content };
        e.id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
        e.sig = bytesToHex(schnorr.sign(e.id, key));
        return e;
    };
    const proposal = sign(keys[2], 9, formatProposal({ title: "Docs in Spanish", budgetSats: 15000, start: null, end: null, who: "everyone", allowanceSats: 500,
        purpose: "Translate the docs.", work: "", provider: "", report: "" }), now - 600);
    const events = [
        proposal,
        sign(keys[0], 7, "✅", now - 300, [["e", proposal.id]]),
        sign(keys[1], 7, "✅", now - 200, [["e", proposal.id]]),
        sign(keys[2], 9, `Hive node: ${"ef".repeat(32)}`, now - 100),
        sign(keys[0], 9, `Hive keeper key: 02${"11".repeat(32)}`, now - 90),
        // Pending on this device, not yet signed by the relay's view: never forwarded.
        { id: "f".repeat(64), pubkey: ALICE, created_at: now, kind: 9, tags: [["h", channel]], content: "draft", delivery: "pending" },
    ];
    const gov = join(work, `gov-${Math.random()}.json`);
    const members = join(work, `members-${Math.random()}.json`);
    const api = await startApi(join(root, "test/fixtures/gateway-agent.jsonl"), ["--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3",
        "--operator", "http://127.0.0.1:9", "--channel", channel, "--keepers", `${K0},${K1}`, "--governance", gov, "--members-file", members, "--discussion-minutes", "5"]);
    const { seen } = await activate(api, ALICE, events, ["--channel", channel, "--keepers", `${K0},${K1}`]);
    for (let i = 0; i < 40 && !seen.requests.some((r) => r.startsWith("POST ")); i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(seen.requests.includes(`POST ${ORIGIN}/hive/v1/channel`), "the plugin forwarded the channel");
    const governance = JSON.parse(readFileSync(gov, "utf8"));
    const p = governance.proposals.find((x) => x.title === "Docs in Spanish");
    assert.equal(p.state, "running", "approved after the test hive's five-minute discussion");
    assert.deepEqual(governance.keeperKeys, [`02${"11".repeat(32)}`, null]);
    assert.deepEqual(JSON.parse(readFileSync(members, "utf8")).members, { ["ef".repeat(32)]: { name: ALICE.slice(0, 12), proposal: p.id, allowance_sats_per_day: 500 } });
    // A forged or edited event is refused; the draft never left the device.
    const forged = { ...events[1], id: "ab".repeat(32), content: "❌" };
    const res = await fetch(`${api}/hive/v1/channel`, { method: "POST", body: JSON.stringify({ events: [forged] }) });
    assert.deepEqual(await res.json(), { added: 0, refused: 1, events: 5, proposals: null });
    seen.cleanups.forEach((stop) => stop());
});

test("a new hive's host runs before its treasury, learns the keepers from HiveBot's record, and every plugin forwards to it", async () => {
    const { schnorr } = await import("@noble/curves/secp256k1");
    const { sha256 } = await import("@noble/hashes/sha2");
    const { bytesToHex } = await import("@noble/hashes/utils");
    const channel = "6b1d2e3f-0000-4000-8000-0000000000aa";
    const [bot, k0, k1, k2] = [1, 2, 3, 4].map(() => schnorr.utils.randomPrivateKey());
    const pub = (k) => bytesToHex(schnorr.getPublicKey(k));
    const now = Math.floor(Date.now() / 1000);
    const sign = (key, kind, content, at, tags = []) => {
        const e = { pubkey: pub(key), created_at: at, kind, tags: [["h", channel], ...tags], content };
        e.id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
        e.sig = bytesToHex(schnorr.sign(e.id, key));
        return e;
    };
    const keys = [k0, k1, k2].map((_, i) => `0${2 + (i % 2)}${String(i + 1).repeat(64)}`);
    const events = [
        sign(bot, 9, "Keepers are set.", now - 900, [["hive", "plugin"], ["p", pub(k0)], ["p", pub(k1)], ["p", pub(k2)]]),
        ...[k0, k1, k2].map((k, i) => sign(k, 9, `Hive keeper key: ${keys[i]}`, now - 800 + i)),
    ];
    const gov = join(work, `gov-${Math.random()}.json`);
    const api = await startApi(join(root, "test/fixtures/gateway-agent.jsonl"), ["--operator", "http://127.0.0.1:9",
        "--channel", channel, "--bot", pub(bot), "--governance", gov, "--discussion-minutes", "10"]);
    const before = await (await fetch(`${api}/hive/v1/state`)).json();
    assert.equal(before.treasury, null, "no treasury yet");
    assert.equal(before.governance.channelId, channel, "the channel is named before anything is forwarded");
    // A plugin built with no channel of its own learns it from the host, and forwards it.
    const { seen } = await activate(api, pub(k0), events);
    for (let i = 0; i < 40 && !seen.requests.some((r) => r.startsWith("POST ")); i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 500));
    const governance = JSON.parse(readFileSync(gov, "utf8"));
    assert.deepEqual(governance.keepers, [pub(k0), pub(k1), pub(k2)], "the keepers HiveBot recorded, in its order");
    assert.deepEqual(governance.keeperKeys, keys, "each keeper's treasury key, in the same order");
    assert.equal(governance.discussionSeconds, 600);
    seen.cleanups.forEach((stop) => stop());
});

test("on the shared Hive service, one plugin finds its community's hive by its channel", async () => {
    const channel = "7d2e3f4a-0000-4000-8000-0000000000bb";
    const asked = [];
    const server = http.createServer((req, res) => {
        asked.push(`${req.method} ${req.url}`);
        if (req.url.startsWith("/hives")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hives: [] }));
        if (req.url === `/c/${channel}/hive/v1/state`)
            return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ v: 1, name: "Open Lab", treasury: null, funding: [], jobs: [], providers: [],
                payouts: [], contributions: [], proposals: [], governance: { channelId: channel, keepers: [], threshold: 2, smallSats: 20000, proposals: [], members: {} } }));
        res.writeHead(404).end("{}");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = execFileSync("node", [join(root, "plugin/build.mjs"), "--service", ORIGIN, "--name", "Hive", "--out", work]).toString().trim();
    const mod = await import(pathToFileURL(join(dir, "plugin.js")).href + `?v=${Math.random()}`);
    const { ctx, seen } = fakeHost(base, "a".repeat(64), []);
    await mod.apply(ctx);
    try {
    for (let i = 0; i < 30 && !asked.some((a) => a.startsWith("GET /hives")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(asked.some((a) => a.startsWith("GET /hives?community=")), "asks the service for its community's hives");
    // Shown the hive's channel, it finds the hive there and loads its state.
    renderToString(React.createElement(seen.accessories[0].component, { channelId: "00000000-0000-4000-8000-000000000000" }));
    renderToString(React.createElement(seen.accessories[0].component, { channelId: channel }));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(asked.includes(`GET /c/${channel}/hive/v1/state`), "loads the hive's state under its channel");
    const status = await seen.tools[0].call();
    assert.match(status, /Open Lab/);
    } finally {
        seen.cleanups.forEach((stop) => stop());
        server.close();
    }
});
