/**
 * Writes `packages/ark/test/vectors/derivations.json`: the address and leaves
 * the delegatee's own Go code (`tools/delegatee-ref`, against a clone of
 * arkade-os/delegatee at `.local/delegatee`) derives for each v4 contract, so
 * the tests can hold the TypeScript derivation to it without Go.
 *
 *   node --import tsx tools/ark-vectors.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ARTIFACTS,
  boardingArguments,
  escrowArguments,
  escrowRefundTemplate,
  instantiate,
  pairKeys,
  treasuryArguments,
  treasuryRenewalTemplate,
  walletArguments,
  walletBoardingTemplate,
  walletBoardingVariables,
  walletRenewalTemplate,
  walletVariables,
} from "@hive/ark";
import { hex, repositoryRoot } from "@hive/kit";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

// Deterministic keys: sha256 of a label, so the vectors never change by chance.
const secret = (label: string) => sha256(new TextEncoder().encode(`hive-v4-vector/${label}`));
const key = (label: string) => hex(secp256k1.getPublicKey(secret(label), true));
const keys = { server: key("server"), emulator: key("emulator"), delegate: key("delegate") };
const stewards = [key("steward0"), key("steward1"), key("steward2")] as [string, string, string];
const pairs = pairKeys(stewards);
const PLACEHOLDER = "0".repeat(64);

const treasury = { pairs, exitDelaySeconds: 1024, renewalWindowSeconds: 86_400, maxFeeSats: 500 };
const wallet = {
  owner: key("provider"),
  exitDelaySeconds: 1024,
  renewalWindowSeconds: 86_400,
  maxFeeSats: 500,
};
const escrow = {
  payer: key("payer").slice(2),
  provider: key("provider-workload").slice(2),
  providerProgram: hex(sha256(new TextEncoder().encode("provider program"))),
  treasuryProgram: hex(sha256(new TextEncoder().encode("treasury program"))),
  escrowId: hex(sha256(new TextEncoder().encode("escrow id"))),
  timeoutAt: 1_791_640_000,
  exitDelaySeconds: 1024,
  pairs,
};

const walletProgram = instantiate(ARTIFACTS.wallet, walletArguments(wallet), keys).pkScript.slice(4);
const BOARDING_EXIT_DELAY = 2048;

// `artifact` names the registered artifact the template refers to; boarding refers to the wallet.
const cases = [
  {
    name: "treasury",
    kind: "treasury",
    artifact: "treasury",
    args: treasuryArguments(treasury),
    template: treasuryRenewalTemplate(PLACEHOLDER, treasury),
    variables: {},
  },
  {
    name: "escrow",
    kind: "escrow",
    artifact: "escrow",
    args: escrowArguments(escrow),
    template: escrowRefundTemplate(PLACEHOLDER, escrow),
    variables: {},
  },
  {
    name: "wallet",
    kind: "wallet",
    artifact: "wallet",
    args: walletArguments(wallet),
    template: walletRenewalTemplate(PLACEHOLDER),
    variables: walletVariables(wallet),
  },
  {
    name: "boarding",
    kind: "boarding",
    artifact: "wallet",
    args: boardingArguments(wallet, walletProgram, BOARDING_EXIT_DELAY),
    template: walletBoardingTemplate(PLACEHOLDER),
    variables: walletBoardingVariables(wallet, BOARDING_EXIT_DELAY),
  },
] as const;

const dir = resolve(repositoryRoot, ".local", "ark-vectors");
mkdirSync(dir, { recursive: true });
const out = cases.map((c) => {
  const input = resolve(dir, `${c.name}.json`);
  const template = JSON.parse(JSON.stringify(c.template).replaceAll(PLACEHOLDER, `<artifact:${c.artifact}>`));
  writeFileSync(
    input,
    JSON.stringify({
      serverKey: keys.server,
      emulatorKey: keys.emulator,
      delegateKey: keys.delegate,
      artifacts: { [c.artifact]: ARTIFACTS[c.artifact] },
      template,
      variables: c.variables,
    }),
  );
  const reference = JSON.parse(
    execFileSync("go", ["run", ".", "derive", input], {
      cwd: resolve(repositoryRoot, "tools/delegatee-ref"),
    }).toString(),
  );
  return { name: c.name, kind: c.kind, args: c.args, expected: reference };
});
const target = resolve(repositoryRoot, "packages/ark/test/vectors/derivations.json");
const text = `${JSON.stringify({ keys, stewards, pairs, cases: out }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  // The committed vectors must still be what the delegatee's own Go derives.
  if (readFileSync(target, "utf8") !== text) {
    process.stderr.write(`${target} differs from the delegatee's derivation\n`);
    process.exit(1);
  }
  process.stdout.write(`${target} matches\n`);
} else {
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, text);
  process.stdout.write(`${target}\n`);
}
