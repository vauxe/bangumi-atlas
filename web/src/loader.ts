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

const BASE = "data";
let version = "";

/** manifest 之后的一切数据请求都以数据版本寻址(§6 防缓存错配)。 */
function url(path: string): string {
  return version
    ? `${BASE}/${path}?v=${encodeURIComponent(version)}`
    : `${BASE}/${path}`;
}

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${BASE}/manifest.json`, { cache: "no-cache" });
  const m = (await res.json()) as Manifest;
  version = m.version;
  manifestRef = m;
  return m;
}

async function streamInto(
  path: string,
  buffer: Uint8Array,
  onProgress: (bytes: number) => void,
  priority: "high" | "low" = "high",
): Promise<void> {
  // 优先级提示:几何六件 high(首块即渲),名字表 low(不抢带宽)
  const res = await fetch(url(path), { priority } as RequestInit);
  if (!res.ok || !res.body) throw new Error(`fetch ${path}: ${res.status}`);
  const reader = res.body.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer.set(value, offset);
    offset += value.length;
    onProgress(offset);
  }
}

export interface GeometryStream {
  geo: Geometry;
  /** 启动六个 SoA 文件的并行流式填充;onChunk(loaded) 以 ~250ms
   * 节流回调。分配与启动分离:调用方先建场景再 start,
   * 首块回调必然晚于场景就绪(首块即渲的前提)。 */
  start(onChunk: (loaded: number) => void): Promise<void>;
}

/** 预分配全量缓冲并立即返回 geo 与启动句柄。 */
export function openGeometry(manifest: Manifest): GeometryStream {
  const n = manifest.n_nodes;
  const raw = {
    positions: new Uint8Array(n * 6),
    year: new Uint8Array(n * 2),
    key: new Uint8Array(n * 4),
    community: new Uint8Array(n * 2),
    size: new Uint8Array(n),
    flags: new Uint8Array(n),
    score: new Uint8Array(n),
    tags: new Uint8Array(n * 4),
  };
  const stride: Record<keyof typeof raw, number> = {
    positions: 6,
    year: 2,
    key: 4,
    community: 2,
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
    community: new Uint16Array(raw.community.buffer),
    size: raw.size,
    flags: raw.flags,
    score: raw.score,
    tags: new Uint32Array(raw.tags.buffer),
    loaded: 0,
    sparse: new Map(),
  };
  const [lo, hi] = manifest.bbox;
  const scale = [0, 1, 2].map(
    (i) => ((hi[i] ?? 1) - (lo[i] ?? 0)) / 65535,
  ) as [number, number, number];
  const qpos = new Uint16Array(raw.positions.buffer);
  let dequantized = 0;
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
      for (; dequantized < loaded; dequantized++) {
        for (let a = 0; a < 3; a++) {
          geo.positions[dequantized * 3 + a] =
            (qpos[dequantized * 3 + a] ?? 0) * (scale[a] ?? 1) +
            (lo[a] ?? 0);
        }
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
    const res = await fetch(url("names.ndjson"), {
      priority: "low",
    } as RequestInit);
    if (!res.ok || !res.body)
      throw new Error(`fetch names.ndjson: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let tail = "";
    const feed = (text: string, flush: boolean): void => {
      const lines = (tail + text).split("\n");
      tail = flush ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line) continue;
        const [nm, cn] = JSON.parse(line) as [string, string | null];
        names.n[names.loaded] = nm;
        names.c[names.loaded] = cn;
        names.loaded++;
      }
    };
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      feed(decoder.decode(value, { stream: true }), false);
    }
    feed(decoder.decode(), true);
  })();
  return { names, done };
}

export async function loadEdges(): Promise<Uint32Array> {
  const res = await fetch(url("edges.bin"));
  const buf = await res.arrayBuffer();
  return new Uint32Array(buf);
}

/** Range 点查:深链/行走落点在流式未覆盖时先取坐标(§6 定长记录)。
 * 开发环境等不支持 Range 的服务器会回整文件,这里做兼容切片。 */
export async function pointByRank(
  manifest: Manifest,
  rank: number,
): Promise<{ pos: [number, number, number]; key: number } | null> {
  const range = async (
    path: string,
    start: number,
    len: number,
  ): Promise<ArrayBuffer | null> => {
    const res = await fetch(url(path), {
      headers: { Range: `bytes=${start}-${start + len - 1}` },
    });
    if (res.status === 206) return res.arrayBuffer();
    if (res.ok) return (await res.arrayBuffer()).slice(start, start + len);
    return null;
  };
  const [posBuf, keyBuf] = await Promise.all([
    range("positions.bin", rank * 6, 6),
    range("key.bin", rank * 4, 4),
  ]);
  if (!posBuf || !keyBuf || posBuf.byteLength < 6 || keyBuf.byteLength < 4)
    return null;
  const q = new Uint16Array(posBuf.slice(0, 6));
  const [lo, hi] = manifest.bbox;
  const pos = [0, 1, 2].map(
    (i) =>
      ((q[i] ?? 0) * ((hi[i] ?? 1) - (lo[i] ?? 0))) / 65535 + (lo[i] ?? 0),
  ) as [number, number, number];
  return { pos, key: new Uint32Array(keyBuf.slice(0, 4))[0] ?? 0 };
}

