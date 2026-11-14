import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { arkAddress, connect, xOnly } from "@hive/ark";
import { faultCode, hex, localPath, readPrivateJson, secretPath, unhex } from "@hive/kit";
import {
  classifyArrival,
  decodeInvoice,
  intakeSettlement,
  observeTreasury,
  registerIntake,
  requestContribution,
} from "@hive/hive";
import { intakeKey } from "@hive/protocol";
import { schnorr } from "@noble/curves/secp256k1.js";
import { startHivePage } from "../../app/server.js";
import { encodeInvoice } from "../support/bolt11.js";
import { startFakeNetwork } from "../support/fake-network.js";
import { arrivalTransaction, startLnurlStub } from "../support/lnurl-stub.js";

/** The hive's Lightning address: registration, both rails, attribution and the page's routes. */
const isCode = (code: string) => (error: unknown) => faultCode(error) === code;
const key = () => hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
const compressed = () => `02${key()}`;

async function setup(t: TestContext) {
  const fake = await startFakeNetwork();
  t.after(() => fake.close());
  const conn = await connect(fake.deployment());
  const operatorKey = hex(xOnly(fake.serverKey));
  const stub = await startLnurlStub(fake);
  t.after(() => stub.close());
  const treasuryScript = `5120${key()}`;
  const treasuryAddress = arkAddress("regtest", fake.serverKey, treasuryScript);
  const run = randomUUID();
  const local = localPath("v4-test", "intake", run);
  const secrets = secretPath("v4-test", "intake", run);
  t.after(() => {
    rmSync(local, { recursive: true, force: true });
    rmSync(secrets, { recursive: true, force: true });
  });
  const endpoint = { baseUrl: stub.baseUrl, username: "hive" };
  const stewards = [compressed(), compressed(), compressed()] as [string, string, string];
  const register = (address = treasuryAddress) =>
    registerIntake({
      endpoint,
      treasuryAddress: address,
      intakeKey: intakeKey(stewards),
      statePath: resolve(local, "registration.json"),
      tokenPath: resolve(secrets, "token.json"),
      operatorKey,
    });
  return {
    fake,
    conn,
    operatorKey,
    stub,
    treasuryScript,
    treasuryAddress,
    local,
    secrets,
    endpoint,
    register,
  };
}

/** A real invoice from lnd on regtest, paid in an earlier funded intake run. */
const REGTEST_INVOICE =
  "lnbcrt300u1p4v37l0pp5a2f7k8hy3c6w5vadqgcm9cf79rssn92ewdcwen4tue8a43zjcrqqdqqcqzpkxqrpcgsp50v9ft4nlyw03n3jvw5qgl0j8wh8055wy47pfp5aj7u3de22pxypq9qxpqysgqke3tqk40kl02hzh8t48ue3ys49lk5y56rvzjnapk0dufp4uzcsmy3qashc9g3w63xhmxcqmfn8wfhygxusulghchnxtc7479nz4fw3qqjgx26a";

test("invoices yield their network, amount and payment hash, checksum verified", () => {
  assert.deepEqual(decodeInvoice(REGTEST_INVOICE), {
    network: "regtest",
    amountSats: 30_000,
    paymentHash: "ea93eb1ee48e34ea33ad0231b2e13e28e10995597370ecceabe64fdac452c0c0",
    // Created 14:36:31 UTC on October 9, payable for 30 minutes.
    createdAt: 1_791_556_591,
    expiresAt: 1_791_558_391,
  });
  assert.deepEqual(decodeInvoice(REGTEST_INVOICE.toUpperCase()), decodeInvoice(REGTEST_INVOICE));
  const paymentHash = hex(randomBytes(32));
  for (const [prefix, amount, network, sats] of [
    ["tbs", "21u", "signet", 2_100],
    ["tb", "300000n", "testnet", 30_000],
    ["bc", "1m", "bitcoin", 100_000],
    ["bcrt", "10000p", "regtest", 1],
  ] as const) {
    const { createdAt, expiresAt, ...facts } = decodeInvoice(encodeInvoice({ prefix, amount, paymentHash }));
    assert.deepEqual(facts, { network, amountSats: sats, paymentHash });
    assert.equal(expiresAt - createdAt, 3600, "BOLT11's default expiry");
  }
  const short = decodeInvoice(
    encodeInvoice({ prefix: "tbs", amount: "21u", paymentHash, expirySeconds: 600 }),
  );
  assert.equal(short.expiresAt - short.createdAt, 600);
  // A payment hash field of the wrong length is skipped, as BOLT11 requires.
  const skipped = encodeInvoice({
    prefix: "tbs",
    amount: "21u",
    paymentHash,
    extra: [{ tag: 1, words: [0, 0] }],
  });
  assert.equal(decodeInvoice(skipped).paymentHash, paymentHash);
});

