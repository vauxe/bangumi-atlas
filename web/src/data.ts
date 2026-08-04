/** 语义与文本数据的唯一入口(设计 §7)。词表 ID、成员号、偏移和
 * 磁盘元组都不越过本模块;返回值只有稳定身份、原始码和完整字符串。
 * 空文本由结构存在位表达,不触发网络请求;网络、解压、校验错误
 * 一律抛出,不伪装成空值。 */

import type {
  EpisodeRecord,
  Fact,
  FactKind,
  LongTextRef,
  LongTextResult,
  Manifest,
  Mappings,
  Names,
  Page,
  StructuralEntity,
} from "./types";
import { FACT_TAGS } from "./types";
import {
  loadGzJson,
  loadPublishedJson,
  member,
  rankOfKey,
} from "./loader";

type Loc4 = [number, number, number, number];

interface EntitiesIdx {
  width: number;
  k: Record<string, Loc4[]>;
}

interface EpisodesIdx {
  width: number;
  ranges: Loc4[];
}

interface FactsIdx {
  buckets: number;
  b: [number, number, number][][];
}

interface TextFamily {
  gzip: number;
  width: number;
  files: string[];
  ranges: Record<string, number[][]> | number[][];
}

interface VocabIdx {
  chunk: number;
  members: Record<string, [number, number][]>;
}

interface FactEntry {
  g: Record<string, unknown[][]>;
  n: Record<string, number>;
  op?: [number, number][];
}

interface EpisodeEntry {
  e: unknown[][];
  n: number;
  op?: [number, number][];
}

/** 存在位为真时，索引或成员缺值是发布损坏，不能降级成源空值。 */
export function requireLongTextValue(
  kind: LongTextRef["kind"],
  value: unknown,
): LongTextResult {
  if (typeof value === "string" && value)
    return { kind: "present", text: value };
  throw new Error(`${kind}: 存在位为真但文本侧车缺失`);
}

const FACT_ROLE_FIELDS: Record<FactKind, string[]> = {
  RELATES_TO: ["source", "target"],
  WORKED_ON: ["person", "subject"],
  APPEARS_IN: ["character", "subject"],
  VOICE_CREDIT: ["person", "character", "subjectContext"],
  PERSON_REL: ["source", "target"],
  CHARACTER_REL: ["source", "target"],
};

/** 磁盘 incidence 元组 → 类型化 Fact(补回桶键)。 */
export function decodeIncidence(
  tag: string,
  key: number,
  tup: unknown[],
): Fact {
  const kind = FACT_TAGS[tag];
  if (!kind) throw new Error(`unknown fact tag ${tag}`);
  const [ref, mult, roleBits, others, ...attrs] = tup as [
    number,
    number,
    number,
    number[],
    ...unknown[],
  ];
  const roles = FACT_ROLE_FIELDS[kind];
  const queue = [...others];
  const parts: Record<string, number> = {};
  for (let i = 0; i < roles.length; i++) {
    if (roleBits & (1 << i)) parts[roles[i] ?? ""] = key;
    else {
      const other = queue.shift();
      if (other === undefined)
        throw new Error(`${kind}: incidence others exhausted`);
      parts[roles[i] ?? ""] = other;
    }
  }
  if (queue.length) throw new Error(`${kind}: incidence others overflow`);
  const base = { ref, multiplicity: mult };
  switch (kind) {
    case "RELATES_TO":
      return {
        ...base,
        kind,
        source: parts["source"] ?? 0,
        target: parts["target"] ?? 0,
        relationType: attrs[0] as number,
        sortOrder: attrs[1] as number,
      };
    case "WORKED_ON":
      return {
        ...base,
        kind,
        person: parts["person"] ?? 0,
        subject: parts["subject"] ?? 0,
        position: attrs[0] as number,
        appearEps: attrs[1] as string,
      };
    case "APPEARS_IN":
      return {
        ...base,
        kind,
        character: parts["character"] ?? 0,
        subject: parts["subject"] ?? 0,
        type: attrs[0] as number,
        sortOrder: attrs[1] as number,
      };
    case "VOICE_CREDIT":
      return {
        ...base,
        kind,
        person: parts["person"] ?? 0,
        character: parts["character"] ?? 0,
        subjectContext: parts["subjectContext"] ?? 0,
        type: attrs[0] as number,
        hasSummary: Boolean(attrs[1]),
      };
    case "PERSON_REL":
    case "CHARACTER_REL":
      return {
        ...base,
        kind,
        source: parts["source"] ?? 0,
        target: parts["target"] ?? 0,
        relationType: attrs[0] as number,
        spoiler: Boolean(attrs[1]),
        ended: Boolean(attrs[2]),
      };
  }
}

