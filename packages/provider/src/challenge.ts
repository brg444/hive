import { resolve } from "node:path";
import {
  callWorker,
  ensure,
  exactObject,
  readJsonIfPresent,
  sha256Hex,
  unhex,
  unixNow,
  withLock,
  writeJson,
} from "@hive/kit";
import {
  canonicalJson,
  type MeteredChallenge,
  type MeteredChallengeBody,
  type MeteredContext,
  makeMeteredChallenge,
  requireValidSignedQuote,
  type SignedQuote,
  validateMeteredChallenge,
} from "@hive/protocol";
import { loadProvider, requireApprovedQuote } from "./config.js";

/** The only thing the sidecar may ask the workload key for. */
export interface ChallengeRequest {
  kind: "sign-metered-challenge";
  quote: SignedQuote;
  body: MeteredChallengeBody;
  context: Omit<MeteredContext, "nowSeconds">;
}

export interface ChallengeSigner {
  signChallenge(request: ChallengeRequest): Promise<MeteredChallenge>;
}

/**
 * Sign one cumulative charge. Each (escrow, request) and each (escrow,
 * sequence) is signed at most once; an identical request returns the saved
 * challenge, a different one is refused.
 */
export async function signChallenge(configPath: string, value: unknown): Promise<MeteredChallenge> {
  const provider = loadProvider(configPath);
  exactObject(value, ["kind", "quote", "body", "context"], "challenge request");
  const request = value as ChallengeRequest;
  ensure(request.kind === "sign-metered-challenge", "UNKNOWN_KIND");
  exactObject(
    request.context,
    [
      "requestId",
      "requestSha256",
      "previousReceipt",
      "sequence",
      "cumulativeInputTokens",
      "cumulativeOutputTokens",
      "requestLimits",
    ],
    "challenge context",
  );
  const quote = requireValidSignedQuote(request.quote);
  requireApprovedQuote(provider, quote);
  const requestSha256 = sha256Hex(canonicalJson(request));
  const directory = resolve(provider.config.stateDirectory, "metered-challenges");
  return withLock(resolve(directory, "signing.lock"), async () => {
    const recordPath = resolve(directory, `${requestSha256}.json`);
    const saved = readJsonIfPresent<{ request: ChallengeRequest; challenge: MeteredChallenge }>(recordPath);
    if (saved) {
      ensure(canonicalJson(saved.request) === canonicalJson(request), "CHALLENGE_RECORD_MISMATCH");
      return validateMeteredChallenge(saved.challenge, quote, request.context);
    }
    const secret = unhex(provider.config.workloadSecret);
    let challenge: MeteredChallenge;
    try {
      challenge = makeMeteredChallenge(request.body, secret);
    } finally {
      secret.fill(0);
    }
    validateMeteredChallenge(challenge, quote, { ...request.context, nowSeconds: unixNow() });
    const reservationsPath = resolve(directory, "reservations.json");
    const reservations = readJsonIfPresent<Record<string, string>>(reservationsPath) ?? {};
    const resources = [
      `${quote.quoteId}:request:${challenge.requestId}`,
      `${quote.quoteId}:sequence:${challenge.sequence}`,
    ];
    for (const resource of resources) {
      ensure(!reservations[resource] || reservations[resource] === requestSha256, "CHALLENGE_ALREADY_SIGNED");
    }
    for (const resource of resources) reservations[resource] = requestSha256;
    writeJson(reservationsPath, reservations);
    writeJson(recordPath, { request, challenge });
    return challenge;
  });
}

/** The sidecar's handle on the workload key: a process that signs challenges only. */
export class ChallengeClient implements ChallengeSigner {
  readonly #configPath: string;
  constructor(configPath: string) {
    this.#configPath = resolve(configPath);
  }
  signChallenge(request: ChallengeRequest): Promise<MeteredChallenge> {
    return callWorker(
      {
        entry: resolve(import.meta.dirname, "challenge-worker.ts"),
        args: [this.#configPath],
        timeoutMs: 15_000,
        maxRequestBytes: 65_536,
        maxResponseBytes: 65_536,
      },
      request,
    );
  }
}
