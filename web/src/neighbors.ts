/** Scene Model 显示规则:从类型化事实生成方向文案、分组标签和
 * 工作集邻居。反向文案("← 关系名")、固定语义标签和颜色都在这里,
 * 不写入数据事实;未知原始码带领域名称显示,不丢弃记录。 */

import type { Fact, Mappings, Page } from "./types";

interface FactPageReader {
  factsFor(
    key: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Fact>>;
}

/** 当前节点的关系线只在游标到达 null 后才是完整集合。 */
export async function allRelationFacts(
  reader: FactPageReader,
  key: number,
  signal?: AbortSignal,
): Promise<Fact[]> {
  const facts: Fact[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await reader.factsFor(key, cursor, signal);
    facts.push(...page.items);
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  return facts;
}

export function factOthers(fact: Fact, selfKey: number): number[] {
  const parts = factParticipants(fact);
  const others = parts.filter((p) => p !== selfKey);
  return others.length ? others : [selfKey]; // 自环:显示自身
}

/** 抽屉 chips 的主要对端:配音三元事实按 self 角色取最相关一端。 */
export function factPrimaryOther(fact: Fact, selfKey: number): number {
  if (fact.kind === "VOICE_CREDIT") {
    if (fact.person === selfKey) return fact.character;
    if (fact.character === selfKey) return fact.person;
    return fact.person;
  }
  return factOthers(fact, selfKey)[0] ?? selfKey;
}

export function factParticipants(fact: Fact): number[] {
  switch (fact.kind) {
    case "RELATES_TO":
    case "PERSON_REL":
    case "CHARACTER_REL":
      return [fact.source, fact.target];
    case "WORKED_ON":
      return [fact.person, fact.subject];
    case "APPEARS_IN":
      return [fact.character, fact.subject];
    case "VOICE_CREDIT":
      return [fact.person, fact.character, fact.subjectContext];
  }
}

function decode(
  table: Record<string, string> | undefined,
  code: number,
  fallback: string,
): string {
  return table?.[String(code)] ?? `未知${fallback}（${code}）`;
}

/** 分组显示标签(self 视角)。方向由角色字段判定:定向关系在
 * self 为目标端时加 "← " 前缀,仅用于浏览,不表示关系互惠。 */
export function factLabel(
  fact: Fact,
  selfKey: number,
  mappings: Mappings,
): string {
  const labels = mappings.fact_labels;
  switch (fact.kind) {
    case "RELATES_TO": {
      const name = decode(labels["RELATES_TO"], fact.relationType, "关系");
      return fact.target === selfKey && fact.source !== selfKey
        ? `← ${name}`
        : name;
    }
    case "WORKED_ON":
      return decode(labels["WORKED_ON"], fact.position, "职位");
    case "APPEARS_IN":
      return decode(labels["APPEARS_IN"], fact.type, "登场");
    case "VOICE_CREDIT":
      if (fact.person === selfKey) return "配音角色";
      if (fact.character === selfKey) return "声优";
      return "配音出演";
    case "PERSON_REL": {
      const name = decode(labels["PERSON_REL"], fact.relationType, "关系");
      return fact.target === selfKey && fact.source !== selfKey
        ? `← ${name}`
        : name;
    }
    case "CHARACTER_REL": {
      const name = decode(
        labels["CHARACTER_REL"],
        fact.relationType,
        "关系",
      );
      return fact.target === selfKey && fact.source !== selfKey
        ? `← ${name}`
        : name;
    }
  }
}

/** 定向事实中 self 的方向:1 = self 是源;-1 = self 是目标;
 * 参与型事实(WORKED_ON 等)视为无方向,返回 1。 */
export function factDirection(fact: Fact, selfKey: number): 1 | -1 {
  switch (fact.kind) {
    case "RELATES_TO":
    case "PERSON_REL":
    case "CHARACTER_REL":
      return fact.target === selfKey && fact.source !== selfKey ? -1 : 1;
    default:
      return 1;
  }
}

export interface WorkingSet {
  ranks: number[];
  labels: string[];
}

const NEIGHBOR_LOOKUP_BITMAP_CAP = 2_000_000;

/** Stable relationship participants needed to materialize one complete fan. */
export function relationNeighborKeys(
  facts: readonly Fact[],
  selfKey: number,
): number[] {
  const requested = new Set<number>();
  for (const fact of facts)
    for (const other of factOthers(fact, selfKey))
      if (other !== selfKey) requested.add(other);
  return [...requested];
}

/** 反向索引尚未就绪时，把一个工作集的未解析键合并为一次流式前缀扫描。
 * knownRankOf 只负责已缓存的稀疏点或已完成的反向索引。 */
export function resolveLoadedNeighborRanks(
  facts: readonly Fact[],
  selfKey: number,
  loadedKeys: Uint32Array,
  loaded: number,
  knownRankOf: (key: number) => number | null,
): ReadonlyMap<number, number> {
  const requested = relationNeighborKeys(facts, selfKey);

  const resolved = new Map<number, number>();
  const unresolved = new Set<number>();
  for (const key of requested) {
    const rank = knownRankOf(key);
    if (rank === null) unresolved.add(key);
    else resolved.set(key, rank);
  }
  if (!unresolved.size) return resolved;

  const count = Math.min(
    Math.max(0, Math.floor(loaded)),
    loadedKeys.length,
  );
  const maxIds = [-1, -1, -1, -1];
  let bitmapBytes = 0;
  let canUseBitmaps = true;
  for (const key of unresolved) {
    const kind = key >>> 24;
    if (kind < 1 || kind > 3) {
      canUseBitmaps = false;
      break;
    }
    const id = key & 0xffffff;
    if (id <= maxIds[kind]!) continue;
    bitmapBytes += id - maxIds[kind]!;
    maxIds[kind] = id;
    if (bitmapBytes > NEIGHBOR_LOOKUP_BITMAP_CAP) {
      canUseBitmaps = false;
      break;
    }
  }
  if (canUseBitmaps) {
    const wanted = maxIds.map((maxId) =>
      maxId < 0 ? null : new Uint8Array(maxId + 1)
    );
    for (const key of unresolved)
      wanted[key >>> 24]![key & 0xffffff] = 1;
    let remaining = unresolved.size;
    for (let rank = 0; rank < count; rank++) {
      const key = loadedKeys[rank] ?? 0;
      const bitmap = wanted[key >>> 24];
      const id = key & 0xffffff;
      if (!bitmap?.[id]) continue;
      bitmap[id] = 0;
      resolved.set(key, rank);
      if (--remaining === 0) break;
    }
    return resolved;
  }

  // 极端稀疏 archive id 不值得按最大 id 分配位图；保留有界内存回退。
  for (let rank = 0; rank < count; rank++) {
    const key = loadedKeys[rank] ?? 0;
    if (!unresolved.delete(key)) continue;
    resolved.set(key, rank);
    if (!unresolved.size) break;
  }
  return resolved;
}

/** 工作集邻居:同一邻居的多种关系分别保留边和标签,按全局收藏度
 * (VisualRank 升序)排列。调用方可显式限制投影数量;未传上限时保留
 * 所有可解析关系,未解析引用(无 rank)不进入画布。 */
export function relationNeighbors(
  facts: Fact[],
  selfKey: number,
  mappings: Mappings,
  rankOf: (key: number) => number | null,
  cap?: number,
): WorkingSet {
  const rel: [number, string][] = [];
  for (const fact of facts)
    for (const other of factOthers(fact, selfKey)) {
      if (other === selfKey) continue;
      const rank = rankOf(other);
      if (rank !== null)
        rel.push([rank, factLabel(fact, selfKey, mappings)]);
  }
  rel.sort(([a], [b]) => a - b);
  const selected = cap === undefined ? rel : rel.slice(0, cap);
  return {
    ranks: selected.map(([rank]) => rank),
    labels: selected.map(([, label]) => label),
  };
}

/** 全局最热的去重邻居;首个出现的关系标签作为主边标签。 */
export function uniqueNeighbors(
  facts: Fact[],
  selfKey: number,
  mappings: Mappings,
  rankOf: (key: number) => number | null,
  cap = 50,
): WorkingSet {
  const primary = new Map<number, string>();
  for (const fact of facts)
    for (const other of factOthers(fact, selfKey)) {
      if (other === selfKey) continue;
      const rank = rankOf(other);
      if (rank !== null && !primary.has(rank))
        primary.set(rank, factLabel(fact, selfKey, mappings));
    }
  const selected = [...primary]
    .sort(([a], [b]) => a - b)
    .slice(0, cap);
  return {
    ranks: selected.map(([rank]) => rank),
    labels: selected.map(([, label]) => label),
  };
}
