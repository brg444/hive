import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type TestContext, test } from "node:test";
import { accountCoins, arkAddress, connect, parseArkAddress, xOnly } from "@hive/ark";
import { faultCode, haltFile, haltReason, localPath, readJson, unhex } from "@hive/kit";
import { nostrTransport, type HiveView, readPurchase } from "@hive/hive";
import { claimEscrow, httpClaimDesk, QuoteDesk, startNostrSolver } from "@hive/provider";
import { quoteCostSats, signReceipt } from "@hive/protocol";
import { startLocalRelay } from "../../gates/support/relay.js";
import { signClaim } from "../../packages/provider/src/claim.js";
import {
  addProvider,
  approvePurchase,
  buyEscrow,
  haltNewWork,
  initHive,
  loadListing,
  opsPaths,
  renewalStatus,
  resumeNewWork,
  serveHost,
  serveHive,
  withdrawPayout,
  withdrawTreasury,
  writeListing,
} from "../../tools/ops.js";
import { type FakeNetwork, startFakeNetwork } from "../support/fake-network.js";
import { frozenSidecar } from "../support/hive-v4.js";

/**
 * The operator tool on v4: a hive is created with its renewal watch, buys from
 * its provider over RFQ, takes the provider's claim at its desk, and returns
 * its funds through approved sends.
 */
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return faultCode(error);
  }
};

async function setup(t: TestContext) {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 2 * 86_400 });
  t.after(() => fake.close());
  const hive = `ops-${randomUUID().slice(0, 8)}`;
  t.after(() => {
    rmSync(opsPaths(hive).local(), { recursive: true, force: true });
    rmSync(opsPaths(hive).secret(), { recursive: true, force: true });
  });
  const ctx = { transport: nostrTransport(5_000), inProcessStewards: true };
  const record = await initHive(hive, { network: "regtest", deployment: fake.deployment() }, ctx);
  return { fake, hive, ctx, record };
}

async function provider(t: TestContext, fake: FakeNetwork, hive: string, ctx: object) {
  const relay = await startLocalRelay();
  t.after(() => relay.close());
  const added = await addProvider(
    hive,
    "mesh",
    { model: "local-model", inputRate: "10000000000", outputRate: "10000000000", relay: relay.url },
    ctx,
  );
  const seed = readJson<{ rfq: string; workload: string }>(
    opsPaths(hive).secret("providers", "mesh", "seed.json"),
  );
  const solver = await startNostrSolver(
    new QuoteDesk({
      secretKey: unhex(seed.rfq),
      card: added.card,
      stateDirectory: opsPaths(hive).local("providers", "mesh", "solver"),
    }),
    unhex(seed.rfq),
  );
  t.after(() => solver.close());
  assert.equal(fake.watchesOf(added.payoutAddress).length, 1, "the payout wallet is watched for renewal");
  return added;
}

