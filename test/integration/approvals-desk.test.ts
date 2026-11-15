import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { type Connection, jobEscrow } from "@hive/ark";
import type { TreasuryContract } from "@hive/executor";
import { faultCode, hex, localPath } from "@hive/kit";
import { deskAuthDigest } from "@hive/steward";
import { CLIENT_PREFIX, challengeOf, counterOf, keeperKey, payMessage, sha256 } from "@hive/treasury";
import { p256 } from "@noble/curves/nist.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { ApprovalDesk } from "../../tools/approvals-desk.js";
import type { DeskAuth } from "../../tools/desk.js";
import { type HiveRecord, opsPaths } from "../../tools/ops.js";

/**
 * The approvals desk between a v5 hive and its keepers' consoles, over a stand-in for the treasury
 * contract that keeps its coins in memory: a payment a keeper starts gets the treasury's next number,
 * two keepers' passkey approvals make it ready, and the desk's round pays it, folding chip-ins in
 * first when the treasury coin cannot cover it. Numbers follow the payments still under way.
 */
const SITE = "keepers.example";
const ORIGIN = "https://keepers.example";
const SUPPLY = 1_000_000n;
const point = () => hex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return faultCode(error);
  }
};

/** A keeper: a passkey on the keeper site, and the Bitcoin key the desk knows them by. */
function keeper() {
  const passkey = p256.utils.randomSecretKey();
  const bitcoin = secp256k1.utils.randomSecretKey();
  const utf8 = (s: string) => new TextEncoder().encode(s);
  return {
    record: {
      kind: 1 as const,
      key: hex(keeperKey(p256.getPublicKey(passkey, true))),
      bitcoinKey: hex(secp256k1.getPublicKey(bitcoin, true)),
      site: SITE,
    },
    auth(hive: string, action: string, id: string, at: number): DeskAuth {
      const signature = hex(schnorr.sign(deskAuthDigest(hive, action, id, at), bitcoin));
      return { keeper: hex(secp256k1.getPublicKey(bitcoin, true)), at, signature };
    },
    /** What the console posts: the passkey's WebAuthn assertion over the message. */
    assertion(message: Uint8Array, origin = ORIGIN) {
      const authData = new Uint8Array([...sha256(utf8(SITE)), 0x05, 0, 0, 0, 1]);
      const clientDataJSON = `${CLIENT_PREFIX}${challengeOf(message)}","origin":"${origin}","crossOrigin":false}`;
      const digest = sha256(new Uint8Array([...authData, ...sha256(utf8(clientDataJSON))]));
      const signature = p256.Signature.fromBytes(
        p256.sign(digest, passkey, { prehash: false }),
        "compact",
      ).toBytes("der");
      return {
        authenticatorData: Buffer.from(authData).toString("base64url"),
        clientDataJSON,
        signature: Buffer.from(signature).toString("base64url"),
      };
    },
  };
}

type Coin = { txid: string; vout: number; value: number; assets?: { assetId: string; amount: number }[] };

/** The treasury contract's coins and spends, in memory: what the desk spends through. */
function fakeTreasury(assetId: string, coins: Coin[]) {
  const sent: { fn: string; args: unknown[] }[] = [];
  let fail: string | null = null;
  // The Emulator accepted the spend, and its answer was lost on the way back.
  let lostAnswer = false;
  const txid = () => hex(randomBytes(32));
  const builder = (fn: string, args: unknown[]) => {
    let from: Coin[] = [];
    const b = {
      from(c: Coin | Coin[]) {
        from = Array.isArray(c) ? c : [c];
        return b;
      },
      to: () => b,
      withAsset: () => b,
      async send() {
        if (fail) throw new Error(fail);
        sent.push({ fn, args });
        const lose = lostAnswer;
        const id = txid();
        const units = from[0]!.assets?.[0]?.amount ?? 0;
        for (const c of from) coins.splice(coins.indexOf(c), 1);
        if (fn === "merge")
          coins.push({
            txid: id,
            vout: 0,
            value: from[0]!.value + from[1]!.value,
            assets: [{ assetId, amount: units }],
          });
        else {
          const amount = Number(args[0]);
          coins.push({
            txid: id,
            vout: 0,
            value: from[0]!.value - amount,
            assets: [{ assetId, amount: units - 1 }],
          });
        }
        if (lose) throw new Error("socket hang up");
        return { txid: id };
      },
    };
    return b;
  };
  const contract = {
    pkScript: new Uint8Array(34),
    getUtxos: async () => coins,
    functions: {
      pay: (...args: unknown[]) => builder("pay", args),
      merge: (...args: unknown[]) => builder("merge", args),
    },
  } as unknown as TreasuryContract;
  return {
    contract,
    sent,
    coins,
    failWith: (m: string | null) => (fail = m),
    loseAnswers: () => (lostAnswer = true),
  };
}

