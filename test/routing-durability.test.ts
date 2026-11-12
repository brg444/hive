import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  type Action,
  buildSpend,
  type CovenantSpend,
  delegateeRoute,
  type Route,
  Router,
  selfRoute,
} from "@hive/executor";
import { Fault, faultCode } from "@hive/kit";
import { httpClaimDesk } from "@hive/provider";
import { spendFingerprint } from "@hive/ark";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const action = (): Action => ({
  txid: "aa".repeat(32),
  validUntil: Date.now() / 1000 + 120,
  request: {
    templateId: "bb".repeat(32),
    variables: {},
    outpoints: [`${"cc".repeat(32)}:0`],
    expiresAt: Math.ceil(Date.now() / 1000) + 120,
    pubkey: "",
    signature: "",
  },
});
const fast = { pollMs: 2, patienceMs: 250, retryMs: 180 };
type State = {
  schema: "hive-execution/v1";
  action: Action;
  routes: string[];
  attempts: {
    sequence: number;
    route: string;
    preparedAt: number;
    answeredAt?: number;
    response?: { result: string; detail?: string };
  }[];
  legacyUnknown?: true;
};
const state = (a: Action, routes = ["self", "delegatee"]): State => ({
  schema: "hive-execution/v1",
  action: a,
  routes,
  attempts: [],
});
// Structural options let these regressions run against the pre-fix Router too.
const execute = (router: Router, a: Action, extra: Record<string, unknown> = {}) =>
  router.execute(a, { timeoutMs: 80, onState: () => {}, ...extra } as Parameters<Router["execute"]>[1]);
const route = (name: "self" | "delegatee", submitted: string[], result = "accepted"): Route => ({
  name,
  async submit(_a, context) {
    await context?.beforePost();
    submitted.push(name);
    return { result, detail: "SERVICE_UNAVAILABLE" } as Awaited<ReturnType<Route["submit"]>>;
  },
});

test("each route sees a durably prepared fixed action before its POST", async () => {
  const a = action();
  let saved: State | undefined;
  let calls = 0;
  const self: Route = {
    name: "self",
    async submit(current, context) {
      await context?.beforePost();
      calls++;
      assert.deepEqual(saved?.action, current);
      assert.equal(saved?.attempts.at(-1)?.route, "self");
      assert.equal(saved?.attempts.at(-1)?.response, undefined);
      return { result: "accepted" };
    },
  };
  await execute(new Router({ routes: [self], observe: async () => "unspent", ...fast }), a, {
    onState: async (s: State) => {
      await pause(3);
      saved = structuredClone(s);
    },
  });
  assert.equal(calls, 1);
  assert.equal(saved?.attempts[0]?.response?.result, "accepted");
});

test("failed durable preparation never calls a route", async () => {
  const calls: string[] = [];
  const router = new Router({ routes: [route("self", calls)], observe: async () => "unspent", ...fast });
  await assert.rejects(
    execute(router, action(), {
      onState: async () => {
        throw new Error("storage unavailable");
      },
    }),
    /storage unavailable/,
  );
  assert.deepEqual(calls, []);
});

test("expiry during durable preparation leaves the prepared action unposted", async () => {
  const a = action();
  let drift = 0;
  a.validUntil = (Date.now() + 50) / 1000;
  const calls: string[] = [];
  const router = new Router({
    routes: [route("self", calls)],
    observe: async () => "unspent",
    now: () => Date.now() + drift,
    ...fast,
  });
  let saved: State | undefined;
  const result = await execute(router, a, {
    onState: (value: State) => {
      saved = structuredClone(value);
      drift += 100;
    },
  });
  assert.equal(result.status, "pending");
  assert.deepEqual(calls, []);
  assert.equal(
    saved?.attempts[0]?.response?.result,
    "unavailable",
    "a known unposted deadline failure is not a lost response",
  );
});

