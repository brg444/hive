// Builds the keeper console into one folder for a static host: index.html and console.js, with the
// curve library bundled in, so the page loads nothing from anywhere else.
//
//   node keeper/build.mjs <out dir>
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? "dist/keeper";
mkdirSync(out, { recursive: true });
await build({ entryPoints: [join(here, "console.mjs")], bundle: true, format: "esm", target: "es2022", minify: true, legalComments: "eof", outfile: join(out, "console.js") });
copyFileSync(join(here, "index.html"), join(out, "index.html"));
console.log(out);
