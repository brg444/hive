// Build a hive's Buzz plugin folder: manifest.json + plugin.js, stamped with the hive's host.
//
//   node plugin/build.mjs --api https://hive.example.org --name "Example Hive" [--id example.hive] [--out dist]
//
// Each hive gets its own plugin, because Buzz only lets a plugin call the exact HTTPS origins its
// manifest declares, and the community owner reviews that origin when installing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const api = arg("--api");
const name = arg("--name", "Hive");
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "hive";
const id = arg("--id", `${slug}.hive`);
const out = join(arg("--out", "dist"), id);

const fail = (m) => { console.error(`build: ${m}`); process.exit(1); };
let origin;
try { origin = new URL(api); } catch { fail("--api must be the hive host's HTTPS origin"); }
if (origin.protocol !== "https:" || origin.origin !== api) fail("--api must be an exact HTTPS origin: scheme and host, no path or trailing slash");
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
    host: { networkOrigins: [api] },
};
const here = dirname(fileURLToPath(import.meta.url));
// The proposal format is shared with the bot, so the text a member sends is exactly what the hive
// acts on. Buzz plugins are one file with no imports, so it is inlined here without its exports.
const proposal = readFileSync(join(here, "../shared/proposal.mjs"), "utf8").replace(/^export\s+/gm, "");
const js = readFileSync(join(here, "plugin.template.js"), "utf8")
    .replace("/*__PROPOSAL__*/", () => proposal)
    .replace("__HIVE_API__", api)
    .replace("__PLUGIN_ID__", id)
    .replace("__HIVE_NAME__", JSON.stringify(name).slice(1, -1));
if (/__[A-Z_]+__/.test(js)) fail("unfilled placeholder");
if (/^\s*import\s/m.test(js)) fail("plugin.js must have no imports");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(out, "plugin.js"), js);
console.log(out);
