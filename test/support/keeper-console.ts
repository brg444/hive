import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { repositoryRoot } from "@hive/kit";

/**
 * The keeper console in a real browser, for tests that sign through it: the built console served
 * locally, and devices with a virtual passkey that supports PRF. Playwright is not one of this
 * repository's dependencies; these tests run where it is installed.
 */
// biome-ignore lint/suspicious/noExplicitAny: Playwright is typed loosely, as it is not a dependency
export type Page = any;
// biome-ignore lint/suspicious/noExplicitAny: as above
export const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: any };

export async function serveConsole(): Promise<{ url: string; close(): void }> {
  const site = mkdtempSync(join(tmpdir(), "hive-console-"));
  execFileSync("node", [join(repositoryRoot, "hive/hive-buzz/keeper/build.mjs"), site]);
  const server = http.createServer((req, res) => {
    const path = join(
      site,
      !req.url || req.url === "/" || req.url.startsWith("/?") ? "index.html" : req.url.slice(1),
    );
    try {
      res
        .writeHead(200, { "content-type": extname(path) === ".js" ? "text/javascript" : "text/html" })
        .end(readFileSync(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://localhost:${(server.address() as { port: number }).port}/`,
    close() {
      server.close();
      rmSync(site, { recursive: true, force: true });
    },
  };
}

/**
 * A keeper's device: a fresh browser profile with a passkey, on which the keeper creates their key and
 * saves its backup. `arkdUrl` is answered with the CORS header a public Operator sends.
 */
export async function keeperDevice(
  browser: Page,
  consoleUrl: string,
  arkdUrl: string,
  contextOptions: Record<string, unknown> = {},
) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  // A string, not a function: the test's own compiler would add helpers the page does not have.
  await page.addInitScript(
    "window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) });",
  );
  await page.route(`${arkdUrl}/**`, async (route: Page) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*" } });
  });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(consoleUrl);
  await page.getByRole("button", { name: "Create my key" }).click();
  await page.locator("#b-pass").fill("correct horse battery staple");
  await page.locator("#b-again").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Encrypt the backup" }).click();
  await page.getByRole("button", { name: "Save the backup file" }).click();
  await page
    .getByRole("heading", { name: "Your keeper key is ready" })
    .waitFor()
    .catch(async (error: Error) => {
      const shown = await page.locator("section:not([hidden]) h1").allTextContents();
      const messages = await page.locator(".msg").allTextContents();
      throw new Error(
        `${error.message}\nshown: ${shown.join(" | ")}\nmessages: ${messages.filter(Boolean).join(" | ")}`,
      );
    });
  const line = (await page.locator("#line").textContent()) ?? "";
  return { page, errors, key: line.replace("Hive keeper key: ", "").trim() };
}

/** Unlocks the console with the passkey and opens the hive's desk. */
export async function openDesk(page: Page, desk: string, hive: string) {
  await page.locator("#desk-url").fill(desk);
  await page.getByRole("button", { name: "Unlock and open" }).click();
  await page
    .getByRole("heading", { name: `${hive}: payments` })
    .waitFor({ timeout: 30_000 })
    .catch(async (error: Error) => {
      throw new Error(`${error.message}\n${await page.locator("#desk-msg").textContent()}`);
    });
}

/** Signs whatever the keeper is asked to sign for the first payment listed, and returns the console's answer. */
export async function signFirstPayment(page: Page, button: string) {
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("button", { name: button }).first().click();
  await page.locator("#act").click();
  const message = page.locator("#payment-msg");
  await page.waitForFunction(
    () => /^Signed\.|Nothing was signed/.test(document.getElementById("payment-msg")?.textContent ?? ""),
    null,
    { timeout: 60_000 },
  );
  const text = (await message.textContent()) ?? "";
  if (!text.startsWith("Signed.")) throw new Error(text);
  await page.getByRole("button", { name: "Back" }).click();
  return text;
}
