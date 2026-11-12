import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { type TestContext, test } from "node:test";
import {
  openWallet,
  paymentHashOf,
  type WalletSendJournal,
  walletBalance,
  walletSend,
  walletTerms,
} from "@hive/ark";
import { CovenantRefusal, type Route } from "@hive/executor";
import { faultCode, hex, localPath, readJson, secretPath, writeJson } from "@hive/kit";
import {
  buildHiveView,
  driveTreasurySpend,
  newSpendJournal,
  planTreasurySend,
  registerClaim,
} from "@hive/hive";
import {
  approveProviderRequest,
  type ClaimDesk,
  type ClaimJournal,
  type CashoutJournal,
  cashOut,
  claimEscrow,
  retireExpiredCashout,
  writeProviderConfig,
} from "@hive/provider";
import { escrowTermsFromQuote, quoteCostSats, quoteTerms, signReceipt } from "@hive/protocol";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { signClaim } from "../../packages/provider/src/claim.js";
import { startFakeNetwork } from "../support/fake-network.js";
import { frozenSidecar, hiveFixture } from "../support/hive-v4.js";
import { startSwapStub } from "../support/swap-stub.js";

/**
 * The provider's side: its payout account is a SimpleWallet,
 * its claim is one signature handed to the hive, and its
 * cash-out is one wallet send to a solver's lockup.
 */
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return faultCode(error);
  }
};

async function payoutWallet(t: TestContext, conn: Parameters<typeof openWallet>[0]) {
  const ownerSecret = secp256k1.utils.randomSecretKey();
  const owner = hex(secp256k1.getPublicKey(ownerSecret, true));
  const wallet = await openWallet(
    conn,
    walletTerms(conn, owner, { renewalWindowSeconds: 600, maxFeeSats: 500 }),
  );
  const directory = localPath("v4-test", randomUUID());
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { ownerSecret, wallet, directory };
}

/** An escrow funded for the provider, its frozen sidecar and a desk that registers through a pair. */
async function claimSetup(t: TestContext) {
  const hive = await hiveFixture(t);
  hive.fake.mint(hive.account.pkScript, 50_000);
  const { wallet, directory } = await payoutWallet(t, hive.conn);
  const {
    quote,
    escrow: terms,
    secrets,
  } = await hive.quote({ providerPayoutScript: wallet.account.pkScript });
  const escrow = await hive.escrow(terms);
  const plan = await planTreasurySend(hive.treasury, {
    pair: "02",
    amount: 20_000,
    destination: escrow.pkScript,
    validSeconds: 600,
  });
  writeJson(resolve(directory, "funding.json"), newSpendJournal("fund", { kind: "allocation", quote }, plan));
  assert.equal((await driveTreasurySpend(hive.treasury, resolve(directory, "funding.json"))).status, "done");

  const configPath = secretPath("v4-test", randomUUID(), "provider.json");
  t.after(() => rmSync(resolve(configPath, ".."), { recursive: true, force: true }));
  writeProviderConfig(configPath, {
    schema: "hive-provider/v4",
    workloadSecret: hex(secrets.workload),
    stateDirectory: resolve(directory, "provider"),
    deployment: hive.fake.deployment(),
    approvedRequests: [],
  });
  await approveProviderRequest(configPath, quoteTerms(quote.body));

  const owed = quoteCostSats(quote.body, "300", "400");
  const receipt = signReceipt({ escrowId: quote.quoteId, amountSats: owed.toString() }, secrets.payer);
  const sidecarUrl = await frozenSidecar(t, {
    latestReceipt: receipt,
    cumulativeInputTokens: "300",
    cumulativeOutputTokens: "400",
  });
  const handed: unknown[] = [];
  const desk: ClaimDesk = {
    async submit(claim) {
      handed.push(claim);
      return registerClaim(hive.treasury, claim, { pair: "12", escrowArtifactId: escrow.artifactId });
    },
  };
  const options = {
    stateDirectory: resolve(directory, "claim"),
    sidecarUrl,
    bearerToken: "token",
    signer: { signClaim: (request: unknown) => signClaim(configPath, request) },
    desk,
    pollMs: 50,
    selfMs: 2_000,
  };
  return { hive, wallet, quote, secrets, owed, handed, options, configPath, directory };
}

