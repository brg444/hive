import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import { test } from "node:test";
import { Arkd, Delegatee } from "@hive/ark";
import { localPath, repositoryRoot } from "@hive/kit";
import { runRenewal } from "../gates/renewal.js";
import { offlineEnv } from "../gates/support/env.js";
import { opsPaths } from "../tools/ops.js";

function childEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, BUZZ_EVIDENCE_ROOT: root };
  for (const name of [
    "BUZZ_MUTINYNET",
    "BUZZ_STACK_FAUCET",
    "BUZZ_MAINNET",
    "BUZZ_EMULATOR_URL",
    "BUZZ_EXECUTION",
  ])
    delete env[name];
  return env;
}

test("renewal captures the minted originals before an immediate background tick", {
  timeout: 20_000,
}, async (t) => {
  const env = await offlineEnv();
  const fake = env.fake!;
  const runId = randomUUID();
  const paths = opsPaths(`renew-${runId.slice(0, 8)}`);
  const minted: string[] = [];
  const mint = fake.mint.bind(fake);
  const coins = Arkd.prototype.coins;
  const address = Delegatee.prototype.address;
  let observedRenewal = false;
  t.after(async () => {
    Arkd.prototype.coins = coins;
    Delegatee.prototype.address = address;
    await env.close();
    rmSync(paths.local(), { recursive: true, force: true });
    rmSync(paths.secret(), { recursive: true, force: true });
  });
  fake.mint = (...args) => {
    const coin = mint(...args);
    minted.push(`${coin.txid}:${coin.vout}`);
    queueMicrotask(() => fake.tick());
    return coin;
  };
  Delegatee.prototype.address = async function (...args) {
    if (minted.length === 2) observedRenewal = true;
    return address.apply(this, args);
  };
  Arkd.prototype.coins = async function (query, signal) {
    const result = await coins.call(this, query, signal);
    // Bound the old-code failure: it must not enter the replacement's long expiry wait.
    if (minted.length === 2 && query.spendableOnly && !observedRenewal) {
      assert.ok(
        result.every((coin) => minted.includes(`${coin.txid}:${coin.vout}`)),
        "the asynchronous starting snapshot contains replacement coins",
      );
    }
    return result;
  };
  const result = await runRenewal(env, runId);
  const renewals = result.renewals as { outpoint: string; renewed: { outpoint: string } }[];
  assert.equal(result.status, "offline-smoke");
  assert.deepEqual(renewals.map((r) => r.outpoint).sort(), [...minted].sort());
  assert.ok(renewals.every((r) => !minted.includes(r.renewed.outpoint)));
});

for (const [suite, hivePrefix] of [
  ["renewal", "renew"],
  ["lifecycle", "gate"],
  ["refusals", "refuse"],
] as const) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`an interrupted offline ${suite} gate records ${signal} before exit`, {
      timeout: 30_000,
    }, async (t) => {
      const parent = localPath("test-gate-interruptions");
      mkdirSync(parent, { recursive: true });
      const root = mkdtempSync(resolve(parent, "run-"));
      let runId: string | undefined;
      const child = spawn(
        process.execPath,
        ["--experimental-eventsource", "--import", "tsx", `gates/${suite}.ts`, "--offline"],
        { cwd: repositoryRoot, env: childEnvironment(root), stdio: ["ignore", "pipe", "pipe"] },
      );
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit, reject) => {
          child.once("error", reject);
          child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
        },
      );
      // Terminate a stuck subprocess before removing only this test's local state.
      t.after(async () => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await ended;
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
          if (runId) {
            const paths = opsPaths(`${hivePrefix}-${runId.slice(0, 8)}`);
            rmSync(paths.local(), { recursive: true, force: true });
            rmSync(paths.secret(), { recursive: true, force: true });
          }
        }
      });
      let buffered = "";
      let evidence: string | undefined;
      child.stdout.on("data", (data: Buffer) => {
        buffered += data.toString();
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) return;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (evidence || !line.includes(`"gate":"${suite}"`)) continue;
          const ready = JSON.parse(line) as { runId: string; evidence: string };
          runId = ready.runId;
          evidence = ready.evidence;
          child.kill(signal);
        }
      });
      // Drain diagnostics; no raw child output is copied into a journal or report.
      child.stderr.resume();
      const outcome = await ended;
      assert.ok(evidence, "the child reached its offline gate readiness record");
      assert.ok(existsSync(resolve(evidence, "failure.json")), "the interruption is durable evidence");
      const failure = JSON.parse(readFileSync(resolve(evidence, "failure.json"), "utf8"));
      assert.equal(failure.schema, `hive-${suite}/v4`);
      assert.equal(failure.schemaVersion, 2);
      assert.equal(failure.status, "stopped");
      assert.equal(failure.code, "INTERRUPTED");
      assert.equal(failure.signal, signal);
      assert.equal(failure.runId, runId);
      assert.equal(outcome.code, signal === "SIGINT" ? 130 : 143);
      assert.equal(outcome.signal, null);
      assert.ok(!existsSync(resolve(evidence, `${suite}.json`)));
    });
  }
}

test("audit --offline reads the same local evidence root as its gates", () => {
  const parent = localPath("test-audit-root");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "run-"));
  try {
    const fixtures = resolve(repositoryRoot, "test/fixtures/v4-evidence");
    const source = readdirSync(fixtures).find((name) => existsSync(resolve(fixtures, name, "renewal.json")))!;
    assert.ok(source);
    const run = resolve(root, "renewal-offline", "copied-public-run");
    mkdirSync(run, { recursive: true });
    cpSync(resolve(fixtures, source, "renewal.json"), resolve(run, "renewal.json"));
    const result = spawnSync(process.execPath, ["--import", "tsx", "tools/audit.ts", "--offline"], {
      cwd: repositoryRoot,
      env: childEnvironment(root),
      encoding: "utf8",
      timeout: 10_000,
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.root, relative(repositoryRoot, root));
    assert.deepEqual(
      report.runs.map((r: { run: string }) => r.run),
      [relative(repositoryRoot, run)],
    );
    assert.equal(report.funded, false);
    assert.deepEqual(report.failures, []);
    assert.equal(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit --offline rejects an evidence override outside .local", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "tools/audit.ts", "--offline"], {
    cwd: repositoryRoot,
    env: childEnvironment(resolve(repositoryRoot, "docs/evidence/v4")),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BUZZ_EVIDENCE_ROOT must be under \.local/);
});
