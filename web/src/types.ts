/** 浏览器数据契约；与烘焙侧 Python 手写镜像，变更须同步。 */

export interface Manifest {
  /** 内容寻址版本(dump-YYYY-MM-DD-<hash>);全部数据请求以 ?v= 携带。 */
  version: string;
  /** 上游归档版本,仅用于来源追踪,不可单独作为缓存身份。 */
  dump_version: string;
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
  /** top-32 元标签名,下标 = tags.bin 位图的 bit 序。 */
  tags: string[];
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
  /** 扩展为 xyz 的世界坐标,长度 3n(流式填充)。 */
  positions: Float32Array;
  year: Uint16Array;
  key: Uint32Array;
  size: Uint8Array;
  /** bit0 nsfw(保留于数据,渲染不使用)、bit1 孤立外环、
   * bit2-4 媒介(1书籍…6三次元),余位 0。 */
  flags: Uint8Array;
  /** 评分×10(u8,无评分/非作品 = 0),属性过滤用。 */
  score: Uint8Array;
  /** top-32 元标签位图(u32,bit 序 = manifest.tags 下标)。 */
  tags: Uint32Array;
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

export type SearchEntry = [norm: string, display: string, rank: number];

export const TYPE_NAMES = ["", "作品", "人物", "角色"] as const;
// 萌系三色(天蓝/珊瑚/薄荷),暗紫底 #181226 上通过
// CVD 校验:最差对 ΔE 8.7(deutan)、对比度全 ≥3:1
export const TYPE_COLORS: [number, number, number][] = [
  [0, 0, 0],
  [61, 142, 222], // 作品 #3d8ede
  [229, 106, 64], // 人物 #e56a40
  [39, 171, 124], // 角色 #27ab7c
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
