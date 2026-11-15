/**
 * The whole of a keepers' hive on a local regtest stack, end to end, as the live test will run it:
 *
 *   1. Three keepers' Buzz keys build the hive's v5 treasury: the host issues its counter, and the
 *      delegatee watches it for renewal.
 *   2. A member chips in: the stack's wallet sends to the treasury's address.
 *   3. The channel, as members' plugins forward it to hive-api: a proposal, two keepers' ✅, and the
 *      member's node. hive-api works out the governance and writes the agent's members file.
 *   4. The member asks the `hive` model on their own MeshLLM node; the hive's agent asks a provider
 *      for a job and writes the funding request, with the escrow's terms.
 *   5. Two keepers approve the payment with a message in the channel, which their Hive plugin writes
 *      once it has checked the job; the approvals desk follows the channel as hive-api keeps it, folds
 *      the chip-in into the treasury coin, pays the escrow, and the escrow holds the cap.
 *   6. The member's requests are served and receipted; the provider claims before the deadline, and
 *      the rest returns to the treasury, where the desk folds it into the treasury coin.
 *
 * Needs the regtest stack (arkd on 7070, the emulator on 7073), the delegatee on 7090
 * (`tools/delegatee.sh`), MeshLLM 0.79, a small GGUF model, and the pay-arkade plugin and worker built:
 *
 *   PAY_ARKADE_MESH=… PAY_ARKADE_MODEL=… PAY_ARKADE_DIR=… node --import tsx test/rehearsal.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { regtestDeployment } from "@hive/ark";
import { hex, localPath, repositoryRoot } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import { startApprovalDesk } from "../tools/approvals-desk.js";
import { initHive, opsPaths } from "../tools/ops.js";
import { issuerWallet } from "../tools/treasury-v5.js";
import { buzzIdentity, pluginOffers } from "./support/buzz-keepers.js";
import { sendOffchain } from "./support/treasury-sdk.js";
import {
  ARKD,
  chat as ask,
  children,
  coins,
  events,
  first,
  freePort,
  http,
  MODEL,
  meshNode,
  modelId,
  nodeId,
  now,
  PRICE,
  pluginBlock,
  proposalText,
  signed,
  until,
  WORKER,
} from "./support/mesh.js";

const PERIOD = 420; // each job's life: long enough for two keepers here, short enough to see the claim
const MODEL_ID = modelId();

const run = randomUUID().slice(0, 8);
const hive = `rehearsal-${run}`;
const out = localPath("rehearsal", run);
mkdirSync(out, { recursive: true });
const result: { steps: unknown[]; passed?: boolean; error?: string } = { steps: [] };
const step = (name: string, detail: Record<string, unknown> = {}) => {
  result.steps.push({ step: name, at: new Date().toISOString(), ...detail });
  console.log(`- ${name}${Object.keys(detail).length ? `: ${JSON.stringify(detail)}` : ""}`);
};

let deskServer: Awaited<ReturnType<typeof startApprovalDesk>> | null = null;
try {
  // 1. The keepers' Buzz keys, and the treasury they build.
  const [a, b, c] = [buzzIdentity(), buzzIdentity(), buzzIdentity()];
  const deployment = regtestDeployment();
  // The host's issuer, which issues each hive's counter, holds a few thousand sats of the host's own.
  const issuer = await issuerWallet(deployment);
  if ((await issuer.getBalance()).available < 5_000) {
    sendOffchain(await issuer.getAddress(), 20_000);
    await until("the issuer's funds", async () => (await issuer.getBalance()).available >= 5_000, 60);
  }
  const record = await initHive(
    hive,
    { network: "regtest", deployment, buzzKeepers: [a.key, b.key, c.key] },
    {},
  );
  step("treasury built from the keepers' Buzz keys", {
    address: record.treasuryAddress,
    counter: record.v5?.counter.assetId,
  });

  // 2. A chip-in, from the stack's own wallet.
  const docker = (...args: string[]) =>
    execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
  const note = docker("exec", "arkd", "arkd", "note", "--amount", "100000");
  docker("exec", "arkd", "ark", "redeem-notes", "-n", note, "--password", "secret");
  docker(
    "exec",
    "arkd",
    "ark",
    "send",
    "--to",
    record.treasuryAddress,
    "--amount",
    "60000",
    "--password",
    "secret",
  );
  await until(
    "the chip-in in the treasury",
    async () => (await coins(record.treasuryScript)).includes(60_000),
    120,
  );
  step("chip-in landed", { treasury: await coins(record.treasuryScript) });

  // 3. hive-api, the agent's files, and the channel's keepers and member.
  const agentLog = join(out, "agent.jsonl");
  const sellerLog = join(out, "seller.jsonl");
  const memberLog = join(out, "member.jsonl");
  const queue = join(out, "funding-queue.jsonl");
  const governance = join(out, "governance.json");
  const members = join(out, "members.json");
  writeFileSync(agentLog, "");
  writeFileSync(members, JSON.stringify({ members: {} }));
  const payments = join(out, "payments.json");
  const channel = randomUUID();
  const memberKey = schnorr.utils.randomSecretKey();
  const member = hex(schnorr.getPublicKey(memberKey));
  const apiPort = await freePort();
  const api = `http://127.0.0.1:${apiPort}`;
  const hiveApi = spawn(
    "node",
    [
      join(repositoryRoot, "hive/hive-buzz/api/src/server.mjs"),
      ...[
        "--name",
        "Rehearsal",
        "--agent-log",
        agentLog,
        "--treasury",
        record.treasuryAddress,
        "--operator",
        ARKD,
      ],
      ...[
        "--channel",
        channel,
        "--keepers",
        `${a.key},${b.key},${c.key}`,
        "--governance",
        governance,
        "--members-file",
        members,
      ],
      ...["--model", MODEL_ID, "--discussion-minutes", "1", "--payments", payments],
      ...["--port", String(apiPort)],
    ],
    { stdio: "ignore" },
  );
  children.push(hiveApi);
  await until("hive-api", async () => (await fetch(`${api}/healthz`)).ok, 30);

  // 4. MeshLLM: a provider, the hive's agent, and a member.
  const common = [
    "--worker",
    WORKER,
    "--model",
    MODEL_ID,
    "--close-margin-secs",
    "40",
    "--min-coin-life-secs",
    "30",
  ];
  const homes = Object.fromEntries(["provider", "agent", "member"].map((n) => [n, join(out, n)]));
  for (const h of Object.values(homes)) mkdirSync(join(h, ".mesh-llm"), { recursive: true });
  writeFileSync(
    join(homes.provider!, ".mesh-llm/config.toml"),
    pluginBlock([
      ...["--role", "seller", ...common, "--state-dir", join(out, "seller-state"), "--log", sellerLog],
      ...["--price-msat-per-mtok", String(PRICE), "--max-unreceipted-sats", "2000"],
    ]),
  );
  writeFileSync(
    join(homes.agent!, ".mesh-llm/config.toml"),
    pluginBlock([
      ...["--role", "buyer", ...common, "--state-dir", join(out, "buyer-state"), "--log", agentLog],
      ...[
        "--treasury-program",
        record.treasuryScript.slice(4),
        "--funding-queue",
        queue,
        "--cap-sats",
        "20000",
      ],
      ...[
        "--period-secs",
        String(PERIOD),
        "--max-price-msat-per-mtok",
        String(PRICE),
        "--expire-grace-secs",
        "10",
      ],
      ...["--members-file", members],
    ]),
  );
  const ports = await Promise.all([0, 1, 2, 3, 4, 5].map(() => freePort()));
  const provider = meshNode(homes.provider!, join(out, "provider-node.log"), [
    ...["--gguf", MODEL, "--port", String(ports[0]), "--console", String(ports[1])],
  ]);
  await until("seller terms", () => first(sellerLog, "terms_published"), 240);
  const invite = await provider.invite();
  const agent = meshNode(homes.agent!, join(out, "agent-node.log"), [
    ...["--join", invite, "--port", String(ports[2]), "--console", String(ports[3])],
  ]);
  const agentId = nodeId(await agent.invite());
  writeFileSync(
    join(homes.member!, ".mesh-llm/config.toml"),
    pluginBlock(["--role", "member", "--agent", agentId, "--log", memberLog], false),
  );
  const memberNode = meshNode(homes.member!, join(out, "member-node.log"), [
    ...["--join", invite, "--port", String(ports[4]), "--console", String(ports[5])],
  ]);
  const memberId = nodeId(await memberNode.invite());
  const memberApi = `http://127.0.0.1:${ports[4]}/v1`;
  await until(
    "the hive model on the member's node",
    async () =>
      ((await http(`${memberApi}/models`)).body.data as { id: string }[])?.some((m) => m.id === "hive"),
    180,
  );
  step("MeshLLM nodes up", { agent: agentId.slice(0, 12), member: memberId.slice(0, 12) });

  // The channel: a proposal from the member, two keepers' ✅ after its discussion, the member's node and a keeper's ✅ on it.
  const proposal = signed(
    memberKey,
    channel,
    9,
    await proposalText("Answers for the docs channel"),
    now() - 600,
  );
  // On a host that names its keepers itself, a member's node counts once a keeper reacts ✅ to it.
  const claim = signed(memberKey, channel, 9, `Hive node: ${memberId}`, now() - 60);
  const forwarded: unknown[] = [
    proposal,
    signed(a.secret, channel, 7, "✅", now() - 300, [["e", proposal.id]]),
    signed(b.secret, channel, 7, "✅", now() - 290, [["e", proposal.id]]),
    claim,
    signed(a.secret, channel, 7, "✅", now() - 50, [["e", claim.id]]),
  ];
  const posted = await http(`${api}/hive/v1/channel`, { events: forwarded });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const gov = JSON.parse(readFileSync(governance, "utf8"));
  assert.equal(gov.proposals[0].state, "running");
  const allowed = JSON.parse(readFileSync(members, "utf8")).members[memberId];
  assert.equal(allowed?.allowance_sats_per_day, 2000);
  step("channel forwarded: proposal approved, member allowed", {
    proposal: gov.proposals[0].id,
    member,
    keepers: [a.key, b.key, c.key],
  });

  // 5. The member asks; the agent asks a provider; the keepers sign.
  const chat = () => ask(memberApi);
  const firstAsk = await chat();
  step("first request: no job yet", { status: firstAsk.status });
  const requested = await until(
    "a funding request with the escrow's terms",
    () => {
      const e = first(agentLog, "funding_requested");
      return e && (e.request as { params?: unknown }).params ? (e.request as Record<string, unknown>) : null;
    },
    120,
  );
  step("funding requested", { job: String(requested.job_id).slice(0, 12), cap: requested.cap_sats });

  // The desk follows the channel as hive-api keeps it, and writes its payments for hive-api to serve.
  deskServer = await startApprovalDesk(hive, {
    agentLog,
    governance,
    events: `${governance}.events.json`,
    paymentsFile: payments,
    tickMs: 5000,
    deadlineMarginSeconds: 60,
    minimumValiditySeconds: 60,
  });
  const jobId = String(requested.job_id);
  await until("the job's payment at the desk", () => deskServer?.desk.payment(jobId), 60);
  // Each keeper's plugin checks the job and writes the approval; they send it in the channel.
  for (const [label, keeper] of [
    ["keeper A", a],
    ["keeper B", b],
  ] as const) {
    const offer = await until(
      `${label}'s plugin offering the approval`,
      async () => {
        const o = await pluginOffers(api, "", keeper, channel, { own: true });
        return o.approvals.length ? o : null;
      },
      60,
    );
    assert.deepEqual(offer.refused, []);
    forwarded.push(keeper.message(channel, offer.approvals[0]!));
    const sent = await http(`${api}/hive/v1/channel`, { events: forwarded });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    step(label, { approval: offer.approvals[0]!.slice(0, 32) });
  }
  await until("the payment executed", () => deskServer?.desk.payment(jobId)?.status === "done", 300);
  await until("the job open on the agent", () => first(agentLog, "job_open", { job_id: jobId }), 120);
  await until("the job open on the provider", () => first(sellerLog, "job_open", { job_id: jobId }), 120);
  const fundedTreasury = (await coins(record.treasuryScript)).reduce((n, v) => n + v, 0);
  step("escrow funded and job open", { treasury: await coins(record.treasuryScript) });

  // 6. Work, receipts, and the claim.
  const served: number[] = [];
  for (let i = 0; i < 3; i++) served.push((await chat()).status);
  assert.deepEqual(served, [200, 200, 200]);
  step("member's requests served", { statuses: served });
  const closed = await until(
    "the provider's claim",
    () => events(agentLog).find((e) => e.event === "job_closed" && e.job_id === jobId && e.txid),
    PERIOD + 180,
  );
  step("provider claimed", { paid: closed.paid_sats, returned: closed.returned_sats });
  // The remainder lands beside the treasury coin, and the desk folds it in: the total is what counts.
  const treasuryAfter = await until(
    "the remainder back in the treasury",
    async () => {
      const held = await coins(record.treasuryScript);
      return held.reduce((n, v) => n + v, 0) >= fundedTreasury + Number(closed.returned_sats) ? held : null;
    },
    120,
  );
  const state = (await http(`${api}/hive/v1/state`)).body as Record<string, unknown>;
  const job = (state.jobs as { jobId: string; status: string }[]).find((j) => j.jobId === jobId);
  step("hive-api's state", {
    job: job?.status,
    treasury: treasuryAfter,
    payments: (state.payments as { payments?: unknown[] } | null)?.payments?.length,
  });
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = String(error instanceof Error ? error.stack : error);
  console.error(error);
} finally {
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  deskServer?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
  console.log(result.passed ? `PASSED (${out})` : `FAILED (${out})`);
  if (result.passed) rmSync(opsPaths(hive).secret(), { recursive: true, force: true });
  process.exit(result.passed ? 0 : 1);
}
