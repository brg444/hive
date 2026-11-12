import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  ARTIFACTS,
  claimMessage,
  deriveAccount,
  type EscrowTerms,
  escrowAccount,
  escrowArguments,
  escrowClaimTemplate,
  escrowVariables,
  sendMessages,
} from "@hive/ark";
import { faultCode, hex, localPath, writeJson } from "@hive/kit";
import {
  driveTreasurySpend,
  executeRefund,
  newSpendJournal,
  observeTreasury,
  planTreasurySend,
  refundEscrow,
  registerClaim,
  withdraw,
} from "@hive/hive";
import { escrowTermsFromQuote, signQuote, signReceipt } from "@hive/protocol";
import { approveWithdrawal, signWithPair } from "@hive/steward";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hiveFixture } from "../support/hive-v4.js";

/**
 * The v4 treasury against the in-memory network: a pair of stewards funds an
 * escrow by signing short messages, refuses what its policy does not allow,
 * and registers a provider's claim; the delegatee refunds at the deadline.
 */
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return faultCode(error);
  }
};

const fund = (hive: Awaited<ReturnType<typeof hiveFixture>>, escrow: { pkScript: string }, amount: number) =>
  planTreasurySend(hive.treasury, { pair: "01", amount, destination: escrow.pkScript, validSeconds: 600 });

test("a pair funds an escrow, a pair registers the provider's claim, and the treasury gets the rest", async (t) => {
  const hive = await hiveFixture(t);
  hive.fake.mint(hive.account.pkScript, 50_000);
  const { quote, escrow: terms, secrets } = await hive.quote();
  const escrow = await hive.escrow(terms);

  const plan = await fund(hive, escrow, 20_000);
  const path = localPath("v4-test", hex(randomBytes(8)), "allocation.json");
  writeJson(path, newSpendJournal("first", { kind: "allocation", quote }, plan));
  const journal = await driveTreasurySpend(hive.treasury, path, { pollMs: 50 });
  assert.equal(journal.status, "done");
  assert.equal(hive.fake.balance(escrow.pkScript), 20_000);
  assert.equal(hive.fake.balance(hive.account.pkScript), 30_000);

  // The same quote is never funded twice.
  const again = await fund(hive, escrow, 20_000);
  writeJson(
    path.replace("allocation", "again"),
    newSpendJournal("again", { kind: "allocation", quote }, again),
  );
  assert.equal(
    await code(driveTreasurySpend(hive.treasury, path.replace("allocation", "again"))),
    "ESCROW_FUNDED",
  );

  // The provider claims 7,000 sats with the payer's receipt and its own signature.
  const receipt = signReceipt({ escrowId: quote.quoteId, amountSats: "7000" }, secrets.payer);
  const claimSignature = hex(schnorr.sign(claimMessage(quote.quoteId, 7000), secrets.workload));
  const escrowArtifact = escrow.artifactId;
  const claim = await registerClaim(
    hive.treasury,
    { quote, receipt, claimSignature },
    { pair: "12", escrowArtifactId: escrowArtifact },
  );
  const state = await hive.conn.delegatee.spendState(claim.spendId);
  assert.equal(state.delegation.status, "done");
  assert.equal(hive.fake.balance(`5120${terms.providerProgram}`), 7_000);
  assert.equal(hive.fake.balance(hive.account.pkScript), 43_000);
  assert.equal(hive.fake.balance(escrow.pkScript), 0);
});

test("stewards refuse a claim the provider did not sign, an unwatched escrow and a coin already promised", async (t) => {
  const hive = await hiveFixture(t);
  hive.fake.mint(hive.account.pkScript, 50_000);
  const { quote, escrow: terms, secrets } = await hive.quote();

  // No refund watch: the escrow address is derived but never registered.
  const unwatched = deriveAccount(hive.conn, "escrow", escrowArguments(terms));
  const plan = await fund(hive, unwatched, 20_000);
  const base = localPath("v4-test", hex(randomBytes(8)));
  writeJson(`${base}/a.json`, newSpendJournal("a", { kind: "allocation", quote }, plan));
  assert.equal(await code(driveTreasurySpend(hive.treasury, `${base}/a.json`)), "REFUND_NOT_WATCHED");

  // Register it; the plan now passes, and a second purchase over the same coin is refused.
  const escrow = await hive.escrow(terms);
  const first = await fund(hive, escrow, 20_000);
  const attest = (quoteValue: typeof quote, plan: typeof first) =>
    signWithPair(
      hive.treasury.stewards,
      hive.stewardKeys,
      {
        id: hex(randomBytes(32)),
        pair: "01",
        purpose: { kind: "allocation", stage: "attest", quote: quoteValue, plan },
      },
      sendMessages(plan, hive.account.instance, hive.conn.operator.checkpointTapscript),
    );
  await attest(quote, first);
  const other = await hive.quote();
  const otherEscrow = await hive.escrow(other.escrow);
  const second = await fund(hive, otherEscrow, 20_000);
  assert.deepEqual(second.coins, first.coins);
  assert.equal(await code(attest(other.quote, second)), "RESERVED");

  // A claim signed by someone other than the provider never reaches the delegatee.
  hive.fake.mint(escrow.pkScript, 20_000);
  const receipt = signReceipt({ escrowId: quote.quoteId, amountSats: "7000" }, secrets.payer);
  const forged = hex(schnorr.sign(claimMessage(quote.quoteId, 7000), secrets.rfq));
  assert.equal(
    await code(
      registerClaim(
        hive.treasury,
        { quote, receipt, claimSignature: forged },
        { escrowArtifactId: escrow.artifactId },
      ),
    ),
    "CLAIM_INVALID",
  );
});

