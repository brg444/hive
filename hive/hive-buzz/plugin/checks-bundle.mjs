// How the plugin's checks are bundled: the hive's own code from packages/, with the Node modules it
// never reaches in Buzz stood in for. The plugin's build inlines the result; a test imports it as a
// module, so what it checks is what a keeper's plugin runs.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const shims = {
    name: "node-shims",
    setup(b) {
        b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: join(here, "shims/node-crypto.mjs") }));
        b.onResolve({ filter: /^node:/ }, () => ({ path: join(here, "shims/node-none.mjs") }));
        b.onResolve({ filter: /^@hive\/executor$|^@arkade-os\/sdk/ }, () => ({ path: join(here, "shims/no-executor.mjs") }));
    },
};

/** esbuild's options for `checks.mjs`, less the output's format. */
export function checksBundle() {
    return {
        entryPoints: [join(here, "checks.mjs")],
        bundle: true,
        target: "es2022",
        legalComments: "none",
        plugins: [shims],
        inject: [join(here, "shims/buffer.mjs")],
        nodePaths: [join(root, "node_modules"), join(here, "../node_modules")],
        define: { "process.env": "{}", "import.meta.dirname": '"/"' },
        alias: Object.fromEntries(["kit", "ark", "steward", "protocol", "hive", "agent", "provider", "treasury"].map((p) => [`@hive/${p}`, join(root, `packages/${p}/src/index.ts`)])),
        logLevel: "warning",
    };
}