test("resume preserves accepted patience and original route order", async () => {
  const a = action();
  const calls: string[] = [];
  const old = state(a);
  old.attempts.push({
    sequence: 1,
    route: "self",
    preparedAt: Date.now() - 10,
    answeredAt: Date.now() - 10,
    response: { result: "accepted" },
  });
  const router = new Router({
    routes: [route("delegatee", calls), route("self", calls)],
    observe: async () => "unspent",
    ...fast,
  });
  await execute(router, a, { execution: old });
  assert.deepEqual(calls, []);
  old.attempts[0]!.answeredAt = Date.now() - 1000;
  await execute(router, a, { execution: old });
  assert.equal(calls[0], "delegatee");
});

test("a lost response keeps the rest of its patience across restart", async () => {
  const a = action();
  const calls: string[] = [];
  const old = state(a);
  old.attempts.push({ sequence: 1, route: "self", preparedAt: Date.now() - 10 });
  await execute(
    new Router({
      routes: [route("self", calls), route("delegatee", calls)],
      observe: async () => "unspent",
      ...fast,
    }),
    a,
    { execution: old },
  );
  assert.deepEqual(calls, []);
});

test("a legacy refusal pins its route across restart and configuration changes", async () => {
  const a = action();
  const calls: string[] = [];
  const router = new Router({ routes: [route("delegatee", calls)], observe: async () => "unspent", ...fast });
  await execute(router, a, {
    legacyAttempts: [{ route: "self", at: Date.now() - 100, result: "refused", detail: "legacy refusal" }],
    legacyUnknown: true,
  });
  assert.deepEqual(calls, []);
});

test("a pinned refusal retains retry backoff after an unavailable response on resume", async () => {
  const a = action();
  const calls: string[] = [];
  const old = state(a);
  old.attempts.push(
    {
      sequence: 1,
      route: "self",
      preparedAt: Date.now() - 1000,
      answeredAt: Date.now() - 1000,
      response: { result: "refused", detail: "LEGACY_RECORDED_ERROR" },
    },
    {
      sequence: 2,
      route: "self",
      preparedAt: Date.now(),
      answeredAt: Date.now(),
      response: { result: "unavailable", detail: "HTTP_500" },
    },
  );
  await execute(
    new Router({
      routes: [route("self", calls), route("delegatee", calls)],
      observe: async () => "unspent",
      ...fast,
    }),
    a,
    { execution: old },
  );
  assert.deepEqual(calls, []);
});

test("the last unavailable route retains cycle backoff across restart", async () => {
  const a = action();
  const calls: string[] = [];
  const old = state(a);
  old.attempts.push({
    sequence: 1,
    route: "delegatee",
    preparedAt: Date.now(),
    answeredAt: Date.now(),
    response: { result: "unavailable", detail: "SERVICE_UNAVAILABLE" },
  });
  await execute(
    new Router({
      routes: [route("self", calls), route("delegatee", calls)],
      observe: async () => "unspent",
      ...fast,
    }),
    a,
    { execution: old },
  );
  assert.deepEqual(calls, []);
});

for (const uncertain of ["accepted", "prepared", "legacy"] as const)
  test(`${uncertain} unresolved execution cannot expire solely with time`, async () => {
    const a = action();
    a.validUntil = Date.now() / 1000 - 1000;
    const old = state(a);
    if (uncertain === "legacy") old.legacyUnknown = true;
    else
      old.attempts.push({
        sequence: 1,
        route: "self",
        preparedAt: Date.now() - 1000001,
        ...(uncertain === "accepted"
          ? { answeredAt: Date.now() - 1000000, response: { result: "accepted" } }
          : {}),
      });
    const calls: string[] = [];
    const result = await execute(
      new Router({ routes: [route("self", calls)], observe: async () => "unspent", ...fast }),
      a,
      { execution: old },
    );
    assert.equal(result.status, "pending");
    assert.deepEqual(calls, []);
  });

