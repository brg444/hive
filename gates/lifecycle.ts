/**
 * The v4 lifecycle gate: one hive from creation to every way value leaves it.
 *
 *   pnpm gate:lifecycle --offline              the in-memory network
 *   pnpm gate:lifecycle [--network regtest]    a local stack and delegatee
 *   pnpm gate:lifecycle --network mutinynet    Ark Labs' Mutinynet (approval required)
 *
 * The treasury is funded; a steward pair funds two escrows, each after its
 * refund watch is registered; two metered completions run through the payer's
 * agent and the provider's sidecar, which restart and replay them without a
 * second charge; the provider executes its fixed claim through the Emulator,
 * with the hive's claim desk and a steward pair as the delegatee fallback.
 * The delegatee's watch refunds the unused escrow after its deadline. The
 * provider cashes out over Lightning where a solver runs; a pair withdraws
 * through the delegatee to exercise that route; and the provider sweeps its
 * wallet back to the treasury. Completion requires the expected transaction's
 * input relationships and payment outputs.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Connection, connect, type IndexedCoin, type WalletSendJournal } from "@hive/ark";
import {
  ensure,
  faultCode,
  localPath,
  readJson,
  readJsonIfPresent,
  readPrivateJson,
  sha256Hex,
  sleep,
  writeOnce,
} from "@hive/kit";
import { fundingJournals, readPurchase, type SpendJournal } from "@hive/hive";
import { quoteCostSats, requireValidReceipt } from "@hive/protocol";
import type { ClaimJournal, MeterTotals } from "@hive/provider";
import {
  addProvider,
  approvePurchase,
  buyEscrow,
  cashoutProvider,
  escrowServices,
  initHive,
  loadHive,
  opsPaths,
  hiveView,
  serveHive,
  withdrawPayout,
  withdrawTreasury,
} from "../tools/ops.js";
import { type Service, startService } from "../tools/services.js";
import { type GateEnv, gateEnv, renewalsSettled } from "./support/env.js";
import { startLocalRelay } from "./support/relay.js";
import { GateRun, sourceHashes } from "./support/run.js";
import { EVIDENCE_VERSION } from "./support/schema.js";

const RATES = { input: "30000000000", output: "60000000000" };
const CAPS = { paid: 30_000, unpaid: 10_000, treasury: 60_000, cashout: 1_000, withdrawal: 5_000 };

export interface Inference {
  key: string;
  body: string;
}

export interface InferenceResult {
  sha256: string;
  bodyBase64: string;
  contentType: string | null;
  amountSats: string | null;
  requestId: string | null;
}

/** Every secret this run's hive holds, so evidence never carries one. */
export function hiveSecrets(hive: string): string[] {
  const paths = opsPaths(hive);
  const secrets: string[] = [];
  const seed = readJsonIfPresent<{ stewards: string[]; payer: string }>(paths.secret("seed.json"));
  if (seed) secrets.push(...seed.stewards, seed.payer);
  const providers = paths.secret("providers");
  for (const name of safeList(providers)) {
    const provider = readJsonIfPresent<{ rfq: string; workload: string; payout: string }>(
      resolve(providers, name, "seed.json"),
    );
    if (provider) secrets.push(provider.rfq, provider.workload, provider.payout);
    for (const file of safeList(resolve(providers, name)).filter((f) => f.startsWith("bearer-")))
      secrets.push(readPrivateJson<{ token: string }>(resolve(providers, name, file)).token);
  }
  // Per-request transport keys: the hive's RFQ conversations and the provider's cash-outs.
  for (const directory of [
    paths.local("rfq"),
    ...safeList(paths.local("providers")).map((p) => paths.local("providers", p, "cashouts")),
  ])
    for (const file of safeList(directory).filter((f) => f.endsWith("transport-key.json")))
      secrets.push(readJson<{ secretKey: string }>(resolve(directory, file)).secretKey);
  return secrets;
}

