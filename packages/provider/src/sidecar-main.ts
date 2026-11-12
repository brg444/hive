import { crashCheckpoint, ensure, exactObject, readJson, readPrivateJson } from "@hive/kit";
import { ChallengeClient } from "./challenge.js";
import type { SidecarLaunch } from "./config.js";
import { type SidecarConfig, startSidecar } from "./sidecar/server.js";

// Usage: sidecar-main.ts <public config> <private launch>
try {
  ensure(process.argv.length === 4, "USAGE");
  const launch = readPrivateJson<SidecarLaunch>(process.argv[3]!);
  exactObject(launch, ["schema", "bearerToken", "providerConfigPath"], "sidecar launch");
  ensure(launch.schema === "hive-sidecar-launch/v4", "INVALID_CONFIG");
  const sidecar = await startSidecar(
    readJson<SidecarConfig>(process.argv[2]!),
    { bearerToken: launch.bearerToken, signer: new ChallengeClient(launch.providerConfigPath) },
    crashCheckpoint,
  );
  process.stdout.write(`${JSON.stringify({ status: "ready", url: sidecar.url })}\n`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(
      signal,
      () =>
        void sidecar.close().then(
          () => process.exit(0),
          () => process.exit(1),
        ),
    );
  }
} catch {
  process.stderr.write("Sidecar configuration or startup rejected\n");
  process.exitCode = 1;
}
