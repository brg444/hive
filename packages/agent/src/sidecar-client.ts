import { ensure, Fault, isLoopbackHost, readBoundedResponse } from "@hive/kit";
import type { MeteredChallenge, SignedReceipt } from "@hive/protocol";

export interface RemoteStatus {
  requestId: string;
  status: string;
  challenge?: MeteredChallenge;
  error?: string;
}

/** The agent's view of one escrow's sidecar: bearer-authenticated JSON over loopback. */
export class SidecarClient {
  readonly #endpoint: URL;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(url: string, token: string, timeoutMs: number) {
    const endpoint = new URL(url);
    ensure(
      endpoint.protocol === "http:" &&
        isLoopbackHost(endpoint.hostname) &&
        endpoint.pathname === "/" &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash,
      "LOCAL_SIDECAR_REQUIRED",
    );
    this.#endpoint = endpoint;
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  prepare(
    id: string,
    requestBase64: string,
    defaultOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<RemoteStatus> {
    return this.#json(`/requests/${id}`, { requestBase64, defaultOutputTokens }, signal);
  }

  status(id: string, signal?: AbortSignal): Promise<RemoteStatus> {
    return this.#json(`/requests/${id}`, undefined, signal);
  }

  cancel(id: string): Promise<RemoteStatus> {
    return this.#json(`/requests/${id}/cancel`, {});
  }

  commit(
    id: string,
    challengeId: string,
    receipt: SignedReceipt,
    signal?: AbortSignal,
  ): Promise<RemoteStatus> {
    return this.#json(`/requests/${id}/receipt`, { challengeId, receipt }, signal);
  }

  async output(
    id: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    const response = await this.#call(`/requests/${id}/output`, undefined, signal);
    if (!response.ok) throw new Fault("SIDECAR_OUTPUT_REFUSED", String(response.status));
    const bytes = await readBoundedResponse(response, maxBytes);
    return { bytes, contentType: response.headers.get("content-type")?.split(";")[0] ?? "" };
  }

  async #json(path: string, body?: unknown, signal?: AbortSignal): Promise<RemoteStatus> {
    const response = await this.#call(path, body, signal);
    const bytes = await readBoundedResponse(response, 256 * 1024);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Fault("SIDECAR_RESPONSE_INVALID");
    }
    if (!response.ok) {
      const code = (value as { error?: unknown })?.error;
      throw new Fault(typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "SIDECAR_REFUSED");
    }
    return value as RemoteStatus;
  }

  #call(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(Math.min(this.#timeoutMs, 15_000));
    return fetch(new URL(path, this.#endpoint), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  }
}
