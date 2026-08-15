/** 数据加载:几何 SoA 流式渐进、gzip 成员按 Range 点查、分族计权
 * LRU 缓存、发布切换检测。全部数据请求以该文件自身 SHA-256 寻址,
 * 字节未变的文件可跨发布复用缓存。 */

import type {
  Geometry,
  Manifest,
  NameRow,
  Names,
  PositionEncoding,
  SearchAliasRow,
  SearchAliases,
  SearchEntry,
  SearchNode,
} from "./types";
import siteContract from "../../scripts/site-contract.json";
import { AsyncMemo, SharedAbortableMemo } from "./async-memo";
import { WeightedLru } from "./cache";
import {
  assertByteLength,
  assertContentRange,
  sha256Hex,
} from "./data-integrity";
import { SiteRuntimeError } from "./site-error";

const BASE = "data";
const {
  member_cap: MEMBER_CAP,
  member_raw_cap: MEMBER_RAW_CAP,
  text_index_cap: TEXT_INDEX_CAP,
  pack_cap: PACK_CAP,
  search_leaf_cap: SEARCH_LEAF_CAP,
  search_top: SEARCH_TOP,
  search_prefix_shards: SEARCH_PREFIX_SHARDS,
  search_fold: SEARCH_FOLD,
  search_fold_max_expansion: SEARCH_FOLD_MAX_EXPANSION,
  search_ngram_width: SEARCH_NGRAM_WIDTH,
  search_ngram_buckets: SEARCH_NGRAM_BUCKETS,
  search_ngram_shards: SEARCH_NGRAM_SHARDS,
  search_ngram_member_ranks: SEARCH_NGRAM_MEMBER_RANKS,
  search_alias_block_ranks_max: SEARCH_ALIAS_BLOCK_RANKS_MAX,
} = siteContract.limits;
const RANK_ENCODING = siteContract.rank.encoding;
const RANK_SENTINEL = siteContract.rank.sentinel;
const EPISODE_SUBJECT_SENTINEL = 0xffffffff;
const NAME_BLOCK_SIZE = 2_048;
const MANIFEST_BYTE_CAP = 1_000_000;
const SMALL_FILE_CAP = 16_000_000;
const RANK_INDEX_CAP = RANK_SENTINEL * 3 * 3;
const RANK_LOOKUP_BLOCK_IDS = 4_096;
const RANK_LOOKUP_MAX_BLOCKS = 16;
const SITE_BYTE_CAP = 1_000_000_000;
const REQUIRED_SEARCH_FILES = [
  "charmap.json",
  "search.pack",
  "search.ngram.pack",
  "search.alias.idx",
  "search.alias.pack",
  ...Array.from(
    { length: SEARCH_PREFIX_SHARDS },
    (_, shard) => `search.idx-${shard}.json.gz`,
  ),
  ...Array.from(
    { length: SEARCH_NGRAM_SHARDS },
    (_, shard) => `search.ngram.idx-${shard}.json.gz`,
  ),
];
const TEXT_SEARCH_POSTING_SHARDS = SEARCH_NGRAM_SHARDS;
const REQUIRED_TEXT_QUERY_FILES = [
  "text.search.members",
  ...Array.from(
    { length: TEXT_SEARCH_POSTING_SHARDS },
    (_, shard) => [
      `text.search.ngram-${shard}.idx`,
      `text.search.ngram-${shard}.pack`,
    ],
  ).flat(),
  ...Array.from(
    { length: TEXT_SEARCH_POSTING_SHARDS },
    (_, shard) => [
      `text.search.trigram-${shard}.idx`,
      `text.search.trigram-${shard}.pack`,
    ],
  ).flat(),
] as const;
const TEXT_SEARCH_TRIGRAM_WIDTH = 3;
const SUBJECT_QUERY_COLUMNS_V1 = "subject-query-columns-v1";
const SUBJECT_QUERY_COLUMNS_V2 = "subject-query-columns-v2";
const CACHE_BUDGET = {
  total: 64_000_000,
  names: 12_000_000,
  structure: 24_000_000,
  search: 8_000_000,
  text: 20_000_000,
} as const;
const EPISODE_SUBJECT_CACHE_BUDGET = 256_000;
const EPISODE_SUBJECT_ENTRY_WEIGHT = 64;
const POSITION_QUANTIZED_MAX = 0xffff;
const GEOMETRY_STRIDES = {
  "positions.bin": 6,
  "year.bin": 2,
  "key.bin": 4,
  "size.bin": 1,
  "flags.bin": 1,
  "score.bin": 1,
  "tags.bin": 4,
} as const;
const CANVAS_STREAM_STRIDES = {
  positions: GEOMETRY_STRIDES["positions.bin"],
  key: GEOMETRY_STRIDES["key.bin"],
  size: GEOMETRY_STRIDES["size.bin"],
  flags: GEOMETRY_STRIDES["flags.bin"],
} as const;
let manifestRef: Manifest | null = null;

export class SiteDataContractError extends SiteRuntimeError {
  constructor(detail: string) {
    super(
      "DATA_INTEGRITY",
      `站点数据版本不兼容:${detail},请重建站点数据`,
    );
    this.name = "SiteDataContractError";
  }
}

function positionVector(value: unknown, nonnegative = false): value is [
  number,
  number,
  number,
] {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) =>
      typeof item === "number" &&
      Number.isFinite(item) &&
      (!nonnegative || item >= 0)
    );
}

function validPositionEncoding(value: unknown): value is PositionEncoding {
  if (!value || typeof value !== "object") return false;
  const encoding = value as Partial<PositionEncoding>;
  if (
    encoding.encoding !== siteContract.geometry.positions.encoding ||
    encoding.components !== siteContract.geometry.positions.components ||
    !positionVector(encoding.offset) ||
    !positionVector(encoding.scale, true)
  ) return false;
  return encoding.offset.every((offset, axis) =>
    Number.isFinite(
      offset + (encoding.scale?.[axis] ?? Number.NaN) * POSITION_QUANTIZED_MAX,
    )
  );
}

function decodePosition(
  encoding: PositionEncoding,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    Math.fround(encoding.offset[0] + x * encoding.scale[0]),
    Math.fround(encoding.offset[1] + y * encoding.scale[1]),
    Math.fround(encoding.offset[2] + z * encoding.scale[2]),
  ];
}

function decodePositionRange(
  encoded: Uint16Array,
  output: Float32Array,
  startRank: number,
  endRank: number,
  encoding: PositionEncoding,
): void {
  for (let rank = startRank; rank < endRank; rank++) {
    const offset = rank * 3;
    const [x, y, z] = decodePosition(
      encoding,
      encoded[offset] ?? 0,
      encoded[offset + 1] ?? 0,
      encoded[offset + 2] ?? 0,
    );
    output[offset] = x;
    output[offset + 1] = y;
    output[offset + 2] = z;
  }
}

/** manifest 可更新，但负载是不可变内容对象；旧对象消失或数据与
 * manifest 不一致时停止请求并要求刷新，不混用两个发布。 */
export class ReleaseChangedError extends SiteRuntimeError {
  constructor(detail: string) {
    super("RELEASE_EVICTED", `站点数据已更新(${detail}),请刷新页面`);
    this.name = "ReleaseChangedError";
  }
}

class ResponseLengthError extends Error {}

let releaseChanged = false;
let onReleaseChanged: (() => void) | null = null;

export function watchReleaseChange(cb: () => void): void {
  onReleaseChanged = cb;
}

export function releaseWasReplaced(): boolean {
  return releaseChanged;
}

function enterReleaseChanged(detail: string): never {
  if (!releaseChanged) {
    releaseChanged = true;
    onReleaseChanged?.();
  }
  throw new ReleaseChangedError(detail);
}

function guard(): void {
  if (releaseChanged) throw new ReleaseChangedError("已停止数据请求");
}

/** manifest 之后只请求完整摘要命名的不可变物理对象。 */
function url(path: string): string {
  const meta = publishedMeta(path);
  return `${BASE}/${meta[2]}`;
}

export type CacheFamily = "names" | "structure" | "search" | "text";

const caches: Record<CacheFamily, WeightedLru<string, unknown>> = {
  names: new WeightedLru(CACHE_BUDGET.names),
  structure: new WeightedLru(CACHE_BUDGET.structure),
  search: new WeightedLru(CACHE_BUDGET.search),
  text: new WeightedLru(CACHE_BUDGET.text),
};
interface PrefetchedPack {
  off: number;
  buffer: ArrayBuffer;
}

const prefetchedPacks = new WeightedLru<string, PrefetchedPack>(PACK_CAP);
const prefetchedPackKeys = new Map<string, string[]>();
const episodeSubjects = new WeightedLru<number, number | null>(
  EPISODE_SUBJECT_CACHE_BUDGET,
);
const episodeSubjectLoads = new SharedAbortableMemo<number, number | null>();

