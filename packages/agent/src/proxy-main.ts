import { crashCheckpoint, ensure, readJson } from "@hive/kit";
import { type AgentProxyOptions, startAgentProxy } from "./proxy.js";

// Usage: proxy-main.ts <public launch>. The launch names the private config path; it holds no secret.
ensure(process.argv.length === 3, "USAGE");
const proxy = await startAgentProxy({
  ...readJson<AgentProxyOptions>(process.argv[2]!),
  checkpoint: crashCheckpoint,
});
process.stdout.write(`${JSON.stringify({ status: "ready", url: proxy.url })}\n`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await proxy.close();
  process.exit(0);
};
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