function safeList(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

export async function complete(agentUrl: string, inference: Inference): Promise<InferenceResult> {
  const response = await fetch(`${agentUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": inference.key },
    body: inference.body,
    signal: AbortSignal.timeout(180_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  ensure(response.status === 200, "INFERENCE_FAILED", bytes.toString("utf8").slice(0, 300));
  return {
    sha256: sha256Hex(bytes),
    bodyBase64: bytes.toString("base64"),
    contentType: response.headers.get("content-type"),
    amountSats: response.headers.get("x-buzz-receipt-amount-sats"),
    requestId: response.headers.get("x-buzz-request-id"),
  };
}

export async function latest(sidecarUrl: string, bearerToken: string): Promise<MeterTotals> {
  const response = await fetch(new URL("/latest", sidecarUrl), {
    headers: { authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  ensure(response.ok, "SIDECAR_UNAVAILABLE");
  return (await response.json()) as MeterTotals;
}

/** The provider's payout wallet owner (a public key) and its renewal settings, as its config records them. */
async function payoutOwner(hive: string) {
  const { loadPayout } = await import("@hive/provider");
  const { config, owner } = loadPayout(opsPaths(hive).secret("providers", "provider", "payout.json"));
  return { owner, wallet: config.wallet };
}

async function upstreamModel(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(10_000) });
  ensure(
    response.ok,
    "UPSTREAM_UNAVAILABLE",
    "start MeshLLM with `pnpm mesh:start`, or pass --stub-upstream",
  );
  const models = (await response.json()) as { data: { id: string }[] };
  ensure(models.data.length === 1, "UPSTREAM_MODELS", "the upstream must serve exactly one model");
  return models.data[0]!.id;
}

/**
 * The delegatee's renewals of an account's coins, from its own history, each
 * with the sats the renewal paid the Operator: the renewed coins less the
 * fresh batch outputs at the same script.
 */
async function renewalsOf(conn: Connection, account: { address: string; pkScript: string }) {
  const watch = await conn.delegatee.address(account.address);
  const coins = await conn.arkd.coins({ scripts: [account.pkScript] });
  const amount = new Map(coins.map((c) => [`${c.txid}:${c.vout}`, c.amount]));
  const done = watch.attempts.filter((a) => a.success);
  return [...new Set(done.map((a) => a.txid))].map((commitmentTxid) => {
    const renewed = [...new Set(done.filter((a) => a.txid === commitmentTxid).flatMap((a) => a.outpoints))];
    const fresh = coins.filter(
      (c) => !c.isPreconfirmed && c.commitmentTxids.length === 1 && c.commitmentTxids[0] === commitmentTxid,
    );
    const inSats = renewed.reduce((n, o) => n + (amount.get(o) ?? Number.NaN), 0);
    const outSats = fresh.reduce((n, c) => n + c.amount, 0);
    return {
      script: account.pkScript,
      commitmentTxid,
      renewed: renewed.map((outpoint) => ({ outpoint, amountSats: amount.get(outpoint) ?? null })),
      outputs: fresh.map((c) => ({ outpoint: `${c.txid}:${c.vout}`, amountSats: c.amount })),
      feeSats: inSats - outSats,
    };
  });
}

const balance = async (conn: Connection, script: string) =>
  (await conn.arkd.coins({ scripts: [script], spendableOnly: true }))
    .filter((c) => c.script === script && !c.isSpent)
    .reduce((n, c) => n + c.amount, 0);

async function until<T>(what: string, seconds: number, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    ensure(Date.now() < deadline, "TIMED_OUT", what);
    await sleep(1000);
  }
}

export async function runLifecycle(
  env: GateEnv,
  runId: string,
  options: { upstream: string },
  run?: GateRun,
): Promise<Record<string, unknown>> {
  const hive = `gate-${runId.slice(0, 8)}`;
  const paths = opsPaths(hive);
  const local = (...parts: string[]) => paths.local("gate", ...parts);
  run?.forbidFrom(() => [...hiveSecrets(hive), ...(env.secrets?.() ?? [])]);
  const ctx = { inProcessStewards: env.mode === "offline" };
  // Saved configuration names the relay and the claim desk, so a resumed run listens where the first one did.
  const port = (name: string) => readJsonIfPresent<{ port: number }>(local(`${name}.json`))?.port;
  const keepPort = (name: string, url: string) => {
    if (port(name) === undefined) writeOnce(local(`${name}.json`), { port: Number(new URL(url).port) });
  };
  const relay = env.relayUrl ? undefined : await startLocalRelay(port("relay") ?? 0);
  if (relay) keepPort("relay", relay.url);
  const log = run?.log("services.log");
  const services: Service[] = [];
  let escrow: Awaited<ReturnType<typeof escrowServices>> | undefined;
  let served: Awaited<ReturnType<typeof serveHive>> | undefined;
  try {
    const record = await initHive(
      hive,
      {
        network: env.deployment.network,
        deployment: env.deployment,
        perRequestMaxSats: "15000",
        renewalWindowSeconds: env.renewal.windowSeconds,
        renewalMaxFeeSats: env.renewal.maxFeeSats,
        ...(env.lnurl ? { lnurl: env.lnurl } : {}),
      },
      ctx,
    );
    const conn = await connect(record.deployment);
    const treasuryAccount = { address: record.treasuryAddress, pkScript: record.treasuryScript };
    const model = await upstreamModel(options.upstream);
    const { card, payoutAddress } = await addProvider(
      hive,
      "provider",
      {
        model,
        inputRate: RATES.input,
        outputRate: RATES.output,
        relay: env.relayUrl ?? relay!.url,
        maxCapSats: String(CAPS.paid),
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

    // The treasury's starting coins.
    const funding =
      readJsonIfPresent<IndexedCoin>(local("treasury-funding.json")) ??
      writeOnce(
        local("treasury-funding.json"),
        await env.fundTreasury(conn, record, CAPS.treasury, paths.local("intake", "requests")),
      );

    // Plans leave out coins waiting for their renewal; the steps below start once none does.
    await renewalsSettled(conn, treasuryAccount, record.treasury.renewalWindowSeconds);

    // Two escrows, each funded by a different pair after its refund watch exists.
    const timing = env.timing;
    for (const [label, cap, timeout] of [
      ["paid", CAPS.paid, timing.paidTimeoutSeconds],
      ["unpaid", CAPS.unpaid, timing.unpaidTimeoutSeconds],
    ] as const)
      await approvePurchase(
        hive,
        label,
        {
          provider: "provider",
          capSats: String(cap),
          timeoutSeconds: timeout,
          quoteLifetimeSeconds: timing.quoteLifetimeSeconds,
        },
        ctx,
      );
    const paid = await buyEscrow(hive, "paid", { pair: "01" }, ctx);
    const unpaid = await buyEscrow(hive, "unpaid", { pair: "02" }, ctx);
    const paidQuote = readPurchase(paths.local("purchases", "paid")).quote;
    const unpaidPurchase = readPurchase(paths.local("purchases", "unpaid"));

    served = await serveHive(hive, { port: port("desk") ?? 0 }, ctx);
    keepPort("desk", served.url);
    escrow = await escrowServices(hive, "paid", {
      upstream: options.upstream,
      desk: `${served.url}/api/claim`,
      limits: {
        maxRequestBytes: 65_536,
        maxResponseBytes: 2 * 1024 * 1024,
        maxOutputTokens: 64,
        requestTimeoutMs: 120_000,
        deadlineGuardSeconds: Math.min(120, Math.floor(timing.paidTimeoutSeconds / 4)),
      },
      ...(log ? { log } : {}),
    });
    run?.forbid(escrow.bearerToken);

    // Two completions, then both services restart and the same calls replay at no charge.
    const inferences: Inference[] = [false, true].map((stream, i) =>
      writeOnce(local(`inference-${i}.request.json`), {
        key: `hive-lifecycle-${runId}-${i}`,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: hello hive. /no_think" }],
          max_completion_tokens: 32,
          temperature: 0,
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
        }),
      }),
    );
    let replay = readJsonIfPresent<{ latest: MeterTotals }>(local("inference-replay.json"));
    if (!replay && !readJsonIfPresent(resolve(escrow.claimDirectory, "close-decision.json"))) {
      await escrow.startPair();
      const responses: InferenceResult[] = [];
      for (const [i, inference] of inferences.entries())
        responses.push(
          readJsonIfPresent<InferenceResult>(local(`inference-${i}.response.json`)) ??
            writeOnce(local(`inference-${i}.response.json`), await complete(escrow.agentUrl, inference)),
        );
      const before = await latest(escrow.sidecarUrl, escrow.bearerToken);
      ensure(before.sequence === "2", "RECEIPTS_MISSING", before.sequence);
      const receipt = requireValidReceipt(before.latestReceipt, {
        escrowId: paidQuote.quoteId,
        payerReceiptKey: paidQuote.body.payerReceiptKey,
        capSats: paidQuote.body.capSats,
      });
      ensure(
        receipt.amountSats ===
          quoteCostSats(
            paidQuote.body,
            before.cumulativeInputTokens,
            before.cumulativeOutputTokens,
          ).toString(),
        "RECEIPT_TOTALS_MISMATCH",
      );
      await escrow.stopPair();
      await escrow.startPair();
      for (const [i, inference] of inferences.entries())
        ensure(
          JSON.stringify(await complete(escrow.agentUrl, inference)) === JSON.stringify(responses[i]),
          "REPLAY_CHANGED",
          String(i),
        );
      ensure(
        JSON.stringify(await latest(escrow.sidecarUrl, escrow.bearerToken)) === JSON.stringify(before),
        "REPLAY_CHARGED",
      );
      replay = writeOnce(local("inference-replay.json"), {
        usageChanged: false,
        receiptsChanged: false,
        latest: before,
      });
    }
    await escrow.stopPair();
    await escrow.startPair(); // The claim daemon freezes the sidecar first.

    // The workload worker signs the provider's claim; the daemon executes it with the desk as fallback.
    await escrow.startClaimDaemon();
    const claim = await until(
      "the provider's claim to be paid",
      timing.paidTimeoutSeconds + timing.settleSeconds,
      async () => {
        const journal = readJsonIfPresent<ClaimJournal>(resolve(escrow!.claimDirectory, "claim.json"));
        return journal?.status === "paid" ? journal : undefined;
      },
    );
    await escrow.close();
    const claimedSats = claim.paidSats!;
    // The daemon claims exactly the receipt it froze the sidecar on.
    const decision = readJsonIfPresent<{ receipt: { amountSats: string } | null }>(
      resolve(escrow.claimDirectory, "close-decision.json"),
    );
    ensure(claimedSats === Number(decision?.receipt?.amountSats), "CLAIM_AMOUNT");

    // The unused escrow: nobody claims it; it returns to the treasury once the deadline has passed.
    await env.advanceTo(Number(unpaidPurchase.quote.body.timeoutAt));
    // Nobody signs: the coordinator executes it, or the escrow's watch does, whichever lands first.
    const refunded = await until("the escrow's refund", timing.settleSeconds, async () => {
      const [coin] = await conn.arkd.coins({ outpoints: [`${unpaid.coin.txid}:${unpaid.coin.vout}`] });
      if (!coin?.isSpent || !coin.arkTxid) return undefined;
      const outputs = (await conn.arkd.coins({ scripts: [record.treasuryScript] })).filter(
        (c) => c.txid === coin.arkTxid,
      );
      return outputs.length
        ? { txid: coin.arkTxid, treasurySats: outputs.reduce((n, c) => n + c.amount, 0) }
        : undefined;
    });
    ensure(refunded.treasurySats === CAPS.unpaid, "REFUND_AMOUNT");
    const ran = readJsonIfPresent<{ route?: string; spendId?: string }>(
      paths.local("refunds", "unpaid.json"),
    );
    const refund = {
      ...refunded,
      executedBy: ran?.route === "self" ? "coordinator" : ran?.spendId ? "pair" : "watch",
    };

    // The provider cashes out over Lightning where a solver runs.
    let cashout: Record<string, unknown> | null = null;
    if (env.cashout) {
      const invoice =
        readJsonIfPresent<{ invoice: string }>(local("cashout-invoice.json"))?.invoice ??
        writeOnce(local("cashout-invoice.json"), { invoice: await env.cashout.invoice(CAPS.cashout) })
          .invoice;
      const rail = env.cashout.rail(conn);
      const ops = { rail };
      const quick = { settleTimeoutMs: 5_000, pollMs: 500 };
      let journal = await cashoutProvider(hive, "provider", invoice, ops, quick);
      // Offline, the stand-in solver pays and claims when told; a real solver does both by itself.
      if (journal.status === "funded" && env.cashout.settle) env.cashout.settle();
      journal = await until("the cash-out to settle", timing.settleSeconds, async () => {
        const next = await cashoutProvider(hive, "provider", invoice, ops, quick);
        return next.status === "settled" ? next : undefined;
      });
      const fundingJournal = readJson<WalletSendJournal>(journal.funding!.journalPath);
      const [settlementTransaction] = await conn.arkd.virtualTxs([journal.settlement!.claimTxid]);
      ensure(settlementTransaction, "CASHOUT_CLAIM_UNKNOWN");
      cashout = {
        invoiceSats: journal.invoice.amountSats,
        paymentHash: journal.invoice.paymentHash,
        fundAmount: journal.lockup.fundAmount,
        funding: {
          txid: journal.funding!.txid,
          outpoint: journal.funding!.outpoint,
          journal: {
            status: fundingJournal.status,
            txid: fundingJournal.txid,
            arkTxid: fundingJournal.arkTxid,
            plan: fundingJournal.plan,
            request: fundingJournal.request,
            attempts: fundingJournal.attempts,
          },
        },
        lockup: { script: journal.lockup.script, refundLocktime: journal.lockup.refundLocktime },
        settlement: { ...journal.settlement, transaction: settlementTransaction },
      };
    }

    // A pair withdraws to the provider's wallet; the provider sweeps its wallet back to the treasury.
    await renewalsSettled(conn, treasuryAccount, record.treasury.renewalWindowSeconds);
    const withdrawal = await withdrawTreasury(
      hive,
      "to-provider",
      // Exercise the delegatee route here; reconstruction and spend vectors verify transaction equality.
      { to: payoutAddress, amount: String(CAPS.withdrawal), pair: "12", routes: ["delegatee"] },
      ctx,
    );
    ensure(withdrawal.complete, "WITHDRAWAL_INCOMPLETE");
    const payoutTerms = (await payoutOwner(hive)).wallet;
    await renewalsSettled(
      conn,
      { address: payoutAddress, pkScript: card.body.providerPayoutScript },
      payoutTerms.renewalWindowSeconds,
    );
    const sweep = await withdrawPayout(
      hive,
      "provider",
      "sweep",
      { to: record.treasuryAddress, amount: "all" },
      ctx,
    );
    ensure(sweep.complete, "SWEEP_INCOMPLETE");

    // Everything returns to the treasury except what the cash-out paid to Lightning
    // and what renewals during the run paid the Operator.
    const cashedOut = cashout ? Number(cashout.fundAmount) : 0;
    const renewals = [
      ...(await renewalsOf(conn, treasuryAccount)),
      ...(await renewalsOf(conn, { address: payoutAddress, pkScript: card.body.providerPayoutScript })),
    ];
    for (const r of renewals) {
      const limit = r.script === record.treasuryScript ? record.treasury.maxFeeSats : payoutTerms.maxFeeSats;
      ensure(
        r.feeSats >= 0 && r.feeSats <= limit * r.renewed.length,
        "RENEWAL_FEE",
        `${r.commitmentTxid}: ${r.feeSats} sats`,
      );
    }
    const renewalFees = renewals.reduce((n, r) => n + r.feeSats, 0);
    const treasuryExpected = CAPS.treasury - cashedOut - renewalFees;
    const view = await hiveView(loadHive(hive), conn);
    const balances = {
      treasurySats: await balance(conn, record.treasuryScript),
      providerWalletSats: await balance(conn, card.body.providerPayoutScript),
      paidEscrowSats: await balance(conn, readPurchase(paths.local("purchases", "paid")).escrow.pkScript),
      unpaidEscrowSats: await balance(conn, unpaidPurchase.escrow.pkScript),
    };
    ensure(
      balances.treasurySats === treasuryExpected,
      "TREASURY_BALANCE",
      `${balances.treasurySats} != ${treasuryExpected}`,
    );
    ensure(
      balances.providerWalletSats === 0 && balances.paidEscrowSats + balances.unpaidEscrowSats === 0,
      "BALANCES",
    );
    const renewal = await conn.delegatee.address(record.treasuryAddress);
    return {
      status: env.mode === "offline" ? "offline-smoke" : "passed",
      network: env.deployment.network,
      hive: {
        treasuryAddress: record.treasuryAddress,
        treasuryScript: record.treasuryScript,
        stewardKeys: record.stewardKeys,
        pairKeys: record.treasury.pairs,
        renewal: {
          windowSeconds: record.treasury.renewalWindowSeconds,
          maxFeeSats: record.treasury.maxFeeSats,
        },
        renewalWatch: record.renewalWatch,
        lightningAddress: record.registration?.lightningAddress ?? null,
      },
      operator: { keys: conn.keys, info: conn.operator },
      provider: {
        cardId: card.cardId,
        payoutAddress,
        payoutScript: card.body.providerPayoutScript,
        payoutOwner: (await payoutOwner(hive)).owner,
        payoutWallet: (await payoutOwner(hive)).wallet,
      },
      model,
      treasuryFunding: funding,
      escrows: {
        paid: { quote: paidQuote, coin: paid.coin, pair: "01" },
        unpaid: { quote: unpaidPurchase.quote, coin: unpaid.coin, pair: "02" },
      },
      inferences: [0, 1].map((i) => {
        const r = readJson<InferenceResult>(local(`inference-${i}.response.json`));
        return {
          sha256: r.sha256,
          contentType: r.contentType,
          amountSats: r.amountSats,
          requestId: r.requestId,
        };
      }),
      replay,
      closeDecision: readJson(resolve(escrow.claimDirectory, "close-decision.json")),
      fundings: Object.fromEntries(
        await Promise.all(
          (["paid", "unpaid"] as const).map(async (label) => [
            label,
            await Promise.all(
              fundingJournals(paths.local("purchases", label)).map(async (path) => {
                const j = readJson<SpendJournal>(path);
                return {
                  status: j.status,
                  txid: j.txid ?? null,
                  arkTxid: j.arkTxid ?? null,
                  attempts: j.attempts ?? [],
                  plan: j.plan,
                  attestations: j.attestations ?? null,
                  request: j.request ?? null,
                  ...(j.status === "expired"
                    ? {
                        outcome: {
                          inputs: await conn.arkd.coins({
                            outpoints: j.plan.coins.map((c) => `${c.txid}:${c.vout}`),
                          }),
                          observedAt: Math.floor(Date.now() / 1000),
                        },
                      }
                    : {}),
                };
              }),
            ),
          ]),
        ),
      ),
      claimRegistrations: safeList(paths.local("claims"))
        .filter((f) => f.startsWith("paid-"))
        .map((f) => readJson(paths.local("claims", f))),
      claim: {
        escrowId: claim.escrowId,
        amountSats: claim.amountSats,
        claimSignature: claim.claimSignature,
        submissions: claim.submissions,
        txid: claim.txid,
        paidSats: claim.paidSats,
      },
      refund,
      cashout,
      withdrawal: withdrawal.parts.map((p) => ({
        status: p.status,
        txid: p.txid,
        arkTxid: p.arkTxid ?? null,
        attempts: p.attempts ?? [],
        plan: p.plan,
        request: p.request,
      })),
      sweep: sweep.parts.map((p) => ({
        status: p.status,
        txid: p.txid,
        arkTxid: p.arkTxid ?? null,
        attempts: p.attempts ?? [],
        plan: p.plan,
        request: p.request,
      })),
      renewals,
      renewalFees,
      balances,
      treasuryWatch: { status: renewal.delegation.status, attempts: renewal.attempts.slice(0, 20) },
      view,
    };
  } finally {
    await escrow?.close();
    await served?.close();
    for (const service of services.reverse()) await service.close();
    await relay?.close();
    log?.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runIndex = argv.indexOf("--run");
  const runId = runIndex >= 0 ? argv[runIndex + 1]! : randomUUID();
  const offline = argv.includes("--offline");
  // Offline runs move no value; their evidence stays local.
  if (offline) process.env.BUZZ_EVIDENCE_ROOT ??= localPath("offline-evidence");
  const env = await gateEnv(argv);
  const run = GateRun.create(offline ? "lifecycle-offline" : `lifecycle-${env.deployment.network}`);
  let upstream: { url: string; close(): Promise<void> } | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await upstream?.close();
      await env.close();
    })());
  const stopInterrupts = run.handleInterrupts(
    { schema: "hive-lifecycle/v4", schemaVersion: EVIDENCE_VERSION, runId },
    close,
  );
  process.stdout.write(`${JSON.stringify({ gate: "lifecycle", runId, evidence: run.directory })}\n`);
  const sources = sourceHashes();
  try {
    const upstreamIndex = argv.indexOf("--upstream");
    let upstreamUrl = upstreamIndex >= 0 ? argv[upstreamIndex + 1]! : "http://127.0.0.1:9337/v1";
    if (offline || argv.includes("--stub-upstream")) {
      // The sidecar's saved configuration names the upstream, so a resumed run listens where the first one did.
      const saved = opsPaths(`gate-${runId.slice(0, 8)}`).local("gate", "upstream.json");
      const port = readJsonIfPresent<{ port: number }>(saved)?.port;
      upstream = await (await import("../test/support/upstream.js")).stubUpstream(undefined, port ?? 0);
      upstreamUrl = upstream.url;
      if (port === undefined) writeOnce(saved, { port: Number(new URL(upstream.url).port) });
    }
    const result = await runLifecycle(env, runId, { upstream: upstreamUrl }, run);
    if (run.interrupted) return;
    run.write("lifecycle.json", {
      schema: "hive-lifecycle/v4",
      schemaVersion: EVIDENCE_VERSION,
      ...result,
      runId,
      skipped: 0,
      // Free text naming the stack, the delegatee build and who ran it.
      environment: process.env.BUZZ_GATE_ENVIRONMENT ?? null,
      startedAt: run.startedAt,
      completedAt: new Date().toISOString(),
      command:
        `pnpm gate:lifecycle ${argv.filter((a) => a !== "--run" && a !== runId).join(" ")} --run ${runId}`.trim(),
      sourceSha256: sources,
      limits: [
        "The hive's keys sign attestations and spend requests only; each spend is executed by its participant through the Emulator or by the delegatee, and both build the same transaction.",
        "A claim the provider cannot execute itself reaches the delegatee through a steward pair, which can delay it but cannot change it; the escrow refunds at its deadline regardless.",
        "Usage accounting relies on the upstream's reported usage and the provider's sidecar; it is not a proof of model computation.",
      ],
    });
    process.stdout.write(
      `${JSON.stringify({ status: result.status, claim: (result.claim as { txid?: string }).txid })}\n`,
    );
  } catch (error) {
    if (run.interrupted) return;
    run.write("failure.json", {
      schema: "hive-lifecycle/v4",
      schemaVersion: EVIDENCE_VERSION,
      status: "stopped",
      runId,
      code: faultCode(error, "FAILED"),
      detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      at: new Date().toISOString(),
    });
    process.stderr.write(
      `Lifecycle gate stopped: ${faultCode(error, String(error))}. Resume with --run ${runId}.\n`,
    );
    process.exitCode = 1;
  } finally {
    stopInterrupts();
    await close();
  }
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
