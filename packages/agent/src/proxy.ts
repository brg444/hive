import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Checkpoint,
  closeServer,
  ensure,
  Fault,
  faultCode,
  hex,
  isBrowserRequest,
  listenLocal,
  noCheckpoint,
  nowSeconds,
  readBody,
  readJson,
  sha256Hex,
  stateExists,
  unhex,
  unixNow,
  withLock,
  writeJson,
  writeOnce,
} from "@hive/kit";
import {
  canonicalJson,
  MESSAGE_TOKEN_ALLOWANCE,
  type MeteredChallenge,
  type MeteredContext,
  type MeteredRequestLimits,
  parseInferenceRequest,
  requireValidSignedQuote,
  type SignedQuote,
  type SignedReceipt,
  signReceipt,
  validateMeteredChallenge,
} from "@hive/protocol";
import { type Agent, loadAgent, requireAgentQuote } from "./config.js";
import { SidecarClient } from "./sidecar-client.js";

export interface AgentProxyOptions {
  configPath: string;
  quote: SignedQuote;
  sidecarUrl: string;
  port?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  checkpoint?: Checkpoint;
}

export interface AgentProxyHandle {
  url: string;
  close(): Promise<void>;
}

interface PaidRequest {
  requestBase64: string;
  requestSha256: string;
  challenge?: MeteredChallenge;
  receipt?: SignedReceipt;
  accepted?: boolean;
  responseSha256?: string;
}

interface ReceiptLedger {
  schema: "hive-agent-ledger/v4";
  escrowId: string;
  sequence: string;
  cumulativeInputTokens: string;
  cumulativeOutputTokens: string;
  latestReceipt: SignedReceipt | null;
  requests: Record<string, PaidRequest>;
}

/** No receipt is signed this close to the deadline. */
const DEADLINE_GUARD_SECONDS = 30n;
const MAX_REQUESTS = 128;

/**
 * An OpenAI-compatible endpoint for the payer's agent. For each completion it
 * has the sidecar run the request, checks the provider's challenge against the
 * request's own limits and the payer's ceiling, signs the cumulative receipt,
 * and only then releases the output. It holds the receipt key and nothing else.
 */
export async function startAgentProxy(options: AgentProxyOptions): Promise<AgentProxyHandle> {
  const agent = loadAgent(options.configPath);
  const quote = requireValidSignedQuote(options.quote);
  const bearerToken = requireAgentQuote(agent, quote);
  const maxRequest = options.maxRequestBytes ?? 65_536;
  const maxResponse = options.maxResponseBytes ?? 2 * 1024 * 1024;
  const timeout = options.requestTimeoutMs ?? 180_000;
  ensure(Number.isSafeInteger(maxRequest) && maxRequest > 0 && maxRequest <= 65_536, "INVALID_LIMIT");
  ensure(
    Number.isSafeInteger(maxResponse) && maxResponse > 0 && maxResponse <= 4 * 1024 * 1024,
    "INVALID_LIMIT",
  );
  ensure(Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 600_000, "INVALID_LIMIT");
  const sidecar = new SidecarClient(options.sidecarUrl, bearerToken, timeout);
  const directory = resolve(agent.config.stateDirectory, quote.quoteId);
  const ledgerPath = resolve(directory, "ledger.json");
  await withLock(resolve(directory, "ledger.lock"), async () => {
    writeOnce(resolve(directory, "context.json"), {
      schema: "hive-agent-context/v4",
      quote,
      sidecarUrl: options.sidecarUrl,
      maxRequest,
      maxResponse,
      timeout,
      perRequestMaxSats: agent.config.perRequestMaxSats,
      defaultOutputTokens: agent.defaultOutputTokens,
      messageTokenAllowance: MESSAGE_TOKEN_ALLOWANCE,
    });
    if (!stateExists(ledgerPath)) {
      writeJson(ledgerPath, {
        schema: "hive-agent-ledger/v4",
        escrowId: quote.quoteId,
        sequence: "0",
        cumulativeInputTokens: "0",
        cumulativeOutputTokens: "0",
        latestReceipt: null,
        requests: {},
      } satisfies ReceiptLedger);
    }
  });
  const pay = paymentFlow({
    agent,
    quote,
    sidecar,
    directory,
    ledgerPath,
    maxResponse,
    timeout,
    checkpoint: options.checkpoint ?? noCheckpoint,
  });
  const active = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const task = handle(request, response, quote, maxRequest, pay).catch((error) => {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Request could not be completed; retry unchanged with the same Idempotency-Key.",
              type: "hive_request_error",
              code: faultCode(error),
            },
          }),
        );
      } else if (!response.writableEnded) response.end();
    });
    active.add(task);
    void task.finally(() => active.delete(task));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const { url } = await listenLocal(server, options.port ?? 0);
  let closing: Promise<void> | undefined;
  return {
    url,
    close() {
      closing ??= (async () => {
        await closeServer(server);
        await Promise.allSettled([...active]);
      })();
      return closing;
    },
  };
}

