import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, utimesSync } from "node:fs";
import { test } from "node:test";
import { payFromTreasury } from "@hive/executor";
import { hex } from "@hive/kit";
import { approvalText, payMessage, withdrawalText } from "@hive/treasury";
import { opsPaths } from "../../tools/ops.js";
import { type Coin, member, point, SUPPLY, setup, treasuryCoin } from "../support/approvals-desk.js";

/**
 * The approvals desk of a v5 hive, following its channel, over a stand-in for the treasury contract
 * that keeps its coins in memory: a job the agent asks the keepers to fund becomes a payment, one
 * payment at a time is open under the treasury's number, two keepers' approval messages make it
 * ready, and the desk's round pays it, folding chip-ins in first when the treasury coin cannot cover
 * it. A keeper's decline stops the desk, a keeper asks for a withdrawal in the channel, and what
 * became of a payment is read from the transaction that spent the treasury coin.
 */
test("a job becomes a payment with the treasury's number; two keepers' messages approve it, and it pays once", async () => {
  const { desk, keepers, fake, job, counter, say, terms, cleanup } = setup([treasuryCoin(100_000)]);
  try {
    const jobId = job(20_000);
    const [a, b, c] = keepers;
    await desk.tick();
    const started = desk.payment(jobId)!;
    assert.equal(started.status, "approving");
    assert.equal(started.left, String(SUPPLY));
    assert.equal(started.amountSats, 20_000);
    assert.equal(started.startedBy, "agent");
    const message = payMessage(counter, terms(started));
    assert.deepEqual(desk.message(started), message, "the message the keepers' plugins rebuild");
    const shown = (await desk.overview()).payments.find((p) => p.id === jobId)!;
    const text = approvalText(counter, terms(started));
    assert.equal(
      text,
      `I approve Hive payment of 20000 sats to ${started.program.slice(0, 8)} ${shown.code}`,
    );
    assert.equal(desk.approval(started), text);

    // Another payment's approval, a message that says more, the code without its words and a
    // stranger's approval count for nothing.
    say(b, approvalText(counter, terms(started, SUPPLY - 1n)));
    say(b, `${text} 👍`);
    say(b, `I approve Hive payment ${shown.code}`);
    say(member(), text);
    say(a, text);
    await desk.tick();
    assert.deepEqual(desk.payment(jobId)!.approvals.map(Boolean), [true, false, false]);
    assert.equal(fake.sent.length, 0, "one approval pays nothing");

    say(c, text);
    await desk.tick();
    assert.equal(desk.payment(jobId)?.status, "done");
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]!.args[0], 20_000n);
    assert.equal(fake.treasuryCoin().assets![0]!.amount, Number(SUPPLY) - 1, "one counter unit burned");
    const [sigs, times, tags] = fake.sent[0]!.args.slice(3) as [Uint8Array[], Uint8Array[], Uint8Array[]];
    assert.equal(sigs.filter((s) => s.length).length, 2, "two keepers' signatures go to the covenant");
    assert.match(new TextDecoder().decode(times[0]), /^\d{10}$/);
    assert.match(new TextDecoder().decode(tags[2]), /^\[\["h",/);
    await desk.tick();
    assert.equal(fake.sent.length, 1, "paid once");
  } finally {
    cleanup();
  }
});

test("a job counts against what approved work has left, payments under way included", async () => {
  const { desk, keepers, fake, job, approve, cleanup } = setup([treasuryCoin(500_000)]);
  try {
    const [a, b] = keepers;
    const large = job(150_000);
    await desk.tick();
    assert.equal(desk.payment(large)?.status, "queued");
    assert.match(String(desk.payment(large)?.detail), /approved work has 100000 left/);
    assert.equal(desk.open(), undefined, "nothing is asked of the keepers");

    // Three jobs of 40,000 against 100,000: the agent has not yet seen the first two funded when
    // the third's turn comes, and the desk counts them all the same.
    const jobs = [job(40_000), job(40_000), job(40_000)];
    for (const id of jobs.slice(0, 2)) {
      await desk.tick();
      assert.equal(desk.open()?.id, id);
      approve(id, a, b);
      await desk.tick();
      assert.equal(desk.payment(id)?.status, "done");
    }
    await desk.tick();
    assert.equal(desk.payment(jobs[2]!)?.status, "queued");
    assert.match(String(desk.payment(jobs[2]!)?.detail), /approved work has 20000 left/);
    assert.equal(fake.sent.filter((s) => s.fn === "pay").length, 2);
    assert.equal((await desk.overview()).budget.remainingSats, 20_000);
  } finally {
    cleanup();
  }
});

