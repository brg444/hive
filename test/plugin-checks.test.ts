import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { arkAddress, jobEscrow, MAINNET_CEILINGS, MAINNET_PINS, type Network } from "@hive/ark";
import { hex } from "@hive/kit";
import { approvalText, codeOf, counterOf, payMessage, withdrawalText } from "@hive/treasury";
import { schnorr } from "@noble/curves/secp256k1.js";

/**
 * What a keeper's Hive plugin checks before it offers an approval (hive/hive-buzz/plugin/checks.mjs),
 * run here as the plugin bundles it: the treasury is the one the keepers' keys build, a job stays
 * within the mainnet ceiling and what approved proposals have left, its receipts are the hive's
 * agent's to sign, a withdrawal was asked for by a keeper in the channel, the payment is the one
 * whose turn it is, and a keeper approves a payment under one number only.
 */
interface Checked {
  problems: string[];
  code: string | null;
  approve: string | null;
  decline: string | null;
  agentPk: string | null;
  mine: boolean;
}
interface Checks {
  treasuryScript(payments: unknown, keepers: string[]): string;
  checkPayment(input: Record<string, unknown>): Checked;
}
const checks = (await import(new URL("../hive/hive-buzz/plugin/checks.mjs", import.meta.url).href)) as Checks;

const key = () => hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
const now = Math.floor(Date.now() / 1000);

function hive(network: Network = "regtest") {
  const keepers = [key(), key(), key()];
  const mainnet = network === "bitcoin";
  const operator = mainnet
    ? {
        network,
        server: MAINNET_PINS.operatorKey,
        emulator: MAINNET_PINS.emulatorKey,
        exitDelay: MAINNET_PINS.exitDelaySeconds,
      }
    : { network, server: `02${key()}`, emulator: `03${key()}`, exitDelay: 512 };
  const conn = {
    deployment: { network },
    keys: { server: operator.server, emulator: operator.emulator },
    operator: { unilateralExitDelay: operator.exitDelay },
  };
  const counter = counterOf(`${hex(randomBytes(32))}0000`);
  const base = {
    v: 5,
    counter,
    keepers,
    units: "999990",
    terms: {
      delegateKey: `02${key()}`,
      renewalWindowSeconds: 172_800,
      maxFeeSats: 500,
      exitDelaySeconds: operator.exitDelay,
    },
    operator,
  };
  const treasuryScript = checks.treasuryScript(base, keepers);
  const payments = { ...base, treasuryScript };
  const treasury = arkAddress(network, operator.server, treasuryScript);
  const agent = key();
  const job = (capSats: number, over: { agentPk?: string; treasuryProgram?: string } = {}) => {
    const jobId = hex(randomBytes(32));
    const params = {
      agentPk: over.agentPk ?? agent,
      providerPk: key(),
      treasuryProgram: over.treasuryProgram ?? treasuryScript.slice(4),
      deadline: now + 7200,
      jobId,
    };
    const escrow = jobEscrow(conn as never, params);
    return {
      id: jobId,
      kind: "job",
      address: escrow.address,
      program: escrow.pkScript.slice(4),
      amountSats: capSats,
      left: "999990",
      validUntil: now + 3600,
      remainingSats: 100_000,
      approvedBy: [],
      status: "approving",
      request: {
        jobId,
        address: escrow.address,
        capSats,
        deadline: params.deadline,
        model: "m",
        providerPk: params.providerPk,
        params,
      },
    };
  };
  const withdrawal = (amountSats: number, id = hex(randomBytes(32))) => {
    const program = hex(randomBytes(32));
    return {
      id,
      kind: "withdrawal",
      address: arkAddress(network, operator.server, `5120${program}`),
      program,
      amountSats,
      left: "999990",
      validUntil: now + 3600,
      withdrawal: { destination: `5120${program}`, amountSats },
      approvedBy: [],
      status: "approving",
      startedBy: keepers[2],
    };
  };
  const check = (payment: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    checks.checkPayment({ payments, payment, keepers, treasury, agent, now, ...more });
  return { keepers, counter, payments, treasury, treasuryScript, agent, operator, job, withdrawal, check };
}

test("a job within its limits checks out, and the plugin writes the approval the covenant rebuilds", () => {
  const h = hive("bitcoin");
  const job = h.job(MAINNET_CEILINGS.escrowSats);
  const checked = h.check(job, { budgetSats: 60_000 });
  assert.deepEqual(checked.problems, []);
  const terms = {
    left: 999_990n,
    amount: BigInt(job.amountSats),
    validUntil: job.validUntil,
    program: job.program,
  };
  assert.equal(checked.approve, approvalText(h.counter, terms));
  assert.equal(checked.code, codeOf(payMessage(h.counter, terms)));
  assert.match(
    String(checked.approve),
    /^I approve Hive payment of 50000 sats to [0-9a-f]{8} [A-Za-z0-9_-]{43}$/,
  );
  assert.equal(checked.agentPk, h.agent);
});

test("on mainnet a job above the escrow ceiling is refused, whatever budget the host reports", () => {
  const h = hive("bitcoin");
  for (const cap of [MAINNET_CEILINGS.escrowSats + 1, 5_000_000]) {
    const { problems, approve } = h.check(h.job(cap), { budgetSats: 10_000_000 });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /more than the 50,000 sats an escrow may hold on mainnet/);
    assert.ok(approve, "the text exists, and the row shows the refusal instead of the button");
  }
  // Another network has no ceiling of this kind.
  assert.deepEqual(
    hive()
      .check(h.job(5_000_000))
      .problems.filter((p) => /ceiling|may hold/.test(p)),
    [],
  );
});

