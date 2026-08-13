import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

import siteContract from "../../scripts/site-contract.json";
import { Data } from "../src/data";
import {
  loadEntityRanksById,
  loadManifest,
  loadSubjectQueryColumns,
  intersectSortedPostings,
  member,
  openNames,
  openSearchAliases,
  openGeometry,
  pointByRank,
  prefetchMemberRanges,
  prefetchPack,
  prefetchPackRange,
  rankOfKey,
  subjectForEpisode,
  ensureRankIndex,
  decodeDeltaPosting,
  foldWithCharmap,
  foldedUtf8Range,
  loadCharmap,
  loadEntityKeys,
  loadSearchDir,
  loadedEntityKeys,
  releaseWasReplaced,
  ReleaseChangedError,
  searchGramBuckets,
  searchMember,
  searchSubstringPage,
  SiteDataContractError,
} from "../src/loader";
import type { Manifest, NameRow } from "../src/types";
import { SiteRuntimeError } from "../src/site-error";

const originalFetch = globalThis.fetch;
const EMPTY_SEARCH_DIRECTORY = gzipSync("{}");
const NGRAM_SHARDS = siteContract.limits.search_ngram_shards;
const EMPTY_NGRAM_SHARD = gzipSync(
  JSON.stringify(new Array(65_536 / NGRAM_SHARDS).fill(null)),
);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const body = (bytes: Uint8Array): ArrayBuffer =>
  Uint8Array.from(bytes).buffer;

function u32le(values: Iterable<number>): Uint8Array {
  const items = [...values];
  const bytes = new Uint8Array(items.length * 4);
  const view = new DataView(bytes.buffer);
  items.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}

function u16le(values: Iterable<number>): Uint8Array {
  const items = [...values];
  const bytes = new Uint8Array(items.length * 2);
  const view = new DataView(bytes.buffer);
  items.forEach((value, index) => view.setUint16(index * 2, value, true));
  return bytes;
}

function ngramArtifacts(
  byBucket: Map<number, number[]>,
  memberRanks = 60_000,
): {
  shards: Record<string, Uint8Array>;
  pack: Uint8Array;
  bucketMembers: number[];
  memberOffsets: number[];
} {
  const bucketMembers = new Array<number>(65537).fill(0);
  const memberOffsets = [0];
  const directories: Array<Array<
    [number, Array<[number, number, number, number]>] | null
  >> = Array.from(
    { length: NGRAM_SHARDS },
    () => new Array(65_536 / NGRAM_SHARDS).fill(null),
  );
  const members: Uint8Array[] = [];
  let size = 0;
  for (let bucket = 0; bucket < 65536; bucket++) {
    bucketMembers[bucket] = members.length;
    const ranks = byBucket.get(bucket) ?? [];
    const locations: Array<[number, number, number, number]> = [];
    for (let start = 0; start < ranks.length; start += memberRanks) {
      const page = ranks.slice(start, start + memberRanks);
      const raw = new Uint8Array(page.length * 3);
      page.forEach((rank, index) => {
        raw[index * 3] = rank & 0xff;
        raw[index * 3 + 1] = (rank >>> 8) & 0xff;
        raw[index * 3 + 2] = rank >>> 16;
      });
      const member = new Uint8Array(gzipSync(raw));
      members.push(member);
      locations.push([
        size,
        member.byteLength,
        page[0] ?? 0,
        page.at(-1) ?? 0,
      ]);
      size += member.byteLength;
      memberOffsets.push(size);
    }
    if (ranks.length) {
      const directory = directories[bucket % NGRAM_SHARDS];
      assert.ok(directory);
      directory[Math.floor(bucket / NGRAM_SHARDS)] = [
        ranks.length,
        locations,
      ];
    }
  }
  bucketMembers[65536] = members.length;
  return {
    shards: Object.fromEntries(
      directories.map((directory, shard) => [
        `search.ngram.idx-${shard}.json.gz`,
        new Uint8Array(gzipSync(JSON.stringify(directory))),
      ]),
    ),
    pack: new Uint8Array(Buffer.concat(members)),
    bucketMembers,
    memberOffsets,
  };
}

function ngramFiles(
  artifacts: ReturnType<typeof ngramArtifacts>,
): Record<string, [number, string]> {
  return {
    ...Object.fromEntries(
      Object.entries(artifacts.shards).map(([path, bytes]) => [
        path,
        [bytes.byteLength, hash(bytes)],
      ]),
    ),
    "search.ngram.pack": [artifacts.pack.byteLength, hash(artifacts.pack)],
  };
}

function ngramShardResponse(
  path: string,
  artifacts: ReturnType<typeof ngramArtifacts>,
): Response | null {
  for (const [logicalName, bytes] of Object.entries(artifacts.shards))
    if (path.endsWith(logicalName)) return new Response(body(bytes));
  return null;
}

function testManifest(
  files: Record<string, [number, string]>,
  nNodes = 1,
): Manifest {
  const logicalFiles = {
    "positions.bin": [nNodes * 6, "0".repeat(64)] as [number, string],
    "year.bin": [nNodes * 2, "0".repeat(64)] as [number, string],
    "key.bin": [nNodes * 4, "0".repeat(64)] as [number, string],
    "size.bin": [nNodes, "0".repeat(64)] as [number, string],
    "flags.bin": [nNodes, "0".repeat(64)] as [number, string],
    "score.bin": [nNodes, "0".repeat(64)] as [number, string],
    "tags.bin": [nNodes * 4, "0".repeat(64)] as [number, string],
    "rank-by-key.bin": [nNodes * 3, "0".repeat(64)] as [number, string],
    "episode-subject.bin": [0, hash(new Uint8Array())] as [number, string],
    "fact-anchor.bin": [0, hash(new Uint8Array())] as [number, string],
    "names.idx": [8, "0".repeat(64)] as [number, string],
    "names.pack": [1, hash(new Uint8Array([0]))] as [number, string],
    "charmap.json": [2, hash(new TextEncoder().encode("{}"))] as [
      number,
      string,
    ],
    ...Object.fromEntries(
      Array.from(
        { length: siteContract.limits.search_prefix_shards },
        (_, shard) => [
          `search.idx-${shard}.json.gz`,
          [
            EMPTY_SEARCH_DIRECTORY.byteLength,
            hash(EMPTY_SEARCH_DIRECTORY),
          ] as [number, string],
        ],
      ),
    ),
    "search.pack": [0, hash(new Uint8Array())] as [number, string],
    ...Object.fromEntries(
      Array.from({ length: NGRAM_SHARDS }, (_, shard) => [
        `search.ngram.idx-${shard}.json.gz`,
        [EMPTY_NGRAM_SHARD.byteLength, hash(EMPTY_NGRAM_SHARD)] as [
          number,
          string,
        ],
      ]),
    ),
    "search.ngram.pack": [0, hash(new Uint8Array())] as [number, string],
    "search.alias.idx": [8, "0".repeat(64)] as [number, string],
    "search.alias.pack": [0, hash(new Uint8Array())] as [number, string],
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
    schema_digest: siteContract.schema_digest,
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
      member_raw_cap: 2_000_000,
      pack_cap: 80_000_000,
      fact_buckets: 8192,
      fact_inline: 200,
      episode_inline: 200,
      page_size: 500,
      entity_block_ids: 256,
      episode_block_subjects: 128,
      search_leaf_cap: 64_000,
      search_top: 12,
      search_prefix_shards: siteContract.limits.search_prefix_shards,
      search_fold: "unicode-casefold-15.0.0-aliases-v1",
      search_ngram_width: 2,
      search_ngram_buckets: 65536,
      search_ngram_shards: NGRAM_SHARDS,
      search_ngram_member_ranks: 60_000,
      search_alias_block_ranks: 1_024,
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
      segments: {
        "1": { offset: 0, count: nNodes },
        "2": { offset: nNodes * 3, count: 0 },
        "3": { offset: nNodes * 3, count: 0 },
      },
    },
    episode_index: {
      encoding: "u32le-subject-id",
      sentinel: 0xffffffff,
      count: 0,
    },
    fact_index: {
      encoding: "u32le-anchor-entity-key",
      count: 0,
    },
    n_nodes: nNodes,
    n_edges_skeleton: 0,
    name_block_size: 2,
    position_encoding: {
      encoding: "u16le-affine-3d-v1",
      components: 3,
      offset: [0, 0, 0],
      scale: [1 / 65_535, 1 / 65_535, 1 / 65_535],
    },
    bbox: [
      [0, 0, 0],
      [1, 1, 1],
    ],
    year_range: [1900, 2035],
    tags: [],
    layout: { dimensions: 3, shape_digest: "c80e48f8" },
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

test("classifies unavailable releases and transport failures", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  await assert.rejects(
    loadManifest(),
    (error: unknown) =>
      error instanceof SiteRuntimeError && error.code === "RELEASE_UNAVAILABLE",
  );

  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  await assert.rejects(
    loadManifest(),
    (error: unknown) =>
      error instanceof SiteRuntimeError && error.code === "NETWORK",
  );
});

