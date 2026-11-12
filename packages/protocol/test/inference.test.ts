import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { isFault } from "@hive/kit";
import { MESSAGE_TOKEN_ALLOWANCE, parseInferenceRequest, parseUsage } from "../src/index.js";

const mesh = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../test/fixtures/mesh-usage.json"), "utf8"),
) as {
  models: { data: { id: string }[] };
  stream: { body: string; responseSha256: string; usageChunkIndex: number };
  nonstream: { body: string; responseSha256: string };
};
const model = mesh.models.data[0]!.id;
const utf8 = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const code = (expected: string) => (error: unknown) => isFault(error, expected);
const blocks = mesh.stream.body.split("\n\n").filter(Boolean);
const usageAt = mesh.stream.usageChunkIndex;
const withTail = (payload: unknown) =>
  mesh.stream.body.replace(
    "data: [DONE]",
    `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: payload, finish_reason: null }] })}\n\ndata: [DONE]`,
  );

test("retained MeshLLM v0.78.1 bodies are the recorded bytes", () => {
  assert.equal(sha(mesh.stream.body), mesh.stream.responseSha256);
  assert.equal(sha(mesh.nonstream.body), mesh.nonstream.responseSha256);
});

test("real MeshLLM SSE, with a finishing chunk after usage, is metered (review R3)", () => {
  assert.deepEqual(parseUsage(utf8(mesh.stream.body), true, 32, model), {
    inputTokens: "21",
    outputTokens: "5",
    totalTokens: "26",
  });
});

test("real MeshLLM JSON and the usage-last SSE order are metered", () => {
  assert.equal(parseUsage(utf8(mesh.nonstream.body), false, 32, model).totalTokens, "26");
  const reordered = [
    ...blocks.slice(0, usageAt),
    blocks[usageAt + 1]!,
    blocks[usageAt]!,
    ...blocks.slice(usageAt + 2),
  ];
  assert.equal(parseUsage(utf8(`${reordered.join("\n\n")}\n\n`), true, 32, model).outputTokens, "5");
});

test("generated payload after usage is refused", () => {
  for (const tail of [
    { content: "unbilled" },
    { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
    { function_call: { name: "tool" } },
    { reasoning_content: "unbilled" },
    { future_payload: "unbilled" },
  ]) {
    assert.throws(() => parseUsage(utf8(withTail(tail)), true, 32, model), code("DATA_AFTER_USAGE"));
  }
  const duplicate = mesh.stream.body.replace("data: [DONE]", `${blocks[usageAt]}\n\ndata: [DONE]`);
  assert.throws(() => parseUsage(utf8(duplicate), true, 32, model), code("DUPLICATE_USAGE"));
});

test("usage anomalies map to stable codes", () => {
  const json = (usage: unknown, extra: Record<string, unknown> = {}) =>
    utf8(
      JSON.stringify({ model, choices: [{ message: { role: "assistant", content: "x" } }], usage, ...extra }),
    );
  const cases: [Uint8Array, boolean, string][] = [
    [utf8("{"), false, "MALFORMED_UPSTREAM_RESPONSE"],
    [utf8(JSON.stringify({ model: "other", choices: [{}], usage: {} })), false, "UPSTREAM_MODEL_MISMATCH"],
    [
      json({ prompt_tokens: 0xffffffff, completion_tokens: 2, total_tokens: 0xffffffff }),
      false,
      "USAGE_OVERFLOW_OR_MISMATCH",
    ],
    [
      json({ prompt_tokens: 0xffffffff, completion_tokens: 0, total_tokens: 0xffffffff }),
      false,
      "SATURATED_USAGE_COUNTER",
    ],
    [json({ prompt_tokens: 3, completion_tokens: 33, total_tokens: 36 }), false, "OUTPUT_TOKEN_LIMIT"],
    [json({ prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 }), false, "INVALID_USAGE_COUNTERS"],
    [json(undefined), false, "MISSING_TERMINAL_USAGE"],
    [
      utf8(`data: ${JSON.stringify({ model, choices: [{ delta: { content: "x" } }] })}\n\ndata: [DONE]\n\n`),
      true,
      "MISSING_TERMINAL_USAGE",
    ],
  ];
  for (const [bytes, stream, expected] of cases) {
    assert.throws(() => parseUsage(bytes, stream, 32, model), code(expected), expected);
  }
});

test("request parsing keeps bytes, bounds tokens and normalizes the upstream body", () => {
  const body = utf8(JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }));
  const parsed = parseInferenceRequest(body, model, { defaultOutputTokens: 64 });
  assert.equal(parsed.completionLimit, 64);
  assert.equal(parsed.inputTokenLimit, body.byteLength + MESSAGE_TOKEN_ALLOWANCE);
  assert.deepEqual(parsed.upstream.stream_options, { include_usage: true });
  assert.equal(parsed.upstream.max_completion_tokens, 64);
  const both = utf8(
    JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      max_completion_tokens: 4,
    }),
  );
  assert.equal(parseInferenceRequest(both, model, { defaultOutputTokens: 64 }).completionLimit, 4);
});

test("unsupported requests are refused before any upstream call", () => {
  const request = (value: unknown) => utf8(JSON.stringify(value));
  const message = [{ role: "user", content: "hi" }];
  const cases: [Uint8Array, string][] = [
    [utf8("not json"), "INVALID_OPENAI_REQUEST"],
    [request({ model, messages: message, tools: [] }), "UNSUPPORTED_OPENAI_FIELD"],
    [request({ model: "other", messages: message }), "MODEL_OR_MESSAGES"],
    [request({ model, messages: [{ role: "tool", content: "x" }] }), "TEXT_MESSAGES_REQUIRED"],
    [request({ model, messages: [{ role: "user", content: [] }] }), "TEXT_MESSAGES_REQUIRED"],
    [request({ model, messages: message, max_tokens: 0 }), "TOKEN_LIMIT"],
    [request({ model, messages: message, max_completion_tokens: 65 }), "TOKEN_LIMIT"],
    [request({ model, messages: message, stream: "yes" }), "INVALID_STREAM"],
  ];
  for (const [bytes, expected] of cases) {
    assert.throws(
      () => parseInferenceRequest(bytes, model, { defaultOutputTokens: 32, maxOutputTokens: 64 }),
      code(expected),
      expected,
    );
  }
});
