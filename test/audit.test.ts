import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Hex, unhex } from "@hive/kit";
import { auditRun } from "../tools/audit.js";
import { refusalProofFixture } from "./support/refusal-evidence.js";

const refusalProofs = await refusalProofFixture();

// biome-ignore lint/suspicious/noExplicitAny: copies of public JSON evidence are deliberately corrupted below.
type Evidence = Record<string, any>;
const fixtures = new URL("./fixtures/v4-evidence/", import.meta.url);
const directories = readdirSync(fixtures).sort();

function fixture(suite: string, prefix = "2026-10-11"): Evidence {
  const directory = directories
    .filter((d) => d.startsWith(prefix))
    .reverse()
    .find((d) => readdirSync(new URL(`${d}/`, fixtures)).includes(`${suite}.json`));
  assert.ok(directory);
  return JSON.parse(readFileSync(new URL(`${directory}/${suite}.json`, fixtures), "utf8"));
}

function copiedAudit(suite: string, evidence: Evidence, funded = false) {
  const directory = mkdtempSync(join(tmpdir(), "buzz-audit-"));
  try {
    writeFileSync(join(directory, `${suite}.json`), JSON.stringify(evidence));
    return auditRun(directory, { funded });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function current(suite: string): Evidence {
  const evidence: Evidence = { ...fixture(suite), schemaVersion: 2 };
  if (suite === "refusals") {
    evidence.status = "offline-smoke";
    Object.assign(evidence.results, structuredClone(refusalProofs));
    evidence.expectedPaidSats = evidence.results.providerPaid;
  }
  if (suite === "renewal")
    for (const r of evidence.renewals) {
      r.renewed.script = r.script;
      r.renewed.commitmentTxids = [r.commitmentTxid];
    }
  return evidence;
}

test("all eight historical development runs audit under their legacy versions", () => {
  for (const directory of directories) {
    const file = readdirSync(new URL(`${directory}/`, fixtures))[0]!;
    const evidence = JSON.parse(readFileSync(new URL(`${directory}/${file}`, fixtures), "utf8"));
    assert.deepEqual(
      copiedAudit(file.slice(0, -5), evidence).checks.filter((c) => !c.ok),
      [],
    );
  }
});

for (const suite of ["lifecycle", "refusals", "renewal"]) {
  test(`${suite}: complete versioned evidence passes`, () => {
    assert.deepEqual(
      copiedAudit(suite, current(suite)).checks.filter((c) => !c.ok),
      [],
    );
  });
  test(`${suite}: unsupported evidence versions fail`, () => {
    assert.ok(copiedAudit(suite, { ...fixture(suite), schemaVersion: 999 }).checks.some((c) => !c.ok));
  });
  test(`${suite}: an unknown unversioned producer cannot select a legacy schema`, () => {
    const evidence = fixture(suite);
    evidence.sourceSha256[`gates/${suite}.ts`] = "00".repeat(32);
    assert.ok(copiedAudit(suite, evidence).checks.some((c) => !c.ok));
  });
}

for (const field of ["withdrawal", "sweep"]) {
  test(`lifecycle: ${field} status cannot hide a changed txid`, () => {
    const evidence = current("lifecycle");
    evidence[field][0].status = "registered";
    evidence[field][0].txid = "00".repeat(32);
    const checks = copiedAudit("lifecycle", evidence).checks;
    assert.ok(checks.some((c) => !c.ok && c.name.includes("transaction is the one its attestations build")));
  });
  test(`lifecycle: ${field} must be present and complete`, () => {
    const incomplete = current("lifecycle");
    incomplete[field][0].status = "registered";
    assert.ok(copiedAudit("lifecycle", incomplete).checks.some((c) => !c.ok));
    const missing = current("lifecycle");
    missing[field] = [];
    assert.ok(copiedAudit("lifecycle", missing).checks.some((c) => !c.ok));
  });
}

test("lifecycle: funding authority cannot be removed from a completed payment", () => {
  const evidence = current("lifecycle");
  evidence.fundings.paid[0].request = null;
  evidence.fundings.paid[0].txid = "00".repeat(32);
  assert.ok(copiedAudit("lifecycle", evidence).checks.some((c) => !c.ok));
});

test("lifecycle: a claim txid must equal the reconstruction, even at the same length", () => {
  const evidence = current("lifecycle");
  evidence.claim.txid = "00".repeat(32);
  assert.ok(
    copiedAudit("lifecycle", evidence).checks.some(
      (c) =>
        !c.ok && c.name === "the claim transaction is the one the receipt and the provider's signature build",
    ),
  );
});

test("lifecycle: a changed claim amount fails receipt, authorization and reconstruction checks", () => {
  const evidence = current("lifecycle");
  evidence.claim.amountSats += 1;
  const failed = copiedAudit("lifecycle", evidence).checks.filter((c) => !c.ok);
  assert.ok(failed.some((c) => c.name === "the claim is the receipt's amount"));
  assert.ok(failed.some((c) => c.name.includes("claim signature verifies")));
  assert.ok(failed.some((c) => c.name.includes("claim transaction is the one")));
});

test("refusals: every required case is mandatory", () => {
  const empty = current("refusals");
  empty.checks = {};
  assert.ok(copiedAudit("refusals", empty).checks.some((c) => !c.ok));
  const missing = current("refusals");
  delete missing.checks.selfForgedClaim;
  assert.ok(copiedAudit("refusals", missing).checks.some((c) => !c.ok));
});

test("renewal: both accounts must have a complete renewal", () => {
  for (const length of [0, 1]) {
    const evidence = current("renewal");
    evidence.renewals.length = length;
    assert.ok(copiedAudit("renewal", evidence).checks.some((c) => !c.ok));
  }
  const duplicate = current("renewal");
  duplicate.renewals[1] = structuredClone(duplicate.renewals[0]);
  assert.ok(copiedAudit("renewal", duplicate).checks.some((c) => !c.ok));
  const missingOutput = current("renewal");
  delete missingOutput.renewals[0].renewed.outpoint;
  assert.ok(copiedAudit("renewal", missingOutput).checks.some((c) => !c.ok));
});

test("lifecycle: a retired unsigned predecessor needs a complete non-payment observation", () => {
  const evidence = current("lifecycle");
  const retired = structuredClone(evidence.fundings.paid[0]);
  retired.status = "expired";
  retired.txid = null;
  retired.arkTxid = null;
  retired.request = null;
  retired.attestations = null;
  retired.plan.coins[0].txid = "ab".repeat(32);
  retired.outcome = {
    observedAt: retired.plan.validUntil + 1,
    inputs: retired.plan.coins.map((coin: Evidence) => ({
      ...coin,
      isSpent: false,
      isSwept: false,
      arkTxid: "",
      spentBy: "",
      settledBy: "",
    })),
  };
  evidence.fundings.paid.unshift(retired);
  assert.deepEqual(
    copiedAudit("lifecycle", evidence).checks.filter((c) => !c.ok),
    [],
  );
  delete retired.outcome;
  assert.ok(copiedAudit("lifecycle", evidence).checks.some((c) => !c.ok));
});

test("lifecycle: completed inference and replay cases cannot be omitted", () => {
  for (const field of ["inferences", "replay"]) {
    const evidence = current("lifecycle");
    delete evidence[field];
    assert.ok(copiedAudit("lifecycle", evidence).checks.some((c) => !c.ok));
  }
});

test("lifecycle: a reported cash-out requires its funding authority and settlement transaction", () => {
  const evidence = current("lifecycle");
  const preimage = "01".repeat(32);
  evidence.cashout = {
    invoiceSats: 1000,
    fundAmount: 1000,
    paymentHash: sha256Hex(unhex(preimage)),
    funding: { txid: "00".repeat(32) },
    settlement: { preimage },
  };
  evidence.balances.treasurySats -= 1000;
  assert.ok(copiedAudit("lifecycle", evidence).checks.some((c) => !c.ok));
});

for (const error of ["no attempt", "500 internal error", "request timed out"]) {
  test(`refusals: ${error} cannot prove covenant rejection`, () => {
    const evidence = current("refusals");
    evidence.results.compromisedClaim = { status: "active", success: false, error, txid: "" };
    assert.ok(copiedAudit("refusals", evidence).checks.some((c) => !c.ok));
  });
}

test("refusals: recorded policy checks must follow the observations", () => {
  const evidence = current("refusals");
  evidence.results.unapprovedQuote = "accepted";
  assert.ok(copiedAudit("refusals", evidence).checks.some((c) => !c.ok));
});

test("legacy development refusals cannot qualify as current funded VM proof", () => {
  assert.ok(copiedAudit("refusals", fixture("refusals"), true).checks.some((c) => !c.ok));
});

test("refusals: genuine payout needs its exact reconstructed output index", () => {
  const evidence = current("refusals");
  evidence.results.genuineClaimExecution.outputs[0].vout++;
  assert.ok(copiedAudit("refusals", evidence).checks.some((c) => !c.ok));
});
