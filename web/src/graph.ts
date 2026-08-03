/** 连接查询:共同关联(邻接交集)与有界双向 BFS 最短路径。
 *
 * 客户端 BFS 跨邻接分片时不能产生无界往返，因此用三重上界约束：
 * 总深度 ≤ 6 跳、每层前沿
 * ≤ 48 节点、每节点只扩展热度 top-48 的邻居(邻接 inline 本就按
 * 热度排序,rank 越小越热,经 hub 相遇的概率最大)。超界即
 * 明确报"未找到",绝不静默扫全图。 */

import { loadAdj } from "./loader";
import { uniqueNeighbors } from "./neighbors";
import type { AdjEntry, Geometry } from "./types";

const WIDTH = 48; // 每层前沿与每节点扩展的宽度上限
const MAX_HOPS = 6;

type AdjLoader = (
  key: number,
  buckets: number,
) => Promise<AdjEntry | null>;

/** [rank, labelId] 扁平化,按 rank 升序(= 热度降序)截前 WIDTH。 */
function flat(adj: AdjEntry | null): [number, number][] {
  const { ranks, labels } = uniqueNeighbors(adj, WIDTH);
  return ranks.map((rank, i) => [rank, labels[i] ?? -1]);
}

export interface CommonItem {
  rank: number;
  la: number; // 与 A 的关系 labelId
  lb: number; // 与 B 的关系 labelId
}

/** 共同关联:两节点邻接(各自热度 top-200 inline)的交集。 */
export async function findCommon(
  aRank: number,
  bRank: number,
  geo: Geometry,
  buckets: number,
): Promise<{ items: CommonItem[]; direct: number | null }> {
  const [adjA, adjB] = await Promise.all([
    loadAdj(geo.key[aRank] ?? 0, buckets),
    loadAdj(geo.key[bRank] ?? 0, buckets),
  ]);
  const mapA = new Map<number, number>();
  for (const [lid, , ranks] of adjA?.g ?? [])
    for (const r of ranks) if (!mapA.has(r)) mapA.set(r, lid);
  let direct: number | null = null;
  const items: CommonItem[] = [];
  for (const [lid, , ranks] of adjB?.g ?? [])
    for (const r of ranks) {
      if (r === aRank) direct = lid;
      const la = mapA.get(r);
      if (la !== undefined && r !== bRank)
        items.push({ rank: r, la, lb: lid });
    }
  items.sort((x, y) => x.rank - y.rank);
  // 去重(B 侧多组含同一节点时取首个)
  const seen = new Set<number>();
  return {
    items: items.filter((it) =>
      seen.has(it.rank) ? false : (seen.add(it.rank), true),
    ),
    direct,
  };
}

interface Visit {
  parent: number; // -1 = 源点
  lid: number;
}

export interface PathResult {
  ranks: number[]; // A → … → B
  labels: number[]; // labels[i] = ranks[i] 与 ranks[i+1] 的关系
  /** 1 = ranks[i] → ranks[i+1]；-1 = 关系由后者指向前者。 */
  directions: (1 | -1)[];
}

/** 有界双向 BFS。找不到(或超界)返回 null。 */
export async function findPath(
  aRank: number,
  bRank: number,
  geo: Geometry,
  buckets: number,
  load: AdjLoader = loadAdj,
): Promise<PathResult | null> {
  if (aRank === bRank)
    return { ranks: [aRank], labels: [], directions: [] };
  const visited: [Map<number, Visit>, Map<number, Visit>] = [
    new Map([[aRank, { parent: -1, lid: -1 }]]),
    new Map([[bRank, { parent: -1, lid: -1 }]]),
  ];
  let frontier: [number[], number[]] = [[aRank], [bRank]];

  const rebuild = (meet: number): PathResult => {
    // 从相遇点分别回溯到两端,拼接
    const walk = (side: 0 | 1): { ranks: number[]; labels: number[] } => {
      const ranks: number[] = [];
      const labels: number[] = [];
      let cur = meet;
      for (;;) {
        const v = visited[side].get(cur);
        ranks.push(cur);
        if (!v || v.parent === -1) break;
        labels.push(v.lid);
        cur = v.parent;
      }
      return { ranks, labels };
    };
    const wa = walk(0); // meet → … → A
    const wb = walk(1); // meet → … → B
    return {
      ranks: [...wa.ranks.reverse(), ...wb.ranks.slice(1)],
      labels: [...wa.labels.reverse(), ...wb.labels],
      directions: [
        ...wa.labels.map(() => 1 as const),
        ...wb.labels.map(() => -1 as const),
      ],
    };
  };

  for (let depth = 0; depth < MAX_HOPS; depth++) {
    // 扩展较小的一侧;前沿按热度截宽
    const side: 0 | 1 =
      frontier[0].length <= frontier[1].length ? 0 : 1;
    const other: 0 | 1 = side === 0 ? 1 : 0;
    const nodes = [...frontier[side]].sort((a, b) => a - b).slice(0, WIDTH);
    if (!nodes.length) return null;
    const adjs = await Promise.all(
      nodes.map((r) => load(geo.key[r] ?? 0, buckets)),
    );
    const next: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const from = nodes[i] ?? 0;
      for (const [r, lid] of flat(adjs[i] ?? null)) {
        if (visited[side].has(r)) continue;
        visited[side].set(r, { parent: from, lid });
        if (visited[other].has(r)) return rebuild(r);
        next.push(r);
      }
    }
    frontier[side] = next;
  }
  return null;
}
