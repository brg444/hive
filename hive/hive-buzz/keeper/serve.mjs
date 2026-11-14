// Serves a console a keeper built themselves, on their own machine: the page and its script come from
// the keeper's checkout, so no host is trusted for the code that holds the key.
//
//   node keeper/build.mjs dist/keeper --mainnet
//   node keeper/serve.mjs dist/keeper [--port 8788]
//
// Open http://localhost:8788 and restore the key from its backup file: a passkey belongs to the
// address it was made at, so this console gets a passkey of its own. The hive's desk takes calls
// from a page served on this machine.
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--")) ?? "dist/keeper";
const at = args.indexOf("--port");
const port = at >= 0 ? Number(args[at + 1]) : 8788;
const files = { "/": ["index.html", "text/html; charset=utf-8"], "/index.html": ["index.html", "text/html; charset=utf-8"], "/console.js": ["console.js", "text/javascript; charset=utf-8"] };
const headers = {
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cache-control": "no-store",
};
http.createServer((req, res) => {
    const file = files[new URL(req.url ?? "/", "http://localhost").pathname];
    if (req.method !== "GET" || !file) return res.writeHead(404).end();
    res.writeHead(200, { ...headers, "content-type": file[1] }).end(readFileSync(join(dir, file[0])));
}).listen(port, "127.0.0.1", () => console.log(`keeper console on http://localhost:${port}`));