export async function loadManifest(): Promise<Manifest> {
  const res = await fetchSite(`${BASE}/manifest.json`, { cache: "no-cache" });
  if (!res.ok)
    throw new SiteRuntimeError(
      "RELEASE_UNAVAILABLE",
      `当前数据发布不可用（manifest.json: ${res.status}）`,
    );
  const manifestBytes = await readLimitedBody(
    res,
    MANIFEST_BYTE_CAP,
    "manifest.json",
  );
  let m: Manifest;
  try {
    m = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  } catch (error) {
    throw new SiteDataContractError(
      `manifest.json 不是有效 JSON${error instanceof Error ? `: ${error.message}` : ""}`,
    );
  }
  if (m.schema_digest !== siteContract.schema_digest)
    throw new SiteDataContractError("manifest.schema_digest 与客户端不一致");
  if (
    !/^[0-9a-f]{64}$/.test(m.version) ||
    m.schema !== siteContract.schema ||
    m.profile !== siteContract.profile ||
    !Number.isInteger(m.n_nodes) ||
    m.n_nodes <= 0 ||
    !m.files ||
    !m.limits ||
    !m.rank_index?.segments ||
    m.limits.search_fold !== SEARCH_FOLD ||
    m.limits.search_ngram_width !== SEARCH_NGRAM_WIDTH ||
    m.limits.search_ngram_buckets !== SEARCH_NGRAM_BUCKETS ||
    m.limits.search_ngram_shards !== SEARCH_NGRAM_SHARDS ||
    m.limits.search_ngram_member_ranks !== SEARCH_NGRAM_MEMBER_RANKS ||
    m.limits.search_prefix_shards !== SEARCH_PREFIX_SHARDS ||
    !Number.isInteger(m.limits.search_alias_block_ranks) ||
    m.limits.search_alias_block_ranks <= 0 ||
    m.limits.search_alias_block_ranks > SEARCH_ALIAS_BLOCK_RANKS_MAX ||
    (m.limits.search_alias_block_ranks &
      (m.limits.search_alias_block_ranks - 1)) !==
      0 ||
    REQUIRED_SEARCH_FILES.some((path) => !m.files[path])
  )
    throw new SiteDataContractError(
      "manifest 不是 structural-site-v1/explorer-v1 契约",
    );
  if (m.n_nodes >= RANK_SENTINEL)
    throw new SiteDataContractError(
      `n_nodes ${m.n_nodes} 超过 u24 节点上限 ${RANK_SENTINEL - 1}`,
    );
  if (
    m.query !== undefined &&
    (
      m.query.schema !== "atlas-release-query-v1" ||
      !Array.isArray(m.query.capabilities) ||
      m.query.capabilities.some((item) => typeof item !== "string") ||
      new Set(m.query.capabilities).size !== m.query.capabilities.length ||
      !/^[0-9a-f]{64}$/.test(m.query.contractDigest)
    )
  )
    throw new SiteDataContractError("manifest.query 查询能力声明无效");
  if (
    m.query?.capabilities.includes("full-text-v1") &&
    REQUIRED_TEXT_QUERY_FILES.some((path) => !m.files[path])
  )
    throw new SiteDataContractError("full-text-v1 查询索引不完整");
  if (
    m.rank_index.encoding !== RANK_ENCODING ||
    m.rank_index.sentinel !== RANK_SENTINEL
  )
    throw new SiteDataContractError("rank_index 必须使用 u24le/0xffffff");
  let rankIndexBytes = 0;
  const rankSegments = m.rank_index.segments;
  for (const kind of ["1", "2", "3"]) {
    const segment = rankSegments[kind];
    if (
      !segment ||
      !Number.isSafeInteger(segment.offset) ||
      segment.offset !== rankIndexBytes ||
      !Number.isSafeInteger(segment.count) ||
      segment.count < 0 ||
      segment.count > RANK_SENTINEL
    )
      throw new SiteDataContractError("rank_index segment 布局无效");
    rankIndexBytes += segment.count * 3;
  }
  if (
    Object.keys(rankSegments).length !== 3 ||
    m.files["rank-by-key.bin"]?.[0] !== rankIndexBytes
  )
    throw new SiteDataContractError("rank_index 与 rank-by-key.bin 不一致");
  const subjectQueryColumns = m.query?.subjectColumns;
  const declaresSubjectColumnsV2 = m.query?.capabilities.includes(
    SUBJECT_QUERY_COLUMNS_V2,
  ) === true;
  if (
    declaresSubjectColumnsV2 !== (subjectQueryColumns !== undefined) ||
    (declaresSubjectColumnsV2 &&
      !m.query?.capabilities.includes(SUBJECT_QUERY_COLUMNS_V1)) ||
    (subjectQueryColumns !== undefined && (
      subjectQueryColumns.order !== "source-id" ||
      !Number.isSafeInteger(subjectQueryColumns.count) ||
      subjectQueryColumns.count !== rankSegments["1"]?.count ||
      subjectQueryColumns.date?.encoding !== "u16le-dictionary-v1" ||
      typeof subjectQueryColumns.date.codes !== "string" ||
      typeof subjectQueryColumns.date.dictionary !== "string" ||
      subjectQueryColumns.rank?.encoding !== "u16le-zero-null-v1" ||
      typeof subjectQueryColumns.rank.values !== "string" ||
      new Set([
        subjectQueryColumns.date.codes,
        subjectQueryColumns.date.dictionary,
        subjectQueryColumns.rank.values,
      ]).size !== 3 ||
      m.files[subjectQueryColumns.date.codes]?.[0] !==
        subjectQueryColumns.count * 2 ||
      !m.files[subjectQueryColumns.date.dictionary] ||
      m.files[subjectQueryColumns.date.dictionary]![0] > SMALL_FILE_CAP ||
      m.files[subjectQueryColumns.rank.values]?.[0] !==
        subjectQueryColumns.count * 2
    ))
  )
    throw new SiteDataContractError("subject-query-columns-v2 查询列声明无效");
  if (
    m.episode_index?.encoding !== "u32le-subject-id" ||
    m.episode_index.sentinel !== EPISODE_SUBJECT_SENTINEL ||
    !Number.isSafeInteger(m.episode_index.count) ||
    m.episode_index.count < 0 ||
    m.files["episode-subject.bin"]?.[0] !== m.episode_index.count * 4
  )
    throw new SiteDataContractError(
      "episode_index 与 episode-subject.bin 不一致",
    );
  if (
    m.fact_index?.encoding !== "u32le-anchor-entity-key" ||
    !Number.isSafeInteger(m.fact_index.count) ||
    m.fact_index.count !== m.counts.facts ||
    m.files["fact-anchor.bin"]?.[0] !== m.fact_index.count * 4
  )
    throw new SiteDataContractError(
      "fact_index 与 fact-anchor.bin 不一致",
    );
  if (
    !Number.isInteger(m.limits.search_top) ||
    m.limits.search_top <= 0 ||
    m.limits.search_top > SEARCH_TOP
  )
    throw new SiteDataContractError("limits.search_top 必须为正整数");
  for (const [logicalName, rawMeta] of Object.entries(
    m.files as Record<string, unknown>,
  )) {
    if (!Array.isArray(rawMeta) || rawMeta.length !== 3)
      throw new SiteDataContractError(
        `${logicalName} 缺少完整 SHA-256 内容寻址物理名`,
      );
    const [size, digest, physicalName] = rawMeta;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !/^[0-9a-f]{64}$/.test(digest) ||
      physicalName !== `${digest}-${logicalName}` ||
      logicalName.includes("/") ||
      logicalName.includes("\\")
    )
      throw new SiteDataContractError(
        `${logicalName} 缺少完整 SHA-256 内容寻址物理名`,
      );
  }
  const limits = m.limits;
  const textIndexCap = limits.text_index_cap;
  const positiveLimits = [
    limits.member_cap,
    limits.member_raw_cap,
    textIndexCap,
    limits.pack_cap,
    limits.search_leaf_cap,
  ];
  const budget = limits.cache_budget;
  const budgetParts = budget && [
    budget.names,
    budget.structure,
    budget.search,
    budget.text,
  ];
  if (
    positiveLimits.some((value) => !Number.isInteger(value) || value <= 0) ||
    limits.member_cap > MEMBER_CAP ||
    limits.member_raw_cap > MEMBER_RAW_CAP ||
    textIndexCap > TEXT_INDEX_CAP ||
    limits.pack_cap > PACK_CAP ||
    limits.search_leaf_cap > SEARCH_LEAF_CAP ||
    limits.member_cap > limits.pack_cap ||
    limits.search_leaf_cap > limits.member_cap ||
    (m.files["text.idx"]?.[0] ?? 0) > textIndexCap ||
    !budget ||
    !Number.isInteger(budget.total) ||
    budget.total <= 0 ||
    !budgetParts ||
    budgetParts.some((value) => !Number.isInteger(value) || value <= 0) ||
    budgetParts.reduce((sum, value) => sum + value, 0) !== budget.total ||
    budget.total > CACHE_BUDGET.total ||
    budget.names > CACHE_BUDGET.names ||
    budget.structure > CACHE_BUDGET.structure ||
    budget.search > CACHE_BUDGET.search ||
    budget.text > CACHE_BUDGET.text
  )
    throw new SiteDataContractError("limits/cache_budget 超过运行时资源上限");
  for (const [logicalName, [size]] of Object.entries(m.files))
    if (logicalName.endsWith(".pack") && size > limits.pack_cap)
      throw new SiteDataContractError(
        `${logicalName} 超过 limits.pack_cap ${limits.pack_cap}`,
      );
    else if (
      (logicalName.endsWith(".idx") || logicalName.endsWith(".json")) &&
      size > SMALL_FILE_CAP
    )
      throw new SiteDataContractError(
        `${logicalName} 超过小型常驻文件上限 ${SMALL_FILE_CAP}`,
      );
  for (const [path, stride] of Object.entries(GEOMETRY_STRIDES)) {
    const actual = m.files[path]?.[0];
    const expected = m.n_nodes * stride;
    if (actual !== expected)
      throw new SiteDataContractError(
        `${path} 应为 ${expected} 字节,实际为 ${actual ?? "缺失"}`,
      );
  }
  if (!validPositionEncoding(m.position_encoding))
    throw new SiteDataContractError("position_encoding 无效");
  if (m.layout?.dimensions !== 3)
    throw new SiteDataContractError(
      `布局应为 3D,实际为 ${String(m.layout?.dimensions ?? "缺失")}`,
    );
  if (
    !Array.isArray(m.bbox) ||
    m.bbox.length !== 2 ||
    m.bbox.some(
      (point) =>
        !Array.isArray(point) ||
        point.length !== 3 ||
        point.some((value) => !Number.isFinite(value)),
    ) ||
    m.bbox[0].some((value, axis) => value > (m.bbox[1][axis] ?? value))
  )
    throw new SiteDataContractError("bbox 必须是有限且有序的 3D 边界");
  const positionBounds = [
    m.position_encoding.offset.map((value) => Math.fround(value)),
    m.position_encoding.offset.map((value, axis) =>
      Math.fround(
        value +
          (m.position_encoding.scale[axis] ?? Number.NaN) *
            POSITION_QUANTIZED_MAX,
      )
    ),
  ];
  if (
    positionBounds.some((point, side) =>
      point.some((value, axis) => value !== m.bbox[side]?.[axis])
    )
  )
    throw new SiteDataContractError("position_encoding 与 bbox 不一致");
  const nameBlockSize = m.name_block_size;
  if (
    !Number.isInteger(nameBlockSize) ||
    nameBlockSize <= 0 ||
    nameBlockSize > NAME_BLOCK_SIZE ||
    (nameBlockSize & (nameBlockSize - 1)) !== 0 ||
    !m.files["names.idx"] ||
    !m.files["names.pack"]
  )
    throw new SiteDataContractError("名字表 names.idx/names.pack 缺失");
  const totalBytes = Object.values(m.files).reduce(
    (sum, [size]) => sum + size,
    0,
  );
  if (
    !Number.isSafeInteger(m.total_bytes) ||
    m.total_bytes !== totalBytes ||
    totalBytes > SITE_BYTE_CAP ||
    m.n_files !== Object.keys(m.files).length ||
    !Number.isSafeInteger(m.core_bytes) ||
    m.core_bytes < 0 ||
    m.core_bytes > totalBytes
  )
    throw new SiteDataContractError("manifest 文件统计或站点资源上限无效");
  caches.names.setBudget(budget.names);
  caches.structure.setBudget(budget.structure);
  caches.search.setBudget(budget.search);
  caches.text.setBudget(budget.text);
  prefetchedPacks.setBudget(limits.pack_cap);
  // 新 SiteRelease:清空不再被当前文件摘要引用的条目与更新状态
  releaseChanged = false;
  for (const cache of Object.values(caches)) cache.clear();
  memberMemo.clear();
  pinned.clear();
  idxCache.clear();
  packAccess.clear();
  wholePackLoads.clear();
  packRangeLoads.clear();
  packModes.clear();
  prefetchedPacks.clear();
  prefetchedPackKeys.clear();
  ephemeralPackRangeRefs.clear();
  episodeSubjects.clear();
  episodeSubjectLoads.clear();
  loadedKeyIndex = null;
  rankBytes = null;
  rankPromise = null;
  rankBlocks.clear();
  rankBlockLoads.clear();
  charmap = null;
  charmapPromise = null;
  manifestRef = m;
  return m;
}

