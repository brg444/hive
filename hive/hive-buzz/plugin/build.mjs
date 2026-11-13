// Build a hive's Buzz plugin folder: manifest.json + plugin.js, stamped with the hive's host.
//
//   node plugin/build.mjs --api https://hive.example.org --name "Example Hive" [--id example.hive] [--out dist]
//       [--channel <the hive's channel UUID> --keepers <npub or hex, comma-separated> [--threshold 2] [--small-sats 20000]]
//       [--install <https Git repository>#<branch>] [--console <keeper console HTTPS address>]
//       [--docs <the repository's docs, as one Markdown file on the --api origin>]
//
// --api is the hive host's HTTPS address; it may carry a path (https://example.github.io/hive/demo),
// and the manifest grants only its origin. With --channel and --keepers the plugin knows the hive's
// channel and keepers by itself; without them it takes them from the host. --install says where
// members get the plugin, for HiveBot's onboarding.
//
// Each hive gets its own plugin, because Buzz only lets a plugin call the exact HTTPS origins its
// manifest declares, and the community owner reviews that origin when installing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bech32 } from "@scure/base";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const api = arg("--api");
const name = arg("--name", "Hive");
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "hive";
const id = arg("--id", `${slug}.hive`);
const out = join(arg("--out", "dist"), id);

const fail = (m) => { console.error(`build: ${m}`); process.exit(1); };
let origin;
try { origin = new URL(api); } catch { fail("--api must be the hive host's HTTPS address"); }
if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || api.endsWith("/")
    || api !== origin.origin + origin.pathname.replace(/\/+$/, "").replace(/^\/$/, "")) {
    fail("--api must be an HTTPS address with no query, credentials or trailing slash, such as https://hive.example.org or https://example.github.io/hive/demo");
}

// The hive's channel and keepers, built in when given.
const keeperKey = (text) => {
    const k = text.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(k)) return k;
    try {
        const { prefix, words } = bech32.decode(k);
        const bytes = bech32.fromWords(words);
        if (prefix === "npub" && bytes.length === 32) return Buffer.from(bytes).toString("hex");
    } catch { /* not an npub */ }
    return fail(`not a public key: ${text}`);
};
let config = null;
if (arg("--channel") || arg("--keepers")) {
    const channelId = arg("--channel") ?? fail("--keepers needs --channel");
    if (!/^[0-9a-f-]{36}$/i.test(channelId)) fail("--channel is the channel's ID, as Buzz shows it under View channel details");
    const keepers = (arg("--keepers") ?? fail("--channel needs --keepers")).split(",").filter(Boolean).map(keeperKey);
    const threshold = Number(arg("--threshold", "2"));
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > keepers.length) fail("--threshold must be between 1 and the number of keepers");
    config = { channelId: channelId.toLowerCase(), keepers, threshold, smallSats: Number(arg("--small-sats", "20000")) };
}
// Buzz's rules for plugin ids and names (docs/plugin-authoring-guide.md).
if (!/^[a-z][a-z0-9.-]*$/.test(id) || id.length > 80 || /\.\.|-\.|\.-|\.$/.test(id)) fail(`invalid plugin id ${id}`);
if (Buffer.byteLength(name) < 1 || Buffer.byteLength(name) > 80) fail("name must be 1-80 bytes");

const description = `${name} inside its community: proposals as cards, a Propose button, your allowances, the treasury, chip-ins, jobs and what waits for keepers.`;
const manifest = {
    id,
    name,
    apiVersion: 1,
    description: Buffer.byteLength(description) <= 280 ? description : description.slice(0, 270),
    discovery: { category: "people-and-communities", tags: ["Bitcoin", "Arkade", "Hive", "AI"] },
    host: { networkOrigins: [origin.origin] },
};
const here = dirname(fileURLToPath(import.meta.url));
// The proposal format is shared with the bot, so the text a member sends is exactly what the hive
// acts on. Buzz plugins are one file with no imports, so it is inlined here without its exports.
const proposal = readFileSync(join(here, "../shared/proposal.mjs"), "utf8").replace(/^export\s+/gm, "");
// The bot's coordinator, in its own scope: the plugin works out where proposals stand by the same rules.
const inline = (file, names) => `const { ${names} } = (() => {\n${readFileSync(join(here, file), "utf8")
    .replace(/^import .*$/gm, "").replace(/^export\s+/gm, "")}\nreturn { ${names} };\n})();`;
const coordinator = inline("../bot/coordinator.mjs", "coordinate");
// HiveBot's onboarding, the same steps the server bot posts.
const onboarding = inline("../bot/onboard.mjs", "onboardingPlan, recordFromChannel");
// What the Hive guide knows, and the instructions it starts with.
const guide = readFileSync(join(here, "../shared/guide.mjs"), "utf8").replace(/^export\s+/gm, "");
// Where members install the plugin from, for HiveBot to tell them: a Git repository and branch.
const install = arg("--install");
// The repository's documentation, for the Hive guide: on the same origin the manifest grants.
const docs = arg("--docs");
if (docs) {
    let u;
    try { u = new URL(docs); } catch { fail("--docs is an HTTPS address"); }
    if (u.origin !== origin.origin) fail("--docs must be on the same origin as --api, the one the plugin may call");
}
// The keeper console's address, where keepers create their treasury keys and sign payments.
const keeperConsole = arg("--console");
if (keeperConsole && !/^https:\/\/[^\s]+$/.test(keeperConsole)) fail("--console is the keeper console's HTTPS address");
if (install && !/^https:\/\/[^\s#]+#[A-Za-z0-9._/-]+$/.test(install)) fail("--install is <https Git repository>#<branch>");
const js = readFileSync(join(here, "plugin.template.js"), "utf8")
    .replace("/*__PROPOSAL__*/", () => proposal)
    .replace("/*__COORDINATOR__*/", () => coordinator)
    .replace("/*__ONBOARDING__*/", () => onboarding)
    .replace("/*__GUIDE__*/", () => guide)
    .replace("/*__INSTALL__*/null", () => JSON.stringify(install ?? null))
    .replace("/*__CONSOLE__*/null", () => JSON.stringify(keeperConsole ?? null))
    .replace("/*__DOCS__*/null", () => JSON.stringify(docs ?? null))
    .replace("/*__HIVE_CONFIG__*/null", () => JSON.stringify(config))
    .replace("__HIVE_API__", api)
    .replace("__PLUGIN_ID__", id)
    .replace("__HIVE_NAME__", JSON.stringify(name).slice(1, -1));
if (/__[A-Z_]+__/.test(js)) fail("unfilled placeholder");
if (/^\s*import\s/m.test(js)) fail("plugin.js must have no imports");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(out, "plugin.js"), js);
console.log(out);