test("the provider executes its own claim, needing no steward, and the payout wallet receives it", async (t) => {
  const { hive, wallet, quote, secrets, owed, handed, options, configPath } = await claimSetup(t);
  const outcome = await claimEscrow(hive.conn, quote, options);
  assert.deepEqual(outcome, {
    kind: "paid",
    txid: outcome.kind === "paid" ? outcome.txid : "",
    amountSats: Number(owed),
  });
  assert.equal(hive.fake.balance(wallet.account.pkScript), Number(owed));
  assert.equal(hive.fake.balance(hive.account.pkScript), 50_000 - Number(owed));
  assert.deepEqual(
    await claimEscrow(hive.conn, quote, options),
    outcome,
    "a resumed claim reads its journal",
  );
  assert.equal(handed.length, 0, "the desk was never needed");
  const journal = JSON.parse(readFileSync(resolve(options.stateDirectory, "claim.json"), "utf8")) as {
    submissions: { route: string; result: string }[];
  };
  assert.deepEqual(
    journal.submissions.map((s) => `${s.route}:${s.result}`),
    ["self:accepted"],
  );

  // The workload key signs one amount per escrow: a later, larger receipt is refused.
  const larger = signReceipt({ escrowId: quote.quoteId, amountSats: String(owed + 1000n) }, secrets.payer);
  assert.equal(
    await code(signClaim(configPath, { kind: "sign-escrow-claim", quote, receipt: larger })),
    "CLAIM_ALREADY_SIGNED",
  );
  // And never for a quote its administrator did not approve.
  const other = await hive.quote();
  const foreign = signReceipt({ escrowId: other.quote.quoteId, amountSats: "100" }, other.secrets.payer);
  assert.equal(
    await code(signClaim(configPath, { kind: "sign-escrow-claim", quote: other.quote, receipt: foreign })),
    "UNAPPROVED_REQUEST",
  );
});

test("when the provider cannot reach the Emulator, the hive's desk registers its claim through a pair", async (t) => {
  const { hive, wallet, quote, owed, handed, options } = await claimSetup(t);
  hive.fake.emulatorUnavailable = true;
  const outcome = await claimEscrow(hive.conn, quote, options);
  assert.equal(outcome.kind, "paid");
  assert.equal(hive.fake.balance(wallet.account.pkScript), Number(owed));
  assert.equal(handed.length, 1);
  const journal = JSON.parse(readFileSync(resolve(options.stateDirectory, "claim.json"), "utf8")) as {
    submissions: { route: string; result?: string; spendId?: string }[];
  };
  assert.equal(journal.submissions[0]?.result, "unavailable");
  assert.ok(journal.submissions.some((s) => s.route === "desk" && s.spendId));
});

