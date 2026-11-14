// A community's own agent node, linked to the Hive service: its pay-arkade log goes to the service,
// which shows the hive's jobs, payouts and usage from it and keeps the keepers' signing desk, and the
// members file comes back, so the node serves the members the hive's proposals allow. Every request
// is signed with the agent's own key, which a keeper names in the hive's channel
// (`Hive agent: <key>`), so nobody else can report or read in the hive's name.
//
//   pay-arkade-worker --key-file <the agent's key> --hive-link https://<service>/c/<channel ID> \
//       --log <the buyer's --log> --members-file <the buyer's --members-file> [--every-secs 15]
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { hiveLinkDigest } from "./signing.ts";

const BATCH = 500;
/** No request to the service waits longer than this: a service that stops answering costs one pass, not the link. */
const TIMEOUT_MS = 30_000;

export interface LinkOptions {
    url: string;
    log: string;
    members: string;
    secret: Uint8Array;
    everyMs?: number;
    once?: boolean;
}

export function linkTarget(url: string): { base: string; channelId: string } {
    const m = /^(https?:\/\/.+\/c\/([0-9a-f-]{36}))\/?$/.exec(url.trim());
    if (!m) throw new Error("--hive-link takes the hive's address on the service: https://<service>/c/<channel ID>");
    return { base: m[1], channelId: m[2] };
}

export async function runHiveLink(o: LinkOptions): Promise<void> {
    const { base, channelId } = linkTarget(o.url);
    const sign = (what: string) => {
        const at = Math.floor(Date.now() / 1000);
        return { at, signature: hex.encode(schnorr.sign(hiveLinkDigest(channelId, at, what), o.secret)) };
    };
    let offset = 0;
    for (;;) {
        try {
            // The members the hive's proposals allow, written whole so the plugin never reads half a file.
            const m = sign("members");
            // In headers, which proxies and access logs leave out, not in the address.
            const res = await fetch(`${base}/agent/v1/members`, {
                headers: { "x-hive-at": String(m.at), "x-hive-signature": m.signature },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.ok) {
                const text = JSON.stringify(await res.json(), null, 2) + "\n";
                let current = "";
                try { current = readFileSync(o.members, "utf8"); } catch { /* first fetch */ }
                if (text !== current) {
                    writeFileSync(`${o.members}.tmp`, text);
                    renameSync(`${o.members}.tmp`, o.members);
                }
            } else console.error(`members: ${res.status} ${await res.text()}`);
            // The log, from where the service's copy ends, in batches.
            let lines: string[] = [];
            try { lines = readFileSync(o.log, "utf8").split("\n").filter((l) => l.trim()); } catch { /* no log yet */ }
            while (offset < lines.length || offset === 0) {
                const batch = lines.slice(offset, offset + BATCH);
                const digest = hex.encode(sha256(new TextEncoder().encode(batch.join("\n"))));
                const s = sign(`events|${offset}|${digest}`);
                const r = await fetch(`${base}/agent/v1/events`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ ...s, offset, lines: batch }),
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
                const body = (await r.json().catch(() => ({}))) as { lines?: number; error?: string; detail?: string };
                if (r.ok && typeof body.lines === "number") offset = body.lines;
                else if (body.error === "GAP") offset = Number(/has (\d+) lines/.exec(body.detail ?? "")?.[1] ?? 0);
                else {
                    console.error(`events: ${r.status} ${body.error ?? ""} ${body.detail ?? ""}`);
                    break;
                }
                if (!batch.length) break;
            }
        } catch (e) {
            console.error(`hive link: ${(e as Error).message}`);
        }
        if (o.once) return;
        await new Promise((r) => setTimeout(r, o.everyMs ?? 15_000));
    }
}
