import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { ensure, Fault, repositoryRoot } from "@hive/kit";

export interface Service {
  url?: string;
  close(): Promise<void>;
}

/** Start a service entry point and wait for its `{"status":"ready"}` line. */
export async function startService(
  entry: string,
  args: string[],
  log?: { append(line: string): void },
  env: Record<string, string> = {},
): Promise<Service> {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, entry), ...args],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
    },
  );
  const url = await new Promise<string | undefined>((ready, reject) => {
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Fault("SERVICE_NOT_READY", entry));
    }, 30_000);
    child.stderr!.on("data", (chunk) => log?.append(`${entry}: ${chunk}`));
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      log?.append(String(chunk));
      for (const line of stdout.split("\n")) {
        try {
          const message = JSON.parse(line) as { status?: string; url?: string };
          if (message.status === "ready" && !settled) {
            settled = true;
            clearTimeout(timer);
            ready(message.url);
          }
        } catch {
          // Partial or non-JSON line.
        }
      }
    });
    child.once("exit", (code) => {
      if (settled) return;
      clearTimeout(timer);
      reject(new Fault("SERVICE_EXITED", `${entry} ${code}`));
    });
  });
  return {
    ...(url ? { url } : {}),
    async close() {
      if (child.exitCode !== null || child.signalCode) return;
      const exited = once(child, "exit");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.kill("SIGTERM");
      await exited;
      clearTimeout(timer);
    },
  };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  ensure(address && typeof address !== "string", "LISTEN_FAILED");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}