test("a fresh never-attempted action can expire and a fixed action cannot change", async () => {
  const a = action();
  a.validUntil = Date.now() / 1000 - 1000;
  const router = new Router({ routes: [], observe: async () => "unspent", ...fast });
  assert.equal((await execute(router, a, { execution: state(a, []) })).status, "expired");
  const altered = { ...action(), txid: "dd".repeat(32) };
  await assert.rejects(
    execute(router, altered, { execution: state(action(), []) }),
    (error: unknown) => faultCode(error) === "EXECUTION_MISMATCH",
  );
});

test("a hanging observation is cancelled and returns pending by the execution deadline", async () => {
  let signal: AbortSignal | undefined;
  const observe = async (_a: Action, s?: AbortSignal) => {
    signal = s;
    await pause(200);
    return "unspent" as const;
  };
  const outcome = await execute(new Router({ routes: [], observe, ...fast }), action());
  assert.equal(outcome.status, "pending");
  assert.equal(signal?.aborted, true);
});

test("a hanging admission cannot escape the route deadline", async () => {
  const calls: string[] = [];
  const router = new Router({ routes: [route("self", calls)], observe: async () => "unspent", ...fast });
  await execute(router, action(), { beforeSubmit: () => pause(200) });
  await pause(220);
  assert.deepEqual(calls, []);
});

test("delegatee HTTP failures stay separate from a covenant rejection and never persist bodies", async () => {
  for (const status of [400, 422, 500, 502, 503, 504]) {
    const answer = await delegateeRoute({
      url: "http://invalid.example",
      fetch: async () => ({ ok: false, status, json: async () => ({ message: "SECRET_RESPONSE_MARKER" }) }),
    }).submit(action());
    assert.equal(answer.result, "unavailable", String(status));
    assert.equal(JSON.stringify(answer).includes("SECRET_RESPONSE_MARKER"), false);
  }
  const a = action();
  const expected = spendFingerprint(a.request!.templateId, a.request!.variables, a.request!.outpoints);
  for (const id of ["SECRET_RESPONSE_MARKER", "ee".repeat(32), expected]) {
    const answer = await delegateeRoute({
      url: "http://invalid.example",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ id }) }),
    }).submit(a);
    assert.equal(answer.result, id === expected ? "accepted" : "invalid");
    assert.equal(JSON.stringify(answer).includes("SECRET_RESPONSE_MARKER"), false);
  }
});

test("a delegatee fetch is aborted at the caller deadline", async () => {
  let signal: AbortSignal | undefined;
  const direct = delegateeRoute({
    url: "http://invalid.example",
    fetch: async (_url, init) => {
      signal = (init as { signal?: AbortSignal })?.signal;
      await pause(200);
      return { ok: false, status: 500, json: async () => ({}) };
    },
  });
  await execute(new Router({ routes: [direct], observe: async () => "unspent", ...fast }), action());
  assert.equal(signal?.aborted, true);
});

test("expiry during Emulator preflight prevents its POST", async () => {
  const vectors = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../packages/ark/test/vectors/spends.json"), "utf8"),
  ) as { checkpointTapscript: string; cases: { spend: CovenantSpend }[] };
  const spend = vectors.cases[0]!.spend;
  const a: Action = {
    spend,
    txid: buildSpend(spend, vectors.checkpointTapscript).txid,
    validUntil: (Date.now() + 30) / 1000,
  };
  let posts = 0;
  const self = selfRoute({
    emulator: {
      getInfo: async () => {
        await pause(50);
        return { signerPubkey: "key" };
      },
      submitTx: async () => {
        posts++;
        throw new Error("must not post");
      },
    },
    emulatorKey: "key",
    serverKey: "key",
    checkpointTapscript: vectors.checkpointTapscript,
    prevTxs: { getVirtualTxs: async () => ({ txs: [] }) },
  });
  const answer = await self.submit(a);
  assert.equal(answer.result, "unavailable");
  assert.equal(posts, 0);
});

