import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, statSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  callWorker,
  clientAddress,
  decimal,
  exactObject,
  Fault,
  isFault,
  localPath,
  readJson,
  rateLimit,
  readPrivateJson,
  runInWindow,
  secretPath,
  shapedObject,
  statePath,
  strictBase64,
  withLock,
  writeJson,
  writeOnce,
  writePrivateJson,
} from "../src/index.js";

const run = randomBytes(6).toString("hex");
const code = (expected: string) => (error: unknown) => isFault(error, expected);

test("state paths stay inside .local and .secrets without symlinks", () => {
  assert.throws(() => statePath("/tmp/outside.json"), code("STATE_PATH"));
  assert.throws(() => statePath(resolve(localPath(), "..", "package.json")), code("STATE_PATH"));
  const target = localPath("kit-test", run, "target");
  writeJson(resolve(target, "file.json"), { ok: true });
  const link = localPath("kit-test", run, "link");
  symlinkSync(target, link);
  assert.throws(() => statePath(resolve(link, "file.json")), code("STATE_PATH"));
});

test("writes are atomic, private and write-once when asked", () => {
  const path = localPath("kit-test", run, "once.json");
  writeOnce(path, { a: "1" });
  assert.deepEqual(writeOnce(path, { a: "1" }), { a: "1" });
  assert.throws(() => writeOnce(path, { a: "2" }), code("STATE_CHANGED"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readJson(path), { a: "1" });
});

test("private configuration requires .secrets and owner-only mode", () => {
  const path = secretPath("kit-test", run, "config.json");
  writePrivateJson(path, { secret: "x" });
  assert.deepEqual(readPrivateJson(path), { secret: "x" });
  chmodSync(path, 0o644);
  assert.throws(() => readPrivateJson(path), code("PRIVATE_CONFIG_MODE"));
  assert.throws(() => readPrivateJson(localPath("kit-test", run, "once.json")), code("PRIVATE_CONFIG_PATH"));
});

test("locks exclude a second holder immediately", async () => {
  const lock = localPath("kit-test", run, "exclusive.lock");
  await withLock(lock, async () => {
    await assert.rejects(() => withLock(lock, async () => "second"));
  });
  assert.equal(await withLock(lock, async () => "after"), "after");
});

test("validators refuse noncanonical input", () => {
  assert.equal(decimal("20000", "x"), 20000n);
  for (const bad of ["020", "+1", "1e3", " 1", "", 1])
    assert.throws(() => decimal(bad, "x"), code("INVALID"));
  assert.throws(() => exactObject({ a: 1, b: 2 }, ["a"], "o"), code("INVALID"));
  assert.deepEqual(shapedObject({ a: 1 }, ["a"], ["b"], "o"), { a: 1 });
  assert.throws(() => strictBase64("YQ", 10), code("INVALID"));
  assert.equal(strictBase64("YQ==", 10).toString(), "a");
});

test("workers return results or bare codes, never messages or output", async () => {
  const entry = resolve(import.meta.dirname, "fixtures/echo-worker.ts");
  assert.deepEqual(await callWorker({ entry, args: ["x"] }, { mode: "echo", payload: 7 }), {
    payload: 7,
    args: ["x"],
  });
  assert.deepEqual(await callWorker({ entry, args: [] }, { mode: "log", payload: 1 }), {
    payload: 1,
    args: [],
  });
  await assert.rejects(
    () => callWorker({ entry, args: [] }, { mode: "fault" }),
    (error: unknown) => {
      assert.ok(error instanceof Fault);
      assert.equal(error.code, "POLICY_REFUSED");
      assert.ok(!error.message.includes("detail"));
      return true;
    },
  );
  await assert.rejects(() => callWorker({ entry, args: [] }, { mode: "crash" }), code("WORKER_FAILED"));
});

test("a burst of worker requests is answered a few processes at a time, in full", async () => {
  const entry = resolve(import.meta.dirname, "fixtures/echo-worker.ts");
  const answers = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      callWorker<{ payload: number }>({ entry, args: [] }, { mode: "echo", payload: i }),
    ),
  );
  assert.deepEqual(
    answers.map((a) => a.payload),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  // A failure gives its place up like a success: the next request still runs.
  await assert.rejects(() => callWorker({ entry, args: [] }, { mode: "crash" }), code("WORKER_FAILED"));
  assert.deepEqual(await callWorker({ entry, args: [] }, { mode: "echo", payload: 1 }), {
    payload: 1,
    args: [],
  });
});

test("a client's address is the proxy's word only from this machine, and its share of requests runs out and refills", () => {
  const from = (peer: string, forwarded?: string) =>
    clientAddress({
      socket: { remoteAddress: peer },
      headers: forwarded ? { "x-forwarded-for": forwarded } : {},
    } as never);
  assert.equal(from("203.0.113.9"), "203.0.113.9");
  assert.equal(from("203.0.113.9", "198.51.100.1"), "203.0.113.9", "a header from elsewhere is not believed");
  assert.equal(from("127.0.0.1", "198.51.100.1, 198.51.100.7"), "198.51.100.7", "the entry the proxy added");
  const limit = rateLimit(60, 3);
  assert.deepEqual(
    [1, 2, 3, 4].map(() => limit.take("a")),
    [true, true, true, false],
  );
  assert.equal(limit.take("b"), true, "another client has its own share");
});

test("window runs retry inside the window and stop at its end", async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  let attempts = 0;
  const handle = runInWindow({
    opensAt: now - 1n,
    closesAt: now + 30n,
    pollMs: 10,
    initialBackoffMs: 10,
    maxBackoffMs: 20,
    attempt: async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "done";
    },
  });
  assert.equal(await handle.result, "done");
  assert.equal(attempts, 3);
  const final = runInWindow({
    opensAt: now - 1n,
    closesAt: now + 30n,
    pollMs: 10,
    initialBackoffMs: 10,
    attempt: async () => {
      throw new Fault("AMBIGUOUS");
    },
    isFinal: (error) => isFault(error, "AMBIGUOUS"),
  });
  await assert.rejects(final.result, code("AMBIGUOUS"));
  const closed = runInWindow({
    opensAt: now - 10n,
    closesAt: now - 1n,
    pollMs: 10,
    attempt: async () => "never",
  });
  await assert.rejects(closed.result, code("WINDOW_CLOSED"));
  const stopped = runInWindow({
    opensAt: now + 60n,
    closesAt: now + 120n,
    pollMs: 10,
    attempt: async () => "never",
  });
  stopped.stop();
  await assert.rejects(stopped.result, code("STOPPED"));
});
