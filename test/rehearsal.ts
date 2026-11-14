/**
 * The whole of a keepers' hive on a local regtest stack, end to end, as the live test will run it:
 *
 *   1. Two keepers create their keys in the keeper console (a browser with a virtual passkey); the
 *      third keeper's key is made here. The hive's treasury is built from the three keys.
 *   2. A member chips in: the stack's wallet sends to the treasury's address.
 *   3. The channel, as members' plugins forward it to hive-api: a proposal, two keepers' ✅, and the
 *      member's node. hive-api works out the governance and writes the agent's members file.
 *   4. The member asks the `hive` model on their own MeshLLM node; the hive's agent asks a provider
 *      for a job and writes the funding request, with the escrow's terms.
 *   5. Two keepers sign the payment in their consoles through the signing desk, in turn; the desk
 *      hands it to the delegatee, and the escrow holds the cap.
 *   6. The member's requests are served and receipted; the provider claims before the deadline, and
 *      the rest returns to the treasury.
 *
 * Needs the regtest stack (arkd on 7070, the emulator on 7073), the delegatee on 7090
 * (`tools/delegatee.sh`), MeshLLM 0.79, a small GGUF model, the pay-arkade plugin and worker built,
 * and Playwright's Chromium:
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
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { startDesk } from "../tools/desk.js";
import { initHive, opsPaths } from "../tools/ops.js";
import {
  chromium,
  keeperDevice,
  openDesk,
  serveConsole,
  signFirstPayment,
} from "./support/keeper-console.js";
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

const site = await serveConsole();
const browser = await chromium.launch();
let deskServer: Awaited<ReturnType<typeof startDesk>> | null = null;
try {
  // 1. Keys, and the treasury they build.
  const a = await keeperDevice(browser, site.url, ARKD);
  const b = await keeperDevice(browser, site.url, ARKD);
  const third = secp256k1.utils.randomSecretKey();
  const keepers = [a.key, b.key, hex(secp256k1.getPublicKey(third, true))] as [string, string, string];
  const deployment = regtestDeployment();
  const record = await initHive(hive, { network: "regtest", deployment, keepers }, {});
  step("treasury built from the keepers' keys", {
    address: record.treasuryAddress,
    keepers: keepers.map((k) => k.slice(0, 10)),
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
  const channel = randomUUID();
  const buzz = [0, 1, 2].map(() => schnorr.utils.randomSecretKey());
  const [k0, k1, member] = buzz.map((k) => hex(schnorr.getPublicKey(k)));
  const deskPort = await freePort();
  const deskUrl = `http://127.0.0.1:${deskPort}`;
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
        `${k0},${k1}`,
        "--governance",
        governance,
        "--members-file",
        members,
      ],
      ...["--model", MODEL_ID, "--discussion-minutes", "1", "--desk", deskUrl, "--console", site.url],
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
    buzz[2]!,
    channel,
    9,
    await proposalText("Answers for the docs channel"),
    now() - 600,
  );
  // On a host that names its keepers itself, a member's node counts once a keeper reacts ✅ to it.
  const claim = signed(buzz[2]!, channel, 9, `Hive node: ${memberId}`, now() - 60);
  const forwarded = [
    proposal,
    signed(buzz[0]!, channel, 7, "✅", now() - 300, [["e", proposal.id]]),
    signed(buzz[1]!, channel, 7, "✅", now() - 290, [["e", proposal.id]]),
    claim,
    signed(buzz[0]!, channel, 7, "✅", now() - 50, [["e", claim.id]]),
    signed(buzz[0]!, channel, 9, `Hive keeper key: ${keepers[0]}`, now() - 900),
    signed(buzz[1]!, channel, 9, `Hive keeper key: ${keepers[1]}`, now() - 890),
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
    keepers: [k0, k1],
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

  deskServer = await startDesk(
    hive,
    {
      agentLog,
      governance,
      port: deskPort,
      tickMs: 5000,
      deadlineMarginSeconds: 60,
      minimumValiditySeconds: 60,
    },
    {},
  );
  await openDesk(b.page, deskUrl, hive);
  await openDesk(a.page, deskUrl, hive);
  step("keeper A", { console: await signFirstPayment(a.page, "Check and sign") });
  step("keeper B", { console: await signFirstPayment(b.page, "Check and sign") });
  step("keeper A again", { console: await signFirstPayment(a.page, "Finish: sign once more") });
  const jobId = String(requested.job_id);
  await until("the payment executed", () => deskServer?.desk.payment(jobId)?.status === "done", 300);
  await until("the job open on the agent", () => first(agentLog, "job_open", { job_id: jobId }), 120);
  await until("the job open on the provider", () => first(sellerLog, "job_open", { job_id: jobId }), 120);
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
  const treasuryAfter = await until(
    "the remainder back in the treasury",
    async () => {
      const held = await coins(record.treasuryScript);
      return held.includes(Number(closed.returned_sats)) ? held : null;
    },
    120,
  );
  const state = (await http(`${api}/hive/v1/state`)).body as Record<string, unknown>;
  const job = (state.jobs as { jobId: string; status: string }[]).find((j) => j.jobId === jobId);
  step("hive-api's state", { job: job?.status, treasury: treasuryAfter, desk: state.keepersDesk });
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = String(error instanceof Error ? error.stack : error);
  console.error(error);
} finally {
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  await deskServer?.close();
  for (const c of children.reverse()) c.kill("SIGTERM");
  await browser.close();
  site.close();
  console.log(result.passed ? `PASSED (${out})` : `FAILED (${out})`);
  if (result.passed) rmSync(opsPaths(hive).secret(), { recursive: true, force: true });
  process.exit(result.passed ? 0 : 1);
}