/** 目录行 [start, end, ...] 的二分定位(闭区间)。 */
function findRange<T extends number[]>(
  ranges: T[],
  id: number,
): T | null {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = ranges[mid];
    if (!row) return null;
    if (id < (row[0] ?? 0)) hi = mid - 1;
    else if (id > (row[1] ?? 0)) lo = mid + 1;
    else return row;
  }
  return null;
}

export class Data {
  private vocabPromise: Promise<{
    career: string[];
    metaTags: string[];
    tags: string[];
  }> | null = null;
  private mappingsPromise: Promise<Mappings> | null = null;

  constructor(
    private manifest: Manifest,
    private names: Names,
  ) {}

  /** rank-by-key 反向索引;未载入或不在当前发布时为 null。 */
  rankOf(key: number): number | null {
    return rankOfKey(key);
  }

  mappings(): Promise<Mappings> {
    this.mappingsPromise ??= loadPublishedJson<Mappings>(
      "mappings.json",
    ).catch((error: unknown) => {
      this.mappingsPromise = null;
      throw error;
    });
    return this.mappingsPromise;
  }

  private vocab(): Promise<{
    career: string[];
    metaTags: string[];
    tags: string[];
  }> {
    this.vocabPromise ??= (async () => {
      const idx = await loadGzJson<VocabIdx>("vocab.idx");
      const fetchAll = async (fam: string): Promise<string[]> => {
        const out: string[] = [];
        for (const [off, len] of idx.members[fam] ?? [])
          out.push(
            ...(await member<string[]>(
              "structure",
              "vocab.pack",
              off,
              len,
            )),
          );
        return out;
      };
      const [career, metaTags, tags] = await Promise.all([
        fetchAll("career"),
        fetchAll("meta_tags"),
        fetchAll("tags"),
      ]);
      return { career, metaTags, tags };
    })().catch((error: unknown) => {
      this.vocabPromise = null;
      throw error;
    });
    return this.vocabPromise;
  }

