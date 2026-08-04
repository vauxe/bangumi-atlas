import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  loadManifest,
  member,
  openNames,
  openGeometry,
  pointByRank,
  rankOfKey,
  ensureRankIndex,
  releaseWasReplaced,
  ReleaseChangedError,
} from "../src/loader";
import type { Manifest, NameRow } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function testManifest(
  files: Record<string, [number, string]>,
  nNodes = 1,
): Manifest {
  const logicalFiles = {
    "positions.bin": [nNodes * 12, "0".repeat(64)] as [number, string],
    "names.idx": [8, "0".repeat(64)] as [number, string],
    "names.pack": [1, hash(new Uint8Array([0]))] as [number, string],
    ...files,
  };
  const completeFiles = Object.fromEntries(
    Object.entries(logicalFiles).map(([name, [size, digest]]) => [
      name,
      [size, digest, `${digest}-${name}`],
    ]),
  ) as unknown as Manifest["files"];
  return {
    version: "0".repeat(64),
    schema: "structural-site-v1",
    profile: "explorer-v1",
    source: { dump_version: "test-dump", dump_sha256: "0".repeat(64) },
    schema_digest: "0".repeat(64),
    field_policy: {},
    mapping_digests: {},
    vocab_digests: {},
    owned_collections: {},
    counts: {
      entities: { subject: 1, person: 0, character: 0 },
      facts: 0,
      fact_source_rows: 0,
      incidence: 0,
      episodes: 0,
      episode_orphan_groups: 0,
      episode_orphan_rows: 0,
      unresolved_voice_subject_context: 0,
      text: {},
    },
    text_bytes: {},
    text_layout: {},
    limits: {
      member_cap: 256_000,
      pack_cap: 80_000_000,
      fact_buckets: 8192,
      fact_inline: 200,
      episode_inline: 200,
      page_size: 500,
      entity_block_ids: 256,
      episode_block_subjects: 128,
      search_leaf_cap: 64_000,
      search_top: 12,
      cache_budget: {
        total: 64_000_000,
        names: 12_000_000,
        structure: 24_000_000,
        search: 8_000_000,
        text: 20_000_000,
      },
    },
    rank_index: {
      encoding: "u24le",
      sentinel: 0xffffff,
      segments: { "1": { offset: 0, count: nNodes } },
    },
    n_nodes: nNodes,
    n_edges_skeleton: 0,
    name_block_size: 2,
    bbox: [
      [0, 0, 0],
      [1, 1, 1],
    ],
    year_range: [1900, 2035],
    tags: [],
    layout: { dimensions: 3, geometry: "topology-3d", stub: false },
    files: completeFiles,
    core_bytes: 0,
    total_bytes: Object.values(completeFiles).reduce(
      (sum, [size]) => sum + size,
      0,
    ),
    n_files: Object.keys(completeFiles).length,
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

test("rejects manifests from the obsolete det/adj generation", async () => {
  const legacy = {
    ...testManifest({}),
    schema: undefined,
    profile: undefined,
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(legacy))) as typeof fetch;
  await assert.rejects(loadManifest(), /structural-site-v1/);
});

test("rejects a malformed physical-file tuple at the manifest boundary", async () => {
  const malformed = testManifest({});
  (malformed.files as Record<string, unknown>)["key.bin"] = null;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(malformed))) as typeof fetch;

  await assert.rejects(loadManifest(), /完整 SHA-256 内容寻址物理名/);
});

test("rejects obsolete geometry manifests before streaming", async () => {
  const obsoletePositions = testManifest({
    "positions.bin": [8, "0".repeat(64)],
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(obsoletePositions))) as typeof fetch;
  await assert.rejects(loadManifest(), /positions\.bin.*实际为 8.*重建站点数据/);

  const obsoleteLayout = {
    ...testManifest({}),
    layout: { dimensions: 2, geometry: "planar", stub: false },
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(obsoleteLayout))) as typeof fetch;
  await assert.rejects(loadManifest(), /布局应为 topology-3d.*重建站点数据/);
});