test("rejects a non-positive search page size at the manifest boundary", async () => {
  const malformed = testManifest({});
  malformed.limits.search_top = 0;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(malformed))) as typeof fetch;

  await assert.rejects(loadManifest(), /search_top/);
});

test("rejects inconsistent cache budgets at the manifest boundary", async () => {
  const malformed = testManifest({});
  malformed.limits.cache_budget.search = -1;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(malformed))) as typeof fetch;

  await assert.rejects(loadManifest(), /cache_budget/);
});

test("rejects manifest-controlled resource expansion", async () => {
  const oversizedNodes = testManifest({});
  oversizedNodes.n_nodes = 0x1000000;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(oversizedNodes))) as typeof fetch;
  await assert.rejects(loadManifest(), /n_nodes|节点上限/);

  const oversizedPack = testManifest({});
  oversizedPack.limits.pack_cap++;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(oversizedPack))) as typeof fetch;
  await assert.rejects(loadManifest(), /limits|资源上限/);
});

test("accepts manifest-controlled resource tightening", async () => {
  const tightened = testManifest({});
  tightened.limits.member_raw_cap--;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(tightened))) as typeof fetch;

  assert.deepEqual(await loadManifest(), tightened);
});

test("accepts a smaller power-of-two search alias block", async () => {
  const tightened = testManifest({});
  tightened.limits.search_alias_block_ranks /= 2;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(tightened))) as typeof fetch;

  assert.deepEqual(await loadManifest(), tightened);
});

test("rejects invalid search alias block sizes", async () => {
  for (const value of [0, 513, 2_048]) {
    const malformed = testManifest({});
    malformed.limits.search_alias_block_ranks = value;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(malformed))) as typeof fetch;

    await assert.rejects(loadManifest(), /structural-site-v1/);
  }
});

test("rejects a manifest with incompatible tuple semantics", async () => {
  const malformed = testManifest({});
  malformed.schema_digest = "f".repeat(64);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(malformed))) as typeof fetch;

  await assert.rejects(loadManifest(), /schema_digest|schema/);
});

test("rejects a malformed manifest content identity", async () => {
  const malformed = testManifest({});
  malformed.version = "weekly";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(malformed))) as typeof fetch;

  await assert.rejects(loadManifest(), /structural-site-v1/);
});

test("rejects a manifest-defined rank decoder", async () => {
  const malformed = testManifest({});
  malformed.rank_index.encoding = "u32le";
  malformed.rank_index.sentinel = 0;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(malformed))) as typeof fetch;

  await assert.rejects(loadManifest(), /rank_index/);

  const gapped = testManifest({});
  gapped.rank_index.segments["2"] = { offset: 1, count: 0 };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(gapped))) as typeof fetch;
  await assert.rejects(loadManifest(), /rank_index/);
});

test("rejects an expanded decoded member cap", async () => {
  const malformed = testManifest({});
  malformed.limits.member_raw_cap++;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(malformed))) as typeof fetch;

  await assert.rejects(loadManifest(), /limits|资源上限/);
});

test("rejects a runtime-defined search folding contract", async () => {
  const malformed = testManifest({});
  malformed.limits.search_fold = "runtime-lower";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(malformed))) as typeof fetch;

  await assert.rejects(loadManifest(), /structural-site-v1/);
});

test("rejects a manifest missing a mandatory search artifact", async () => {
  for (const path of [
    "charmap.json",
    "search.idx-0.json.gz",
    "search.pack",
    "search.ngram.idx-0.json.gz",
    "search.ngram.pack",
    "search.alias.idx",
    "search.alias.pack",
  ]) {
    const malformed = testManifest({});
    const removed = malformed.files[path];
    assert.ok(removed);
    delete malformed.files[path];
    malformed.n_files--;
    malformed.total_bytes -= removed[0];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(malformed))) as typeof fetch;

    await assert.rejects(loadManifest(), /structural-site-v1|charmap/);
  }
});

test("loads only the prefix directory shard selected by the first codepoint", async () => {
  const shard = ("境".codePointAt(0) ?? 0) % 16;
  const directory = { "境": { l: [4, 5] } };
  const compressed = gzipSync(JSON.stringify(directory));
  const path = `search.idx-${shard}.json.gz`;
  const manifest = testManifest({
    [path]: [compressed.byteLength, hash(compressed)],
  });
  const requests: string[] = [];
  await installFetch(manifest, async (requested) => {
    requests.push(requested);
    assert.ok(requested.endsWith(path));
    return new Response(body(compressed));
  });

  assert.deepEqual(await loadSearchDir("境界"), directory);
  assert.equal(requests.length, 1);
});

test("rejects an incomplete full-text-v1 query release", async () => {
  const malformed = testManifest({});
  malformed.query = {
    schema: "atlas-release-query-v1",
    capabilities: ["atlas-query-v1", "full-text-v1"],
    contractDigest: "0".repeat(64),
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(malformed))) as typeof fetch;

  await assert.rejects(loadManifest(), /full-text-v1 查询索引不完整/);
});

test("accepts a query release without a deployment marker", async () => {
  const manifest = testManifest({});
  manifest.query = {
    schema: "atlas-release-query-v1",
    capabilities: ["atlas-query-v1"],
    contractDigest: "0".repeat(64),
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(manifest))) as typeof fetch;

  const loaded = await loadManifest();

  assert.equal(loaded.query?.schema, "atlas-release-query-v1");
});

test("rejects incomplete Subject source-column declarations", async () => {
  const dictionary = new Uint8Array(gzipSync(JSON.stringify([""])));
  const files = {
    "subject-date-code.bin": [2, hash(u16le([0]))] as [number, string],
    "subject-date-dictionary.json.gz": [
      dictionary.byteLength,
      hash(dictionary),
    ] as [number, string],
    "subject-bgm-rank.bin": [2, hash(u16le([0]))] as [number, string],
  };
  const sourceColumns = {
    order: "source-id" as const,
    count: 1,
    date: {
      encoding: "u16le-dictionary-v1" as const,
      codes: "subject-date-code.bin",
      dictionary: "subject-date-dictionary.json.gz",
    },
    rank: {
      encoding: "u16le-zero-null-v1" as const,
      values: "subject-bgm-rank.bin",
    },
  };
  const makeManifest = (): Manifest => {
    const manifest = testManifest(files);
    manifest.query = {
      schema: "atlas-release-query-v1",
      capabilities: [
        "subject-query-columns-v1",
        "subject-query-columns-v2",
      ],
      contractDigest: "0".repeat(64),
      subjectColumns: structuredClone(sourceColumns),
    };
    return manifest;
  };

  const missingLayout = makeManifest();
  delete missingLayout.query!.subjectColumns;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(missingLayout))) as typeof fetch;
  await assert.rejects(loadManifest(), /subject-query-columns-v2/);

  const missingBase = makeManifest();
  missingBase.query!.capabilities = ["subject-query-columns-v2"];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(missingBase))) as typeof fetch;
  await assert.rejects(loadManifest(), /subject-query-columns-v2/);

  const wrongCount = makeManifest();
  wrongCount.query!.subjectColumns!.count++;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(wrongCount))) as typeof fetch;
  await assert.rejects(loadManifest(), /subject-query-columns-v2/);
});

test("hashes Unicode bigrams exactly like the site baker", () => {
  assert.deepEqual(searchGramBuckets("ab"), [36752]);
  assert.deepEqual(searchGramBuckets("之境界"), [53925, 53696]);
  assert.deepEqual(searchGramBuckets("😀界"), [6955]);
  assert.deepEqual(searchGramBuckets("境"), []);
});

test("folding is defined only by the published character map", () => {
  assert.equal(foldWithCharmap(" A\u1c89 ", { A: "a" }), "a\u1c89");
  assert.equal(foldWithCharmap("\ufeff A \ufeff", { A: "a" }), "a");
  assert.equal(
    foldWithCharmap("\u0085A\u0085", { A: "a" }),
    "\u0085a\u0085",
  );
});

test("reports authoritative text matches as UTF-8 byte ranges", () => {
  assert.deepEqual(foldedUtf8Range("  穿过 星空 ", "星空"), [9, 15]);
  assert.equal(foldedUtf8Range("穿过旅程", "星空"), null);
});

test("decodes canonical delta-varint text postings", () => {
  assert.deepEqual(
    decodeDeltaPosting(new Uint8Array([0, 1, 126, 1, 128, 124]), 5, 20_000),
    [0, 1, 127, 128, 16_000],
  );
  assert.throws(
    () => decodeDeltaPosting(new Uint8Array([128]), 1, 10),
    /截断/,
  );
  assert.throws(
    () => decodeDeltaPosting(new Uint8Array([129, 0]), 1, 10),
    /最短编码/,
  );
});

test("intersects every text bigram posting before reading source members", () => {
  assert.deepEqual(
    intersectSortedPostings([
      [1, 2, 4, 7, 9],
      [0, 2, 4, 8, 9],
      [2, 3, 4, 9],
    ]),
    [2, 4, 9],
  );
  assert.deepEqual(intersectSortedPostings([[1, 2], []]), []);
  assert.deepEqual(intersectSortedPostings([]), []);
});