function publishedMeta(path: string): [number, string, string] {
  const meta = manifestRef?.files[path];
  if (!meta) throw new Error(`${path}: missing manifest metadata`);
  return meta;
}

async function fetchSite(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SiteRuntimeError("NETWORK", "站点数据请求失败，请检查网络后重试", {
      cause: error,
    });
  }
}

async function fetchPublished(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  guard();
  const res = await fetchSite(url(path), init);
  if (res.status === 404 || res.status === 410)
    enterReleaseChanged(`${path} 的旧内容对象已不存在`);
  if (!res.ok)
    throw new SiteRuntimeError("NETWORK", `${path} 请求失败（HTTP ${res.status}）`);
  return res;
}

async function verifyWholeFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const [size, expectedHash] = publishedMeta(path);
  if (bytes.byteLength !== size)
    enterReleaseChanged(`${path} 字节数 ${bytes.byteLength} != ${size}`);
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== expectedHash)
    enterReleaseChanged(`${path} 摘要不符`);
}

async function loadPublishedBytes(
  path: string,
  init?: RequestInit,
  cap = SMALL_FILE_CAP,
): Promise<Uint8Array> {
  guard();
  const [size] = publishedMeta(path);
  if (size > cap)
    throw new SiteDataContractError(`${path} 超过整文件读取上限 ${cap}`);
  const res = await fetchPublished(path, init);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return readPublishedResponse(path, res);
}

async function readPublishedResponse(
  path: string,
  response: Response,
): Promise<Uint8Array> {
  const [size] = publishedMeta(path);
  const buffer = await readPublishedBody(response, size, path);
  const bytes = new Uint8Array(buffer);
  await verifyWholeFile(path, bytes);
  return bytes;
}

async function readPublishedBody(
  response: Response,
  expected: number,
  label: string,
): Promise<ArrayBuffer> {
  try {
    return await readExactBody(response, expected, label);
  } catch (error) {
    if (error instanceof ResponseLengthError)
      enterReleaseChanged(error.message);
    throw error;
  }
}

function waitForSignal<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = (): void => {
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      stop();
      reject(
        signal.reason ?? new DOMException("The operation was aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(
      (value) => {
        stop();
        resolve(value);
      },
      (error: unknown) => {
        stop();
        reject(error);
      },
    );
  });
}

export async function loadPublishedJson<T>(path: string): Promise<T> {
  const bytes = await loadPublishedBytes(path);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function streamInto(
  path: string,
  buffer: Uint8Array,
  onProgress: (bytes: number) => void,
  priority: "high" | "low" = "high",
): Promise<void> {
  const res = await fetchPublished(path, { priority } as RequestInit);
  if (!res.ok || !res.body) throw new Error(`fetch ${path}: ${res.status}`);
  const reader = res.body.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > buffer.byteLength) {
      await reader.cancel();
      throw new Error(`${path}: response exceeds allocated buffer`);
    }
    buffer.set(value, offset);
    offset += value.length;
    onProgress(offset);
  }
  assertByteLength(path, offset, buffer.byteLength);
  await verifyWholeFile(path, buffer);
}

export interface GeometryStream {
  geo: Geometry;
  start(onChunk: (loaded: number) => void): Promise<void>;
}

/** 预分配全量缓冲并立即返回 geo 与启动句柄。 */
export function openGeometry(manifest: Manifest): GeometryStream {
  const n = manifest.n_nodes;
  const raw = {
    key: new Uint8Array(n * 4),
    size: new Uint8Array(n),
    flags: new Uint8Array(n),
  };
  const progress: Record<"positions" | keyof typeof raw, number> = {
    positions: 0,
    key: 0,
    size: 0,
    flags: 0,
  };
  const geo: Geometry = {
    positions: new Float32Array(n * 3),
    key: new Uint32Array(raw.key.buffer),
    size: raw.size,
    flags: raw.flags,
    loaded: 0,
    sparse: new Map(),
  };
  let lastEmit = 0;
  let lastEmitted = 0;

  const start = (onChunk: (loaded: number) => void): Promise<void> => {
    const update = (): void => {
      const loaded = Math.min(
        ...(
          Object.keys(progress) as (keyof typeof progress)[]
        ).map((k) =>
          Math.floor(
            (progress[k] ?? 0) / CANVAS_STREAM_STRIDES[k],
          ),
        ),
      );
      geo.loaded = loaded;
      const now = performance.now();
      // 首个完整 SoA 行立即可画；空进度和重复进度只会浪费一轮节流。
      if (
        loaded > lastEmitted &&
        (lastEmitted === 0 || now - lastEmit > 250 || loaded === n)
      ) {
        lastEmit = now;
        lastEmitted = loaded;
        onChunk(loaded);
      }
    };
    const encodedPositionBytes = new Uint8Array(n * 6);
    const encodedPositions = new Uint16Array(encodedPositionBytes.buffer);
    let decodedRanks = 0;
    const positionStream = streamInto(
      "positions.bin",
      encodedPositionBytes,
      (bytes) => {
        const completeRanks = Math.floor(bytes / CANVAS_STREAM_STRIDES.positions);
        decodePositionRange(
          encodedPositions,
          geo.positions,
          decodedRanks,
          completeRanks,
          manifest.position_encoding,
        );
        decodedRanks = completeRanks;
        progress.positions = bytes;
        update();
      },
    );
    return Promise.all([
      positionStream,
      ...(Object.keys(raw) as (keyof typeof raw)[]).map((k) =>
        streamInto(`${k}.bin`, raw[k], (bytes) => {
          progress[k] = bytes;
          update();
        }),
      ),
    ]).then(() => update());
  };
  return { geo, start };
}

/** 精确 Range 读取;总长度与 manifest 不符判定发布已被替换。
 * 不支持 Range 的服务器回退整文件校验后本地切片(至多一个 pack)。 */
async function rangeFetch(
  path: string,
  off: number,
  len: number,
  signal?: AbortSignal,
  allowWhole = true,
): Promise<PackAccess> {
  guard();
  const [total] = publishedMeta(path);
  if (off < 0 || len <= 0 || off + len > total)
    throw new RangeError(`${path}: slice [${off}, ${off + len}) is invalid`);
  const res = await fetchPublished(path, {
    headers: { Range: `bytes=${off}-${off + len - 1}` },
    signal,
  });
  if (res.status === 206) {
    const header = res.headers.get("Content-Range");
    try {
      assertContentRange(path, header, off, len, total);
    } catch (error) {
      enterReleaseChanged(
        error instanceof Error ? error.message : `${path} Content-Range 无效`,
      );
    }
    const part = await readPublishedBody(res, len, `${path} range`);
    return { kind: "range", off, len, buffer: part };
  }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  if (!allowWhole) {
    void res.body?.cancel();
    throw new SiteDataContractError(`${path}: server stopped honoring Range`);
  }
  const whole = await readPublishedResponse(path, res);
  return { kind: "whole", buffer: whole.buffer as ArrayBuffer };
}

async function readExactBody(
  response: Response,
  expected: number,
  label: string,
): Promise<ArrayBuffer> {
  if (!response.body)
    throw new ResponseLengthError(`${label}: response body is missing`);
  const output = new Uint8Array(expected);
  const reader = response.body.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > expected) {
      await reader.cancel();
      throw new ResponseLengthError(
        `${label} exceeds declared length ${expected}`,
      );
    }
    output.set(value, offset);
    offset += value.byteLength;
  }
  if (offset !== expected)
    throw new ResponseLengthError(
      `${label}: expected ${expected} bytes, received ${offset}`,
    );
  return output.buffer;
}

