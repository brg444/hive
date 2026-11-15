/**
 * A hive on the shared Hive service, on a local regtest stack, with its keepers approving payments
 * from Buzz: HiveBot asks for the hive and the operator approves it; once HiveBot's message names the
 * three keepers, the service builds the v5 treasury from their Buzz keys, its counter issued by the
 * host's issuer and its renewal watched by the delegatee. A member chips in and a proposal is
 * approved in the channel. The hive's agent asks for a job, and each keeper's Hive plugin, the one
 * `plugin/build.mjs` builds, checks the job against its escrow's own terms and writes the approval;
 * two keepers send it in the channel, hours apart if they like, and the desk pays the escrow. A
 * keeper asks for a withdrawal in the channel, and two keepers approve it the same way. A message
 * that says more than the approval, or one from a member who is no keeper, pays nothing.
 *
 * Needs the regtest stack (arkd on 7070, the Emulator on 7073) and the delegatee on 7090
 * (`tools/delegatee.sh`):
 *
 *   node --experimental-eventsource --import tsx test/buzz-approvals-e2e.ts
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, rmSync } from "node:fs";
import { connect, jobEscrow, regtestDeployment } from "@hive/ark";
import { treasuryCoins, unitsOn } from "@hive/executor";
import { hex, localPath } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import { opsPaths } from "../tools/ops.js";
import { hiveIdFor, startService } from "../tools/service.js";
import { issuerWallet, v5Contract, v5Terms } from "../tools/treasury-v5.js";
import { buzzIdentity, pluginOffers, type BuzzEvent } from "./support/buzz-keepers.js";
import { http, now, proposalText, signed, until } from "./support/mesh.js";
import { newWallet, sendOffchain, waitFor } from "./support/treasury-sdk.js";

const deployment = regtestDeployment();
const COMMUNITY = "wss://buzz-approvals";
const step = (name: string, detail: Record<string, unknown> = {}) =>
  console.log(`- ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
const root = localPath("buzz-approvals-e2e", randomUUID().slice(0, 8));
const running = await startService({
  network: "regtest",
  deployment,
  publicUrl: "https://hive.example.org",
  discussionSeconds: 5,
  root,
  desk: { deadlineMarginSeconds: 60, minimumValiditySeconds: 60 },
});
const service = running.url;
const channel = randomUUID();
const hive = hiveIdFor(channel);
const [a, b, c] = [buzzIdentity(), buzzIdentity(), buzzIdentity()];
const member = buzzIdentity();
const bot = schnorr.utils.randomSecretKey();
const sent: unknown[] = [];
/** Members' plugins forward the channel to the service as its messages arrive. */
const forward = async (...more: unknown[]) => {
  sent.push(...more);
  const r = await http(`${service}/c/${channel}/hive/v1/channel`, { events: sent }, 600_000);
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
const desk = () => running.service.desk(running.service.registration(channel));
/** The desk's rounds run every minute on the service; here, as often as the test needs. */
const round = async () => {
  await running.service.sweep();
};

try {
  // 1. HiveBot asks for the hive, the operator approves it, and HiveBot names the keepers.
  const call = signed(bot, channel, 9, "Hi, I'm Hive bot.", now() - 600, [["hive", "call"]]);
  const asked = await http(`${service}/hives`, {
    channelId: channel,
    community: COMMUNITY,
    name: "Approvals Lab",
    call,
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  await running.service.approve(hive, hex(schnorr.getPublicKey(bot)));
  const issuer = await issuerWallet(deployment);
  if ((await issuer.getBalance()).available < 5_000) {
    sendOffchain(await issuer.getAddress(), 20_000);
    await waitFor("the host's issuer funds", async () => (await issuer.getBalance()).available >= 5_000);
  }
  await forward(
    call,
    signed(bot, channel, 9, "Keepers are set.", now() - 500, [
      ["hive", "plugin"],
      ...[a, b, c].map((k) => ["p", k.key]),
    ]),
  );
  const record = await until("the treasury", async () => running.service.record(hive) ?? null, 120);
  assert.deepEqual(
    record.v5?.keepers,
    [a.key, b.key, c.key],
    "built from the keepers' Buzz keys, in HiveBot's order",
  );
  const counter = record.v5!.counter;
  step("treasury built from the keepers' Buzz keys", {
    address: record.treasuryAddress,
    counter: counter.assetId,
  });

  // 2. A member chips in; a proposal is approved after its short discussion.
  sendOffchain(record.treasuryAddress, 60_000);
  const { contract } = await v5Contract(deployment, v5Terms(record.v5!));
  await waitFor(
    "the chip-in",
    async () => (await treasuryCoins(contract, counter.assetId)).others.length > 0,
  );
  const proposal = signed(member.secret, channel, 9, await proposalText("Docs answers"), now() - 120);
  await forward(
    proposal,
    signed(a.secret, channel, 7, "✅", now() - 60, [["e", proposal.id]]),
    signed(b.secret, channel, 7, "✅", now() - 50, [["e", proposal.id]]),
  );
  const governance = await until(
    "the proposal approved",
    async () => {
      const s = (await http(`${service}/c/${channel}/hive/v1/state`)).body as {
        governance?: { proposals?: { state: string }[] };
      };
      return s.governance?.proposals?.some((p) => ["approved", "running"].includes(p.state))
        ? s.governance
        : null;
    },
    60,
  );
  step("chip-in landed and proposal approved", { proposals: governance.proposals!.length });

  // 3. The hive's agent asks for a job; the desk makes it a payment.
  const conn = await connect(deployment);
  const jobId = hex(randomBytes(32));
  const deadline = now() + 3600;
  const params = {
    agentPk: hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
    providerPk: hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
    treasuryProgram: record.treasuryScript.slice(4),
    deadline,
    jobId,
  };
  const escrow = jobEscrow(conn, params);
  appendFileSync(
    running.service.files(hive).agentLog,
    `${JSON.stringify({
      event: "funding_requested",
      at: now(),
      request: {
        job_id: jobId,
        address: escrow.address,
        cap_sats: 20_000,
        deadline,
        model: "hive-test",
        price_msat_per_mtok: 1_000_000,
        provider_pk: params.providerPk,
        provider_peer: "peer",
        params,
      },
    })}\n`,
  );
  await until(
    "the job's payment",
    async () => {
      await round();
      return (await desk()).payment(jobId) ?? null;
    },
    60,
  );

  // 4. Each keeper's plugin checks the job and writes the approval; two keepers send it.
  const offerA = await pluginOffers(service, COMMUNITY, a, channel);
  assert.deepEqual(offerA.refused, [], "the job checks out against its escrow's own terms");
  assert.equal(offerA.approvals.length, 1, offerA.html);
  const approval = offerA.approvals[0]!;
  // A message that says more than the approval, and the approval from a member who is no keeper, pay nothing.
  await forward(a.message(channel, `${approval} 👍`), member.message(channel, approval));
  await round();
  assert.deepEqual((await desk()).payment(jobId)?.approvals.map(Boolean), [false, false, false]);
  await forward(a.message(channel, approval));
  await round();
  assert.equal((await desk()).payment(jobId)?.status, "approving", "one keeper pays nothing");
  const offerB = await pluginOffers(service, COMMUNITY, b, channel);
  assert.deepEqual(offerB.approvals, [approval], "the other keeper's plugin works out the same approval");
  assert.deepEqual(
    (await pluginOffers(service, COMMUNITY, a, channel)).approvals,
    [],
    "nothing left for the keeper who approved",
  );
  await forward(b.message(channel, approval));
  await until(
    "the job funded",
    async () => {
      await round();
      return (await desk()).payment(jobId)?.status === "done";
    },
    180,
  );
  const funded = await waitFor("the escrow's coin", async () => {
    const coins = await conn.arkd.coins({ scripts: [escrow.pkScript], spendableOnly: true });
    return coins.find((coin) => coin.amount === 20_000);
  });
  step("two keepers approved in the channel, and the escrow is funded", {
    txid: (await desk()).payment(jobId)?.txid,
    amount: funded.amount,
  });

  // 5. A keeper asks for a withdrawal in the channel; two keepers approve it from their plugins.
  const wallet = await newWallet(deployment.arkdUrl, deployment.emulatorUrl!);
  const asking: BuzzEvent = c.message(channel, `Hive withdrawal: 5,000 sats to ${await wallet.getAddress()}`);
  await forward(asking);
  await until(
    "the withdrawal's payment",
    async () => {
      await round();
      return (await desk()).payment(asking.id) ?? null;
    },
    60,
  );
  for (const k of [c, a]) {
    const offer = await pluginOffers(service, COMMUNITY, k, channel);
    assert.equal(offer.approvals.length, 1, offer.html);
    await forward(k.message(channel, offer.approvals[0]!));
  }
  await until(
    "the withdrawal paid",
    async () => {
      await round();
      return (await wallet.getBalance()).available >= 5_000;
    },
    180,
  );
  const coin = (await treasuryCoins(contract, counter.assetId)).treasury!;
  assert.equal(unitsOn(coin, counter.assetId), BigInt(record.v5!.supply) - 2n, "two payments, two units");
  step("withdrawal approved in the channel and paid", {
    treasury: coin.value,
    units: String(unitsOn(coin, counter.assetId)),
  });
  console.log("PASSED");
} finally {
  await running.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(opsPaths(hive).secret(), { recursive: true, force: true });
}
process.exit(0);