function setup(clock: { now: number }, coins: Coin[]) {
  const hive = `approvals-${randomUUID().slice(0, 8)}`;
  const keepers = [keeper(), keeper(), keeper()];
  const counter = counterOf(`${hex(randomBytes(32))}0000`);
  const server = point();
  const conn = {
    deployment: { network: "regtest" },
    keys: { server, emulator: point(), delegate: point() },
    operator: { dust: 330, unilateralExitDelay: 512 },
    delegatee: { info: async () => ({}) },
  } as unknown as Connection;
  const treasuryScript = `5120${hex(randomBytes(32))}`;
  const record = {
    schema: "hive-ops-hive/v4",
    name: hive,
    network: "regtest",
    deployment: { network: "regtest", arkdUrl: "http://arkd", delegateeUrl: "http://delegatee" },
    stewardKeys: keepers.map((k) => k.record.bitcoinKey),
    keepersHold: true,
    passkeys: {
      version: 5,
      keepers: keepers.map((k) => k.record),
      counter,
      supply: String(SUPPLY),
      delegateKey: conn.keys.delegate,
      renewalWindowSeconds: 600,
      maxFeeSats: 2000,
      exitDelaySeconds: 512,
      fundedTxid: "00".repeat(32),
    },
    treasury: { pairs: {}, exitDelaySeconds: 512, renewalWindowSeconds: 600, maxFeeSats: 2000 },
    treasuryScript,
    treasuryAddress: "tark1…",
  } as unknown as HiveRecord;
  const recordPath = opsPaths(hive).local("hive.json");
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record));
  for (const c of coins) if (c.assets) c.assets[0]!.assetId = counter.assetId;
  const fake = fakeTreasury(counter.assetId, coins);
  const files = localPath("approvals-test", hive);
  mkdirSync(files, { recursive: true });
  const agentLog = `${files}/agent.jsonl`;
  const governance = `${files}/governance.json`;
  writeFileSync(
    governance,
    JSON.stringify({
      proposals: [{ id: "p", title: "Work", budgetSats: 100_000, usedSats: 0, state: "running" }],
    }),
  );
  writeFileSync(agentLog, "");
  const job = (cap: number) => {
    const jobId = hex(randomBytes(32));
    const deadline = clock.now + 7200;
    const params = {
      agentPk: hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
      providerPk: hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
      treasuryProgram: treasuryScript.slice(4),
      deadline,
      jobId,
    };
    const request = {
      job_id: jobId,
      address: jobEscrow(conn as never, params).address,
      cap_sats: cap,
      deadline,
      model: "m",
      provider_pk: params.providerPk,
      provider_peer: "peer",
      params,
    };
    writeFileSync(agentLog, `${JSON.stringify({ event: "funding_requested", at: clock.now, request })}\n`, {
      flag: "a",
    });
    return jobId;
  };
  const desk = new ApprovalDesk(hive, conn, fake.contract, {
    agentLog,
    governance,
    now: () => clock.now,
    deadlineMarginSeconds: 60,
    minimumValiditySeconds: 60,
  });
  const cleanup = () => {
    rmSync(opsPaths(hive).local(), { recursive: true, force: true });
    rmSync(files, { recursive: true, force: true });
  };
  return { hive, desk, keepers, fake, job, counter, cleanup };
}

const treasuryCoin = (value: number, units = SUPPLY): Coin => ({
  txid: hex(randomBytes(32)),
  vout: 0,
  value,
  assets: [{ assetId: "", amount: Number(units) }],
});

test("a started payment gets the treasury's number, two passkeys approve it, and the desk pays it once", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const { hive, desk, keepers, fake, job, counter, cleanup } = setup(clock, [treasuryCoin(100_000)]);
  try {
    const jobId = job(20_000);
    const [a, b, c] = keepers as [
      ReturnType<typeof keeper>,
      ReturnType<typeof keeper>,
      ReturnType<typeof keeper>,
    ];
    const started = await desk.start(jobId, a.auth(hive, "start", jobId, clock.now));
    assert.equal(started.left, String(SUPPLY));
    assert.equal(started.amountSats, 20_000);
    const message = payMessage(counter, {
      left: SUPPLY,
      amount: 20_000n,
      validUntil: started.validUntil,
      program: started.program,
    });
    assert.deepEqual(desk.message(started), message, "the message the consoles rebuild");
    assert.equal(await code(desk.start(jobId, b.auth(hive, "start", jobId, clock.now))), "PAYMENT_STARTED");

    // Another payment's approval, another site's, and a stranger's are refused at the door.
    const other = payMessage(counter, {
      left: SUPPLY - 1n,
      amount: 20_000n,
      validUntil: started.validUntil,
      program: started.program,
    });
    assert.equal(await code(desk.approve(jobId, { assertion: a.assertion(other) })), "APPROVAL_REFUSED");
    assert.equal(
      await code(desk.approve(jobId, { assertion: a.assertion(message, "https://evil.example") })),
      "NOT_A_KEEPER",
    );
    assert.equal(await code(desk.approve(jobId, { assertion: keeper().assertion(message) })), "NOT_A_KEEPER");

    await desk.approve(jobId, { assertion: a.assertion(message) });
    await desk.tick();
    assert.equal(fake.sent.length, 0, "one approval pays nothing");
    const ready = await desk.approve(jobId, { assertion: c.assertion(message) });
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.approvals.map(Boolean), [true, false, true]);
    await desk.tick();
    assert.equal(desk.payment(jobId)?.status, "done");
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]!.args[0], 20_000n);
    assert.equal(fake.coins[0]!.assets![0]!.amount, Number(SUPPLY) - 1, "one counter unit burned");
    await desk.tick();
    assert.equal(fake.sent.length, 1, "paid once");
    assert.equal(await code(desk.start(jobId, b.auth(hive, "start", jobId, clock.now))), "PAID");
  } finally {
    cleanup();
  }
});