// ---- 分片打包读取:pack 文件 + 偏移索引 + Range 取片 + 逐片 gzip。
// 分片数(2.2 万)不再等于文件数(个位数 pack);详情从裸 JSON 存储
// 700MB 变为存储即压缩(~250MB),传输量与原 CDN gzip 持平 ----

const packFull = new Map<string, Promise<ArrayBuffer>>();

/** Range 取片;服务器不支持 Range(开发环境)时整包缓存一次,
 * 后续切片全部本地完成。 */
async function packSlice(
  path: string,
  off: number,
  len: number,
): Promise<ArrayBuffer> {
  const cached = packFull.get(path);
  if (cached) return (await cached).slice(off, off + len);
  const res = await fetch(url(path), {
    headers: { Range: `bytes=${off}-${off + len - 1}` },
  });
  if (res.status === 206) return res.arrayBuffer();
  if (res.ok) {
    const whole = res.arrayBuffer();
    packFull.set(path, whole);
    return (await whole).slice(off, off + len);
  }
  throw new Error(`${path}: ${res.status}`);
}

async function gunzipJson<T>(buf: ArrayBuffer): Promise<T> {
  const body = new Response(buf).body;
  if (!body) throw new Error("gunzip: empty body");
  const stream = body.pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).json()) as T;
}

const idxCache = new Map<string, Promise<Uint32Array>>();

/** u32 累计偏移索引(buckets+1 项):桶 b 的片 = [idx[b], idx[b+1])。 */
function loadIdx(path: string): Promise<Uint32Array> {
  let p = idxCache.get(path);
  if (!p) {
    p = fetch(url(path))
      .then((r) => {
        if (!r.ok) throw new Error(`${path}: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => new Uint32Array(b));
    idxCache.set(path, p);
  }
  return p;
}

const adjCache = new Map<number, Record<string, AdjEntry>>();
const detCache = new Map<number, Record<string, Detail>>();

async function shard<T>(
  cache: Map<number, Record<string, T>>,
  kind: "adj" | "det",
  bucket: number,
  buckets: number,
  detPacks: number,
): Promise<Record<string, T>> {
  const hit = cache.get(bucket);
  if (hit) return hit;
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
  const data =
    len > 0
      ? await gunzipJson<Record<string, T>>(await packSlice(path, rel, len))
      : ({} as Record<string, T>);
  cache.set(bucket, data);
  return data;
}

let manifestRef: Manifest | null = null;

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
  void loadAdj(key, buckets);
  void loadDetail(key, buckets);
}

const searchCache = new Map<string, SearchEntry[]>();
let charmap: Record<string, string> | null = null;
let charmapPromise: Promise<void> | null = null;

/** 幂等:搜索路径 await 它,保证折叠表就绪后才归一查询
 * (否则冷启动头几百毫秒繁体/日文旧字查询会漏命中并污染缓存)。 */
export function loadCharmap(): Promise<void> {
  charmapPromise ??= (async () => {
    const res = await fetch(url("charmap.json"));
    charmap = (await res.json()) as Record<string, string>;
  })();
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
  searchIdxP ??= fetch(url("search.idx.json")).then(
    (r) => r.json() as Promise<Record<string, [number, number]>>,
  );
  return searchIdxP;
}

async function fetchShard(first: string): Promise<SearchEntry[]> {
  const hit = searchCache.get(first);
  if (hit) return hit;
  const cp = first.codePointAt(0);
  if (cp === undefined) return [];
  const loc = (await loadSearchIdx())[cp.toString(16)];
  const data: SearchEntry[] = loc
    ? await gunzipJson<SearchEntry[]>(
        await packSlice("search.pack", loc[0], loc[1]),
      )
    : [];
  searchCache.set(first, data);
  return data;
}

export const searchShard = fetchShard;

/** 高频首字分片随首块预取(§1:冷分片 p95 对冲)。 */
export function prefetchHotShards(manifest: Manifest): void {
  for (const hex of manifest.hot_shards) {
    const cp = Number.parseInt(hex, 16);
    if (Number.isFinite(cp)) void fetchShard(String.fromCodePoint(cp));
  }
}
