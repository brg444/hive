import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { repositoryRoot } from "@hive/kit";

/**
 * The package rules. A package imports only what
 * its row allows, never another package's files by relative path, and lists
 * every external import as a dependency.
 */
const ALLOWED: Record<string, string[]> = {
  kit: [],
  executor: ["@hive/kit", "@arkade-os/sdk", "@scure/base"],
  protocol: ["@hive/kit", "@noble/curves", "@noble/hashes", "@scure/btc-signer"],
  ark: ["@hive/kit", "@hive/executor", "@noble/curves", "@noble/hashes", "@scure/base", "@scure/btc-signer"],
  steward: [
    "@hive/kit",
    "@hive/protocol",
    "@hive/ark",
    "@noble/curves",
    "@noble/hashes",
    "@scure/btc-signer/musig2.js",
  ],
  hive: [
    "@hive/kit",
    "@hive/protocol",
    "@hive/ark",
    "@hive/executor",
    "@hive/steward/client",
    "@arkade-os/swap",
    "@noble/curves",
    "@noble/hashes",
    "@scure/btc-signer",
    "nostr-tools",
  ],
  provider: [
    "@hive/kit",
    "@hive/protocol",
    "@hive/ark",
    "@hive/executor",
    "@arkade-os/swap",
    "@noble/curves",
    "nostr-tools",
  ],
  agent: ["@hive/kit", "@hive/protocol", "@noble/curves"],
};

const packagesRoot = resolve(repositoryRoot, "packages");
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function imports(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [
    ...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g),
    ...text.matchAll(/import\("([^"]+)"\)/g),
  ].map((match) => match[1]!);
}

const packageOf = (specifier: string) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;

test("the package list matches the architecture table", () => {
  const present = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.deepEqual(present.sort(), Object.keys(ALLOWED).sort());
});

for (const [name, allowed] of Object.entries(ALLOWED)) {
  test(`${name} imports only what its row allows`, () => {
    const manifest = JSON.parse(readFileSync(resolve(packagesRoot, name, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const source = resolve(packagesRoot, name, "src");
    for (const file of sources(source)) {
      for (const specifier of imports(file)) {
        const where = relative(repositoryRoot, file);
        if (specifier.startsWith(".")) {
          const target = resolve(file, "..", specifier);
          // JSON contract artifacts are data, shared from the repository's contracts directories,
          // the pay-arkade escrow's among them, which keepers derive to check a funding request.
          const at = relative(repositoryRoot, target);
          if (
            target.endsWith(".json") &&
            (at.startsWith("contracts/") || at.startsWith("hive/pay-arkade/contracts/"))
          )
            continue;
          assert.ok(target.startsWith(`${source}/`), `${where} reaches outside its package: ${specifier}`);
          continue;
        }
        if (builtins.has(specifier) || specifier.startsWith("node:")) continue;
        const allowedHere = allowed.some((entry) => specifier === entry || specifier.startsWith(`${entry}/`));
        assert.ok(allowedHere, `${where} imports ${specifier}`);
        assert.ok(declared.has(packageOf(specifier)), `${where} imports undeclared ${packageOf(specifier)}`);
      }
    }
  });
}

test("only the executor imports the Arkade SDK, and it signs nothing", () => {
  for (const name of Object.keys(ALLOWED)) {
    for (const file of sources(resolve(packagesRoot, name, "src"))) {
      for (const specifier of imports(file)) {
        assert.ok(
          name === "executor" || !specifier.startsWith("@arkade-os/sdk"),
          `${relative(repositoryRoot, file)} imports ${specifier}`,
        );
      }
      // Executing a covenant spend needs no key: the Operator and the Emulator sign it.
      if (name === "executor")
        assert.ok(
          !/\.sign\(|signerSession|Identity\b|secretKey|privateKey/.test(readFileSync(file, "utf8")),
          `${relative(repositoryRoot, file)} signs`,
        );
    }
  }
});

test("the coordinator never loads a steward's signing code", () => {
  for (const file of sources(resolve(packagesRoot, "hive", "src"))) {
    for (const specifier of imports(file)) {
      assert.ok(
        !/@hive\/steward(?!\/client)/.test(specifier),
        `${relative(repositoryRoot, file)} imports ${specifier}`,
      );
    }
  }
});