test("rejects a character map with non-codepoint keys", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ab: "a" }));
  const manifest = testManifest({
    "charmap.json": [bytes.byteLength, hash(bytes)],
  });
  await installFetch(manifest, async (path) => {
    assert.match(path, /charmap\.json$/);
    return new Response(body(bytes));
  });

  await assert.rejects(loadCharmap(), /逐码点字符串映射/);
});

test("rejects a character map with unbounded expansion", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ A: "xxxx" }));
  const manifest = testManifest({
    "charmap.json": [bytes.byteLength, hash(bytes)],
  });
  await installFetch(manifest, async (path) => {
    assert.match(path, /charmap\.json$/);
    return new Response(body(bytes));
  });

  await assert.rejects(loadCharmap(), /逐码点字符串映射|expansion/);
});

test("rejects an empty or non-idempotent character mapping", async () => {
  for (const value of [{ A: "" }, { A: "B", B: "b" }]) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const manifest = testManifest({
      "charmap.json": [bytes.byteLength, hash(bytes)],
    });
    await installFetch(manifest, async () => new Response(body(bytes)));

    await assert.rejects(loadCharmap(), /逐码点字符串映射|幂等/);
  }
});

test("reads the rarest bigram posting page in global rank order", async () => {
  const firstBucket = 53696;
  const rarestBucket = 53925;
  const byBucket = new Map<number, number[]>([
    [firstBucket, [1, 2, 3, 4]],
    [rarestBucket, [1, 3]],
  ]);
  const artifacts = ngramArtifacts(byBucket);
  const { pack, bucketMembers, memberOffsets } = artifacts;
  const manifest = testManifest(
    ngramFiles(artifacts),
    5,
  );
  const ranges: string[] = [];
  const shardRequests: string[] = [];
  await installFetch(manifest, async (path, init) => {
    const shard = ngramShardResponse(path, artifacts);
    if (shard) {
      shardRequests.push(path);
      return shard;
    }
    assert.match(path, /search\.ngram\.pack$/);
    const range = new Headers(init?.headers).get("Range");
    assert.ok(range);
    ranges.push(range);
    const match = range.match(/^bytes=(\d+)-(\d+)$/);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(pack.slice(start, end + 1).buffer as ArrayBuffer, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${pack.byteLength}`,
      },
    });
  });

  assert.deepEqual(await searchSubstringPage("之境界", 0, 64), {
    ranks: [1, 3],
    next: null,
  });
  const member = bucketMembers[rarestBucket] ?? 0;
  const expectedRange = `bytes=${memberOffsets[member] ?? 0}-${
    (memberOffsets[member + 1] ?? 0) - 1
  }`;
  assert.deepEqual(ranges, [expectedRange]);
  assert.equal(shardRequests.length, 2);
  assert.ok(shardRequests.some((path) =>
    path.endsWith(`search.ngram.idx-${firstBucket % NGRAM_SHARDS}.json.gz`)
  ));
  assert.ok(shardRequests.some((path) =>
    path.endsWith(`search.ngram.idx-${rarestBucket % NGRAM_SHARDS}.json.gz`)
  ));
});

test("reuses one validated posting member across result pages", async () => {
  const bucket = searchGramBuckets("之境")[0] ?? 0;
  const artifacts = ngramArtifacts(new Map([[bucket, [1, 2, 3]]]));
  const { pack } = artifacts;
  const manifest = testManifest(
    ngramFiles(artifacts),
    4,
  );
  let memberRequests = 0;
  await installFetch(manifest, async (path, init) => {
    const shard = ngramShardResponse(path, artifacts);
    if (shard) return shard;
    memberRequests++;
    const range = new Headers(init?.headers).get("Range");
    assert.equal(range, `bytes=0-${pack.byteLength - 1}`);
    return new Response(body(pack), {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${pack.byteLength - 1}/${pack.byteLength}`,
      },
    });
  });

  const signal = new AbortController().signal;
  assert.deepEqual(await searchSubstringPage("之境", 0, 1, signal), {
    ranks: [1],
    next: 1,
  });
  assert.deepEqual(await searchSubstringPage("之境", 1, 2, signal), {
    ranks: [2, 3],
    next: null,
  });
  assert.equal(memberRequests, 1);
});

test("continues a posting bucket at a validated member boundary", async () => {
  const bucket = searchGramBuckets("之境")[0] ?? 0;
  const postingRanks = Array.from({ length: 60_001 }, (_, rank) => rank);
  const artifacts = ngramArtifacts(new Map([[bucket, postingRanks]]));
  const { pack, memberOffsets } = artifacts;
  const manifest = testManifest(
    ngramFiles(artifacts),
    60_002,
  );
  const ranges: string[] = [];
  await installFetch(manifest, async (path, init) => {
    const shard = ngramShardResponse(path, artifacts);
    if (shard) return shard;
    const range = new Headers(init?.headers).get("Range");
    assert.ok(range);
    ranges.push(range);
    const match = range.match(/^bytes=(\d+)-(\d+)$/);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(body(pack.slice(start, end + 1)), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${pack.byteLength}`,
      },
    });
  });

  const first = await searchSubstringPage("之境", 0, 60_001);
  assert.equal(first.ranks.length, 60_000);
  assert.equal(first.ranks[0], 0);
  assert.equal(first.ranks.at(-1), 59_999);
  assert.equal(first.next, 60_000);
  assert.deepEqual(await searchSubstringPage("之境", 60_000, 2), {
    ranks: [60_000],
    next: null,
  });
  assert.deepEqual(ranges, [
    `bytes=0-${(memberOffsets[1] ?? 0) - 1}`,
    `bytes=${memberOffsets[1] ?? 0}-${(memberOffsets[2] ?? 0) - 1}`,
  ]);
});

test("rejects overlapping rank boundaries between posting members", async () => {
  const bucket = searchGramBuckets("之境")[0] ?? 0;
  const postingRanks = Array.from(
    { length: 60_001 },
    (_, rank) => rank === 60_000 ? 59_999 : rank,
  );
  const artifacts = ngramArtifacts(new Map([[bucket, postingRanks]]));
  const manifest = testManifest(
    ngramFiles(artifacts),
    60_002,
  );
  await installFetch(manifest, async (path) => {
    const shard = ngramShardResponse(path, artifacts);
    if (shard) return shard;
    return new Response(body(artifacts.pack));
  });

  await assert.rejects(searchSubstringPage("之境", 0, 1), /rank 边界/);
});

test("rejects a corrupt posting member before exposing candidates", async () => {
  const bucket = searchGramBuckets("之境")[0] ?? 0;
  const artifacts = ngramArtifacts(new Map([[bucket, [1]]]));
  const corrupt = artifacts.pack.slice();
  const middle = Math.floor(corrupt.length / 2);
  corrupt[middle] = (corrupt[middle] ?? 0) ^ 0xff;
  const manifest = testManifest(
    {
      ...ngramFiles(artifacts),
      "search.ngram.pack": [corrupt.byteLength, hash(corrupt)],
    },
    2,
  );
  await installFetch(manifest, async (path, init) => {
    const shard = ngramShardResponse(path, artifacts);
    if (shard) return shard;
    const range = new Headers(init?.headers).get("Range");
    assert.equal(range, `bytes=0-${corrupt.byteLength - 1}`);
    return new Response(body(corrupt), {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${corrupt.byteLength - 1}/${corrupt.byteLength}`,
      },
    });
  });

  await assert.rejects(
    searchSubstringPage("之境", 0, 1),
    (error: unknown) => error instanceof ReleaseChangedError,
  );
});

test("rejects a posting shard with a zero-length member", async () => {
  const bucket = searchGramBuckets("之境")[0] ?? 0;
  const artifacts = ngramArtifacts(new Map([[bucket, [1]]]));
  const shardPath = `search.ngram.idx-${bucket % NGRAM_SHARDS}.json.gz`;
  const shard = artifacts.shards[shardPath];
  assert.ok(shard);
  const directory = JSON.parse(
    new TextDecoder().decode(gunzipSync(shard)),
  ) as Array<[number, Array<[number, number, number, number]>] | null>;
  const entry = directory[Math.floor(bucket / NGRAM_SHARDS)];
  assert.ok(entry);
  const member = entry[1][0];
  assert.ok(member);
  member[1] = 0;
  const malformed = new Uint8Array(gzipSync(JSON.stringify(directory)));
  artifacts.shards[shardPath] = malformed;
  const manifest = testManifest(
    ngramFiles(artifacts),
    2,
  );
  await installFetch(manifest, async (path) => {
    const response = ngramShardResponse(path, artifacts);
    if (response) return response;
    return new Response(body(artifacts.pack));
  });

  await assert.rejects(searchSubstringPage("之境", 0, 1), /成员边界/);
});

