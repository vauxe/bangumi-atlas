/** 数据契约类型(EXPLORER.md §6;与烘焙侧 Python 手写镜像,变更须同步)。 */

export interface Manifest {
  n_nodes: number;
  n_edges_skeleton: number;
  buckets: number;
  adj_inline: number;
  eps_inline: number;
  bbox: [number[], number[]];
  labels: string[];
  total_bytes: number;
  n_files: number;
}

/** 几何 SoA(rank 有序)。 */
export interface Geometry {
  /** 反量化后的世界坐标,长度 3n。 */
  positions: Float32Array;
  year: Uint16Array;
  key: Uint32Array;
  community: Uint16Array;
  size: Uint8Array;
  /** bit0 nsfw、bit1 孤立外壳、bit2-4 媒介(1书籍…6三次元)。 */
  flags: Uint8Array;
  /** 已就绪的节点数(流式期间 < n)。 */
  loaded: number;
}

export interface Names {
  n: (string | null)[];
  c: (string | null)[];
}

/** 邻接分片条目:g = [labelId, ranks[]][],n = 总数,p = 溢出页数。 */
export interface AdjEntry {
  g: [number, number[]][];
  n: number;
  p?: number;
}

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
  eps?: [number, number, string, string, string][];
}

export type SearchEntry = [norm: string, display: string, rank: number];

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
