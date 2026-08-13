/** Repeatable real-release query benchmark.
 *
 * Start `npm run serve:smoke`, then run one isolated scenario, for example:
 * `npm run bench:query -- aggregate`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { Data } from "../src/data";
import { loadManifest } from "../src/loader";
import type { QuerySection } from "../src/query/bundle";
import { executeQuery } from "../src/query/engine";
import { compileExplorerQuery } from "../src/query/explorer";
import { fullTextRecipe } from "../src/query/recipes";
import { SiteQuerySearchIndex } from "../src/query/site-search";
import { SiteQueryDataSource } from "../src/query/site-source";
import type { Owner } from "../src/query/contract";

type Scenario = "lookup" | "scan" | "scan-wide" | "aggregate" | "fulltext";

interface Sample {
  elapsed: number;
  requests: number;
  bytes: number;
  resources: {
    path: string;
    requests: number;
    bytes: number;
  }[];
  rows: number;
  totalMatches: number;
  signature: string;
}

const scenario = process.argv[2] as Scenario | undefined;
const scenarios: readonly Scenario[] = [
  "lookup",
  "scan",
  "scan-wide",
  "aggregate",
  "fulltext",
];
if (!scenario || !scenarios.includes(scenario))
  throw new TypeError(
    "scenario must be lookup, scan, scan-wide, aggregate, or fulltext",
  );

const runCount = Number(process.env["QUERY_BENCH_RUNS"] ?? 5);
if (!Number.isSafeInteger(runCount) || runCount < 1 || runCount > 20)
  throw new TypeError("QUERY_BENCH_RUNS must be an integer from 1 to 20");
const forceSubjectRowScan =
  process.env["QUERY_BENCH_FORCE_SUBJECT_ROW_SCAN"] === "1";

const base = process.env["SMOKE_BASE"] ?? "http://127.0.0.1:8391";
const realFetch = globalThis.fetch;
let requests = 0;
let bytes = 0;
const resources = new Map<string, { requests: number; bytes: number }>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(
    typeof input === "string" ? new URL(input, `${base}/`) : input,
    init,
  );
  const response = await realFetch(request);
  requests++;
  let responseBytes = 0;
  const contentLengthHeader = response.headers.get("Content-Length");
  const contentLength = Number(contentLengthHeader);
  if (contentLengthHeader !== null && Number.isFinite(contentLength)) {
    bytes += contentLength;
    responseBytes = contentLength;
  }
  else {
    const range = /^bytes (\d+)-(\d+)\//.exec(
      response.headers.get("Content-Range") ?? "",
    );
    if (range) {
      responseBytes = Number(range[2]) - Number(range[1]) + 1;
      bytes += responseBytes;
    }
  }
  const path = new URL(request.url).pathname.replace(/^.*\/data\//, "");
  const resource = resources.get(path) ?? { requests: 0, bytes: 0 };
  resource.requests++;
  resource.bytes += responseBytes;
  resources.set(path, resource);
  return response;
}) as typeof fetch;

const manifest = await loadManifest();
const runtimeManifest = forceSubjectRowScan && manifest.query
  ? {
    ...manifest,
    query: {
      ...manifest.query,
      capabilities: manifest.query.capabilities.filter(
        (capability) => !capability.startsWith("subject-query-columns-v"),
      ),
    },
  }
  : manifest;
const data = new Data(runtimeManifest);
const source = new SiteQueryDataSource(
  data,
  new SiteQuerySearchIndex(data, manifest),
  manifest.version,
);

function resultSection(owner: Owner, text: string): QuerySection {
  const columns = owner === "subject" || owner === "episode"
    ? ["ref", "name", "nameCn"]
    : ["ref", "name"];
  const section = compileExplorerQuery({
    owner,
    text: { value: text, capability: "lookup" },
    columns,
    orderBy: [],
    limit: null,
  }).sections.results;
  if (!section) throw new TypeError(`lookup section for ${owner} is missing`);
  return section;
}

function sectionsFor(selected: Scenario): [string, QuerySection, number][] {
  if (selected === "lookup") {
    const text = process.env["QUERY_BENCH_TEXT"] ?? "命运石之门";
    return (["subject", "person", "character", "episode"] as const).map(
      (owner) => [owner, resultSection(owner, text), 500],
    );
  }
  if (selected === "scan" || selected === "scan-wide") {
    const columns = selected === "scan-wide"
      ? ["ref", "name", "nameCn", "type", "date", "score", "rank"]
      : ["ref", "name", "nameCn", "score"];
    const section = compileExplorerQuery({
      owner: "subject",
      condition: { kind: "compare", field: "score", operator: "gte", value: 8 },
      columns,
      orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
      limit: 50,
    }).sections.results;
    if (!section) throw new TypeError("scan section is missing");
    return [["results", section, 50]];
  }
  if (selected === "aggregate") {
    const section = compileExplorerQuery({
      owner: "subject",
      aggregate: { groupBy: ["type"], metrics: [{ function: "count" }] },
      orderBy: [],
      limit: null,
    }).sections.results;
    if (!section) throw new TypeError("aggregate section is missing");
    return [["results", section, 50]];
  }
  const text = process.env["QUERY_BENCH_TEXT"] ?? "时间旅行";
  return Object.entries(fullTextRecipe(text).sections).map(
    ([name, section]) => [name, section, 500],
  );
}

const sections = sectionsFor(scenario);
const execute = async (): Promise<Sample> => {
  const beforeRequests = requests;
  const beforeBytes = bytes;
  const beforeResources = new Map(
    [...resources].map(([path, value]) => [path, { ...value }]),
  );
  const started = performance.now();
  const results = await Promise.all(sections.map(async ([name, section, pageSize]) => [
    name,
    await executeQuery(
      section.query,
      section.parameterValues ?? {},
      source,
      { pageSize },
    ),
  ] as const));
  return {
    elapsed: Number((performance.now() - started).toFixed(2)),
    requests: requests - beforeRequests,
    bytes: bytes - beforeBytes,
    resources: [...resources].flatMap(([path, value]) => {
      const before = beforeResources.get(path) ?? { requests: 0, bytes: 0 };
      const delta = {
        path,
        requests: value.requests - before.requests,
        bytes: value.bytes - before.bytes,
      };
      return delta.requests ? [delta] : [];
    }),
    rows: results.reduce((sum, [, result]) => sum + result.rows.length, 0),
    totalMatches: results.reduce(
      (sum, [, result]) => sum + result.totalMatches,
      0,
    ),
    signature: createHash("sha256")
      .update(JSON.stringify(results))
      .digest("hex"),
  };
};

const cold = await execute();
const warm: Sample[] = [];
for (let index = 0; index < runCount; index++) {
  globalThis.gc?.();
  const sample = await execute();
  assert.equal(sample.signature, cold.signature, "query result changed between runs");
  warm.push(sample);
}
const elapsed = warm
  .map((sample) => sample.elapsed)
  .sort((left, right) => left - right);
const median = elapsed[Math.floor(elapsed.length / 2)] as number;

console.log(JSON.stringify({
  scenario,
  subjectScanPath: forceSubjectRowScan ? "entities.pack" : "release-default",
  releaseId: manifest.version,
  cold,
  warm: {
    runs: warm,
    median,
  },
}, null, 2));
