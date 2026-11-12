import { connect, treasuryArguments, deriveAccount } from "@hive/ark";
import { ensure, exactObject } from "@hive/kit";
import { loadSteward } from "./config.js";
import { checkPurpose } from "./policy.js";
import type { SessionRequest, StewardDescription, StewardRequest } from "./purpose.js";
import { firstNonces, firstPartials, lastSignature } from "./signer.js";

/**
 * One typed request in the steward's worker process. Every signing request is
 * checked against the steward's policy and the network before anything is
 * derived from its key.
 */
export async function handleStewardRequest(configPath: string, value: unknown): Promise<unknown> {
  const steward = loadSteward(configPath);
  const request = value as StewardRequest;
  ensure(request && typeof request === "object", "INVALID_REQUEST");
  const now = Math.floor(Date.now() / 1000);
  switch (request.operation) {
    case "describe": {
      exactObject(request, ["operation"], "describe");
      const conn = await connect(steward.config.deployment);
      const description: StewardDescription = {
        index: steward.index,
        publicKey: steward.publicKey,
        pairs: steward.pairs,
        treasuryScript: deriveAccount(conn, "treasury", treasuryArguments(steward.treasuryTerms)).pkScript,
      };
      return description;
    }
    case "nonce": {
      exactObject(request, ["operation", "session"], "nonce");
      const session = request.session as SessionRequest;
      const conn = await connect(steward.config.deployment);
      const checked = await checkPurpose(steward, conn, session, now);
      return { publicNonces: await firstNonces(steward, session, checked, now) };
    }
    case "sign": {
      exactObject(request, ["operation", "session", "peerNonces"], "sign");
      const conn = await connect(steward.config.deployment);
      const checked = await checkPurpose(steward, conn, request.session, now);
      return {
        partials: await firstPartials(steward, request.session, checked, nonceList(request.peerNonces)),
      };
    }
    case "sign-last": {
      exactObject(request, ["operation", "session", "peerNonces"], "sign-last");
      const conn = await connect(steward.config.deployment);
      const checked = await checkPurpose(steward, conn, request.session, now);
      return lastSignature(steward, request.session, checked, nonceList(request.peerNonces), now);
    }
    default:
      ensure(false, "UNKNOWN_OPERATION");
  }
}

function nonceList(value: unknown): string[] {
  ensure(Array.isArray(value) && value.length <= 16, "INVALID_REQUEST", "nonces");
  for (const n of value)
    ensure(typeof n === "string" && /^[0-9a-f]{132}$/.test(n), "INVALID_REQUEST", "nonce");
  return value as string[];
}
