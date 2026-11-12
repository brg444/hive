import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  accountCoins,
  type Connection,
  type Deployment,
  type IndexedCoin,
  MUTINYNET,
  openWallet,
  regtestDeployment,
  type Wallet,
  walletBalance,
  walletBoarding,
  walletSend,
  walletTerms,
  xOnly,
} from "@hive/ark";
import {
  ensure,
  fail,
  hex,
  localPath,
  readPrivateJson,
  repositoryRoot,
  secretPath,
  sleep,
  stateExists,
  unhex,
  withLock,
  writePrivateOnce,
} from "@hive/kit";
import { requestContribution } from "@hive/hive";
import type { CashoutRail } from "@hive/provider";
import { publishedCashoutRail } from "@hive/provider";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { type FakeNetwork, startFakeNetwork } from "../../test/support/fake-network.js";
import type { HiveRecord } from "../../tools/ops.js";
import { faucetInvoice, faucetPays, MUTINYNET_LNURL, MUTINYNET_RELAY } from "./mutinynet.js";

/**
 * Where a gate runs and how it gets its starting coins. Every network uses
 * the same hive code; only the funding source, the way time passes for the
 * chain, and the Lightning payee differ.
 */
export interface GateEnv {
  mode: "offline" | "regtest" | "mutinynet";
  deployment: Deployment;
  /** The in-memory network, offline only. */
  fake?: FakeNetwork;
  /** Secrets the environment itself holds, such as a funding key, which evidence must never contain. */
  secrets?(): string[];
  /** Pay the treasury from this network's funding source and return the observed coin. */
  fundTreasury(
    conn: Connection,
    hive: HiveRecord,
    amountSats: number,
    requestsDirectory: string,
  ): Promise<IndexedCoin>;
  /** Return once the chain's median time has passed `unixSeconds`, so time locks there open. */
  advanceTo(unixSeconds: number): Promise<void>;
  /** The Lightning address service a hive registers with; absent where none runs. */
  lnurl?: string;
  /** Where providers advertise and answer RFQs; a local relay when absent. */
  relayUrl?: string;
  /** A Lightning payee for a provider's cash-out and the corridor that pays it; absent where no solver runs. */
  cashout?: {
    invoice(amountSats: number): Promise<string>;
    rail(conn: Connection): CashoutRail;
    settle?(): number;
  };
  renewal: { windowSeconds: number; maxFeeSats: number };
  timing: GateTiming;
  close(): Promise<void>;
}

export interface GateTiming {
  /** Seconds from approval to the paid escrow's deadline: inference and the claim happen inside it. */
  paidTimeoutSeconds: number;
  /** Seconds from approval to the unpaid escrow's deadline, after which the delegatee refunds it. */
  unpaidTimeoutSeconds: number;
  quoteLifetimeSeconds: number;
  /** How long to wait for a delegatee action once it is due. */
  settleSeconds: number;
}

async function observed(
  conn: Connection,
  script: string,
  before: Set<string>,
  seconds: number,
): Promise<IndexedCoin> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const coin = (await conn.arkd.coins({ scripts: [script], spendableOnly: true })).find(
      (c) => c.script === script && !c.isSpent && !before.has(`${c.txid}:${c.vout}`),
    );
    if (coin) return coin;
    await sleep(2000);
  }
  return fail("FUNDING_NOT_OBSERVED", `no new coin at ${script} after ${seconds} seconds`);
}

/**
 * Wait until no coin of an account waits for its renewal. A plan leaves such
 * coins out from the renewal margin onward, so a step that needs them starts
 * once the delegatee has renewed them; the margin then covers the step. A
 * renewal template the delegatee disabled never renews anything, so that stops
 * the wait at once.
 */
export async function renewalsSettled(
  conn: Connection,
  account: { address: string; pkScript: string },
  windowSeconds: number,
  seconds = 1_500,
): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while ((await accountCoins(conn, account.pkScript, windowSeconds)).renewing.length) {
    const watch = await conn.delegatee.address(account.address);
    ensure(
      (await conn.delegatee.templateStatus(watch.delegation.templateId)) === "active",
      "RENEWALS_DISABLED",
      `the delegatee disabled the renewal template of ${account.address}`,
    );
    ensure(Date.now() < deadline, "RENEWAL_NOT_OBSERVED", `${account.address} still waits for its renewal`);
    await sleep(5000);
  }
}

const outpoints = async (conn: Connection, script: string) =>
  new Set((await conn.arkd.coins({ scripts: [script] })).map((c) => `${c.txid}:${c.vout}`));

