import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  loadManifest,
  loadNames,
  pointByRank,
  searchShard,
} from "../src/loader";
import type { Manifest, SearchEntry } from "../src/types";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function testManifest(
  files: Record<string, [number, string]>,
  nNodes = 1,
): Manifest {
  return {
    version: "test-content-version",
    dump_version: "test-dump",
    n_nodes: nNodes,
    n_edges_skeleton: 0,
    buckets: 1,
    det_packs: 1,
    adj_inline: 1,
    eps_inline: 1,
    bbox: [
      [0, 0, 0],
      [1, 1, 1],
    ],
    year_range: [1900, 2035],
    tags: [],
    labels: [],
    hot_shards: [],
    layout: null,
    files,
    total_bytes: Object.values(files).reduce((sum, [size]) => sum + size, 0),
    n_files: Object.keys(files).length,
  };
}

async function installFetch(
  manifest: Manifest,
  load: (path: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(String(input), "https://example.test/").pathname;
    if (path.endsWith("/data/manifest.json"))
      return new Response(JSON.stringify(manifest), { status: 200 });
    return load(path, init);
  }) as typeof fetch;
  await loadManifest();
}

test("rejects a same-length names mutation that violates its hash", async () => {
  const published = encoder.encode('["A",null]\n');
  const mutated = encoder.encode('["B",null]\n');
  const manifest = testManifest({
    "names.ndjson": [published.byteLength, hash(published)],
  });
  await installFetch(manifest, async (path) => {
    assert.match(path, /names\.ndjson$/);
    return new Response(mutated, { status: 200 });
  });

  const { done } = loadNames(1);
  await assert.rejects(done, /names\.ndjson: sha256 mismatch/);
});

test("rejects a 206 response for the wrong byte range", async () => {
  const manifest = testManifest(
    {
      "positions.bin": [16, "0".repeat(64)],
      "key.bin": [8, "0".repeat(64)],
    },
    2,
  );
  await installFetch(manifest, async (path) => {
    if (path.endsWith("positions.bin"))
      return new Response(new Uint8Array(8), {
        status: 206,
        headers: { "Content-Range": "bytes 0-7/16" },
      });
    return new Response(new Uint8Array(4), {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/8" },
    });
  });

  await assert.rejects(pointByRank(manifest, 1), /Content-Range/);
});

test("reads an exact planar float32 position by rank", async () => {
  const positions = new Uint8Array(
    new Float32Array([1.25, -2.5, 3.5, 4.75]).buffer,
  );
  const keys = new Uint8Array(new Uint32Array([11, 22]).buffer);
  const manifest = testManifest(
    {
      "positions.bin": [positions.byteLength, hash(positions)],
      "key.bin": [keys.byteLength, hash(keys)],
    },
    2,
  );
  await installFetch(manifest, async (path) =>
    new Response(path.endsWith("positions.bin") ? positions : keys),
  );

  assert.deepEqual(await pointByRank(manifest, 1), {
    pos: [3.5, 0, 4.75],
    key: 22,
  });
});

test("shares one whole-pack fallback across concurrent slices", async () => {
  const first: SearchEntry[] = [["a", "A", 1]];
  const second: SearchEntry[] = [["b", "B", 2]];
  const firstGzip = gzipSync(JSON.stringify(first));
  const secondGzip = gzipSync(JSON.stringify(second));
  const pack = new Uint8Array(Buffer.concat([firstGzip, secondGzip]));
  const index = encoder.encode(
    JSON.stringify({
      "61": [0, firstGzip.byteLength],
      "62": [firstGzip.byteLength, secondGzip.byteLength],
    }),
  );
  const manifest = testManifest({
    "search.idx.json": [index.byteLength, hash(index)],
    "search.pack": [pack.byteLength, hash(pack)],
  });
  let packRequests = 0;
  await installFetch(manifest, async (path) => {
    if (path.endsWith("search.idx.json"))
      return new Response(index, { status: 200 });
    packRequests++;
    return new Response(pack, { status: 200 });
  });

  const [loadedFirst, loadedSecond] = await Promise.all([
    searchShard("a"),
    searchShard("b"),
  ]);

  assert.deepEqual(loadedFirst, first);
  assert.deepEqual(loadedSecond, second);
  assert.equal(packRequests, 1);
});
