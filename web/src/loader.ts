/** 数据加载:几何 SoA 流式渐进、名字表、分片按需 fetch(带缓存)。 */

import type {
  AdjEntry,
  Detail,
  Geometry,
  Manifest,
  Names,
  SearchEntry,
} from "./types";

const BASE = "data";

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${BASE}/manifest.json`);
  return (await res.json()) as Manifest;
}

async function streamInto(
  url: string,
  buffer: Uint8Array,
  onProgress: (bytes: number) => void,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`fetch ${url}: ${res.status}`);
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

/** 流式加载几何;onChunk(loadedNodes) 以 ~250ms 节流回调。 */
export async function loadGeometry(
  manifest: Manifest,
  onChunk: (loaded: number) => void,
): Promise<Geometry> {
  const n = manifest.n_nodes;
  const raw = {
    positions: new Uint8Array(n * 6),
    year: new Uint8Array(n * 2),
    key: new Uint8Array(n * 4),
    community: new Uint8Array(n * 2),
    size: new Uint8Array(n),
    flags: new Uint8Array(n),
  };
  const stride: Record<keyof typeof raw, number> = {
    positions: 6,
    year: 2,
    key: 4,
    community: 2,
    size: 1,
    flags: 1,
  };
  const progress: Record<string, number> = {};
  const geo: Geometry = {
    positions: new Float32Array(n * 3),
    year: new Uint16Array(raw.year.buffer),
    key: new Uint32Array(raw.key.buffer),
    community: new Uint16Array(raw.community.buffer),
    size: raw.size,
    flags: raw.flags,
    loaded: 0,
  };
  const [lo, hi] = manifest.bbox;
  const scale = [0, 1, 2].map(
    (i) => ((hi[i] ?? 1) - (lo[i] ?? 0)) / 65535,
  ) as [number, number, number];
  const qpos = new Uint16Array(raw.positions.buffer);
  let dequantized = 0;
  let lastEmit = 0;

  const update = (): void => {
    const loaded = Math.min(
      ...Object.entries(raw).map(([k, buf]) =>
        Math.floor(
          (progress[k] ?? 0) / stride[k as keyof typeof raw],
        ),
      ),
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

  await Promise.all(
    (Object.keys(raw) as (keyof typeof raw)[]).map((k) =>
      streamInto(`${BASE}/${k === "positions" ? "positions" : k}.bin`,
        raw[k], (bytes) => {
          progress[k] = bytes;
          update();
        }),
    ),
  );
  update();
  return geo;
}

export async function loadNames(): Promise<Names> {
  const res = await fetch(`${BASE}/names.json`);
  return (await res.json()) as Names;
}

export async function loadEdges(
  manifest: Manifest,
): Promise<Uint32Array> {
  const res = await fetch(`${BASE}/edges.bin`);
  const buf = await res.arrayBuffer();
  void manifest;
  return new Uint32Array(buf);
}

const adjCache = new Map<number, Record<string, AdjEntry>>();
const detCache = new Map<number, Record<string, Detail>>();

async function shard<T>(
  cache: Map<number, Record<string, T>>,
  dir: string,
  bucket: number,
): Promise<Record<string, T>> {
  const hit = cache.get(bucket);
  if (hit) return hit;
  const res = await fetch(`${BASE}/${dir}/${bucket}.json`);
  const data = (await res.json()) as Record<string, T>;
  cache.set(bucket, data);
  return data;
}

export async function loadAdj(
  key: number,
  buckets: number,
): Promise<AdjEntry | null> {
  const s = await shard(adjCache, "adj", key % buckets);
  return s[String(key)] ?? null;
}

export async function loadDetail(
  key: number,
  buckets: number,
): Promise<Detail | null> {
  const s = await shard(detCache, "det", key % buckets);
  return s[String(key)] ?? null;
}

/** 悬停预取:填充分片缓存,点击时大概率已热。 */
export function prefetch(key: number, buckets: number): void {
  void loadAdj(key, buckets);
  void loadDetail(key, buckets);
}

const searchCache = new Map<string, SearchEntry[]>();
let charmap: Record<string, string> | null = null;

export async function loadCharmap(): Promise<void> {
  const res = await fetch(`${BASE}/charmap.json`);
  charmap = (await res.json()) as Record<string, string>;
}

export function fold(text: string): string {
  const lower = text.trim().toLowerCase();
  if (!charmap) return lower;
  let out = "";
  for (const ch of lower) out += charmap[ch] ?? ch;
  return out;
}

export async function searchShard(
  first: string,
): Promise<SearchEntry[]> {
  const hit = searchCache.get(first);
  if (hit) return hit;
  const cp = first.codePointAt(0);
  if (cp === undefined) return [];
  const res = await fetch(`${BASE}/search/${cp.toString(16)}.json`);
  const data: SearchEntry[] = res.ok
    ? ((await res.json()) as SearchEntry[])
    : [];
  searchCache.set(first, data);
  return data;
}