type Pay = (
  bytes: Buffer,
  idempotencyKey: string,
  client: AbortSignal,
  isGone: () => boolean,
) => Promise<{
  id: string;
  challenge: MeteredChallenge;
  bytes: Buffer;
}>;

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  quote: SignedQuote,
  maxRequest: number,
  pay: Pay,
): Promise<void> {
  ensure(!isBrowserRequest(request), "CROSS_ORIGIN_DISABLED");
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: quote.body.model, object: "model", owned_by: "hive-provider" }],
      }),
    );
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404);
    response.end();
    return;
  }
  ensure(request.headers["content-type"]?.split(";")[0] === "application/json", "JSON_REQUIRED");
  const key = request.headers["idempotency-key"] ?? hex(randomBytes(32));
  ensure(
    typeof key === "string" && key.length > 0 && Buffer.byteLength(key) <= 256,
    "INVALID_IDEMPOTENCY_KEY",
  );
  response.setHeader("idempotency-key", key);
  let gone = false;
  const client = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) {
      gone = true;
      client.abort();
    }
  });
  const bytes = await readBody(request, maxRequest);
  const paid = await pay(bytes, key, client.signal, () => gone);
  if (gone) return;
  response.writeHead(200, {
    "content-type": paid.challenge.contentType,
    "content-length": paid.bytes.length,
    "x-buzz-escrow-id": quote.quoteId,
    "x-buzz-receipt-amount-sats": paid.challenge.amountSats,
    "x-buzz-request-id": paid.id,
    "cache-control": "no-store",
  });
  response.end(paid.bytes);
}