async function readLimitedBody(
  response: Response,
  cap: number,
  label: string,
): Promise<Uint8Array> {
  if (!response.body)
    throw new SiteDataContractError(`${label}: response body is missing`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new SiteDataContractError(`${label} exceeds byte cap ${cap}`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

type PackAccess =
  | { kind: "whole"; buffer: ArrayBuffer }
  | { kind: "range"; off: number; len: number; buffer: ArrayBuffer };

type PackMode = "range" | "whole";

/** 首次点查共享一次探测:服务器不支持 Range(开发环境)时整包
 * 缓存一次,后续切片全部本地完成,并发调用合并为一个请求。 */
const packAccess = new SharedAbortableMemo<string, PackAccess>();
const wholePackLoads = new SharedAbortableMemo<string, ArrayBuffer>();
const packRangeLoads = new SharedAbortableMemo<string, PackAccess>();
const packModes = new Map<string, PackMode>();
const ephemeralPackRangeRefs = new Map<string, number>();

function packPrefetchKey(path: string, off: number, len: number): string {
  return `${path}:${off}:${len}`;
}

function storePrefetchedPack(
  path: string,
  off: number,
  buffer: ArrayBuffer,
): void {
  const key = packPrefetchKey(path, off, buffer.byteLength);
  prefetchedPacks.set(key, { off, buffer }, buffer.byteLength);
  const keys = prefetchedPackKeys.get(path) ?? [];
  const previous = keys.indexOf(key);
  if (previous >= 0) keys.splice(previous, 1);
  keys.push(key);
  prefetchedPackKeys.set(path, keys);
}

function deletePrefetchedPack(path: string, key: string): void {
  prefetchedPacks.delete(key);
  const keys = prefetchedPackKeys.get(path);
  if (!keys) return;
  const index = keys.indexOf(key);
  if (index >= 0) keys.splice(index, 1);
  if (!keys.length) prefetchedPackKeys.delete(path);
}

function prefetchedPack(
  path: string,
  off: number,
  len: number,
): PrefetchedPack | undefined {
  const keys = prefetchedPackKeys.get(path);
  if (!keys) return undefined;
  for (let index = keys.length - 1; index >= 0; index--) {
    const key = keys[index];
    if (!key) continue;
    const value = prefetchedPacks.get(key);
    if (!value) {
      keys.splice(index, 1);
      continue;
    }
    if (off >= value.off && off + len <= value.off + value.buffer.byteLength)
      return value;
  }
  if (!keys.length) prefetchedPackKeys.delete(path);
  return undefined;
}

/** 全量扫描前显式预取一个受上限约束、内容寻址且摘要校验过的 pack。
 * 点查不调用它，仍保持 Range 成员读取。 */
export async function prefetchPack(
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const [size] = publishedMeta(path);
  if (prefetchedPack(path, 0, size)) return;
  const cap = manifestRef?.limits.pack_cap ?? 0;
  if (size > cap)
    throw new SiteDataContractError(`${path} 超过整包预取上限 ${cap}`);
  const buffer = await wholePackLoads.get(
    path,
    async (workSignal) => {
      const bytes = await loadPublishedBytes(
        path,
        { priority: "low", signal: workSignal } as RequestInit,
        cap,
      );
      const whole = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      storePrefetchedPack(path, 0, whole);
      packModes.set(path, "whole");
      return whole;
    },
    signal,
  );
  // 同一时刻另一个大包可能触发 LRU；调用方仍可安全回退 Range。
  if (!prefetchedPack(path, 0, size)) storePrefetchedPack(path, 0, buffer);
  packModes.set(path, "whole");
}

/** 全量扫描已知的连续成员区间时只预取该区间。Range 响应依赖成员
 * CRC 与 Content-Range 校验；不支持 Range 的服务器仍回退完整 pack。 */
export async function prefetchPackRange(
  path: string,
  off: number,
  len: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const [size] = publishedMeta(path);
  const cap = manifestRef?.limits.pack_cap ?? 0;
  if (
    !Number.isInteger(off) ||
    off < 0 ||
    !Number.isInteger(len) ||
    len <= 0 ||
    off + len > size ||
    len > cap
  ) throw new RangeError(`${path}: prefetch range [${off}, ${off + len}) is invalid`);
  if (prefetchedPack(path, off, len)) return;
  const key = packPrefetchKey(path, off, len);
  const access = await packRangeLoads.get(
    key,
    async (workSignal) => {
      const result = await rangeFetch(path, off, len, workSignal);
      if (result.kind === "whole") {
        storePrefetchedPack(path, 0, result.buffer);
        packModes.set(path, "whole");
      } else {
        storePrefetchedPack(path, result.off, result.buffer);
        packModes.set(path, "range");
      }
      return result;
    },
    signal,
  );
  if (!prefetchedPack(path, off, len)) {
    if (access.kind === "whole") storePrefetchedPack(path, 0, access.buffer);
    else storePrefetchedPack(path, access.off, access.buffer);
  }
}

/** Coalesce adjacent decoded-cache misses into exact pack ranges. This keeps
 * authoritative gzip members independently decoded and cached while avoiding
 * one HTTP round trip per physically adjacent member. */
export async function prefetchMemberRanges(
  family: CacheFamily,
  path: string,
  ranges: readonly (readonly [offset: number, length: number])[],
  signal?: AbortSignal,
): Promise<() => void> {
  signal?.throwIfAborted();
  const memberCap = manifestRef?.limits.member_cap ?? 0;
  const packCap = manifestRef?.limits.pack_cap ?? 0;
  const missing = new Map<string, [offset: number, length: number]>();
  for (const [offset, length] of ranges) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(length) ||
      length <= 0 ||
      length > memberCap
    ) throw new SiteDataContractError(`${path}: invalid member boundary`);
    const key = `${path}:${offset}:${length}`;
    if (caches[family].get(key) === undefined)
      missing.set(key, [offset, length]);
  }
  if (missing.size < 2) return () => {};
  const ordered = [...missing.values()].sort(
    (left, right) => left[0] - right[0] || left[1] - right[1],
  );
  const spans: [offset: number, length: number][] = [];
  let start = ordered[0]![0];
  let end = start + ordered[0]![1];
  let count = 1;
  const flush = (): void => {
    if (count > 1) spans.push([start, end - start]);
  };
  for (const [offset, length] of ordered.slice(1)) {
    if (offset < end)
      throw new SiteDataContractError(`${path}: member ranges overlap`);
    if (offset === end && offset + length - start <= packCap) {
      end += length;
      count++;
      continue;
    }
    flush();
    start = offset;
    end = offset + length;
    count = 1;
  }
  flush();
  if (!spans.length) return () => {};
  const leases: string[] = [];
  for (const [offset, length] of spans) {
    const key = packPrefetchKey(path, offset, length);
    const references = ephemeralPackRangeRefs.get(key);
    if (references !== undefined) {
      ephemeralPackRangeRefs.set(key, references + 1);
      leases.push(key);
    } else if (prefetchedPacks.get(key) === undefined) {
      ephemeralPackRangeRefs.set(key, 1);
      leases.push(key);
    }
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const key of leases) {
      const references = ephemeralPackRangeRefs.get(key);
      if (references === undefined) continue;
      if (references > 1) {
        ephemeralPackRangeRefs.set(key, references - 1);
        continue;
      }
      ephemeralPackRangeRefs.delete(key);
      deletePrefetchedPack(path, key);
    }
  };
  try {
    await Promise.all(spans.map(([offset, length]) =>
      prefetchPackRange(path, offset, length, signal)
    ));
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

async function packSlice(
  path: string,
  off: number,
  len: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  const prefetched = prefetchedPack(path, off, len);
  if (prefetched)
    return prefetched.buffer.slice(
      off - prefetched.off,
      off - prefetched.off + len,
    );
  const mode = packModes.get(path);
  if (mode === "whole") {
    // 整包被 LRU 淘汰后重新探测，兼容 Range 与无 Range 服务器。
  }
  if (mode === "range") {
    const direct = await rangeFetch(path, off, len, signal, false);
    return direct.buffer;
  }

  const access = await packAccess.get(
    path,
    async (workSignal) => {
      const result = await rangeFetch(path, off, len, workSignal);
      packModes.set(path, result.kind);
      if (result.kind === "whole")
        storePrefetchedPack(path, 0, result.buffer);
      return result;
    },
    signal,
  );
  if (access.kind === "whole") return access.buffer.slice(off, off + len);
  if (access.off === off && access.len === len) return access.buffer.slice(0);
  const direct = await rangeFetch(path, off, len, signal, false);
  return direct.buffer;
}

/** gzip 成员解压;CRC32 或长度校验失败判定发布已被替换。 */
async function gunzipBytes(
  buf: ArrayBuffer,
  compressedCap = manifestRef?.limits.member_cap ?? 0,
): Promise<Uint8Array> {
  if (buf.byteLength > compressedCap)
    throw new SiteDataContractError(
      `gzip member exceeds member cap ${compressedCap}`,
    );
  const body = new Response(buf).body;
  if (!body) throw new Error("gunzip: empty body");
  try {
    const stream = body.pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cap = manifestRef?.limits.member_raw_cap ?? 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        void reader.cancel();
        throw new SiteDataContractError(
          `gzip decoded member exceeds decoded member cap ${cap}`,
        );
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } catch (error) {
    if (error instanceof SiteDataContractError) throw error;
    enterReleaseChanged("gzip 成员校验失败");
  }
}

const memberMemo = new SharedAbortableMemo<string, unknown>();

type MemberDecoder<T> = (bytes: Uint8Array) => T;

async function readMember<T>(
  family: CacheFamily,
  path: string,
  off: number,
  len: number,
  cacheKey: string,
  decode: MemberDecoder<T>,
  signal: AbortSignal,
): Promise<T> {
  const bytes = await gunzipBytes(await packSlice(path, off, len, signal));
  const value = decode(bytes);
  caches[family].set(cacheKey, value, bytes.byteLength);
  return value;
}

async function cachedMember<T>(
  family: CacheFamily,
  path: string,
  off: number,
  len: number,
  decode: MemberDecoder<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const memberCap = manifestRef?.limits.member_cap ?? 0;
  if (
    !Number.isInteger(off) ||
    off < 0 ||
    !Number.isInteger(len) ||
    len <= 0 ||
    len > memberCap
  )
    throw new SiteDataContractError(`${path}: invalid member boundary`);
  const cacheKey = `${path}:${off}:${len}`;
  const hit = caches[family].get(cacheKey);
  if (hit !== undefined) return hit as T;
  return memberMemo.get(
    cacheKey,
    (workSignal) =>
      readMember(family, path, off, len, cacheKey, decode, workSignal),
    signal,
  ) as Promise<T>;
}

/** 读取 JSON gzip 成员；只有通过调用方校验的数据才进入分族 LRU。 */
export function member<T>(
  family: CacheFamily,
  path: string,
  off: number,
  len: number,
  signal?: AbortSignal,
  validate?: (value: unknown) => T,
): Promise<T> {
  return cachedMember(
    family,
    path,
    off,
    len,
    (bytes) => {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return validate ? validate(value) : value as T;
    },
    signal,
  );
}

function binaryMember(
  family: CacheFamily,
  path: string,
  off: number,
  len: number,
  validate: (bytes: Uint8Array) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return cachedMember(
    family,
    path,
    off,
    len,
    (bytes) => {
      validate(bytes);
      return bytes;
    },
    signal,
  );
}

// ---- 小型索引:整文件读取并常驻(不参与 LRU) ----

const pinned = new AsyncMemo<string, unknown>();

/** gzip 整文件 JSON 目录(entities/episodes/facts/text/vocab idx)。 */
export function loadGzJson<T>(path: string): Promise<T> {
  return pinned.get(path, async () => {
    const bytes = await loadPublishedBytes(path);
    const compressedCap = path === "text.idx"
      ? manifestRef?.limits.text_index_cap ?? 0
      : manifestRef?.limits.member_cap ?? 0;
    const out = await gunzipBytes(bytes.buffer as ArrayBuffer, compressedCap);
    return JSON.parse(new TextDecoder().decode(out)) as unknown;
  }) as Promise<T>;
}

const idxCache = new AsyncMemo<string, Uint32Array>();
let loadedKeyIndex: Uint32Array | null = null;

export interface SubjectQueryColumns {
  nodeCount: number;
  sourceCount?: number;
  year?: Uint16Array;
  score?: Uint8Array;
  flags?: Uint8Array;
  dateCodes?: Uint16Array;
  dateDictionary?: readonly string[];
  bgmRank?: Uint16Array;
}

/** Exact Subject columns used only by a release that declares the matching
 * rank-aligned v1 and source-id-aligned v2 capabilities. */
export async function loadSubjectQueryColumns(
  fields: readonly string[] = ["year", "score", "type", "nsfw"],
  signal?: AbortSignal,
): Promise<SubjectQueryColumns> {
  const count = manifestRef?.n_nodes ?? 0;
  const sourceLayout = manifestRef?.query?.subjectColumns;
  const sourceCount = sourceLayout?.count ?? 0;
  const loadUint16 = (
    key: string,
    path: string,
    expectedCount: number,
    label: string,
  ): Promise<Uint16Array> =>
    pinned.get(key, async () => {
      const bytes = await loadPublishedBytes(path);
      if (bytes.byteLength !== expectedCount * 2)
        throw new SiteDataContractError(
          `${label} 查询列宽度与声明 count 不一致`,
        );
      const values = new Uint16Array(expectedCount);
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      for (let index = 0; index < expectedCount; index++)
        values[index] = view.getUint16(index * 2, true);
      return values;
    }) as Promise<Uint16Array>;
  const loadYear = (): Promise<Uint16Array> =>
    loadUint16("subject-query-year", "year.bin", count, "Subject year");
  const loadBytes = (path: "score.bin" | "flags.bin"): Promise<Uint8Array> =>
    pinned.get(`subject-query-${path}`, async () => {
      const bytes = await loadPublishedBytes(path);
      if (bytes.byteLength !== count)
        throw new SiteDataContractError(`${path} 查询列宽度与 n_nodes 不一致`);
      return Uint8Array.from(bytes);
    }) as Promise<Uint8Array>;
  const needsYear = fields.includes("year");
  const needsScore = fields.includes("score");
  const needsFlags = fields.includes("type") || fields.includes("nsfw");
  const needsDate = fields.includes("date");
  const needsRank = fields.includes("rank");
  if ((needsDate || needsRank) && !sourceLayout)
    throw new SiteDataContractError("Subject source-id 查询列声明缺失");
  const loadDate = (): Promise<{
    codes: Uint16Array;
    dictionary: readonly string[];
  }> => pinned.get("subject-query-date", async () => {
    const layout = sourceLayout!;
    const [codes, rawDictionary] = await Promise.all([
      loadUint16(
        `subject-query-${layout.date.codes}`,
        layout.date.codes,
        sourceCount,
        "Subject date code",
      ),
      loadGzJson<unknown>(layout.date.dictionary),
    ]);
    if (
      !Array.isArray(rawDictionary) ||
      rawDictionary.length > 0x1_0000 ||
      rawDictionary.some((value) => typeof value !== "string") ||
      new Set(rawDictionary).size !== rawDictionary.length
    ) throw new SiteDataContractError("Subject date 查询字典无效");
    const dictionary = rawDictionary as string[];
    for (const code of codes)
      if (code >= dictionary.length)
        throw new SiteDataContractError("Subject date 查询列引用字典外编码");
    return { codes, dictionary };
  }) as Promise<{ codes: Uint16Array; dictionary: readonly string[] }>;
  const [year, score, flags, date, bgmRank] = await Promise.all([
    needsYear ? waitForSignal(loadYear(), signal) : Promise.resolve(undefined),
    needsScore
      ? waitForSignal(loadBytes("score.bin"), signal)
      : Promise.resolve(undefined),
    needsFlags
      ? waitForSignal(loadBytes("flags.bin"), signal)
      : Promise.resolve(undefined),
    needsDate
      ? waitForSignal(loadDate(), signal)
      : Promise.resolve(undefined),
    needsRank
      ? waitForSignal(
        loadUint16(
          `subject-query-${sourceLayout!.rank.values}`,
          sourceLayout!.rank.values,
          sourceCount,
          "Subject Bangumi rank",
        ),
        signal,
      )
      : Promise.resolve(undefined),
  ]);
  return {
    nodeCount: count,
    sourceCount,
    year,
    score,
    flags,
    dateCodes: date?.codes,
    dateDictionary: date?.dictionary,
    bgmRank,
  };
}

/** u32 累计偏移索引；校验与读取一起进入发布级 Promise 缓存。 */
function loadIdx(
  path: string,
  validate?: (index: Uint32Array) => void,
): Promise<Uint32Array> {
  return idxCache.get(path, async () => {
    const bytes = await loadPublishedBytes(path);
    if (bytes.byteLength % 4 !== 0)
      throw new Error(`${path}: byte length is not a u32 array`);
    const index = new Uint32Array(bytes.byteLength / 4);
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    for (let offset = 0; offset < bytes.byteLength; offset += 4)
      index[offset / 4] = view.getUint32(offset, true);
    validate?.(index);
    return index;
  });
}

/** rank 有序的稳定 EntityKey；查询 Worker 按搜索候选批量回到权威实体。 */
export function loadEntityKeys(signal?: AbortSignal): Promise<Uint32Array> {
  const pending = idxCache.get("key.bin", async () => {
    const bytes = await loadPublishedBytes("key.bin");
    const expected = manifestRef?.n_nodes ?? 0;
    if (bytes.byteLength !== expected * 4)
      throw new SiteDataContractError("key.bin 与 n_nodes 不一致");
    const keys = new Uint32Array(expected);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.byteLength; offset += 4)
      keys[offset / 4] = view.getUint32(offset, true);
    loadedKeyIndex = keys;
    return keys;
  });
  return waitForSignal(pending, signal);
}

/** 已完成整表加载时返回 rank 有序的 EntityKey；不会触发网络请求。 */
export function loadedEntityKeys(): Uint32Array | null {
  return loadedKeyIndex;
}

/** EpisodeId -> Subject 源 id；Range 服务器只读取一个 u32。 */
export async function subjectForEpisode(
  episodeId: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const index = manifestRef?.episode_index;
  if (
    !index ||
    !Number.isSafeInteger(episodeId) ||
    episodeId < 0 ||
    episodeId >= index.count
  )
    return null;
  const cached = episodeSubjects.get(episodeId);
  if (cached !== undefined) return cached;
  return episodeSubjectLoads.get(
    episodeId,
    async (workSignal) => {
      const bytes = await packSlice(
        "episode-subject.bin",
        episodeId * 4,
        4,
        workSignal,
      );
      const value = new DataView(bytes).getUint32(0, true);
      const subject = value === EPISODE_SUBJECT_SENTINEL ? null : value;
      episodeSubjects.set(
        episodeId,
        subject,
        EPISODE_SUBJECT_ENTRY_WEIGHT,
      );
      return subject;
    },
    signal,
  );
}

/** FactRef -> one canonical participant EntityKey; the incidence remains authoritative. */
export async function anchorForFact(
  factRef: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const index = manifestRef?.fact_index;
  if (
    !index ||
    !Number.isSafeInteger(factRef) ||
    factRef < 0 ||
    factRef >= index.count
  )
    return null;
  const bytes = await packSlice("fact-anchor.bin", factRef * 4, 4, signal);
  const key = new DataView(bytes).getUint32(0, true);
  const kind = key >>> 24;
  if (kind < 1 || kind > 3)
    throw new SiteDataContractError("fact-anchor.bin contains an invalid EntityKey");
  return key;
}

// ---- rank-by-key:u24 反向索引(深链恢复与事实参与者定位) ----

let rankBytes: Uint8Array | null = null;
let rankPromise: Promise<void> | null = null;
const rankBlocks = new Map<string, Uint8Array>();
const rankBlockLoads = new SharedAbortableMemo<string, Uint8Array>();

function rankBlockKey(kind: number, block: number): string {
  return `${kind}:${block}`;
}

function decodeRank(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] ?? 0) |
    ((bytes[at + 1] ?? 0) << 8) |
    ((bytes[at + 2] ?? 0) << 16)
  );
}

