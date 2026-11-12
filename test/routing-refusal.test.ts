import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExecutionState,
  observeSpend,
  restEmulator,
  type Route,
  Router,
  selfRoute,
} from "@hive/executor";
import { refusalProofFixture } from "./support/refusal-evidence.js";

test("a correlated covenant refusal stays on self across the real 15-second retry", {
  timeout: 35_000,
}, async () => {
  await refusalProofFixture(async ({ fake, conn, claimAction }) => {
    const saved: ExecutionState[] = [];
    let posted = 0;
    let rejectedBeforePost = 0;
    let delegateeCalls = 0;
    const transport = restEmulator(fake.emulatorUrl);
    const outpoints = claimAction.spend!.inputs.map((input) => `${input.txid}:${input.vout}`).sort();
    const self = selfRoute({
      emulator: {
        getInfo: (context) => transport.getInfo(context),
        async submitTx(arkTx, checkpointTxs, context) {
          const persisted = saved.at(-1);
          assert.ok(persisted, "the fixed execution must be persisted before an HTTP post");
          assert.deepEqual(persisted.action, claimAction);
          const attempt = persisted.attempts.at(-1)!;
          assert.equal(attempt.route, "self");
          assert.equal(attempt.response, undefined, "the saved attempt precedes its response");
          assert.equal(attempt.sequence, ++posted);
          rejectedBeforePost = fake.covenantRejections.length;
          return transport.submitTx(arkTx, checkpointTxs, context);
        },
      },
      emulatorKey: conn.keys.emulator,
      serverKey: conn.keys.server,
      checkpointTapscript: conn.operator.checkpointTapscript,
      prevTxs: {
        getVirtualTxs: async (txids) => ({ txs: await conn.arkd.virtualTxs(txids) }),
      },
      async covenantRejection(action) {
        const matches = fake.covenantRejections
          .slice(rejectedBeforePost)
          .filter(
            (record) =>
              record.route === "self" &&
              record.actionId === action.txid &&
              JSON.stringify([...record.outpoints].sort()) === JSON.stringify(outpoints),
          );
        assert.equal(matches.length, 1, "this failed post produced its own correlated model rejection");
        const rejection = matches[0]!;
        return {
          source: "offline-model",
          route: "self",
          txid: action.txid,
          outpoints: [...rejection.outpoints],
          reason: "signature-verification",
        };
      },
    });
    const delegatee: Route = {
      name: "delegatee",
      async submit() {
        delegateeCalls++;
        return { result: "accepted", reference: "ab".repeat(32) };
      },
    };
    const router = new Router({
      routes: [self, delegatee],
      observe: observeSpend({
        coins: (query, signal) => conn.arkd.coins(query, signal),
        checkpointTapscript: conn.operator.checkpointTapscript,
      }),
      pollMs: 25,
    });
    const started = Date.now();
    const outcome = await router.execute(claimAction, {
      timeoutMs: 18_000,
      onState: (state) => {
        saved.push(structuredClone(state));
      },
    });
    assert.equal(outcome.status, "pending");
    assert.ok(Date.now() - started >= 15_000);
    assert.ok(posted >= 2, "the default refusal retry happened after 15 seconds");
    assert.equal(delegateeCalls, 0);
    assert.ok(outcome.attempts.length >= 2);
    assert.ok(outcome.attempts.every((attempt) => attempt.route === "self" && attempt.result === "refused"));
    for (const attempt of outcome.execution.attempts) {
      assert.ok(
        saved.some((state) => {
          const entry = state.attempts.find((entry) => entry.sequence === attempt.sequence);
          return entry?.route === "self" && entry.response === undefined;
        }),
        "each attempt was durable before posting",
      );
      assert.ok(
        saved.some((state) =>
          state.attempts.some(
            (entry) => entry.sequence === attempt.sequence && entry.response?.result === "refused",
          ),
        ),
        "each correlated refusal was attached durably",
      );
    }
    assert.ok(fake.emulatorSubmissions.every((submission) => !submission.accepted));
    assert.equal(fake.balance(claimAction.spend!.outputs[0]!.script), 0);
  });
});

test("self does not post after validUntil passes during real Emulator preflight", async () => {
  await refusalProofFixture(async ({ fake, conn, claimAction }) => {
    const transport = restEmulator(fake.emulatorUrl);
    let previousLookups = 0;
    let submissions = 0;
    const route = selfRoute({
      emulator: {
        async getInfo(context) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return transport.getInfo(context);
        },
        async submitTx(arkTx, checkpoints, context) {
          submissions++;
          return transport.submitTx(arkTx, checkpoints, context);
        },
      },
      emulatorKey: conn.keys.emulator,
      serverKey: conn.keys.server,
      checkpointTapscript: conn.operator.checkpointTapscript,
      prevTxs: {
        getVirtualTxs: async (txids) => {
          previousLookups++;
          return { txs: await conn.arkd.virtualTxs(txids) };
        },
      },
    });
    const before = fake.emulatorSubmissions.length;
    // The genuine input relationships are available. Only this envelope's
    // posting deadline is shorter; no claim witness or request is changed.
    await route.submit({ ...claimAction, validUntil: Date.now() / 1000 + 0.02 });
    assert.equal(submissions, 0);
    assert.equal(fake.emulatorSubmissions.length, before);
    assert.ok(previousLookups <= 1);
  });
});
