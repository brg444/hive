import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type TestContext, test } from "node:test";
import { arkAddress, connect, jobEscrow, xOnly } from "@hive/ark";
import { faultCode, hex, localPath, unhex } from "@hive/kit";
import {
  checkKeeperWithdrawal,
  checkPayment,
  deskAuthDigest,
  keeperView,
  nonceBatch,
  type SecretNonce,
  type SessionRequest,
  signOver,
  signShared,
  withdrawalId,
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
      // A console signs for what its keeper read: here, what the session itself carries.
      if (session.purpose.kind === "withdrawal")
        return checkKeeperWithdrawal(
          view,
          ctx.conn,
          session,
          { withdrawal: session.purpose.withdrawal },
          now(),
        );
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
  // The hive's payments are read by its keepers alone: a read carries a keeper's fresh signature.
  const read = (path: string, keeper?: string) =>
    fetch(`${base}${path}`, keeper ? { headers: { "x-hive-keeper": keeper } } : {});
  const signed = (i: number, at?: number) => {
    const auth = ctx.auth(i, "read", "");
    return `${auth.keeper}.${at ?? auth.at}.${auth.signature}`;
  };
  assert.equal((await read("/payments")).status, 401);
  assert.equal((await read(`/payments/${jobId}`)).status, 401);
  assert.equal((await read("/listing")).status, 401);
  assert.equal((await read("/payments", signed(0, 1))).status, 401, "a signature for another time");
  const stranger = ctx.auth(0, "read", "");
  assert.equal(
    (await read("/payments", `02${"11".repeat(32)}.${stranger.at}.${stranger.signature}`)).status,
    400,
  );
  const overview = (await (await read("/payments", signed(1))).json()) as { payments: unknown[] };
  assert.equal(overview.payments.length, 1);
  assert.equal((await read(`/payments/${jobId}`, signed(1))).status, 200);
  assert.equal((await read(`/payments/${"00".repeat(32)}`, signed(1))).status, 404);
  // A page elsewhere on the web cannot call the desk from a keeper's browser; one on this machine can.
  const from = (origin: string) => fetch(`${base}/hive`, { headers: { origin } });
  assert.equal((await from("https://elsewhere.example")).status, 403);
  const local = await from("http://127.0.0.1:5173");
  assert.deepEqual(
    [local.status, local.headers.get("access-control-allow-origin")],
    [200, "http://127.0.0.1:5173"],
  );
});

test("a keeper who signed a payment that was given up signs no other for the job, and the two who did not can fund it", async (t) => {
  const ctx = await setup(t);
  const { desk } = ctx.server;
  const consoles = [0, 1, 2].map((i) => consoleOf(i, ctx));
  await Promise.all(consoles.map((c) => c.share(32)));
  const jobId = ctx.params.jobId;
  await desk.start(jobId, ctx.auth(0, "start", jobId), ctx.keepers[1]);
  await consoles[0]!.signFirst(jobId, "attest");
  await desk.cancel(jobId, ctx.auth(1, "cancel", jobId));
  // Keeper A's console holds A to the plan it signed: the desk says so, and plans around A.
  assert.equal(await code(desk.start(jobId, ctx.auth(0, "start", jobId))), "ALREADY_SIGNED");
  assert.equal(await code(desk.start(jobId, ctx.auth(1, "start", jobId), ctx.keepers[0])), "NO_PARTNER");
  const again = await desk.start(jobId, ctx.auth(1, "start", jobId));
  assert.deepEqual([again.pair, again.second, again.signedBefore], ["12", ctx.keepers[2], [ctx.keepers[0]]]);
  // Given up again after B signed, nobody is left to pair with C: the job waits for the agent to ask anew.
  await consoles[1]!.signFirst(jobId, "attest");
  await desk.cancel(jobId, ctx.auth(2, "cancel", jobId));
  assert.equal(await code(desk.start(jobId, ctx.auth(2, "start", jobId))), "NO_PARTNER");
  assert.deepEqual(desk.payment(jobId)!.signedBefore, [ctx.keepers[0]]);
});

