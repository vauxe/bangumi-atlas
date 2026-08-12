/** Repeatable hot-path benchmarks against the locally rebuilt SiteRelease. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { nearestAlongRay } from "../src/anchor";

interface PublishedFile {
  0: number;
  1: string;
  2: string;
}

interface LocalManifest {
  n_nodes: number;
  version: string;
  files: Record<string, PublishedFile>;
}

const scenario = process.argv[2];
if (scenario !== "anchor")
  throw new TypeError("frontend scenario must be anchor");

const runCount = Number(process.env["FRONTEND_BENCH_RUNS"] ?? 7);
if (!Number.isSafeInteger(runCount) || runCount < 1 || runCount > 30)
  throw new TypeError("FRONTEND_BENCH_RUNS must be an integer from 1 to 30");

const siteDir = resolve(process.env["ATLAS_SITE_DIR"] ?? "../site");
const manifest = JSON.parse(
  readFileSync(resolve(siteDir, "data/manifest.json"), "utf8"),
) as LocalManifest;
const positionObject = manifest.files["positions.bin"]?.[2];
if (!positionObject) throw new TypeError("manifest has no positions.bin object");
const positionBytes = readFileSync(resolve(siteDir, "data", positionObject));
assert.equal(positionBytes.byteLength, manifest.n_nodes * 12);
const positions = new Float32Array(
  positionBytes.buffer,
  positionBytes.byteOffset,
  positionBytes.byteLength / 4,
);

const rays = [
  { origin: [0, 0, 1_000], dir: [0, 0, -1] },
  { origin: [0, 0, 1_000], dir: [0.1, 0.1, -0.9899494937] },
  { origin: [-600, 200, 700], dir: [0.6, -0.2, -0.7745966692] },
] as const;
const tanCutoff = 60 / 960;
const execute = (): number[] => rays.map(({ origin, dir }) =>
  nearestAlongRay(
    positions,
    manifest.n_nodes,
    origin,
    dir,
    tanCutoff,
  )
);

for (let index = 0; index < 2; index++) execute();
const expected = execute();
const samples: number[] = [];
for (let index = 0; index < runCount; index++) {
  globalThis.gc?.();
  const started = performance.now();
  const ranks = execute();
  samples.push(Number((performance.now() - started).toFixed(2)));
  assert.deepEqual(ranks, expected, "anchor ranks changed between runs");
}
samples.sort((left, right) => left - right);
console.log(JSON.stringify({
  scenario,
  releaseId: manifest.version,
  nodes: manifest.n_nodes,
  rays: rays.length,
  ranks: expected,
  runs: samples,
  median: samples[Math.floor(samples.length / 2)],
}, null, 2));
