/**
 * What the rehearsals share: MeshLLM nodes with the pay-arkade plugin, their JSONL logs, the regtest
 * Operator's indexer, and channel events signed as a member's Buzz app would sign them.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { hex, repositoryRoot, sha256Hex, unhex } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";

export const MESH = process.env.PAY_ARKADE_MESH ?? "mesh-llm";
export const MODEL = process.env.PAY_ARKADE_MODEL ?? "";
export const PAY = process.env.PAY_ARKADE_DIR ?? join(repositoryRoot, "hive/pay-arkade");
export const PLUGIN = join(PAY, "plugin/target/release/pay-arkade");
export const WORKER = join(PAY, "worker/dist/pay-arkade-worker");
/** 10 sats a token: a few short answers cross the 330-sat floor. */
export const PRICE = 10_000_000_000;
export const ARKD = "http://localhost:7070";

export function modelId(): string {
  for (const [name, path] of Object.entries({ MeshLLM: MESH, model: MODEL, plugin: PLUGIN, worker: WORKER }))
    assert.ok(existsSync(path), `${name} not found at ${path}`);
  return `local-gguf/sha256-${createHash("sha256").update(readFileSync(MODEL)).digest("hex")}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const now = () => Math.floor(Date.now() / 1000);

export async function until<T>(
  what: string,
  check: () => T | Promise<T>,
  seconds: number,
): Promise<NonNullable<T>> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch {
      // not yet
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export const events = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];

export const first = (path: string, name: string, match: Record<string, unknown> = {}) =>
  events(path).find((e) => e.event === name && Object.entries(match).every(([k, v]) => e[k] === v));

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise((r) => server.close(r));
  return port;
}

export async function http(url: string, body?: unknown, timeoutMs = 180_000) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // text
  }
  return { status: res.status, body: json as Record<string, unknown> };
}

/** The spendable coins at a script, as the Operator's indexer lists them. */
export async function coins(script: string) {
  const { body } = await http(`${ARKD}/v1/indexer/vtxos?scripts=${script}&spendableOnly=true`);
  return ((body.vtxos as { amount: string }[]) ?? []).map((v) => Number(v.amount));
}

export const children: ChildProcess[] = [];

/** The newest mesh invite in a node's output. */
export function inviteIn(output: string): string | undefined {
  let token: string | undefined;
  for (const line of output.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e?.event === "invite_token") token = e.token;
    } catch {
      // not JSON
    }
  }
  return token;
}

export function meshNode(home: string, log: string, args: string[]) {
  mkdirSync(join(home, ".mesh-llm"), { recursive: true });
  const child = spawn(MESH, ["serve", "--log-format", "json", ...args], {
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (c) => chunks.push(c));
  child.stderr?.on("data", (c) => chunks.push(c));
  const flush = setInterval(() => writeFileSync(log, Buffer.concat(chunks)), 1000);
  child.on("exit", () => clearInterval(flush));
  children.push(child);
  return {
    invite: (): Promise<string> =>
      until(`${log} invite`, () => inviteIn(Buffer.concat(chunks).toString()), 180),
  };
}

export const nodeId = (token: string) =>
  JSON.parse(Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()).id as string;

/** The plugin block of a node's MeshLLM config; a member's node needs no exchange grant. */
export function pluginBlock(args: string[], grant = true) {
  const quoted = args.map((a) => JSON.stringify(a)).join(", ");
  return `[[plugin]]\nname = "pay-arkade"\ncommand = ${JSON.stringify(PLUGIN)}\nargs = [${quoted}]\n${
    grant
      ? `
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
`
      : ""
  }`;
}

/** A signed Buzz channel event, as a member's app would forward it. */
export function signed(
  secret: Uint8Array,
  channel: string,
  kind: number,
  content: string,
  at: number,
  tags: string[][] = [],
) {
  const pubkey = hex(schnorr.getPublicKey(secret));
  const e = { pubkey, created_at: at, kind, tags: [["h", channel], ...tags], content };
  const id = sha256Hex(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]));
  return { ...e, id, sig: hex(schnorr.sign(unhex(id), secret)) };
}

/** A chat request to the `hive` model on a member's node. */
export const chat = (memberApi: string) =>
  http(`${memberApi}/chat/completions`, {
    model: "hive",
    messages: [{ role: "user", content: "Name a color." }],
    temperature: 0,
    max_tokens: 12,
    stream: false,
  });

/** A proposal any member might post, with an allowance for everyone. */
export async function proposalText(title: string): Promise<string> {
  // @ts-expect-error: the Buzz plugin's shared module is plain JavaScript, without type declarations
  const { formatProposal } = await import("../../hive/hive-buzz/shared/proposal.mjs");
  return formatProposal({
    title,
    budgetSats: 30000,
    start: null,
    end: null,
    who: "everyone",
    allowanceSats: 2000,
    purpose: "Answer questions about the docs.",
    work: "",
    provider: "",
    report: "",
  });
}
