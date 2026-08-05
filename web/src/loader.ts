/** 数据加载:几何 SoA 流式渐进、gzip 成员按 Range 点查、分族计权
 * LRU 缓存、发布切换检测。全部数据请求以该文件自身 SHA-256 寻址,
 * 字节未变的文件可跨发布复用缓存。 */

import type {
  Geometry,
  Manifest,
  NameRow,
  Names,
  SearchEntry,
  SearchNode,
} from "./types";
import { AsyncMemo } from "./async-memo";
import { WeightedLru } from "./cache";
import {
  assertByteLength,
  assertContentRange,
  sha256Hex,
} from "./data-integrity";

const BASE = "data";
let manifestRef: Manifest | null = null;

export class SiteDataContractError extends Error {
  constructor(detail: string) {
    super(`站点数据版本不兼容:${detail},请重建站点数据`);
    this.name = "SiteDataContractError";
  }
}

/** manifest 可更新，但负载是不可变内容对象；旧对象消失或数据与
 * manifest 不一致时停止请求并要求刷新，不混用两个发布。 */
export class ReleaseChangedError extends Error {
  constructor(detail: string) {
    super(`站点数据已更新(${detail}),请刷新页面`);
    this.name = "ReleaseChangedError";
  }
}

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
  names: new WeightedLru(12_000_000),
  structure: new WeightedLru(24_000_000),
  search: new WeightedLru(8_000_000),
  text: new WeightedLru(20_000_000),
};

export function cacheUsage(): Record<CacheFamily, number> {
  return {
    names: caches.names.usedWeight,
    structure: caches.structure.usedWeight,
    search: caches.search.usedWeight,
    text: caches.text.usedWeight,
  };
}

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${BASE}/manifest.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest.json: ${res.status}`);
  const m = (await res.json()) as Manifest;
  if (
    !m.version ||
    m.schema !== "structural-site-v1" ||
    m.profile !== "explorer-v1" ||
    !Number.isInteger(m.n_nodes) ||
    m.n_nodes <= 0 ||
    !m.files ||
    !m.limits ||
    !m.rank_index?.segments
  )
    throw new SiteDataContractError(
      "manifest 不是 structural-site-v1/explorer-v1 契约",
    );
  for (const [logicalName, rawMeta] of Object.entries(
    m.files as Record<string, unknown>,
  )) {
    if (!Array.isArray(rawMeta) || rawMeta.length !== 3)
      throw new SiteDataContractError(
        `${logicalName} 缺少完整 SHA-256 内容寻址物理名`,
      );
    const [size, digest, physicalName] = rawMeta;
    if (
      !Number.isInteger(size) ||
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
  const positionBytes = m.files["positions.bin"]?.[0];
  const expectedPositionBytes = m.n_nodes * 12;
  if (positionBytes !== expectedPositionBytes)
    throw new SiteDataContractError(
      `positions.bin 应为 ${expectedPositionBytes} 字节,实际为 ` +
        `${positionBytes ?? "缺失"}`,
    );
  if (m.layout?.dimensions !== 3)
    throw new SiteDataContractError(
      `布局应为 3D,实际为 ${String(m.layout?.dimensions ?? "缺失")}`,
    );
  const nameBlockSize = m.name_block_size;
  if (
    !Number.isInteger(nameBlockSize) ||
    nameBlockSize <= 0 ||
    !m.files["names.idx"] ||
    !m.files["names.pack"]
  )
    throw new SiteDataContractError("名字表 names.idx/names.pack 缺失");
  const budget = m.limits.cache_budget;
  caches.names.setBudget(budget.names);
  caches.structure.setBudget(budget.structure);
  caches.search.setBudget(budget.search);
  caches.text.setBudget(budget.text);
  // 新 SiteRelease:清空不再被当前文件摘要引用的条目与更新状态
  releaseChanged = false;
  for (const cache of Object.values(caches)) cache.clear();
  memberMemo.clear();
  pinned.clear();
  idxCache.clear();
  packAccess.clear();
  rankBytes = null;
  rankPromise = null;
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

async function fetchPublished(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  guard();
  const res = await fetch(url(path), init);
  if (res.status === 404 || res.status === 410)
    enterReleaseChanged(`${path} 的旧内容对象已不存在`);
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

/** Fetch and authenticate a complete JSON artifact from the manifest. */
export async function loadPublishedJson<T>(path: string): Promise<T> {
  guard();
  const res = await fetchPublished(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await verifyWholeFile(path, bytes);
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
    if (offset + value.byteLength > buffer.byteLength)
      throw new Error(`${path}: response exceeds allocated buffer`);
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
    positions: new Uint8Array(n * 12),
    year: new Uint8Array(n * 2),
    key: new Uint8Array(n * 4),
    size: new Uint8Array(n),
    flags: new Uint8Array(n),
    score: new Uint8Array(n),
    tags: new Uint8Array(n * 4),
  };
  const stride: Record<keyof typeof raw, number> = {
    positions: 12,
    year: 2,
    key: 4,
    size: 1,
    flags: 1,
    score: 1,
    tags: 4,
  };
  const progress: Record<string, number> = {};
  const geo: Geometry = {
    positions: new Float32Array(raw.positions.buffer),
    year: new Uint16Array(raw.year.buffer),
    key: new Uint32Array(raw.key.buffer),
    size: raw.size,
    flags: raw.flags,
    score: raw.score,
    tags: new Uint32Array(raw.tags.buffer),
    loaded: 0,
    sparse: new Map(),
  };
  let lastEmit = 0;

  const start = (onChunk: (loaded: number) => void): Promise<void> => {
    const update = (): void => {
      const loaded = Math.min(
        ...Object.keys(raw).map((k) =>
          Math.floor(
            (progress[k] ?? 0) / stride[k as keyof typeof raw],
          ),
        ),
      );
      geo.loaded = loaded;
      const now = performance.now();
      if (now - lastEmit > 250 || loaded === n) {
        lastEmit = now;
        onChunk(loaded);
      }
    };
    return Promise.all(
      (Object.keys(raw) as (keyof typeof raw)[]).map((k) =>
        streamInto(`${k}.bin`, raw[k], (bytes) => {
          progress[k] = bytes;
          update();
        }),
      ),
    ).then(() => update());
  };
  return { geo, start };
}

export async function loadEdges(): Promise<Uint32Array> {
  guard();
  const res = await fetchPublished("edges.bin", {
    priority: "low",
  } as RequestInit);
  if (!res.ok) throw new Error(`edges.bin: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await verifyWholeFile("edges.bin", buf);
  if (buf.byteLength % 8 !== 0)
    throw new Error("edges.bin: byte length is not a u32 endpoint-pair array");
  return new Uint32Array(buf.buffer);
}