test("on mainnet a job above the escrow ceiling gets no payment", async () => {
  const { desk, job, cleanup } = setup([treasuryCoin(900_000)], { network: "bitcoin", budgetSats: 500_000 });
  try {
    const above = job(60_000);
    const within = job(50_000);
    await desk.tick();
    assert.equal(desk.payment(above), undefined);
    const { waiting } = await desk.overview();
    assert.equal(waiting[0]?.jobId, above);
    assert.match(String(waiting[0]?.reason), /above the 50000 sats an escrow may hold on mainnet/);
    assert.equal(desk.open()?.id, within);
  } finally {
    cleanup();
  }
});

test("a payment the treasury coin cannot cover waits for the chip-in beside it to fold in", async () => {
  const chipIn: Coin = { txid: hex(randomBytes(32)), vout: 0, value: 60_000 };
  const { desk, keepers, fake, job, approve, cleanup } = setup([treasuryCoin(1_000), chipIn]);
  try {
    const jobId = job(20_000);
    await desk.tick();
    assert.deepEqual(
      fake.sent.map((s) => s.fn),
      ["merge"],
      "the chip-in folds in while the keepers approve",
    );
    approve(jobId, ...keepers.slice(0, 2));
    await desk.tick();
    assert.deepEqual(
      fake.sent.map((s) => s.fn),
      ["merge", "pay"],
    );
    assert.equal(desk.payment(jobId)?.status, "done");
    assert.equal(fake.treasuryCoin().value, 41_000);
  } finally {
    cleanup();
  }
});

test("one payment is open at a time: the next gets a number only when its turn comes, so no payment is approved under two", async () => {
  const { desk, keepers, fake, job, say, approve, inChannel, cleanup } = setup([treasuryCoin(100_000)]);
  try {
    const [a, b] = keepers;
    const first = job(10_000);
    const second = job(5_000);
    await desk.tick();
    const one = desk.payment(first)!;
    const two = desk.payment(second)!;
    assert.deepEqual([one.status, one.left], ["approving", String(SUPPLY)]);
    assert.deepEqual([two.status, two.left, two.validUntil], ["queued", null, 0], "no number while it waits");
    const shown = (await desk.overview()).payments.find((p) => p.id === second)!;
    assert.equal("code" in shown, false, "and no approval to send");

    say(b, desk.decline(one));
    await desk.tick();
    assert.equal(desk.payment(first)?.status, "declined");
    assert.equal(desk.payment(first)?.declinedBy, b.key);
    const next = desk.payment(second)!;
    assert.deepEqual([next.status, next.left], ["approving", String(SUPPLY)], "the treasury's number, now");
    approve(second, a, b);
    await desk.tick();
    assert.equal(desk.payment(second)?.status, "done");
    assert.equal(fake.sent.length, 1);
    // What the channel holds pays the second job under the number it went out under, and no other.
    const paid = desk.payment(second)!;
    assert.equal(inChannel(paid, SUPPLY).filter(Boolean).length, 2);
    assert.equal(inChannel(paid, SUPPLY - 1n).filter(Boolean).length, 0);
  } finally {
    cleanup();
  }
});

test("a keeper asks for a withdrawal in the channel, one at a time; two keepers approve it like any payment", async () => {
  const { desk, keepers, fake, say, approve, address, cleanup } = setup([treasuryCoin(100_000)]);
  try {
    const [a, b, c] = keepers;
    const to = address();
    const asked = say(c, withdrawalText(5_000, to));
    const again = say(c, withdrawalText(7_000, address()));
    say(member(), withdrawalText(9_000, address()));
    const elsewhere = say(a, withdrawalText(5_000, address(point())));
    await desk.tick();
    const w = desk.payment(asked.id)!;
    assert.equal(w.status, "approving");
    assert.equal(w.startedBy, c.key);
    assert.equal(w.address, to);
    assert.equal(
      desk.payments().length,
      1,
      "a second request, another Operator's address and a stranger queue nothing",
    );
    const { refused } = await desk.overview();
    assert.match(String(refused.find((r) => r.id === elsewhere.id)?.reason), /another Operator/);
    assert.match(String(refused.find((r) => r.id === again.id)?.reason), /one at a time/);
    approve(asked.id, a, b);
    await desk.tick();
    assert.equal(desk.payment(asked.id)?.status, "done");
    assert.equal(fake.sent[0]!.args[0], 5_000n);
    // Requests the desk refused are not picked up later.
    await desk.tick();
    assert.equal(desk.payments().length, 1);
  } finally {
    cleanup();
  }
});