test("the delegatee returns an unclaimed escrow to the treasury at its deadline", async (t) => {
  const hive = await hiveFixture(t);
  const { escrow: terms } = await hive.quote();
  const past: EscrowTerms = { ...terms, timeoutAt: Math.floor(Date.now() / 1000) - 5 };
  const escrow = await escrowAccount(hive.conn, past);
  hive.fake.mint(escrow.pkScript, 12_345);
  hive.fake.tick();
  assert.equal(hive.fake.balance(escrow.pkScript), 0);
  assert.equal(hive.fake.balance(hive.account.pkScript), 12_345);
});

test("a decoy watch registered first cannot keep an escrow from its refund: a pair registers it", async (t) => {
  const hive = await hiveFixture(t);
  const now = Math.floor(Date.now() / 1000);
  // A deadline already passed: the escrow is due for its refund.
  const { quote, escrow: terms } = await hive.quote({
    timeoutAt: String(now - 5),
    quoteExpiresAt: String(now - 60),
  });
  // Someone who knows the quote watches the escrow first, with a template that never acts.
  const artifactId = await hive.conn.delegatee.registerArtifact(ARTIFACTS.escrow);
  const decoy = await hive.conn.delegatee.registerTemplate(escrowClaimTemplate(artifactId, false));
  const address = deriveAccount(hive.conn, "escrow", escrowArguments(terms)).address;
  await hive.conn.delegatee.watch(decoy, {
    ...escrowVariables(terms),
    amount: "01",
    receipt_sig: "00".repeat(64),
    claim_sig: "00".repeat(64),
  });
  const escrow = await hive.escrow(terms);
  assert.equal(escrow.address, address);
  hive.fake.mint(escrow.pkScript, Number(quote.body.capSats));
  hive.fake.tick();
  assert.equal(hive.fake.balance(escrow.pkScript), 20_000, "the hive's own watch is not the one acting");

  // The coordinator cannot reach the Emulator to execute the refund itself, so a pair registers it.
  hive.fake.emulatorUnavailable = true;
  const own = await executeRefund(hive.treasury, quote, { timeoutMs: 300 });
  assert.equal(own?.txid, undefined);
  assert.ok(own?.attempts.every((a) => a.result === "unavailable"));
  const refund = await refundEscrow(hive.treasury, quote, { escrowArtifactId: escrow.artifactId });
  assert.ok(refund);
  assert.equal(hive.fake.balance(escrow.pkScript), 0);
  assert.equal(hive.fake.balance(hive.account.pkScript), 20_000);
  const fetchOriginal = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.notEqual(init?.method, "POST", "a completed refund resumes without another POST");
    return fetchOriginal(input, init);
  });
  assert.deepEqual(await refundEscrow(hive.treasury, quote, { escrowArtifactId: escrow.artifactId }), refund);
});

test("from its deadline the coordinator executes an escrow's refund itself, with no signature at all", async (t) => {
  const hive = await hiveFixture(t);
  const now = Math.floor(Date.now() / 1000);
  const { quote, escrow: terms } = await hive.quote({
    timeoutAt: String(now + 2),
    quoteExpiresAt: String(now - 60),
  });
  const escrow = await hive.escrow(terms);
  hive.fake.mint(escrow.pkScript, Number(quote.body.capSats));
  assert.equal(await executeRefund(hive.treasury, quote).then(() => "ok", faultCode), "REFUND_EARLY");
  await new Promise((r) => setTimeout(r, 2_500));
  const own = await executeRefund(hive.treasury, quote);
  assert.ok(own?.txid);
  assert.deepEqual(
    own.attempts.map((a) => `${a.route}:${a.result}`),
    ["self:accepted"],
  );
  assert.equal(hive.fake.balance(escrow.pkScript), 0);
  assert.equal(hive.fake.balance(hive.account.pkScript), 20_000);
  const fetchOriginal = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.notEqual(init?.method, "POST", "a completed refund resumes without another POST");
    return fetchOriginal(input, init);
  });
  assert.deepEqual(await executeRefund(hive.treasury, quote), own, "resume observes the same fixed refund");
});