async function loadRankBlock(
  kind: number,
  block: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const manifest = manifestRef;
  const segment = manifest?.rank_index.segments[String(kind)];
  const startId = block * RANK_LOOKUP_BLOCK_IDS;
  if (!manifest || !segment || startId >= segment.count)
    throw new SiteDataContractError("rank-by-key block is unavailable");
  const key = rankBlockKey(kind, block);
  const cached = rankBlocks.get(key);
  if (cached) return cached;
  return rankBlockLoads.get(
    key,
    async (workSignal) => {
      const count = Math.min(
        RANK_LOOKUP_BLOCK_IDS,
        segment.count - startId,
      );
      const buffer = await packSlice(
        "rank-by-key.bin",
        segment.offset + startId * 3,
        count * 3,
        workSignal,
      );
      const bytes = new Uint8Array(buffer);
      for (let at = 0; at < bytes.byteLength; at += 3) {
        const rank = decodeRank(bytes, at);
        if (rank !== manifest.rank_index.sentinel && rank >= manifest.n_nodes)
          throw new SiteDataContractError(
            "rank-by-key block contains an invalid VisualRank",
          );
      }
      rankBlocks.set(key, bytes);
      return bytes;
    },
    signal,
  );
}

export function ensureRankIndex(signal?: AbortSignal): Promise<void> {
  rankPromise ??= (async () => {
    const bytes = await loadPublishedBytes(
      "rank-by-key.bin",
      { priority: "low" } as RequestInit,
      RANK_INDEX_CAP,
    );
    rankBytes = bytes;
    rankBlocks.clear();
  })().catch((error: unknown) => {
    rankPromise = null;
    throw error;
  });
  return waitForSignal(rankPromise, signal);
}

/** 稳定键 -> VisualRank;索引未载入或键不在当前发布时返回 null。 */
export function rankOfKey(key: number): number | null {
  const m = manifestRef;
  if (!m) return null;
  const seg = m.rank_index.segments[String(key >>> 24)];
  if (!seg) return null;
  const id = key & 0xffffff;
  if (id >= seg.count) return null;
  let bytes = rankBytes;
  let at = seg.offset + id * 3;
  if (!bytes) {
    const block = Math.floor(id / RANK_LOOKUP_BLOCK_IDS);
    bytes = rankBlocks.get(rankBlockKey(key >>> 24, block)) ?? null;
    if (!bytes) return null;
    at = (id - block * RANK_LOOKUP_BLOCK_IDS) * 3;
  }
  const rank = decodeRank(bytes, at);
  return rank === m.rank_index.sentinel ? null : rank;
}

/** Resolve a small set of stable keys from fixed Range blocks. Broad callers
 * fall back to the verified whole index instead of creating a request fan-out. */
export async function loadRanksByKey(
  keys: Iterable<number>,
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  signal?.throwIfAborted();
  const manifest = manifestRef;
  if (!manifest) throw new Error("manifest must be loaded before rank lookup");
  const requested = [...new Set(keys)].filter((key) => {
    if (!Number.isSafeInteger(key) || key < 0 || key > 0xffff_ffff)
      return false;
    const segment = manifest.rank_index.segments[String(key >>> 24)];
    return Boolean(segment && (key & 0xffffff) < segment.count);
  });
  const blocks = new Map<string, [kind: number, block: number]>();
  if (!rankBytes) {
    for (const key of requested) {
      const kind = key >>> 24;
      const block = Math.floor((key & 0xffffff) / RANK_LOOKUP_BLOCK_IDS);
      const cacheKey = rankBlockKey(kind, block);
      if (!rankBlocks.has(cacheKey)) blocks.set(cacheKey, [kind, block]);
    }
    if (rankPromise || blocks.size > RANK_LOOKUP_MAX_BLOCKS) {
      await ensureRankIndex(signal);
    } else {
      await Promise.all(
        [...blocks.values()].map(([kind, block]) =>
          loadRankBlock(kind, block, signal)
        ),
      );
    }
  }
  signal?.throwIfAborted();
  const resolved = new Map<number, number>();
  for (const key of requested) {
    const rank = rankOfKey(key);
    if (rank !== null) resolved.set(key, rank);
  }
  return resolved;
}

