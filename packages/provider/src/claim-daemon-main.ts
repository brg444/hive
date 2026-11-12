import { resolve } from "node:path";
import { connect } from "@hive/ark";
import { ensure, exactObject, readJson, readPrivateJson, stateExists } from "@hive/kit";
import type { SignedQuote } from "@hive/protocol";
import { ClaimClient } from "./claim.js";
import { type ClaimOutcome, claimEscrow, httpClaimDesk, scheduleClaim } from "./claim-daemon.js";
import type { ClaimDaemonLaunch } from "./config.js";

// Usage: claim-daemon-main.ts <private launch>
ensure(process.argv.length === 3, "USAGE");
const launch = readPrivateJson<ClaimDaemonLaunch>(process.argv[2]!);
exactObject(
  launch,
  [
    "schema",
    "deployment",
    "providerConfigPath",
    "quotePath",
    "stateDirectory",
    "sidecarUrl",
    "bearerToken",
    "claimDeskUrl",
  ],
  "claim daemon launch",
);
ensure(launch.schema === "hive-claim-daemon/v4", "INVALID_CONFIG");
const quote = readJson<SignedQuote>(launch.quotePath);
const conn = await connect(launch.deployment);
const options = {
  stateDirectory: launch.stateDirectory,
  sidecarUrl: launch.sidecarUrl,
  bearerToken: launch.bearerToken,
  signer: new ClaimClient(launch.providerConfigPath),
  desk: httpClaimDesk(launch.claimDeskUrl),
};
const report = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
const finish = (outcome: ClaimOutcome) =>
  report({
    event: "provider-claim-complete",
    kind: outcome.kind,
    ...(outcome.kind !== "no-receipt" ? { txid: outcome.txid } : {}),
    ...(outcome.kind === "paid" ? { amountSats: outcome.amountSats } : {}),
  });
const failed = (error: unknown) => {
  report({ event: "provider-claim-stopped", code: (error as { code?: string }).code ?? "FAILED" });
  process.exitCode = 1;
};
report({ status: "ready", kind: "provider-claim-daemon", timeoutAt: quote.body.timeoutAt });
if (stateExists(resolve(launch.stateDirectory, "claim.json"))) {
  // A claim already handed in is reconciled at once, even after the window.
  await claimEscrow(conn, quote, options).then(finish, failed);
} else {
  const handle = scheduleClaim(conn, quote, options, {
    onRetry: (_error, delayMs) => report({ event: "provider-claim-retry", delayMs }),
  });
  process.once("SIGTERM", () => handle.stop());
  await handle.result.then(finish, failed);
}
