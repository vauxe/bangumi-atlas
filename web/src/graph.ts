/** 连接查询:共同关联(事实交集)与有界双向 BFS 最短路径。
 *
 * 客户端 BFS 跨事实桶时不能产生无界往返,因此用三重上界约束:
 * 总深度 ≤ 6 跳、每层前沿 ≤ 48 节点、每节点只扩展热度 top-48 的
 * 邻居(工作集本就按热度排序)。超界即明确报"未找到",绝不
 * 静默扫全图。 */

import type { Data } from "./data";
import {
  factDirection,
  factLabel,
  factOthers,
  uniqueNeighbors,
} from "./neighbors";
import type { Fact, Geometry, Mappings } from "./types";

const WIDTH = 48; // 每层前沿与每节点扩展的宽度上限
const MAX_HOPS = 6;

interface Flat {
  rank: number;
  label: string;
  direction: 1 | -1;
}

/** self 视角的去重邻居,按热度截前 WIDTH。 */
function flat(
  facts: Fact[],
  selfKey: number,
  mappings: Mappings,
  rankOf: (key: number) => number | null,
): Flat[] {
  const seen = new Map<number, Flat>();
  for (const fact of facts)
    for (const other of factOthers(fact, selfKey)) {
      if (other === selfKey) continue;
      const rank = rankOf(other);
      if (rank === null || seen.has(rank)) continue;
      seen.set(rank, {
        rank,
        label: labelOf(fact, selfKey, mappings),
        direction: factDirection(fact, selfKey),
      });
    }
  return [...seen.values()].sort((a, b) => a.rank - b.rank).slice(0, WIDTH);
}

function labelOf(fact: Fact, selfKey: number, mappings: Mappings): string {
  // BFS 链路文案统一用正向名(方向另行以 ↓/↑ 表达)
  const label = factLabel(fact, selfKey, mappings);
  return label.startsWith("← ") ? label.slice(2) : label;
}

export interface CommonItem {
  rank: number;
  la: string; // 与 A 的关系显示文本
  lb: string; // 与 B 的关系显示文本
}

/** 共同关联:两节点内联事实(各自热度上限内)的邻居交集。 */
export async function findCommon(
  aRank: number,
  bRank: number,
  geo: Geometry,
  data: Data,
): Promise<{ items: CommonItem[]; direct: string | null }> {
  const [aFacts, bFacts, mappings] = await Promise.all([
    data.factsFor(geo.key[aRank] ?? 0),
    data.factsFor(geo.key[bRank] ?? 0),
    data.mappings(),
  ]);
  const aKey = geo.key[aRank] ?? 0;
  const bKey = geo.key[bRank] ?? 0;
  const rankOf = (key: number): number | null => data.rankOf(key);
  const mapA = new Map<number, string>();
  for (const item of flatAll(aFacts.items, aKey, mappings, rankOf))
    if (!mapA.has(item.rank)) mapA.set(item.rank, item.label);
  let direct: string | null = null;
  const items: CommonItem[] = [];
  const seen = new Set<number>();
  for (const item of flatAll(bFacts.items, bKey, mappings, rankOf)) {
    if (item.rank === aRank) direct ??= item.label;
    const la = mapA.get(item.rank);
    if (
      la !== undefined &&
      item.rank !== bRank &&
      item.rank !== aRank &&
      !seen.has(item.rank)
    ) {
      seen.add(item.rank);
      items.push({ rank: item.rank, la, lb: item.label });
    }
  }
  items.sort((x, y) => x.rank - y.rank);
  return { items, direct };
}

/** 不截宽的扁平化(共同关联基于全部内联事实求交)。 */
function flatAll(
  facts: Fact[],
  selfKey: number,
  mappings: Mappings,
  rankOf: (key: number) => number | null,
): Flat[] {
  const out: Flat[] = [];
  const ws = uniqueNeighbors(facts, selfKey, mappings, rankOf, Infinity);
  ws.ranks.forEach((rank, i) =>
    out.push({ rank, label: ws.labels[i] ?? "", direction: 1 }),
  );
  return out;
}

interface Visit {
  parent: number; // -1 = 源点
  label: string;
  direction: 1 | -1;
}

export interface PathResult {
  ranks: number[]; // A → … → B
  labels: string[]; // labels[i] = ranks[i] 与 ranks[i+1] 的关系
  /** 1 = ranks[i] → ranks[i+1];-1 = 关系由后者指向前者。 */
  directions: (1 | -1)[];
}

/** 有界双向 BFS。找不到(或超界)返回 null。 */
export async function findPath(
  aRank: number,
  bRank: number,
  geo: Geometry,
  data: Data,
): Promise<PathResult | null> {
  if (aRank === bRank)
    return { ranks: [aRank], labels: [], directions: [] };
  const mappings = await data.mappings();
  const rankOf = (key: number): number | null => data.rankOf(key);
  const visited: [Map<number, Visit>, Map<number, Visit>] = [
    new Map([[aRank, { parent: -1, label: "", direction: 1 }]]),
    new Map([[bRank, { parent: -1, label: "", direction: 1 }]]),
  ];
  const frontier: [number[], number[]] = [[aRank], [bRank]];

  const rebuild = (meet: number): PathResult => {
    const walk = (
      side: 0 | 1,
    ): { ranks: number[]; labels: string[]; dirs: (1 | -1)[] } => {
      const ranks: number[] = [];
      const labels: string[] = [];
      const dirs: (1 | -1)[] = [];
      let cur = meet;
      for (;;) {
        const v = visited[side].get(cur);
        ranks.push(cur);
        if (!v || v.parent === -1) break;
        labels.push(v.label);
        dirs.push(v.direction);
        cur = v.parent;
      }
      return { ranks, labels, dirs };
    };
    const wa = walk(0); // meet → … → A
    const wb = walk(1); // meet → … → B
    return {
      ranks: [...wa.ranks.reverse(), ...wb.ranks.slice(1)],
      labels: [...wa.labels.reverse(), ...wb.labels],
      directions: [
        ...wa.dirs.reverse().map((d) => d),
        ...wb.dirs.map((d) => (d === 1 ? -1 : 1) as 1 | -1),
      ],
    };
  };

  for (let depth = 0; depth < MAX_HOPS; depth++) {
    const side: 0 | 1 = frontier[0].length <= frontier[1].length ? 0 : 1;
    const other: 0 | 1 = side === 0 ? 1 : 0;
    const nodes = [...frontier[side]].sort((a, b) => a - b).slice(0, WIDTH);
    if (!nodes.length) return null;
    const pages = await Promise.all(
      nodes.map((r) => data.factsFor(geo.key[r] ?? 0)),
    );
    const next: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const from = nodes[i] ?? 0;
      const fromKey = geo.key[from] ?? 0;
      for (const item of flat(
        pages[i]?.items ?? [],
        fromKey,
        mappings,
        rankOf,
      )) {
        if (visited[side].has(item.rank)) continue;
        visited[side].set(item.rank, {
          parent: from,
          label: item.label,
          direction: item.direction,
        });
        if (visited[other].has(item.rank)) return rebuild(item.rank);
        next.push(item.rank);
      }
    }
    frontier[side] = next;
  }
  return null;
}