test("aborts substring network work when its caller cancels", async () => {
  const bucket = searchGramBuckets("之境")[0] ?? 0;
  const artifacts = ngramArtifacts(new Map([[bucket, [1]]]));
  const { pack } = artifacts;
  const manifest = testManifest(
    ngramFiles(artifacts),
    2,
  );
  let requestStarted = false;
  let requestSignal: AbortSignal | null = null;
  await installFetch(manifest, async (path, init) => {
    const shard = ngramShardResponse(path, artifacts);
    if (shard) return shard;
    const range = new Headers(init?.headers).get("Range");
    if (range === "bytes=0-0")
      return new Response(pack.slice(0, 1).buffer as ArrayBuffer, {
        status: 206,
        headers: { "Content-Range": `bytes 0-0/${pack.byteLength}` },
      });
    requestStarted = true;
    requestSignal = init?.signal ?? null;
    return new Promise((_resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("range request was not aborted")),
        50,
      );
      requestSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(requestSignal?.reason);
        },
        { once: true },
      );
    });
  });

  const controller = new AbortController();
  const pending = searchSubstringPage("之境", 0, 64, controller.signal);
  while (!requestStarted)
    await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  assert.ok(requestSignal);
  assert.equal((requestSignal as AbortSignal).aborted, true);
});

test("aborts an orphaned name request and retries it", async () => {
  const rows = gzipSync(JSON.stringify([["A", null, 1]]));
  const index = u32le([0, rows.byteLength]);
  const manifest = testManifest({
    "names.idx": [index.byteLength, hash(index)],
    "names.pack": [rows.byteLength, hash(rows)],
  });
  let requestStarted = false;
  let memberRequests = 0;
  const requestSignals: AbortSignal[] = [];
  const responses: Array<() => void> = [];
  await installFetch(manifest, async (path, init) => {
    if (path.endsWith("names.idx")) return new Response(body(index));
    const range = new Headers(init?.headers).get("Range");
    if (range === "bytes=0-0")
      return new Response(body(rows.slice(0, 1)), {
        status: 206,
        headers: { "Content-Range": `bytes 0-0/${rows.byteLength}` },
      });
    requestStarted = true;
    memberRequests++;
    if (init?.signal) requestSignals.push(init.signal);
    return new Promise((resolve, reject) => {
      responses.push(() =>
        resolve(
          new Response(rows, {
            status: 206,
            headers: {
              "Content-Range": `bytes 0-${rows.byteLength - 1}/${rows.byteLength}`,
            },
          }),
        ),
      );
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  });

  const controller = new AbortController();
  const names = openNames(manifest);
  const pending = names.load([0], controller.signal);
  while (!requestStarted)
    await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  const surviving = names.load([0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  responses.forEach((respond) => respond());
  await surviving;

  assert.equal(memberRequests, 2);
  assert.equal(requestSignals[0]?.aborted, true);
  assert.equal(requestSignals[1]?.aborted, false);
  assert.equal(names.get(0), "A");
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
    "positions.bin": [24, "0".repeat(64)],
  }, 2);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(obsoletePositions))) as typeof fetch;
  await assert.rejects(loadManifest(), /positions\.bin.*实际为 24.*重建站点数据/);

  const invalidPositionEncoding = {
    ...testManifest({}),
    position_encoding: {
      encoding: "float32",
      components: 3,
      offset: [0, 0, 0],
      scale: [1, 1, Number.NaN],
    },
  } as unknown as Manifest;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(invalidPositionEncoding))) as typeof fetch;
  await assert.rejects(loadManifest(), /position_encoding/);

  const obsoleteFlags = testManifest({
    "flags.bin": [2, "0".repeat(64)],
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(obsoleteFlags))) as typeof fetch;
  await assert.rejects(loadManifest(), /flags\.bin/);

  const obsoleteLayout = {
    ...testManifest({}),
    layout: { dimensions: 2, shape_digest: "c80e48f8" },
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(obsoleteLayout))) as typeof fetch;
  await assert.rejects(loadManifest(), /布局应为 3D.*实际为 2.*重建站点数据/);

  const invalidBounds = {
    ...testManifest({}),
    bbox: [[0, 0, 0], [Number.POSITIVE_INFINITY, 1, 1]],
  } as Manifest;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(invalidBounds))) as typeof fetch;
  await assert.rejects(loadManifest(), /bbox/);
});

test("loads and caches only the requested name blocks", async () => {
  const first = gzipSync(
    JSON.stringify([["A", null, 1], ["B", "乙", 2]]),
  );
  const second = gzipSync(JSON.stringify([["C", "丙", 3]]));
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
  assert.deepEqual(names.row(2), ["C", "丙", 3]);
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

test("coalesces adjacent name blocks for one batch read", async () => {
  const first = gzipSync(
    JSON.stringify([["A", null, 1], ["B", "乙", 2]]),
  );
  const second = gzipSync(JSON.stringify([["C", "丙", 3]]));
  const pack = new Uint8Array(Buffer.concat([first, second]));
  const index = u32le([0, first.byteLength, pack.byteLength]);
  const manifest = testManifest(
    {
      "names.idx": [index.byteLength, hash(index)],
      "names.pack": [pack.byteLength, hash(pack)],
    },
    3,
  );
  const ranges: string[] = [];
  await installFetch(manifest, async (path, init) => {
    if (path.endsWith("names.idx")) return new Response(body(index));
    const range = new Headers(init?.headers).get("Range");
    assert.ok(range);
    ranges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(body(pack.slice(start, end + 1)), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${pack.byteLength}`,
      },
    });
  });

  const rows = await openNames(manifest).read?.([0, 2]);

  assert.deepEqual(rows, new Map([
    [0, ["A", null, 1]],
    [2, ["C", "丙", 3]],
  ]));
  assert.deepEqual(ranges, [`bytes=0-${pack.byteLength - 1}`]);
});

test("loads search aliases independently from entity names", async () => {
  const rows = gzipSync(
    JSON.stringify([
      [
        [["虎伥", "虎伥"], ["虎倀", "虎倀"]],
        "虎伥",
        3,
      ],
    ]),
  );
  const index = u32le([0, rows.byteLength]);
  const manifest = testManifest({
    "search.alias.idx": [index.byteLength, hash(index)],
    "search.alias.pack": [rows.byteLength, hash(rows)],
  });
  let indexRequests = 0;
  await installFetch(manifest, async (path, init) => {
    if (path.endsWith("search.alias.idx")) {
      indexRequests++;
      return new Response(body(index));
    }
    const range = new Headers(init?.headers).get("Range");
    assert.equal(range, `bytes=0-${rows.byteLength - 1}`);
    return new Response(rows, {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${rows.byteLength - 1}/${rows.byteLength}`,
      },
    });
  });

  const aliases = openSearchAliases(manifest);
  assert.equal(aliases.row(0), null);
  assert.equal(indexRequests, 0);
  const snapshot = await aliases.read([0]);
  assert.equal(indexRequests, 1);
  assert.deepEqual(snapshot.get(0), [
    [["虎伥", "虎伥"], ["虎倀", "虎倀"]],
    "虎伥",
    3,
  ]);
  assert.deepEqual(aliases.row(0), [
    [["虎伥", "虎伥"], ["虎倀", "虎倀"]],
    "虎伥",
    3,
  ]);
});

test("accepts an unsearchable entity with an empty alias list", async () => {
  const rows = gzipSync(JSON.stringify([[[], "\u3000", 1]]));
  const index = u32le([0, rows.byteLength]);
  const manifest = testManifest({
    "search.alias.idx": [index.byteLength, hash(index)],
    "search.alias.pack": [rows.byteLength, hash(rows)],
  });
  await installFetch(manifest, async (path, init) => {
    if (path.endsWith("search.alias.idx")) return new Response(body(index));
    const range = new Headers(init?.headers).get("Range");
    assert.equal(range, `bytes=0-${rows.byteLength - 1}`);
    return new Response(rows, {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${rows.byteLength - 1}/${rows.byteLength}`,
      },
    });
  });

  const aliases = openSearchAliases(manifest);
  await aliases.load([0]);
  assert.deepEqual(aliases.row(0), [[], "\u3000", 1]);
});

test("cancels a whole-file body that exceeds its manifest size", async () => {
  const expected = new TextEncoder().encode("{}");
  const manifest = testManifest({
    "charmap.json": [expected.byteLength, hash(expected)],
  });
  let cancelled = false;
  await installFetch(manifest, async (path) => {
    assert.match(path, /charmap\.json$/);
    let pull = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller): void {
        if (pull++ === 0) controller.enqueue(expected);
        else if (pull === 2) controller.enqueue(new Uint8Array([0]));
        else return;
      },
      cancel(): void {
        cancelled = true;
      },
    }));
  });

  await assert.rejects(loadCharmap(), /exceeds|字节|length|bytes/);
  assert.equal(cancelled, true);
  assert.equal(releaseWasReplaced(), true);
});

test("retries a name index after a failed load", async () => {
  const rows = gzipSync(JSON.stringify([["A", null, 1]]));
  const index = u32le([0, rows.byteLength]);
  const manifest = testManifest({
    "names.idx": [index.byteLength, hash(index)],
    "names.pack": [rows.byteLength, hash(rows)],
  });
  let indexRequests = 0;
  await installFetch(manifest, async (path, init) => {
    if (path.endsWith("names.idx")) {
      indexRequests++;
      if (indexRequests === 1)
        return new Response("temporary", { status: 503 });
      return new Response(body(index));
    }
    const range = new Headers(init?.headers).get("Range");
    assert.equal(range, `bytes=0-${rows.byteLength - 1}`);
    return new Response(rows, {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${rows.byteLength - 1}/${rows.byteLength}`,
      },
    });
  });

  const names = openNames(manifest);
  await assert.rejects(names.load([0]), /503/);
  await names.load([0]);

  assert.equal(indexRequests, 2);
  assert.deepEqual(names.row(0), ["A", null, 1]);
});

