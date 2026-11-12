import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  bearerMatches,
  type Checkpoint,
  closeServer,
  ensure,
  exactObject,
  Fault,
  faultCode,
  hexField,
  isBrowserRequest,
  isFault,
  listenLocal,
  noCheckpoint,
  readJsonBody,
  sendJson,
  sha256Hex,
  withLock,
} from "@hive/kit";
import { requireValidSignedQuote, type SignedQuote } from "@hive/protocol";
import type { ChallengeSigner } from "../challenge.js";
import { Meter } from "./meter.js";
import { localUpstream, parseLimits, type SidecarLimits } from "./upstream.js";

/** Public settings: the hive hands over the quote only after activating the escrow. */
export interface SidecarConfig {
  quote: SignedQuote;
  upstreamBaseUrl: string;
  stateDirectory: string;
  limits: SidecarLimits;
  port?: number;
}

export interface SidecarSecrets {
  /** Per-escrow token shared with the payer's agent and the provider's claim daemon. */
  bearerToken: string;
  signer: ChallengeSigner;
}

export interface SidecarHandle {
  url: string;
  close(): Promise<void>;
}

const STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  RECEIPT_REQUIRED: 402,
  CROSS_ORIGIN_DISABLED: 403,
  UNKNOWN_ENDPOINT: 404,
  UNKNOWN_REQUEST: 404,
  REQUEST_TOO_LARGE: 413,
  JSON_REQUIRED: 415,
};
const BAD_REQUEST = new Set([
  "INVALID",
  "INVALID_JSON",
  "INVALID_REQUEST",
  "INVALID_REQUEST_BYTES",
  "TOKEN_LIMIT",
  "INVALID_OPENAI_REQUEST",
  "UNSUPPORTED_OPENAI_FIELD",
  "MODEL_OR_MESSAGES",
  "TEXT_MESSAGES_REQUIRED",
  "INVALID_STREAM",
  "INVALID_STREAM_OPTIONS",
]);

function statusOf(code: string): number {
  return STATUS[code] ?? (BAD_REQUEST.has(code) ? 400 : 409);
}

/**
 * The provider's metering endpoint, bound to loopback. Every route needs the
 * escrow's bearer token; browsers are refused outright. It holds no key: each
 * challenge is signed by the workload-key worker.
 */
export async function startSidecar(
  config: SidecarConfig,
  secrets: SidecarSecrets,
  checkpoint: Checkpoint = noCheckpoint,
): Promise<SidecarHandle> {
  exactObject(
    config,
    ["quote", "upstreamBaseUrl", "stateDirectory", "limits", ...(config.port === undefined ? [] : ["port"])],
    "sidecar config",
  );
  ensure(/^[0-9a-f]{64}$/.test(secrets.bearerToken), "INVALID_BEARER");
  const quote = requireValidSignedQuote(config.quote);
  const upstream = localUpstream(config.upstreamBaseUrl);
  const limits = parseLimits(config.limits);
  ensure(
    config.port === undefined || (Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535),
    "INVALID_PORT",
  );
  const directory = resolve(config.stateDirectory);
  const configurationSha256 = sha256Hex(
    JSON.stringify({
      quote,
      upstreamBaseUrl: upstream.href,
      limits,
      bearerTokenSha256: sha256Hex(secrets.bearerToken),
    }),
  );
  let ready!: { resolve(handle: SidecarHandle): void; reject(error: unknown): void };
  const started = new Promise<SidecarHandle>((resolveStart, rejectStart) => {
    ready = { resolve: resolveStart, reject: rejectStart };
  });
  let release!: () => void;
  const released = new Promise<void>((done) => {
    release = done;
  });
  // One sidecar per ledger directory for its whole lifetime.
  const lifetime = withLock(resolve(directory, "service.lock"), async () => {
    const meter = await Meter.open({
      quote,
      upstream,
      limits,
      directory,
      configurationSha256,
      signer: secrets.signer,
      checkpoint,
    });
    const server = createServer((request, response) => {
      void route(meter, request, response, secrets.bearerToken, limits).catch((error) => {
        const code = isFault(error) ? faultCode(error) : "INTERNAL";
        sendJson(response, isFault(error) ? statusOf(code) : 500, { error: code });
      });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    const { url } = await listenLocal(server, config.port ?? 0);
    let closing: Promise<void> | undefined;
    ready.resolve({
      url,
      close() {
        closing ??= (async () => {
          await meter.stop();
          await closeServer(server);
          release();
          await lifetime;
        })();
        return closing;
      },
    });
    await released;
  });
  lifetime.catch((error) => ready.reject(error));
  return started;
}

async function route(
  meter: Meter,
  request: IncomingMessage,
  response: ServerResponse,
  bearerToken: string,
  limits: SidecarLimits,
): Promise<void> {
  ensure(bearerMatches(request.headers.authorization, bearerToken), "UNAUTHORIZED");
  ensure(!isBrowserRequest(request), "CROSS_ORIGIN_DISABLED");
  if (request.method === "POST") {
    ensure(request.headers["content-type"]?.split(";")[0] === "application/json", "JSON_REQUIRED");
  }
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/latest" && request.method === "GET")
    return sendJson(response, 200, await meter.totals());
  if (pathname === "/freeze" && request.method === "POST") {
    exactObject(await readJsonBody(request, 1024), [], "freeze");
    return sendJson(response, 200, await meter.freeze());
  }
  const match = /^\/requests\/([0-9a-f]{64})(?:\/(receipt|output|cancel))?$/.exec(pathname);
  if (!match) throw new Fault("UNKNOWN_ENDPOINT");
  const id = hexField(match[1], 32, "request id");
  const action = match[2];
  if (!action && request.method === "POST") {
    const value = (await readJsonBody(request, limits.maxRequestBytes * 2 + 1024)) as Record<string, unknown>;
    const body = exactObject(
      value,
      ["requestBase64", ...(value?.defaultOutputTokens === undefined ? [] : ["defaultOutputTokens"])],
      "prepare",
    );
    return sendJson(response, 202, await meter.prepare(id, body.requestBase64, body.defaultOutputTokens));
  }
  if (!action && request.method === "GET") return sendJson(response, 200, await meter.status(id));
  if (action === "receipt" && request.method === "POST") {
    return sendJson(response, 200, await meter.commit(id, await readJsonBody(request, 16_384)));
  }
  if (action === "cancel" && request.method === "POST") {
    exactObject(await readJsonBody(request, 1024), [], "cancel");
    return sendJson(response, 200, await meter.cancel(id));
  }
  if (action === "output" && request.method === "GET") {
    const output = await meter.output(id);
    response.writeHead(200, {
      "content-type": output.contentType,
      "content-length": output.bytes.length,
      "cache-control": "no-store",
      "x-buzz-challenge-id": output.challengeId,
    });
    response.end(output.bytes);
    return;
  }
  throw new Fault("UNKNOWN_ENDPOINT");
}
