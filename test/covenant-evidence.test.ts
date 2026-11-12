import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { localPath } from "@hive/kit";
import {
  captureRejection,
  normalizeVmFailure,
  type RejectionRecord,
  requireCovenantRejection,
  type VmRejection,
} from "../gates/support/covenant.js";
import { refusalProofFixture } from "./support/refusal-evidence.js";

const records = await refusalProofFixture();
const copy = (name = "selfForgedClaim") => structuredClone(records[name]) as RejectionRecord;

test("both routes produce explicit offline signature-rejection observations", () => {
  for (const name of ["selfForgedClaim", "selfSwappedSend", "compromisedClaim", "compromisedSend"])
    assert.doesNotThrow(() => requireCovenantRejection(copy(name), "offline"));
  assert.throws(() => requireCovenantRejection(copy(), "live"), /MODEL_IS_NOT_VM_PROOF/);
});

for (const [label, mutate] of [
  [
    "missing proof",
    (r) => {
      delete r.rejection;
    },
  ],
  [
    "txid",
    (r) => {
      r.action.txid = "00".repeat(32);
    },
  ],
  [
    "action identity",
    (r) => {
      r.actionId = "00".repeat(32);
    },
  ],
  [
    "witness",
    (r) => {
      r.action.spend.inputs[0]!.covenant!.witness[0] = "00".repeat(64);
    },
  ],
  [
    "missing input",
    (r) => {
      r.after = [];
    },
  ],
  [
    "duplicate input",
    (r) => {
      r.after!.push(r.after![0]!);
    },
  ],
  [
    "input amount",
    (r) => {
      r.after![0]!.amount++;
    },
  ],
  [
    "input script",
    (r) => {
      r.after![0]!.script = "5120" + "00".repeat(32);
    },
  ],
  [
    "spent input",
    (r) => {
      r.after![0]!.isSpent = true;
    },
  ],
  [
    "model identity",
    (r) => {
      if (r.rejection?.source === "offline-model") r.rejection.actionId = "00".repeat(32);
    },
  ],
  [
    "stale proof",
    (r) => {
      if (r.rejection?.source === "offline-model") r.rejection.at = r.attemptedAt! - 1;
    },
  ],
  [
    "expired action",
    (r) => {
      r.action.validUntil = 1;
    },
  ],
  [
    "unbounded window",
    (r) => {
      r.respondedAt = r.attemptedAt! + 30_000;
    },
  ],
  [
    "service unavailable without covenant proof",
    (r) => {
      r.answer = { result: "unavailable", detail: "HTTP_503" };
      delete r.rejection;
    },
  ],
] satisfies [string, (r: RejectionRecord) => void][]) {
  test(`covenant evidence rejects ${label}`, () => {
    const r = copy();
    mutate(r);
    assert.throws(() => requireCovenantRejection(r, "offline"));
  });
}

test("a correlated VM verdict survives an opaque service error", () => {
  const r = copy();
  r.answer = { result: "unavailable", detail: "HTTP_500" };
  assert.doesNotThrow(() => requireCovenantRejection(r, "offline"));
});

test("delegatee evidence needs a new failed Emulator attempt on the fixed inputs", () => {
  for (const mutation of [
    (r: RejectionRecord) => {
      delete r.attempt;
    },
    (r: RejectionRecord) => {
      r.attempt!.outpoints = [];
    },
    (r: RejectionRecord) => {
      r.attempt!.attemptedAt = 1;
    },
    (r: RejectionRecord) => {
      r.attempt!.error = "request timed out";
    },
    (r: RejectionRecord) => {
      r.action.request!.variables.amount = "01";
    },
  ]) {
    const r = copy("compromisedClaim");
    mutation(r);
    assert.throws(() => requireCovenantRejection(r, "offline"));
  }
});

function vmRecord(): RejectionRecord & { rejection: VmRejection } {
  const r = copy();
  const at = new Date(r.attemptedAt!).toISOString();
  const line = `${at} level=error msg="failed to process transaction" error="failed to execute arkade script: signature verification failed vin=0"`;
  return {
    ...r,
    rejection: {
      source: "emulator-log",
      identity: {
        containerId: "01".repeat(32),
        image: "ghcr.io/arkade-os/emulator:v0.0.9-rc.0",
        startedAt: new Date(r.attemptedAt! - 1000).toISOString(),
      },
      previousLines: [],
      lines: [normalizeVmFailure(line)],
      since: new Date(r.attemptedAt! - 1000).toISOString(),
      until: new Date(r.respondedAt! + 1000).toISOString(),
    },
  };
}