test("malformed, amountless and ambiguous invoices are refused", () => {
  const paymentHash = hex(randomBytes(32));
  const flipped = `${REGTEST_INVOICE.slice(0, -1)}${REGTEST_INVOICE.endsWith("q") ? "p" : "q"}`;
  for (const invoice of [
    flipped,
    `${REGTEST_INVOICE.slice(0, 20)}${REGTEST_INVOICE.slice(20).toUpperCase()}`,
    encodeInvoice({ prefix: "bcrt", amount: "", paymentHash }),
    encodeInvoice({ prefix: "bcrt", amount: "1p", paymentHash }),
    encodeInvoice({ prefix: "bcrt", amount: "021u", paymentHash }),
    encodeInvoice({ prefix: "xyz", amount: "1u", paymentHash }),
    encodeInvoice({ prefix: "bcrt", amount: "1u", paymentHash, hashes: 0 }),
    encodeInvoice({ prefix: "bcrt", amount: "1u", paymentHash, hashes: 2 }),
    "lnbcrt500u1p4v36yupp5qq",
  ]) {
    assert.throws(() => decodeInvoice(invoice), isCode("INTAKE_INVOICE"), invoice.slice(0, 40));
  }
});

test("the intake key is the three stewards' aggregate, whatever their order", () => {
  const keys = [compressed(), compressed(), compressed()] as [string, string, string];
  const aggregate = intakeKey(keys);
  assert.match(aggregate, /^02[0-9a-f]{64}$/);
  assert.equal(intakeKey([keys[2], keys[0], keys[1]]), aggregate);
  assert.throws(() => intakeKey([keys[0], keys[0], keys[1]]), isCode("INVALID"));
});

test("registration names the treasury, keeps the token private and is idempotent", async (t) => {
  const { register, secrets, treasuryAddress, treasuryScript, fake } = await setup(t);
  const registration = await register();
  assert.equal(registration.lightningAddress, "hive@localhost");
  assert.equal(registration.treasuryScript, treasuryScript);
  assert.match(readPrivateJson<{ token: string }>(resolve(secrets, "token.json")).token, /^[0-9a-f]{64}$/);
  assert.deepEqual(await register(), registration);
  const other = arkAddress("regtest", fake.serverKey, `5120${key()}`);
  await assert.rejects(register(other), isCode("INTAKE_CHANGED"));
  const foreign = arkAddress("regtest", compressed(), treasuryScript);
  assert.notEqual(foreign, treasuryAddress);
});

test("each rail's treasury output is credited to its request once observed", async (t) => {
  const { fake, conn, operatorKey, stub, register, local, endpoint, treasuryScript } = await setup(t);
  await register();
  const requestsDirectory = resolve(local, "requests");
  const ask = (rail: "lightning" | "arkade", amountSats: number) =>
    requestContribution({
      endpoint,
      network: "regtest",
      rail,
      amountSats,
      operatorKey,
      requestsDirectory,
    });
  const lightning = await ask("lightning", 30_000);
  const arkade = await ask("arkade", 20_000);
  assert.equal(decodeInvoice(lightning.invoice!).amountSats, 30_000);
  assert.equal((await intakeSettlement(lightning)).settled, false);
  const observe = () =>
    observeTreasury(conn, {
      treasuryScript,
      internalTxids: new Set(),
      renewalMaxFeeSats: 500,
      requests: [lightning, arkade],
    });
  assert.deepEqual((await observe()).contributions, [], "nothing is credited before it is observed");

  await stub.payInvoice(lightning.invoice!);
  await stub.sweep(arkade.destinationScript!);
  const direct = fake.mint(treasuryScript, 5_000);
  const { contributions } = await observe();
  const byRequest = (id?: string) => contributions.find((c) => c.requestId === id);
  assert.equal(byRequest(lightning.id)?.rail, "lightning");
  assert.equal(byRequest(lightning.id)?.paymentHash, lightning.paymentHash);
  assert.equal(byRequest(arkade.id)?.rail, "arkade");
  assert.equal(byRequest(arkade.id)?.sourceScript, arkade.destinationScript);
  assert.deepEqual(
    contributions.filter((c) => !c.requestId).map((c) => [c.rail, c.amountSats, c.txid]),
    [["direct", 5_000, direct.txid]],
  );
  const settlement = await intakeSettlement(lightning);
  assert.equal(settlement.settled, true);
  assert.equal(createHash("sha256").update(unhex(settlement.preimage!)).digest("hex"), lightning.paymentHash);

  const internal = await observeTreasury(conn, {
    treasuryScript,
    internalTxids: new Set([direct.txid]),
    renewalMaxFeeSats: 500,
  });
  assert.equal(internal.contributions.length, 2, "the hive's own outputs are never contributions");
});