test("rejects a gzip member that exceeds the decoded member cap", async () => {
  const rows = gzipSync(JSON.stringify(["x".repeat(2_000_000)]));
  const manifest = testManifest({
    "facts.pack": [rows.byteLength, hash(rows)],
  });
  await installFetch(manifest, async (_path, init) => {
    const range = new Headers(init?.headers).get("Range");
    assert.equal(range, `bytes=0-${rows.byteLength - 1}`);
    return new Response(rows, {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${rows.byteLength - 1}/${rows.byteLength}`,
      },
    });
  });

  await assert.rejects(
    member("structure", "facts.pack", 0, rows.byteLength),
    /decoded member cap/,
  );
});

test("cancels a range body as soon as it exceeds the declared length", async () => {
  const rows = new Uint8Array(gzipSync(JSON.stringify(["ok"])));
  const manifest = testManifest({
    "search.pack": [rows.byteLength, hash(rows)],
  });
  let cancelled = false;
  await installFetch(manifest, async (_path, init) => {
    const range = new Headers(init?.headers).get("Range");
    assert.equal(range, `bytes=0-${rows.byteLength - 1}`);
    let pull = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        if (pull++ === 0) controller.enqueue(rows);
        else if (pull === 2) controller.enqueue(new Uint8Array([0]));
        else return;
      },
      cancel(): void {
        cancelled = true;
      },
    });
    return new Response(stream, {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${rows.byteLength - 1}/${rows.byteLength}`,
      },
    });
  });

  await assert.rejects(
    member("search", "search.pack", 0, rows.byteLength),
    (error: unknown) => error instanceof ReleaseChangedError,
  );
  assert.equal(cancelled, true);
  assert.equal(releaseWasReplaced(), true);
});

test("rejects a name row with an invalid entity kind", async () => {
  const rows = gzipSync(JSON.stringify([["A", null, 4]]));
  const index = new Uint8Array(
    new Uint32Array([0, rows.byteLength]).buffer,
  );
  const manifest = testManifest({
    "names.idx": [index.byteLength, hash(index)],
    "names.pack": [rows.byteLength, hash(rows)],
  });
  await installFetch(manifest, async (path, init) => {
    if (path.endsWith("names.idx")) return new Response(index);
    const range = new Headers(init?.headers).get("Range");
    assert.equal(range, `bytes=0-${rows.byteLength - 1}`);
    return new Response(rows, {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${rows.byteLength - 1}/${rows.byteLength}`,
      },
    });
  });

  const names = openNames(manifest);
  await assert.rejects(
    names.load([0]),
    (error: unknown) =>
      error instanceof SiteDataContractError &&
      /names block 0.*invalid row/.test(error.message),
  );
  assert.equal(names.row(0), null);
});

test("rejects a names index that does not cover the whole pack", async () => {
  const rows = gzipSync(JSON.stringify([["A", null, 1]]));
  const index = u32le([1, rows.byteLength]);
  const manifest = testManifest({
    "names.idx": [index.byteLength, hash(index)],
    "names.pack": [rows.byteLength, hash(rows)],
  });
  await installFetch(manifest, async (path) => {
    if (path.endsWith("names.idx")) return new Response(body(index));
    return new Response(body(rows));
  });

  await assert.rejects(openNames(manifest).load([0]), /names\.idx.*from zero/);
});

test("rejects a malformed search projection row", async () => {
  const rows = gzipSync(JSON.stringify([["a", "A", 0]]));
  const manifest = testManifest({
    "search.pack": [rows.byteLength, hash(rows)],
  });
  await installFetch(manifest, async (_path, init) => {
    const range = new Headers(init?.headers).get("Range");
    assert.equal(range, `bytes=0-${rows.byteLength - 1}`);
    return new Response(rows, {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${rows.byteLength - 1}/${rows.byteLength}`,
      },
    });
  });

  await assert.rejects(
    searchMember([0, rows.byteLength]),
    (error: unknown) =>
      error instanceof SiteDataContractError &&
      /search\.pack.*invalid row/.test(error.message),
  );
});

test("rejects a 206 response for the wrong byte range", async () => {
  const manifest = testManifest(
    {
      "positions.bin": [12, "0".repeat(64)],
      "key.bin": [8, "0".repeat(64)],
    },
    2,
  );
  await installFetch(manifest, async (path) => {
    if (path.endsWith("positions.bin"))
      return new Response(new Uint8Array(6), {
        status: 206,
        headers: { "Content-Range": "bytes 0-5/12" },
      });
    return new Response(new Uint8Array(4), {
      status: 206,
      headers: { "Content-Range": "bytes 4-7/8" },
    });
  });

  await assert.rejects(
    pointByRank(manifest, 1),
    (error: unknown) => error instanceof ReleaseChangedError,
  );
  assert.equal(releaseWasReplaced(), true);
});

test("treats a changed Content-Range total as a replaced release", async () => {
  const manifest = testManifest(
    {
      "positions.bin": [12, "0".repeat(64)],
      "key.bin": [8, "0".repeat(64)],
    },
    2,
  );
  await installFetch(manifest, async (path) => {
    const position = path.endsWith("positions.bin");
    return new Response(new Uint8Array(position ? 6 : 4), {
      status: 206,
      headers: {
        "Content-Range": position ? "bytes 6-11/999" : "bytes 4-7/999",
      },
    });
  });

  assert.equal(releaseWasReplaced(), false);
  await assert.rejects(
    pointByRank(manifest, 1),
    (error: unknown) => error instanceof ReleaseChangedError,
  );
  assert.equal(releaseWasReplaced(), true);
  await assert.rejects(
    pointByRank(manifest, 0),
    (error: unknown) => error instanceof ReleaseChangedError,
  );
});

test("uses immutable object names and stops when an old object disappears", async () => {
  const value: NameRow[] = [["old", null, 1]];
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

test("reads an affine u16 xyz position by rank", async () => {
  const positions = u16le([0, 0, 0, 65_535, 65_535, 65_535]);
  const keys = new Uint8Array(new Uint32Array([11, 22]).buffer);
  const manifest = {
    ...testManifest(
    {
      "positions.bin": [positions.byteLength, hash(positions)],
      "key.bin": [keys.byteLength, hash(keys)],
    },
    2,
    ),
    position_encoding: {
      encoding: "u16le-affine-3d-v1" as const,
      components: 3 as const,
      offset: [1, -2, 3] as [number, number, number],
      scale: [1.5 / 65_535, 1 / 65_535, 10 / 65_535] as [
        number,
        number,
        number,
      ],
    },
    bbox: [
      [1, -2, 3],
      [2.5, -1, 13],
    ] as Manifest["bbox"],
  } satisfies Manifest;
  await installFetch(manifest, async (path) =>
    new Response(body(path.endsWith("positions.bin") ? positions : keys)),
  );

  assert.deepEqual(await pointByRank(manifest, 1), {
    pos: [2.5, -1, 13],
    key: 22,
  });
});

test("streams affine geometry without empty or duplicate progress", async () => {
  const artifacts: Record<string, Uint8Array> = {
    "positions.bin": u16le([0, 0, 0, 65_535, 65_535, 65_535]),
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
  const manifest = {
    ...testManifest(metadata, 2),
    position_encoding: {
      encoding: "u16le-affine-3d-v1" as const,
      components: 3 as const,
      offset: [1, -2, 3] as [number, number, number],
      scale: [1.5 / 65_535, 1 / 65_535, 10 / 65_535] as [
        number,
        number,
        number,
      ],
    },
    bbox: [
      [1, -2, 3],
      [2.5, -1, 13],
    ] as Manifest["bbox"],
  } satisfies Manifest;
  const fetched = new Set<string>();
  await installFetch(manifest, async (path) => {
    const physicalName = path.slice(path.lastIndexOf("/") + 1);
    const logicalName = Object.entries(manifest.files).find(
      ([, meta]) => meta[2] === physicalName,
    )?.[0];
    const bytes = logicalName ? artifacts[logicalName] : undefined;
    assert.ok(bytes);
    fetched.add(logicalName as string);
    const middle = bytes.byteLength / 2;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, middle));
        queueMicrotask(() => {
          controller.enqueue(bytes.subarray(middle));
          controller.close();
        });
      },
    }));
  });

  const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => 100,
  });
  const stream = openGeometry(manifest);
  const loadedCounts: number[] = [];
  try {
    await stream.start((loaded) => loadedCounts.push(loaded));
  } finally {
    if (nowDescriptor)
      Object.defineProperty(performance, "now", nowDescriptor);
    else Reflect.deleteProperty(performance, "now");
  }

  assert.equal(stream.geo.loaded, 2);
  assert.deepEqual(loadedCounts, [1, 2]);
  assert.deepEqual(Array.from(stream.geo.positions), [1, -2, 3, 2.5, -1, 13]);
  assert.deepEqual([...fetched].sort(), [
    "flags.bin",
    "key.bin",
    "positions.bin",
    "size.bin",
  ]);
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
      segments: {
        "1": { offset: 0, count: 2 },
        "2": { offset: 6, count: 0 },
        "3": { offset: 6, count: 0 },
      },
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

