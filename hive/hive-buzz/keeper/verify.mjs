// Compares the console a host serves with the one this checkout builds. The build is the same byte
// for byte from the same commit, so a host that serves anything else is serving other code.
//
//   node keeper/verify.mjs https://keeper.example.org [--mainnet]
//
// Exits 0 when both files match, 1 when either differs. It shows what the host serves to whoever
// runs this, at the moment it runs: a keeper who wants no host in the way of their key builds the
// console and serves it themselves (keeper/serve.mjs).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const address = args.find((a) => !a.startsWith("--"));
if (!address) {
    console.error("usage: node keeper/verify.mjs <console address> [--mainnet]");
    process.exit(2);
}
const base = address.replace(/\/+$/, "");
const out = mkdtempSync(join(tmpdir(), "hive-keeper-"));
let differs = false;
try {
    execFileSync("node", [join(here, "build.mjs"), out, ...(args.includes("--mainnet") ? ["--mainnet"] : [])], { stdio: "ignore" });
    const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
    for (const [file, path] of [["index.html", "/"], ["console.js", "/console.js"]]) {
        const res = await fetch(`${base}${path}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`${base}${path} answered ${res.status}`);
        const [served, built] = [sha256(Buffer.from(await res.arrayBuffer())), sha256(readFileSync(join(out, file)))];
        const same = served === built;
        differs ||= !same;
        console.log(`${same ? "same   " : "DIFFERS"}  ${file}  served ${served}  built ${built}`);
    }
} finally {
    rmSync(out, { recursive: true, force: true });
}
if (differs) console.error("The host serves a console this checkout does not build. Check the commit and the network (--mainnet); if both are right, do not unlock a key there.");
process.exit(differs ? 1 : 0);