test("an invoice for another network, payment or origin is refused before it is handed out", async (t) => {
  const { operatorKey, stub, register, local, endpoint } = await setup(t);
  await register();
  const ask = (network: "regtest" | "mutinynet" = "regtest") =>
    requestContribution({
      endpoint,
      network,
      rail: "lightning",
      amountSats: 2_100,
      operatorKey,
      requestsDirectory: resolve(local, "requests"),
    });
  await assert.rejects(ask("mutinynet"), isCode("INTAKE_INVOICE"));
  stub.misbehave.invoicePrefix = "tbs";
  assert.equal(decodeInvoice((await ask("mutinynet")).invoice!).network, "signet");
  await assert.rejects(ask("regtest"), isCode("INTAKE_INVOICE"));
  delete stub.misbehave.invoicePrefix;
  stub.misbehave.verifyHash = hex(randomBytes(32));
  await assert.rejects(ask(), isCode("INTAKE_INVOICE"));
  delete stub.misbehave.verifyHash;
  stub.misbehave.verifyHost = "attacker.example";
  await assert.rejects(ask(), isCode("INTAKE_CALLBACK"));
  delete stub.misbehave.verifyHost;
  const honest = await ask();
  assert.ok(honest.verify.startsWith(`${endpoint.baseUrl}/lnurl/verify/`));
});

test("arrivals are classified by the leaf they spend", () => {
  const operatorKey = key();
  const preimage = randomBytes(32);
  const script = `5120${key()}`;
  const claim = arrivalTransaction({ kind: "swap-claim", script, value: 1_000, preimage, operatorKey });
  const sweep = arrivalTransaction({
    kind: "destination-sweep",
    script,
    value: 1_000,
    preimage,
    operatorKey,
  });
  assert.deepEqual(classifyArrival(claim.tx), {
    rail: "lightning",
    conditionHash: classifyArrival(claim.tx).conditionHash,
    paymentHash: createHash("sha256").update(preimage).digest("hex"),
    checkpointTxid: claim.checkpoint.id,
  });
  assert.equal(classifyArrival(sweep.tx).rail, "arkade");
  assert.equal(classifyArrival(sweep.tx).checkpointTxid, sweep.checkpoint.id);
  assert.equal(classifyArrival(claim.checkpoint).rail, "direct");
});

test("the page serves the view and refuses malformed or hurried payment requests", async (t) => {
  const { fake, operatorKey, register, local, endpoint, treasuryScript, treasuryAddress } = await setup(t);
  const registration = await register();
  fake.mint(treasuryScript, 7_000);
  let readings = 0;
  const counted = <T>(view: T): T => {
    readings += 1;
    return view;
  };
  const page = await startHivePage({
    view: async () =>
      counted({
        schema: "hive-view/v4",
        generatedAt: new Date().toISOString(),
        treasury: {
          address: treasuryAddress,
          script: treasuryScript,
          lightningAddress: registration.lightningAddress,
          balanceSats: 7_000,
          coins: [],
        },
        contributions: [],
        renewals: [],
        unattributed: [],
        escrows: [],
        totals: { contributedSats: 7_000, inEscrowSats: 0, paidSats: 0, refundedSats: 0 },
      }),
    intake: {
      endpoint,
      network: "regtest",
      operatorKey,
      requestsDirectory: resolve(local, "page"),
    },
  });
  t.after(() => page.close());
  const html = await (await fetch(page.url)).text();
  assert.match(html, /Chip in/);
  assert.equal(
    ((await (await fetch(`${page.url}/api/view`)).json()) as { treasury: { balanceSats: number } }).treasury
      .balanceSats,
    7_000,
  );
  // Many visitors at once share one reading of the view: it is not worked out for each of them.
  await Promise.all(Array.from({ length: 20 }, () => fetch(`${page.url}/api/view`).then((r) => r.json())));
  assert.equal(readings, 1);
  const pour = (body: unknown) =>
    fetch(`${page.url}/api/pour`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await pour({ rail: "lightning", amountSats: 0.5 })).status, 400);
  const requestTime = Date.now();
  const clock = t.mock.method(Date, "now", () => requestTime);
  const first = await pour({ rail: "lightning", amountSats: 2_000 });
  assert.equal(first.status, 200);
  const hurried = await pour({ rail: "arkade", amountSats: 2_000 });
  assert.deepEqual([hurried.status, ((await hurried.json()) as { error: string }).error], [400, "SLOW_DOWN"]);
  clock.mock.restore();
  const { id } = (await first.json()) as { id: string };
  const status = (await (await fetch(`${page.url}/api/pour/${id}`)).json()) as {
    settled: boolean;
    credited: unknown;
  };
  assert.deepEqual(status, { id, settled: false, credited: null });
  assert.equal((await fetch(`${page.url}/api/pour/${randomUUID()}`)).status, 400);
});
