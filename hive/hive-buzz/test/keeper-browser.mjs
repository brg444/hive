// The keeper console in a real browser, with a virtual passkey that supports PRF: create a key,
// save its backup, see the line to post, keep it across a reload, and restore it on another device.
//
//   node test/keeper-browser.mjs     (needs Playwright's Chromium)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { parseKeeperKey } from "../shared/proposal.mjs";
import { restore } from "../keeper/vault.mjs";

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
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    // The system's save dialog, as a stand-in: the first save is cancelled, later ones are kept.
    await page.addInitScript(() => {
        window.__saved = [];
        let cancelled = false;
        window.showSaveFilePicker = async ({ suggestedName }) => {
            if (!cancelled) { cancelled = true; throw new DOMException("The user aborted a request.", "AbortError"); }
            const chunks = [];
            return { createWritable: async () => ({ write: async (b) => chunks.push(await b.text()), close: async () => window.__saved.push({ name: suggestedName, text: chunks.join("") }) }) };
        };
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(url);
    return { context, page, errors };
}

const browser = await chromium.launch();
try {
    const a = await device(browser);
    await a.page.getByRole("button", { name: "Create my key" }).click();
    await a.page.getByRole("heading", { name: "Save a backup" }).waitFor();
    await a.page.locator("#b-pass").fill("correct horse battery staple");
    await a.page.locator("#b-again").fill("correct horse battery staple");
    await a.page.getByRole("button", { name: "Encrypt the backup" }).click();
    await a.page.getByRole("heading", { name: "Save your backup somewhere safe" }).waitFor();
    assert.match(await a.page.locator("#save-hint").textContent(), /iCloud Drive or your Google Drive folder/);
    await a.page.getByRole("button", { name: "Save the backup file" }).click();
    await a.page.getByText("The backup was not saved. Save it before you go on.").waitFor();
    await a.page.getByRole("button", { name: "Save the backup file" }).click();
    await a.page.getByRole("heading", { name: "Your keeper key is ready" }).waitFor();
    const [saved] = await a.page.evaluate(() => window.__saved);
    assert.match(saved.name, /^hive-keeper-backup-[0-9a-f]{8}\.json$/);
    const backupPath = join(site, "backup.json");
    writeFileSync(backupPath, saved.text);
    const line = await a.page.locator("#line").textContent();
    const key = parseKeeperKey(line);
    assert.ok(key, `a line HiveBot reads: ${line}`);
    console.log(`- created: ${line}`);
    const file = JSON.parse(readFileSync(backupPath, "utf8"));
    assert.equal(file.publicKey, key, "the backup is of that key");
    assert.equal((await restore(file, "correct horse battery staple")).length, 32);

    await a.page.reload();
    await a.page.getByRole("heading", { name: "Your keeper key is ready" }).waitFor();
    assert.equal(await a.page.locator("#line").textContent(), line, "kept on the device");
    // Another backup needs the passkey, which opens the stored key; without a save dialog or a
    // share sheet it downloads.
    await a.page.evaluate(() => { window.showSaveFilePicker = undefined; });
    await a.page.getByText("Save another backup").first().click();
    await a.page.locator("#a-pass").fill("another long passphrase");
    await a.page.locator("#a-again").fill("another long passphrase");
    await a.page.getByRole("button", { name: "Encrypt another backup" }).click();
    await a.page.getByRole("heading", { name: "Save your backup somewhere safe" }).waitFor();
    assert.match(await a.page.locator("#save-hint").textContent(), /Downloads folder/);
    const [second] = await Promise.all([a.page.waitForEvent("download"), a.page.getByRole("button", { name: "Save the backup file" }).click()]);
    const secondPath = join(site, "backup2.json");
    await second.saveAs(secondPath);
    assert.equal(JSON.parse(readFileSync(secondPath, "utf8")).publicKey, key);
    console.log("- second backup saved through the passkey");
    assert.deepEqual(a.errors, [], "no errors on the page");

    // Another device: restore from the backup, with a passkey of its own.
    const b = await device(browser);
    await b.page.getByRole("button", { name: "I have a backup" }).click();
    await b.page.locator("#r-file").setInputFiles(backupPath);
    await b.page.locator("#r-pass").fill("wrong passphrase here");
    await b.page.getByRole("button", { name: "Restore my key" }).click();
    await b.page.getByText("That passphrase does not open this backup.").waitFor();
    await b.page.locator("#r-pass").fill("correct horse battery staple");
    await b.page.getByRole("button", { name: "Restore my key" }).click();
    await b.page.getByRole("heading", { name: "Your keeper key is ready" }).waitFor();
    assert.equal(await b.page.locator("#line").textContent(), line, "the same key on the other device");
    console.log("- restored on another device");
    assert.deepEqual(b.errors, []);
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
