import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { type AgentProxyHandle, startAgentProxy, writeAgentConfig } from "@hive/agent";
import {
  closeServer,
  hex,
  listenLocal,
  localPath,
  readBody,
  readJson,
  secretPath,
  sha256Hex,
} from "@hive/kit";
import { METERED_PROFILE, makeMeteredChallenge, quoteCostSats, receiptSha256 } from "@hive/protocol";
import { approveProviderRequest, startSidecar, writeProviderConfig } from "@hive/provider";
import { signChallenge } from "../../packages/provider/src/challenge.js";
import { makeQuote } from "../support/quotes.js";
import { MESH_MODEL, mesh, stubUpstream } from "../support/upstream.js";

const LIMITS = {
  maxRequestBytes: 65_536,
  maxResponseBytes: 1_048_576,
  maxOutputTokens: 64,
  requestTimeoutMs: 30_000,
  deadlineGuardSeconds: 60,
};
const chat = (stream: boolean, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: MESH_MODEL,
    messages: [{ role: "user", content: "Say hello" }],
    max_tokens: 32,
    stream,
    ...extra,
  });

/** A provider, a payer and one escrow quote, with no Arkade network involved. */
function escrow(options: { perRequestMaxSats?: string; timeoutInSeconds?: bigint } = {}) {
  const run = randomBytes(6).toString("hex");
  const now = BigInt(Math.floor(Date.now() / 1000));
  const lifetime = options.timeoutInSeconds ?? 3600n;
  const fixture = makeQuote({
    model: MESH_MODEL,
    timeoutAt: String(now + lifetime),
    quoteExpiresAt: String(now + (lifetime > 600n ? 600n : lifetime - 10n)),
  });
  const providerConfigPath = secretPath("test-runs", run, "provider.json");
  writeProviderConfig(providerConfigPath, {
    schema: "hive-provider/v4",
    workloadSecret: hex(fixture.secrets.workload),
    stateDirectory: localPath("test-runs", run, "provider"),
    // Metering never reaches the network; the address is never dialled.
    deployment: { network: "regtest", arkdUrl: "http://127.0.0.1:9", delegateeUrl: "http://127.0.0.1:9" },
    approvedRequests: [],
  });
  const bearerToken = hex(randomBytes(32));
  const agentConfigPath = secretPath("test-runs", run, "agent.json");
  writeAgentConfig(agentConfigPath, {
    schema: "hive-agent/v4",
    receiptSecret: hex(fixture.secrets.payer),
    stateDirectory: localPath("test-runs", run, "agent"),
    approvedRequests: [fixture.terms],
    perRequestMaxSats: options.perRequestMaxSats ?? "5000",
    sidecarBearerTokens: { [fixture.quote.quoteId]: bearerToken },
  });
  return { run, fixture, providerConfigPath, agentConfigPath, bearerToken };
}

async function complete(agent: AgentProxyHandle, body: string, key = hex(randomBytes(8))) {
  const response = await fetch(`${agent.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body,
  });
  return { response, text: await response.text() };
}

async function serve(
  upstreamRewrite?: (body: string, stream: boolean) => string,
  options: Parameters<typeof escrow>[0] = {},
) {
  const setup = escrow(options);
  await approveProviderRequest(setup.providerConfigPath, setup.fixture.terms);
  const upstream = await stubUpstream(upstreamRewrite);
  const sidecar = await startSidecar(
    {
      quote: setup.fixture.quote,
      upstreamBaseUrl: upstream.url,
      stateDirectory: localPath("test-runs", setup.run, "sidecar"),
      limits: LIMITS,
    },
    {
      bearerToken: setup.bearerToken,
      signer: { signChallenge: (r) => signChallenge(setup.providerConfigPath, r) },
    },
  );
  const agent = await startAgentProxy({
    configPath: setup.agentConfigPath,
    quote: setup.fixture.quote,
    sidecarUrl: `${sidecar.url}/`,
  });
  return {
    ...setup,
    upstream,
    sidecar,
    agent,
    async close() {
      await agent.close();
      await sidecar.close();
      await upstream.close();
    },
  };
}

const ledger = (run: string, escrowId: string) =>
  readJson<{ latestReceipt: { amountSats: string } | null; sequence: string }>(
    localPath("test-runs", run, "agent", escrowId, "ledger.json"),
  );

describe("sidecar access (review R6)", () => {
  let service: Awaited<ReturnType<typeof serve>>;
  before(async () => {
    service = await serve();
  });
  after(() => service.close());

  test("every endpoint needs the escrow's bearer token and refuses browsers", async () => {
    const id = "ab".repeat(32);
    const routes: [string, string][] = [
      ["GET", "/latest"],
      ["POST", "/freeze"],
      ["POST", `/requests/${id}`],
      ["GET", `/requests/${id}`],
      ["POST", `/requests/${id}/receipt`],
      ["POST", `/requests/${id}/cancel`],
      ["GET", `/requests/${id}/output`],
    ];
    for (const [method, path] of routes) {
      for (const authorization of [undefined, `Bearer ${"00".repeat(32)}`, service.bearerToken]) {
        const response = await fetch(`${service.sidecar.url}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(authorization === undefined ? {} : { authorization }),
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        if (authorization === service.bearerToken) continue;
        assert.equal(response.status, 401, `${method} ${path}`);
      }
    }
    const browser = await fetch(`${service.sidecar.url}/latest`, {
      headers: { authorization: `Bearer ${service.bearerToken}`, origin: "https://example.com" },
    });
    assert.equal(browser.status, 403);
  });

  test("a retried request with the same idempotency key is charged once", async () => {
    const key = hex(randomBytes(8));
    const first = await complete(service.agent, chat(false), key);
    const second = await complete(service.agent, chat(false), key);
    assert.equal(first.response.status, 200);
    assert.equal(second.text, first.text);
    assert.equal(ledger(service.run, service.fixture.quote.quoteId).latestReceipt?.amountSats, "260");
    const reused = await complete(service.agent, chat(true), key);
    assert.equal(reused.response.status, 409);
    assert.match(reused.text, /IDEMPOTENCY_KEY_REUSED/);
  });
});

