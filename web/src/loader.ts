/** 数据加载:几何 SoA 流式渐进、名字表流式、分片按需 fetch(带缓存)、
 * Range 按 rank 点查、热分片预取。全部数据请求携带 ?v=(防缓存错配)。 */

import type {
  AdjEntry,
  AdjPage,
  Detail,
  EpisodeRow,
  Geometry,
  Manifest,
  Names,
  SearchEntry,
} from "./types";
import { AsyncMemo } from "./async-memo";
import {
  assertByteLength,
  assertContentRange,
  sha256Hex,
} from "./data-integrity";

const BASE = "data";
let version = "";
let manifestRef: Manifest | null = null;

/** manifest 之后的一切数据请求都以数据版本寻址，避免跨发布缓存错配。 */
function url(path: string): string {
  return version
    ? `${BASE}/${path}?v=${encodeURIComponent(version)}`
    : `${BASE}/${path}`;
}

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${BASE}/manifest.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest.json: ${res.status}`);
  const m = (await res.json()) as Manifest;
  if (
    !m.version ||
    !Number.isInteger(m.n_nodes) ||
    m.n_nodes <= 0 ||
    !m.files
  )
    throw new Error("manifest.json: invalid data contract");
  version = m.version;
  manifestRef = m;
  return m;
}

function publishedMeta(path: string): [number, string] {
  const meta = manifestRef?.files[path];
  if (!meta) throw new Error(`${path}: missing manifest metadata`);
  return meta;
}

async function verifyWholeFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const [size, expectedHash] = publishedMeta(path);
  assertByteLength(path, bytes.byteLength, size);
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== expectedHash)
    throw new Error(
      `${path}: sha256 mismatch (${actualHash.slice(0, 12)} != ` +
        `${expectedHash.slice(0, 12)})`,
    );
}

/** Fetch and authenticate a complete JSON artifact from the manifest. */
export async function loadPublishedJson<T>(path: string): Promise<T> {
  const res = await fetch(url(path));
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
  // 优先级提示:几何七件 high(首块即渲),名字表 low(不抢带宽)
  const res = await fetch(url(path), { priority } as RequestInit);
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
  /** 启动七个 SoA 文件的并行流式填充;onChunk(loaded) 以 ~250ms
   * 节流回调。分配与启动分离:调用方先建场景再 start,
   * 首块回调必然晚于场景就绪(首块即渲的前提)。 */
  start(onChunk: (loaded: number) => void): Promise<void>;
}

/** 预分配全量缓冲并立即返回 geo 与启动句柄。 */
export function openGeometry(manifest: Manifest): GeometryStream {
  const n = manifest.n_nodes;
  const raw = {
    positions: new Uint8Array(n * 8),
    year: new Uint8Array(n * 2),
    key: new Uint8Array(n * 4),
    size: new Uint8Array(n),
    flags: new Uint8Array(n),
    score: new Uint8Array(n),
    tags: new Uint8Array(n * 4),
  };
  const stride: Record<keyof typeof raw, number> = {
    positions: 8,
    year: 2,
    key: 4,
    size: 1,
    flags: 1,
    score: 1,
    tags: 4,
  };
  const progress: Record<string, number> = {};
  const geo: Geometry = {
    positions: new Float32Array(n * 3),
    year: new Uint16Array(raw.year.buffer),
    key: new Uint32Array(raw.key.buffer),
    size: raw.size,
    flags: raw.flags,
    score: raw.score,
    tags: new Uint32Array(raw.tags.buffer),
    loaded: 0,
    sparse: new Map(),
  };
  const planar = new Float32Array(raw.positions.buffer);
  let expanded = 0;
  let lastEmit = 0;

  const start = (onChunk: (loaded: number) => void): Promise<void> => {
    const update = (): void => {
      const loaded = Math.min(
        ...Object.entries(raw).map(([k, buf]) => {
          void buf;
          return Math.floor(
            (progress[k] ?? 0) / stride[k as keyof typeof raw],
          );
        }),
      );
      for (; expanded < loaded; expanded++) {
        geo.positions[expanded * 3] = planar[expanded * 2] ?? 0;
        geo.positions[expanded * 3 + 2] = planar[expanded * 2 + 1] ?? 0;
      }
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

/** 名字表:NDJSON 逐行流式填充(与几何同序)。 */
export function loadNames(
  n: number,
): { names: Names; done: Promise<void> } {
  const names: Names = {
    n: new Array<string | null>(n).fill(null),
    c: new Array<string | null>(n).fill(null),
    loaded: 0,
  };
  const done = (async (): Promise<void> => {
    const [publishedSize] = publishedMeta("names.ndjson");
    const publishedBytes = new Uint8Array(publishedSize);
    const res = await fetch(url("names.ndjson"), {
      priority: "low",
    } as RequestInit);
    if (!res.ok || !res.body)
      throw new Error(`fetch names.ndjson: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let tail = "";
    const feed = (text: string, flush: boolean): void => {
      const lines = (tail + text).split("\n");
      tail = flush ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line) continue;
        if (names.loaded >= n)
          throw new Error(`names.ndjson: more than ${n} rows`);
        const [nm, cn] = JSON.parse(line) as [string, string | null];
        names.n[names.loaded] = nm;
        names.c[names.loaded] = cn;
        names.loaded++;
      }
    };
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      if (received + value.byteLength > publishedBytes.byteLength)
        throw new Error("names.ndjson: response exceeds published size");
      publishedBytes.set(value, received);
      received += value.byteLength;
      feed(decoder.decode(value, { stream: true }), false);
    }
    feed(decoder.decode(), true);
    assertByteLength("names.ndjson rows", names.loaded, n);
    assertByteLength("names.ndjson", received, publishedSize);
    await verifyWholeFile("names.ndjson", publishedBytes);
  })();
  return { names, done };
}