test("a hive is created with its renewal watch, buys over RFQ, and pays its provider's claim", async (t) => {
  const { fake, hive, ctx, record } = await setup(t);
  assert.equal(parseArkAddress(record.treasuryAddress).pkScript, record.treasuryScript);
  assert.equal(fake.watchesOf(record.treasuryAddress).length, 1);
  assert.deepEqual(await initHive(hive, { network: "regtest", deployment: fake.deployment() }, ctx), record);
  const { card, payoutAddress } = await provider(t, fake, hive, ctx);
  fake.mint(record.treasuryScript, 30_000);
  await approvePurchase(hive, "first", { provider: "mesh", capSats: "10000", timeoutSeconds: 3_600 }, ctx);
  const activation = await buyEscrow(hive, "first", { pair: "12" }, ctx);
  assert.equal(activation.coin.amountSats, 10_000);
  assert.equal(fake.balance(record.treasuryScript), 20_000);

  const served = await serveHive(hive, {}, ctx);
  t.after(() => served.close());
  const quote = readPurchase(opsPaths(hive).local("purchases", "first")).quote;
  const agent = readJson<{ receiptSecret: string }>(opsPaths(hive).secret("agent.json"));
  const owed = quoteCostSats(quote.body, "200", "300");
  const sidecarUrl = await frozenSidecar(t, {
    latestReceipt: signReceipt(
      { escrowId: quote.quoteId, amountSats: owed.toString() },
      unhex(agent.receiptSecret),
    ),
    cumulativeInputTokens: "200",
    cumulativeOutputTokens: "300",
  });
  const providerConfig = opsPaths(hive).secret("providers", "mesh", "provider.json");
  const { connect } = await import("@hive/ark");
  const outcome = await claimEscrow(await connect(record.deployment), quote, {
    stateDirectory: opsPaths(hive).local("escrows", "first", "claim"),
    sidecarUrl,
    bearerToken: "token",
    signer: { signClaim: (request) => signClaim(providerConfig, request) },
    desk: httpClaimDesk(`${served.url}/api/claim`),
    pollMs: 50,
  });
  assert.equal(outcome.kind, "paid");
  assert.equal(fake.balance(card.body.providerPayoutScript), Number(owed));
  const view = (await (await fetch(`${served.url}/api/view`)).json()) as HiveView;
  assert.equal(view.treasury.balanceSats, 30_000 - Number(owed));
  assert.deepEqual(
    view.escrows.map((e) => [e.status, e.capSats, e.close?.providerSats]),
    [["claimed", 10_000, Number(owed)]],
  );
  assert.match(payoutAddress, /^tark1/);

  // The desk refuses a claim for an escrow this hive never bought.
  const response = await fetch(`${served.url}/api/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote: { ...quote, quoteId: "00".repeat(32) }, receipt: {}, claimSignature: "" }),
  });
  assert.equal(response.status, 400);
});

test("a halted hive buys nothing new", async (t) => {
  const { fake, hive, ctx } = await setup(t);
  await provider(t, fake, hive, ctx);
  await approvePurchase(hive, "first", { provider: "mesh", capSats: "1000", timeoutSeconds: 3_600 }, ctx);
  const file = localPath("v4-test", randomUUID(), "HALT");
  process.env.BUZZ_HALT_FILE = file;
  t.after(() => {
    delete process.env.BUZZ_HALT_FILE;
    rmSync(dirname(file), { recursive: true, force: true });
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "incident");
  assert.equal(await code(buyEscrow(hive, "first", {}, ctx)), "HALTED");
});

test("a hive halts on its own, and a host serves it under its keepers' signed listing", async (t) => {
  const { fake, hive, ctx } = await setup(t);
  await provider(t, fake, hive, ctx);
  await approvePurchase(hive, "first", { provider: "mesh", capSats: "1000", timeoutSeconds: 3_600 }, ctx);
  // Another hive's switch is not this hive's.
  const other = haltFile(`other-${hive}`);
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, "elsewhere");
  t.after(() => rmSync(other, { force: true }));
  assert.equal(haltReason(hive), undefined);
  haltNewWork("keepers investigating", hive);
  t.after(() => resumeNewWork(hive));
  assert.equal(haltReason(hive), "keepers investigating");
  assert.equal(await code(buyEscrow(hive, "first", {}, ctx)), "HALTED");
  resumeNewWork(hive);
  assert.equal(haltReason(hive), undefined);

  // A host needs the hive's listing, signed by its three keepers and naming its own treasury.
  assert.equal(await code(serveHost([hive], {}, ctx)), "NO_LISTING");
  const listing = writeListing(hive, { name: "Ops Hive", purpose: "Inference for the tests." });
  assert.equal(loadListing(hive).listingId, listing.listingId);
  const served = await serveHost([hive], {}, ctx);
  t.after(() => served.close());
  const { hives } = (await (await fetch(`${served.url}/api/hives`)).json()) as {
    hives: { hive: string; listing: { body: { name: string } }; halted: boolean }[];
  };
  assert.deepEqual(
    hives.map((h) => [h.hive, h.listing.body.name, h.halted]),
    [[hive, "Ops Hive", false]],
  );
  const status = (await (await fetch(`${served.url}/h/${hive}/api/status`)).json()) as { hive: string };
  assert.equal(status.hive, hive);
});

test("a hive returns its funds through an approved withdrawal and a provider payout sweep", async (t) => {
  const { fake, hive, ctx, record } = await setup(t);
  const { card } = await provider(t, fake, hive, ctx);
  for (let i = 0; i < 18; i++) fake.mint(record.treasuryScript, 1_000);
  const to = arkAddress("regtest", fake.serverKey, `5120${randomBytes(32).toString("hex")}`);
  const sweep = await withdrawTreasury(hive, "out", { to, amount: "all", pair: "02" }, ctx);
  assert.equal(sweep.complete, true);
  assert.deepEqual(
    sweep.parts.map((p) => [p.status, p.plan.amount]),
    [
      ["done", 16_000],
      ["done", 2_000],
    ],
    "16 coins per send, then the rest",
  );
  assert.equal(fake.balance(parseArkAddress(to).pkScript), 18_000);
  assert.equal(fake.balance(record.treasuryScript), 0);

  // A withdrawal to another Operator's address is refused before any steward is asked.
  const foreign = arkAddress("regtest", fake.emulatorKey, `5120${randomBytes(32).toString("hex")}`);
  assert.equal(
    await code(withdrawTreasury(hive, "away", { to: foreign, amount: "1000" }, ctx)),
    "INVALID_DESTINATION",
  );

  fake.mint(card.body.providerPayoutScript, 4_000);
  const payout = await withdrawPayout(hive, "mesh", "earnings", { to, amount: "all" }, ctx);
  assert.equal(payout.complete, true);
  assert.equal(fake.balance(card.body.providerPayoutScript), 0);
  assert.equal(fake.balance(parseArkAddress(to).pkScript), 22_000);
  assert.equal(xOnly(fake.serverKey).length, 32);
});

test("coins waiting for their renewal stay out of withdrawals, and a disabled renewal template is reported", async (t) => {
  const { fake, hive, ctx, record } = await setup(t);
  assert.equal((await renewalStatus(record, ctx)).template, "active");
  fake.mint(record.treasuryScript, 3_000);
  fake.mint(record.treasuryScript, 5_000, { expiresInSeconds: 60 });
  const to = arkAddress("regtest", fake.serverKey, `5120${randomBytes(32).toString("hex")}`);
  assert.equal(
    await code(withdrawTreasury(hive, "early", { to, amount: "6000", pair: "01" }, ctx)),
    "COINS_RENEWING",
  );
  // An "all" sweep sends what it may and reports what waits.
  const sweep = await withdrawTreasury(hive, "rest", { to, amount: "all", pair: "01" }, ctx);
  assert.deepEqual(
    [sweep.complete, sweep.parts.map((p) => p.plan.amount), sweep.remainingSats, sweep.renewingSats],
    [false, [3_000], 5_000, 5_000],
  );
  // A template the delegatee disabled renews nothing, and the operator sees why.
  fake.disabledTemplates.add(record.renewalWatch.templateId);
  fake.tick();
  assert.equal(fake.balance(record.treasuryScript), 5_000, "the coin was not renewed");
  assert.equal((await renewalStatus(record, ctx)).template, "disabled");
  fake.disabledTemplates.clear();
  fake.tick();
  assert.equal(fake.balance(record.treasuryScript), 5_000, "renewed for no fee");
  assert.equal(
    (await accountCoins(await connect(record.deployment), record.treasuryScript, 1_200)).renewing.length,
    0,
  );
});

test("mainnet is refused: no delegatee is pinned for it", async (t) => {
  const hive = `ops-${randomUUID().slice(0, 8)}`;
  t.after(() => rmSync(opsPaths(hive).secret(), { recursive: true, force: true }));
  assert.equal(await code(initHive(hive, { network: "bitcoin" })), "MAINNET_DISABLED");
  process.env.BUZZ_MAINNET = "enabled";
  t.after(() => delete process.env.BUZZ_MAINNET);
  assert.equal(await code(initHive(hive, { network: "bitcoin" })), "NO_DELEGATEE");
});