/** Dense source-id -> VisualRank segment. Missing archive IDs keep the u24
 * sentinel so callers can reproduce the canonical archive-id scan order. */
export function loadEntityRanksById(
  kind: 1 | 2 | 3,
  signal?: AbortSignal,
): Promise<Uint32Array> {
  const pending = idxCache.get(`rank-by-key:${kind}`, async () => {
    await ensureRankIndex();
    const manifest = manifestRef;
    const bytes = rankBytes;
    const segment = manifest?.rank_index.segments[String(kind)];
    if (!manifest || !bytes || !segment)
      throw new SiteDataContractError("rank-by-key segment is unavailable");
    const ranks = new Uint32Array(segment.count);
    const seen = new Uint8Array(manifest.n_nodes);
    let present = 0;
    for (let id = 0; id < segment.count; id++) {
      const at = segment.offset + id * 3;
      const rank =
        (bytes[at] ?? 0) |
        ((bytes[at + 1] ?? 0) << 8) |
        ((bytes[at + 2] ?? 0) << 16);
      ranks[id] = rank;
      if (rank === RANK_SENTINEL) continue;
      if (rank >= manifest.n_nodes || seen[rank])
        throw new SiteDataContractError("rank-by-key segment is not injective");
      seen[rank] = 1;
      present++;
    }
    const owner = kind === 1 ? "subject" : kind === 2 ? "person" : "character";
    if (present !== manifest.counts.entities[owner])
      throw new SiteDataContractError("rank-by-key entity count mismatch");
    return ranks;
  });
  return waitForSignal(pending, signal);
}

/** Range 点查:深链或行走落点未被流式覆盖时,读取定长坐标记录。 */
export async function pointByRank(
  manifest: Manifest,
  rank: number,
): Promise<{ pos: [number, number, number]; key: number } | null> {
  if (!Number.isInteger(rank) || rank < 0 || rank >= manifest.n_nodes)
    throw new RangeError(`rank ${rank} is outside geometry`);
  const [posBuf, keyBuf] = await Promise.all([
    packSlice("positions.bin", rank * 6, 6),
    packSlice("key.bin", rank * 4, 4),
  ]);
  if (posBuf.byteLength < 6 || keyBuf.byteLength < 4) return null;
  const xyz = new DataView(posBuf, 0, 6);
  return {
    pos: decodePosition(
      manifest.position_encoding,
      xyz.getUint16(0, true),
      xyz.getUint16(2, true),
      xyz.getUint16(4, true),
    ),
    key: new Uint32Array(keyBuf.slice(0, 4))[0] ?? 0,
  };
}

interface RankRows<T> {
  row(rank: number): T | null;
  load(ranks: Iterable<number>, signal?: AbortSignal): Promise<void>;
  read(
    ranks: Iterable<number>,
    signal?: AbortSignal,
  ): Promise<Map<number, T>>;
}

/** 连续 rank 分块的公共读取器:索引、成员边界、行数与 LRU 只实现一次。 */
function openRankRows<T>(
  manifest: Manifest,
  stem: string,
  family: CacheFamily,
  blockSize: number,
  validRow: (row: unknown) => boolean,
): RankRows<T> {
  const indexPath = `${stem}.idx`;
  const packPath = `${stem}.pack`;
  const blockCount = Math.ceil(manifest.n_nodes / blockSize);
  const validateIndex = (index: Uint32Array): void => {
    if (index.length !== blockCount + 1)
      throw new SiteDataContractError(
        `${indexPath} 应有 ${blockCount + 1} 项,实际为 ${index.length}`,
      );
    const [packBytes] = publishedMeta(packPath);
    if (index[0] !== 0)
      throw new SiteDataContractError(`${indexPath} must start from zero`);
    for (let block = 0; block < blockCount; block++) {
      const start = index[block] ?? 0;
      const end = index[block + 1] ?? start;
      if (end <= start || end - start > manifest.limits.member_cap)
        throw new SiteDataContractError(`${indexPath} 成员边界无效`);
    }
    if (index[blockCount] !== packBytes)
      throw new SiteDataContractError(
        `${indexPath} 终点 ${index[blockCount]} != ${packPath} ${packBytes}`,
      );
  };

  let loadedIdx: Uint32Array | null = null;
  const index = async (signal?: AbortSignal): Promise<Uint32Array> => {
    const value = await waitForSignal(loadIdx(indexPath, validateIndex), signal);
    loadedIdx = value;
    return value;
  };

  const loadBlock = async (
    block: number,
    signal?: AbortSignal,
  ): Promise<T[]> => {
    const idx = await index(signal);
    const off = idx[block] ?? 0;
    const len = (idx[block + 1] ?? off) - off;
    return member<T[]>(
      family,
      packPath,
      off,
      len,
      signal,
      (value) => {
        const expected = Math.min(
          blockSize,
          manifest.n_nodes - block * blockSize,
        );
        if (!Array.isArray(value) || value.length !== expected)
          throw new SiteDataContractError(
            `${stem} block ${block} 应有 ${expected} 行,实际为 ${Array.isArray(value) ? value.length : "non-array"}`,
          );
        if (!value.every(validRow))
          throw new SiteDataContractError(`${stem} block ${block}: invalid row`);
        return value as T[];
      },
    );
  };

  const loadBlocks = async (
    blocks: readonly number[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly [number, T[]])[]> => {
    if (!blocks.length) return [];
    const idx = await index(signal);
    const release = await prefetchMemberRanges(
      family,
      packPath,
      blocks.map((block) => {
        const off = idx[block] ?? 0;
        return [off, (idx[block + 1] ?? off) - off] as const;
      }),
      signal,
    );
    try {
      return await Promise.all(
        blocks.map(async (block) => [
          block,
          await loadBlock(block, signal),
        ] as const),
      );
    } finally {
      release();
    }
  };

  return {
    row(rank): T | null {
      if (
        !loadedIdx ||
        !Number.isInteger(rank) ||
        rank < 0 ||
        rank >= manifest.n_nodes
      )
        return null;
      const block = Math.floor(rank / blockSize);
      const off = loadedIdx[block] ?? 0;
      const len = (loadedIdx[block + 1] ?? off) - off;
      const rows = caches[family].get(`${packPath}:${off}:${len}`) as
        | T[]
        | undefined;
      return rows?.[rank % blockSize] ?? null;
    },
    async load(ranks, signal): Promise<void> {
      const needed = new Set<number>();
      for (const rank of ranks)
        if (Number.isInteger(rank) && rank >= 0 && rank < manifest.n_nodes)
          needed.add(Math.floor(rank / blockSize));
      await loadBlocks([...needed], signal);
    },
    async read(ranks, signal): Promise<Map<number, T>> {
      const requested = [...new Set(ranks)].filter(
        (rank) =>
          Number.isInteger(rank) && rank >= 0 && rank < manifest.n_nodes,
      );
      const needed = new Set(
        requested.map((rank) => Math.floor(rank / blockSize)),
      );
      const blocks = new Map(await loadBlocks([...needed], signal));
      const result = new Map<number, T>();
      for (const rank of requested) {
        const block = Math.floor(rank / blockSize);
        const row = blocks.get(block)?.[rank % blockSize];
        if (row === undefined)
          throw new SiteDataContractError(
            `${stem} rank ${rank} missing from loaded block ${block}`,
          );
        result.set(rank, row);
      }
      return result;
    },
  };
}

/** 名字按连续 rank 分块;悬停、结果或关系视图只解压实际需要的块。 */
export function openNames(manifest: Manifest): Names {
  const rows = openRankRows<NameRow>(
    manifest,
    "names",
    "names",
    manifest.name_block_size,
    (row) =>
      Array.isArray(row) &&
      row.length === 3 &&
      typeof row[0] === "string" &&
      (row[1] === null || typeof row[1] === "string") &&
      (row[2] === 1 || row[2] === 2 || row[2] === 3),
  );
  return {
    get(rank): string | null {
      const row = rows.row(rank);
      return row ? row[1] || row[0] || null : null;
    },
    row: rows.row,
    load: rows.load,
    read: rows.read,
    prefetch: (signal) => prefetchPack("names.pack", signal),
  };
}

/** 子串索引只保存 rank；完整匹配由独立别名块确认。 */
export function openSearchAliases(manifest: Manifest): SearchAliases {
  const rows = openRankRows<SearchAliasRow>(
    manifest,
    "search.alias",
    "search",
    manifest.limits.search_alias_block_ranks,
    (row) =>
      Array.isArray(row) &&
      row.length === 3 &&
      Array.isArray(row[0]) &&
      row[0].every(
        (alias) =>
          Array.isArray(alias) &&
          alias.length === 2 &&
          typeof alias[0] === "string" &&
          alias[0].length > 0 &&
          typeof alias[1] === "string",
      ) &&
      typeof row[1] === "string" &&
      (row[2] === 1 || row[2] === 2 || row[2] === 3),
  );
  return {
    ...rows,
    prefetch: (signal) => prefetchPack("search.alias.pack", signal),
  };
}

// ---- 搜索:自适应前缀目录 + 按需成员 ----

let charmap: Record<string, string> | null = null;
let charmapPromise: Promise<void> | null = null;

function validatedCharmap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SiteDataContractError("charmap.json 不是逐码点字符串映射");
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.some(([key, mapped]) => {
      if (typeof mapped !== "string") return true;
      const length = [...mapped].length;
      return (
        [...key].length !== 1 ||
        length === 0 ||
        length > SEARCH_FOLD_MAX_EXPANSION
      );
    })
  )
    throw new SiteDataContractError(
      `charmap.json 不是逐码点字符串映射(每项最多 ${SEARCH_FOLD_MAX_EXPANSION} 码点)`,
    );
  const mappings = value as Record<string, string>;
  if (
    Object.values(mappings).some(
      (mapped) =>
        [...mapped]
          .map((char) => mappings[char] ?? char)
          .join("") !== mapped,
    )
  )
    throw new SiteDataContractError("charmap.json 不是幂等映射");
  return mappings;
}

/** 幂等:搜索路径 await 它,保证折叠表就绪后才归一查询。 */
export function loadCharmap(): Promise<void> {
  charmapPromise ??= (async () => {
    charmap = validatedCharmap(
      await loadPublishedJson<unknown>("charmap.json"),
    );
  })().catch((error: unknown) => {
    charmapPromise = null;
    throw error;
  });
  return charmapPromise;
}

export function fold(text: string): string {
  return foldWithCharmap(text, charmap ?? {});
}

/** Locate a normalized match in the authoritative source text. Offsets are
 * UTF-8 byte offsets so they remain stable outside JavaScript strings. */