test("does not reuse rank-ordered entity keys across SiteReleases", async () => {
  const firstKeys = u32le([(1 << 24) | 1, (2 << 24) | 2]);
  const first = testManifest({
    "key.bin": [firstKeys.byteLength, hash(firstKeys)],
  }, 2);
  await installFetch(first, async (path) => {
    assert.ok(path.endsWith("key.bin"));
    return new Response(body(firstKeys));
  });
  assert.deepEqual(Array.from(await loadEntityKeys()), [
    (1 << 24) | 1,
    (2 << 24) | 2,
  ]);
  assert.ok(loadedEntityKeys());

  const secondKeys = u32le([(3 << 24) | 3]);
  const second = testManifest({
    "key.bin": [secondKeys.byteLength, hash(secondKeys)],
  });
  await installFetch(second, async () => new Response(body(secondKeys)));

  assert.equal(loadedEntityKeys(), null);
});

test("loads verified Subject query columns in archive-id order", async () => {
  const rankBytes = Uint8Array.of(1, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0);
  const years = u16le([2024, 0]);
  const scores = Uint8Array.of(85, 0);
  const flags = Uint8Array.of((2 << 2) | 1, 6 << 2);
  const manifest = {
    ...testManifest({
      "rank-by-key.bin": [rankBytes.byteLength, hash(rankBytes)],
      "year.bin": [years.byteLength, hash(years)],
      "score.bin": [scores.byteLength, hash(scores)],
      "flags.bin": [flags.byteLength, hash(flags)],
    }, 2),
    counts: {
      ...testManifest({}, 2).counts,
      entities: { subject: 2, person: 0, character: 0 },
    },
    rank_index: {
      encoding: "u24le",
      sentinel: 0xffffff,
      segments: {
        "1": { offset: 0, count: 3 },
        "2": { offset: 9, count: 0 },
        "3": { offset: 9, count: 0 },
      },
    },
  };
  const artifacts = new Map([
    ["rank-by-key.bin", rankBytes],
    ["year.bin", years],
    ["score.bin", scores],
    ["flags.bin", flags],
  ]);
  await installFetch(manifest, async (path) => {
    const artifact = [...artifacts].find(([name]) => path.endsWith(`-${name}`));
    assert.ok(artifact, `unexpected request ${path}`);
    return new Response(body(artifact[1]));
  });

  assert.deepEqual(
    [...await loadEntityRanksById(1)],
    [1, 0xffffff, 0],
  );
  const columns = await loadSubjectQueryColumns(["score"]);
  assert.equal(columns.nodeCount, 2);
  assert.equal(columns.year, undefined);
  assert.deepEqual([...(columns.score ?? [])], [85, 0]);
  assert.equal(columns.flags, undefined);
});

test("projects verified Subject columns through Data in archive-id order", async () => {
  const rankBytes = Uint8Array.of(
    2, 0, 0,
    0xff, 0xff, 0xff,
    0, 0, 0,
    1, 0, 0,
  );
  const years = u16le([0, 2025, 2020]);
  const scores = Uint8Array.of(0, 91, 85);
  const flags = Uint8Array.of(2 << 2, (6 << 2) | 1, (1 << 2) | 1);
  const dateCodes = u16le([1, 0, 0, 2]);
  const dateDictionary = new Uint8Array(gzipSync(JSON.stringify([
    "",
    "2020-01-01",
    "2025-04-01",
  ])));
  const bgmRanks = u16le([50, 0, 0, 7]);
  const firstNames = gzipSync(JSON.stringify([
    ["Two", "二", 1],
    ["Three", null, 1],
  ]));
  const secondNames = gzipSync(JSON.stringify([["Zero", "零", 1]]));
  const namesPack = new Uint8Array(Buffer.concat([firstNames, secondNames]));
  const namesIndex = u32le([
    0,
    firstNames.byteLength,
    namesPack.byteLength,
  ]);
  const artifacts = new Map<string, Uint8Array>([
    ["rank-by-key.bin", rankBytes],
    ["year.bin", years],
    ["score.bin", scores],
    ["flags.bin", flags],
    ["subject-date-code.bin", dateCodes],
    ["subject-date-dictionary.json.gz", dateDictionary],
    ["subject-bgm-rank.bin", bgmRanks],
    ["names.idx", namesIndex],
    ["names.pack", namesPack],
  ]);
  const base = testManifest(
    Object.fromEntries(
      [...artifacts].map(([name, bytes]) => [
        name,
        [bytes.byteLength, hash(bytes)],
      ]),
    ),
    3,
  );
  const manifest: Manifest = {
    ...base,
    counts: {
      ...base.counts,
      entities: { subject: 3, person: 0, character: 0 },
    },
    rank_index: {
      encoding: "u24le",
      sentinel: 0xffffff,
      segments: {
        "1": { offset: 0, count: 4 },
        "2": { offset: 12, count: 0 },
        "3": { offset: 12, count: 0 },
      },
    },
    query: {
      schema: "atlas-release-query-v1",
      capabilities: [
        "subject-query-columns-v1",
        "subject-query-columns-v2",
      ],
      contractDigest: "0".repeat(64),
      subjectColumns: {
        order: "source-id",
        count: 4,
        date: {
          encoding: "u16le-dictionary-v1",
          codes: "subject-date-code.bin",
          dictionary: "subject-date-dictionary.json.gz",
        },
        rank: {
          encoding: "u16le-zero-null-v1",
          values: "subject-bgm-rank.bin",
        },
      },
    },
  };
  const requested = new Set<string>();
  await installFetch(manifest, async (path) => {
    const artifact = [...artifacts].find(([name]) => path.endsWith(`-${name}`));
    assert.ok(artifact, `unexpected request ${path}`);
    requested.add(artifact[0]);
    return new Response(body(artifact[1]));
  });

  const data = new Data(manifest);
  const projected = [];
  for await (const entity of data.projectEntities(
    "subject",
    ["name", "nameCn", "type", "date", "year", "score", "rank", "nsfw"],
    undefined,
    "whole",
  )) projected.push(entity);

  assert.deepEqual(projected, [
    {
      kind: "subject",
      key: (1 << 24) | 0,
      fields: {
        name: "Zero",
        nameCn: "零",
        type: 1,
        date: "2020-01-01",
        year: 2020,
        score: 8.5,
        rank: 50,
        nsfw: true,
      },
    },
    {
      kind: "subject",
      key: (1 << 24) | 2,
      fields: {
        name: "Two",
        nameCn: "二",
        type: 2,
        date: "",
        year: null,
        score: null,
        rank: null,
        nsfw: false,
      },
    },
    {
      kind: "subject",
      key: (1 << 24) | 3,
      fields: {
        name: "Three",
        nameCn: "",
        type: 6,
        date: "2025-04-01",
        year: 2025,
        score: 9.1,
        rank: 7,
        nsfw: true,
      },
    },
  ]);
  const projectedBatches = [];
  for await (const batch of data.projectEntityBatches(
    "subject",
    ["name", "nameCn", "type", "date", "year", "score", "rank", "nsfw"],
    undefined,
    "whole",
  )) projectedBatches.push(batch);
  assert.deepEqual(projectedBatches.flat(), projected);
  assert.equal(requested.has("entities.pack"), false);
});

test("projects identity-only point reads without entities.pack", async () => {
  const rankBytes = Uint8Array.of(0, 0, 0);
  const namesMember = gzipSync(JSON.stringify([["Original", "中文名", 1]]));
  const namesIndex = u32le([0, namesMember.byteLength]);
  const artifacts = new Map<string, Uint8Array>([
    ["rank-by-key.bin", rankBytes],
    ["names.idx", namesIndex],
    ["names.pack", namesMember],
  ]);
  const manifest = testManifest(Object.fromEntries(
    [...artifacts].map(([name, bytes]) => [
      name,
      [bytes.byteLength, hash(bytes)],
    ]),
  ));
  const requested = new Set<string>();
  await installFetch(manifest, async (path) => {
    const artifact = [...artifacts].find(([name]) => path.endsWith(`-${name}`));
    assert.ok(artifact, `unexpected request ${path}`);
    requested.add(artifact[0]);
    return new Response(body(artifact[1]));
  });

  const projected = await new Data(manifest).projectEntity(
    1 << 24,
    ["ref", "name", "nameCn"],
  );

  assert.deepEqual(projected, {
    kind: "subject",
    key: 1 << 24,
    fields: { name: "Original", nameCn: "中文名" },
  });
  assert.deepEqual(
    requested,
    new Set(["rank-by-key.bin", "names.idx", "names.pack"]),
  );
});