test("loads and caches only the requested name blocks", async () => {
  const first = gzipSync(JSON.stringify([["A", null], ["B", "乙"]]));
  const second = gzipSync(JSON.stringify([["C", "丙"]]));
  const pack = new Uint8Array(Buffer.concat([first, second]));
  const index = new Uint8Array(
    new Uint32Array([0, first.byteLength, pack.byteLength]).buffer,
  );
  const manifest = testManifest(
    {
      "names.idx": [index.byteLength, hash(index)],
      "names.pack": [pack.byteLength, hash(pack)],
    },
    3,
  );
  const ranges: string[] = [];
  await installFetch(manifest, async (path, init) => {
    if (path.endsWith("names.idx")) return new Response(index);
    assert.match(path, /names\.pack$/);
    const range = new Headers(init?.headers).get("Range");
    assert.ok(range);
    ranges.push(range);
    const match = range.match(/^bytes=(\d+)-(\d+)$/);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(pack.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${pack.byteLength}`,
      },
    });
  });

  const names = openNames(manifest);
  assert.equal(names.get(2), null);
  await names.load([2]);
  assert.equal(names.get(2), "丙");
  assert.deepEqual(names.row(2), ["C", "丙"]);
  assert.equal(names.get(0), null);
  await names.load([2]);
  await names.load([0, 1]);
  assert.equal(names.get(0), "A");
  assert.equal(names.get(1), "乙");
  assert.deepEqual(ranges, [
    `bytes=${first.byteLength}-${pack.byteLength - 1}`,
    `bytes=0-${first.byteLength - 1}`,
  ]);
});

test("rejects a 206 response for the wrong byte range", async () => {
  const manifest = testManifest(
    {
      "positions.bin": [24, "0".repeat(64)],
      "key.bin": [8, "0".repeat(64)],
    },
    2,
  );
  await installFetch(manifest, async (path) => {
    if (path.endsWith("positions.bin"))
      return new Response(new Uint8Array(8), {
        status: 206,
        headers: { "Content-Range": "bytes 0-7/24" },
      });
    return new Response(new Uint8Array(4), {
      status: 206,
      headers: { "Content-Range": "bytes 4-7/8" },
    });
  });

  await assert.rejects(pointByRank(manifest, 1), /Content-Range/);
});

test("treats a changed Content-Range total as a replaced release", async () => {
  const manifest = testManifest(
    {
      "positions.bin": [24, "0".repeat(64)],
      "key.bin": [8, "0".repeat(64)],
    },
    2,
  );
  await installFetch(manifest, async () => {
    return new Response(new Uint8Array(12), {
      status: 206,
      headers: { "Content-Range": "bytes 12-23/999" },
    });
  });

  assert.equal(releaseWasReplaced(), false);
  await assert.rejects(
    pointByRank(manifest, 1),
    (error: unknown) => error instanceof ReleaseChangedError,
  );
  assert.equal(releaseWasReplaced(), true);
  // 判定发布已被替换后停止该发布的后续数据请求
  await assert.rejects(
    pointByRank(manifest, 0),
    (error: unknown) => error instanceof ReleaseChangedError,
  );
});

test("uses immutable object names and stops when an old object disappears", async () => {
  const value: NameRow[] = [["old", null]];
  const compressed = gzipSync(JSON.stringify(value));
  const digest = hash(compressed);
  const manifest = testManifest({
    "facts.pack": [compressed.byteLength, digest],
  });
  let requestedPath = "";
  await installFetch(manifest, async (path) => {
    requestedPath = path;
    return new Response(null, { status: 404 });
  });

  await assert.rejects(
    member("structure", "facts.pack", 0, compressed.byteLength),
    (error: unknown) => error instanceof ReleaseChangedError,
  );
  assert.equal(requestedPath, `/data/${digest}-facts.pack`);
  assert.equal(releaseWasReplaced(), true);
});

test("reads an exact xyz float32 position by rank", async () => {
  const positions = new Uint8Array(
    new Float32Array([1.25, -2.5, 3.5, 4.75, 5.25, -6.5]).buffer,
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
    pos: [4.75, 5.25, -6.5],
    key: 22,
  });
});

test("streams complete xyz geometry without planar expansion", async () => {
  const artifacts: Record<string, Uint8Array> = {
    "positions.bin": new Uint8Array(
      new Float32Array([1, 2, 3, 4, 5, 6]).buffer,
    ),
    "year.bin": new Uint8Array(new Uint16Array([1999, 2000]).buffer),
    "key.bin": new Uint8Array(new Uint32Array([11, 22]).buffer),
    "size.bin": new Uint8Array([7, 8]),
    "flags.bin": new Uint8Array([0, 2]),
    "score.bin": new Uint8Array([91, 92]),
    "tags.bin": new Uint8Array(new Uint32Array([1, 2]).buffer),
  };
  const metadata: Record<string, [number, string]> = {};
  for (const [path, bytes] of Object.entries(artifacts))
    metadata[path] = [bytes.byteLength, hash(bytes)];
  const manifest = testManifest(metadata, 2);
  await installFetch(manifest, async (path) => {
    const physicalName = path.slice(path.lastIndexOf("/") + 1);
    const logicalName = Object.entries(manifest.files).find(
      ([, meta]) => meta[2] === physicalName,
    )?.[0];
    const bytes = logicalName ? artifacts[logicalName] : undefined;
    assert.ok(bytes);
    return new Response(bytes.buffer as ArrayBuffer);
  });

  const stream = openGeometry(manifest);
  await stream.start(() => undefined);

  assert.equal(stream.geo.loaded, 2);
  assert.deepEqual(Array.from(stream.geo.positions), [1, 2, 3, 4, 5, 6]);
});

test("decodes the u24 rank-by-key reverse index", async () => {
  // kind1 段:id0 = 哨兵,id1 = rank 5
  const bytes = new Uint8Array([0xff, 0xff, 0xff, 5, 0, 0]);
  const manifest = {
    ...testManifest({
      "rank-by-key.bin": [bytes.byteLength, hash(bytes)] as [
        number,
        string,
      ],
    }),
    rank_index: {
      encoding: "u24le",
      sentinel: 0xffffff,
      segments: { "1": { offset: 0, count: 2 } },
    },
  };
  await installFetch(manifest, async () =>
    new Response(bytes.buffer as ArrayBuffer),
  );
  await ensureRankIndex();

  assert.equal(rankOfKey((1 << 24) | 0), null);
  assert.equal(rankOfKey((1 << 24) | 1), 5);
  assert.equal(rankOfKey((2 << 24) | 1), null);
});

test("shares one whole-pack fallback across concurrent members", async () => {
  const first: NameRow[] = [["a", "A"]];
  const second: NameRow[] = [["b", "B"]];
  const firstGzip = gzipSync(JSON.stringify(first));
  const secondGzip = gzipSync(JSON.stringify(second));
  const pack = new Uint8Array(Buffer.concat([firstGzip, secondGzip]));
  const manifest = testManifest({
    "facts.pack": [pack.byteLength, hash(pack)],
  });
  let packRequests = 0;
  await installFetch(manifest, async () => {
    packRequests++;
    return new Response(pack, { status: 200 });
  });

  const [loadedFirst, loadedSecond] = await Promise.all([
    member("structure", "facts.pack", 0, firstGzip.byteLength),
    member(
      "structure",
      "facts.pack",
      firstGzip.byteLength,
      secondGzip.byteLength,
    ),
  ]);

  assert.deepEqual(loadedFirst, first);
  assert.deepEqual(loadedSecond, second);
  assert.equal(packRequests, 1);
  // 成员缓存命中不得产生网络请求
  await member("structure", "facts.pack", 0, firstGzip.byteLength);
  assert.equal(packRequests, 1);
});