describe("usage after the usage chunk (review R3)", () => {
  test("a finishing chunk is accepted, generated text is not billed or released", async () => {
    const tail = (delta: Record<string, unknown>) => (body: string, stream: boolean) =>
      stream
        ? body.replace(
            "data: [DONE]",
            `data: ${JSON.stringify({ model: MESH_MODEL, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: [DONE]`,
          )
        : body;
    const finishing = await serve(tail({}));
    try {
      assert.equal((await complete(finishing.agent, chat(true))).response.status, 200);
    } finally {
      await finishing.close();
    }
    const smuggled = await serve(tail({ content: "unbilled" }));
    try {
      const result = await complete(smuggled.agent, chat(true));
      assert.equal(result.response.status, 409);
      assert.ok(!result.text.includes("unbilled"));
      assert.equal(ledger(smuggled.run, smuggled.fixture.quote.quoteId).latestReceipt, null);
    } finally {
      await smuggled.close();
    }
  });
});

describe("the agent's own bounds (review R1)", () => {
  /** A sidecar that signs whatever usage it likes, to test the agent rather than the sidecar. */
  async function lyingSidecar(setup: ReturnType<typeof escrow>, usage: { input: bigint; output: bigint }) {
    const quote = setup.fixture.quote;
    const cancelled: string[] = [];
    const prepared = new Map<string, string>();
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://x").pathname;
      const id = path.split("/")[2]!;
      const body = request.method === "POST" ? JSON.parse((await readBody(request, 1 << 20)).toString()) : {};
      if (path.endsWith("/cancel")) cancelled.push(id);
      if (body.requestBase64) prepared.set(id, sha256Hex(Buffer.from(body.requestBase64, "base64")));
      const requestSha256 = prepared.get(id)!;
      const challenge = makeMeteredChallenge(
        {
          profile: METERED_PROFILE,
          escrowId: quote.quoteId,
          requestId: id,
          requestSha256,
          responseSha256: sha256Hex(mesh.nonstream.body),
          contentType: "application/json",
          inputTokens: String(usage.input),
          outputTokens: String(usage.output),
          totalTokens: String(usage.input + usage.output),
          cumulativeInputTokens: String(usage.input),
          cumulativeOutputTokens: String(usage.output),
          amountSats: quoteCostSats(quote.body, usage.input, usage.output).toString(),
          sequence: "1",
          previousReceiptSha256: receiptSha256(null),
        },
        setup.fixture.secrets.workload,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          requestId: id,
          status: path.endsWith("/cancel") ? "cancelled" : "ready",
          challenge,
        }),
      );
    });
    const { url } = await listenLocal(server);
    return { url: `${url}/`, cancelled, close: () => closeServer(server) };
  }

  for (const [name, usage, options] of [
    ["input beyond the request's size allowance", { input: 1_000n, output: 5n }, {}],
    ["output beyond the request's completion limit", { input: 21n, output: 33n }, {}],
    [
      "a charge above the payer's per-request ceiling",
      { input: 21n, output: 5n },
      { perRequestMaxSats: "100" },
    ],
  ] as const) {
    test(`no receipt for ${name}`, async () => {
      const setup = escrow(options);
      const sidecar = await lyingSidecar(setup, usage);
      const agent = await startAgentProxy({
        configPath: setup.agentConfigPath,
        quote: setup.fixture.quote,
        sidecarUrl: sidecar.url,
      });
      try {
        const result = await complete(agent, chat(false));
        assert.equal(result.response.status, 409);
        assert.match(result.text, /CHALLENGE_(TOKEN_LIMIT|SPEND_CEILING)/);
        assert.equal(ledger(setup.run, setup.fixture.quote.quoteId).latestReceipt, null);
        assert.equal(sidecar.cancelled.length, 1, "the agent cancels the unpaid request");
      } finally {
        await agent.close();
        await sidecar.close();
      }
    });
  }
});

describe("deadline guard", () => {
  test("a request that cannot finish before the escrow deadline is refused up front", async () => {
    const service = await serve(undefined, { timeoutInSeconds: 70n });
    try {
      const result = await complete(service.agent, chat(false));
      assert.equal(result.response.status, 409);
      assert.match(result.text, /INSUFFICIENT_DEADLINE|ESCROW_DEADLINE/);
    } finally {
      await service.close();
    }
  });
});
