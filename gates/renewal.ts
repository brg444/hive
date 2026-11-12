import { requireCoinExpiry } from "@hive/ark";
/**
 * The v4 renewal gate: the delegatee renews the treasury and a payout wallet
 * before their batches expire, paying its fee from each coin within the
 * leaf's limit, and the hive counts what it renewed as renewals, never as
 * contributions.
 *
 *   pnpm gate:renewal --offline | [--network regtest]
 *
 * On regtest the hive's renewal window is half the stack's batch life, the
 * most the delegatee honours, so the run lasts about half a batch.
 */
import { randomUUID } from "node:crypto";
import { connect, type IndexedCoin } from "@hive/ark";
import { ensure, faultCode, localPath, sleep } from "@hive/kit";
import { addProvider, initHive, opsPaths, hiveView, withdrawTreasury } from "../tools/ops.js";
import { hiveSecrets } from "./lifecycle.js";
import { type GateEnv, gateEnv, renewalsSettled } from "./support/env.js";
import { GateRun, sourceHashes } from "./support/run.js";
import { EVIDENCE_VERSION } from "./support/schema.js";

export async function runRenewal(
  env: GateEnv,
  runId: string,
  run?: GateRun,
): Promise<Record<string, unknown>> {
  ensure(
    env.mode !== "mutinynet",
    "UNSUPPORTED_NETWORK",
    "Mutinynet renewals take a day; watch them with `pnpm ops renewal`",
  );
  const hive = `renew-${runId.slice(0, 8)}`;
  const paths = opsPaths(hive);
  run?.forbidFrom(() => [...hiveSecrets(hive), ...(env.secrets?.() ?? [])]);
  const ctx = { inProcessStewards: env.mode === "offline" };
  const windowSeconds = env.mode === "offline" ? 600 : 2048;
  const record = await initHive(
    hive,
    {
      network: env.deployment.network,
      deployment: env.deployment,
      renewalWindowSeconds: windowSeconds,
      renewalMaxFeeSats: env.renewal.maxFeeSats,
    },
    ctx,
  );
  const conn = await connect(record.deployment);
  const { card, payoutAddress } = await addProvider(
    hive,
    "provider",
    { model: "renewal-model", inputRate: "1", outputRate: "1", relay: "ws://127.0.0.1:9/" },
    ctx,
  );
  const wallet = card.body.providerPayoutScript;
  let funded: IndexedCoin[];
  if (env.fake) {
    // Coins already inside the window: the next scan renews them, for a fee within the leaf's limit.
    env.fake.renewalFeeSats = 100;
    const resumeTicks = env.fake.pauseTicks();
    try {
      // Mint returns mutable records: copy both before a renewal can mark them spent.
      funded = [
        structuredClone({
          ...env.fake.mint(record.treasuryScript, 20_000, { expiresInSeconds: 300 }),
          isSwept: false,
        }),
        structuredClone({
          ...env.fake.mint(wallet, 5_000, { expiresInSeconds: 300 }),
          isSwept: false,
        }),
      ];
    } finally {
      resumeTicks();
    }
  } else {
    await env.fundTreasury(conn, record, 20_000, paths.local("intake", "requests"));
    await renewalsSettled(
      conn,
      { address: record.treasuryAddress, pkScript: record.treasuryScript },
      record.treasury.renewalWindowSeconds,
    );
    const withdrawal = await withdrawTreasury(
      hive,
      "to-wallet",
      { to: payoutAddress, amount: "5000", pair: "01" },
      ctx,
    );
    ensure(withdrawal.complete, "WITHDRAWAL_INCOMPLETE");
    funded = await conn.arkd.coins({ scripts: [record.treasuryScript, wallet], spendableOnly: true });
  }
  const original = funded.filter((c) => !c.isSpent);
  ensure(original.length >= 2, "FUNDING_NOT_OBSERVED");
  const latestExpiry = Math.max(...original.map(requireCoinExpiry));
  const deadline = Date.now() + (Math.max(0, latestExpiry - Date.now() / 1000) + 300) * 1000;
  process.stdout.write(`${JSON.stringify({ waitingUntil: new Date(latestExpiry * 1000).toISOString() })}\n`);

  // Every original coin spent into a batch the delegatee reports as its own renewal.
  const outcome = await (async () => {
    for (;;) {
      const [treasuryState, walletState] = await Promise.all([
        conn.delegatee.address(record.treasuryAddress),
        conn.delegatee.address(payoutAddress),
      ]);
      const attempts = [...treasuryState.attempts, ...walletState.attempts].filter((a) => a.success);
      const renewed = original.filter((c) =>
        attempts.some((a) => a.outpoints.includes(`${c.txid}:${c.vout}`)),
      );
      if (renewed.length === original.length) return { treasuryState, walletState, attempts };
      ensure(
        Date.now() < deadline,
        "RENEWAL_NOT_OBSERVED",
        `${renewed.length} of ${original.length} coins renewed`,
      );
      await sleep(env.mode === "offline" ? 500 : 15_000);
    }
  })();
  const after = (
    await conn.arkd.coins({ scripts: [record.treasuryScript, wallet], spendableOnly: true })
  ).filter((c) => !c.isSpent);
  const fees = original.map((coin) => {
    const attempt = outcome.attempts.find((a) => a.outpoints.includes(`${coin.txid}:${coin.vout}`))!;
    const replacement = after.find(
      (c) => c.script === coin.script && c.commitmentTxids.includes(attempt.txid),
    );
    return {
      outpoint: `${coin.txid}:${coin.vout}`,
      script: coin.script,
      amountSats: coin.amount,
      expiredAt: requireCoinExpiry(coin),
      commitmentTxid: attempt.txid,
      renewed: replacement
        ? {
            outpoint: `${replacement.txid}:${replacement.vout}`,
            amountSats: replacement.amount,
            expiresAt: requireCoinExpiry(replacement),
            script: replacement.script,
            commitmentTxids: replacement.commitmentTxids,
          }
        : null,
      feeSats: replacement ? coin.amount - replacement.amount : null,
    };
  });
  for (const fee of fees) {
    ensure(fee.renewed, "RENEWAL_OUTPUT_MISSING", fee.outpoint);
    ensure(fee.feeSats! >= 0 && fee.feeSats! <= record.treasury.maxFeeSats, "RENEWAL_FEE", fee.outpoint);
    ensure(fee.renewed.expiresAt > fee.expiredAt, "RENEWAL_EXPIRY", fee.outpoint);
  }
  const view = await hiveView(record, conn);
  const renewedTreasury = fees.filter((f) => f.script === record.treasuryScript);
  ensure(
    renewedTreasury.every((f) => view.renewals.some((r) => `${r.txid}:${r.vout}` === f.renewed!.outpoint)),
    "RENEWAL_UNATTRIBUTED",
  );
  ensure(
    !view.contributions.some((c) =>
      renewedTreasury.some((f) => `${c.txid}:${c.vout}` === f.renewed!.outpoint),
    ),
    "RENEWAL_CREDITED",
  );
  return {
    status: env.mode === "offline" ? "offline-smoke" : "passed",
    network: env.deployment.network,
    treasury: {
      address: record.treasuryAddress,
      renewal: { windowSeconds, maxFeeSats: record.treasury.maxFeeSats },
    },
    wallet: { address: payoutAddress, script: wallet },
    renewals: fees,
    view: {
      renewals: view.renewals,
      contributions: view.contributions,
      balanceSats: view.treasury.balanceSats,
    },
    delegatee: {
      treasuryWatch: outcome.treasuryState.delegation.id,
      walletWatch: outcome.walletState.delegation.id,
      attempts: outcome.attempts,
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runId = randomUUID();
  const offline = argv.includes("--offline");
  if (offline) process.env.BUZZ_EVIDENCE_ROOT ??= localPath("offline-evidence");
  const env = await gateEnv(argv);
  const run = GateRun.create(offline ? "renewal-offline" : `renewal-${env.deployment.network}`);
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= env.close());
  const stopInterrupts = run.handleInterrupts(
    { schema: "hive-renewal/v4", schemaVersion: EVIDENCE_VERSION, runId },
    close,
  );
  process.stdout.write(`${JSON.stringify({ gate: "renewal", runId, evidence: run.directory })}\n`);
  const sources = sourceHashes();
  try {
    const result = await runRenewal(env, runId, run);
    if (run.interrupted) return;
    run.write("renewal.json", {
      schema: "hive-renewal/v4",
      schemaVersion: EVIDENCE_VERSION,
      ...result,
      runId,
      skipped: 0,
      // Free text naming the stack, the delegatee build and who ran it.
      environment: process.env.BUZZ_GATE_ENVIRONMENT ?? null,
      startedAt: run.startedAt,
      completedAt: new Date().toISOString(),
      command: `pnpm gate:renewal ${argv.join(" ")}`.trim(),
      sourceSha256: sources,
    });
    process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
  } catch (error) {
    if (run.interrupted) return;
    run.write("failure.json", {
      schema: "hive-renewal/v4",
      schemaVersion: EVIDENCE_VERSION,
      status: "stopped",
      runId,
      code: faultCode(error, "FAILED"),
      detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      at: new Date().toISOString(),
    });
    process.stderr.write(`Renewal gate stopped: ${faultCode(error, String(error))}.\n`);
    process.exitCode = 1;
  } finally {
    stopInterrupts();
    await close();
  }
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