test("a cash-out funds the quoted lockup with one wallet send and settles on the revealed preimage", async (t) => {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 86_400 });
  t.after(() => fake.close());
  const { connect } = await import("@hive/ark");
  const conn = await connect(fake.deployment());
  const { ownerSecret, wallet, directory } = await payoutWallet(t, conn);
  fake.mint(wallet.account.pkScript, 3_000);
  const stub = startSwapStub(fake);
  const invoice = stub.invoice(2_000);
  const journalPath = resolve(directory, "cashout.json");
  const run = () =>
    cashOut(conn, {
      journalPath,
      invoice,
      wallet,
      ownerSecret,
      rail: stub.rail,
      settleTimeoutMs: 500,
      pollMs: 50,
    });
  const funded = await run();
  assert.equal(funded.status, "funded", "nothing claims the lockup until the solver pays");
  assert.equal(funded.lockup.fundAmount, 2_007);
  assert.equal(fake.balance(funded.lockup.script), 2_007);
  assert.equal(fake.balance(wallet.account.pkScript), 993, "change returns to the payout wallet");
  assert.equal(
    funded.lockup.contract.params.sender !== undefined,
    true,
    "the lockup's refund terms are kept",
  );

  assert.equal(stub.settle(), 1);
  const settled = await run();
  assert.equal(settled.status, "settled");
  assert.equal(paymentHashOf(settled.settlement!.preimage), settled.invoice.paymentHash);
  assert.equal(stub.quotes.length, 1, "a resumed cash-out asks for no second quote");
  assert.deepEqual(await run(), settled);
});

test("a cash-out refuses a high fee and lets a lapsing quote go unsigned", async (t) => {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 86_400 });
  t.after(() => fake.close());
  const { connect } = await import("@hive/ark");
  const conn = await connect(fake.deployment());
  const { ownerSecret, wallet, directory } = await payoutWallet(t, conn);
  fake.mint(wallet.account.pkScript, 5_000);
  const costly = startSwapStub(fake, { feeSats: 500 });
  const ask = (rail: typeof costly.rail, invoice: string, label: string) =>
    cashOut(conn, { journalPath: resolve(directory, `${label}.json`), invoice, wallet, ownerSecret, rail });
  assert.equal(await code(ask(costly.rail, costly.invoice(2_000), "fee")), "CASHOUT_FEE");

  const hurried = startSwapStub(fake, { validSeconds: 20 });
  const expired = await ask(hurried.rail, hurried.invoice(2_000), "hurried");
  assert.equal(expired.status, "expired");
  assert.equal(fake.balance(wallet.account.pkScript), 5_000, "nothing was sent");
  const archived = await retireExpiredCashout(resolve(directory, "hurried.json"));
  assert.match(archived, /hurried\.json\.expired-/);
});

test("a wallet send pays exactly once, and an empty wallet sends nothing", async (t) => {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 86_400 });
  t.after(() => fake.close());
  const { connect } = await import("@hive/ark");
  const conn = await connect(fake.deployment());
  const { ownerSecret, wallet, directory } = await payoutWallet(t, conn);
  fake.mint(wallet.account.pkScript, 1_500);
  fake.mint(wallet.account.pkScript, 2_500);
  const destination = `5120${hex(randomBytes(32))}`;
  const args = {
    journalPath: resolve(directory, "sweep.json"),
    destination,
    amount: "all" as const,
    validUntil: Math.floor(Date.now() / 1000) + 300,
    purpose: { kind: "sweep" },
    pollMs: 50,
  };
  const sent = await walletSend(wallet, ownerSecret, args);
  assert.equal(sent.status, "done");
  assert.equal(fake.balance(destination), 4_000);
  assert.deepEqual(await walletSend(wallet, ownerSecret, args), sent, "a resumed send posts nothing new");
  assert.deepEqual(await walletBalance(wallet), { spendableSats: 0, renewingSats: 0, coins: 0 });
  assert.equal(
    await code(walletSend(wallet, ownerSecret, { ...args, journalPath: resolve(directory, "again.json") })),
    "INSUFFICIENT_FUNDS",
  );
  assert.equal(
    await code(walletSend(wallet, ownerSecret, { ...args, purpose: { kind: "other" } })),
    "JOURNAL_MISMATCH",
  );
  // A coin waiting for its renewal is left out of every plan, and the refusal says why.
  fake.mint(wallet.account.pkScript, 3_000, { expiresInSeconds: 60 });
  for (const amount of ["all", 2_000] as const)
    assert.equal(
      await code(
        walletSend(wallet, ownerSecret, {
          ...args,
          amount,
          journalPath: resolve(directory, `renewing-${amount}.json`),
        }),
      ),
      "COINS_RENEWING",
    );
  assert.deepEqual(await walletBalance(wallet), { spendableSats: 0, renewingSats: 3_000, coins: 1 });
});