test("an approved request funds one quote, an approved withdrawal one plan", async (t) => {
  const hive = await hiveFixture(t);
  hive.fake.mint(hive.account.pkScript, 30_000);
  hive.fake.mint(hive.account.pkScript, 30_000);
  const { quote, escrow: terms, secrets } = await hive.quote();
  const escrow = await hive.escrow(terms);
  const base = localPath("v4-test", hex(randomBytes(8)));
  const plan = await fund(hive, escrow, 20_000);
  writeJson(`${base}/first.json`, newSpendJournal("first", { kind: "allocation", quote }, plan));
  assert.equal((await driveTreasurySpend(hive.treasury, `${base}/first.json`)).status, "done");

  // The provider signs a second quote for the same request: a different escrow, refused.
  const { quoteNonce: _nonce, ...body } = quote.body;
  const twin = signQuote({ ...body, quoteNonce: hex(randomBytes(32)) }, secrets.rfq);
  const twinEscrow = await hive.escrow(escrowTermsFromQuote(twin) as EscrowTerms);
  const twinPlan = await fund(hive, twinEscrow, 20_000);
  writeJson(`${base}/twin.json`, newSpendJournal("twin", { kind: "allocation", quote: twin }, twinPlan));
  assert.equal(await code(driveTreasurySpend(hive.treasury, `${base}/twin.json`)), "REQUEST_ALREADY_QUOTED");

  // A withdrawal approval pays once; the same terms planned again are refused.
  const withdrawal = {
    label: "once",
    destination: `5120${hex(randomBytes(32))}`,
    amountSats: 1_000,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  for (const path of [hive.configPaths[0]!, hive.configPaths[1]!]) await approveWithdrawal(path, withdrawal);
  const paid = await withdraw(hive.treasury, { withdrawal, journalPath: `${base}/w1.json`, pair: "01" });
  assert.equal(paid.status, "done");
  assert.equal(
    await code(withdraw(hive.treasury, { withdrawal, journalPath: `${base}/w2.json`, pair: "01" })),
    "WITHDRAWAL_USED",
  );
  assert.equal(hive.fake.balance(withdrawal.destination), 1_000);
});

test("a pair's signing session resumes after a lost answer, and a lapsed plan closes unsigned", async (t) => {
  const hive = await hiveFixture(t);
  hive.fake.mint(hive.account.pkScript, 30_000);
  const { quote, escrow: terms } = await hive.quote();
  const escrow = await hive.escrow(terms);
  const plan = await fund(hive, escrow, 20_000);
  const session = {
    id: hex(randomBytes(32)),
    pair: "01" as const,
    purpose: { kind: "allocation" as const, stage: "attest" as const, quote, plan },
  };
  const messages = sendMessages(plan, hive.account.instance, hive.conn.operator.checkpointTapscript);
  const first = await signWithPair(hive.treasury.stewards, hive.stewardKeys, session, messages);
  assert.deepEqual(await signWithPair(hive.treasury.stewards, hive.stewardKeys, session, messages), first);

  const lapsed = { ...plan, validUntil: Math.floor(Date.now() / 1000) + 30 };
  const path = localPath("v4-test", hex(randomBytes(8)), "lapsed.json");
  writeJson(path, newSpendJournal("lapsed", { kind: "allocation", quote }, lapsed));
  assert.equal((await driveTreasurySpend(hive.treasury, path)).status, "expired");
});

test("renewed treasury coins are told from contributions by the indexer alone", async (t) => {
  const hive = await hiveFixture(t, { renewalWindowSeconds: 600 });
  hive.fake.renewalFeeSats = 100;
  const original = hive.fake.mint(hive.account.pkScript, 10_000, { expiresInSeconds: 300 });
  hive.fake.tick();
  // A stranger's newer watch on the treasury changes nothing.
  await hive.conn.delegatee.watch(hive.account.watch.templateId, {});
  const { renewals, contributions } = await observeTreasury(hive.conn, {
    treasuryScript: hive.account.pkScript,
    internalTxids: new Set(),
    renewalMaxFeeSats: 500,
  });
  assert.deepEqual(
    renewals.map((r) => [r.amountSats, r.sources]),
    [[9_900, [`${original.txid}:${original.vout}`]]],
  );
  assert.deepEqual(
    contributions.map((c) => [c.txid, c.amountSats]),
    [[original.txid, 10_000]],
  );
});