test("projects identity-only candidate batches from targeted name blocks", async () => {
  const rankBytes = Uint8Array.of(
    2, 0, 0,
    0, 0, 0,
    1, 0, 0,
  );
  const firstNames = gzipSync(JSON.stringify([
    ["Zero", "零", 1],
    ["One", "一", 1],
  ]));
  const secondNames = gzipSync(JSON.stringify([["Two", "二", 1]]));
  const namesPack = new Uint8Array(Buffer.concat([firstNames, secondNames]));
  const namesIndex = u32le([
    0,
    firstNames.byteLength,
    firstNames.byteLength + secondNames.byteLength,
  ]);
  const artifacts = new Map<string, Uint8Array>([
    ["rank-by-key.bin", rankBytes],
    ["names.idx", namesIndex],
    ["names.pack", namesPack],
  ]);
  const manifest = testManifest(Object.fromEntries(
    [...artifacts].map(([name, bytes]) => [
      name,
      [bytes.byteLength, hash(bytes)],
    ]),
  ), 3);
  manifest.counts.entities.subject = 3;
  const requested = new Set<string>();
  await installFetch(manifest, async (path) => {
    const artifact = [...artifacts].find(([name]) => path.endsWith(`-${name}`));
    assert.ok(artifact, `unexpected request ${path}`);
    requested.add(artifact[0]);
    return new Response(body(artifact[1]));
  });
  const projected = [];

  for await (const entity of new Data(manifest).projectEntityCandidates(
    "subject",
    [(1 << 24) | 2, 1 << 24],
    ["ref", "name", "nameCn"],
  )) projected.push(entity);

  assert.deepEqual(projected, [
    {
      kind: "subject",
      key: 1 << 24,
      fields: { name: "Two", nameCn: "二" },
    },
    {
      kind: "subject",
      key: (1 << 24) | 2,
      fields: { name: "One", nameCn: "一" },
    },
  ]);
  assert.deepEqual(
    requested,
    new Set(["rank-by-key.bin", "names.idx", "names.pack"]),
  );
});

test("cancels an identity-only point read while the shared rank index loads", async () => {
  const rankBytes = Uint8Array.of(0, 0, 0);
  const namesMember = gzipSync(JSON.stringify([["Original", null, 1]]));
  const namesIndex = u32le([0, namesMember.byteLength]);
  const artifacts = new Map<string, Uint8Array>([
    ["rank-by-key.bin", rankBytes],
    ["names.idx", namesIndex],
    ["names.pack", namesMember],
  ]);
  const manifest = testManifest(Object.fromEntries(
    [...artifacts].map(([name, bytes]) => [
      name,
      [bytes.byteLength, hash(bytes)],
    ]),
  ));
  let rankStarted = false;
  let finishRank: (() => void) | undefined;
  await installFetch(manifest, async (path) => {
    if (path.endsWith("rank-by-key.bin")) {
      rankStarted = true;
      await new Promise<void>((resolve) => {
        finishRank = resolve;
      });
      return new Response(body(rankBytes));
    }
    const artifact = [...artifacts].find(([name]) => path.endsWith(`-${name}`));
    assert.ok(artifact, `unexpected request ${path}`);
    return new Response(body(artifact[1]));
  });
  const controller = new AbortController();
  const pending = new Data(manifest).projectEntity(
    1 << 24,
    ["ref", "name"],
    controller.signal,
  );
  while (!rankStarted)
    await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();

  try {
    await assert.rejects(
      Promise.race([
        pending,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("point read did not cancel")), 50)
        ),
      ]),
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
  } finally {
    finishRank?.();
  }
});

test("falls back to entities.pack when a release lacks Subject columns", async () => {
  const entityMember = gzipSync(JSON.stringify({
    i: [7, 8],
    r: [
      ["Fallback", null, 2, null, "2024-01-01", 8.6],
      ["No score", null, 2, null, "", 0],
    ],
  }));
  const entityIndex = gzipSync(JSON.stringify({
    width: 256,
    k: { "1": [[7, 8, 0, entityMember.byteLength]] },
  }));
  const artifacts = new Map<string, Uint8Array>([
    ["entities.idx", entityIndex],
    ["entities.pack", entityMember],
  ]);
  const manifest = testManifest(Object.fromEntries(
    [...artifacts].map(([name, bytes]) => [
      name,
      [bytes.byteLength, hash(bytes)],
    ]),
  ));
  const requested = new Set<string>();
  await installFetch(manifest, async (path) => {
    const artifact = [...artifacts].find(([name]) => path.endsWith(`-${name}`));
    assert.ok(artifact, `unexpected request ${path}`);
    requested.add(artifact[0]);
    return new Response(body(artifact[1]));
  });

  const projected = [];
  for await (const entity of new Data(manifest).projectEntities(
    "subject",
    ["score"],
    undefined,
    "whole",
  )) projected.push(entity);

  assert.deepEqual(projected, [
    {
      kind: "subject",
      key: (1 << 24) | 7,
      fields: { score: 8.6 },
    },
    {
      kind: "subject",
      key: (1 << 24) | 8,
      fields: { score: null },
    },
  ]);
  assert.deepEqual(requested, new Set(["entities.idx", "entities.pack"]));
});

test("stops a streaming projection within its current storage member", async () => {
  const entityMember = gzipSync(JSON.stringify({
    i: [7, 8],
    r: [
      ["First", null, 2, null, "", 8.6],
      null,
    ],
  }));
  const entityIndex = gzipSync(JSON.stringify({
    width: 256,
    k: { "1": [[7, 8, 0, entityMember.byteLength]] },
  }));
  const artifacts = new Map<string, Uint8Array>([
    ["entities.idx", entityIndex],
    ["entities.pack", entityMember],
  ]);
  const manifest = testManifest(Object.fromEntries(
    [...artifacts].map(([name, bytes]) => [
      name,
      [bytes.byteLength, hash(bytes)],
    ]),
  ));
  await installFetch(manifest, async (path) => {
    const artifact = [...artifacts].find(([name]) => path.endsWith(`-${name}`));
    assert.ok(artifact, `unexpected request ${path}`);
    return new Response(body(artifact[1]));
  });
  const projected = [];

  for await (const entity of new Data(manifest).projectEntities(
    "subject",
    ["score"],
    undefined,
    "stream",
  )) {
    projected.push(entity);
    break;
  }

  assert.deepEqual(projected, [{
    kind: "subject",
    key: (1 << 24) | 7,
    fields: { score: 8.6 },
  }]);
});

test("resolves and caches an Episode owning Subject from fixed-width lookups", async () => {
  const bytes = u32le([0xffffffff, 42, 7]);
  const manifest = {
    ...testManifest({
      "episode-subject.bin": [bytes.byteLength, hash(bytes)],
    }),
    episode_index: {
      encoding: "u32le-subject-id" as const,
      sentinel: 0xffffffff,
      count: 3,
    },
  };
  let requests = 0;
  await installFetch(manifest, async (_path, init) => {
    requests++;
    const range = new Headers(init?.headers).get("Range");
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(body(bytes.slice(start, end + 1)), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}` },
    });
  });

  assert.equal(await subjectForEpisode(0), null);
  assert.equal(await subjectForEpisode(1), 42);
  assert.equal(await subjectForEpisode(2), 7);
  assert.equal(await subjectForEpisode(1), 42);
  assert.equal(await subjectForEpisode(3), null);
  assert.equal(requests, 3);
});

test("shares one whole-pack fallback across concurrent members", async () => {
  const first: NameRow[] = [["a", "A", 1]];
  const second: NameRow[] = [["b", "B", 2]];
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
  await member("structure", "facts.pack", 0, firstGzip.byteLength);
  assert.equal(packRequests, 1);
});

test("prefetches a range-capable pack once for a local full scan", async () => {
  const first: NameRow[] = [["a", "A", 1]];
  const second: NameRow[] = [["b", "B", 2]];
  const firstGzip = gzipSync(JSON.stringify(first));
  const secondGzip = gzipSync(JSON.stringify(second));
  const pack = new Uint8Array(Buffer.concat([firstGzip, secondGzip]));
  const manifest = testManifest({
    "facts.pack": [pack.byteLength, hash(pack)],
  });
  const ranges: Array<string | null> = [];
  await installFetch(manifest, async (_path, init) => {
    const range = new Headers(init?.headers).get("Range");
    ranges.push(range);
    if (!range) return new Response(body(pack));
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(body(pack.slice(start, end + 1)), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${pack.byteLength}`,
      },
    });
  });

  await prefetchPack("facts.pack");
  assert.deepEqual(
    await member("structure", "facts.pack", 0, firstGzip.byteLength),
    first,
  );
  assert.deepEqual(
    await member(
      "structure",
      "facts.pack",
      firstGzip.byteLength,
      secondGzip.byteLength,
    ),
    second,
  );

  assert.deepEqual(ranges, [null]);
});

