// hive-api: serves `GET /hive/v1/state` for a hive's Buzz plugin. Run it on the hive's host,
// behind TLS: the plugin may only call the exact HTTPS origin its manifest declares.
//
//   node src/server.mjs --name "Hive" --agent-log <pay-arkade buyer log> \
//     --treasury <ark1... address> --operator https://arkade.computer \
//     [--lightning-address name@lnurl.arkade.sh --lnurl-token-file <file>] [--port 8787] \
//     [--agent-console http://127.0.0.1:3131 [--serve-invite]] [--governance <file>]
//     [--channel <channel UUID> (--keepers <npub or hex,…> | --bot <HiveBot's pubkey>)
//      [--members-file <path>] [--model <id>] [--threshold 2] [--small-sats 20000] [--discussion-minutes <n>]]
//     [--desk <https url of the signing desk>] [--console <https url of the keeper console>]
//     [--tls-cert <pem> --tls-key <pem>]
//
// With --channel, members' Hive plugins forward the channel's signed events to POST /hive/v1/channel,
// and hive-api works out the governance itself and writes it to --governance, with the agent's
// members file to --members-file: the host needs no Buzz key. --discussion-minutes gives every
// proposal one discussion length, for a test hive.
//
// With --tls-cert and --tls-key it serves HTTPS itself, which is enough to try the plugin on one
// machine with a locally trusted certificate (mkcert localhost); a public host puts it behind its
// usual TLS proxy instead.
//
// With --agent-console the state names the agent's node id, which members install with. With
// --serve-invite as well, `GET /hive/v1/invite` returns the agent's current mesh invite as text, so
// providers and members can keep their --join-file current after the agent restarts. Unless the mesh
// admits only trusted owners, anyone holding the invite can join it (though not spend: providers and
// members are still named), so it is off unless asked for.
import http from "node:http";
import https from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { renameSync, writeFileSync } from "node:fs";
import { bech32 } from "@scure/base";
import { governanceFrom, mergeEvents } from "./channel.mjs";
import { agentFromStatus, arkadePkScript, contributionsFromPayments, hiveState, jobsFromLog, proposalsFromLog } from "./state.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const cfg = {
    name: arg("--name", "Hive"),
    agentLog: arg("--agent-log"),
    treasury: arg("--treasury"),
    operator: arg("--operator", "https://arkade.computer").replace(/\/+$/, ""),
    lightningAddress: arg("--lightning-address"),
    lnurlTokenFile: arg("--lnurl-token-file"),
    port: Number(arg("--port", "8787")),
    host: arg("--host", "127.0.0.1"),
    agentConsole: arg("--agent-console")?.replace(/\/+$/, ""),
    // Where the hive's bot writes proposals, keepers and members' nodes (hive-bot run --keepers ...),
    // or where hive-api writes them itself from the forwarded channel (--channel).
    governance: arg("--governance"),
    channel: arg("--channel"),
    keepers: arg("--keepers")?.split(",").map((k) => k.trim()).filter(Boolean),
    bot: arg("--bot"),
    membersFile: arg("--members-file"),
    model: arg("--model"),
    threshold: Number(arg("--threshold", "2")),
    smallSats: Number(arg("--small-sats", "20000")),
    discussionSeconds: arg("--discussion-minutes") ? Math.round(Number(arg("--discussion-minutes")) * 60) : undefined,
    desk: arg("--desk"),
    keeperConsole: arg("--console"),
    serveInvite: argv.includes("--serve-invite"),
    cacheMs: Number(arg("--cache-secs", "15")) * 1000,
    tlsCert: arg("--tls-cert"),
    tlsKey: arg("--tls-key"),
};
if (Boolean(cfg.tlsCert) !== Boolean(cfg.tlsKey)) {
    console.error("--tls-cert and --tls-key go together");
    process.exit(2);
}
if (cfg.serveInvite && !cfg.agentConsole) {
    console.error("--serve-invite needs --agent-console");
    process.exit(2);
}
/** A Buzz public key as hex, from hex or an npub. */
function pubkeyHex(value) {
    if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
    const { prefix, words } = bech32.decode(value, 1000);
    if (prefix !== "npub") throw new Error(`not a public key: ${value}`);
    return Buffer.from(bech32.fromWords(words)).toString("hex");
}
if (cfg.keepers) cfg.keepers = cfg.keepers.map(pubkeyHex);
if (cfg.bot) cfg.bot = pubkeyHex(cfg.bot);
if (cfg.channel && (!cfg.governance || (!cfg.keepers && !cfg.bot))) {
    console.error("--channel needs --governance, and --keepers or --bot");
    process.exit(2);
}
// A new hive has no treasury until its keepers' keys are in: hive-api runs without one meanwhile,
// collecting the channel, and is restarted with --treasury once the treasury is built.
if (!cfg.agentLog) {
    console.error("--agent-log is required");
    process.exit(2);
}
const treasuryScript = cfg.treasury ? arkadePkScript(cfg.treasury) : null;
// Some operators sit behind a CDN that refuses anonymous user agents.
const headers = { "user-agent": "hive-api/0.1" };

async function treasuryBalance() {
    if (!treasuryScript) return null;
    const res = await fetch(`${cfg.operator}/v1/indexer/vtxos?scripts=${treasuryScript}&spendableOnly=true`, { headers });
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const { vtxos = [] } = await res.json();
    return vtxos.reduce((n, v) => n + Number(v.amount), 0);
}

