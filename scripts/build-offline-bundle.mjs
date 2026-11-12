// Builds public/offline-runtime.js: the whole demo as one browser bundle.
//
// No aliasing or module patching is involved. The database, messaging and access
// modules in server/_shared are already the in-memory implementations, and none of
// them imports a Node built-in, so the same files the local server runs are the ones
// that go into the browser.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { DEFAULT_DATASET, resolveDataset } from "../data/datasets.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

// Which scenario this bundle contains. A browser has no environment to read, so the
// choice is compiled in here — the same HEARTH_DATASET the local server reads, but
// fixed at build time. Resolved first so a typo fails the build instead of shipping
// a bundle that quietly contains the wrong scenario.
const dataset = resolveDataset(process.env.HEARTH_DATASET || DEFAULT_DATASET);

await build({
  entryPoints: [here("./offline-entry.mjs")],
  outfile: here("../public/offline-runtime.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
  legalComments: "none",
  define: {
    __HEARTH_DATASET__: JSON.stringify(dataset.id),
  },
});

console.log(`Built public/offline-runtime.js [${dataset.id}] (fictional data; no SDKs, no credentials).`);