/** 精确 Range 读取;总长度与 manifest 不符判定发布已被替换。
 * 不支持 Range 的服务器回退整文件校验后本地切片(至多一个 pack)。 */
async function rangeFetch(
  path: string,
  off: number,
  len: number,
): Promise<PackAccess> {
  guard();
  const [total] = publishedMeta(path);
  if (off < 0 || len <= 0 || off + len > total)
    throw new RangeError(`${path}: slice [${off}, ${off + len}) is invalid`);
  const res = await fetchPublished(path, {
    headers: { Range: `bytes=${off}-${off + len - 1}` },
  });
  if (res.status === 206) {
    const header = res.headers.get("Content-Range");
    const match = header?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
    if (match && Number(match[3]) !== total)
      enterReleaseChanged(
        `${path} 总长度 ${match[3]} != manifest ${total}`,
      );
    assertContentRange(path, header, off, len, total);
    const part = await res.arrayBuffer();
    assertByteLength(`${path} range`, part.byteLength, len);
    return { kind: "range", off, len, buffer: part };
  }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const whole = new Uint8Array(await res.arrayBuffer());
  await verifyWholeFile(path, whole);
  return { kind: "whole", buffer: whole.buffer as ArrayBuffer };
}

type PackAccess =
  | { kind: "whole"; buffer: ArrayBuffer }
  | { kind: "range"; off: number; len: number; buffer: ArrayBuffer };

/** 首次点查共享一次探测:服务器不支持 Range(开发环境)时整包
 * 缓存一次,后续切片全部本地完成,并发调用合并为一个请求。 */
const packAccess = new AsyncMemo<string, PackAccess>();

async function packSlice(
  path: string,
  off: number,
  len: number,
): Promise<ArrayBuffer> {
  const access = await packAccess.get(path, () =>
    rangeFetch(path, off, len),
  );
  if (access.kind === "whole")
    return access.buffer.slice(off, off + len);
  if (access.off === off && access.len === len)
    return access.buffer.slice(0);
  const direct = await rangeFetch(path, off, len);
  if (direct.kind === "whole") {
    packAccess.delete(path);
    void packAccess.get(path, async () => direct);
    return direct.buffer.slice(off, off + len);
  }
  return direct.buffer;
}

