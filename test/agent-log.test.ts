import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { localPath } from "@hive/kit";
import { AgentLog } from "../tools/desk.js";

const request = (jobId: string, model: string) => ({
  at: 1,
  event: "funding_requested",
  request: {
    job_id: jobId,
    address: "tark1example",
    cap_sats: 20_000,
    deadline: 4_000_000_000,
    model,
    provider_pk: "ab".repeat(32),
    params: { jobId },
  },
});

test("the desk follows the agent's log as it grows, a line or a character cut short included", () => {
  const dir = localPath("agent-log-test");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "agent.jsonl");
  try {
    writeFileSync(path, "");
    const log = new AgentLog(path);
    assert.deepEqual(log.jobs(2), []);
    // A line written in two parts, cut inside a character of four bytes.
    const line = Buffer.from(`${JSON.stringify(request("j1", "qwen-🐝"))}\n`);
    const cut = line.indexOf(Buffer.from("🐝")) + 2;
    appendFileSync(path, line.subarray(0, cut));
    assert.deepEqual(log.jobs(2), []);
    appendFileSync(path, line.subarray(cut));
    assert.deepEqual(
      log.jobs(2).map((j) => j.request.model),
      ["qwen-🐝"],
    );
    appendFileSync(path, `${JSON.stringify({ at: 3, event: "job_open", job_id: "j1" })}\n`);
    assert.equal(log.jobs(4)[0]?.status, "open");
    // A shorter log is another log, read from its start.
    writeFileSync(path, `${JSON.stringify(request("j2", "llama"))}\n`);
    assert.deepEqual(
      log.jobs(4).map((j) => j.request.jobId),
      ["j2"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
