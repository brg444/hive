import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, ScriptBuilder, sequence, xOnly } from "@hive/ark";
import { faultCode, hex } from "@hive/kit";
import mutinynetInfo from "./support/mutinynet-info.json" with { type: "json" };

const advertised = mutinynetInfo.body;
function checkpoint(delay: number, keys = [advertised.forfeitPubkey]): string {
  const script = new ScriptBuilder().addInt(sequence(delay)).addOp(0xb2).addOp(0x75);
  keys.forEach((key, i) => {
    script.addData(xOnly(key)).addOp(i + 1 === keys.length ? 0xac : 0xad);
  });
  return hex(script.script());
}
const deployment = {
  network: "regtest" as const,
  arkdUrl: "http://operator.invalid",
  delegateeUrl: "http://delegatee.invalid",
};
function connectInfo(overrides: Record<string, unknown>) {
  return connect(deployment, async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.startsWith(deployment.arkdUrl)
        ? { ...advertised, network: "regtest", unilateralExitDelay: "2048", ...overrides }
        : {
            network: "regtest",
            serverPubkey: advertised.signerPubkey,
            emulatorPubkey: advertised.signerPubkey,
            delegatePubkey: advertised.signerPubkey,
          },
  }));
}
const rejected = (error: unknown) => faultCode(error) === "DEPLOYMENT_MISMATCH";

test("connect rejects a checkpoint that matures before the advertised exit delay", async () => {
  await assert.rejects(connectInfo({ checkpointTapscript: checkpoint(1024) }), rejected);
});

test("connect binds the checkpoint to the advertised forfeit key, separately from the signer", async () => {
  await assert.rejects(connectInfo({ forfeitPubkey: advertised.signerPubkey }), rejected);
  await assert.rejects(connectInfo({ forfeitPubkey: undefined }), rejected);
  await assert.rejects(connectInfo({ forfeitPubkey: "invalid" }), rejected);
});

test("connect requires a seconds checkpoint with exactly one advertised forfeit key", async () => {
  await assert.rejects(connectInfo({ checkpointTapscript: checkpoint(10) }), rejected);
  await assert.rejects(
    connectInfo({
      checkpointTapscript: checkpoint(4096, [advertised.forfeitPubkey, advertised.signerPubkey]),
    }),
    rejected,
  );
  await assert.rejects(connectInfo({ checkpointTapscript: "51" }), rejected);
});

test("connect accepts matching checkpoints at or above the advertised exit delay", async () => {
  for (const delay of [2048, 4096]) {
    const conn = await connectInfo({ checkpointTapscript: checkpoint(delay) });
    assert.equal(conn.operator.unilateralExitDelay, 2048);
    assert.equal(conn.operator.checkpointTapscript, checkpoint(delay));
  }
});
