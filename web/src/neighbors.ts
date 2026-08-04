/** Scene Model 显示规则:从类型化事实生成方向文案、分组标签和
 * 工作集邻居。反向文案("← 关系名")、固定语义标签和颜色都在这里,
 * 不写入数据事实;未知原始码按数值显示,不丢弃记录。 */

import type { Fact, Mappings } from "./types";

/** 事实中除 self 外的参与者(角色顺序)。 */
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
  return table?.[String(code)] ?? `${fallback} ${code}`;
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

/** 工作集邻居:同一邻居的多种关系分别保留边和标签,按全局收藏度
 * (VisualRank 升序)取前 cap 条;未解析引用(无 rank)不进入画布。 */
export function relationNeighbors(
  facts: Fact[],
  selfKey: number,
  mappings: Mappings,
  rankOf: (key: number) => number | null,
  cap = 50,
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
  const selected = rel.slice(0, cap);
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