test("a wallet executes through the Emulator and hands unavailable service responses to the delegatee", async (t) => {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 86_400 });
  t.after(() => fake.close());
  const { connect } = await import("@hive/ark");
  const conn = await connect(fake.deployment());
  const { ownerSecret, wallet, directory } = await payoutWallet(t, conn);
  const send = (name: string, timeoutMs = 20_000) =>
    walletSend(wallet, ownerSecret, {
      journalPath: resolve(directory, `${name}.json`),
      destination: `5120${hex(randomBytes(32))}`,
      amount: 1_000,
      validUntil: Math.floor(Date.now() / 1000) + 300,
      purpose: { kind: name },
      pollMs: 20,
      timeoutMs,
    });

  // Ourselves first: the Emulator finalizes the transaction the journal named before anything was posted.
  fake.mint(wallet.account.pkScript, 3_000);
  const own = await send("own");
  assert.equal(own.status, "done");
  assert.deepEqual(
    own.attempts?.map((a) => `${a.route}:${a.result}`),
    ["self:accepted"],
  );
  assert.equal(own.txid, own.arkTxid);
  assert.deepEqual(fake.emulatorSubmissions.at(-1), { txid: own.arkTxid, accepted: true });

  // An Emulator out of reach: the delegatee builds the very same transaction from the request.
  fake.emulatorUnavailable = true;
  fake.mint(wallet.account.pkScript, 3_000);
  const journal = send("handed-over");
  await new Promise((r) => setTimeout(r, 200));
  fake.tick();
  const handed = await journal;
  assert.equal(handed.status, "done");
  assert.deepEqual(
    handed.attempts?.map((a) => `${a.route}:${a.result}`),
    ["self:unavailable", "delegatee:accepted"],
  );
  assert.equal(handed.txid, handed.arkTxid, "both routes build one transaction");
  assert.ok(handed.spendId);
  fake.emulatorUnavailable = false;

  // An opaque HTTP 500 cannot establish a covenant verdict, so the next service may try.
  fake.refuseSpends = "internal error";
  fake.mint(wallet.account.pkScript, 3_000);
  assert.equal(await code(send("opaque-error", 300)), "SEND_PENDING");
  const pending = JSON.parse(
    (await import("node:fs")).readFileSync(resolve(directory, "opaque-error.json"), "utf8"),
  ) as { attempts: { route: string; result: string }[]; spendId?: string };
  assert.deepEqual(
    pending.attempts.map((attempt) => [attempt.route, attempt.result]),
    [
      ["self", "unavailable"],
      ["delegatee", "accepted"],
    ],
  );
  assert.ok(pending.spendId);
});

test("a claim with hidden payout stays pending, then reconciles the exact claim without using the desk", async (t) => {
  const { hive, wallet, quote, owed, handed, options } = await claimSetup(t);
  const coins = hive.conn.arkd.coins.bind(hive.conn.arkd);
  let hide = true;
  hive.conn.arkd.coins = async (query) => {
    const found = await coins(query);
    return hide ? found.filter((coin) => coin.script !== wallet.account.pkScript) : found;
  };
  await assert.rejects(
    claimEscrow(hive.conn, quote, { ...options, selfMs: 1000, waitMs: 20 }),
    (error: unknown) => faultCode(error) === "CLAIM_PENDING",
  );
  const path = resolve(options.stateDirectory, "claim.json");
  assert.equal(readJson<ClaimJournal>(path).status, "signed");
  assert.equal(readJson<ClaimJournal>(path).txid, undefined);
  const fixed = readJson<ClaimJournal>(path).claimAction!;
  const input = fixed.spend!.inputs[0]!;
  assert.equal(hive.fake.coins.get(input.txid + ":" + input.vout)?.isSpent, true);
  assert.ok(
    hive.fake.emulatorSubmissions.some((submission) => submission.txid === fixed.txid && submission.accepted),
  );
  assert.equal(handed.length, 0);
  hide = false;
  const paid = await claimEscrow(hive.conn, quote, options);
  assert.equal(paid.kind, "paid");
  assert.equal(paid.kind === "paid" && paid.amountSats, Number(owed));
  assert.equal(readJson<ClaimJournal>(path).txid, readJson<ClaimJournal>(path).claimAction?.txid);
  assert.equal(handed.length, 0);
});

