import { resolve } from "node:path";
import { callWorker } from "@hive/kit";
import type { SessionRequest, StewardDescription } from "./purpose.js";

export { signWithPair } from "./pair.js";
export {
  MAX_VALIDITY_SECONDS,
  type Purpose,
  type SessionRequest,
  type StewardDescription,
  type WithdrawalTerms,
} from "./purpose.js";

const WORKER = resolve(import.meta.dirname, "worker.ts");

/** What the coordinator asks of a steward. */
export interface StewardEndpoint {
  describe(): Promise<StewardDescription>;
  nonce(session: SessionRequest): Promise<{ publicNonces: string[] }>;
  sign(session: SessionRequest, peerNonces: string[]): Promise<{ partials: string[] }>;
  signLast(
    session: SessionRequest,
    peerNonces: string[],
  ): Promise<{ publicNonces: string[]; partials: string[] }>;
}

/** A steward as the coordinator holds it: a process endpoint, never a key. */
export class StewardClient implements StewardEndpoint {
  readonly #configPath: string;

  constructor(configPath: string) {
    this.#configPath = resolve(configPath);
  }

  describe(): Promise<StewardDescription> {
    return this.#call({ operation: "describe" });
  }

  nonce(session: SessionRequest): Promise<{ publicNonces: string[] }> {
    return this.#call({ operation: "nonce", session });
  }

  sign(session: SessionRequest, peerNonces: string[]): Promise<{ partials: string[] }> {
    return this.#call({ operation: "sign", session, peerNonces });
  }

  signLast(
    session: SessionRequest,
    peerNonces: string[],
  ): Promise<{ publicNonces: string[]; partials: string[] }> {
    return this.#call({ operation: "sign-last", session, peerNonces });
  }

  #call<T>(request: unknown): Promise<T> {
    return callWorker<T>({ entry: WORKER, args: [this.#configPath], timeoutMs: 60_000 }, request);
  }
}
