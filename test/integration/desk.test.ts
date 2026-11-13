import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type TestContext, test } from "node:test";
import { connect, jobEscrow } from "@hive/ark";
import { faultCode, hex, localPath, unhex } from "@hive/kit";
import {
  checkPayment,
  deskAuthDigest,
  keeperView,
  nonceBatch,
  type SecretNonce,
  type SessionRequest,
  signOver,
  signShared,
} from "@hive/steward";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { type DeskAuth, startDesk } from "../../tools/desk.js";
import { initHive, loadListing, opsPaths, proposeListing } from "../../tools/ops.js";
import { startFakeNetwork } from "../support/fake-network.js";

/**
 * The signing desk between a keepers' hive and their consoles: it plans a payment for the job the
 * agent asked to fund, and two keepers sign it hours apart, each checking it themselves first, until
 * the escrow holds exactly the cap.
 */
const now = () => Math.floor(Date.now() / 1000);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return faultCode(error);
  }
};

async function setup(t: TestContext) {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 4 * 86_400 });
  t.after(() => fake.close());
  const hive = `desk-${randomUUID().slice(0, 8)}`;
  const files = localPath("desk-test", hive);
  t.after(() => {
    for (const p of [opsPaths(hive).local(), opsPaths(hive).secret(), files])
      rmSync(p, { recursive: true, force: true });
  });
  const secrets = [0, 1, 2].map(() => secp256k1.utils.randomSecretKey());
  const keepers = secrets.map((s) => hex(secp256k1.getPublicKey(s, true))) as [string, string, string];
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
  const agentLog = `${files}/agent.jsonl`;
  const governance = `${files}/governance.json`;
  mkdirSync(dirname(agentLog), { recursive: true });
  writeFileSync(
    agentLog,
    `${JSON.stringify({
      at: now(),
      event: "funding_requested",
      request: {
        event: "fund",
        job_id: params.jobId,
        address: escrow.address,
        cap_sats: 20_000,
        deadline: params.deadline,
        model: "qwen3-8b",
        price_msat_per_mtok: 2_000_000,
        provider_peer: "peer",
        provider_pk: params.providerPk,
        params,
      },
    })}\n`,
  );
  writeFileSync(
    governance,
    JSON.stringify({
      proposals: [{ id: "p-1", title: "Docs", budgetSats: 30_000, usedSats: 0, state: "running" }],
    }),
  );
  const server = await startDesk(hive, { agentLog, governance, tickMs: 60_000 }, {});
  t.after(() => server.close());
  const auth = (i: number, action: string, jobId: string): DeskAuth => {
    const at = now();
    return {
      keeper: keepers[i]!,
      at,
      signature: hex(schnorr.sign(deskAuthDigest(hive, action, jobId, at), secrets[i]!)),
    };
  };
  return { fake, hive, record, conn, secrets, keepers, params, escrow, server, auth };
}

/** One keeper's console: shares nonces, keeps their secrets, and checks every session before signing. */
function consoleOf(i: number, ctx: Awaited<ReturnType<typeof setup>>) {
  const kept: SecretNonce[] = [];
  const view = keeperView(ctx.keepers, ctx.record.treasury);
  return {
    async share(count = 16) {
      const { batch, secrets } = nonceBatch(ctx.secrets[i]!, count);
      kept.push(...secrets);
      return ctx.server.desk.addNonces(batch);
    },
    async check(session: SessionRequest, remainingSats: number) {
      const purpose = session.purpose as Extract<SessionRequest["purpose"], { kind: "payment" }>;
      return checkPayment(view, ctx.conn, session, { request: purpose.request, remainingSats }, now());
    },
    async signFirst(jobId: string, stage: "attest" | "register") {
      const payment = ctx.server.desk.payment(jobId)!;
      const sessions = ctx.server.desk.sessions(payment);
      const checked = await this.check(sessions[stage]!, payment.remainingSats);
      const session = stage === "attest" ? payment.attest : payment.register!;
      assert.deepEqual(checked.messages.map(hex), session.messages);
      return ctx.server.desk.sign(jobId, {
        keeper: ctx.keepers[i]!,
        stage,
        ...signOver(session, ctx.secrets[i]!, checked.messages),
      });
    },
    async signSecond(jobId: string, stage: "attest" | "register") {
      const payment = ctx.server.desk.payment(jobId)!;
      const sessions = ctx.server.desk.sessions(payment);
      const checked = await this.check(sessions[stage]!, payment.remainingSats);
      const session = stage === "attest" ? payment.attest : payment.register!;
      const partials = signShared(session, ctx.secrets[i]!, checked.messages, kept);
      // A secret nonce signs once: the console drops each one as it uses it.
      for (const id of session.pooled[ctx.keepers[i]!] ?? [])
        kept.splice(
          kept.findIndex((s) => s.id === id),
          1,
        );
      return ctx.server.desk.sign(jobId, { keeper: ctx.keepers[i]!, stage, partials });
    },
  };
}