test("an old inferred refund is reconciled against the actual claim output", async (t) => {
  const { hive, quote, options } = await claimSetup(t);
  const paid = await claimEscrow(hive.conn, quote, options);
  assert.equal(paid.kind, "paid");
  const path = resolve(options.stateDirectory, "claim.json");
  const old = readJson<ClaimJournal>(path);
  delete old.claimAction;
  delete old.refundAction;
  old.status = "refunded";
  delete old.paidSats;
  writeJson(path, old);
  assert.deepEqual(await claimEscrow(hive.conn, quote, options), paid);
  assert.equal(readJson<ClaimJournal>(path).status, "paid");
});

test("the hive view never labels a visible claim remainder as a refund", async (t) => {
  const { hive, wallet, quote, options, directory } = await claimSetup(t);
  const terms = escrowTermsFromQuote(quote);
  const escrow = await hive.escrow(terms);
  writeJson(resolve(directory, "purchase.json"), {
    schema: "hive-purchase/v4",
    quote,
    escrow: {
      terms,
      address: escrow.address,
      pkScript: escrow.pkScript,
      artifactId: escrow.artifactId,
      refundWatch: escrow.watch.delegationId,
    },
    createdAt: new Date().toISOString(),
  });
  await claimEscrow(hive.conn, quote, options);
  const coins = hive.conn.arkd.coins.bind(hive.conn.arkd);
  let hide = true;
  hive.conn.arkd.coins = async (query) => {
    const found = await coins(query);
    return hide ? found.filter((coin) => coin.script !== wallet.account.pkScript) : found;
  };
  const view = () =>
    buildHiveView(hive.conn, {
      treasuryAddress: hive.account.address,
      treasuryScript: hive.account.pkScript,
      journalRoots: [directory],
      renewalMaxFeeSats: 500,
    });
  const partial = await view();
  assert.equal(partial.escrows[0]?.status, "closed");
  assert.equal(partial.escrows[0]?.close, null);
  assert.equal(partial.totals.refundedSats, 0);
  hide = false;
  assert.equal((await view()).escrows[0]?.status, "claimed");
});

test("a refund needs its full treasury output before the claim daemon reports it", async (t) => {
  const { hive, quote, options } = await claimSetup(t);
  hive.fake.emulatorUnavailable = true;
  await assert.rejects(
    claimEscrow(hive.conn, quote, {
      ...options,
      selfMs: 20,
      waitMs: 50,
      desk: {
        async submit() {
          throw new Error("desk temporarily unavailable");
        },
      },
    }),
    (error: unknown) => faultCode(error) === "CLAIM_PENDING",
  );
  const path = resolve(options.stateDirectory, "claim.json");
  const escrowScript = readJson<ClaimJournal>(path).escrowScript;
  t.mock.timers.enable({ apis: ["Date"], now: Number(quote.body.timeoutAt) * 1000 + 1_000 });
  hive.fake.tick();
  const coins = hive.conn.arkd.coins.bind(hive.conn.arkd);
  const source = (await coins({ scripts: [escrowScript] })).find((coin) => coin.isSpent)!;
  assert.ok(source.arkTxid);
  let hide = true;
  hive.conn.arkd.coins = async (query) => {
    const found = await coins(query);
    return hide ? found.filter((coin) => coin.txid !== source.arkTxid) : found;
  };
  await assert.rejects(
    claimEscrow(hive.conn, quote, { ...options, selfMs: 20, waitMs: 20 }),
    (error: unknown) => faultCode(error) === "CLAIM_PENDING",
  );
  assert.equal(readJson<ClaimJournal>(path).status, "signed");
  hide = false;
  assert.deepEqual(await claimEscrow(hive.conn, quote, options), { kind: "refunded", txid: source.arkTxid });
});