test("prefetches and reuses one contiguous range for a partial scan", async () => {
  const first: NameRow[] = [["a", "A", 1]];
  const second: NameRow[] = [["b", "B", 2]];
  const third: NameRow[] = [["c", "C", 3]];
  const firstGzip = gzipSync(JSON.stringify(first));
  const secondGzip = gzipSync(JSON.stringify(second));
  const thirdGzip = gzipSync(JSON.stringify(third));
  const pack = new Uint8Array(Buffer.concat([
    firstGzip,
    secondGzip,
    thirdGzip,
  ]));
  const manifest = testManifest({
    "facts.pack": [pack.byteLength, hash(pack)],
  });
  const ranges: Array<string | null> = [];
  await installFetch(manifest, async (_path, init) => {
    const range = new Headers(init?.headers).get("Range");
    ranges.push(range);
    if (!range) return new Response(body(pack));
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(body(pack.slice(start, end + 1)), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${pack.byteLength}`,
      },
    });
  });

  const rangeOffset = firstGzip.byteLength;
  const rangeLength = secondGzip.byteLength + thirdGzip.byteLength;
  await prefetchPackRange("facts.pack", rangeOffset, rangeLength);
  assert.deepEqual(
    await member("structure", "facts.pack", rangeOffset, secondGzip.byteLength),
    second,
  );
  assert.deepEqual(
    await member(
      "structure",
      "facts.pack",
      rangeOffset + secondGzip.byteLength,
      thirdGzip.byteLength,
    ),
    third,
  );
  await prefetchPackRange("facts.pack", rangeOffset, rangeLength);

  assert.deepEqual(ranges, [
    `bytes=${rangeOffset}-${pack.byteLength - 1}`,
  ]);
});

test("coalesces adjacent uncached member reads without downloading gaps", async () => {
  const first: NameRow[] = [["a", "A", 1]];
  const second: NameRow[] = [["b", "B", 2]];
  const third: NameRow[] = [["c", "C", 3]];
  const firstGzip = gzipSync(JSON.stringify(first));
  const secondGzip = gzipSync(JSON.stringify(second));
  const thirdGzip = gzipSync(JSON.stringify(third));
  const gap = new Uint8Array([1, 2, 3]);
  const pack = new Uint8Array(Buffer.concat([
    firstGzip,
    secondGzip,
    gap,
    thirdGzip,
  ]));
  const manifest = testManifest({
    "facts.pack": [pack.byteLength, hash(pack)],
  });
  const ranges: string[] = [];
  await installFetch(manifest, async (_path, init) => {
    const range = new Headers(init?.headers).get("Range");
    assert.ok(range);
    ranges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(body(pack.slice(start, end + 1)), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${pack.byteLength}`,
      },
    });
  });

  const release = await prefetchMemberRanges("text", "facts.pack", [
    [0, firstGzip.byteLength],
    [firstGzip.byteLength, secondGzip.byteLength],
    [firstGzip.byteLength + secondGzip.byteLength + gap.byteLength, thirdGzip.byteLength],
  ]);
  assert.deepEqual(await Promise.all([
    member("text", "facts.pack", 0, firstGzip.byteLength),
    member("text", "facts.pack", firstGzip.byteLength, secondGzip.byteLength),
    member(
      "text",
      "facts.pack",
      firstGzip.byteLength + secondGzip.byteLength + gap.byteLength,
      thirdGzip.byteLength,
    ),
  ]), [first, second, third]);
  release();
  await prefetchMemberRanges("text", "facts.pack", [
    [0, firstGzip.byteLength],
    [firstGzip.byteLength, secondGzip.byteLength],
  ]);
  assert.deepEqual(
    await member("structure", "facts.pack", 0, firstGzip.byteLength),
    first,
  );

  assert.deepEqual(ranges, [
    `bytes=0-${firstGzip.byteLength + secondGzip.byteLength - 1}`,
    `bytes=${firstGzip.byteLength + secondGzip.byteLength + gap.byteLength}-${pack.byteLength - 1}`,
    `bytes=0-${firstGzip.byteLength - 1}`,
  ]);
});

test("bounds whole-pack fallbacks with a weighted LRU", async () => {
  const facts = new Uint8Array(gzipSync(JSON.stringify(["facts"])));
  const episodes = new Uint8Array(gzipSync(JSON.stringify(["episodes"])));
  const packCap = Math.max(facts.byteLength, episodes.byteLength);
  const manifest = testManifest({
    "facts.pack": [facts.byteLength, hash(facts)],
    "episodes.pack": [episodes.byteLength, hash(episodes)],
  });
  manifest.limits.member_cap = packCap;
  manifest.limits.pack_cap = packCap;
  manifest.limits.search_leaf_cap = packCap;
  manifest.limits.cache_budget.structure = 1;
  manifest.limits.cache_budget.total =
    manifest.limits.cache_budget.names +
    manifest.limits.cache_budget.structure +
    manifest.limits.cache_budget.search +
    manifest.limits.cache_budget.text;
  const requests = new Map<string, number>();
  await installFetch(manifest, async (path) => {
    const logicalName = path.endsWith("facts.pack")
      ? "facts.pack"
      : "episodes.pack";
    requests.set(logicalName, (requests.get(logicalName) ?? 0) + 1);
    return new Response(logicalName === "facts.pack" ? facts : episodes);
  });

  await member("structure", "facts.pack", 0, facts.byteLength);
  await member("structure", "episodes.pack", 0, episodes.byteLength);
  await member("structure", "facts.pack", 0, facts.byteLength);

  assert.equal(requests.get("facts.pack"), 2);
  assert.equal(requests.get("episodes.pack"), 1);
});

test("shares one whole-pack fallback across cancellable members", async () => {
  const first: NameRow[] = [["a", "A", 1]];
  const second: NameRow[] = [["b", "B", 2]];
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

  const signal = new AbortController().signal;
  const [loadedFirst, loadedSecond] = await Promise.all([
    member(
      "structure",
      "facts.pack",
      0,
      firstGzip.byteLength,
      signal,
    ),
    member(
      "structure",
      "facts.pack",
      firstGzip.byteLength,
      secondGzip.byteLength,
      signal,
    ),
  ]);

  assert.deepEqual(loadedFirst, first);
  assert.deepEqual(loadedSecond, second);
  assert.equal(packRequests, 1);
});

test("coalesces concurrent cancellable reads of one member", async () => {
  const rows = gzipSync(JSON.stringify([["A", null, 1]]));
  const index = u32le([0, rows.byteLength]);
  const manifest = testManifest({
    "names.idx": [index.byteLength, hash(index)],
    "names.pack": [rows.byteLength, hash(rows)],
  });
  let memberRequests = 0;
  await installFetch(manifest, async (path, init) => {
    if (path.endsWith("names.idx")) return new Response(body(index));
    const range = new Headers(init?.headers).get("Range");
    if (range === "bytes=0-0")
      return new Response(body(rows.slice(0, 1)), {
        status: 206,
        headers: { "Content-Range": `bytes 0-0/${rows.byteLength}` },
      });
    memberRequests++;
    return new Response(rows, {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${rows.byteLength - 1}/${rows.byteLength}`,
      },
    });
  });

  const names = openNames(manifest);
  await Promise.all([
    names.load([0], new AbortController().signal),
    names.load([0], new AbortController().signal),
  ]);

  assert.equal(memberRequests, 1);
});

test("does not retain successful range payloads outside the LRU", async () => {
  const first = gzipSync(JSON.stringify(["first"]));
  const second = gzipSync(JSON.stringify(["second"]));
  const pack = new Uint8Array(Buffer.concat([first, second]));
  const manifest = testManifest({
    "facts.pack": [pack.byteLength, hash(pack)],
  });
  manifest.limits.cache_budget.structure = 1;
  manifest.limits.cache_budget.total =
    manifest.limits.cache_budget.names +
    manifest.limits.cache_budget.structure +
    manifest.limits.cache_budget.search +
    manifest.limits.cache_budget.text;
  const ranges: string[] = [];
  await installFetch(manifest, async (_path, init) => {
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

  await member("structure", "facts.pack", 0, first.byteLength);
  await member("structure", "facts.pack", first.byteLength, second.byteLength);
  await member("structure", "facts.pack", 0, first.byteLength);

  assert.equal(
    ranges.filter((range) => range === `bytes=0-${first.byteLength - 1}`).length,
    2,
  );
});

test("rejects a server that stops honoring ranges after the probe", async () => {
  const first = gzipSync(JSON.stringify(["first"]));
  const second = gzipSync(JSON.stringify(["second"]));
  const pack = new Uint8Array(Buffer.concat([first, second]));
  const manifest = testManifest({
    "facts.pack": [pack.byteLength, hash(pack)],
  });
  await installFetch(manifest, async (_path, init) => {
    const range = new Headers(init?.headers).get("Range");
    if (range === `bytes=0-${first.byteLength - 1}`)
      return new Response(first, {
        status: 206,
        headers: {
          "Content-Range": `bytes 0-${first.byteLength - 1}/${pack.byteLength}`,
        },
      });
    return new Response(pack, { status: 200 });
  });

  await member("structure", "facts.pack", 0, first.byteLength);
  await assert.rejects(
    member(
      "structure",
      "facts.pack",
      first.byteLength,
      second.byteLength,
    ),
    /stopped honoring Range/,
  );
});
