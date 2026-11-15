import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { arkAddress, type Connection, jobEscrow } from "@hive/ark";
import type { TreasuryContract } from "@hive/executor";
import { hex, localPath } from "@hive/kit";
import {
  approvalText,
  type BuzzEvent,
  counterOf,
  declineText,
  payMessage,
  sha256,
  withdrawalText,
} from "@hive/treasury";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { ApprovalDesk } from "../../tools/approvals-desk.js";
import { type HiveRecord, opsPaths } from "../../tools/ops.js";

/**
 * The approvals desk of a v5 hive, following its channel, over a stand-in for the treasury contract
 * that keeps its coins in memory: a job the agent asks the keepers to fund becomes a payment with the
 * treasury's next number, two keepers' approval messages make it ready, and the desk's round pays it,
 * folding chip-ins in first when the treasury coin cannot cover it. A keeper's decline stops one, and
 * numbers follow the payments still under way. A keeper asks for a withdrawal in the channel.
 */
const SUPPLY = 1_000_000n;
const CHANNEL = "4f1c2e0a-0000-4000-8000-000000000000";
const point = () => hex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const utf8 = (s: string) => new TextEncoder().encode(s);

/** A member's Buzz identity: it signs channel messages as Buzz's outbox builds them. */
function member() {
  const secret = schnorr.utils.randomSecretKey();
  const key = hex(schnorr.getPublicKey(secret));
  let n = 0;
  return {
    key,
    message(content: string, at: number): BuzzEvent {
      const tags = [
        ["h", CHANNEL],
        ["client-id", `c${n++}`],
        ["ms", "417"],
      ];
      const id = hex(sha256(utf8(JSON.stringify([0, key, at, 9, tags, content]))));
      return {
        id,
        pubkey: key,
        created_at: at,
        kind: 9,
        tags,
        content,
        sig: hex(schnorr.sign(Buffer.from(id, "hex"), secret)),
      };
    },
  };
}
type Member = ReturnType<typeof member>;

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
  const keepers = [member(), member(), member()];
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
    stewardKeys: keepers.map((k) => `02${k.key}`),
    keepersHold: true,
    v5: {
      version: 5,
      keepers: keepers.map((k) => k.key),
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
  const events = `${files}/events.json`;
  writeFileSync(events, "[]");
  /** A message in the hive's channel, as members' plugins forward it to the host. */
  const say = (who: Member, text: string) => {
    const e = who.message(text, clock.now);
    writeFileSync(events, JSON.stringify([...JSON.parse(readFileSync(events, "utf8")), e]));
    return e;
  };
  /** An Arkade address on this hive's Operator, or another's. */
  const address = (server = conn.keys.server) => arkAddress("regtest", server, `5120${hex(randomBytes(32))}`);
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
    events,
    now: () => clock.now,
    deadlineMarginSeconds: 60,
    minimumValiditySeconds: 60,
  });
  const cleanup = () => {
    rmSync(opsPaths(hive).local(), { recursive: true, force: true });
    rmSync(files, { recursive: true, force: true });
  };
  return {
    desk,
    keepers: keepers as [Member, Member, Member],
    fake,
    job,
    counter,
    say,
    address,
    conn,
    cleanup,
  };
}

const treasuryCoin = (value: number, units = SUPPLY): Coin => ({
  txid: hex(randomBytes(32)),
  vout: 0,
  value,
  assets: [{ assetId: "", amount: Number(units) }],
});

test("a job becomes a payment with the treasury's number; two keepers' messages approve it, and it pays once", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const { desk, keepers, fake, job, counter, say, cleanup } = setup(clock, [treasuryCoin(100_000)]);
  try {
    const jobId = job(20_000);
    const [a, b, c] = keepers;
    await desk.tick();
    const started = desk.payment(jobId)!;
    assert.equal(started.left, String(SUPPLY));
    assert.equal(started.amountSats, 20_000);
    assert.equal(started.startedBy, "agent");
    const message = payMessage(counter, {
      left: SUPPLY,
      amount: 20_000n,
      validUntil: started.validUntil,
      program: started.program,
    });
    assert.deepEqual(desk.message(started), message, "the message the keepers' plugins rebuild");
    const shown = (await desk.overview()).payments.find((p) => p.id === jobId)!;
    assert.equal(approvalText(message), `I approve Hive payment ${shown.code}`);

    // Another payment's approval, a message that says more, and a stranger's approval count for nothing.
    const other = payMessage(counter, {
      left: SUPPLY - 1n,
      amount: 20_000n,
      validUntil: started.validUntil,
      program: started.program,
    });
    say(b, approvalText(other));
    say(b, `${approvalText(message)} 👍`);
    say(member(), approvalText(message));
    say(a, approvalText(message));
    await desk.tick();
    assert.deepEqual(desk.payment(jobId)!.approvals.map(Boolean), [true, false, false]);
    assert.equal(fake.sent.length, 0, "one approval pays nothing");

    say(c, approvalText(message));
    await desk.tick();
    assert.equal(desk.payment(jobId)?.status, "done");
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]!.args[0], 20_000n);
    assert.equal(fake.coins[0]!.assets![0]!.amount, Number(SUPPLY) - 1, "one counter unit burned");
    const [sigs, times, tags] = fake.sent[0]!.args.slice(3) as [Uint8Array[], Uint8Array[], Uint8Array[]];
    assert.equal(sigs.filter((s) => s.length).length, 2, "two keepers' signatures go to the covenant");
    assert.equal(new TextDecoder().decode(times[0]), String(clock.now));
    assert.match(new TextDecoder().decode(tags[2]), /^\[\["h",/);
    await desk.tick();
    assert.equal(fake.sent.length, 1, "paid once");
  } finally {
    cleanup();
  }
});