async function contributions() {
    if (!cfg.lightningAddress || !cfg.lnurlTokenFile) return [];
    const [handle, domain] = cfg.lightningAddress.split("@");
    const token = JSON.parse(readFileSync(cfg.lnurlTokenFile, "utf8")).token;
    const res = await fetch(`https://${domain}/lnurl/address/${handle}/payments`, { headers: { ...headers, authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`lnurl ${res.status}`);
    return contributionsFromPayments(await res.json());
}

async function agent() {
    if (!cfg.agentConsole) return null;
    const res = await fetch(`${cfg.agentConsole}/api/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`agent console ${res.status}`);
    return agentFromStatus(await res.json());
}

function writeAtomic(path, value) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path);
}

const storePath = () => `${cfg.governance}.events.json`;
function storedEvents() {
    try { return JSON.parse(readFileSync(storePath(), "utf8")); } catch { return []; }
}

/** Recomputes the governance from the channel's events, with each proposal's usage from the agent's log. */
function coordinateChannel(events) {
    let log = "";
    try { log = readFileSync(cfg.agentLog, "utf8"); } catch { /* no usage yet */ }
    const usage = Object.fromEntries(proposalsFromLog(log).map((p) => [p.proposal, p.usedSats]));
    const { governance, members } = governanceFrom(events, {
        channelId: cfg.channel, keepers: cfg.keepers, bot: cfg.bot, threshold: cfg.threshold, smallSats: cfg.smallSats,
        discussionSeconds: cfg.discussionSeconds, model: cfg.model,
    }, usage);
    writeAtomic(cfg.governance, governance);
    if (cfg.membersFile) writeAtomic(cfg.membersFile, members);
    cached = { at: 0, body: null };
    return governance;
}

/** Forwarded events from a member's plugin: verified, merged, and the governance worked out again. */
async function receiveChannel(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw Object.assign(new Error("too large"), { status: 413 });
        chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const { events, added, refused } = mergeEvents(storedEvents(), body?.events, cfg.channel);
    if (added) writeAtomic(storePath(), events);
    const governance = added || !existsSync(cfg.governance) ? coordinateChannel(events) : null;
    return { added, refused, events: events.length, proposals: governance?.proposals.length ?? null };
}

function governanceFile() {
    if (!cfg.governance) return null;
    try { return JSON.parse(readFileSync(cfg.governance, "utf8")); } catch { return null; }
}

// One shared snapshot, refreshed at most every 15 seconds (--cache-secs) however many members are looking.
let cached = { at: 0, body: null };
async function snapshot() {
    if (cached.body && Date.now() - cached.at < cfg.cacheMs) return cached.body;
    const [balance, chips, node] = await Promise.all([
        treasuryBalance().catch(() => null),
        contributions().catch(() => []),
        agent().catch(() => null),
    ]);
    const log = readFileSync(cfg.agentLog, "utf8");
    const jobs = jobsFromLog(log);
    const body = JSON.stringify(hiveState({
        name: cfg.name,
        chipIn: { lightningAddress: cfg.lightningAddress ?? null, arkadeAddress: cfg.treasury ?? null },
        treasury: cfg.treasury ? { address: cfg.treasury, balanceSats: balance } : null,
        jobs,
        contributions: chips,
        proposals: proposalsFromLog(log),
        agent: node,
        // Before any member's plugin has forwarded the channel, the channel alone, so plugins know which to forward.
        governance: governanceFile() ?? (cfg.channel ? { v: 1, channelId: cfg.channel, keepers: cfg.keepers ?? [], threshold: cfg.threshold,
            smallSats: cfg.smallSats, ...(cfg.discussionSeconds !== undefined ? { discussionSeconds: cfg.discussionSeconds } : {}),
            updatedAt: Math.floor(Date.now() / 1000), proposals: [], members: {} } : null),
        ...(cfg.desk || cfg.keeperConsole ? { keepersDesk: { desk: cfg.desk ?? null, console: cfg.keeperConsole ?? null } } : {}),
    }));
    cached = { at: Date.now(), body };
    return body;
}

// Discussions close and budgets run out with time alone: the governance is worked out again each minute.
if (cfg.channel) setInterval(() => { try { if (storedEvents().length) coordinateChannel(storedEvents()); } catch { /* next minute */ } }, 60_000).unref();

const tls = cfg.tlsCert ? { cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey) } : null;
(tls ? https.createServer.bind(null, tls) : http.createServer)(async (req, res) => {
    if (req.method === "GET" && req.url === "/hive/v1/state") {
        try {
            const body = await snapshot();
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
        } catch (e) {
            res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e.message ?? e) }));
        }
    } else if (req.method === "GET" && req.url === "/hive/v1/invite" && cfg.serveInvite) {
        // Read fresh each time: the invite changes the moment the agent restarts.
        const node = await agent().catch(() => null);
        if (node) res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end(node.invite + "\n");
        else res.writeHead(503, { "content-type": "text/plain" }).end("the hive's agent is not reachable\n");
    } else if (req.method === "POST" && req.url === "/hive/v1/channel" && cfg.channel) {
        try {
            const out = await receiveChannel(req);
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
        } catch (e) {
            res.writeHead(e.status ?? 400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e.message ?? e) }));
        }
    } else if (req.url === "/healthz") {
        res.writeHead(200).end("ok");
    } else {
        res.writeHead(404).end();
    }
}).listen(cfg.port, cfg.host, () => console.log(`hive-api on ${tls ? "https" : "http"}://${cfg.host}:${cfg.port}`));
