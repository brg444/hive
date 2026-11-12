import { Fault, isFault } from "@hive/kit";

/** OpenAI chat-completion requests and responses as the metering path accepts them. */
export const DEFAULT_OUTPUT_TOKENS = 128;
export const MESSAGE_TOKEN_ALLOWANCE = 64;
export const MAX_OUTPUT_TOKENS = 65536;
const ALLOWED_FIELDS = [
  "model",
  "messages",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "seed",
  "stop",
  "presence_penalty",
  "frequency_penalty",
];

export interface InferenceRequest {
  request: Record<string, unknown>;
  stream: boolean;
  /** Completion tokens the request may produce. */
  completionLimit: number;
  messageCount: number;
  /** Upper bound on billable input tokens: request bytes plus a per-message allowance. */
  inputTokenLimit: number;
  /** Body forwarded upstream, with the completion limit and usage reporting made explicit. */
  upstream: Record<string, unknown>;
}

export interface Usage {
  inputTokens: string;
  outputTokens: string;
  totalTokens: string;
}

function demand(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Fault(code);
}

function plainFields(value: unknown, fields: readonly string[], code: string): Record<string, unknown> {
  demand(value && typeof value === "object" && !Array.isArray(value), code);
  const prototype = Object.getPrototypeOf(value);
  demand(prototype === Object.prototype || prototype === null, code);
  const keys = Object.keys(value);
  demand(keys.length === fields.length && keys.every((key) => fields.includes(key)), code);
  return value as Record<string, unknown>;
}

/** The original UTF-8 bytes stay the request identity; only the upstream copy is normalized. */
export function parseInferenceRequest(
  bytes: Uint8Array,
  model: string,
  options: { defaultOutputTokens: number; maxOutputTokens?: number },
): InferenceRequest {
  const maximum = options.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  demand(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_OUTPUT_TOKENS, "TOKEN_LIMIT");
  const defaultTokens = options.defaultOutputTokens;
  demand(Number.isSafeInteger(defaultTokens) && defaultTokens > 0 && defaultTokens <= maximum, "TOKEN_LIMIT");
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Fault("INVALID_OPENAI_REQUEST");
  }
  demand(request && typeof request === "object" && !Array.isArray(request), "INVALID_OPENAI_REQUEST");
  demand(
    Object.keys(request).every((key) => ALLOWED_FIELDS.includes(key)),
    "UNSUPPORTED_OPENAI_FIELD",
  );
  const messages = request.messages;
  demand(
    request.model === model && Array.isArray(messages) && messages.length > 0 && messages.length <= 256,
    "MODEL_OR_MESSAGES",
  );
  for (const message of messages) {
    const raw = plainFields(message, ["role", "content"], "INVALID_OPENAI_REQUEST");
    demand(
      ["system", "user", "assistant"].includes(raw.role as string) && typeof raw.content === "string",
      "TEXT_MESSAGES_REQUIRED",
    );
  }
  demand(request.stream === undefined || typeof request.stream === "boolean", "INVALID_STREAM");
  // Both aliases must be valid; the completion alias wins when both are present.
  for (const name of ["max_completion_tokens", "max_tokens"]) {
    const limit = request[name];
    if (limit === undefined) continue;
    demand(
      typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 && limit <= maximum,
      "TOKEN_LIMIT",
    );
  }
  const completionLimit = (request.max_completion_tokens ?? request.max_tokens ?? defaultTokens) as number;
  if (request.stream_options !== undefined) {
    const streamOptions = plainFields(request.stream_options, ["include_usage"], "INVALID_STREAM_OPTIONS");
    demand(typeof streamOptions.include_usage === "boolean", "INVALID_STREAM_OPTIONS");
  }
  const stream = request.stream === true;
  return {
    request,
    stream,
    completionLimit,
    messageCount: messages.length,
    inputTokenLimit: bytes.byteLength + MESSAGE_TOKEN_ALLOWANCE * messages.length,
    upstream: {
      ...request,
      max_completion_tokens: completionLimit,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    },
  };
}

/**
 * Final usage from a buffered completion. A stream must report usage once, in
 * a chunk without choices; only empty finishing chunks may follow it.
 */
export function parseUsage(
  bytes: Uint8Array,
  stream: boolean,
  maxOutputTokens: number,
  model: string,
): Usage {
  let raw: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!stream) {
      const response = JSON.parse(text);
      demand(response.model === model, "UPSTREAM_MODEL_MISMATCH");
      demand(
        Array.isArray(response.choices) && response.choices.length > 0 && !response.error,
        "INVALID_RESPONSE",
      );
      raw = response.usage;
    } else {
      let done = false;
      let found = false;
      for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        demand(!done, "DATA_AFTER_DONE");
        if (data === "[DONE]") {
          demand(found, "MISSING_TERMINAL_USAGE");
          done = true;
          continue;
        }
        const chunk = JSON.parse(data);
        demand(chunk.model === model, "UPSTREAM_MODEL_MISMATCH");
        demand(Array.isArray(chunk.choices) && !chunk.error, "INVALID_STREAM_CHUNK");
        if (chunk.usage !== undefined && chunk.usage !== null) {
          demand(!found, "DUPLICATE_USAGE");
          demand(chunk.choices.length === 0, "NONTERMINAL_USAGE");
          raw = chunk.usage;
          found = true;
        } else if (found) {
          demand(chunk.choices.every(isTerminalChoice), "DATA_AFTER_USAGE");
        }
      }
      demand(done && found, "MISSING_TERMINAL_USAGE");
    }
  } catch (error) {
    if (isFault(error)) throw error;
    throw new Fault("MALFORMED_UPSTREAM_RESPONSE");
  }
  demand(raw && typeof raw === "object" && !Array.isArray(raw), "MISSING_TERMINAL_USAGE");
  const usage = raw as Record<string, unknown>;
  const values = [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens];
  demand(
    values.every(
      (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
    ),
    "INVALID_USAGE_COUNTERS",
  );
  const [input, output, total] = values as [number, number, number];
  demand(input + output === total && total <= 0xffffffff, "USAGE_OVERFLOW_OR_MISMATCH");
  demand(
    values.every((value) => (value as number) < 0xffffffff),
    "SATURATED_USAGE_COUNTER",
  );
  demand(output <= maxOutputTokens, "OUTPUT_TOKEN_LIMIT");
  return { inputTokens: String(input), outputTokens: String(output), totalTokens: String(total) };
}

/** Finish metadata may follow usage; generated payload may not. */
export function isTerminalChoice(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const choice = value as Record<string, unknown>;
  if (Object.keys(choice).some((key) => !["index", "delta", "finish_reason", "logprobs"].includes(key)))
    return false;
  if (choice.index !== undefined && !(Number.isSafeInteger(choice.index) && (choice.index as number) >= 0))
    return false;
  if (
    choice.finish_reason !== undefined &&
    choice.finish_reason !== null &&
    typeof choice.finish_reason !== "string"
  ) {
    return false;
  }
  const empty = (item: unknown): boolean =>
    item === undefined ||
    item === null ||
    item === "" ||
    (Array.isArray(item) && item.length === 0) ||
    (typeof item === "object" && Object.keys(item as object).length === 0);
  if (!empty(choice.logprobs)) return false;
  if (choice.delta === undefined || choice.delta === null) return true;
  return (
    typeof choice.delta === "object" &&
    !Array.isArray(choice.delta) &&
    Object.values(choice.delta).every(empty)
  );
}
