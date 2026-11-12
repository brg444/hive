/**
 * Writes `packages/ark/test/vectors/spends.json`: for each kind of offchain
 * spend v4 makes, the ark transaction and checkpoints the delegatee's own Go
 * code builds from the template (`tools/delegatee-ref spend`, against the
 * clone at `.local/delegatee`). The tests hold the covenant builders and the
 * executor's SDK build to them, so a spend has the same txid whoever
 * executes it.
 *
 *   node --import tsx tools/spend-vectors.ts [--check]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ARTIFACTS,
  type ClaimPlan,
  claimHasRemainder,
  claimSpend,
  claimVariables,
  type CovenantSpend,
  type ContractKind,
  escrowArguments,
  escrowClaimTemplate,
  escrowRefundTemplate,
  exitLeaf,
  instantiate,
  intVar,
  pairKeys,
  type Pair,
  type RefundPlan,
  refundSpend,
  type SendPlan,
  sendSpend,
  signedSend,
  treasuryArguments,
  treasuryPlanVariables,
  treasurySendTemplate,
  walletArguments,
  walletPlanVariables,
  walletSendTemplate,
} from "@hive/ark";
import { hex, repositoryRoot } from "@hive/kit";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Transaction } from "@scure/btc-signer";

const label = (l: string) => sha256(new TextEncoder().encode(`hive-v4-spend-vector/${l}`));
const key = (l: string) => hex(secp256k1.getPublicKey(label(l), true));
const keys = { server: key("server"), emulator: key("emulator"), delegate: key("delegate") };
const pairs = pairKeys([key("steward0"), key("steward1"), key("steward2")]);
const PLACEHOLDER = "0".repeat(64);
const unroll = exitLeaf(keys.server.slice(2), 4096);
const sig = (l: string) => hex(new Uint8Array([...label(`${l}/r`), ...label(`${l}/s`)]));

const treasuryTerms = { pairs, exitDelaySeconds: 1024, renewalWindowSeconds: 1200, maxFeeSats: 2000 };
const walletTerms = {
  owner: key("owner"),
  exitDelaySeconds: 1024,
  renewalWindowSeconds: 1200,
  maxFeeSats: 2000,
};
const escrowTerms = {
  payer: key("payer").slice(2),
  provider: key("provider").slice(2),
  providerProgram: key("provider program").slice(2),
  treasuryProgram: key("treasury program").slice(2),
  escrowId: hex(label("escrow id")),
  timeoutAt: 1_791_640_000,
  exitDelaySeconds: 1024,
  pairs,
};

/** A transaction paying `script` `amount` at `vout`, standing in for the coin's creator. */
function source(name: string, script: string, amount: number, vout: number) {
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
  tx.addInput({ txid: label(name), index: 0, sequence: 0xffffffff });
  for (let i = 0; i <= vout; i++)
    tx.addOutput({
      script: i === vout ? Buffer.from(script, "hex") : Buffer.from("6a", "hex"),
      amount: i === vout ? BigInt(amount) : 0n,
    });
  return { txid: tx.id, vout, amount, tx: hex(tx.unsignedTx), script };
}

interface Case {
  name: string;
  kind: ContractKind;
  args: Record<string, string>;
  template: Record<string, unknown>;
  variables: Record<string, string>;
  sources: ReturnType<typeof source>[];
  spend: CovenantSpend;
}

function sendCase(
  name: string,
  kind: "wallet" | "treasury",
  amounts: number[],
  amount: number,
  change: number,
  pair: Pair = "02",
): Case {
  const args = kind === "wallet" ? walletArguments(walletTerms) : treasuryArguments(treasuryTerms);
  const instance = instantiate(ARTIFACTS[kind], args, keys);
  const sources = amounts.map((a, i) => source(`${name}/coin${i}`, instance.pkScript, a, i));
  const terms = {
    amount,
    change,
    validUntil: 1_791_650_000,
    destination: `5120${key(`${name}/dest`).slice(2)}`,
  };
  const plan: SendPlan = {
    account: kind,
    ...(kind === "treasury" ? { pair } : {}),
    coins: sources.map((s) => ({ txid: s.txid, vout: s.vout, amount: s.amount, script: s.script })),
    templateId: PLACEHOLDER,
    variables:
      kind === "wallet"
        ? walletPlanVariables(walletTerms, terms)
        : treasuryPlanVariables(treasuryTerms, terms),
    ...terms,
  };
  const sigs = sources.map((_, i) => sig(`${name}/sig${i}`));
  const template =
    kind === "wallet"
      ? walletSendTemplate(PLACEHOLDER, sources.length, change > 0)
      : treasurySendTemplate(PLACEHOLDER, pair, sources.length, change > 0);
  return {
    name,
    kind,
    args,
    template,
    variables: signedSend(plan, sigs).variables,
    sources,
    spend: sendSpend(plan, instance, sigs),
  };
}