/** gzip 成员解压;CRC32 或长度校验失败判定发布已被替换。 */
async function gunzipBytes(buf: ArrayBuffer): Promise<Uint8Array> {
  const body = new Response(buf).body;
  if (!body) throw new Error("gunzip: empty body");
  try {
    const stream = body.pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    enterReleaseChanged("gzip 成员校验失败");
  }
}

const memberMemo = new AsyncMemo<string, unknown>();

/** 读取并解码一个 gzip 成员:Promise 合并在途请求,完成后只进入
 * 按解码字节计权的分族 LRU;缓存命中不产生网络请求。 */
export async function member<T>(
  family: CacheFamily,
  path: string,
  off: number,
  len: number,
): Promise<T> {
  const cacheKey = `${path}:${off}:${len}`;
  const hit = caches[family].get(cacheKey);
  if (hit !== undefined) return hit as T;
  return memberMemo.get(cacheKey, async () => {
    const bytes = await gunzipBytes(await packSlice(path, off, len));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    caches[family].set(cacheKey, value, bytes.byteLength);
    memberMemo.delete(cacheKey);
    return value;
  }) as Promise<T>;
}

// ---- 小型索引:整文件读取并常驻(不参与 LRU) ----

const pinned = new AsyncMemo<string, unknown>();