test("cash-out resumes funding observed after quote expiry without submitting or quoting again", async (t) => {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 86_400 });
  t.after(() => fake.close());
  const { connect } = await import("@hive/ark");
  const conn = await connect(fake.deployment());
  const { ownerSecret, wallet, directory } = await payoutWallet(t, conn);
  fake.mint(wallet.account.pkScript, 3_000);
  const stub = startSwapStub(fake);
  const invoice = stub.invoice(2_000);
  const journalPath = resolve(directory, "resumed-cashout.json");
  const run = () =>
    cashOut(conn, {
      journalPath,
      invoice,
      wallet,
      ownerSecret,
      rail: stub.rail,
      settleTimeoutMs: 20,
      pollMs: 5,
    });
  const funded = await run();
  assert.equal(funded.status, "funded");
  const fundingPath = `${journalPath}.funding.json`;
  const send = readJson<WalletSendJournal>(fundingPath);
  // The transaction landed before a crash, but its final observation and the cash-out update did not.
  send.status = "registered";
  delete send.txid;
  writeJson(fundingPath, send);
  const quoted = readJson<CashoutJournal>(journalPath);
  quoted.status = "quoted";
  delete quoted.funding;
  writeJson(journalPath, quoted);
  const submissions = fake.emulatorSubmissions.length;
  const realNow = Date.now;
  const offset = quoted.quote.valid_until * 1000 + 1_000 - realNow();
  t.mock.method(Date, "now", () => realNow() + offset);
  const resumed = await run();
  assert.equal(resumed.status, "funded");
  assert.equal(resumed.funding?.txid, send.arkTxid);
  assert.equal(fake.emulatorSubmissions.length, submissions);
  assert.equal(stub.quotes.length, 1);
  assert.equal(stub.settle(), 1);
  assert.equal((await run()).status, "settled");
});

test("unknown escrow expiry prevents a new provider claim submission", async (t) => {
  const { hive, quote, handed, options } = await claimSetup(t);
  const terms = escrowTermsFromQuote(quote);
  const escrow = await hive.escrow(terms);
  const coins = hive.conn.arkd.coins.bind(hive.conn.arkd);
  hive.conn.arkd.coins = async (query) =>
    (await coins(query)).map((coin) => (coin.script === escrow.pkScript ? { ...coin, expiresAt: 0 } : coin));
  const posts = hive.fake.emulatorSubmissions.length;
  await assert.rejects(
    claimEscrow(hive.conn, quote, options),
    (error: unknown) => faultCode(error) === "COIN_EXPIRY_UNKNOWN",
  );
  assert.equal(hive.fake.emulatorSubmissions.length, posts);
  assert.equal(handed.length, 0);
  assert.deepEqual(readJson<ClaimJournal>(resolve(options.stateDirectory, "claim.json")).submissions, []);
});