test("a job above what approved work has left waits, and says why", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const { desk, job, cleanup } = setup(clock, [treasuryCoin(500_000)]);
  try {
    const jobId = job(150_000);
    await desk.tick();
    assert.equal(desk.payment(jobId), undefined);
    const { waiting } = await desk.overview();
    assert.equal(waiting[0]?.jobId, jobId);
    assert.match(String(waiting[0]?.reason), /approved work has 100000 left/);
  } finally {
    cleanup();
  }
});

test("a payment the treasury coin cannot cover waits for the chip-in beside it to fold in", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const chipIn: Coin = { txid: hex(randomBytes(32)), vout: 0, value: 60_000 };
  const { desk, keepers, fake, job, say, cleanup } = setup(clock, [treasuryCoin(1_000), chipIn]);
  try {
    const jobId = job(20_000);
    await desk.tick();
    assert.deepEqual(
      fake.sent.map((s) => s.fn),
      ["merge"],
      "the chip-in folds in while the keepers approve",
    );
    for (const k of keepers.slice(0, 2)) say(k, approvalText(desk.message(desk.payment(jobId)!)));
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

test("payments go out in the order they started; one declined gives its number to the next", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const { desk, keepers, fake, job, say, cleanup } = setup(clock, [treasuryCoin(100_000)]);
  try {
    const [a, b] = keepers;
    const first = job(10_000);
    const second = job(5_000);
    await desk.tick();
    const one = desk.payment(first)!;
    const two = desk.payment(second)!;
    assert.deepEqual([one.left, two.left], [String(SUPPLY), String(SUPPLY - 1n)]);
    for (const k of [a, b]) say(k, approvalText(desk.message(two)));
    await desk.tick();
    assert.equal(fake.sent.length, 0, "the second waits for the first");
    say(b, declineText(desk.message(one)));
    await desk.tick();
    assert.equal(desk.payment(first)?.status, "declined");
    assert.equal(desk.payment(first)?.declinedBy, b.key);
    const renumbered = desk.payment(second)!;
    assert.equal(renumbered.left, String(SUPPLY), "the next number");
    assert.equal(renumbered.status, "approving", "its approvals named the old number");
    assert.deepEqual(renumbered.approvals, [null, null, null]);
    for (const k of [a, b]) say(k, approvalText(desk.message(renumbered)));
    await desk.tick();
    assert.equal(desk.payment(second)?.status, "done");
  } finally {
    cleanup();
  }
});

test("a keeper asks for a withdrawal in the channel; two keepers approve it like any payment", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const { desk, keepers, fake, say, address, cleanup } = setup(clock, [treasuryCoin(100_000)]);
  try {
    const [a, b, c] = keepers;
    const to = address();
    const asked = say(c, withdrawalText(5_000, to));
    say(member(), withdrawalText(9_000, address()));
    const elsewhere = say(a, withdrawalText(5_000, address(point())));
    await desk.tick();
    const w = desk.payment(asked.id)!;
    assert.equal(w.status, "approving");
    assert.equal(w.startedBy, c.key);
    assert.equal(w.address, to);
    assert.equal(desk.payment(elsewhere.id)?.status, "failed");
    assert.match(String(desk.payment(elsewhere.id)?.detail), /another Operator/);
    assert.equal(desk.payments().length, 2, "a member who is not a keeper asks for nothing");
    for (const k of [a, b]) say(k, approvalText(desk.message(w)));
    await desk.tick();
    assert.equal(desk.payment(asked.id)?.status, "done");
    assert.equal(fake.sent[0]!.args[0], 5_000n);
  } finally {
    cleanup();
  }
});

test("approvals lapse; a payment whose answer was lost is done when the counter moved", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const { desk, keepers, fake, job, say, cleanup } = setup(clock, [treasuryCoin(100_000)]);
  try {
    const [a, b] = keepers;
    const late = job(10_000);
    await desk.tick();
    const started = desk.payment(late)!;
    clock.now = started.validUntil;
    for (const k of [a, b]) say(k, approvalText(desk.message(started)));
    await desk.tick();
    assert.equal(desk.payment(late)?.status, "lapsed");
    assert.equal(fake.sent.length, 0);

    const lost = job(10_000);
    await desk.tick();
    const payment = desk.payment(lost)!;
    for (const k of [a, b]) say(k, approvalText(desk.message(payment)));
    // The Emulator accepted the payment and the answer never came back.
    fake.loseAnswers();
    await desk.tick();
    assert.equal(desk.payment(lost)?.status, "done", "the counter says it went out");
    assert.equal(fake.sent.length, 1);
  } finally {
    cleanup();
  }
});
