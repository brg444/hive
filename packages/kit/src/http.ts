import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { ensure, Fault } from "./fault.js";

export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Fault("REQUEST_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const body = await readBody(request, limit);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Fault("INVALID_JSON");
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    // JSON is never read as a page, whatever it carries.
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

/** Read a fetch response body, refusing anything above `limit` bytes. */
export async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  ensure(response.body, "EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw new Fault("RESPONSE_TOO_LARGE");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function bearerMatches(header: string | string[] | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const supplied = typeof header === "string" ? Buffer.from(header) : Buffer.alloc(0);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Browsers send Origin or Sec-Fetch-Site; local services refuse both. */
export function isBrowserRequest(request: IncomingMessage): boolean {
  return Boolean(request.headers.origin) || request.headers["sec-fetch-site"] === "cross-site";
}

export function isLoopbackHost(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
}

/**
 * Who a request comes from: the peer, or, when the peer is this host's own TLS proxy, the address the
 * proxy saw. Only the last forwarded entry counts, the one the proxy added itself: a client can put
 * anything before it.
 */
export function clientAddress(request: IncomingMessage): string {
  const peer = request.socket.remoteAddress ?? "";
  const local = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const forwarded = request.headers["x-forwarded-for"];
  if (local && forwarded) {
    const last = String(Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded)
      .split(",")
      .pop()
      ?.trim();
    if (last) return last;
  }
  return peer;
}

export interface RateLimit {
  /** Takes `cost` from the key's allowance; false when it has run out. */
  take(key: string, cost?: number): boolean;
}

/**
 * A token bucket per key: `perMinute` on average, `burst` at once. Kept in memory and bounded, so
 * the limiter itself cannot be filled up; when it is full the keys idle longest make room.
 */
export function rateLimit(perMinute: number, burst = perMinute, maxKeys = 10_000): RateLimit {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key, cost = 1) {
      const now = Date.now();
      const bucket = buckets.get(key) ?? { tokens: burst, at: now };
      bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 60_000) * perMinute);
      bucket.at = now;
      // Re-inserted, so the map stays in order of last use.
      buckets.delete(key);
      buckets.set(key, bucket);
      if (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value as string);
      if (bucket.tokens < cost) return false;
      bucket.tokens -= cost;
      return true;
    },
  };
}

export async function listenLocal(server: Server, port = 0): Promise<{ url: string; port: number }> {
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      ready();
    });
  });
  const address = server.address();
  ensure(address && typeof address !== "string", "LISTEN_FAILED");
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}

export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
