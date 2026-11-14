import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { type TestContext, test } from "node:test";
import { hex, localPath, sha256Hex, unhex } from "@hive/kit";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { opsPaths } from "../../tools/ops.js";
import { agentDigest, hiveIdFor, startService } from "../../tools/service.js";
import { startFakeNetwork } from "../support/fake-network.js";

/**
 * The Hive service: a community asks for a hive through HiveBot, the operator approves it, members'
 * plugins forward the channel, and once the keepers' keys are in the treasury is built with nobody
 * at the service doing anything.
 */
const now = () => Math.floor(Date.now() / 1000);

function sign(
  secret: Uint8Array,
  channel: string,
  kind: number,
  content: string,
  at: number,
  tags: string[][] = [],
) {
  const e = {
    pubkey: hex(schnorr.getPublicKey(secret)),
    created_at: at,
    kind,
    tags: [["h", channel], ...tags],
    content,
  };
  const id = sha256Hex(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]));
  return { ...e, id, sig: hex(schnorr.sign(unhex(id), secret)) };
}

async function setup(t: TestContext) {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 4 * 86_400 });
  t.after(() => fake.close());
  const root = localPath("service-test", randomUUID().slice(0, 8));
  const server = await startService(
    {
      network: "regtest",
      deployment: fake.deployment(),
      publicUrl: "https://hive.example.org",
      consoleUrl: "https://hive.example.org/keeper/",
      discussionSeconds: 600,
      root,
    },
    {},
  );
  const channel = randomUUID();
  const hive = hiveIdFor(channel);
  t.after(async () => {
    await server.close();
    for (const p of [root, opsPaths(hive).local(), opsPaths(hive).secret()])
      rmSync(p, { recursive: true, force: true });
  });
  const call = (path: string, body?: unknown) =>
    fetch(`${server.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
  return { fake, server, channel, hive, call };
}

test("a hive is asked for by HiveBot, approved, and gets its treasury from its keepers' keys by itself", async (t) => {
  const { server, channel, hive, call } = await setup(t);
  const [bot, k0, k1, k2, member] = [0, 1, 2, 3, 4].map(() => schnorr.utils.randomSecretKey());
  const pub = (k: Uint8Array) => hex(schnorr.getPublicKey(k));
  const treasuryKeys = [0, 1, 2].map(() =>
    hex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)),
  );
  const first = sign(bot!, channel, 9, "Hi, I'm Hive bot.", now() - 900, [["hive", "call"]]);

  // A setup message someone else signed, or from another channel, asks for nothing.
  const forged = { ...first, content: "edited" };
  assert.equal((await call("/hives", { channelId: channel, call: forged })).status, 400);
  assert.equal((await call("/hives", { channelId: randomUUID(), call: first })).status, 400);
  const asked = await call("/hives", {
    channelId: channel,
    community: "wss://open.example",
    name: "Open Lab",
    call: first,
  });
  assert.deepEqual([asked.body.hive, asked.body.status, asked.body.bot], [hive, "pending", pub(bot!)]);
  // A hive nobody approved is not shown to the community's plugins.
  const listed = async () =>
    ((await call("/hives?community=wss://open.example")).body.hives as { hive: string }[]).map((h) => h.hive);
  assert.deepEqual(await listed(), []);

  // The channel, as members' plugins forward it: the keepers HiveBot recorded, and their keys.
  const events = [
    first,
    sign(bot!, channel, 9, "Keepers are set.", now() - 800, [
      ["hive", "plugin"],
      ...[k0, k1, k2].map((k) => ["p", pub(k!)]),
    ]),
    ...[k0, k1, k2].map((k, i) =>
      sign(k!, channel, 9, `Hive keeper key: ${treasuryKeys[i]}`, now() - 700 + i),
    ),
    sign(member!, channel, 9, `Hive keeper key: 02${"ab".repeat(32)}`, now() - 600),
  ];
  // Still pending: nothing is kept or built until the operator opens the hive, and plugins are told so.
  const early = await call(`/c/${channel}/hive/v1/channel`, { events });
  assert.deepEqual([early.status, early.body], [202, { added: 0, refused: 0, events: 0, pending: true }]);
  let state = (await call(`/c/${channel}/hive/v1/state`)).body;
  assert.equal(state.treasury, null);
  assert.equal((state.hive as { status: string }).status, "pending");
  assert.deepEqual((state.governance as { keepers: string[] }).keepers, []);

  // The operator names HiveBot's key, as the channel shows it: no request is approved on its own word.
  await assert.rejects(server.service.approve(hive), /BOT_REQUIRED/);
  await assert.rejects(server.service.approve(hive, pub(member!)), /NO_SUCH_REQUEST/);
  await server.service.approve(hive, pub(bot!));
  assert.deepEqual(await listed(), [hive]);
  assert.deepEqual((await call(`/c/${channel}/hive/v1/channel`, { events })).body, {
    added: 6,
    refused: 0,
    events: 6,
  });
  state = (await call(`/c/${channel}/hive/v1/state`)).body;
  assert.deepEqual(
    (state.governance as { keepers: string[] }).keepers,
    [k0, k1, k2].map((k) => pub(k!)),
  );
  const record = server.service.record(hive);
  assert.ok(record?.keepersHold);
  assert.deepEqual(record?.stewardKeys, treasuryKeys);
  state = await server.service.state(channel);
  assert.equal((state.treasury as { address: string }).address, record?.treasuryAddress);
  assert.deepEqual(state.keepersDesk, {
    desk: `https://hive.example.org/c/${channel}`,
    console: "https://hive.example.org/keeper/",
  });
  // The keepers' consoles reach the hive's desk under its channel.
  const described = await call(`/c/${channel}/desk/v1/hive`);
  assert.deepEqual((described.body as { keepers: string[] }).keepers, treasuryKeys);
  assert.equal((await call(`/c/${randomUUID()}/hive/v1/state`)).status, 404);
});

