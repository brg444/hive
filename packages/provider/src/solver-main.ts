import { crashCheckpoint, ensure, exactObject, readPrivateJson, unhex } from "@hive/kit";
import type { SolverConfig } from "./config.js";
import { QuoteDesk, startNostrSolver } from "./solver.js";

ensure(process.argv.length === 3, "USAGE");
const config = readPrivateJson<SolverConfig>(process.argv[2]!);
exactObject(config, ["schema", "rfqSecret", "card", "stateDirectory"], "solver config");
ensure(config.schema === "hive-solver/v4", "INVALID_CONFIG");
const secretKey = unhex(config.rfqSecret);
const desk = new QuoteDesk({
  secretKey,
  card: config.card,
  stateDirectory: config.stateDirectory,
  checkpoint: crashCheckpoint,
});
const solver = await startNostrSolver(desk, secretKey, {
  checkpoint: crashCheckpoint,
  onError: (code) => process.stderr.write(`${JSON.stringify({ type: "solver-error", code })}\n`),
});
process.stdout.write(
  `${JSON.stringify({ status: "ready", providerRfqKey: solver.card.body.providerRfqKey })}\n`,
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await solver.close();
  process.exit(0);
};
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