export function foldedUtf8Range(
  text: string,
  normalizedQuery: string,
): [number, number] | null {
  const source = text.trim();
  const prefix = text.slice(0, text.length - text.trimStart().length);
  const encoder = new TextEncoder();
  let byteOffset = encoder.encode(prefix).byteLength;
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const map = charmap ?? {};
  for (const character of source) {
    const byteLength = encoder.encode(character).byteLength;
    const code = character.codePointAt(0) ?? 0;
    const part = map[character] ??
      (code >= 65 && code <= 90 ? String.fromCodePoint(code + 32) : character);
    normalized += part;
    for (let index = 0; index < part.length; index++) {
      starts.push(byteOffset);
      ends.push(byteOffset + byteLength);
    }
    byteOffset += byteLength;
  }
  const start = normalized.indexOf(normalizedQuery);
  if (start < 0) return null;
  const end = start + normalizedQuery.length - 1;
  return [starts[start] ?? byteOffset, ends[end] ?? byteOffset];
}

export function foldWithCharmap(
  text: string,
  map: Record<string, string>,
): string {
  let out = "";
  for (const ch of text.trim()) {
    const code = ch.codePointAt(0) ?? 0;
    out += map[ch] ??
      (code >= 65 && code <= 90 ? String.fromCodePoint(code + 32) : ch);
  }
  return out;
}

interface SearchNgramIndex {
  bucketMembers: Uint32Array;
  memberOffsets: Uint32Array;
  memberFirst: Uint32Array;
  memberLast: Uint32Array;
  counts: Uint32Array;
}

/** Fixed u32 index retained by authoritative full-text search. */
function searchNgramIndex(
  index: Uint32Array,
  bucketCount = SEARCH_NGRAM_BUCKETS,
): SearchNgramIndex {
  const bucketMembers = index.subarray(0, bucketCount + 1);
  const memberCount = bucketMembers[bucketCount] ?? 0;
  const expectedLength = bucketCount * 2 + memberCount * 3 + 2;
  if (index.length !== expectedLength)
    throw new SiteDataContractError(
      `text search index 应有 ${expectedLength} 项,实际为 ${index.length}`,
    );
  const offsetsStart = bucketCount + 1;
  const firstStart = offsetsStart + memberCount + 1;
  const lastStart = firstStart + memberCount;
  const countsStart = lastStart + memberCount;
  return {
    bucketMembers,
    memberOffsets: index.subarray(offsetsStart, firstStart),
    memberFirst: index.subarray(firstStart, lastStart),
    memberLast: index.subarray(lastStart, countsStart),
    counts: index.subarray(countsStart),
  };
}

type SearchNgramMember = [
  offset: number,
  length: number,
  firstRank: number,
  lastRank: number,
];
type SearchNgramBucket = [
  count: number,
  members: SearchNgramMember[],
] | null;
type SearchNgramShard = SearchNgramBucket[];

function validateSearchNgramShard(
  value: unknown,
  shard: number,
): SearchNgramShard {
  const expectedLength = SEARCH_NGRAM_BUCKETS / SEARCH_NGRAM_SHARDS;
  if (
    !Array.isArray(value) ||
    !Number.isInteger(expectedLength) ||
    value.length !== expectedLength
  )
    throw new SiteDataContractError(
      `search.ngram shard ${shard} 目录长度无效`,
    );
  const [packBytes] = publishedMeta("search.ngram.pack");
  const memberCap = manifestRef?.limits.member_cap ?? 0;
  const nNodes = manifestRef?.n_nodes ?? 0;
  for (const entry of value) {
    if (entry === null) continue;
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !Number.isSafeInteger(entry[0]) ||
      entry[0] <= 0 ||
      entry[0] > nNodes ||
      !Array.isArray(entry[1]) ||
      entry[1].length !== Math.ceil(entry[0] / SEARCH_NGRAM_MEMBER_RANKS)
    )
      throw new SiteDataContractError("search.ngram.idx 成员边界无效");
    let priorEnd = -1;
    let priorLast = -1;
    for (const member of entry[1]) {
      if (
        !Array.isArray(member) ||
        member.length !== 4 ||
        member.some((item) => !Number.isSafeInteger(item))
      )
        throw new SiteDataContractError("search.ngram.idx 成员边界无效");
      const [offset, length, firstRank, lastRank] = member;
      if (
        offset < 0 ||
        length <= 0 ||
        length > memberCap ||
        !Number.isSafeInteger(offset + length) ||
        offset + length > packBytes ||
        firstRank < 0 ||
        firstRank > lastRank ||
        lastRank >= nNodes ||
        (priorEnd >= 0 && offset !== priorEnd)
      )
        throw new SiteDataContractError("search.ngram.idx 成员边界无效");
      if (firstRank <= priorLast)
        throw new SiteDataContractError("search.ngram.idx 桶内 rank 边界无效");
      priorEnd = offset + length;
      priorLast = lastRank;
    }
  }
  return value as SearchNgramShard;
}

async function loadSearchNgramShard(
  shard: number,
): Promise<SearchNgramShard> {
  const path = `search.ngram.idx-${shard}.json.gz`;
  return validateSearchNgramShard(await loadGzJson<unknown>(path), shard);
}

/** 与烘焙器一致地按 Unicode 码点散列连续二元字符。碰撞只会增加
 * 候选；最终仍用完整规范化名称过滤，因此不会制造错误命中。 */
export function searchGramBuckets(
  text: string,
  width = SEARCH_NGRAM_WIDTH,
): number[] {
  const chars = [...text];
  if (!Number.isInteger(width) || width <= 0)
    throw new RangeError("search gram width must be positive");
  if (chars.length < width) return [];
  const buckets = new Set<number>();
  for (let start = 0; start <= chars.length - width; start++) {
    let value = (2166136261 ^ width) >>> 0;
    for (let i = 0; i < width; i++) {
      value ^= chars[start + i]?.codePointAt(0) ?? 0;
      value = Math.imul(value, 16777619) >>> 0;
    }
    buckets.add(value & (SEARCH_NGRAM_BUCKETS - 1));
  }
  return [...buckets];
}

export interface SearchRankPage {
  ranks: number[];
  next: number | null;
}

export type TextSearchFamily =
  | "episode-identity"
  | "entity-summary"
  | "entity-infobox"
  | "episode-description"
  | "fact-summary";

export type TextSearchMember = [
  family: TextSearchFamily,
  entityKind: number,
  fileIndex: number,
  offset: number,
  length: number,
];

interface TextSearchMembers {
  schema: "text-search-members-v1";
  members: TextSearchMember[];
}

function loadTextSearchMembers(): Promise<TextSearchMembers> {
  return loadGzJson<TextSearchMembers>("text.search.members").then((value) => {
    const families = new Set<TextSearchFamily>([
      "episode-identity",
      "entity-summary",
      "entity-infobox",
      "episode-description",
      "fact-summary",
    ]);
    if (
      value.schema !== "text-search-members-v1" ||
      !Array.isArray(value.members) ||
      value.members.some((row) =>
        !Array.isArray(row) ||
        row.length !== 5 ||
        !families.has(row[0]) ||
        !Number.isInteger(row[1]) ||
        row[1] < 0 ||
        row[1] > 3 ||
        !Number.isInteger(row[2]) || row[2] < 0 ||
        !Number.isInteger(row[3]) || row[3] < 0 ||
        !Number.isInteger(row[4]) || row[4] < 0 ||
        row[4] <= 0 ||
        row[4] > MEMBER_CAP
      )
    )
      throw new SiteDataContractError("text.search.members 无效");
    return value;
  });
}

function validateTextSearchIndex(
  index: Uint32Array,
  packPath: string,
  bucketCount = SEARCH_NGRAM_BUCKETS,
): void {
  const {
    bucketMembers,
    memberOffsets,
    memberFirst,
    memberLast,
    counts,
  } = searchNgramIndex(index, bucketCount);
  const memberCount = memberFirst.length;
  const [packBytes] = publishedMeta(packPath);
  if (bucketMembers[0] !== 0 || memberOffsets[0] !== 0)
    throw new SiteDataContractError("text search index 必须从零开始");
  for (let member = 0; member < memberCount; member++) {
    const start = memberOffsets[member] ?? 0;
    const end = memberOffsets[member + 1] ?? start;
    if (end <= start || end - start > MEMBER_CAP)
      throw new SiteDataContractError("text search posting 成员边界无效");
  }
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = bucketMembers[bucket] ?? 0;
    const end = bucketMembers[bucket + 1] ?? start;
    const count = counts[bucket] ?? 0;
    if (
      end < start ||
      end > memberCount ||
      end - start !== Math.ceil(count / SEARCH_NGRAM_MEMBER_RANKS)
    )
      throw new SiteDataContractError("text search bucket 边界无效");
    for (let member = start + 1; member < end; member++)
      if ((memberLast[member - 1] ?? 0) >= (memberFirst[member] ?? 0))
        throw new SiteDataContractError("text search posting 不递增");
  }
  if ((memberOffsets[memberCount] ?? 0) !== packBytes)
    throw new SiteDataContractError("text search posting 终点不匹配");
}

export interface TextSearchMemberPage {
  members: TextSearchMember[];
  next: number | null;
  totalCandidates: number;
}

export function decodeDeltaPosting(
  bytes: Uint8Array,
  expectedCount: number,
  exclusiveUpperBound: number,
): number[] {
  const ids: number[] = [];
  let offset = 0;
  let previous = -1;
  while (ids.length < expectedCount) {
    let delta = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[offset++];
      if (byte === undefined || shift > 28)
        throw new SiteDataContractError("text search varint 截断或溢出");
      delta += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) {
        if (shift && (byte & 0x7f) === 0)
          throw new SiteDataContractError("text search varint 不是最短编码");
        break;
      }
      shift += 7;
    }
    const id = previous < 0 ? delta : previous + delta;
    if (
      !Number.isSafeInteger(id) ||
      id <= previous ||
      id >= exclusiveUpperBound
    )
      throw new SiteDataContractError("text search member id 无效");
    ids.push(id);
    previous = id;
  }
  if (offset !== bytes.byteLength)
    throw new SiteDataContractError("text search posting 含多余字节");
  return ids;
}

export function intersectSortedPostings(postings: number[][]): number[] {
  if (!postings.length) return [];
  const ordered = [...postings].sort(
    (left, right) => left.length - right.length,
  );
  let result = [...(ordered[0] ?? [])];
  for (const posting of ordered.slice(1)) {
    const intersection: number[] = [];
    let left = 0;
    let right = 0;
    while (left < result.length && right < posting.length) {
      const a = result[left] as number;
      const b = posting[right] as number;
      if (a === b) {
        intersection.push(a);
        left++;
        right++;
      } else if (a < b) left++;
      else right++;
    }
    result = intersection;
    if (!result.length) break;
  }
  return result;
}