  /** 结构实体 = entities.pack 元组 + names.pack 名称行。 */
  async entity(key: number): Promise<StructuralEntity | null> {
    const kind = key >>> 24;
    const id = key & 0xffffff;
    const idx = await loadGzJson<EntitiesIdx>("entities.idx");
    const row = findRange(idx.k[String(kind)] ?? [], id);
    if (!row) return null;
    const m = await member<{ i: number[]; r: unknown[][] }>(
      "structure",
      "entities.pack",
      row[2],
      row[3],
    );
    const pos = m.i.indexOf(id);
    if (pos < 0) return null;
    const tup = m.r[pos];
    if (!tup) return null;
    const rank = this.rankOf(key);
    if (rank !== null) await this.names.load([rank]);
    const nameRow = rank !== null ? this.names.row(rank) : null;
    const name = nameRow?.[0] ?? "";
    const nameCn = nameRow?.[1] ?? "";
    const vocab = await this.vocab();
    if (kind === 1) {
      const [
        type, platformCode, date, score, bgmRank, nsfw,
        wish, done, doing, onHold, dropped, series,
        scoreDetails, metaTags, tags, hasSummary, hasInfobox,
      ] = tup as [
        number, number | null, string, number | null, number | null,
        number, number, number, number, number, number, number,
        number[], number[], [number, number][], number, number,
      ];
      return {
        kind: "subject",
        key,
        name,
        nameCn,
        type,
        platformCode,
        date,
        score,
        bgmRank,
        nsfw: Boolean(nsfw),
        favorite: [wish, done, doing, onHold, dropped],
        series: Boolean(series),
        scoreDetails,
        metaTags: metaTags.map((t) => vocab.metaTags[t] ?? ""),
        tags: tags.map(([t, c]) => [vocab.tags[t] ?? "", c]),
        hasSummary: Boolean(hasSummary),
        hasInfobox: Boolean(hasInfobox),
      };
    }
    if (kind === 2) {
      const [type, career, comments, collects, hasSummary, hasInfobox] =
        tup as [number, number[], number, number, number, number];
      return {
        kind: "person",
        key,
        name,
        nameCn,
        type,
        career: career.map((c) => vocab.career[c] ?? ""),
        comments,
        collects,
        hasSummary: Boolean(hasSummary),
        hasInfobox: Boolean(hasInfobox),
      };
    }
    if (kind === 3) {
      const [role, comments, collects, hasSummary, hasInfobox] = tup as [
        number, number, number, number, number,
      ];
      return {
        kind: "character",
        key,
        name,
        nameCn,
        role,
        comments,
        collects,
        hasSummary: Boolean(hasSummary),
        hasInfobox: Boolean(hasInfobox),
      };
    }
    return null;
  }

  private async factEntry(key: number): Promise<FactEntry | null> {
    const idx = await loadGzJson<FactsIdx>("facts.idx");
    const bucket = idx.b[key % idx.buckets] ?? [];
    const loc = bucket.find((m) => key <= (m[2] ?? -1));
    if (!loc) return null;
    const m = await member<Record<string, FactEntry>>(
      "structure",
      "facts.pack",
      loc[0],
      loc[1],
    );
    return m[String(key)] ?? null;
  }

  /** 完整类型化事实,分页读取。cursor 为溢出页号(条目内嵌偏移)。 */
  async factsFor(key: number, cursor?: string): Promise<Page<Fact>> {
    const entry = await this.factEntry(key);
    if (!entry) return { items: [], total: 0, next: null };
    const total = Object.values(entry.n).reduce((a, b) => a + b, 0);
    if (cursor === undefined) {
      const items: Fact[] = [];
      for (const [tag, tuples] of Object.entries(entry.g))
        for (const tup of tuples)
          items.push(decodeIncidence(tag, key, tup));
      return {
        items,
        total,
        next: entry.op?.length ? "0" : null,
      };
    }
    const pageIdx = Number(cursor);
    const loc = entry.op?.[pageIdx];
    if (!loc || !Number.isInteger(pageIdx))
      throw new RangeError(`factsFor: invalid cursor ${cursor}`);
    const page = await member<unknown[][]>(
      "structure",
      "pages.pack",
      loc[0],
      loc[1],
    );
    return {
      items: page.map((item) =>
        decodeIncidence(item[0] as string, key, item.slice(1)),
      ),
      total,
      next: (entry.op?.length ?? 0) > pageIdx + 1
        ? String(pageIdx + 1)
        : null,
    };
  }