test("a hanging self phase is aborted in time to try the desk budget", async () => {
  const a = action();
  let selfSignal: AbortSignal | undefined;
  const calls: string[] = [];
  const self: Route = {
    name: "self",
    async submit(_action, context) {
      selfSignal = context?.signal;
      await pause(100);
      await context?.beforePost();
      calls.push("self");
      return { result: "accepted" };
    },
  };
  const fallback: Route = {
    name: "delegatee",
    async submit(_action, context) {
      await context?.beforePost();
      calls.push("delegatee");
      return { result: "accepted" };
    },
  };
  await execute(
    new Router({
      routes: [self, fallback],
      observe: async () => (calls.includes("delegatee") ? "spent" : "unspent"),
      ...fast,
    }),
    a,
    { timeoutMs: 80, routeBudgetMs: { self: 15 } },
  );
  assert.equal(selfSignal?.aborted, true);
  assert.deepEqual(calls, ["delegatee"]);
  await pause(110);
  assert.deepEqual(calls, ["delegatee"]);
});

test("the claim desk carries only an action-bound correlated rejection envelope", async (t) => {
  const a = action();
  const proof = {
    source: "bounded-vm",
    route: "delegatee",
    txid: a.txid,
    outpoints: a.request!.outpoints,
    reason: "signature-verification",
  };
  let envelope: unknown = {
    error: "COVENANT_REFUSAL",
    rejection: { ...proof, remoteExtra: "SECRET_RESPONSE_MARKER" },
  };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(envelope), { status: 409 }));
  const desk = httpClaimDesk("http://127.0.0.1/api/claim");
  const claim = { expectedSpend: { txid: a.txid, outpoint: a.request!.outpoints[0] } } as Parameters<
    typeof desk.submit
  >[0];
  await assert.rejects(desk.submit(claim), (error: unknown) => {
    const rejection = (error as { rejection?: unknown }).rejection;
    assert.deepEqual(rejection, proof);
    assert.equal(JSON.stringify(rejection).includes("SECRET_RESPONSE_MARKER"), false);
    return true;
  });
  for (const rejection of [
    undefined,
    { ...proof, txid: "ee".repeat(32) },
    { ...proof, outpoints: ["ee".repeat(32) + ":0"] },
  ]) {
    envelope = { error: "COVENANT_REFUSAL", rejection };
    await assert.rejects(desk.submit(claim), (error: unknown) => faultCode(error) === "COVENANT_PROOF");
  }
});

test("transient admission metadata gaps remain resumable with no POST", async () => {
  for (const code of ["COIN_EXPIRY_UNKNOWN", "COIN_UNKNOWN", "INDEXER"]) {
    const a = action();
    const calls: string[] = [];
    let saved: State | undefined;
    const router = new Router({ routes: [route("self", calls)], observe: async () => "unspent", ...fast });
    const first = await execute(router, a, {
      beforeSubmit: () => {
        throw new Fault(code);
      },
      onState: (value: State) => {
        saved = value;
      },
    });
    assert.equal(first.status, "pending");
    assert.deepEqual(calls, []);
    assert.equal(saved!.attempts[0]!.response!.result, "unavailable");
    saved!.attempts[0]!.answeredAt = Date.now() - 1000;
    await execute(router, a, { execution: saved });
    assert.deepEqual(calls, ["self"]);
  }
});

test("the execution timeout remains bounded when the policy clock stops", async () => {
  let now = Date.now();
  let advanced = false;
  const timer = setTimeout(() => {
    advanced = true;
    now += 1000;
  }, 100);
  try {
    const outcome = await execute(
      new Router({ routes: [], observe: async () => "pending", now: () => now, ...fast }),
      action(),
      { timeoutMs: 10 },
    );
    assert.equal(outcome.status, "pending");
    assert.equal(advanced, false, "real execution budget expires before a policy-clock advance");
  } finally {
    clearTimeout(timer);
  }
});

test("a narrowed unavailable route keeps cycle backoff when other saved routes are disabled", async () => {
  const a = action();
  const calls: string[] = [];
  const router = new Router({
    routes: [route("self", calls, "unavailable"), route("delegatee", calls)],
    observe: async () => "unspent",
    ...fast,
  });
  await execute(router, a, { routes: ["self"], execution: state(a) });
  assert.deepEqual(calls, ["self"]);
});