test("two keepers fund the agent's job through the desk, hours apart, and the escrow holds the cap", async (t) => {
  const ctx = await setup(t);
  const { desk } = ctx.server;
  const [a, b] = [consoleOf(0, ctx), consoleOf(1, ctx)];
  const jobId = ctx.params.jobId;
  const overview = desk.overview();
  assert.equal(overview.payments.length, 1);
  assert.deepEqual(
    { approved: overview.budget.approvedLeftSats, remaining: overview.budget.remainingSats },
    { approved: 30_000, remaining: 30_000 },
  );

  // Nobody else has opened the console yet: there is no one to sign with.
  await a.share();
  assert.equal(await code(desk.start(jobId, ctx.auth(0, "start", jobId))), "NO_PARTNER");
  await b.share();
  // A request someone else signed, or one for another action, is refused.
  assert.equal(await code(desk.start(jobId, { ...ctx.auth(0, "cancel", jobId) })), "AUTH_INVALID");

  // Keeper A starts it and signs attest at once; keeper B comes later and signs attest and register.
  const started = await desk.start(jobId, ctx.auth(0, "start", jobId), ctx.keepers[1]);
  assert.equal(started.pair, "01");
  await a.signFirst(jobId, "attest");
  assert.equal(desk.payment(jobId)!.status, "attesting");
  await b.signSecond(jobId, "attest");
  assert.equal(desk.payment(jobId)!.status, "registering");
  await b.signFirst(jobId, "register");
  // A forged partial never lands: it is checked against the pair's key on arrival.
  assert.equal(
    await code(desk.sign(jobId, { keeper: ctx.keepers[0]!, stage: "register", partials: ["11".repeat(32)] })),
    "PARTIAL_SIGNATURE_INVALID",
  );
  // Keeper A comes back once to finish, and the desk hands the payment to the delegatee.
  const done = await a.signSecond(jobId, "register");
  assert.equal(done.status, "submitted");
  await desk.drive(jobId);
  assert.equal(desk.payment(jobId)!.status, "done");
  assert.equal(ctx.fake.balance(ctx.escrow.pkScript), 20_000);
  assert.equal(await code(desk.start(jobId, ctx.auth(1, "start", jobId))), "PAYMENT_STARTED");
});

test("the desk serves consoles over HTTP and a keeper can cancel a payment that stalls", async (t) => {
  const ctx = await setup(t);
  const [a, c] = [consoleOf(0, ctx), consoleOf(2, ctx)];
  await a.share();
  await c.share();
  const base = `${ctx.server.url}/desk/v1`;
  const hiveInfo = (await (await fetch(`${base}/hive`)).json()) as {
    keepers: string[];
    nonces: Record<string, number>;
  };
  assert.deepEqual(hiveInfo.keepers, ctx.keepers);
  assert.equal(hiveInfo.nonces[ctx.keepers[2]!], 16);
  const jobId = ctx.params.jobId;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const started = await post(`/payments/${jobId}/start`, { auth: ctx.auth(2, "start", jobId) });
  assert.equal(started.status, 200);
  const { payment } = (await started.json()) as { payment: { pair: string; status: string } };
  assert.equal(payment.pair, "02");
  const cancelled = await post(`/payments/${jobId}/cancel`, { auth: ctx.auth(0, "cancel", jobId) });
  assert.equal(((await cancelled.json()) as { payment: { status: string } }).payment.status, "cancelled");
  // Another pair may start again; the coins of the cancelled plan are free.
  const again = await post(`/payments/${jobId}/start`, { auth: ctx.auth(0, "start", jobId) });
  assert.equal(again.status, 200);
  const missing = await fetch(`${base}/payments/${"00".repeat(32)}`);
  assert.equal(missing.status, 404);
});

test("each keeper signs the hive's listing in their console, and the third signature lists the hive", async (t) => {
  const ctx = await setup(t);
  const pending = proposeListing(ctx.hive, { name: "Open Lab", purpose: "Translate the docs" });
  const sign = (i: number) => hex(schnorr.sign(unhex(pending.listingId), ctx.secrets[i]!));
  assert.equal(await code(ctx.server.desk.signListing(ctx.keepers[0]!, sign(1))), "LISTING_SIGNATURE");
  await ctx.server.desk.signListing(ctx.keepers[0]!, sign(0));
  await ctx.server.desk.signListing(ctx.keepers[2]!, sign(2));
  assert.equal(ctx.server.desk.listing()?.signatures.filter(Boolean).length, 2);
  const { listing } = await ctx.server.desk.signListing(ctx.keepers[1]!, sign(1));
  assert.equal(listing?.body.name, "Open Lab");
  assert.equal(loadListing(ctx.hive).listingId, pending.listingId);
  assert.equal(ctx.server.desk.listing(), null);
});
