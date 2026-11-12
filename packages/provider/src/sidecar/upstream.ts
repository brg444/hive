import { ensure, Fault, isLoopbackHost, readBoundedResponse, sha256Hex } from "@hive/kit";
import { type OutputContentType, parseInferenceRequest, parseUsage, type Usage } from "@hive/protocol";

export interface SidecarLimits {
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  deadlineGuardSeconds: number;
}

/** The request as received and as forwarded, with the limits the challenge will be checked against. */
export interface PreparedRequest {
  requestBase64: string;
  upstreamBase64: string;
  stream: boolean;
  maxTokens: number;
  maxInputTokens: number;
  defaultOutputTokens: number;
}

/** A completed upstream response, kept until the payer's receipt releases it. */
export interface RetainedOutput {
  responseBase64: string;
  responseSha256: string;
  contentType: OutputContentType;
  usage: Usage;
}

const MAXIMA: SidecarLimits = {
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  maxOutputTokens: 65_536,
  requestTimeoutMs: 300_000,
  deadlineGuardSeconds: 3600,
};

export function parseLimits(value: SidecarLimits): SidecarLimits {
  const keys = Object.keys(MAXIMA) as (keyof SidecarLimits)[];
  ensure(
    value && Object.keys(value).length === keys.length && keys.every((key) => key in value),
    "INVALID_LIMIT",
  );
  for (const key of keys) {
    ensure(
      Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= MAXIMA[key],
      "INVALID_LIMIT",
      key,
    );
  }
  return value;
}

/** Inference stays on this machine: plain HTTP to a loopback host, no credentials or query. */
export function localUpstream(baseUrl: string): URL {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  ensure(
    url.protocol === "http:" &&
      isLoopbackHost(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "LOCAL_UPSTREAM_REQUIRED",
  );
  return url;
}

export function prepareRequest(
  bytes: Buffer,
  model: string,
  limits: SidecarLimits,
  defaultOutputTokens: number,
): PreparedRequest {
  const parsed = parseInferenceRequest(bytes, model, {
    defaultOutputTokens,
    maxOutputTokens: limits.maxOutputTokens,
  });
  return {
    requestBase64: bytes.toString("base64"),
    defaultOutputTokens,
    upstreamBase64: Buffer.from(JSON.stringify(parsed.upstream)).toString("base64"),
    stream: parsed.stream,
    maxTokens: parsed.completionLimit,
    maxInputTokens: parsed.inputTokenLimit,
  };
}

export async function callUpstream(
  upstream: URL,
  prepared: PreparedRequest,
  limits: SidecarLimits,
  model: string,
  signal: AbortSignal,
): Promise<RetainedOutput> {
  const response = await fetch(new URL("chat/completions", upstream), {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: Buffer.from(prepared.upstreamBase64, "base64"),
    signal,
  });
  ensure(response.ok && response.body, "UPSTREAM_HTTP_ERROR");
  const bytes = await readBoundedResponse(response, limits.maxResponseBytes);
  const contentType = expectedContentType(prepared);
  ensure(
    (response.headers.get("content-type") ?? "").split(";")[0]!.trim() === contentType,
    "UPSTREAM_CONTENT_TYPE",
  );
  const usage = parseUsage(bytes, prepared.stream, prepared.maxTokens, model);
  return { responseBase64: bytes.toString("base64"), responseSha256: sha256Hex(bytes), contentType, usage };
}

/** A retained output is released only if it still matches its hash, type and usage. */
export function verifyRetainedOutput(
  output: RetainedOutput,
  prepared: PreparedRequest,
  limits: SidecarLimits,
  model: string,
): Buffer {
  const bytes = Buffer.from(output.responseBase64, "base64");
  ensure(
    bytes.length <= limits.maxResponseBytes &&
      bytes.toString("base64") === output.responseBase64 &&
      sha256Hex(bytes) === output.responseSha256 &&
      output.contentType === expectedContentType(prepared),
    "OUTPUT_CORRUPTED",
  );
  const usage = parseUsage(bytes, prepared.stream, prepared.maxTokens, model);
  if (JSON.stringify(usage) !== JSON.stringify(output.usage)) throw new Fault("OUTPUT_CORRUPTED");
  return bytes;
}

function expectedContentType(prepared: PreparedRequest): OutputContentType {
  return prepared.stream ? "text/event-stream" : "application/json";
}
