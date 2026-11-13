/**
 * Each hive's agent node, run by the Hive service: a MeshLLM node with the pay-arkade plugin as
 * buyer, which asks providers for jobs, writes the funding requests the keepers sign, receipts
 * every answer and serves the hive's members. It starts once the hive's treasury is built, and
 * stops when a keeper names the community's own node instead.
 *
 * The agent's receipt key stays on this host, in the node's state: it can sign receipts up to the
 * cap of jobs the keepers already funded, and nothing more.
 *
 *   --mesh <mesh-llm>  --pay-arkade <plugin>  --worker <pay-arkade-worker>  --agent-model <model id>
 *   [--agent-arg <buyer flag or value> …]     passed to every agent's plugin as is, such as
 *                                              --network bitcoin, --operator, --emulator, --delegate,
 *                                              --allow-peer <provider node id>
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { ensure } from "@hive/kit";
import type { HiveRecord } from "./ops.js";
import type { AgentRunner, HiveFiles, Registration } from "./service.js";

export interface MeshAgentOptions {
  mesh: string;
  plugin: string;
  worker: string;
  model: string;
  capSats?: number;
  periodSecs?: number;
  /** Extra buyer arguments for every agent, such as the network and the providers it may pay. */
  extra?: string[];
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise((r) => server.close(r));
  return port;
}

/** The plugin block that makes a node the hive's buyer. */
export function agentConfig(options: MeshAgentOptions, files: HiveFiles, record: HiveRecord): string {
  const args = [
    ...["--role", "buyer", "--worker", options.worker, "--model", options.model],
    ...["--state-dir", join(files.dir, "buyer-state"), "--log", files.agentLog],
    ...[
      "--treasury-program",
      record.treasuryScript.slice(4),
      "--funding-queue",
      join(files.dir, "funding-queue.jsonl"),
    ],
    ...["--members-file", files.members, "--cap-sats", String(options.capSats ?? 20_000)],
    ...["--period-secs", String(options.periodSecs ?? 2 * 86_400)],
    ...(options.extra ?? []),
  ];
  return `[[plugin]]
name = "pay-arkade"
command = ${JSON.stringify(options.plugin)}
args = [${args.map((a) => JSON.stringify(a)).join(", ")}]

[plugin.openai_exchange_grant]
endpoints = ["chat_completions", "completions", "responses"]
phases = ["request_received", "backend_selected", "exchange_finished"]
metadata = true
request_body = true
admission = true
failure_policy = "required"
deadline_ms = 30000
max_body_bytes = 1048576
max_queue_bytes = 4194304
max_in_flight = 32
`;
}

/** The newest mesh invite a node has logged. */
export function latestInvite(log: string): string | null {
  let token: string | null = null;
  for (const line of log.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e?.event === "invite_token" && typeof e.token === "string") token = e.token;
    } catch {
      // not JSON
    }
  }
  return token;
}

/** The node id an invite names. */
export function inviteNodeId(token: string): string | null {
  try {
    return (
      JSON.parse(Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()).id ?? null
    );
  } catch {
    return null;
  }
}

export class MeshAgents implements AgentRunner {
  #nodes = new Map<string, { child: ChildProcess; log: string; stopping: boolean }>();

  constructor(readonly options: MeshAgentOptions) {
    for (const [name, path] of Object.entries({
      mesh: options.mesh,
      plugin: options.plugin,
      worker: options.worker,
    }))
      ensure(existsSync(path), "AGENT_SETUP", `${name} not found at ${path}`);
  }

  async ensure(hive: Registration, files: HiveFiles, record: HiveRecord): Promise<void> {
    if (this.#nodes.has(hive.hive)) return;
    const home = join(files.dir, "agent-home");
    mkdirSync(join(home, ".mesh-llm"), { recursive: true });
    writeFileSync(join(home, ".mesh-llm/config.toml"), agentConfig(this.options, files, record));
    if (!existsSync(files.agentLog)) writeFileSync(files.agentLog, "");
    const log = join(files.dir, "agent-node.log");
    const start = async () => {
      const out = openSync(log, "a");
      const child = spawn(
        this.options.mesh,
        [
          "serve",
          "--log-format",
          "json",
          "--port",
          String(await freePort()),
          "--console",
          String(await freePort()),
        ],
        { env: { ...process.env, HOME: home }, stdio: ["ignore", out, out] },
      );
      const entry = { child, log, stopping: false };
      this.#nodes.set(hive.hive, entry);
      // A node that stops on its own is started again; jobs and receipts are on disk.
      child.on("exit", () => {
        if (!entry.stopping) setTimeout(() => void start(), 10_000);
        else this.#nodes.delete(hive.hive);
      });
    };
    await start();
  }

  async stop(hive: string): Promise<void> {
    const entry = this.#nodes.get(hive);
    if (!entry) return;
    entry.stopping = true;
    entry.child.kill("SIGTERM");
    this.#nodes.delete(hive);
  }

  async invite(hive: string): Promise<string | null> {
    const entry = this.#nodes.get(hive);
    if (!entry) return null;
    try {
      return latestInvite(readFileSync(entry.log, "utf8"));
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    for (const hive of [...this.#nodes.keys()]) await this.stop(hive);
  }
}

/** The service's agents, from its command line. */
export async function meshAgents(args: string[]): Promise<MeshAgents> {
  const value = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const need = (name: string) => {
    const v = value(name);
    ensure(v, "USAGE", `--agents needs --${name}`);
    return v;
  };
  return new MeshAgents({
    mesh: need("mesh"),
    plugin: need("pay-arkade"),
    worker: need("worker"),
    model: need("agent-model"),
    ...(value("cap-sats") ? { capSats: Number(value("cap-sats")) } : {}),
    ...(value("period-secs") ? { periodSecs: Number(value("period-secs")) } : {}),
    extra: args.flatMap((a, i) => (a === "--agent-arg" && args[i + 1] !== undefined ? [args[i + 1]!] : [])),
  });
}
