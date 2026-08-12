import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

const outdir = resolve(process.env.ATLAS_SITE_DIR ?? "../site");
rmSync(resolve(outdir, "chunks"), { recursive: true, force: true });

const [appBuild] = await Promise.all([
  build({
    entryPoints: { app: "src/main.ts" },
    bundle: true,
    minify: true,
    format: "esm",
    splitting: true,
    outdir,
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    metafile: true,
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

const outputs = appBuild.metafile.outputs;
const entry = Object.entries(outputs).find(
  ([, output]) => output.entryPoint === "src/main.ts",
)?.[0];
if (!entry) throw new Error("main build has no app entry");
const initial = new Set();
const visitStatic = (path) => {
  if (initial.has(path)) return;
  const output = outputs[path];
  if (!output) throw new Error(`main build import ${path} is missing`);
  initial.add(path);
  for (const dependency of output.imports)
    if (dependency.kind !== "dynamic-import") visitStatic(dependency.path);
};
visitStatic(entry);
const gzipBytes = (paths) => [...paths].reduce(
  (sum, path) => sum + gzipSync(readFileSync(resolve(path)), { level: 9 }).byteLength,
  0,
);
const initialRaw = [...initial].reduce(
  (sum, path) => sum + (outputs[path]?.bytes ?? 0),
  0,
);
const initialGzip = gzipBytes(initial);
const totalGzip = gzipBytes(Object.keys(outputs));
if (initialRaw > 850_000 || initialGzip > 245_000 || totalGzip > 290_000)
  throw new Error(
    `app bundle budget exceeded: initial ${initialRaw}/${initialGzip} gzip, ` +
      `all ${totalGzip} gzip`,
  );
console.log(
  `app initial ${initialRaw.toLocaleString()} bytes / ` +
    `${initialGzip.toLocaleString()} gzip; all chunks ${totalGzip.toLocaleString()} gzip`,
);