test("jobs take their turn before withdrawals, and an open withdrawal nobody else approved steps aside for a job", async () => {
  const { clock, desk, keepers, job, say, approve, address, cleanup } = setup([treasuryCoin(100_000)], {
    patienceSeconds: 900,
  });
  try {
    const [a, b, c] = keepers;
    const w = say(c, withdrawalText(5_000, address()));
    await desk.tick();
    const [own] = approve(w.id, c);
    await desk.tick();
    const opened = desk.payment(w.id)!;
    assert.deepEqual(opened.approvals.map(Boolean), [false, false, true]);

    const waiting = job(10_000);
    await desk.tick();
    assert.equal(desk.open()?.id, w.id, "the withdrawal keeps its turn for a while");
    clock.now += 901;
    await desk.tick();
    assert.equal(desk.open()?.id, waiting);
    const aside = desk.payment(w.id)!;
    assert.deepEqual(
      [aside.status, aside.left, aside.validUntil],
      ["queued", opened.left, opened.validUntil],
    );

    // The job is declined, the treasury has not moved, and the withdrawal comes back as it was:
    // its keeper's approval still counts, under the same code.
    say(a, desk.decline(desk.payment(waiting)!));
    await desk.tick();
    const back = desk.payment(w.id)!;
    assert.deepEqual(
      [back.status, back.left, back.validUntil],
      ["approving", opened.left, opened.validUntil],
    );
    assert.equal(back.approvals[2]?.event, own!.id);
    approve(w.id, b);
    await desk.tick();
    assert.equal(desk.payment(w.id)?.status, "done");

    // A withdrawal waiting behind a job gets its number only after the job's has gone.
    const later = say(a, withdrawalText(1_000, address()));
    const ahead = job(10_000);
    await desk.tick();
    assert.equal(desk.open()?.id, ahead);
    assert.equal(desk.payment(later.id)?.left, null);
  } finally {
    cleanup();
  }
});

test("approvals lapse; a payment whose answer was lost is done once the treasury shows it paid", async () => {
  const { clock, desk, keepers, fake, job, approve, cleanup } = setup([treasuryCoin(100_000)]);
  try {
    const [a, b] = keepers;
    const late = job(10_000);
    await desk.tick();
    clock.now = desk.payment(late)!.validUntil;
    approve(late, a, b);
    await desk.tick();
    assert.equal(desk.payment(late)?.status, "lapsed");
    assert.equal(fake.sent.length, 0);

    const lost = job(10_000);
    await desk.tick();
    approve(lost, a, b);
    // The Emulator accepted the payment and the answer never came back.
    fake.loseAnswer();
    await desk.tick();
    const paid = desk.payment(lost)!;
    assert.equal(paid.status, "done", "the transaction that spent the treasury coin paid it");
    assert.match(String(paid.txid), /^[0-9a-f]{64}$/);
    assert.equal(fake.sent.length, 1);
  } finally {
    cleanup();
  }
});

test("a decline stops the desk, not approvals already sent: the desk says so, and records the payment if they are used", async () => {
  const { desk, keepers, fake, job, say, approve, inChannel, counter, cleanup } = setup([
    treasuryCoin(15_000),
  ]);
  try {
    const [a, b, c] = keepers;
    // Two keepers approve a payment the treasury cannot cover yet, and the third declines it.
    const first = job(20_000);
    await desk.tick();
    approve(first, a, b);
    await desk.tick();
    assert.equal(desk.payment(first)?.status, "ready");
    say(c, desk.decline(desk.payment(first)!));
    await desk.tick();
    const declined = desk.payment(first)!;
    assert.equal(declined.status, "declined");
    assert.match(String(declined.detail), /two keepers had approved it; their approvals stay valid until/);

    // The next payment takes the number. A chip-in arrives, and someone who read the channel
    // submits the declined payment on its two approvals before the desk pays the next.
    const second = job(5_000);
    await desk.tick();
    assert.equal(desk.payment(second)?.left, String(SUPPLY));
    approve(second, a, b);
    fake.outsider.merge(50_000);
    await payFromTreasury(
      fake.contract,
      fake.treasuryCoin(),
      counter.assetId,
      { amount: 20_000n, program: Buffer.from(declined.program, "hex"), validUntil: declined.validUntil },
      inChannel(declined, SUPPLY),
    );
    await desk.tick();
    const recorded = desk.payment(first)!;
    assert.equal(recorded.status, "done", "the desk's record follows the treasury");
    assert.match(String(recorded.detail), /paid on approvals sent before it was declined/);
    assert.match(String(recorded.txid), /^[0-9a-f]{64}$/);
    // The second job never went out under that number: it takes the next, and is approved under it.
    const renumbered = desk.payment(second)!;
    assert.deepEqual([renumbered.status, renumbered.left], ["approving", String(SUPPLY - 1n)]);
    assert.deepEqual(renumbered.approvals, [null, null, null]);
    approve(second, a, b);
    await desk.tick();
    assert.equal(desk.payment(second)?.status, "done");
    assert.equal(fake.treasuryCoin().value, 15_000 + 50_000 - 20_000 - 5_000);
  } finally {
    cleanup();
  }
});

