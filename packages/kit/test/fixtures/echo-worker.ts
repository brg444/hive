import { Fault, serveWorker } from "../../src/index.js";

await serveWorker(async (request, args) => {
  const value = request as { mode: string; payload?: unknown };
  if (value.mode === "fault") throw new Fault("POLICY_REFUSED", "a detail that never leaves the worker");
  if (value.mode === "crash") throw new Error("secret-bearing message");
  if (value.mode === "log") console.log("private diagnostics");
  return { payload: value.payload, args };
});
