import { resolve } from "node:path";

import { build } from "esbuild";

const outdir = resolve(process.env.ATLAS_SITE_DIR ?? "../site");

await Promise.all([
  build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    minify: true,
    format: "iife",
    outfile: resolve(outdir, "app.js"),
  }),
  build({
    entryPoints: ["src/query/worker-entry.ts"],
    bundle: true,
    minify: true,
    format: "iife",
    outfile: resolve(outdir, "query-worker.js"),
  }),
  build({
    entryPoints: ["src/query/workbench.css"],
    bundle: true,
    minify: true,
    outfile: resolve(outdir, "query.css"),
  }),
]);
