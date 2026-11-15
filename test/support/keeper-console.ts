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
 * A keeper's device: a fresh browser profile with a platform authenticator that supports PRF, on which
 * the keeper creates their keeper passkey. Returns the line's token: the keeper's Bitcoin key, the
 * passkey's P-256 key and its site. `arkdUrl` is answered with the CORS header a public Operator sends.
 */
export async function keeperDevice(
  browser: Page,
  consoleUrl: string,
  arkdUrl: string,
  contextOptions: Record<string, unknown> = {},
  /** Called on each screen of passkey creation, for screenshots. */
  onScreen: (page: Page, name: string) => Promise<void> = async () => {},
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
  await page.route(`${arkdUrl}/**`, async (route: Page) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*" } });
  });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("dialog", (d: Page) => d.accept());
  await page.goto(consoleUrl);
  await page.getByRole("heading", { name: "Create your keeper passkey" }).waitFor();
  await onScreen(page, "create");
  await page.getByRole("button", { name: "Create my keeper passkey" }).click();
  await page
    .getByRole("heading", { name: "Your keeper passkey is ready" })
    .waitFor()
    .catch(async (error: Error) => {
      const shown = await page.locator("section:not([hidden]) h1").allTextContents();
      const messages = await page.locator(".msg").allTextContents();
      throw new Error(
        `${error.message}\nshown: ${shown.join(" | ")}\nmessages: ${messages.filter(Boolean).join(" | ")}`,
      );
    });
  await onScreen(page, "key");
  const line = (await page.locator("#line").textContent()) ?? "";
  return { page, errors, line, key: line.replace("Hive keeper key: ", "").trim() };
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

/**
 * Approves the first payment whose button reads `button` with the keeper's passkey, after the
 * console's own checks, and returns the console's answer.
 */
export async function approveFirstPayment(page: Page, button: string, list = "#payment-list") {
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.locator(list).getByRole("button", { name: button }).first().click();
  await page.locator("#act").click();
  await page.waitForFunction(
    () => /^Approved\.|Nothing was approved/.test(document.getElementById("payment-msg")?.textContent ?? ""),
    null,
    { timeout: 60_000 },
  );
  const text = (await page.locator("#payment-msg").textContent()) ?? "";
  if (!text.startsWith("Approved.")) throw new Error(text);
  await page.getByRole("button", { name: "Back" }).click();
  return text;
}

/** Starts a withdrawal in the console and approves it with the keeper's passkey. */
export async function startWithdrawal(page: Page, address: string, amountSats: number) {
  await page.getByText("Withdraw from the treasury").first().click();
  await page.locator("#w-address").fill(address);
  await page.locator("#w-amount").fill(String(amountSats));
  await page.getByRole("button", { name: "Check and approve the withdrawal" }).click();
  await page.waitForFunction(
    () =>
      /^Approved\./.test(document.getElementById("payments-msg")?.textContent ?? "") ||
      Boolean(document.getElementById("withdraw-msg")?.textContent),
    null,
    { timeout: 60_000 },
  );
  const failed = (await page.locator("#withdraw-msg").textContent()) ?? "";
  if (failed) throw new Error(failed);
}
