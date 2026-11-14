/**
 * Two hives on one shared Hive service, on a local regtest stack, end to end as the pilot runs them:
 * the first uses the agent node the service runs for it, the second brings its own node and links it
 * to the service.
 *
 *   1. HiveBot asks the service for each hive; the service's operator approves both.
 *   2. Each hive's keepers create their keys in the keeper console (a browser with a virtual passkey)
 *      and post them in the channel; members' plugins forward the channel, and the service builds
 *      each treasury by itself once the third key is in.
 *   3. The first hive's agent starts on the service. For the second, a keeper names the community's
 *      own node in the channel, and the node's worker links it to the service.
 *   4. A member chips in to each treasury; a proposal is approved in each channel, and each member's
 *      node is acknowledged by HiveBot.
 *   5. Each member asks the `hive` model; each agent asks the provider for a job; two keepers of each
 *      hive sign its payment at the hive's desk on the service, and the escrows hold the cap.
 *   6. The provider claims each job before its deadline, and the rest returns to each treasury.
 *
 * Needs what `test/rehearsal.ts` needs:
 *
 *   PAY_ARKADE_MESH=… PAY_ARKADE_MODEL=… PAY_ARKADE_DIR=… node --import tsx test/rehearsal-service.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { regtestDeployment } from "@hive/ark";
import { hex, localPath } from "@hive/kit";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { MeshAgents } from "../tools/agents.js";
import { opsPaths } from "../tools/ops.js";
import { hiveIdFor, startService } from "../tools/service.js";
import {
  chromium,
  keeperDevice,
  openDesk,
  type Page,
  serveConsole,
  signFirstPayment,
} from "./support/keeper-console.js";
import {
  ARKD,
  chat,
  children,
  coins,
  events,
  first,
  freePort,
  http,
  MESH,
  MODEL,
  meshNode,
  modelId,
  nodeId,
  now,
  PLUGIN,
  PRICE,
  pluginBlock,
  proposalText,
  signed,
  until,
  WORKER,
} from "./support/mesh.js";

const PERIOD = 480; // each job's life: long enough for two keepers of each hive, short enough to see the claims
const MODEL_ID = modelId();
const run = randomUUID().slice(0, 8);
const out = localPath("rehearsal", `service-${run}`);
mkdirSync(out, { recursive: true });
const result: { steps: unknown[]; passed?: boolean; error?: string } = { steps: [] };
const step = (name: string, detail: Record<string, unknown> = {}) => {
  result.steps.push({ step: name, at: new Date().toISOString(), ...detail });
  console.log(`- ${name}${Object.keys(detail).length ? `: ${JSON.stringify(detail)}` : ""}`);
};
/** Terms both agents buy with, short enough for a rehearsal. */
const BUYER_TERMS = [
  ...["--close-margin-secs", "40", "--min-coin-life-secs", "30"],
  ...["--max-price-msat-per-mtok", String(PRICE), "--expire-grace-secs", "10"],
];

interface Hive {
  name: string;
  own: boolean;
  channel: string;
  hive: string;
  bot: Uint8Array;
  buzz: Uint8Array[]; // three keepers' Buzz keys, then the member's
  devices: { key: string; page: Page }[];
  keys: [string, string, string];
  sent: unknown[];
  treasury?: { address: string; script: string };
  agentLog?: string;
  agentId?: string;
  memberId?: string;
  memberApi?: string;
  jobId?: string;
}

