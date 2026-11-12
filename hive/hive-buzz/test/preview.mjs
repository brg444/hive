// Render the plugin's page to HTML with stand-in values for Buzz's design tokens, for a screenshot.
// Data: the mainnet agent log, plus one sample funding request so the keepers' queue shows.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToString } from "react-dom/server";

const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "hive-preview-"));
const now = Math.floor(Date.now() / 1000);
const log = join(work, "agent.jsonl");
writeFileSync(log, readFileSync(join(root, "test/fixtures/mainnet-agent.jsonl"), "utf8") + [
    { at: now, event: "sent", to: "peer", message: { kind: "offer", job_id: "sample", model: "example/model-8b", cap_sats: 20000, deadline: now + 86400 } },
    { at: now, event: "funding_requested", request: { job_id: "sample", address: "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameexamplesampleescrowaddress", cap_sats: 20000, deadline: now + 86400, min_coin_expiry: now + 172800, provider_pk: "3c1d0b7e52" + "0".repeat(48) + "a91f04", provider_peer: "peer", model: "example/model-8b" } },
].map((e) => JSON.stringify(e)).join("\n") + "\n");
const port = 31000 + Math.floor(Math.random() * 1000);
const api = spawn("node", [join(root, "api/src/server.mjs"), "--name", "Hive", "--agent-log", log, "--port", String(port),
    "--treasury", process.argv[2], "--operator", "https://arkade.computer", "--lightning-address", "wise-comet@lnurl.arkade.sh",
    "--lnurl-token-file", process.argv[3]], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 800));
const dir = join(work, "plugin");
spawn("node", [join(root, "plugin/build.mjs"), "--api", "https://hive.example.org", "--name", "Hive", "--out", dir], { stdio: "ignore" }).on("exit", async () => {
    const mod = await import(pathToFileURL(join(dir, "hive.hive", "plugin.js")).href);
    const pages = [];
    mod.apply({
        react: React, pages: { register: (p) => pages.push(p) }, agents: { addTool: () => {} },
        notifications: { register: () => ({ submit: async () => {} }) }, effect: (fn) => { fn(); },
        host: { request: async ({ url }) => { const r = await fetch(`http://127.0.0.1:${port}` + new URL(url).pathname); return { status: r.status, headers: {}, body: await r.text() }; } },
    });
    const tools = [];
    // Load once through the page's own path, then render the loaded state.
    const Page = pages[0].component;
    renderToString(React.createElement(Page));
    await new Promise((r) => setTimeout(r, 4000));
    const body = renderToString(React.createElement(Page));
    writeFileSync(process.argv[4], `<!doctype html><meta charset=utf-8><style>
:root{--space-half:2px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-panel-inset:20px;--text-subtle:#6b6f76;--text-danger:#c4321c;--border-standard:#e6e6e3}
body{margin:0;background:#f7f7f5;color:#1d1f22;font:14px/1.45 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
h1{font-size:22px}h2{font-size:15px}code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}
.ui-card{background:#fff;border:1px solid var(--border-standard);border-radius:12px}
button{font:inherit;font-size:12.5px;padding:3px 10px;border-radius:8px;border:1px solid var(--border-standard);background:#fff}
</style><div style="max-width:760px;margin:0 auto">${body}</div>`);
    api.kill();
    process.exit(0);
});
