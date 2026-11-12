import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Action,
  type Observation,
  type Route,
  type RouteAnswer,
  type RouteName,
  Router,
} from "@hive/executor";

/**
 * The router alone, with routes and an indexer made of closures: which route
 * is asked, when the next one is, and how an outcome is read.
 */
const action = (validInSeconds = 600): Action => ({
  txid: "aa".repeat(32),
  request: {
    templateId: "t",
    variables: {},
    outpoints: ["bb:0"],
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    pubkey: "",
    signature: "",
  },
  validUntil: Math.floor(Date.now() / 1000) + validInSeconds,
});

function scripted(
  name: RouteName,
  answers: (RouteAnswer | { result: "refused"; detail: string })[],
  onSubmit?: () => void,
): Route & { calls: number } {
  const route = {
    name,
    calls: 0,
    async submit(current: Action, context?: import("@hive/executor").RouteContext) {
      await context?.beforePost();
      route.calls++;
      onSubmit?.();
      const answer = answers[Math.min(route.calls - 1, answers.length - 1)]!;
      return answer.result === "refused"
        ? {
            ...answer,
            proof: {
              source: "offline-model" as const,
              route: name,
              txid: current.txid,
              outpoints: current.request!.outpoints,
              reason: "signature-verification" as const,
            },
          }
        : answer;
    },
  };
  return route;
}

const execute = (router: Router, action: Action, options: Parameters<Router["execute"]>[1] = {}) =>
  router.execute(action, { onState: () => {}, ...options });

const fast = { pollMs: 5, retryMs: 20, patienceMs: 40 };

test("the first route that takes the spend executes it; the others are not asked", async () => {
  let seen: Observation = "unspent";
  const self = scripted("self", [{ result: "accepted", reference: "x" }], () => {
    seen = "spent";
  });
  const delegatee = scripted("delegatee", [{ result: "accepted" }]);
  const router = new Router({ routes: [self, delegatee], observe: async () => seen, ...fast });
  const outcome = await execute(router, action());
  assert.equal(outcome.status, "done");
  assert.deepEqual([self.calls, delegatee.calls], [1, 0]);
  assert.equal(outcome.status === "done" && outcome.route, "self");
});

test("an unreachable route hands the spend to the next", async () => {
  let seen: Observation = "unspent";
  const self = scripted("self", [{ result: "unavailable", detail: "fetch failed" }]);
  const delegatee = scripted("delegatee", [{ result: "accepted", reference: "id" }], () => {
    seen = "spent";
  });
  const attempts: string[] = [];
  const router = new Router({ routes: [self, delegatee], observe: async () => seen, ...fast });
  const outcome = await execute(router, action(), {
    onAttempt: (a) => {
      attempts.push(`${a.route}:${a.result}`);
    },
  });
  assert.equal(outcome.status, "done");
  assert.deepEqual(attempts, ["self:unavailable", "delegatee:accepted"]);
});

test("a refusal is asked again later, never passed on: the next route builds the same transaction", async () => {
  let seen: Observation = "unspent";
  const self = scripted(
    "self",
    [{ result: "refused", detail: "VTXO_BANNED" }, { result: "accepted" }],
    () => {
      if (self.calls === 2) seen = "spent";
    },
  );
  const delegatee = scripted("delegatee", [{ result: "accepted" }]);
  const router = new Router({ routes: [self, delegatee], observe: async () => seen, ...fast });
  const outcome = await execute(router, action());
  assert.equal(outcome.status, "done");
  assert.deepEqual([self.calls, delegatee.calls], [2, 0]);
});

test("an accepted route that shows nothing is followed by the next one", async () => {
  let seen: Observation = "unspent";
  const self = scripted("self", [{ result: "accepted" }]);
  const delegatee = scripted("delegatee", [{ result: "accepted" }], () => {
    seen = "spent";
  });
  const router = new Router({ routes: [self, delegatee], observe: async () => seen, ...fast });
  const outcome = await execute(router, action());
  assert.equal(outcome.status, "done");
  assert.deepEqual([self.calls, delegatee.calls], [1, 1]);
});

test("nothing is posted once the spend's time is up, and it expires after the grace", async () => {
  const self = scripted("self", [{ result: "accepted" }]);
  const router = new Router({ routes: [self], observe: async () => "unspent", graceSeconds: 0, ...fast });
  const outcome = await execute(router, action(-1));
  assert.equal(outcome.status, "expired");
  assert.equal(self.calls, 0);
});

test("without an outcome by the timeout the spend stays pending, with every attempt reported", async () => {
  const self = scripted("self", [{ result: "refused", detail: "internal error" }]);
  const router = new Router({ routes: [self], observe: async () => "unspent", ...fast });
  const outcome = await execute(router, action(), { timeoutMs: 100 });
  assert.equal(outcome.status, "pending");
  assert.ok(outcome.attempts.length >= 2 && outcome.attempts.every((a) => a.result === "refused"));
});

test("an action can narrow the routes, and coins spent by another transaction end it", async () => {
  const self = scripted("self", [{ result: "accepted" }]);
  const delegatee = scripted("delegatee", [{ result: "accepted" }]);
  let seen: Observation = "elsewhere";
  const router = new Router({ routes: [self, delegatee], observe: async () => seen, ...fast });
  assert.equal((await execute(router, action(), { routes: ["delegatee"] })).status, "elsewhere");
  assert.deepEqual([self.calls, delegatee.calls], [0, 0]);
  seen = "spent";
  assert.equal((await execute(router, action())).status, "done");
});

test("admission runs only immediately before a new submission, after observation", async () => {
  let seen: Observation = "spent";
  let admissions = 0;
  const self = scripted("self", [{ result: "unavailable", detail: "fetch failed" }]);
  const delegatee = scripted("delegatee", [{ result: "accepted" }], () => {
    seen = "spent";
  });
  const router = new Router({ routes: [self, delegatee], observe: async () => seen, ...fast });
  const beforeSubmit = () => {
    admissions++;
  };
  assert.equal((await execute(router, action(), { beforeSubmit })).status, "done");
  assert.equal(admissions, 0);
  seen = "unspent";
  assert.equal((await execute(router, action(), { beforeSubmit })).status, "done");
  assert.equal(admissions, 2);
  assert.deepEqual([self.calls, delegatee.calls], [1, 1]);
});

test("a failed admission prevents a new submission but cannot hide an observed spend", async () => {
  let seen: Observation = "unspent";
  const self = scripted("self", [{ result: "accepted" }]);
  const router = new Router({ routes: [self], observe: async () => seen, ...fast });
  const beforeSubmit = () => {
    throw new Error("quote lapsed");
  };
  assert.equal((await execute(router, action(), { beforeSubmit, timeoutMs: 50 })).status, "invalid");
  assert.equal(self.calls, 0);
  seen = "spent";
  assert.equal((await execute(router, action(-1), { beforeSubmit })).status, "done");
  assert.equal(self.calls, 0);
});
