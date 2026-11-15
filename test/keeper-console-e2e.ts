/**
 * Three keepers create their keeper passkeys in the keeper console in a real browser, each with a
 * virtual passkey that supports PRF, and the hive's v5 treasury is built from their lines: the host
 * issues its counter and the delegatee watches it for renewal. A member chips in. The hive's agent asks
 * for a job, and two keepers approve its funding in their consoles at the approvals desk, hours apart
 * if they like; the desk folds the chip-in into the treasury coin and pays the escrow the cap. The same
 * two then withdraw to an Arkade address each reads in their own console.
 *
 * Needs the regtest stack (arkd on 7070, the Emulator on 7073), the delegatee on 7090
 * (`tools/delegatee.sh`) and Playwright's Chromium:
 *
 *   node --experimental-eventsource --import tsx test/keeper-console-e2e.ts
 *
 * With HIVE_SHOTS=<dir>, keeper A's console is also saved as screenshots there, for the docs.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, jobEscrow, regtestDeployment } from "@hive/ark";
import { treasuryCoins, unitsOn } from "@hive/executor";
import { hex, localPath } from "@hive/kit";
import { type Keeper, keeperOf } from "@hive/treasury";
import { schnorr } from "@noble/curves/secp256k1.js";
import { startApprovalDesk } from "../tools/approvals-desk.js";
import { initHive } from "../tools/ops.js";
import { issuerWallet, v5Contract, v5Terms } from "../tools/treasury-v5.js";
import {
  approveFirstPayment,
  chromium,
  keeperDevice,
  openDesk,
  serveConsole,
  startWithdrawal,
} from "./support/keeper-console.js";
import { newWallet, sendOffchain, waitFor } from "./support/treasury-sdk.js";

const now = () => Math.floor(Date.now() / 1000);
const deployment = regtestDeployment();
const hive = `console-${randomUUID().slice(0, 8)}`;
const files = localPath("console-e2e", hive);
mkdirSync(files, { recursive: true });
const site = await serveConsole();
const browser = await chromium.launch({ args: ["--proxy-server=direct://"] });
const shots = process.env.HIVE_SHOTS;
const shoot = async (page: { screenshot(o: object): Promise<unknown> }, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};
const step = (name: string, detail: Record<string, unknown> = {}) =>
  console.log(`- ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
let desk: Awaited<ReturnType<typeof startApprovalDesk>> | null = null;

try {
  // 1. Three keepers make their passkeys; the hive's treasury is built from their lines.
  const a = await keeperDevice(
    browser,
    site.url,
    deployment.arkdUrl,
    shots ? { deviceScaleFactor: 2, viewport: { width: 760, height: 900 } } : {},
    (page, name) => shoot(page, `keeper-console-${name}`),
  );
  const b = await keeperDevice(browser, site.url, deployment.arkdUrl);
  const c = await keeperDevice(browser, site.url, deployment.arkdUrl);
  const keepers = [a, b, c].map((d) => keeperOf(d.key)) as [Keeper, Keeper, Keeper];
  assert.ok(
    keepers.every((k) => k?.site === "localhost"),
    "each line names its passkey's site",
  );
  step("keepers' lines", { lines: [a, b, c].map((d) => `${d.line.slice(0, 32)}…`) });

  const issuer = await issuerWallet(deployment);
  if ((await issuer.getBalance()).available < 5_000) {
    sendOffchain(await issuer.getAddress(), 20_000);
    await waitFor("the host's issuer funds", async () => (await issuer.getBalance()).available >= 5_000);
  }
  const record = await initHive(hive, {
    network: "regtest",
    deployment,
    passkeys: keepers,
    renewalWindowSeconds: 600,
  });
  const counter = record.passkeys!.counter;
  step("treasury built from the keepers' passkeys", {
    address: record.treasuryAddress,
    counter: counter.assetId,
    renewal: record.renewalWatch,
  });

  // 2. A member chips in, beside the treasury coin.
  sendOffchain(record.treasuryAddress, 60_000);
  const { contract } = await v5Contract(deployment, v5Terms(record.passkeys!));
  await waitFor(
    "the chip-in",
    async () => (await treasuryCoins(contract, counter.assetId)).others.length > 0,
  );
  step("chip-in landed");

  // 3. The agent asks for a job, within a running proposal's budget.
  const conn = await connect(deployment);
  const jobId = hex(randomBytes(32));
  const deadline = now() + 3600;
  const params = {
    agentPk: hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
    providerPk: hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
    treasuryProgram: record.treasuryScript.slice(4),
    deadline,
    jobId,
  };
  const escrow = jobEscrow(conn, params);
  const agentLog = join(files, "agent.jsonl");
  const governance = join(files, "governance.json");
  writeFileSync(
    governance,
    JSON.stringify({
      proposals: [{ id: "p1", title: "Docs answers", budgetSats: 50_000, usedSats: 0, state: "running" }],
    }),
  );
  writeFileSync(
    agentLog,
    `${JSON.stringify({
      event: "funding_requested",
      at: now(),
      request: {
        job_id: jobId,
        address: escrow.address,
        cap_sats: 20_000,
        deadline,
        model: "hive-test",
        price_msat_per_mtok: 1_000_000,
        provider_pk: params.providerPk,
        provider_peer: "peer",
        params,
      },
    })}\n`,
  );
  desk = await startApprovalDesk(hive, {
    agentLog,
    governance,
    tickMs: 3000,
    deadlineMarginSeconds: 60,
    minimumValiditySeconds: 60,
  });
  step("desk open", { url: desk.url });

  // 4. Two keepers approve the job's funding, each in their own console.
  await openDesk(a.page, desk.url, hive);
  await shoot(a.page, "keeper-console-payments");
  assert.match(await approveFirstPayment(a.page, "Check and approve"), /Another keeper approves next/);
  await openDesk(b.page, desk.url, hive);
  assert.match(await approveFirstPayment(b.page, "Check and approve"), /Two keepers have approved/);
  step("two keepers approved the job");
  await waitFor("the job funded", () => desk?.desk.payment(jobId)?.status === "done", 180);
  const funded = await waitFor("the escrow's coin", async () => {
    const coins = await conn.arkd.coins({ scripts: [escrow.pkScript], spendableOnly: true });
    return coins.find((coin) => coin.amount === 20_000);
  });
  step("escrow funded", { txid: desk.desk.payment(jobId)?.txid, amount: funded.amount });

  // The third keeper's console has nothing left to approve, and the desk refuses a second start.
  await openDesk(c.page, desk.url, hive);
  await c.page.getByRole("button", { name: "Refresh" }).click();
  assert.equal(
    await c.page.locator("#payment-list").getByRole("button", { name: "Check and approve" }).count(),
    0,
  );
  await assert.rejects(
    fetch(`${desk.url}/desk/v1/payments/${jobId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: { authenticatorData: "", clientDataJSON: "{}", signature: "" } }),
    }).then(async (r) => (r.ok ? r : Promise.reject(new Error((await r.json()).error)))),
  );
  step("nothing more to approve, and a bare approval refused");

  // 5. A withdrawal to a member's Arkade wallet, read and approved by two keepers.
  const member = await newWallet(deployment.arkdUrl, deployment.emulatorUrl!);
  await startWithdrawal(a.page, await member.getAddress(), 5_000);
  await shoot(a.page, "keeper-console-withdrawal");
  assert.match(
    await approveFirstPayment(b.page, "Check and approve", "#withdrawal-list"),
    /Two keepers have approved/,
  );
  await waitFor("the withdrawal paid", async () => (await member.getBalance()).available >= 5_000, 180);
  const coin = (await treasuryCoins(contract, counter.assetId)).treasury!;
  assert.equal(
    unitsOn(coin, counter.assetId),
    BigInt(record.passkeys!.supply) - 2n,
    "two payments, two units",
  );
  step("withdrawal paid", { treasury: coin.value, units: String(unitsOn(coin, counter.assetId)) });
  for (const d of [a, b, c]) assert.deepEqual(d.errors, [], "no errors in the consoles");
  console.log("PASSED");
} finally {
  await desk?.close();
  await browser.close();
  site.close();
}
process.exit(0);
