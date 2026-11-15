/**
 * Keepers as Buzz has them: an identity whose key signs every channel message, and the Hive plugin
 * they approve payments with. The plugin here is the one `plugin/build.mjs` builds, activated in a
 * stand-in for Buzz's host that answers its requests from the Hive service under test: what a keeper
 * is offered to approve is what the plugin itself works out, with the hive's own code bundled in.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hex, repositoryRoot, sha256Hex, unhex } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";

const BUZZ = join(repositoryRoot, "hive/hive-buzz");
// The plugin's own React, as the Buzz host would hand it over.
const require = createRequire(join(BUZZ, "package.json"));
const React = require("react") as { createElement: (type: unknown, props: unknown) => unknown };
const { renderToString } = require("react-dom/server") as { renderToString: (element: unknown) => string };

/** The origin the plugin is built for; the stand-in host sends its requests to the service. */
const ORIGIN = "https://hive.example.org";

export interface BuzzEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A member's Buzz identity. */
export function buzzIdentity() {
  const secret = schnorr.utils.randomSecretKey();
  const key = hex(schnorr.getPublicKey(secret));
  return {
    secret,
    key,
    /** A channel message as Buzz's outbox builds one: its text trimmed, then `h`, `client-id` and `ms`. */
    message(channel: string, content: string, at = Math.floor(Date.now() / 1000)): BuzzEvent {
      const tags = [
        ["h", channel],
        ["client-id", randomUUID()],
        ["ms", String(Date.now() % 1000)],
      ];
      const text = content.trim();
      const id = sha256Hex(JSON.stringify([0, key, at, 9, tags, text]));
      return {
        id,
        pubkey: key,
        created_at: at,
        kind: 9,
        tags,
        content: text,
        sig: hex(schnorr.sign(unhex(id), secret)),
      };
    },
  };
}
export type BuzzIdentity = ReturnType<typeof buzzIdentity>;

const built = new Map<string, string>();
/** The Hive plugin, for a shared service or for one hive's own hive-api, built once per run. */
function plugin(kind: "service" | "api"): string {
  if (!built.has(kind))
    built.set(
      kind,
      execFileSync(
        "node",
        [
          join(BUZZ, "plugin/build.mjs"),
          `--${kind}`,
          ORIGIN,
          "--name",
          "Hive",
          "--out",
          mkdtempSync(join(tmpdir(), "hive-plugin-")),
        ],
        { encoding: "utf8" },
      ).trim(),
    );
  return built.get(kind)!;
}

type Registered = { id: string; component: (props: Record<string, unknown>) => unknown };

/**
 * What the keeper's plugin offers them in the hive's channel right now: the approvals it would write
 * into the message box, one per payment waiting for them that passed its checks, and the reasons it
 * gives for any it refuses. `host` is the Hive service, or with `own`, one hive's own hive-api.
 */
export async function pluginOffers(
  host: string,
  community: string,
  keeper: BuzzIdentity,
  channel: string,
  { own = false } = {},
) {
  const mod = await import(
    `${pathToFileURL(join(plugin(own ? "api" : "service"), "plugin.js")).href}?v=${Math.random()}`
  );
  const accessories: Registered[] = [];
  const tools: { name: string; call: () => Promise<string> }[] = [];
  const cleanups: (() => void)[] = [];
  const ctx = {
    react: React,
    conversation: {
      registerMessage: () => {},
      registerTool: () => {},
      registerAccessory: (a: Registered) => accessories.push(a),
    },
    relay: {
      snapshot: () => ({ status: "ready", generation: 1, scope: community, viewer: keeper.key, session: {} }),
      subscribe: () => () => {},
    },
    navigation: { open: async () => ({ status: "opened" }) },
    pages: { register: () => {} },
    settingsCards: { register: () => {} },
    agents: { addTool: (t: (typeof tools)[number]) => tools.push(t) },
    notifications: { register: () => ({ submit: async () => {} }) },
    host: {
      request: async ({
        url,
        method,
        headers,
        body,
      }: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      }) => {
        if (!url.startsWith(`${ORIGIN}/`)) throw new Error(`undeclared origin ${url}`);
        const res = await fetch(host + url.slice(ORIGIN.length), { method: method ?? "GET", headers, body });
        return { status: res.status, headers: {}, body: await res.text() };
      },
    },
    effect: (fn: () => (() => void) | undefined) => {
      const stop = fn();
      if (stop) cleanups.push(stop);
    },
    reflect: { get: () => undefined },
  };
  try {
    await mod.apply(ctx);
    await tools.find((t) => t.name === "hive_status")!.call();
    const bar = accessories.find((a) => a.id === "keeper")!;
    const html = renderToString(React.createElement(bar.component, { channelId: channel }));
    const decoded = html
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    return {
      approvals: [...decoded.matchAll(/I approve Hive payment [A-Za-z0-9_-]{43}/g)].map((m) => m[0]),
      refused: [...decoded.matchAll(/Don't approve this payment: ([^<]*)/g)].map((m) => m[1]!),
      html: decoded,
    };
  } finally {
    for (const stop of cleanups) stop();
  }
}