test("a community's own agent node reports to the service once a keeper names it", async (t) => {
  const { server, channel, hive, call } = await setup(t);
  const [bot, k0, k1, k2] = [0, 1, 2, 3].map(() => schnorr.utils.randomSecretKey());
  const agent = schnorr.utils.randomSecretKey();
  const pub = (k: Uint8Array) => hex(schnorr.getPublicKey(k));
  const first = sign(bot!, channel, 9, "Hi.", now() - 900, [["hive", "call"]]);
  await call("/hives", { channelId: channel, call: first });
  await server.service.approve(hive, pub(bot!));
  const report = (lines: string[], offset: number, key = agent) => {
    const at = now();
    const signature = hex(
      schnorr.sign(agentDigest(channel, at, `events|${offset}|${sha256Hex(lines.join("\n"))}`), key),
    );
    return call(`/c/${channel}/agent/v1/events`, { at, signature, lines, offset });
  };
  const line = JSON.stringify({ at: now(), event: "started", role: "buyer" });
  // Until a keeper names the node, nothing it reports is taken.
  assert.equal((await report([line], 0)).body.error, "NO_AGENT");
  const events = [
    first,
    sign(bot!, channel, 9, "Keepers are set.", now() - 800, [
      ["hive", "plugin"],
      ...[k0, k1, k2].map((k) => ["p", pub(k!)]),
    ]),
    sign(k1!, channel, 9, `Hive agent: \`${pub(agent)}\``, now() - 100),
  ];
  await call(`/c/${channel}/hive/v1/channel`, { events });
  assert.deepEqual(((await server.service.state(channel)).hive as { agent: unknown }).agent, {
    own: true,
    key: pub(agent),
  });
  assert.equal((await report([line], 0, schnorr.utils.randomSecretKey())).body.error, "AUTH_INVALID");
  assert.deepEqual((await report([line], 0)).body, { lines: 1 });
  // A repeat is skipped, and a gap refused, so the service's copy of the log stays whole.
  assert.deepEqual((await report([line], 0)).body, { lines: 1 });
  assert.equal((await report([line], 5)).body.error, "GAP");
  const at = now();
  const signature = hex(schnorr.sign(agentDigest(channel, at, "members"), agent));
  const members = await fetch(`${server.url}/c/${channel}/agent/v1/members`, {
    headers: { "x-hive-at": String(at), "x-hive-signature": signature },
  });
  assert.deepEqual(await members.json(), { members: {} });
  // A signature in the address, where proxies log it, is not taken.
  assert.equal((await call(`/c/${channel}/agent/v1/members?at=${at}&signature=${signature}`)).status, 401);
});

test("a channel someone else asked for first is still HiveBot's to open, and only as the operator names it", async (t) => {
  const { server, channel, hive, call } = await setup(t);
  const [bot, intruder, k0, k1, k2] = [0, 1, 2, 3, 4].map(() => schnorr.utils.randomSecretKey());
  const pub = (k: Uint8Array) => hex(schnorr.getPublicKey(k));
  const ask = (key: Uint8Array, name: string) =>
    call("/hives", {
      channelId: channel,
      community: "wss://open.example",
      name,
      call: sign(key, channel, 9, "Hi.", now() - 900, [["hive", "call"]]),
    });
  // Anyone can sign a setup message that names the channel, and does so before HiveBot.
  assert.equal((await ask(intruder!, "Not this hive")).body.bot, pub(intruder!));
  const asked = await ask(bot!, "Open Lab");
  assert.deepEqual([asked.body.bot, asked.body.status, asked.body.name], [pub(bot!), "pending", "Open Lab"]);
  assert.deepEqual(
    Object.keys(server.service.list()[0]?.requests ?? {}).sort(),
    [pub(intruder!), pub(bot!)].sort(),
  );

  const opened = await server.service.approve(hive, pub(bot!));
  assert.deepEqual([opened.bot, opened.name, opened.requests], [pub(bot!), "Open Lab", undefined]);
  // The intruder's messages name no keepers here, and it is told whose hive this is.
  await call(`/c/${channel}/hive/v1/channel`, {
    events: [
      sign(intruder!, channel, 9, "Keepers are set.", now() - 800, [
        ["hive", "plugin"],
        ...[k0, k1, k2].map((k) => ["p", pub(k!)]),
      ]),
    ],
  });
  const state = await server.service.state(channel);
  assert.deepEqual((state.governance as { keepers: string[] }).keepers, []);
  assert.equal((state.hive as { bot: string }).bot, pub(bot!));
  assert.equal((await ask(intruder!, "Not this hive")).body.bot, pub(bot!));
  await assert.rejects(server.service.approve(hive, pub(intruder!)), /APPROVED/);
});

test("the service turns away more than its share of requests, bodies and waiting hives", async (t) => {
  const { server, channel, call } = await setup(t);
  const bot = schnorr.utils.randomSecretKey();
  const first = sign(bot, channel, 9, "Hi.", now() - 900, [["hive", "call"]]);
  // A request for a hive is small; one that is not is refused before it is read whole.
  const large = await call("/hives", { channelId: channel, call: first, name: "x".repeat(64 * 1024) });
  assert.deepEqual([large.status, large.body.error], [413, "REQUEST_TOO_LARGE"]);
  // One address asks for a few hives a minute, not hundreds.
  const answers: number[] = [];
  for (let i = 0; i < 14; i++)
    answers.push((await call("/hives", { channelId: randomUUID(), call: first })).status);
  assert.ok(answers.includes(429), "requests past the allowance are turned away");
  assert.equal(server.service.list().length, 0, "and none of them left anything behind");
});