/** gzip 整文件 JSON 目录(entities/episodes/facts/text/vocab idx)。 */
export function loadGzJson<T>(path: string): Promise<T> {
  return pinned.get(path, async () => {
    guard();
    const res = await fetchPublished(path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await verifyWholeFile(path, bytes);
    const out = await gunzipBytes(bytes.buffer as ArrayBuffer);
    return JSON.parse(new TextDecoder().decode(out)) as unknown;
  }) as Promise<T>;
}

const idxCache = new AsyncMemo<string, Uint32Array>();

/** u32 累计偏移索引(names.idx):块 b 的片 = [idx[b], idx[b+1])。 */
function loadIdx(path: string): Promise<Uint32Array> {
  return idxCache.get(path, async () => {
    guard();
    const res = await fetchPublished(path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await verifyWholeFile(path, bytes);
    if (bytes.byteLength % 4 !== 0)
      throw new Error(`${path}: byte length is not a u32 array`);
    return new Uint32Array(bytes.buffer);
  });
}

// ---- rank-by-key:u24 反向索引(深链恢复与事实参与者定位) ----

let rankBytes: Uint8Array | null = null;
let rankPromise: Promise<void> | null = null;

export function ensureRankIndex(): Promise<void> {
  rankPromise ??= (async () => {
    guard();
    const res = await fetchPublished("rank-by-key.bin", {
      priority: "low",
    } as RequestInit);
    if (!res.ok) throw new Error(`rank-by-key.bin: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await verifyWholeFile("rank-by-key.bin", bytes);
    rankBytes = bytes;
  })().catch((error: unknown) => {
    rankPromise = null;
    throw error;
  });
  return rankPromise;
}

/** 稳定键 -> VisualRank;索引未载入或键不在当前发布时返回 null。 */
export function rankOfKey(key: number): number | null {
  const m = manifestRef;
  if (!rankBytes || !m) return null;
  const seg = m.rank_index.segments[String(key >>> 24)];
  if (!seg) return null;
  const id = key & 0xffffff;
  if (id >= seg.count) return null;
  const at = seg.offset + id * 3;
  const rank =
    (rankBytes[at] ?? 0) |
    ((rankBytes[at + 1] ?? 0) << 8) |
    ((rankBytes[at + 2] ?? 0) << 16);
  return rank === m.rank_index.sentinel ? null : rank;
}

/** Range 点查:深链或行走落点未被流式覆盖时,读取定长坐标记录。 */
export async function pointByRank(
  manifest: Manifest,
  rank: number,
): Promise<{ pos: [number, number, number]; key: number } | null> {
  if (!Number.isInteger(rank) || rank < 0 || rank >= manifest.n_nodes)
    throw new RangeError(`rank ${rank} is outside geometry`);
  const [posBuf, keyBuf] = await Promise.all([
    packSlice("positions.bin", rank * 12, 12),
    packSlice("key.bin", rank * 4, 4),
  ]);
  if (posBuf.byteLength < 12 || keyBuf.byteLength < 4) return null;
  const xyz = new Float32Array(posBuf.slice(0, 12));
  return {
    pos: [xyz[0] ?? 0, xyz[1] ?? 0, xyz[2] ?? 0],
    key: new Uint32Array(keyBuf.slice(0, 4))[0] ?? 0,
  };
}

/** 名字按连续 rank 分块;悬停、结果或关系视图只解压实际需要的块,
 * 已解码块受名字族 LRU 约束。 */
export function openNames(manifest: Manifest): Names {
  const blockSize = manifest.name_block_size;
  const blockCount = Math.ceil(manifest.n_nodes / blockSize);

  const loadBlock = async (block: number): Promise<NameRow[]> => {
    const idx = await loadIdx("names.idx");
    if (idx.length !== blockCount + 1)
      throw new SiteDataContractError(
        `names.idx 应有 ${blockCount + 1} 项,实际为 ${idx.length}`,
      );
    const off = idx[block] ?? 0;
    const len = (idx[block + 1] ?? off) - off;
    if (len <= 0) throw new Error(`names block ${block}: empty slice`);
    const rows = await member<NameRow[]>(
      "names",
      "names.pack",
      off,
      len,
    );
    const expected = Math.min(
      blockSize,
      manifest.n_nodes - block * blockSize,
    );
    if (!Array.isArray(rows) || rows.length !== expected)
      throw new SiteDataContractError(
        `names block ${block} 应有 ${expected} 行,实际为 ${rows.length}`,
      );
    return rows;
  };

  let loadedIdx: Uint32Array | null = null;
  const blockOf = (rank: number): NameRow[] | undefined => {
    // 同步查成员缓存;索引未就绪时视为未加载(load() 会补齐)
    if (!loadedIdx) return undefined;
    const block = Math.floor(rank / blockSize);
    const off = loadedIdx[block] ?? 0;
    const len = (loadedIdx[block + 1] ?? off) - off;
    return caches.names.get(`names.pack:${off}:${len}`) as
      | NameRow[]
      | undefined;
  };
  void loadIdx("names.idx").then(
    (idx) => (loadedIdx = idx),
    () => undefined,
  );

  return {
    get(rank: number): string | null {
      if (!Number.isInteger(rank) || rank < 0 || rank >= manifest.n_nodes)
        return null;
      const row = blockOf(rank)?.[rank % blockSize];
      return row ? row[1] || row[0] || null : null;
    },
    row(rank: number): NameRow | null {
      if (!Number.isInteger(rank) || rank < 0 || rank >= manifest.n_nodes)
        return null;
      return blockOf(rank)?.[rank % blockSize] ?? null;
    },
    async load(ranks: Iterable<number>): Promise<void> {
      const needed = new Set<number>();
      for (const rank of ranks)
        if (Number.isInteger(rank) && rank >= 0 && rank < manifest.n_nodes)
          needed.add(Math.floor(rank / blockSize));
      await Promise.all([...needed].map(loadBlock));
    },
  };
}

// ---- 搜索:自适应前缀目录 + 按需成员 ----

let charmap: Record<string, string> | null = null;
let charmapPromise: Promise<void> | null = null;

/** 幂等:搜索路径 await 它,保证折叠表就绪后才归一查询。 */
export function loadCharmap(): Promise<void> {
  charmapPromise ??= (async () => {
    charmap = await loadPublishedJson<Record<string, string>>(
      "charmap.json",
    );
  })().catch((error: unknown) => {
    charmapPromise = null;
    throw error;
  });
  return charmapPromise;
}

export function fold(text: string): string {
  const lower = text.trim().toLowerCase();
  if (!charmap) return lower;
  let out = "";
  for (const ch of lower) out += charmap[ch] ?? ch;
  return out;
}

/** 搜索目录在搜索框获得焦点时读取;启动不预取任何搜索成员。 */
export function loadSearchDir(): Promise<Record<string, SearchNode>> {
  return pinned.get("search.idx.json", () =>
    loadPublishedJson<Record<string, SearchNode>>("search.idx.json"),
  ) as Promise<Record<string, SearchNode>>;
}

export function searchMember(
  loc: [number, number],
): Promise<SearchEntry[]> {
  return member<SearchEntry[]>("search", "search.pack", loc[0], loc[1]);
}