test("one normalized VM rejection in a bounded request window passes operational correlation", () => {
  assert.doesNotThrow(() => requireCovenantRejection(vmRecord(), "live"));
});

for (const [label, mutate] of [
  [
    "no VM failure",
    (p) => {
      p.lines = [];
    },
  ],
  [
    "concurrent VM failures",
    (p) => {
      p.lines.push(p.lines[0]!);
    },
  ],
  [
    "previous VM failure",
    (p) => {
      p.previousLines = [p.lines[0]!.digest];
    },
  ],
  [
    "unrelated failure",
    (p) => {
      p.lines[0]!.reason = "other";
    },
  ],
  [
    "another input",
    (p) => {
      p.lines[0]!.vin = 1;
    },
  ],
  [
    "stale line",
    (p) => {
      p.lines[0]!.at = "2000-01-01T00:00:00.000Z";
    },
  ],
  [
    "restarted Emulator",
    (p) => {
      p.identity.startedAt = p.until;
    },
  ],
  [
    "changed window",
    (p) => {
      p.since = p.until;
    },
  ],
] satisfies [string, (p: VmRejection) => void][]) {
  test(`VM correlation rejects ${label}`, () => {
    const r = vmRecord();
    mutate(r.rejection);
    assert.throws(() => requireCovenantRejection(r, "live"));
  });
}

test("normalization retains a fixed reason and digest, with no raw log material", () => {
  const marker = "arbitrary-sensitive-log-material";
  const normalized = normalizeVmFailure(
    `2026-10-11T00:00:00.000Z msg="failed to process transaction" error="failed to execute arkade script: signature verification failed vin=0" extra="${marker}"`,
  );
  assert.equal(normalized.reason, "signature-verification");
  assert.equal(JSON.stringify(normalized).includes(marker), false);
});

test("hosted proof without logs stops before submitting", async () => {
  const r = copy();
  let submitted = false;
  await assert.rejects(
    captureRejection({
      record: r,
      mode: "mutinynet",
      observe: async () => r.before,
      submit: async () => {
        submitted = true;
        return { answer: r.answer! };
      },
    }),
    /VM_REJECTION_UNAVAILABLE/,
  );
  assert.equal(submitted, false);
});

test("capture writes prepared fixed action and inputs before posting; an HTTP error alone remains unproven", async () => {
  const r = copy();
  const directory = mkdtempSync(localPath("buzz-refusal-"));
  const path = join(directory, "record.json");
  try {
    await assert.rejects(
      captureRejection({
        record: r,
        journalPath: path,
        mode: "offline",
        observe: async () => r.before,
        model: () => [],
        submit: async () => {
          const saved = JSON.parse(readFileSync(path, "utf8")) as RejectionRecord;
          assert.equal(saved.action.txid, r.action.txid);
          assert.deepEqual(saved.before, r.before);
          assert.ok(saved.attemptedAt);
          assert.equal(saved.respondedAt, undefined);
          return { answer: { result: "unavailable", detail: "HTTP_500" } };
        },
      }),
      /VM_REJECTION_UNPROVEN/,
    );
    const saved = JSON.parse(readFileSync(path, "utf8")) as RejectionRecord;
    assert.ok(saved.respondedAt);
    assert.equal(saved.rejection, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejection evidence binds the template, variables and deliberately malformed spend", () => {
  for (const mutate of [
    (r: RejectionRecord) => {
      r.action.request!.templateId = "00".repeat(32);
    },
    (r: RejectionRecord) => {
      r.action.request!.variables.amount = "01";
    },
    (r: RejectionRecord) => {
      if (r.basis.kind === "swapped-send") r.basis.destination = r.basis.plan.destination;
    },
  ]) {
    const r = copy("selfSwappedSend");
    mutate(r);
    assert.throws(() => requireCovenantRejection(r, "offline"));
  }
  const r = copy();
  const genuine = records.genuineClaimExecution as {
    plan: { receiptSig: string; amount: number; claimSig: string };
    spend: RejectionRecord["action"]["spend"];
    txid: string;
  };
  if (r.basis.kind === "forged-claim") Object.assign(r.basis.plan, genuine.plan);
  r.action.spend = genuine.spend;
  r.action.txid = genuine.txid;
  assert.throws(() => requireCovenantRejection(r, "offline"), /TAMPER_RECEIPT_IS_VALID/);
});
