/**
 * The v4 refusals gate: what the stewards refuse, and what the covenants
 * refuse when the stewards themselves are compromised.
 *
 *   pnpm gate:refusals --offline | [--network regtest] | --network mutinynet
 *
 * Stewards refuse a quote nobody approved, a second funding of one escrow, a
 * coin already promised to another send, a withdrawal nobody approved, a
 * provider claim with someone else's signature, and any purchase while the
 * hive is halted. Then a pair is treated as compromised: its two keys sign
 * directly, skipping every policy. The escrow's covenant refuses a claim with
 * a forged receipt, and the treasury's covenant refuses a send registered
 * with other terms than the pair attested; each coin stays where it was, and
 * the escrow still pays its provider's genuine claim afterwards.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ClaimPlan,
  type CovenantSpend,
  claimMessage,
  claimSpend,
  claimVariables,
  connect,
  deriveAccount,
  escrowArguments,
  escrowClaimTemplate,
  type Pair,
  planVariables,
  receiptMessage,
  type SendPlan,
  sendMessages,
  sendSpend,
  signedSend,
  signTogether,
  spendRequestFor,
  treasuryVariables,
} from "@hive/ark";
import {
  type Action,
  buildSpend,
  type RouteName,
  restEmulator,
  type SpendRequest,
  selfRoute,
} from "@hive/executor";
import { ensure, faultCode, hex, localPath, readJson, sleep, unhex } from "@hive/kit";
import {
  nostrTransport,
  planTreasurySend,
  purchase,
  readPurchase,
  requestQuote,
  treasuryAccountOf,
  withdraw,
} from "@hive/hive";
import {
  type ComputeQuoteRequest,
  quoteCostSats,
  type SignedProviderCard,
  signReceipt,
} from "@hive/protocol";
import { approveWithdrawal } from "@hive/steward";
import { signWithPair } from "@hive/steward/client";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  addProvider,
  approvePurchase,
  buyEscrow,
  initHive,
  opsPaths,
  serveHive,
  treasuryOf,
} from "../tools/ops.js";
import { type Service, startService } from "../tools/services.js";
import { hiveSecrets } from "./lifecycle.js";
import { captureRejection, type RejectionBasis, refusalChecks } from "./support/covenant.js";
import { type GateEnv, gateEnv, renewalsSettled } from "./support/env.js";
import { startLocalRelay } from "./support/relay.js";
import { GateRun, sourceHashes } from "./support/run.js";
import { EVIDENCE_VERSION } from "./support/schema.js";

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "accepted";
  } catch (error) {
    return faultCode(error, "FAILED");
  }
};

export async function runRefusals(
  env: GateEnv,
  runId: string,
  run?: GateRun,
): Promise<Record<string, unknown>> {
  const hive = `refuse-${runId.slice(0, 8)}`;
  const paths = opsPaths(hive);
  run?.forbidFrom(() => [...hiveSecrets(hive), ...(env.secrets?.() ?? [])]);
  const ctx = { inProcessStewards: env.mode === "offline", transport: nostrTransport(20_000) };
  const relay = env.relayUrl ? undefined : await startLocalRelay();
  const log = run?.log("services.log");
  const services: Service[] = [];
  let served: Awaited<ReturnType<typeof serveHive>> | undefined;
  const results: Record<string, unknown> = {};
  try {
    const record = await initHive(
      hive,
      {
        network: env.deployment.network,
        deployment: env.deployment,
        renewalWindowSeconds: env.renewal.windowSeconds,
        renewalMaxFeeSats: env.renewal.maxFeeSats,
        ...(env.lnurl ? { lnurl: env.lnurl } : {}),
      },
      ctx,
    );
    const conn = await connect(record.deployment);
    const { card, payoutAddress } = await addProvider(
      hive,
      "provider",
      {
        model: "refusal-model",
        inputRate: "10000000000",
        outputRate: "20000000000",
        relay: env.relayUrl ?? relay!.url,
      },
      ctx,
    );
    services.push(
      await startService(
        "packages/provider/src/solver-main.ts",
        [paths.secret("providers", "provider", "solver.json")],
        log,
      ),
    );
    // Two coins, so a send the covenant refuses binds one while the other still funds escrows.
    const requests = paths.local("intake", "requests");
    const first = await env.fundTreasury(conn, record, 30_000, requests);
    const second = await env.fundTreasury(conn, record, 30_000, requests);
    await renewalsSettled(
      conn,
      { address: record.treasuryAddress, pkScript: record.treasuryScript },
      record.treasury.renewalWindowSeconds,
    );
    const treasury = await treasuryOf(record, ctx);
    const seed = readJson<{ stewards: string[] }>(paths.secret("seed.json"));
    const pairSecrets = (pair: Pair): [Uint8Array, Uint8Array] => [
      unhex(seed.stewards[Number(pair[0])]!),
      unhex(seed.stewards[Number(pair[1])]!),
    ];
    const timing = env.timing;

    // A quote no steward approved: the provider quotes it, the stewards refuse to fund it.
    await approvePurchase(
      hive,
      "approved",
      {
        provider: "provider",
        capSats: "8000",
        timeoutSeconds: timing.paidTimeoutSeconds,
        quoteLifetimeSeconds: timing.quoteLifetimeSeconds,
      },
      ctx,
    );
    const approvedRequest = readJson<ComputeQuoteRequest>(paths.local("requests", "approved.json"));
    const stranger: ComputeQuoteRequest = {
      ...approvedRequest,
      requestId: hex(randomBytes(32)),
      capSats: "9000",
    };
    const strangerQuote = await requestQuote(stranger, card as SignedProviderCard, paths.local("rfq"), ctx);
    results.unapprovedQuote = await code(
      purchase(treasury, {
        quote: strangerQuote,
        directory: paths.local("refusals", "stranger"),
        attempts: 1,
      }),
    );

    // The approved purchase funds once; the same quote funded again is refused.
    const bought = await buyEscrow(hive, "approved", { pair: "01" }, ctx);
    const quote = readPurchase(paths.local("purchases", "approved")).quote;
    results.secondFunding = await code(
      purchase(treasury, { quote, directory: paths.local("refusals", "again"), attempts: 1 }),
    );

    // A coin promised to one send is refused to another until that send ends.
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    const approvals = [1, 2].map((n) => ({
      label: `${hive}.promise-${n}`,
      destination: `5120${hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))}`,
      amountSats: 1_000,
      expiresAt: nowSeconds() + 3600,
    }));
    for (const terms of approvals)
      for (const i of [0, 2]) await approveWithdrawal(paths.secret(`steward-${i}.json`), terms);
    const plans: SendPlan[] = [];
    for (const terms of approvals)
      plans.push(
        await planTreasurySend(treasury, {
          pair: "02",
          amount: terms.amountSats,
          destination: terms.destination,
          validSeconds: 120,
        }),
      );
    const attest = (n: 0 | 1) =>
      signWithPair(
        treasury.stewards,
        treasury.stewardKeys,
        {
          id: hex(randomBytes(32)),
          pair: "02",
          purpose: { kind: "withdrawal", stage: "attest", withdrawal: approvals[n]!, plan: plans[n]! },
        },
        sendMessages(
          plans[n]!,
          treasuryAccountOf(treasury).instance,
          treasury.conn.operator.checkpointTapscript,
        ),
      );
    results.firstPromise = await code(attest(0));
    results.secondPromise = plans[1]!.coins.some((c) =>
      plans[0]!.coins.some((d) => d.txid === c.txid && d.vout === c.vout),
    )
      ? await code(attest(1))
      : "no shared coin";

    // A withdrawal nobody approved.
    results.unapprovedWithdrawal = await code(
      withdraw(treasury, {
        withdrawal: {
          label: `${hive}.unapproved`,
          destination: approvals[0]!.destination,
          amountSats: 2_000,
          expiresAt: nowSeconds() + 600,
        },
        journalPath: paths.local("refusals", "unapproved-withdrawal.json"),
        pair: "01",
      }),
    );

    // A claim the provider did not sign, at the hive's desk.
    served = await serveHive(hive, {}, ctx);
    const payer = unhex(readJson<{ payer: string }>(paths.secret("seed.json")).payer);
    const workload = unhex(
      readJson<{ workload: string }>(paths.secret("providers", "provider", "seed.json")).workload,
    );
    const amount = Number(quoteCostSats(quote.body, "100", "50"));
    const receipt = signReceipt({ escrowId: quote.quoteId, amountSats: String(amount) }, payer);
    const genuineClaim = hex(schnorr.sign(claimMessage(quote.quoteId, amount), workload));
    const forgedClaim = hex(
      schnorr.sign(claimMessage(quote.quoteId, amount), schnorr.utils.randomSecretKey()),
    );
    const desk = async (claimSignature: string) => {
      const response = await fetch(`${served!.url}/api/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote, receipt, claimSignature }),
      });
      const body = (await response.json()) as { error?: string; spendId?: string };
      return { status: response.status, ...body };
    };
    results.forgedClaimAtDesk = await desk(forgedClaim);

    // A compromised pair signs a claim with a forged receipt itself; the escrow's covenant refuses it.
    const escrowRecord = readPurchase(paths.local("purchases", "approved"));
    const forgedReceipt = hex(
      schnorr.sign(receiptMessage(quote.quoteId, bought.coin.amountSats), schnorr.utils.randomSecretKey()),
    );
    const theft: ClaimPlan = {
      escrow: escrowRecord.escrow.terms,
      coin: {
        txid: bought.coin.txid,
        vout: bought.coin.vout,
        amount: bought.coin.amountSats,
        script: escrowRecord.escrow.pkScript,
      },
      amount: bought.coin.amountSats,
      receiptSig: forgedReceipt,
      claimSig: hex(schnorr.sign(claimMessage(quote.quoteId, bought.coin.amountSats), workload)),
      templateId: await conn.delegatee.registerTemplate(
        escrowClaimTemplate(escrowRecord.escrow.artifactId, false),
      ),
      expiresAt: nowSeconds() + 61,
    };
    const theftRequest = spendRequestFor(
      theft.templateId,
      claimVariables(theft),
      [`${theft.coin.txid}:${theft.coin.vout}`],
      theft.expiresAt,
      record.treasury.pairs["12"],
    );
    const theftSigned = theftRequest.request(
      signTogether(pairSecrets("12"), record.stewardKeys, "12", theftRequest.message),
    );

    // A compromised pair attests one send and registers another; the treasury's covenant refuses it.
    const decoy = await planTreasurySend(treasury, {
      pair: "12",
      amount: 1_000,
      destination: approvals[0]!.destination,
      validSeconds: 180,
      exclude: plans.flatMap((p) => p.coins.map((c) => `${c.txid}:${c.vout}`)),
    });
    const instance = treasuryAccountOf(treasury).instance;
    const attested = sendMessages(decoy, instance, treasury.conn.operator.checkpointTapscript).map((m) =>
      signTogether(pairSecrets("12"), record.stewardKeys, "12", m),
    );
    const { outpoints } = signedSend(decoy, attested);
    const thief = `5120${hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))}`;
    const swapped = {
      ...planVariables(treasuryVariables(record.treasury), { ...decoy, destination: thief }),
      ...Object.fromEntries(attested.map((sig, i) => [`sig_${i}`, sig])),
    };
    const swap = spendRequestFor(
      decoy.templateId,
      swapped,
      outpoints,
      decoy.validUntil,
      record.treasury.pairs["12"],
    );
    const swapSigned = swap.request(signTogether(pairSecrets("12"), record.stewardKeys, "12", swap.message));
    const escrowInstance = deriveAccount(conn, "escrow", escrowArguments(escrowRecord.escrow.terms)).instance;
    const theftAction = {
      txid: "",
      spend: claimSpend(theft, escrowInstance),
      request: theftSigned,
      validUntil: theft.expiresAt,
    };
    theftAction.txid = buildSpend(theftAction.spend, conn.operator.checkpointTapscript).txid;
    const swappedAction = {
      txid: "",
      spend: sendSpend({ ...decoy, destination: thief }, instance, attested),
      request: swapSigned,
      validUntil: decoy.validUntil,
    };
    swappedAction.txid = buildSpend(swappedAction.spend, conn.operator.checkpointTapscript).txid;
    ensure(conn.deployment.emulatorUrl, "NO_SELF_ROUTE");
    const direct = selfRoute({
      emulator: restEmulator(conn.deployment.emulatorUrl),
      emulatorKey: conn.keys.emulator,
      checkpointTapscript: conn.operator.checkpointTapscript,
      serverKey: conn.keys.server,
      prevTxs: { getVirtualTxs: async (txids) => ({ txs: await conn.arkd.virtualTxs(txids) }) },
    });
    const reject = async (
      label: string,
      route: RouteName,
      action: Action & { spend: CovenantSpend; request: SpendRequest },
    ) =>
      captureRejection({
        record: {
          label,
          route,
          action,
          checkpointTapscript: conn.operator.checkpointTapscript,
          basis: (label.endsWith("Claim")
            ? { kind: "forged-claim", plan: theft, keys: conn.keys }
            : {
                kind: "swapped-send",
                plan: decoy,
                destination: thief,
                signatures: attested,
                treasury: record.treasury,
                keys: conn.keys,
              }) as RejectionBasis,
        },
        journalPath: paths.local("refusals", label + ".json"),
        mode: env.mode,
        observe: () => conn.arkd.coins({ outpoints: action.request.outpoints }),
        model: () => env.fake?.covenantRejections ?? [],
        async submit() {
          if (route === "self") return { answer: await direct.submit(action) };
          const posted = await conn.delegatee.spend(action.request);
          const deadline = Date.now() + Math.min(timing.settleSeconds * 1000, 28_000);
          for (;;) {
            const state = await conn.delegatee.spendState(posted.id);
            const attempt = state.attempts[0];
            if (attempt) return { answer: { result: "accepted" as const, reference: posted.id }, attempt };
            ensure(Date.now() < deadline, "VM_REJECTION_UNPROVEN", "no delegatee attempt");
            await sleep(100);
          }
        },
      });
    // Direct requests run before any malicious delegation can retry in their log windows.
    results.selfForgedClaim = await reject("selfForgedClaim", "self", theftAction);
    results.selfSwappedSend = await reject("selfSwappedSend", "self", swappedAction);
    results.compromisedClaim = await reject("compromisedClaim", "delegatee", theftAction);
    // A pending malicious delegation would make the next VM log window ambiguous.
    while (nowSeconds() <= theft.expiresAt + 10) await sleep(1000);
    results.compromisedSend = await reject("compromisedSend", "delegatee", swappedAction);

    // The escrow still pays its provider's genuine claim once the forged one has lapsed;
    // the delegatee lets go of a lapsed spend's coins on its next scan.
    while (nowSeconds() <= theft.expiresAt + 10) await sleep(1000);
    results.genuineClaimAfter = await desk(genuineClaim);
    const providerPayments = await (async () => {
      const until = Date.now() + timing.settleSeconds * 1000;
      while (Date.now() < until) {
        const outs = (await conn.arkd.coins({ scripts: [card.body.providerPayoutScript] })).filter(
          (c) => !c.isSpent,
        );
        if (outs.length) return outs;
        await sleep(1000);
      }
      return [];
    })();
    const paid = providerPayments.reduce((n, c) => n + c.amount, 0);
    const genuinePlan = { ...theft, amount, receiptSig: receipt.signature, claimSig: genuineClaim };
    const genuineSpend = claimSpend(genuinePlan, escrowInstance);
    results.genuineClaimExecution = {
      plan: genuinePlan,
      txid: buildSpend(genuineSpend, conn.operator.checkpointTapscript).txid,
      spend: genuineSpend,
      checkpointTapscript: conn.operator.checkpointTapscript,
      outputs: providerPayments,
    };
    results.providerPaid = paid;

    // While halted, nothing new is bought.
    const haltFile = localPath("gate-halts", runId, "HALT");
    mkdirSync(dirname(haltFile), { recursive: true });
    writeFileSync(haltFile, "refusals gate");
    process.env.BUZZ_HALT_FILE = haltFile;
    try {
      await approvePurchase(
        hive,
        "halted",
        {
          provider: "provider",
          capSats: "1000",
          timeoutSeconds: timing.paidTimeoutSeconds,
          quoteLifetimeSeconds: timing.quoteLifetimeSeconds,
        },
        ctx,
      );
      results.haltedPurchase = await code(buyEscrow(hive, "halted", {}, ctx));
    } finally {
      delete process.env.BUZZ_HALT_FILE;
      rmSync(dirname(haltFile), { recursive: true, force: true });
    }

    const checks = refusalChecks(results, env.mode === "offline" ? "offline" : "live", amount);
    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    return {
      status: failed.length ? "failed" : env.mode === "offline" ? "offline-smoke" : "passed",
      failed,
      network: env.deployment.network,
      treasury: { address: record.treasuryAddress, coins: [first, second] },
      provider: { payoutAddress },
      escrow: { quoteId: quote.quoteId, coin: bought.coin },
      results,
      expectedPaidSats: amount,
      checks,
    };
  } finally {
    await served?.close();
    for (const service of services.reverse()) await service.close();
    await relay?.close();
    log?.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runId = randomUUID();
  const offline = argv.includes("--offline");
  if (offline) process.env.BUZZ_EVIDENCE_ROOT ??= localPath("offline-evidence");
  const env = await gateEnv(argv);
  const run = GateRun.create(offline ? "refusals-offline" : `refusals-${env.deployment.network}`);
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= env.close());
  const stopInterrupts = run.handleInterrupts(
    { schema: "hive-refusals/v4", schemaVersion: EVIDENCE_VERSION, runId },
    close,
  );
  process.stdout.write(`${JSON.stringify({ gate: "refusals", runId, evidence: run.directory })}\n`);
  const sources = sourceHashes();
  try {
    const result = await runRefusals(env, runId, run);
    if (run.interrupted) return;
    run.write("refusals.json", {
      schema: "hive-refusals/v4",
      schemaVersion: EVIDENCE_VERSION,
      ...result,
      runId,
      skipped: 0,
      // Free text naming the stack, the delegatee build and who ran it.
      environment: process.env.BUZZ_GATE_ENVIRONMENT ?? null,
      startedAt: run.startedAt,
      completedAt: new Date().toISOString(),
      command: `pnpm gate:refusals ${argv.join(" ")}`.trim(),
      sourceSha256: sources,
    });
    process.stdout.write(`${JSON.stringify({ status: result.status, failed: result.failed })}\n`);
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    if (run.interrupted) return;
    run.write("failure.json", {
      schema: "hive-refusals/v4",
      schemaVersion: EVIDENCE_VERSION,
      status: "stopped",
      runId,
      code: faultCode(error, "FAILED"),
      detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      at: new Date().toISOString(),
    });
    process.stderr.write(`Refusals gate stopped: ${faultCode(error, String(error))}.\n`);
    process.exitCode = 1;
  } finally {
    stopInterrupts();
    await close();
  }
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