async function textPosting(
  bucket: number,
  layout: ReturnType<typeof searchNgramIndex>,
  directorySize: number,
  packPath: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const total = layout.counts[bucket] ?? 0;
  const pages = (layout.bucketMembers[bucket + 1] ?? 0) -
    (layout.bucketMembers[bucket] ?? 0);
  const postings: number[][] = [];
  for (let page = 0; page < pages; page++) {
    signal?.throwIfAborted();
    const postingMember = (layout.bucketMembers[bucket] ?? 0) + page;
    const postingCount = Math.min(
      SEARCH_NGRAM_MEMBER_RANKS,
      total - page * SEARCH_NGRAM_MEMBER_RANKS,
    );
    const start = layout.memberOffsets[postingMember] ?? 0;
    const end = layout.memberOffsets[postingMember + 1] ?? start;
    const bytes = await binaryMember(
      "search",
      packPath,
      start,
      end - start,
      (postingBytes) => {
        const ids = decodeDeltaPosting(
          postingBytes,
          postingCount,
          directorySize,
        );
        if (
          ids.at(-1) !== layout.memberLast[postingMember] ||
          ids[0] !== layout.memberFirst[postingMember]
        )
          throw new SiteDataContractError("text search posting 与索引不匹配");
      },
      signal,
    );
    postings.push(decodeDeltaPosting(bytes, postingCount, directorySize));
  }
  return postings.flat();
}

/** Intersect every query bigram posting before reading authoritative text. */
async function textSearchMemberPageFrom(
  normalized: string,
  cursor: number,
  limit: number,
  width: number,
  stem: string,
  shards: number,
  signal?: AbortSignal,
): Promise<TextSearchMemberPage> {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit <= 0)
    throw new RangeError("text search page is invalid");
  const buckets = [...new Set(searchGramBuckets(normalized, width))];
  if (!buckets.length) return { members: [], next: null, totalCandidates: 0 };
  if (
    !Number.isInteger(shards) ||
    shards <= 0 ||
    SEARCH_NGRAM_BUCKETS % shards
  ) throw new RangeError("text search shard count is invalid");
  const bucketCount = SEARCH_NGRAM_BUCKETS / shards;
  const sources = buckets.map((bucket) => {
    const shard = bucket % shards;
    return {
      globalBucket: bucket,
      bucket: Math.floor(bucket / shards),
      indexPath: shards === 1 ? `${stem}.idx` : `${stem}-${shard}.idx`,
      packPath: shards === 1 ? `${stem}.pack` : `${stem}-${shard}.pack`,
    };
  });
  const directoryPromise = waitForSignal(loadTextSearchMembers(), signal);
  const layouts = new Map<string, ReturnType<typeof searchNgramIndex>>();
  await Promise.all([...new Map(sources.map((source) => [
    source.indexPath,
    source,
  ])).values()].map(async (source) => {
    const index = await waitForSignal(loadIdx(
      source.indexPath,
      (value) => validateTextSearchIndex(
        value,
        source.packPath,
        bucketCount,
      ),
    ), signal);
    layouts.set(source.indexPath, searchNgramIndex(index, bucketCount));
  }));
  const directory = await directoryPromise;
  sources.sort((left, right) => {
    const leftCount = layouts.get(left.indexPath)?.counts[left.bucket] ?? 0;
    const rightCount = layouts.get(right.indexPath)?.counts[right.bucket] ?? 0;
    return leftCount - rightCount || left.globalBucket - right.globalBucket;
  });
  const postings: number[][] = [];
  for (const source of sources) {
    const layout = layouts.get(source.indexPath);
    if (!layout) throw new SiteDataContractError("text search shard missing");
    postings.push(await textPosting(
      source.bucket,
      layout,
      directory.members.length,
      source.packPath,
      signal,
    ));
    if (!(postings.at(-1)?.length)) break;
  }
  const candidates = intersectSortedPostings(postings);
  const total = candidates.length;
  if (cursor >= total) return { members: [], next: null, totalCandidates: total };
  const members: TextSearchMember[] = [];
  const count = Math.min(limit, total - cursor);
  for (let item = cursor; item < cursor + count; item++) {
    const id = candidates[item];
    const descriptor = id === undefined ? undefined : directory.members[id];
    if (!descriptor) throw new SiteDataContractError("text search member missing");
    members.push(descriptor);
  }
  const consumed = cursor + count;
  return {
    members,
    next: consumed < total ? consumed : null,
    totalCandidates: total,
  };
}

export function textSearchMemberPage(
  normalized: string,
  cursor: number,
  limit: number,
  signal?: AbortSignal,
): Promise<TextSearchMemberPage> {
  return textSearchMemberPageFrom(
    normalized,
    cursor,
    limit,
    SEARCH_NGRAM_WIDTH,
    "text.search.ngram",
    TEXT_SEARCH_POSTING_SHARDS,
    signal,
  );
}

/** Two-character queries use bigram shards; longer queries use narrower
 * trigram shards. Both are required by the full-text-v1 contract. */
export function fullTextSearchMemberPage(
  normalized: string,
  cursor: number,
  limit: number,
  signal?: AbortSignal,
): Promise<TextSearchMemberPage> {
  if ([...normalized].length < TEXT_SEARCH_TRIGRAM_WIDTH)
    return textSearchMemberPage(normalized, cursor, limit, signal);
  return textSearchMemberPageFrom(
    normalized,
    cursor,
    limit,
    TEXT_SEARCH_TRIGRAM_WIDTH,
    "text.search.trigram",
    TEXT_SEARCH_POSTING_SHARDS,
    signal,
  );
}

/** 从查询的最稀疏二元字符桶按全局热度分页取候选。最终包含判断
 * 由 search.ts 对完整名称执行；散列桶本身不是结果权威。 */
export async function searchSubstringPage(
  normalized: string,
  cursor: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchRankPage> {
  const manifest = manifestRef;
  if (!manifest) throw new Error("manifest must be loaded before search");
  if (!Number.isInteger(cursor) || cursor < 0)
    throw new RangeError("substring search cursor must be non-negative");
  if (!Number.isInteger(limit) || limit <= 0)
    throw new RangeError("substring search page size must be positive");
  const buckets = searchGramBuckets(normalized);
  if (!buckets.length) return { ranks: [], next: null };

  const shardIds = [...new Set(
    buckets.map((bucket) => bucket % SEARCH_NGRAM_SHARDS),
  )];
  const directories = new Map(await waitForSignal(
    Promise.all(shardIds.map(async (shard) =>
      [shard, await loadSearchNgramShard(shard)] as const
    )),
    signal,
  ));
  const entryFor = (bucket: number): SearchNgramBucket =>
    directories.get(bucket % SEARCH_NGRAM_SHARDS)?.[
      Math.floor(bucket / SEARCH_NGRAM_SHARDS)
    ] ?? null;

  let bucket = buckets[0] ?? 0;
  let bucketEntry = entryFor(bucket);
  for (const candidate of buckets.slice(1)) {
    const candidateEntry = entryFor(candidate);
    if ((candidateEntry?.[0] ?? 0) < (bucketEntry?.[0] ?? 0)) {
      bucket = candidate;
      bucketEntry = candidateEntry;
    }
  }
  const total = bucketEntry?.[0] ?? 0;
  if (cursor >= total) return { ranks: [], next: null };
  const page = Math.floor(cursor / SEARCH_NGRAM_MEMBER_RANKS);
  const location = bucketEntry?.[1][page];
  if (!location)
    throw new SiteDataContractError("search.ngram.idx 缺少候选成员");
  const [start, length, expectedFirstRank, expectedLastRank] = location;
  const memberCursor = page * SEARCH_NGRAM_MEMBER_RANKS;
  const localCursor = cursor - memberCursor;
  const memberCount = Math.min(
    SEARCH_NGRAM_MEMBER_RANKS,
    total - memberCursor,
  );
  const count = Math.min(limit, memberCount - localCursor);
  const bytes = await binaryMember(
    "search",
    "search.ngram.pack",
    start,
    length,
    (postingBytes) => {
      if (postingBytes.byteLength !== memberCount * 3)
        throw new SiteDataContractError(
          `search.ngram.pack 成员应有 ${memberCount * 3} 字节,实际为 ${postingBytes.byteLength}`,
        );
      let priorRank = -1;
      for (let at = 0; at < postingBytes.length; at += 3) {
        const rank =
          (postingBytes[at] ?? 0) |
          ((postingBytes[at + 1] ?? 0) << 8) |
          ((postingBytes[at + 2] ?? 0) << 16);
        if (rank <= priorRank || rank >= manifest.n_nodes)
          throw new SiteDataContractError(
            "search.ngram.pack 候选不是递增的有效 VisualRank",
          );
        priorRank = rank;
      }
      const firstRank =
        (postingBytes[0] ?? 0) |
        ((postingBytes[1] ?? 0) << 8) |
        ((postingBytes[2] ?? 0) << 16);
      if (
        firstRank !== expectedFirstRank ||
        priorRank !== expectedLastRank
      )
        throw new SiteDataContractError(
          "search.ngram.pack 成员与索引 rank 边界不一致",
        );
    },
    signal,
  );
  const ranks: number[] = [];
  for (let index = localCursor; index < localCursor + count; index++) {
    const at = index * 3;
    const rank =
      (bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16);
    ranks.push(rank);
  }
  const consumed = cursor + count;
  return {
    ranks,
    next: consumed < total ? consumed : null,
  };
}

/** 归一化查询确定首字符后只读取对应目录分片。 */
export function loadSearchDir(
  normalized: string,
): Promise<Record<string, SearchNode>> {
  const first = [...normalized][0];
  if (!first) return Promise.resolve({});
  const shard = (first.codePointAt(0) ?? 0) % SEARCH_PREFIX_SHARDS;
  const path = `search.idx-${shard}.json.gz`;
  return loadGzJson<Record<string, SearchNode>>(path);
}

export async function searchMember(
  loc: [number, number],
  signal?: AbortSignal,
): Promise<SearchEntry[]> {
  return member<SearchEntry[]>(
    "search",
    "search.pack",
    loc[0],
    loc[1],
    signal,
    (value) => {
      const nNodes = manifestRef?.n_nodes ?? 0;
      if (
        !Array.isArray(value) ||
        value.some(
          (row) =>
            !Array.isArray(row) ||
            row.length !== 5 ||
            typeof row[0] !== "string" ||
            typeof row[1] !== "string" ||
            !Number.isInteger(row[2]) ||
            row[2] < 0 ||
            row[2] >= nNodes ||
            typeof row[3] !== "string" ||
            (row[4] !== 1 && row[4] !== 2 && row[4] !== 3),
        )
      )
        throw new SiteDataContractError("search.pack: invalid row");
      return value as SearchEntry[];
    },
  );
}