export async function loadEdges(): Promise<Uint32Array> {
  const res = await fetch(url("edges.bin"));
  if (!res.ok) throw new Error(`edges.bin: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await verifyWholeFile("edges.bin", buf);
  if (buf.byteLength % 8 !== 0)
    throw new Error("edges.bin: byte length is not a u32 endpoint-pair array");
  return new Uint32Array(buf.buffer);
}

/** Range 点查：深链或行走落点未被流式覆盖时，先读取定长坐标记录。
 * 开发环境等不支持 Range 的服务器会回整文件,这里做兼容切片。 */
export async function pointByRank(
  manifest: Manifest,
  rank: number,
): Promise<{ pos: [number, number, number]; key: number } | null> {
  if (!Number.isInteger(rank) || rank < 0 || rank >= manifest.n_nodes)
    throw new RangeError(`rank ${rank} is outside geometry`);
  const range = async (
    path: string,
    start: number,
    len: number,
  ): Promise<ArrayBuffer | null> => {
    const [total] = publishedMeta(path);
    if (start + len > total)
      throw new RangeError(`${path}: byte range exceeds published file`);
    const res = await fetch(url(path), {
      headers: { Range: `bytes=${start}-${start + len - 1}` },
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (res.status === 206) {
      assertContentRange(
        path,
        res.headers.get("Content-Range"),
        start,
        len,
        total,
      );
      assertByteLength(`${path} range`, bytes.byteLength, len);
      return bytes.buffer;
    }
    await verifyWholeFile(path, bytes);
    return bytes.buffer.slice(start, start + len);
  };
  const [posBuf, keyBuf] = await Promise.all([
    range("positions.bin", rank * 8, 8),
    range("key.bin", rank * 4, 4),
  ]);
  if (!posBuf || !keyBuf || posBuf.byteLength < 8 || keyBuf.byteLength < 4)
    return null;
  const xy = new Float32Array(posBuf.slice(0, 8));
  const pos: [number, number, number] = [xy[0] ?? 0, 0, xy[1] ?? 0];
  return { pos, key: new Uint32Array(keyBuf.slice(0, 4))[0] ?? 0 };
}

// ---- 分片打包读取:pack 文件 + 偏移索引 + Range 取片 + 逐片 gzip。
// 分片数(2.2 万)不再等于文件数(个位数 pack);详情从裸 JSON 存储
// 700MB 变为存储即压缩(~250MB),传输量与原 CDN gzip 持平 ----

type PackAccess =
  | { kind: "whole"; buffer: ArrayBuffer }
  | { kind: "range"; off: number; len: number; buffer: ArrayBuffer };

const packAccess = new AsyncMemo<string, PackAccess>();

async function probePack(
  path: string,
  off: number,
  len: number,
  total: number,
): Promise<PackAccess> {
  const res = await fetch(url(path), {
    headers: { Range: `bytes=${off}-${off + len - 1}` },
  });
  if (res.status === 206) {
    assertContentRange(
      path,
      res.headers.get("Content-Range"),
      off,
      len,
      total,
    );
    const buffer = await res.arrayBuffer();
    assertByteLength(`${path} range`, buffer.byteLength, len);
    return { kind: "range", off, len, buffer };
  }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  await verifyWholeFile(path, new Uint8Array(buffer));
  return { kind: "whole", buffer };
}

/** Range 取片;服务器不支持 Range(开发环境)时整包缓存一次,
 * 后续切片全部本地完成。 */
async function packSlice(
  path: string,
  off: number,
  len: number,
): Promise<ArrayBuffer> {
  const [total] = publishedMeta(path);
  if (off < 0 || len < 0 || off + len > total)
    throw new RangeError(`${path}: slice [${off}, ${off + len}) is invalid`);
  const access = await packAccess.get(path, () =>
    probePack(path, off, len, total),
  );
  if (access.kind === "whole") return access.buffer.slice(off, off + len);
  if (access.off === off && access.len === len) return access.buffer.slice(0);

  const res = await fetch(url(path), {
    headers: { Range: `bytes=${off}-${off + len - 1}` },
  });
  if (res.status === 206) {
    assertContentRange(
      path,
      res.headers.get("Content-Range"),
      off,
      len,
      total,
    );
    const part = await res.arrayBuffer();
    assertByteLength(`${path} range`, part.byteLength, len);
    return part;
  }
  if (res.ok) {
    const whole = await res.arrayBuffer();
    await verifyWholeFile(path, new Uint8Array(whole));
    return whole.slice(off, off + len);
  }
  throw new Error(`${path}: ${res.status}`);
}

async function gunzipJson<T>(buf: ArrayBuffer): Promise<T> {
  const body = new Response(buf).body;
  if (!body) throw new Error("gunzip: empty body");
  const stream = body.pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).json()) as T;
}

const idxCache = new AsyncMemo<string, Uint32Array>();

/** u32 累计偏移索引(buckets+1 项):桶 b 的片 = [idx[b], idx[b+1])。 */
function loadIdx(path: string): Promise<Uint32Array> {
  return idxCache.get(path, async () => {
    const res = await fetch(url(path));
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await verifyWholeFile(path, bytes);
    if (bytes.byteLength % 4 !== 0)
      throw new Error(`${path}: byte length is not a u32 array`);
    return new Uint32Array(bytes.buffer);
  });
}

const adjCache = new AsyncMemo<number, Record<string, AdjEntry>>();
const detCache = new AsyncMemo<number, Record<string, Detail>>();

async function shard<T>(
  cache: AsyncMemo<number, Record<string, T>>,
  kind: "adj" | "det",
  bucket: number,
  buckets: number,
  detPacks: number,
): Promise<Record<string, T>> {
  return cache.get(bucket, async () => {
    const idx = await loadIdx(`${kind}.idx`);
    const off = idx[bucket] ?? 0;
    const len = (idx[bucket + 1] ?? off) - off;
    let path = "adj.pack";
    let rel = off;
    if (kind === "det") {
      // det 均分多个 pack:索引存全局累计偏移,减去 pack 首桶偏移
      const per = Math.floor(buckets / detPacks);
      const p = Math.floor(bucket / per);
      path = `det-${p}.pack`;
      rel = off - (idx[p * per] ?? 0);
    }
    return len > 0
      ? gunzipJson<Record<string, T>>(await packSlice(path, rel, len))
      : ({} as Record<string, T>);
  });
}

export async function loadAdj(
  key: number,
  buckets: number,
): Promise<AdjEntry | null> {
  const s = await shard<AdjEntry>(
    adjCache,
    "adj",
    key % buckets,
    buckets,
    manifestRef?.det_packs ?? 4,
  );
  return s[String(key)] ?? null;
}

export async function loadDetail(
  key: number,
  buckets: number,
): Promise<Detail | null> {
  const s = await shard<Detail>(
    detCache,
    "det",
    key % buckets,
    buckets,
    manifestRef?.det_packs ?? 4,
  );
  return s[String(key)] ?? null;
}

/** 溢出页(邻接"展开全部" / 分集分页):偏移内嵌在所属条目里。 */
export async function loadPage<T extends AdjPage | EpisodeRow[]>(
  off: number,
  len: number,
): Promise<T> {
  return gunzipJson<T>(await packSlice("pages.pack", off, len));
}

/** 悬停预取:填充分片缓存,点击时大概率已热(对冲每周失效后的冷 CDN)。 */
export function prefetch(key: number, buckets: number): void {
  void Promise.all([loadAdj(key, buckets), loadDetail(key, buckets)]).catch(
    (error: unknown) => console.warn("prefetch failed", error),
  );
}

const searchCache = new AsyncMemo<string, SearchEntry[]>();
let charmap: Record<string, string> | null = null;
let charmapPromise: Promise<void> | null = null;

/** 幂等:搜索路径 await 它,保证折叠表就绪后才归一查询
 * (否则冷启动头几百毫秒繁体/日文旧字查询会漏命中并污染缓存)。 */
export function loadCharmap(): Promise<void> {
  charmapPromise ??= (async () => {
    charmap = await loadPublishedJson<Record<string, string>>("charmap.json");
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

let searchIdxP: Promise<Record<string, [number, number]>> | null = null;

function loadSearchIdx(): Promise<Record<string, [number, number]>> {
  searchIdxP ??= loadPublishedJson<Record<string, [number, number]>>(
    "search.idx.json",
  ).catch((error: unknown) => {
    searchIdxP = null;
    throw error;
  });
  return searchIdxP;
}

async function fetchShard(first: string): Promise<SearchEntry[]> {
  return searchCache.get(first, async () => {
    const cp = first.codePointAt(0);
    if (cp === undefined) return [];
    const loc = (await loadSearchIdx())[cp.toString(16)];
    return loc
      ? gunzipJson<SearchEntry[]>(
          await packSlice("search.pack", loc[0], loc[1]),
        )
      : [];
  });
}

export const searchShard = fetchShard;

/** 高频首字分片随首块预取，降低首次搜索命中冷分片的概率。 */
export function prefetchHotShards(manifest: Manifest): void {
  for (const hex of manifest.hot_shards) {
    const cp = Number.parseInt(hex, 16);
    if (Number.isFinite(cp))
      void fetchShard(String.fromCodePoint(cp)).catch((error: unknown) =>
        console.warn("hot search shard prefetch failed", error),
      );
  }
}