const port = await freePort();
const service = `http://127.0.0.1:${port}`;
const site = await serveConsole();
const browser = await chromium.launch();
const agents = new MeshAgents({
  mesh: MESH,
  plugin: PLUGIN,
  worker: WORKER,
  model: MODEL_ID,
  capSats: 20_000,
  periodSecs: PERIOD,
  extra: BUYER_TERMS,
});
const root = join(out, "service");
const server = await startService({
  network: "regtest",
  deployment: regtestDeployment(),
  publicUrl: service,
  consoleUrl: site.url,
  discussionSeconds: 60,
  agents,
  serveInvite: true,
  root,
  port,
  host: "127.0.0.1",
  desk: { deadlineMarginSeconds: 60, minimumValiditySeconds: 60 },
});
const hives: Hive[] = [];
try {
  // 1. HiveBot asks for each hive, and the operator approves it.
  for (const [name, own] of [
    ["Hosted Lab", false],
    ["Own Node Lab", true],
  ] as const) {
    const channel = randomUUID();
    const bot = schnorr.utils.randomSecretKey();
    const call = signed(bot, channel, 9, "Hi, I'm Hive bot.", now() - 1200, [["hive", "call"]]);
    const asked = await http(`${service}/hives`, {
      channelId: channel,
      community: "wss://rehearsal",
      name,
      call,
    });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    await server.service.approve(hiveIdFor(channel), hex(schnorr.getPublicKey(bot)));
    const devices = [
      await keeperDevice(browser, site.url, ARKD),
      await keeperDevice(browser, site.url, ARKD),
    ];
    const third = secp256k1.utils.randomSecretKey();
    hives.push({
      name,
      own,
      channel,
      hive: hiveIdFor(channel),
      bot,
      buzz: [0, 1, 2, 3].map(() => schnorr.utils.randomSecretKey()),
      devices,
      keys: [devices[0]!.key, devices[1]!.key, hex(secp256k1.getPublicKey(third, true))],
      sent: [call],
    });
  }
  step("two hives asked for and approved", { hives: hives.map((h) => h.hive) });

  const forward = async (h: Hive, more: unknown[]) => {
    h.sent.push(...more);
    const posted = await http(`${service}/c/${h.channel}/hive/v1/channel`, { events: h.sent });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    return http(`${service}/c/${h.channel}/hive/v1/state`).then((r) => r.body);
  };
  const pub = (k: Uint8Array) => hex(schnorr.getPublicKey(k));

  // 2. The keepers HiveBot records, their keys in the channel, and the treasury the service builds.
  for (const h of hives) {
    await forward(h, [
      signed(h.bot, h.channel, 9, "Keepers are set.", now() - 1100, [
        ["hive", "plugin"],
        ...h.buzz.slice(0, 3).map((k) => ["p", pub(k)]),
      ]),
      ...h.buzz
        .slice(0, 3)
        .map((k, i) => signed(k, h.channel, 9, `Hive keeper key: ${h.keys[i]}`, now() - 1000 + i)),
    ]);
    const state = await until(
      `${h.name}'s treasury`,
      async () => {
        const s = (await http(`${service}/c/${h.channel}/hive/v1/state`)).body;
        return (s.treasury as { address?: string } | null)?.address ? s : null;
      },
      60,
    );
    const record = server.service.record(h.hive)!;
    h.treasury = { address: record.treasuryAddress, script: record.treasuryScript };
    assert.equal((state.treasury as { address: string }).address, h.treasury.address);
  }
  step("treasuries built from the keepers' keys", {
    treasuries: hives.map((h) => h.treasury!.address.slice(0, 20)),
  });

  // 3. The hosted agent starts on the service; the provider joins its mesh, and so does the
  // community's own agent node, linked to the service once a keeper names it.
  const [hosted, own] = hives as [Hive, Hive];
  const hostedInvite = await until(
    "the hosted agent's invite",
    async () => {
      const r = await http(`${service}/c/${hosted.channel}/hive/v1/invite`);
      return r.status === 200 ? String(r.body).trim() : null;
    },
    180,
  );
  hosted.agentId = nodeId(hostedInvite);
  hosted.agentLog = server.service.files(hosted.hive).agentLog;
  const sellerLog = join(out, "seller.jsonl");
  const ports = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(() => freePort()));
  const home = (n: string) => join(out, n);
  mkdirSync(join(home("provider"), ".mesh-llm"), { recursive: true });
  writeFileSync(
    join(home("provider"), ".mesh-llm/config.toml"),
    pluginBlock([
      ...["--role", "seller", "--worker", WORKER, "--model", MODEL_ID],
      ...["--close-margin-secs", "40", "--min-coin-life-secs", "30"],
      ...["--state-dir", join(out, "seller-state"), "--log", sellerLog],
      ...["--price-msat-per-mtok", String(PRICE), "--max-unreceipted-sats", "2000"],
    ]),
  );
  meshNode(home("provider"), join(out, "provider-node.log"), [
    ...["--join", hostedInvite, "--gguf", MODEL, "--port", String(ports[0]), "--console", String(ports[1])],
  ]);
  await until("seller terms", () => first(sellerLog, "terms_published"), 240);

  own.agentLog = join(out, "own-agent.jsonl");
  const ownMembers = join(out, "own-members.json");
  const ownState = join(out, "own-buyer-state");
  mkdirSync(ownState, { recursive: true });
  const ownSecret = schnorr.utils.randomSecretKey();
  writeFileSync(join(ownState, "key"), `${hex(ownSecret)}\n`, { mode: 0o600 });
  writeFileSync(own.agentLog, "");
  writeFileSync(ownMembers, JSON.stringify({ members: {} }));
  mkdirSync(join(home("own-agent"), ".mesh-llm"), { recursive: true });
  writeFileSync(
    join(home("own-agent"), ".mesh-llm/config.toml"),
    pluginBlock([
      ...["--role", "buyer", "--worker", WORKER, "--model", MODEL_ID, ...BUYER_TERMS],
      ...["--state-dir", ownState, "--log", own.agentLog, "--members-file", ownMembers],
      ...[
        "--treasury-program",
        own.treasury!.script.slice(4),
        "--funding-queue",
        join(out, "own-queue.jsonl"),
      ],
      ...["--cap-sats", "20000", "--period-secs", String(PERIOD)],
    ]),
  );
  const ownNode = meshNode(home("own-agent"), join(out, "own-agent-node.log"), [
    ...["--join", hostedInvite, "--port", String(ports[2]), "--console", String(ports[3])],
  ]);
  own.agentId = nodeId(await ownNode.invite());
  const named = await forward(own, [
    signed(own.buzz[1]!, own.channel, 9, `Hive agent: \`${pub(ownSecret)}\``, now() - 900),
  ]);
  assert.deepEqual((named.hive as { agent: unknown }).agent, { own: true, key: pub(ownSecret) });
  const link = spawn(
    WORKER,
    [
      ...["--key-file", join(ownState, "key"), "--hive-link", `${service}/c/${own.channel}`],
      ...["--log", own.agentLog, "--members-file", ownMembers, "--every-secs", "3"],
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  children.push(link);
  step("agents up", { hosted: hosted.agentId.slice(0, 12), own: own.agentId.slice(0, 12) });

  // 4. A chip-in to each treasury, from the stack's own wallet.
  const docker = (...args: string[]) =>
    execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
  const note = docker("exec", "arkd", "arkd", "note", "--amount", "130000");
  docker("exec", "arkd", "ark", "redeem-notes", "-n", note, "--password", "secret");
  for (const h of hives) {
    docker(
      "exec",
      "arkd",
      "ark",
      "send",
      "--to",
      h.treasury!.address,
      "--amount",
      "60000",
      "--password",
      "secret",
    );
    await until(
      `the chip-in in ${h.name}`,
      async () => (await coins(h.treasury!.script)).includes(60_000),
      120,
    );
  }
  step("chip-ins landed", { treasuries: await Promise.all(hives.map((h) => coins(h.treasury!.script))) });

  // Each channel: a proposal, two keepers' ✅ after its discussion, the member's node, HiveBot's ack.
  for (const [i, h] of hives.entries()) {
    mkdirSync(join(home(`member-${i}`), ".mesh-llm"), { recursive: true });
    writeFileSync(
      join(home(`member-${i}`), ".mesh-llm/config.toml"),
      pluginBlock(
        ["--role", "member", "--agent", h.agentId!, "--log", join(out, `member-${i}.jsonl`)],
        false,
      ),
    );
    const member = meshNode(home(`member-${i}`), join(out, `member-${i}-node.log`), [
      ...["--join", hostedInvite, "--port", String(ports[4 + 2 * i]), "--console", String(ports[5 + 2 * i])],
    ]);
    h.memberId = nodeId(await member.invite());
    h.memberApi = `http://127.0.0.1:${ports[4 + 2 * i]}/v1`;
    const proposal = signed(
      h.buzz[3]!,
      h.channel,
      9,
      await proposalText(`Answers for ${h.name}`),
      now() - 600,
    );
    const claim = signed(h.buzz[3]!, h.channel, 9, `Hive node: ${h.memberId}`, now() - 60);
    await forward(h, [
      proposal,
      signed(h.buzz[0]!, h.channel, 7, "✅", now() - 300, [["e", proposal.id]]),
      signed(h.buzz[1]!, h.channel, 7, "✅", now() - 290, [["e", proposal.id]]),
      claim,
      signed(h.bot, h.channel, 9, "Node noted.", now() - 50, [["hive", "node-ack", claim.id]]),
    ]);
  }
  await until(
    "the hosted agent's members file",
    () =>
      JSON.parse(readFileSync(server.service.files(hosted.hive).members, "utf8")).members[hosted.memberId!]
        ?.allowance_sats_per_day === 2000,
    30,
  );
  await until(
    "the own node's members file, fetched through its link",
    () =>
      JSON.parse(readFileSync(ownMembers, "utf8")).members[own.memberId!]?.allowance_sats_per_day === 2000,
    60,
  );
  for (const h of hives)
    await until(
      `the hive model on ${h.name}'s member node`,
      async () =>
        ((await http(`${h.memberApi}/models`)).body.data as { id: string }[])?.some((m) => m.id === "hive"),
      180,
    );
  step("proposals approved and members allowed", { members: hives.map((h) => h.memberId!.slice(0, 12)) });

  // 5. Each member asks; each agent asks the provider; two keepers of each hive sign at its desk.
  for (const h of hives) {
    const ask = await chat(h.memberApi!);
    const requested = await until(
      `${h.name}'s funding request`,
      () => {
        const e = first(h.agentLog!, "funding_requested");
        return e && (e.request as { params?: unknown }).params
          ? (e.request as Record<string, unknown>)
          : null;
      },
      120,
    );
    h.jobId = String(requested.job_id);
    step(`${h.name}: funding requested`, { first: ask.status, job: h.jobId.slice(0, 12) });
  }
  // The service's desk reads the own node's log as its link reports it.
  await until(
    "the own node's job at its desk",
    async () =>
      (await server.service.desk(server.service.registration(own.channel))).overview().payments.length > 0,
    60,
  );
  for (const h of hives) {
    const desk = `${service}/c/${h.channel}`;
    const [a, b] = [h.devices[0]!, h.devices[1]!];
    await openDesk(b.page, desk, h.hive);
    await openDesk(a.page, desk, h.hive);
  }
  // Both hives' keepers sign in turn, interleaved, at the same service.
  for (const [label, who, button] of [
    ["keeper A", 0, "Check and sign"],
    ["keeper B", 1, "Check and sign"],
    ["keeper A again", 0, "Finish: sign once more"],
  ] as const) {
    const answers = await Promise.all(hives.map((h) => signFirstPayment(h.devices[who]!.page, button)));
    step(label, { consoles: answers });
  }
  for (const h of hives) {
    await until(
      `${h.name}'s payment executed`,
      async () =>
        (await server.service.desk(server.service.registration(h.channel))).payment(h.jobId!)?.status ===
        "done",
      300,
    );
    await until(
      `the job open on ${h.name}'s agent`,
      () => first(h.agentLog!, "job_open", { job_id: h.jobId }),
      120,
    );
    await until(`the job open on the provider`, () => first(sellerLog, "job_open", { job_id: h.jobId }), 120);
  }
  step("escrows funded and jobs open", {
    treasuries: await Promise.all(hives.map((h) => coins(h.treasury!.script))),
  });

  // 6. Work, receipts, and the claims.
  for (const h of hives) {
    const served: number[] = [];
    for (let i = 0; i < 3; i++) served.push((await chat(h.memberApi!)).status);
    assert.deepEqual(served, [200, 200, 200]);
  }
  step("members' requests served");
  for (const h of hives) {
    const closed = await until(
      `${h.name}'s claim`,
      () => events(h.agentLog!).find((e) => e.event === "job_closed" && e.job_id === h.jobId && e.txid),
      PERIOD + 180,
    );
    const held = await until(
      `the remainder back in ${h.name}`,
      async () => {
        const c = await coins(h.treasury!.script);
        return c.includes(Number(closed.returned_sats)) ? c : null;
      },
      120,
    );
    const state = await until(
      `${h.name}'s page showing the claim`,
      async () => {
        const s = (await http(`${service}/c/${h.channel}/hive/v1/state`)).body;
        const job = (s.jobs as { jobId: string; status: string }[]).find((j) => j.jobId === h.jobId);
        return job?.status === "claimed" ? s : null;
      },
      60,
    );
    step(`${h.name}: provider claimed`, {
      paid: closed.paid_sats,
      returned: closed.returned_sats,
      treasury: held,
      agent: (state.hive as { agent: unknown }).agent,
    });
  }
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = String(error instanceof Error ? error.stack : error);
  console.error(error);
} finally {
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  await server.close();
  await agents.close();
  for (const c of children.reverse()) c.kill("SIGTERM");
  await browser.close();
  site.close();
  console.log(result.passed ? `PASSED (${out})` : `FAILED (${out})`);
  if (result.passed)
    for (const h of hives) rmSync(opsPaths(h.hive).secret(), { recursive: true, force: true });
  process.exit(result.passed ? 0 : 1);
}
