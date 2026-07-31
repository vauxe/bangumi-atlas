/** 数据契约类型(EXPLORER.md §6;与烘焙侧 Python 手写镜像,变更须同步)。 */

export interface Manifest {
  /** 数据版本(dump-YYYY-MM-DD);全部数据请求以 ?v= 携带,防缓存错配。 */
  version: string;
  n_nodes: number;
  n_edges_skeleton: number;
  buckets: number;
  /** 详情 pack 均分文件数(det-{p}.pack,p = bucket / (buckets/det_packs))。 */
  det_packs: number;
  adj_inline: number;
  eps_inline: number;
  bbox: [number[], number[]];
  /** 时间滑块窗口:非零年份钳制到 [1900, 2035](上游有脏值);
   * 滑块拉满 = 不过滤,窗口外脏年份节点不受影响。 */
  year_range: [number, number];
  labels: string[];
  /** 高频首字搜索分片(hex 码点),随首块预取。 */
  hot_shards: string[];
  /** 布局报告(p95_shift_pct 等),跨周位移留观。 */
  layout: Record<string, unknown> | null;
  /** 文件名 -> [bytes, sha256](分片已打包,产物全为顶层文件)。 */
  files: Record<string, [number, string]>;
  total_bytes: number;
  n_files: number;
}

/** 几何 SoA(rank 有序)。 */
export interface Geometry {
  /** 反量化后的世界坐标,长度 3n(流式填充)。 */
  positions: Float32Array;
  year: Uint16Array;
  key: Uint32Array;
  community: Uint16Array;
  size: Uint8Array;
  /** bit0 nsfw、bit1 孤立外壳、bit2-4 媒介(1书籍…6三次元),余位 0。 */
  flags: Uint8Array;
  /** 已就绪的节点数(流式期间 < n)。 */
  loaded: number;
  /** Range 点查得到的零散坐标(深链/行走落点在流式未覆盖时)。 */
  sparse: Map<number, [number, number, number]>;
}

/** 名字表(names.ndjson 流式填充,与几何同序)。 */
export interface Names {
  n: (string | null)[];
  c: (string | null)[];
  loaded: number;
}

/** 邻接分片条目:g = [labelId, 组总数, inline ranks][],n = 总数,
 * op = 溢出页在 pages.pack 中的 [offset, len](逐片 gzip)。 */
export interface AdjEntry {
  g: [number, number, number[]][];
  n: number;
  op?: [number, number][];
}

/** 溢出页条目:[labelId, rank]。 */
export type AdjPage = [number, number][];

/** 分集行:[type, sort, name, name_cn, airdate]。 */
export type EpisodeRow = [number, number, string, string, string];

/** 详情分片条目(字段与烘焙侧一致,宽松索引)。 */
export interface Detail {
  t: string;
  st?: string;
  name: string;
  cn: string;
  r: number;
  sum: string;
  date?: string;
  score?: number | null;
  bgm_rank?: number | null;
  fav?: number[];
  tags?: string[];
  career?: string[];
  collects?: number;
  ne?: number;
  eps?: EpisodeRow[];
  /** 分集溢出页在 pages.pack 中的 [offset, len]。 */
  eo?: [number, number][];
}

/** 搜索条目;第 4 位 = 1 表示 nsfw(默认过滤,§4 反模式)。 */
export type SearchEntry = [
  norm: string,
  display: string,
  rank: number,
  nsfw?: number,
];

export const TYPE_NAMES = ["", "作品", "人物", "角色"] as const;
export const TYPE_COLORS: [number, number, number][] = [
  [0, 0, 0],
  [57, 135, 229], // 作品 #3987e5
  [217, 89, 38], // 人物 #d95926
  [25, 158, 112], // 角色 #199e70
];
export const MEDIA_NAMES: Record<number, string> = {
  1: "书籍",
  2: "动画",
  3: "音乐",
  4: "游戏",
  6: "三次元",
};

export const etype = (key: number): number => key >>> 24;
export const eid = (key: number): number => key & 0xffffff;
export const bgmUrl = (key: number): string => {
  const kind = ["", "subject", "person", "character"][etype(key)];
  return `https://bgm.tv/${kind}/${eid(key)}`;
};