export async function offlineEnv(): Promise<GateEnv> {
  // Watches run every half second, as a delegatee polls: renewals and refunds happen on their own.
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 2 * 86_400, tickMs: 500 });
  const { startSwapStub } = await import("../../test/support/swap-stub.js");
  const stub = startSwapStub(fake);
  return {
    mode: "offline",
    deployment: fake.deployment(),
    fake,
    async fundTreasury(conn, hive, amountSats) {
      const before = await outpoints(conn, hive.treasuryScript);
      fake.mint(hive.treasuryScript, amountSats);
      return observed(conn, hive.treasuryScript, before, 10);
    },
    async advanceTo(unixSeconds) {
      while (Date.now() / 1000 <= unixSeconds) await sleep(250);
    },
    cashout: {
      invoice: async (amount) => stub.invoice(amount),
      rail: () => stub.rail,
      settle: () => stub.settle(),
    },
    renewal: { windowSeconds: 600, maxFeeSats: 500 },
    timing: {
      paidTimeoutSeconds: 240,
      unpaidTimeoutSeconds: 150,
      quoteLifetimeSeconds: 140,
      settleSeconds: 30,
    },
    close: () => fake.close(),
  };
}

/**
 * The regtest fixture: a SimpleWallet owned by a key cached once under
 * `.secrets/v4/`. Its boarding address takes bitcoin from the stack's own
 * bitcoind faucet, which the delegatee boards into the wallet; the wallet then
 * funds each gate's treasury with one signed send. The stack's Ark wallet CLI
 * is never used.
 */
export interface Fixture {
  wallet: Wallet;
  secret: Uint8Array;
  boarding: { address: string; pkScript: string };
}

const FIXTURE_PATH = () => secretPath("v4", "fixture-wallet.json");

export async function regtestFixture(conn: Connection): Promise<Fixture> {
  const path = FIXTURE_PATH();
  const saved = stateExists(path)
    ? readPrivateJson<{ network: string; secretKey: string }>(path)
    : writePrivateOnce(path, { network: "regtest", secretKey: hex(secp256k1.utils.randomSecretKey()) });
  ensure(saved.network === "regtest" && /^[0-9a-f]{64}$/.test(saved.secretKey), "FIXTURE_KEY_INVALID");
  const secret = unhex(saved.secretKey);
  const owner = hex(secp256k1.getPublicKey(secret, true));
  const wallet = await openWallet(
    conn,
    walletTerms(conn, owner, { renewalWindowSeconds: 1200, maxFeeSats: 2000 }),
  );
  return { wallet, secret, boarding: await walletBoarding(wallet) };
}

/** The fixture's key, which evidence must never contain; empty before the first regtest run. */
export function fixtureSecrets(): string[] {
  return stateExists(FIXTURE_PATH())
    ? [readPrivateJson<{ secretKey: string }>(FIXTURE_PATH()).secretKey]
    : [];
}

/**
 * A local stack and a local delegatee. `BUZZ_ARKD_URL` and `BUZZ_DELEGATEE_URL`
 * name them; `BUZZ_STACK_DIR` and `BUZZ_STACK_ENV` name the stack's CLI, which
 * mines blocks so median time passes a deadline and, where its operator allows
 * it with `BUZZ_STACK_FAUCET=allowed`, pays the fixture's boarding address.
 */
