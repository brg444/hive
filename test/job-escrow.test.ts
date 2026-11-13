import assert from "node:assert/strict";
import { test } from "node:test";
import { type JobEscrowParams, jobEscrow } from "@hive/ark";

/**
 * The pay-arkade escrow derived here must be the one the MeshLLM plugin's worker derives with the
 * Arkade SDK, or keepers would refuse every real job. These addresses came from the worker's
 * `escrow` op on a regtest Operator with the keys below.
 */
const conn = {
  deployment: { network: "regtest" as const },
  keys: {
    server: "02e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdb",
    emulator: "02999413c46fa10ada5cbc4bcc79a1d09160c2ba3cfc812705d7a13e5e545fb2a9",
  },
  operator: { unilateralExitDelay: 5 },
};
const K = [
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
  "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
  "e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
];
const base: JobEscrowParams = {
  agentPk: K[0]!,
  providerPk: K[1]!,
  treasuryProgram: K[2]!,
  deadline: 1794600000,
  jobId: "ab".repeat(32),
};
const vectors: [JobEscrowParams, string][] = [
  [base, "5120b6fda17fdcdf3ca34bf912565ea8c35cc314c6958f1f935a6671015e4b7e11af"],
  [{ ...base, delegatePk: K[3]! }, "5120017dc2c0a05dba610317b97e806dffb52da20b6e911f0c28434bf3eeb2de02d5"],
  [
    { ...base, renewalWindow: 7200, maxRenewalFee: 250, deadline: 1800000000, jobId: "0c".repeat(32) },
    "5120e28a75c6aa0aad3b9732fce7a5ab97a0205db092a2c67c3a9c1692bd0a6efb7e",
  ],
  [
    { ...base, agentPk: K[3]!, providerPk: K[0]!, deadline: 600 },
    "512073c2fd205a6fe6ff99c682c2289b4cf2e5772df018972dc140b0d5b32360618b",
  ],
];

test("the job escrow derives exactly as the pay-arkade worker derives it", () => {
  for (const [params, pkScript] of vectors) assert.equal(jobEscrow(conn, params).pkScript, pkScript);
  assert.equal(
    jobEscrow(conn, base).address,
    "tark1qr340xg400jtxat9hdd0ungyu6s05zjtdf85uj9smyzxshf98ndahdha59laeheu5d9ljyjkt65vxhxrznrftrcljddxvugpte9huyd0frzaq0",
  );
});

test("the job escrow refuses malformed terms", () => {
  for (const bad of [
    { ...base, agentPk: `02${K[0]}` },
    { ...base, jobId: "ab" },
    { ...base, deadline: 0 },
    { ...base, renewalWindow: -1 },
  ])
    assert.throws(() => jobEscrow(conn, bad));
});