test("a payment the treasury coin cannot cover waits for the chip-in beside it to fold in", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const chipIn: Coin = { txid: hex(randomBytes(32)), vout: 0, value: 60_000 };
  const { hive, desk, keepers, fake, job, cleanup } = setup(clock, [treasuryCoin(1_000), chipIn]);
  try {
    const jobId = job(20_000);
    const [a, b] = keepers as [ReturnType<typeof keeper>, ReturnType<typeof keeper>];
    const started = await desk.start(jobId, a.auth(hive, "start", jobId, clock.now));
    for (const k of [a, b]) await desk.approve(jobId, { assertion: k.assertion(desk.message(started)) });
    await desk.tick();
    assert.deepEqual(
      fake.sent.map((s) => s.fn),
      ["merge"],
      "the chip-in folds in first",
    );
    await desk.tick();
    assert.deepEqual(
      fake.sent.map((s) => s.fn),
      ["merge", "pay"],
    );
    assert.equal(desk.payment(jobId)?.status, "done");
    assert.equal(fake.coins[0]!.value, 41_000);
  } finally {
    cleanup();
  }
});

test("payments go out in the order keepers started them; one cancelled gives its number to the next", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const { hive, desk, keepers, fake, job, cleanup } = setup(clock, [treasuryCoin(100_000)]);
  try {
    const [a, b] = keepers as [ReturnType<typeof keeper>, ReturnType<typeof keeper>];
    const first = job(10_000);
    const second = job(5_000);
    const one = await desk.start(first, a.auth(hive, "start", first, clock.now));
    const two = await desk.start(second, a.auth(hive, "start", second, clock.now));
    assert.deepEqual([one.left, two.left], [String(SUPPLY), String(SUPPLY - 1n)]);
    for (const k of [a, b]) await desk.approve(second, { assertion: k.assertion(desk.message(two)) });
    await desk.tick();
    assert.equal(fake.sent.length, 0, "the second waits for the first");
    await desk.cancel(first, b.auth(hive, "cancel", first, clock.now));
    await desk.tick();
    const renumbered = desk.payment(second)!;
    assert.equal(renumbered.left, String(SUPPLY), "the next number");
    assert.equal(renumbered.status, "approving", "its approvals named the old number");
    assert.deepEqual(renumbered.approvals, [null, null, null]);
    for (const k of [a, b]) await desk.approve(second, { assertion: k.assertion(desk.message(renumbered)) });
    await desk.tick();
    assert.equal(desk.payment(second)?.status, "done");
  } finally {
    cleanup();
  }
});

test("approvals lapse; a payment whose answer was lost is done when the counter moved", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const { hive, desk, keepers, fake, job, cleanup } = setup(clock, [treasuryCoin(100_000)]);
  try {
    const [a, b] = keepers as [ReturnType<typeof keeper>, ReturnType<typeof keeper>];
    const late = job(10_000);
    const started = await desk.start(late, a.auth(hive, "start", late, clock.now));
    clock.now = started.validUntil;
    await desk.tick();
    assert.equal(desk.payment(late)?.status, "lapsed");
    assert.equal(
      await code(desk.approve(late, { assertion: b.assertion(desk.message(started)) })),
      "WRONG_ROUND",
    );

    const lost = job(10_000);
    const payment = await desk.start(lost, a.auth(hive, "start", lost, clock.now));
    for (const k of [a, b]) await desk.approve(lost, { assertion: k.assertion(desk.message(payment)) });
    // The Emulator accepted the payment and the answer never came back.
    fake.loseAnswers();
    await desk.tick();
    assert.equal(desk.payment(lost)?.status, "done", "the counter says it went out");
    assert.equal(fake.sent.length, 1);
  } finally {
    cleanup();
  }
});