test("two keepers withdraw from the treasury to an address they both read, and to no other", async (t) => {
  const ctx = await setup(t);
  const { desk } = ctx.server;
  const [a, b] = [consoleOf(0, ctx), consoleOf(1, ctx)];
  await a.share();
  await b.share();
  const server = hex(xOnly(ctx.conn.keys.server));
  const point = () => hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
  const payee = `5120${point()}`;
  const address = arkAddress(ctx.conn.deployment.network, server, payee);
  const start = (i: number, to: string, amountSats: number, partner?: string) => {
    const at = now();
    const script = to === address ? payee : ctx.record.treasuryScript;
    const id = withdrawalId(ctx.hive, script, amountSats, at);
    const auth = { ...ctx.auth(i, "withdraw", id), at };
    auth.signature = hex(schnorr.sign(deskAuthDigest(ctx.hive, "withdraw", id, at), ctx.secrets[i]!));
    return desk.startWithdrawal(auth, { address: to, amountSats }, partner);
  };
  // Not an address, one on another Operator, the treasury's own, or dust: nothing is planned.
  assert.equal(await code(start(0, "ark1notanaddress", 5_000)), "INVALID_DESTINATION");
  const elsewhere = arkAddress(ctx.conn.deployment.network, point(), payee);
  assert.equal(await code(start(0, elsewhere, 5_000)), "INVALID_DESTINATION");
  assert.equal(await code(start(0, ctx.record.treasuryAddress, 5_000)), "INVALID_DESTINATION");
  assert.equal(await code(start(0, address, 10)), "INVALID");
  // A request signed for other terms than it carries is not this keeper's.
  const other = ctx.auth(0, "withdraw", withdrawalId(ctx.hive, payee, 9_000, now()));
  assert.equal(await code(desk.startWithdrawal(other, { address, amountSats: 5_000 })), "AUTH_INVALID");

  const started = await start(0, address, 5_000, ctx.keepers[1]);
  const id = started.jobId;
  assert.deepEqual(
    [started.withdrawal?.destination, started.withdrawal?.amountSats, started.address, started.pair],
    [payee, 5_000, address, "01"],
  );
  assert.equal(await code(start(2, address, 7_000)), "WITHDRAWAL_STARTED");
  assert.equal(desk.overview().withdrawals.length, 1);
  // A console that showed its keeper another amount or address signs nothing.
  const session = desk.sessions(started).attest as SessionRequest;
  const view = keeperView(ctx.keepers, ctx.record.treasury);
  const shown = (over: object) =>
    code(
      checkKeeperWithdrawal(
        view,
        ctx.conn,
        session,
        { withdrawal: { ...started.withdrawal!, ...over } },
        now(),
      ),
    );
  assert.equal(await shown({ amountSats: 4_000 }), "UNAPPROVED_WITHDRAWAL");
  assert.equal(await shown({ destination: `5120${hex(randomBytes(32))}` }), "UNAPPROVED_WITHDRAWAL");
  assert.equal(await shown({}), "ok");

  await a.signFirst(id, "attest");
  await b.signSecond(id, "attest");
  await b.signFirst(id, "register");
  const done = await a.signSecond(id, "register");
  assert.equal(done.status, "submitted");
  await desk.drive(id);
  assert.equal(desk.payment(id)!.status, "done");
  assert.equal(ctx.fake.balance(payee), 5_000);
  assert.equal(ctx.fake.balance(ctx.record.treasuryScript), 45_000);
  // The job waiting for funding is still there, and still fundable from what is left.
  assert.equal(desk.overview().payments.length, 1);
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

test("keepers acting at the same moment wait their turn at the desk, and one payment is started", async (t) => {
  const ctx = await setup(t);
  const { desk } = ctx.server;
  const consoles = [0, 1, 2].map((i) => consoleOf(i, ctx));
  await Promise.all(consoles.map((c) => c.share()));
  assert.deepEqual(
    ctx.keepers.map((k) => desk.describe().nonces[k]),
    [16, 16, 16],
  );
  const jobId = ctx.params.jobId;
  const outcomes = await Promise.all([
    code(desk.start(jobId, ctx.auth(0, "start", jobId), ctx.keepers[1])),
    code(desk.start(jobId, ctx.auth(2, "start", jobId), ctx.keepers[1])),
  ]);
  assert.deepEqual(outcomes.sort(), ["PAYMENT_STARTED", "ok"]);
});