function claimCase(name: string, coinAmount: number, amount: number): Case {
  const args = escrowArguments(escrowTerms);
  const instance = instantiate(ARTIFACTS.escrow, args, keys);
  const [coin] = [source(`${name}/escrow`, instance.pkScript, coinAmount, 0)];
  const plan: ClaimPlan = {
    escrow: escrowTerms,
    coin: { txid: coin!.txid, vout: 0, amount: coinAmount, script: instance.pkScript },
    amount,
    receiptSig: sig(`${name}/receipt`),
    claimSig: sig(`${name}/claim`),
    templateId: PLACEHOLDER,
    expiresAt: escrowTerms.timeoutAt,
  };
  return {
    name,
    kind: "escrow",
    args,
    template: escrowClaimTemplate(PLACEHOLDER, claimHasRemainder(plan)),
    variables: claimVariables(plan),
    sources: [coin!],
    spend: claimSpend(plan, instance),
  };
}

function refundCase(name: string, coinAmount: number): Case {
  const args = escrowArguments(escrowTerms);
  const instance = instantiate(ARTIFACTS.escrow, args, keys);
  const coin = source(`${name}/escrow`, instance.pkScript, coinAmount, 1);
  const plan: RefundPlan = {
    escrow: escrowTerms,
    coin: { txid: coin.txid, vout: coin.vout, amount: coinAmount, script: instance.pkScript },
    templateId: PLACEHOLDER,
    expiresAt: escrowTerms.timeoutAt + 3600,
  };
  return {
    name,
    kind: "escrow",
    args,
    template: escrowRefundTemplate(PLACEHOLDER, escrowTerms),
    variables: {},
    sources: [coin],
    spend: refundSpend(plan, instance),
  };
}

const cases = [
  sendCase("wallet send with change", "wallet", [12_000], 5_000, 7_000),
  sendCase("wallet send of everything from two coins", "wallet", [3_000, 1_500], 4_500, 0),
  sendCase(
    "treasury send by pair 02 from two coins with change",
    "treasury",
    [20_000, 10_000],
    25_000,
    5_000,
  ),
  claimCase("escrow claim with a remainder", 30_000, 1_860),
  claimCase("escrow claim of nearly everything", 10_000, 9_800),
  refundCase("escrow refund", 10_000),
  sendCase(
    "treasury send by pair 01 from two coins with change",
    "treasury",
    [20_000, 10_000],
    25_000,
    5_000,
    "01",
  ),
  sendCase(
    "treasury send by pair 12 from two coins with change",
    "treasury",
    [20_000, 10_000],
    25_000,
    5_000,
    "12",
  ),
  sendCase("wallet send of everything from one coin", "wallet", [12_000], 12_000, 0),
  sendCase("treasury send from one coin with change", "treasury", [12_000], 5_000, 7_000),
  sendCase("treasury send of everything from one coin", "treasury", [12_000], 12_000, 0),
  sendCase("treasury send of everything from two coins", "treasury", [3_000, 1_500], 4_500, 0),
  sendCase("wallet send from three coins with change", "wallet", [3_000, 4_000, 5_000], 10_000, 2_000),
  claimCase("escrow claim with exactly 330 sats left", 10_000, 9_670),
  claimCase("escrow claim with exactly 331 sats left", 10_000, 9_669),
];
void intVar;

const dir = resolve(repositoryRoot, ".local", "spend-vectors");
mkdirSync(dir, { recursive: true });
const out = cases.map((c) => {
  const input = resolve(dir, `${c.name.replaceAll(" ", "-")}.json`);
  const template = JSON.parse(JSON.stringify(c.template).replaceAll(PLACEHOLDER, `<artifact:${c.kind}>`));
  writeFileSync(
    input,
    JSON.stringify({
      serverKey: keys.server,
      emulatorKey: keys.emulator,
      delegateKey: keys.delegate,
      artifacts: { [c.kind]: ARTIFACTS[c.kind] },
      template,
      variables: c.variables,
      checkpointTapscript: unroll,
      dust: 330,
      sources: c.sources.map((s) => ({ ...s, expiry: escrowTerms.timeoutAt + 7200 })),
    }),
  );
  const expected = JSON.parse(
    execFileSync("go", ["run", ".", "spend", input], {
      cwd: resolve(repositoryRoot, "tools/delegatee-ref"),
    }).toString(),
  );
  return { name: c.name, kind: c.kind, args: c.args, sources: c.sources, spend: c.spend, expected };
});
const target = resolve(repositoryRoot, "packages/ark/test/vectors/spends.json");
const text = `${JSON.stringify({ keys, checkpointTapscript: unroll, cases: out }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== text) {
    process.stderr.write(`${target} differs from the delegatee's build\n`);
    process.exit(1);
  }
  process.stdout.write(`${target} matches\n`);
} else {
  writeFileSync(target, text);
  process.stdout.write(`${target}\n`);
}
