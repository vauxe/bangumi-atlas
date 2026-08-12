/** Repeatable hot-path benchmarks against the locally rebuilt SiteRelease. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { nearestAlongRay } from "../src/anchor";
import { Data } from "../src/data";
import { nearbyLabelRanks, NEARBY_LABEL_ZOOM } from "../src/labels";
import { loadManifest } from "../src/loader";
import {
  relationNeighbors,
  resolveLoadedNeighborRanks,
} from "../src/neighbors";
import type { Fact, Mappings } from "../src/types";

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

const requestedScenario = process.argv[2];
const scenarios = [
  "anchor",
  "entity-subject",
  "entity-person",
  "entity-character",
  "neighbor-fallback",
  "nearby-labels",
  "query-visibility",
] as const;
if (!scenarios.includes(requestedScenario as (typeof scenarios)[number]))
  throw new TypeError(`frontend scenario must be ${scenarios.join(", ")}`);
const scenario = requestedScenario as (typeof scenarios)[number];

const runCount = Number(process.env["FRONTEND_BENCH_RUNS"] ?? 7);
if (!Number.isSafeInteger(runCount) || runCount < 1 || runCount > 30)
  throw new TypeError("FRONTEND_BENCH_RUNS must be an integer from 1 to 30");

const siteDir = resolve(process.env["ATLAS_SITE_DIR"] ?? "../site");
const manifest = JSON.parse(
  readFileSync(resolve(siteDir, "data/manifest.json"), "utf8"),
) as LocalManifest;

if (scenario === "anchor" || scenario === "nearby-labels") {
  const positionObject = manifest.files["positions.bin"]?.[2];
  if (!positionObject) throw new TypeError("manifest has no positions.bin object");
  const positionBytes = readFileSync(resolve(siteDir, "data", positionObject));
  assert.equal(positionBytes.byteLength, manifest.n_nodes * 12);
  const positions = new Float32Array(
    positionBytes.buffer,
    positionBytes.byteOffset,
    positionBytes.byteLength / 4,
  );
  if (scenario === "nearby-labels") {
    const targetOffset = Math.floor(manifest.n_nodes / 2) * 3;
    const target = [
      positions[targetOffset] ?? 0,
      positions[targetOffset + 1] ?? 0,
      positions[targetOffset + 2] ?? 0,
    ] as [number, number, number];
    const execute = (): number[] => nearbyLabelRanks(
      positions,
      manifest.n_nodes,
      target,
      NEARBY_LABEL_ZOOM,
      1_440,
      900,
      { visible: () => true },
    );
    for (let index = 0; index < 2; index++) execute();
    const expected = execute();
    const samples: number[] = [];
    for (let index = 0; index < runCount; index++) {
      globalThis.gc?.();
      const started = performance.now();
      const ranks = execute();
      samples.push(Number((performance.now() - started).toFixed(2)));
      assert.deepEqual(ranks, expected, "nearby label ranks changed between runs");
    }
    samples.sort((left, right) => left - right);
    console.log(JSON.stringify({
      scenario,
      releaseId: manifest.version,
      nodes: manifest.n_nodes,
      labels: expected.length,
      signature: createHash("sha256")
        .update(JSON.stringify(expected))
        .digest("hex"),
      runs: samples,
      median: samples[Math.floor(samples.length / 2)],
    }, null, 2));
    process.exit(0);
  }

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
} else if (scenario === "neighbor-fallback") {
  const keyObject = manifest.files["key.bin"]?.[2];
  if (!keyObject) throw new TypeError("manifest has no key.bin object");
  const keyBytes = readFileSync(resolve(siteDir, "data", keyObject));
  const keys = new Uint32Array(
    keyBytes.buffer,
    keyBytes.byteOffset,
    keyBytes.byteLength / 4,
  );
  const selfKey = keys[0];
  if (!selfKey) throw new TypeError("release has no first entity key");
  const facts: Fact[] = [];
  for (let index = 0; index < 200; index++) {
    const rank = manifest.n_nodes - 1 - index * 997;
    const target = keys[rank];
    if (!target) throw new TypeError(`release has no entity key at rank ${rank}`);
    facts.push({
      kind: "RELATES_TO",
      ref: index,
      multiplicity: 1,
      source: selfKey,
      target,
      relationType: 1,
      sortOrder: 0,
    });
  }
  const mappings: Mappings = {
    fact_labels: { RELATES_TO: { "1": "related" } },
    subject_type: {},
    platform: {},
    person_type: {},
    character_role: {},
    episode_type: {},
  };
  const execute = () => {
    const resolved = resolveLoadedNeighborRanks(
      facts,
      selfKey,
      keys,
      keys.length,
      () => null,
    );
    return relationNeighbors(
      facts,
      selfKey,
      mappings,
      (key) => resolved.get(key) ?? null,
      50,
    );
  };
  const expected = execute();
  const samples: number[] = [];
  for (let index = 0; index < runCount; index++) {
    globalThis.gc?.();
    const started = performance.now();
    const workingSet = execute();
    samples.push(Number((performance.now() - started).toFixed(2)));
    assert.deepEqual(workingSet, expected, "neighbor working set changed between runs");
  }
  samples.sort((left, right) => left - right);
  console.log(JSON.stringify({
    scenario,
    releaseId: manifest.version,
    nodes: manifest.n_nodes,
    facts: facts.length,
    signature: createHash("sha256")
      .update(JSON.stringify(expected))
      .digest("hex"),
    runs: samples,
    median: samples[Math.floor(samples.length / 2)],
  }, null, 2));
} else if (scenario === "query-visibility") {
  const ranks = new Uint32Array(manifest.n_nodes);
  for (let rank = 0; rank < ranks.length; rank++) ranks[rank] = rank;
  const styled = 0;
  const execute = (): boolean => {
    for (const rank of ranks) if (rank < styled) return true;
    return false;
  };
  const expected = execute();
  const samples: number[] = [];
  for (let index = 0; index < runCount; index++) {
    globalThis.gc?.();
    const started = performance.now();
    const visible = execute();
    samples.push(Number((performance.now() - started).toFixed(2)));
    assert.equal(visible, expected);
  }
  samples.sort((left, right) => left - right);
  console.log(JSON.stringify({
    scenario,
    releaseId: manifest.version,
    results: ranks.length,
    styled,
    visible: expected,
    runs: samples,
    median: samples[Math.floor(samples.length / 2)],
  }, null, 2));
} else {
  const owner = scenario.slice("entity-".length) as
    | "subject"
    | "person"
    | "character";
  const kind = owner === "subject" ? 1 : owner === "person" ? 2 : 3;
  const keyObject = manifest.files["key.bin"]?.[2];
  if (!keyObject) throw new TypeError("manifest has no key.bin object");
  const keyBytes = readFileSync(resolve(siteDir, "data", keyObject));
  const keys = new Uint32Array(
    keyBytes.buffer,
    keyBytes.byteOffset,
    keyBytes.byteLength / 4,
  );
  const key = keys.find((candidate) => candidate >>> 24 === kind);
  if (!key) throw new TypeError(`release has no ${owner} key`);

  const base = process.env["SMOKE_BASE"] ?? "http://127.0.0.1:8391";
  const realFetch = globalThis.fetch;
  let requests = 0;
  let bytes = 0;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(
      typeof input === "string" ? new URL(input, `${base}/`) : input,
      init,
    );
    const response = await realFetch(request);
    requests++;
    const length = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(length)) bytes += length;
    return response;
  }) as typeof fetch;

  await loadManifest();
  requests = 0;
  bytes = 0;
  const started = performance.now();
  const entity = await new Data().entity(key);
  const elapsed = Number((performance.now() - started).toFixed(2));
  assert.equal(entity?.kind, owner);
  console.log(JSON.stringify({
    scenario,
    releaseId: manifest.version,
    key,
    elapsed,
    requests,
    bytes,
    signature: createHash("sha256")
      .update(JSON.stringify(entity))
      .digest("hex"),
  }, null, 2));
}