function paymentFlow(context: {
  agent: Agent;
  quote: SignedQuote;
  sidecar: SidecarClient;
  directory: string;
  ledgerPath: string;
  maxResponse: number;
  timeout: number;
  checkpoint: Checkpoint;
}): Pay {
  const { agent, quote, sidecar, directory, ledgerPath, maxResponse, timeout, checkpoint } = context;
  const beforeDeadline = (code: string) =>
    ensure(nowSeconds() + DEADLINE_GUARD_SECONDS < BigInt(quote.body.timeoutAt), code);
  return async (bytes, idempotencyKey, client, isGone) => {
    const parsed = parseInferenceRequest(bytes, quote.body.model, {
      defaultOutputTokens: agent.defaultOutputTokens,
    });
    const limits: MeteredRequestLimits = {
      maxInputTokens: String(parsed.inputTokenLimit),
      maxOutputTokens: String(parsed.completionLimit),
      maxRequestSats: agent.config.perRequestMaxSats,
    };
    const id = sha256Hex(`hive-agent-request/v1\0${quote.quoteId}\0${idempotencyKey}`);
    return withLock(resolve(directory, "ledger.lock"), async () => {
      const ledger = readJson<ReceiptLedger>(ledgerPath);
      ensure(
        ledger.schema === "hive-agent-ledger/v4" && ledger.escrowId === quote.quoteId,
        "LEDGER_MISMATCH",
      );
      const save = () => writeJson(ledgerPath, ledger);
      let saved = ledger.requests[id];
      if (!saved?.accepted) {
        // A receipt already issued must be reconciled on its own request first.
        ensure(
          !Object.entries(ledger.requests).some(
            ([other, entry]) => other !== id && entry.receipt && !entry.accepted,
          ),
          "PENDING_RECEIPT",
        );
      }
      if (saved) ensure(saved.requestBase64 === bytes.toString("base64"), "IDEMPOTENCY_KEY_REUSED");
      else {
        ensure(Object.keys(ledger.requests).length < MAX_REQUESTS, "REQUEST_LIMIT");
        beforeDeadline("ESCROW_DEADLINE");
        saved = { requestBase64: bytes.toString("base64"), requestSha256: sha256Hex(bytes) };
        ledger.requests[id] = saved;
        save();
      }
      const entry = saved;
      const expected = (): MeteredContext => ({
        requestId: id,
        requestSha256: entry.requestSha256,
        previousReceipt: ledger.latestReceipt,
        sequence: ledger.sequence,
        cumulativeInputTokens: ledger.cumulativeInputTokens,
        cumulativeOutputTokens: ledger.cumulativeOutputTokens,
        requestLimits: limits,
        nowSeconds: unixNow(),
      });
      const lifetime = AbortSignal.any([client, AbortSignal.timeout(timeout)]);
      const cancelIfGone = async () => {
        if (!isGone()) return;
        await sidecar.cancel(id);
        throw new Fault("CLIENT_CANCELLED");
      };
      try {
        await checkpoint("agent.request.persisted");
        const prepared = await sidecar.prepare(id, entry.requestBase64, agent.defaultOutputTokens, lifetime);
        ensure(prepared.requestId === id, "SIDECAR_MISMATCH");
        ensure(
          ["prepared", "running", "ready", "receipted"].includes(prepared.status),
          "SIDECAR_REQUEST_CLOSED",
        );
        await checkpoint("agent.request.response");
        const expires = Date.now() + timeout;
        while (!entry.challenge) {
          await cancelIfGone();
          ensure(Date.now() < expires, "METERING_TIMEOUT");
          const status = await sidecar.status(id, lifetime);
          ensure(status.requestId === id, "SIDECAR_MISMATCH");
          if (["cancelled", "failed", "indeterminate"].includes(status.status))
            throw new Fault("NO_BILLABLE_OUTPUT");
          if (status.challenge) {
            beforeDeadline("ESCROW_DEADLINE");
            const challenge = validateMeteredChallenge(status.challenge, quote, expected());
            ensure(BigInt(challenge.amountSats) > 0n, "ZERO_COST_OUTPUT");
            entry.challenge = challenge;
            save();
            await checkpoint("agent.challenge.persisted");
            break;
          }
          await delay(50);
        }
        const challenge = entry.challenge;
        if (!entry.receipt) {
          beforeDeadline("ESCROW_DEADLINE");
          const current = await sidecar.status(id, lifetime);
          ensure(
            current.requestId === id && ["ready", "receipted"].includes(current.status),
            "SIDECAR_REQUEST_CLOSED",
          );
          ensure(canonicalJson(current.challenge) === canonicalJson(challenge), "CHALLENGE_CHANGED");
          validateMeteredChallenge(challenge, quote, expected());
          await cancelIfGone();
          beforeDeadline("ESCROW_DEADLINE");
          entry.receipt =
            ledger.latestReceipt?.amountSats === challenge.amountSats
              ? ledger.latestReceipt
              : signReceipt(
                  { escrowId: quote.quoteId, amountSats: challenge.amountSats },
                  unhex(agent.config.receiptSecret),
                );
          save();
        }
        await checkpoint("agent.receipt.persisted");
        if (!entry.accepted) {
          ensure(!isGone(), "CLIENT_GONE_BEFORE_COMMIT");
          const committed = await sidecar.commit(id, challenge.challengeId, entry.receipt, lifetime);
          await checkpoint("agent.receipt.response");
          ensure(committed.requestId === id && committed.status === "receipted", "RECEIPT_NOT_ACKNOWLEDGED");
          ensure(canonicalJson(committed.challenge) === canonicalJson(challenge), "CHALLENGE_CHANGED");
          ensure(BigInt(challenge.sequence) === BigInt(ledger.sequence) + 1n, "SEQUENCE_MISMATCH");
          ledger.sequence = challenge.sequence;
          ledger.cumulativeInputTokens = challenge.cumulativeInputTokens;
          ledger.cumulativeOutputTokens = challenge.cumulativeOutputTokens;
          ledger.latestReceipt = entry.receipt;
          entry.accepted = true;
          save();
        }
        await checkpoint("agent.receipt.accepted");
        const output = await sidecar.output(id, maxResponse, lifetime);
        ensure(sha256Hex(output.bytes) === challenge.responseSha256, "OUTPUT_MISMATCH");
        ensure(output.contentType === challenge.contentType, "OUTPUT_MISMATCH");
        entry.responseSha256 = challenge.responseSha256;
        save();
        await checkpoint("agent.output.verified");
        return { id, challenge, bytes: output.bytes };
      } catch (error) {
        // An issued receipt reconciles against the same request, even if its acknowledgement was lost.
        if (!entry.receipt) await sidecar.cancel(id).catch(() => {});
        throw error;
      }
    });
  };
}
