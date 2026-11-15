// The keeper console in a real browser, with a virtual passkey that supports PRF: create the keeper
// passkey, see the line to post, keep it across a reload, and find the same passkey again after the
// browser forgot it, as a keeper's other device finds a synced passkey.
//
//   node test/keeper-browser.mjs     (needs Playwright's Chromium)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { parseKeeperKey } from "../shared/proposal.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = new URL("..", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "hive-keeper-"));
execFileSync("node", [join(root, "keeper/build.mjs"), site]);
const server = http.createServer((req, res) => {
    const path = join(site, req.url === "/" ? "index.html" : req.url.slice(1));
    try {
        const body = readFileSync(path);
        res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript" }[extname(path)] ?? "application/octet-stream" }).end(body);
    } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/`;

async function device(browser) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(url);
    return { context, page, errors };
}

const browser = await chromium.launch();
try {
    const a = await device(browser);
    await a.page.getByRole("button", { name: "Create my keeper passkey" }).click();
    await a.page.getByRole("heading", { name: "Your keeper passkey is ready" }).waitFor();
    const line = await a.page.locator("#line").textContent();
    const token = parseKeeperKey(line);
    assert.ok(token, `a line HiveBot reads: ${line}`);
    const [bitcoinKey, passkey, siteName] = token.split(" ");
    assert.match(bitcoinKey, /^0[23][0-9a-f]{64}$/);
    assert.match(passkey, /^110[23][0-9a-f]{64}$/);
    assert.equal(siteName, "localhost", "the passkey's site");
    console.log(`- created: ${line}`);
    const stored = await a.page.evaluate(() => localStorage.getItem("hive-keeper/v2"));
    assert.ok(!/prf|secret/i.test(stored), "nothing secret is kept in the browser");

    await a.page.reload();
    await a.page.getByRole("heading", { name: "Your keeper passkey is ready" }).waitFor();
    assert.equal(await a.page.locator("#line").textContent(), line, "kept on the device");

    // The browser forgets it; the passkey, still in its manager, gives the same Bitcoin key again.
    a.page.once("dialog", (d) => d.accept());
    await a.page.getByRole("button", { name: "Forget the passkey in this browser" }).click();
    await a.page.getByRole("heading", { name: "Create your keeper passkey" }).waitFor();
    await a.page.getByRole("button", { name: "I made my passkey on another device" }).click();
    await a.page.getByRole("heading", { name: "Your keeper passkey is ready" }).waitFor();
    const again = JSON.parse(await a.page.evaluate(() => localStorage.getItem("hive-keeper/v2")));
    assert.equal(again.bitcoinKey, bitcoinKey, "the same Bitcoin key from the same passkey");
    assert.ok(await a.page.locator("#no-line").isVisible(), "the line stays with the device that made the passkey");
    console.log("- found the same passkey again");
    assert.deepEqual(a.errors, [], "no errors on the page");
    for (const theme of ["light", "dark"]) {
        await a.page.emulateMedia({ colorScheme: theme });
        await a.page.setViewportSize({ width: 760, height: 900 });
        await a.page.screenshot({ path: join(process.env.SHOTS ?? site, `keeper-${theme}.png`), fullPage: true });
    }
    console.log("PASSED");
} finally {
    await browser.close();
    server.close();
}
