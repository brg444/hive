/**
 * Two keepers fund a job from their own keeper consoles in a real browser, each with a virtual
 * passkey: they create their keys, the hive's treasury is built from them, and through the signing
 * desk they sign the agent's funding request in turn, until the escrow holds the cap. The third
 * keeper signs the hive's listing from Node, the other two in their consoles.
 *
 *   node --import tsx test/keeper-console-e2e.ts      (needs Playwright's Chromium)
 *
 * With HIVE_SHOTS=<dir>, keeper A's console is also saved as screenshots there, for the docs.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, jobEscrow } from "@hive/ark";
import { hex, localPath, unhex } from "@hive/kit";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { startDesk } from "../tools/desk.js";
import { initHive, loadListing, opsPaths, proposeListing } from "../tools/ops.js";
import { startFakeNetwork } from "./support/fake-network.js";
import {
  chromium,
  keeperDevice,
  openDesk,
  serveConsole,
  signFirstPayment,
} from "./support/keeper-console.js";

const now = () => Math.floor(Date.now() / 1000);
const fake = await startFakeNetwork({ batchLifetimeSeconds: 4 * 86_400 });
const hive = `console-${randomUUID().slice(0, 8)}`;
const files = localPath("console-e2e", hive);
const site = await serveConsole();
const browser = await chromium.launch();
const shots = process.env.HIVE_SHOTS;
const shoot = async (page: { screenshot(o: object): Promise<unknown> }, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};

try {
  const a = await keeperDevice(
    browser,
    site.url,
    fake.deployment().arkdUrl,
    shots ? { deviceScaleFactor: 2, viewport: { width: 760, height: 900 } } : {},
    (page, name) => shoot(page, `keeper-console-${name}`),
  );
  await shoot(a.page, "keeper-console-key");
  const b = await keeperDevice(browser, site.url, fake.deployment().arkdUrl);
  const third = secp256k1.utils.randomSecretKey();
  const keepers = [a.key, b.key, hex(secp256k1.getPublicKey(third, true))] as [string, string, string];
  console.log(`- keys: ${keepers.map((k) => k.slice(0, 10)).join(", ")}`);
  const record = await initHive(hive, { network: "regtest", deployment: fake.deployment(), keepers }, {});
  fake.mint(record.treasuryScript, 50_000);
  const conn = await connect(record.deployment);
  const params = {
    agentPk: hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
    providerPk: hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
    treasuryProgram: record.treasuryScript.slice(4),
    deadline: now() + 36 * 3600,
    jobId: hex(randomBytes(32)),
  };
  const escrow = jobEscrow(conn, params);
  mkdirSync(files, { recursive: true });
  const agentLog = join(files, "agent.jsonl");
  const request = {
    job_id: params.jobId,
    address: escrow.address,
    cap_sats: 20_000,
    deadline: params.deadline,
    model: "qwen3-8b",
    price_msat_per_mtok: 2_000_000,
    provider_pk: params.providerPk,
    params,
  };
  writeFileSync(agentLog, `${JSON.stringify({ at: now(), event: "funding_requested", request })}\n`);
  const governance = join(files, "governance.json");
  const proposals = [{ id: "p-1", title: "Docs", budgetSats: 30_000, usedSats: 0, state: "running" }];
  writeFileSync(governance, JSON.stringify({ proposals }));
  const pending = proposeListing(hive, { name: "Open Lab", purpose: "Translate the docs" });
  const desk = await startDesk(hive, { agentLog, governance, tickMs: 60_000 }, {});

  // Keeper B opens the console first: their nonces reach the desk, so A has someone to sign with.
  await openDesk(b.page, desk.url, hive);
  await b.page.getByRole("button", { name: "Sign the listing" }).click();
  await b.page.locator("#listing-card").waitFor({ state: "hidden" });
  await openDesk(a.page, desk.url, hive);
  await a.page.getByRole("button", { name: "Sign the listing" }).click();
  await a.page.locator("#listing-card").waitFor({ state: "hidden" });
  await desk.desk.signListing(keepers[2], hex(schnorr.sign(unhex(pending.listingId), third)));
  assert.equal(loadListing(hive).body.name, "Open Lab");
  console.log("- the listing carries all three keepers' signatures");
  await shoot(a.page, "keeper-console-desk");

  // The console shows its own checks before anyone signs.
  await a.page.getByRole("button", { name: "Check and sign" }).click();
  for (const check of [
    "The address is the escrow the job's terms build.",
    "Unused funds go back to this hive's treasury.",
  ])
    assert.equal(await a.page.getByText(check).getAttribute("data-ok"), "true");
  await shoot(a.page, "keeper-console-check");
  await a.page.getByRole("button", { name: "Back" }).click();

  assert.match(await signFirstPayment(a.page, "Check and sign"), /you sign once more after them/);
  console.log("- keeper A checked and signed first");
  assert.match(await signFirstPayment(b.page, "Check and sign"), /The other keeper finishes it/);
  console.log("- keeper B checked and signed both remaining steps");
  assert.match(await signFirstPayment(a.page, "Finish: sign once more"), /on its way to the escrow/);
  await desk.desk.drive(params.jobId);
  assert.equal(desk.desk.payment(params.jobId)?.status, "done");
  assert.equal(fake.balance(escrow.pkScript), 20_000);
  console.log("- the escrow holds the job's cap: 20,000 sats");
  assert.deepEqual([...a.errors, ...b.errors], []);
  await desk.close();
  console.log("ok: two keepers funded a job from their consoles");
} finally {
  await browser.close();
  site.close();
  await fake.close();
  for (const p of [opsPaths(hive).local(), opsPaths(hive).secret(), files])
    rmSync(p, { recursive: true, force: true });
}
