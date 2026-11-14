// Builds the keeper console into one folder for a static host: index.html and console.js, with the
// hive's checking and signing code and the curve library bundled in, so the page loads nothing from
// anywhere else.
//
//   node keeper/build.mjs <out dir> [--mainnet]
//
// The test networks' console says it is for trying Hive; with --mainnet the build is the console a
// hive's host serves for real funds, and says so instead.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "dist/keeper";
mkdirSync(out, { recursive: true });

// The hive's shared code reaches for a few Node modules at its edges; the console gets stand-ins.
const shims = {
    name: "node-shims",
    setup(b) {
        b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: join(here, "shims/node-crypto.mjs") }));
        b.onResolve({ filter: /^node:/ }, () => ({ path: join(here, "shims/node-none.mjs") }));
        // The Operator's execution routes are the desk's business, never the console's.
        b.onResolve({ filter: /^@hive\/executor$|^@arkade-os\/sdk/ }, () => ({ path: join(here, "shims/no-executor.mjs") }));
    },
};
// The packages resolve their own dependencies from the repository's node_modules.
const root = join(here, "../../..");
await build({
    entryPoints: [join(here, "console.mjs")],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    legalComments: "eof",
    outfile: join(out, "console.js"),
    plugins: [shims],
    inject: [join(here, "shims/buffer.mjs")],
    nodePaths: [join(root, "node_modules"), join(here, "../node_modules")],
    define: { "process.env": "{}", "import.meta.dirname": '"/"', __HIVE_MAINNET__: process.argv.includes("--mainnet") ? "true" : "false" },
    alias: Object.fromEntries(["kit", "ark", "steward", "protocol", "hive", "agent", "provider"].map((p) => [`@hive/${p}`, join(root, `packages/${p}/src/index.ts`)])),
    logLevel: "warning",
});
const TEST_NOTE = "This console is for test networks. Keys made here are for trying Hive; mainnet keys get a console of their own.";
const MAINNET_NOTE = "This console signs for real Bitcoin. Keep your backup file and its passphrase apart, and sign only payments you have checked.";
const page = readFileSync(join(here, "index.html"), "utf8");
if (!page.includes(TEST_NOTE)) throw new Error("the console's network note moved; update build.mjs");
const LOCAL = " http://127.0.0.1:* http://localhost:*";
if (!page.includes(`connect-src https:${LOCAL};`)) throw new Error("the console's connect-src moved; update build.mjs");
// The mainnet console talks to HTTPS hosts only: no desk on this device's own ports.
const mainnetPage = page.replace(TEST_NOTE, MAINNET_NOTE).replace(`connect-src https:${LOCAL};`, "connect-src https:;");
// The page names its one script by hash: a browser runs console.js only as this build made it.
const SCRIPT = '<script type="module" src="console.js"></script>';
if (!page.includes(SCRIPT)) throw new Error("the console's script tag moved; update build.mjs");
const integrity = `sha384-${createHash("sha384").update(readFileSync(join(out, "console.js"))).digest("base64")}`;
const pinned = (html) => html.replace(SCRIPT, `<script type="module" src="console.js" integrity="${integrity}"></script>`);
writeFileSync(join(out, "index.html"), pinned(process.argv.includes("--mainnet") ? mainnetPage : page));
// The build is the same byte for byte from the same commit, so keepers can compare what their host
// serves with what they build themselves, or with the hashes published with a release.
const sums = ["index.html", "console.js"]
    .map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`)
    .join("\n");
writeFileSync(join(out, "SHA256SUMS"), `${sums}\n`);
console.log(out);
console.log(sums);
