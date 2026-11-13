// The Hive guide's reading: the repository's documentation for people using a hive, in one Markdown
// file the demo site serves beside the hive's state. The plugin's hive_docs tool reads it and hands
// the guide the sections a question needs.
//
//   node demo/make-docs.mjs <out file> <doc> [<doc> ...]      (paths relative to the repository root)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [out, ...docs] = process.argv.slice(2);
if (!out || !docs.length) throw new Error("usage: make-docs.mjs <out file> <doc> [<doc> ...]");
const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const parts = docs.map((doc) => `<!-- source: ${doc} -->\n\n${readFileSync(join(repo, doc), "utf8").trim()}\n`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, parts.join("\n"));
console.log(out);