test("an observed historical refund reconciles without batch expiry metadata", async (t) => {
  const { hive, quote, options, directory } = await claimSetup(t);
  hive.fake.emulatorUnavailable = true;
  await assert.rejects(
    claimEscrow(hive.conn, quote, {
      ...options,
      selfMs: 20,
      waitMs: 50,
      desk: {
        async submit() {
          throw new Error("desk temporarily unavailable");
        },
      },
    }),
    (error: unknown) => faultCode(error) === "CLAIM_PENDING",
  );
  const path = resolve(options.stateDirectory, "claim.json");
  const old = readJson<ClaimJournal>(path);
  const terms = escrowTermsFromQuote(quote);
  const escrow = await hive.escrow(terms);
  t.mock.timers.enable({ apis: ["Date"], now: Number(quote.body.timeoutAt) * 1000 + 1_000 });
  hive.fake.tick();
  const coins = hive.conn.arkd.coins.bind(hive.conn.arkd);
  const source = (await coins({ scripts: [escrow.pkScript] })).find((coin) => coin.isSpent)!;
  assert.ok(source.arkTxid);
  hive.conn.arkd.coins = async (query) =>
    (await coins(query)).map((coin) =>
      coin.script === escrow.pkScript && coin.isSpent ? { ...coin, expiresAt: null } : coin,
    );
  // Legacy journals had no fixed Actions and may have inferred the wrong close.
  delete old.claimAction;
  delete old.refundAction;
  old.status = "paid";
  writeJson(path, old);
  assert.deepEqual(await claimEscrow(hive.conn, quote, options), {
    kind: "refunded",
    txid: source.arkTxid,
  });
  writeJson(resolve(directory, "purchase.json"), {
    schema: "hive-purchase/v4",
    quote,
    escrow: {
      terms,
      address: escrow.address,
      pkScript: escrow.pkScript,
      artifactId: escrow.artifactId,
      refundWatch: escrow.watch.delegationId,
    },
    createdAt: new Date().toISOString(),
  });
  const view = await buildHiveView(hive.conn, {
    treasuryAddress: hive.account.address,
    treasuryScript: hive.account.pkScript,
    journalRoots: [directory],
    renewalMaxFeeSats: 500,
  });
  assert.equal(view.escrows[0]?.status, "refunded");
  assert.equal(view.escrows[0]?.close?.txid, source.arkTxid);
  assert.equal(view.totals.refundedSats, Number(quote.body.capSats));
});

test("a desk covenant refusal pins the provider claim across resume", async (t) => {
  const { hive, quote, options } = await claimSetup(t);
  let selfCalls = 0;
  let deskCalls = 0;
  const self: Route = {
    name: "self",
    async submit() {
      selfCalls++;
      return { result: "unavailable", detail: "SERVICE_UNAVAILABLE" };
    },
  };
  hive.conn.router = hive.conn.router.withRoutes([self], { retryMs: 5, pollMs: 1 });
  const desk: ClaimDesk = {
    async submit(claim) {
      deskCalls++;
      assert.ok(claim.expectedSpend);
      throw new CovenantRefusal({
        source: "offline-model",
        route: "delegatee",
        txid: claim.expectedSpend.txid,
        outpoints: [claim.expectedSpend.outpoint],
        reason: "covenant-failed",
      });
    },
  };
  const run = () =>
    claimEscrow(hive.conn, quote, {
      ...options,
      desk,
      pollMs: 1,
      selfMs: 100,
      waitMs: 30,
    });
  await assert.rejects(run(), (error: unknown) => faultCode(error) === "CLAIM_PENDING");
  const path = resolve(options.stateDirectory, "claim.json");
  const first = readJson<ClaimJournal>(path);
  assert.equal(selfCalls, 1, "a desk refusal never returns the claim to self");
  assert.ok(deskCalls >= 1);
  assert.ok(
    first.execution?.attempts.some(
      (attempt) => attempt.route === "desk" && attempt.response?.result === "refused",
    ),
  );
  const deskBeforeResume = deskCalls;
  await assert.rejects(run(), (error: unknown) => faultCode(error) === "CLAIM_PENDING");
  assert.equal(selfCalls, 1, "a resumed provider keeps the saved desk refusal");
  assert.ok(deskCalls > deskBeforeResume, "the same desk route can retry");
  assert.equal(readJson<ClaimJournal>(path).status, "signed");
});