  /** Episode 是 Subject 的分页从属集合;只接受 SubjectKey。 */
  async episodesFor(
    subject: number,
    cursor?: string,
  ): Promise<Page<EpisodeRecord>> {
    if (subject >>> 24 !== 1)
      throw new RangeError("episodesFor: subject key required");
    const sid = subject & 0xffffff;
    const idx = await loadGzJson<EpisodesIdx>("episodes.idx");
    const row = findRange(idx.ranges, sid);
    if (!row) return { items: [], total: 0, next: null };
    const m = await member<{ i: number[]; g: EpisodeEntry[] }>(
      "structure",
      "episodes.pack",
      row[2],
      row[3],
    );
    const pos = m.i.indexOf(sid);
    const entry = pos >= 0 ? m.g[pos] : undefined;
    if (!entry) return { items: [], total: 0, next: null };
    const decode = (r: unknown[]): EpisodeRecord => {
      const [id, name, nameCn, airdate, disc, duration, sort, type, hd] =
        r as [
          number, string, string, string, number, string,
          number | null, number, number,
        ];
      return {
        id,
        subject,
        name,
        nameCn,
        airdate,
        disc,
        duration,
        sort,
        type,
        hasDescription: Boolean(hd),
      };
    };
    if (cursor === undefined)
      return {
        items: entry.e.map(decode),
        total: entry.n,
        next: entry.op?.length ? "0" : null,
      };
    const pageIdx = Number(cursor);
    const loc = entry.op?.[pageIdx];
    if (!loc || !Number.isInteger(pageIdx))
      throw new RangeError(`episodesFor: invalid cursor ${cursor}`);
    const page = await member<unknown[][]>(
      "structure",
      "pages.pack",
      loc[0],
      loc[1],
    );
    return {
      items: page.map(decode),
      total: entry.n,
      next: (entry.op?.length ?? 0) > pageIdx + 1
        ? String(pageIdx + 1)
        : null,
    };
  }

  /** 长文本按需读取;`empty` 表示源值为空,错误一律抛出。 */
  async longText(ref: LongTextRef): Promise<LongTextResult> {
    if (!ref.present) return { kind: "empty" };
    const idx = await loadGzJson<{
      families: Record<string, TextFamily>;
    }>("text.idx");
    const fam = idx.families[ref.kind];
    if (!fam) throw new Error(`text family ${ref.kind} missing`);
    if (ref.kind === "entity-summary" || ref.kind === "entity-infobox") {
      const kind = ref.entity >>> 24;
      const id = ref.entity & 0xffffff;
      const ranges =
        (fam.ranges as Record<string, number[][]>)[String(kind)] ?? [];
      const row = findRange(ranges, id);
      if (!row) return requireLongTextValue(ref.kind, undefined);
      const m = await this.textMember(fam, row);
      const pos = m.i.indexOf(id);
      const text = pos >= 0 ? m.t[pos] : undefined;
      return requireLongTextValue(ref.kind, text);
    }
    if (ref.kind === "episode-description") {
      const sid = ref.subject & 0xffffff;
      const rows = (fam.ranges as number[][]).filter(
        (r) =>
          sid >= (r[0] ?? 0) &&
          sid <= (r[1] ?? 0) &&
          (r.length < 7 ||
            (ref.episode >= (r[5] ?? 0) && ref.episode <= (r[6] ?? 0))),
      );
      for (const row of rows) {
        const m = await this.textMember(fam, row);
        const pos = m.i.indexOf(sid);
        if (pos < 0) continue;
        const pairs = m.t[pos] as unknown as [number, string][];
        const hit = pairs.find(([epid]) => epid === ref.episode);
        if (hit?.[1]) return requireLongTextValue(ref.kind, hit[1]);
      }
      return requireLongTextValue(ref.kind, undefined);
    }
    const row = findRange(fam.ranges as number[][], ref.fact);
    if (!row) return requireLongTextValue(ref.kind, undefined);
    const m = await this.textMember(fam, row);
    const pos = m.i.indexOf(ref.fact);
    const text = pos >= 0 ? m.t[pos] : undefined;
    return requireLongTextValue(ref.kind, text);
  }

  private textMember(
    fam: TextFamily,
    row: number[],
  ): Promise<{ i: number[]; t: unknown[] }> {
    const file = fam.files[row[2] ?? 0];
    if (!file) throw new Error("text member file missing");
    return member<{ i: number[]; t: unknown[] }>(
      "text",
      file,
      row[3] ?? 0,
      row[4] ?? 0,
    );
  }

  /** 悬停稳定后的结构预取:实体与事实结构,不含 Episode 或文本。 */
  prefetchStructure(key: number): void {
    void Promise.all([this.entity(key), this.factsFor(key)]).catch(
      () => undefined,
    );
  }

}