test("a merge that takes the treasury coin first does not cost the payment an attempt; a refusal on a standing coin does", async () => {
  const { desk, keepers, fake, job, approve, cleanup } = setup([treasuryCoin(100_000)]);
  try {
    const [a, b] = keepers;
    const jobId = job(20_000);
    await desk.tick();
    approve(jobId, a, b);
    // Anyone may merge a chip-in, which replaces the treasury coin: three land just ahead of the desk.
    let merges = 0;
    const racing = () => {
      fake.outsider.merge(330);
      if (++merges < 3) fake.beforeNextSpend(racing);
    };
    fake.beforeNextSpend(racing);
    await desk.tick();
    const paid = desk.payment(jobId)!;
    assert.equal(paid.status, "done", "it goes again at once on the coin that replaced it");
    assert.equal(paid.attempts, undefined);
    assert.equal(merges, 3);

    const refused = job(20_000);
    await desk.tick();
    approve(refused, a, b);
    fake.failWith("the Emulator refused the transaction");
    for (let i = 0; i < 3; i++) await desk.tick();
    const failed = desk.payment(refused)!;
    assert.deepEqual([failed.status, failed.attempts], ["failed", 3]);
    assert.match(String(failed.detail), /refused the transaction/);
  } finally {
    cleanup();
  }
});

test("nothing is decided while the indexer cannot say what became of the treasury coin", async () => {
  const { desk, keepers, fake, job, approve, cleanup } = setup([treasuryCoin(100_000)]);
  try {
    const [a, b] = keepers;
    const jobId = job(20_000);
    await desk.tick();
    approve(jobId, a, b);
    fake.loseAnswer();
    fake.indexerDown(true);
    await desk.tick();
    await desk.tick();
    assert.equal(desk.payment(jobId)?.status, "submitted", "neither paid nor asked for again");
    fake.indexerDown(false);
    await desk.tick();
    assert.equal(desk.payment(jobId)?.status, "done");
    assert.equal(fake.sent.length, 1);
  } finally {
    cleanup();
  }
});

test("a message its keeper deleted no longer counts at the desk", async () => {
  const { desk, keepers, fake, job, say, unsay, approve, address, cleanup } = setup([treasuryCoin(100_000)]);
  try {
    const [a, b, c] = keepers;
    const jobId = job(20_000);
    await desk.tick();
    const [first] = approve(jobId, a);
    await desk.tick();
    assert.deepEqual(desk.payment(jobId)!.approvals.map(Boolean), [true, false, false]);
    unsay(a, first!.id);
    // A deletion counts from the message's own author only.
    unsay(b, first!.id);
    approve(jobId, b);
    await desk.tick();
    assert.deepEqual(desk.payment(jobId)!.approvals.map(Boolean), [false, true, false]);
    assert.equal(fake.sent.length, 0);
    approve(jobId, c);
    await desk.tick();
    assert.equal(desk.payment(jobId)?.status, "done");

    // A keeper takes back a withdrawal request the same way.
    const asked = say(c, withdrawalText(5_000, address()));
    await desk.tick();
    assert.equal(desk.payment(asked.id)?.status, "approving");
    unsay(c, asked.id);
    await desk.tick();
    assert.deepEqual(
      [desk.payment(asked.id)?.status, desk.payment(asked.id)?.declinedBy],
      ["declined", c.key],
    );
  } finally {
    cleanup();
  }
});

test("finished payments leave the live folder after a week, and are not started again", async () => {
  const { clock, hive, desk, keepers, fake, job, approve, cleanup } = setup([treasuryCoin(100_000)]);
  try {
    const [a, b] = keepers;
    const jobId = job(20_000, clock.now + 30 * 86_400);
    await desk.tick();
    approve(jobId, a, b);
    await desk.tick();
    assert.equal(desk.payment(jobId)?.status, "done");
    clock.now += 8 * 86_400;
    await desk.tick();
    assert.equal(desk.payment(jobId), undefined);
    const folder = opsPaths(hive).local("desk", "archive");
    assert.deepEqual(readdirSync(folder), [`${jobId}.json`]);
    // The agent's log still names the job as waiting: the desk knows it paid it.
    await desk.tick();
    assert.equal(desk.payments().length, 0);
    assert.equal(fake.sent.length, 1);
    // A payment file changed behind the desk's back is read again.
    const other = job(10_000, clock.now + 86_400);
    await desk.tick();
    const path = opsPaths(hive).local("desk", "payments", `${other}.json`);
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    assert.equal(desk.payment(other)?.status, "approving");
  } finally {
    cleanup();
  }
});