test("a job that asks more than approved proposals have left is refused", () => {
  const h = hive();
  const job = h.job(20_000);
  assert.match(
    h.check(job, { budgetSats: 19_999 }).problems.join(),
    /more than approved proposals have left: 19,999 sats/,
  );
  assert.match(h.check(job, { budgetSats: 0 }).problems.join(), /have left: 0 sats/);
  assert.deepEqual(h.check(job, { budgetSats: 20_000 }).problems, []);
  assert.deepEqual(
    h.check(job, { budgetSats: null }).problems,
    [],
    "no count of its own: nothing to hold it to",
  );
});

test("a job whose receipts another agent would sign is refused", () => {
  const h = hive();
  const other = key();
  const { problems, agentPk } = h.check(h.job(20_000, { agentPk: other }));
  assert.equal(agentPk, other);
  assert.match(problems.join(), /receipts would be signed by another agent/);
  assert.deepEqual(
    h.check(h.job(20_000, { agentPk: other }), { agent: null }).problems,
    [],
    "the first agent it sees",
  );
});

test("the treasury is the one the keepers' keys build: a host cannot name another, for payments or for chip-ins", () => {
  const h = hive("bitcoin");
  const own = `5120${hex(randomBytes(32))}`;
  // The host states a script of its own, shows its address to members and builds the escrow to give back to it.
  const lying = { ...h.payments, treasuryScript: own };
  const { problems } = checks.checkPayment({
    payments: lying,
    payment: h.job(40_000, { treasuryProgram: own.slice(4) }),
    keepers: h.keepers,
    treasury: arkAddress("bitcoin", h.operator.server, own),
    agent: h.agent,
    now,
  });
  assert.match(
    problems.join(" "),
    /The treasury the host pays from is not the one the keepers' keys and its terms build\./,
  );
  assert.match(problems.join(" "), /The address members chip in to is not this hive's treasury\./);
  assert.match(problems.join(" "), /The escrow gives back to another treasury than this hive's\./);

  // Other keepers than the plugin's, another Operator on mainnet, and terms that let a renewal take too much.
  const strangers = [key(), key(), key()];
  assert.match(
    checks
      .checkPayment({
        payments: { ...h.payments, keepers: strangers },
        payment: h.job(1_000),
        keepers: h.keepers,
        treasury: h.treasury,
        now,
      })
      .problems.join(),
    /names other keepers than this channel confirmed/,
  );
  const elsewhere = { ...h.payments, operator: { ...h.operator, emulator: `03${key()}` } };
  assert.match(
    checks
      .checkPayment({
        payments: elsewhere,
        payment: h.job(1_000),
        keepers: h.keepers,
        treasury: h.treasury,
        now,
      })
      .problems.join(),
    /names an Operator other than Arkade's/,
  );
  const greedy = { ...h.payments, terms: { ...h.payments.terms, maxFeeSats: 50_000 } };
  const withFee = { ...greedy, treasuryScript: checks.treasuryScript(greedy, h.keepers) };
  assert.match(
    checks
      .checkPayment({
        payments: withFee,
        payment: h.job(1_000, { treasuryProgram: withFee.treasuryScript.slice(4) }),
        keepers: h.keepers,
        treasury: arkAddress("bitcoin", h.operator.server, withFee.treasuryScript),
        now,
      })
      .problems.join(),
    /let a renewal take more than 2000 sats/,
  );
});

test("a withdrawal is one a keeper asked for in the channel, when the plugin reads the channel", () => {
  const h = hive();
  const w = h.withdrawal(900_000);
  const asked = (pubkey: string, amountSats = w.amountSats) => ({
    id: w.id,
    kind: 9,
    pubkey,
    created_at: now - 60,
    tags: [],
    content: withdrawalText(amountSats, w.address),
  });
  assert.deepEqual(h.check(w, { events: [asked(h.keepers[2]!)] }).problems, []);
  assert.match(
    h.check(w, { events: [] }).problems.join(),
    /No keeper's message in this channel asks for this withdrawal/,
  );
  assert.match(h.check(w, { events: [asked(key())] }).problems.join(), /No keeper's message/);
  assert.match(
    h.check(w, { events: [asked(h.keepers[2]!, 9_000)] }).problems.join(),
    /asks for another amount or address/,
  );
  assert.deepEqual(
    h.check(w, { events: null }).problems,
    [],
    "without the channel it has only the desk's word",
  );
  assert.match(
    h.check({ ...w, address: h.treasury, program: h.treasuryScript.slice(4) }).problems.join(),
    /pays the treasury itself/,
  );
});

test("only the payment whose turn it is, for no longer than a day", () => {
  const h = hive();
  const job = h.job(20_000);
  assert.match(h.check({ ...job, left: "999989" }).problems.join(), /not this payment's turn/);
  assert.match(h.check({ ...job, left: null }).problems.join(), /not this payment's turn/);
  assert.match(h.check({ ...job, validUntil: now + 86_401 }).problems.join(), /valid for more than a day/);
  assert.match(h.check({ ...job, validUntil: now + 30 }).problems.join(), /lapse too soon/);
});

test("a keeper approves a payment under one number: the same amount to the same recipient is not offered again within a day", () => {
  const h = hive();
  const job = h.job(20_000);
  const { code } = h.check(job);
  const earlier = (at: number, over: Record<string, unknown> = {}) => ({
    code: "B".repeat(43),
    amountSats: 20_000,
    recipient: job.program.slice(0, 8),
    at,
    ...over,
  });
  const again = h.check(job, { approved: [earlier(now - 3600)] });
  assert.match(again.problems.join(), /You approved this amount to this recipient under another number/);
  assert.deepEqual(
    h.check(job, { approved: [earlier(now - 90_000)] }).problems,
    [],
    "that approval has lapsed",
  );
  assert.deepEqual(h.check(job, { approved: [earlier(now - 60, { amountSats: 19_000 })] }).problems, []);
  assert.deepEqual(h.check(job, { approved: [earlier(now - 60, { recipient: "00000000" })] }).problems, []);
  const mine = h.check(job, { approved: [earlier(now - 60, { code })] });
  assert.deepEqual([mine.problems, mine.mine], [[], true], "the approval already sent for this very payment");
});
