import { spawn } from "node:child_process";
import { Fault, faultCode } from "./fault.js";
import { repositoryRoot } from "./state.js";

export interface WorkerCall {
  /** Absolute path of the worker module. */
  entry: string;
  args: readonly string[];
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

type WorkerReply = { ok: true; result: unknown } | { ok: false; code: string };

/**
 * Run one typed request in a fresh worker process. The worker holds its own
 * private configuration; the caller sees a result or a fixed error code only.
 */
export function callWorker<T>(call: WorkerCall, request: unknown): Promise<T> {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > (call.maxRequestBytes ?? 4 * 1024 * 1024)) {
    return Promise.reject(new Fault("REQUEST_TOO_LARGE"));
  }
  const maxResponse = call.maxResponseBytes ?? 8 * 1024 * 1024;
  return new Promise<T>((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", call.entry, ...call.args], {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    let output = "";
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Fault("WORKER_TIMEOUT")));
    }, call.timeoutMs ?? 45_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part: string) => {
      output += part;
      if (Buffer.byteLength(output) > maxResponse) child.kill("SIGKILL");
    });
    // Worker diagnostics stay inside the worker; only the reply crosses over.
    child.stderr.resume();
    child.on("error", () => finish(() => reject(new Fault("WORKER_UNAVAILABLE"))));
    child.on("close", (code) =>
      finish(() => {
        let reply: WorkerReply;
        try {
          reply = JSON.parse(output) as WorkerReply;
        } catch {
          reject(new Fault(code === 75 ? "WORKER_INTERRUPTED" : "WORKER_FAILED"));
          return;
        }
        if (reply.ok === true && code === 0) resolveResult(reply.result as T);
        else
          reject(
            new Fault(reply.ok === false && typeof reply.code === "string" ? reply.code : "WORKER_FAILED"),
          );
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * Worker side of callWorker. Reads one JSON request, writes one reply line,
 * silences console output and never serializes an exception.
 */
export async function serveWorker(
  handler: (request: unknown, args: readonly string[]) => Promise<unknown>,
  options: { maxRequestBytes?: number; fallbackCode?: string } = {},
): Promise<void> {
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  const limit = options.maxRequestBytes ?? 4 * 1024 * 1024;
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > limit) throw new Fault("REQUEST_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    let request: unknown;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Fault("INVALID_JSON");
    }
    const result = await handler(request, process.argv.slice(2));
    process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, code: faultCode(error, options.fallbackCode ?? "WORKER_FAILED") }) + "\n",
    );
    process.exitCode = 1;
  }
}
