// hive-api: serves `GET /hive/v1/state` for a hive's Buzz plugin. Run it on the hive's host,
// behind TLS: the plugin may only call the exact HTTPS origin its manifest declares.
//
//   node src/server.mjs --name "Hive" --agent-log <pay-arkade buyer log> \
//     --treasury <ark1... address> --operator https://arkade.computer \
//     [--lightning-address name@lnurl.arkade.sh --lnurl-token-file <file>] [--port 8787] \
//     [--agent-console http://127.0.0.1:3131 [--serve-invite]] [--governance <file>]
//     [--tls-cert <pem> --tls-key <pem>]
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
import { readFileSync } from "node:fs";
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
    // Where the hive's bot writes proposals, keepers and members' nodes (hive-bot run --keepers ...).
    governance: arg("--governance"),
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
if (!cfg.agentLog || !cfg.treasury) {
    console.error("--agent-log and --treasury are required");
    process.exit(2);
}
const treasuryScript = arkadePkScript(cfg.treasury);
// Some operators sit behind a CDN that refuses anonymous user agents.
const headers = { "user-agent": "hive-api/0.1" };

async function treasuryBalance() {
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
        chipIn: { lightningAddress: cfg.lightningAddress ?? null, arkadeAddress: cfg.treasury },
        treasury: { address: cfg.treasury, balanceSats: balance },
        jobs,
        contributions: chips,
        proposals: proposalsFromLog(log),
        agent: node,
        governance: governanceFile(),
    }));
    cached = { at: Date.now(), body };
    return body;
}

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
    } else if (req.url === "/healthz") {
        res.writeHead(200).end("ok");
    } else {
        res.writeHead(404).end();
    }
}).listen(cfg.port, cfg.host, () => console.log(`hive-api on ${tls ? "https" : "http"}://${cfg.host}:${cfg.port}`));
