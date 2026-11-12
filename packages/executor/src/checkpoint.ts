import { assertValidServerUnrollScript } from "@arkade-os/sdk";
import { ensure, guard } from "@hive/kit";

/** Validate advertised checkpoint recovery parameters before any spend is prepared. */
export function validateCheckpoint(
  checkpointTapscript: string,
  options: { exitDelaySeconds: number; forfeitKey: Uint8Array },
): void {
  ensure(
    Number.isSafeInteger(options.exitDelaySeconds) &&
      options.exitDelaySeconds > 0 &&
      options.forfeitKey.length === 32,
    "DEPLOYMENT_MISMATCH",
    "invalid checkpoint parameters",
  );
  guard("DEPLOYMENT_MISMATCH", () =>
    assertValidServerUnrollScript(checkpointTapscript, {
      minSeconds: BigInt(options.exitDelaySeconds),
      requireSeconds: true,
      advertisedForfeitPubkey: options.forfeitKey,
    }),
  );
}