export function regtestEnv(): GateEnv {
  const directory = process.env.BUZZ_STACK_DIR ?? resolve(repositoryRoot, "regtest");
  const envFile = process.env.BUZZ_STACK_ENV ?? ".env.regtest";
  const stack = (...args: string[]) =>
    execFileSync(process.execPath, ["regtest.mjs", args[0]!, ...args.slice(1), "--env", envFile], {
      cwd: directory,
      env: { ...process.env, CI: "1" },
      timeout: 120_000,
    }).toString();
  return {
    mode: "regtest",
    deployment: regtestDeployment(),
    secrets: fixtureSecrets,
    async fundTreasury(conn, hive, amountSats) {
      const fixture = await regtestFixture(conn);
      return withLock(localPath("v4", "fixture.lock"), async () => {
        // Coins waiting for their renewal are spendable again once renewed: wait for them before boarding more.
        for (const deadline = Date.now() + 1_500_000; Date.now() < deadline; await sleep(5000)) {
          const balance = await walletBalance(fixture.wallet);
          if (balance.spendableSats >= amountSats + 330 || !balance.renewingSats) break;
        }
        // Top up in deposits whose boarding fee stays within the wallet's limit.
        for (let round = 0; (await walletBalance(fixture.wallet)).spendableSats < amountSats + 330; round++) {
          ensure(
            process.env.BUZZ_STACK_FAUCET === "allowed",
            "FUNDING_UNAVAILABLE",
            `the fixture holds too little; set BUZZ_STACK_FAUCET=allowed to board from the stack's faucet to ${fixture.boarding.address}`,
          );
          ensure(round < 4, "FUNDING_NOT_OBSERVED", "boarding did not land");
          const before = (await walletBalance(fixture.wallet)).spendableSats;
          stack("faucet", fixture.boarding.address, "0.0015", "--confirm");
          const until = Date.now() + 180_000;
          while ((await walletBalance(fixture.wallet)).spendableSats <= before && Date.now() < until)
            await sleep(3000);
        }
        const before = await outpoints(conn, hive.treasuryScript);
        const send = await walletSend(fixture.wallet, fixture.secret, {
          journalPath: localPath("v4", "fixture", `${hive.name}-${Date.now()}.json`),
          destination: hive.treasuryScript,
          amount: amountSats,
          // A stack that bans coins after a failed batch holds the spend for minutes; the request outlasts that.
          validUntil: Math.floor(Date.now() / 1000) + 900,
          purpose: { kind: "fund-treasury", hive: hive.name, amountSats },
          timeoutMs: 960_000,
        });
        ensure(send.status === "done", "FUNDING_NOT_OBSERVED", send.status);
        return observed(conn, hive.treasuryScript, before, 60);
      });
    },
    async advanceTo(unixSeconds) {
      while (Date.now() / 1000 <= unixSeconds) await sleep(1000);
      // Eleven blocks stamped after the deadline put the median past it.
      stack("mine", "11");
    },
    renewal: { windowSeconds: 1200, maxFeeSats: 2000 },
    timing: {
      paidTimeoutSeconds: 480,
      unpaidTimeoutSeconds: 360,
      quoteLifetimeSeconds: 300,
      settleSeconds: 180,
    },
    close: async () => {},
  };
}

/**
 * Ark Labs' public Mutinynet: the pinned Operator and delegatee, the public
 * Lightning address service and relay, and the Mutinynet faucet as the outside
 * world's Lightning wallet. Every run needs approval first.
 */
export function mutinynetEnv(): GateEnv {
  ensure(
    process.env.BUZZ_MUTINYNET === "approved",
    "APPROVAL_REQUIRED",
    "Mutinynet runs need BUZZ_MUTINYNET=approved; see docs/running.md",
  );
  return {
    mode: "mutinynet",
    deployment: MUTINYNET,
    async fundTreasury(conn, hive, amountSats, requestsDirectory) {
      ensure(hive.registration, "FUNDING_UNAVAILABLE", "the hive has no Lightning address");
      const before = await outpoints(conn, hive.treasuryScript);
      const request = await requestContribution({
        endpoint: hive.registration.endpoint,
        network: "mutinynet",
        rail: "lightning",
        amountSats,
        operatorKey: hex(xOnly(conn.keys.server)),
        requestsDirectory,
      });
      await faucetPays(request.invoice!);
      return observed(conn, hive.treasuryScript, before, 600);
    },
    async advanceTo(unixSeconds) {
      // Median time trails the clock by about six 30-second blocks.
      while (Date.now() / 1000 <= unixSeconds + 240) await sleep(5000);
    },
    lnurl: MUTINYNET_LNURL,
    relayUrl: process.env.BUZZ_RFQ_RELAY ?? MUTINYNET_RELAY,
    cashout: { invoice: faucetInvoice, rail: (conn) => publishedCashoutRail(conn) },
    renewal: { windowSeconds: 86_400, maxFeeSats: 500 },
    timing: {
      paidTimeoutSeconds: 1200,
      unpaidTimeoutSeconds: 900,
      quoteLifetimeSeconds: 600,
      settleSeconds: 900,
    },
    close: async () => {},
  };
}

export async function gateEnv(argv: string[]): Promise<GateEnv> {
  if (argv.includes("--offline")) return offlineEnv();
  const index = argv.indexOf("--network");
  const network = index >= 0 ? argv[index + 1] : "regtest";
  if (network === "regtest") return regtestEnv();
  if (network === "mutinynet") return mutinynetEnv();
  return fail("UNSUPPORTED_NETWORK", String(network));
}
