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
  Page,
  StructuralEntity,
  TagVocabularyField,
} from "./types";
import { FACT_TAGS } from "./types";
import { AsyncMemo } from "./async-memo";
import {
  anchorForFact,
  loadGzJson,
  loadPublishedJson,
  member,
  prefetchMemberRanges,
  prefetchPack,
  prefetchPackRange,
  rankOfKey,
  subjectForEpisode,
  type CacheFamily,
  type TextSearchMember,
} from "./loader";
import {
  canProjectSubjectQueryColumns,
  projectSubjectQueryEntities,
} from "./subject-query-projection";

type Loc4 = [number, number, number, number];
const ENTITY_CANDIDATE_READ_CONCURRENCY = 6;

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

type VocabularyValues = readonly string[] | ReadonlyMap<number, string>;

interface EntityVocab {
  career: VocabularyValues;
  metaTags: VocabularyValues;
  tags: VocabularyValues;
}

type VocabFamily = keyof EntityVocab;
type EntityVocabularyIds = Partial<Record<VocabFamily, number[]>>;

const EMPTY_VOCABULARY: readonly string[] = [];

const vocabularyValue = (values: VocabularyValues, id: number): string =>
  (values instanceof Map
    ? values.get(id)
    : (values as readonly string[])[id]) ?? "";

/** @internal Selects only vocabulary ids physically referenced by one tuple. */
export function entityVocabularyIds(
  kind: number,
  tuple: unknown[],
  requested?: ReadonlySet<string>,
): EntityVocabularyIds {
  const needs = (field: string): boolean => !requested || requested.has(field);
  if (kind === 1) {
    const ids: EntityVocabularyIds = {};
    if (needs("metaTags")) ids.metaTags = [...(tuple[15] as number[])];
    if (needs("tags"))
      ids.tags = (tuple[16] as [number, number][]).map(([id]) => id);
    return ids;
  }
  if (kind === 2 && needs("career"))
    return { career: [...(tuple[2] as number[])] };
  return {};
}

/** @internal Collects the exact vocabulary ids referenced by selected rows. */
export function entityVocabularyIdsForRows(
  kind: number,
  tuples: readonly unknown[][],
  requested?: ReadonlySet<string>,
): EntityVocabularyIds {
  const collected: Record<VocabFamily, Set<number>> = {
    career: new Set(),
    metaTags: new Set(),
    tags: new Set(),
  };
  for (const tuple of tuples) {
    const ids = entityVocabularyIds(kind, tuple, requested);
    for (const family of Object.keys(ids) as VocabFamily[])
      for (const id of ids[family] ?? []) collected[family].add(id);
  }
  const result: EntityVocabularyIds = {};
  for (const family of Object.keys(collected) as VocabFamily[]) {
    const ids = [...collected[family]];
    if (ids.length) result[family] = ids;
  }
  return result;
}

export interface VocabularyIndex {
  values: readonly string[];
  folded: readonly string[];
}

function foldVocabularyValue(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function buildVocabularyIndex(
  values: readonly string[],
): VocabularyIndex {
  return {
    values,
    folded: values.map(foldVocabularyValue),
  };
}

interface VocabularyCandidate {
  position: number;
  value: string;
  width: number;
}

function compareVocabularyCandidates(
  left: VocabularyCandidate,
  right: VocabularyCandidate,
): number {
  return left.width - right.width || left.position - right.position;
}

export function suggestVocabularyValues(
  index: VocabularyIndex,
  text: string,
): string[] {
  const query = foldVocabularyValue(text.trim());
  if (!query) return [];
  const exact: VocabularyCandidate[] = [];
  const prefix: VocabularyCandidate[] = [];
  const substring: VocabularyCandidate[] = [];
  for (let position = 0; position < index.values.length; position++) {
    const value = index.values[position];
    const folded = index.folded[position];
    if (value === undefined || folded === undefined) continue;
    const candidate = { position, value, width: folded.length };
    if (folded === query) {
      exact.push(candidate);
    } else if (folded.startsWith(query)) {
      prefix.push(candidate);
    } else if (folded.includes(query)) {
      substring.push(candidate);
    }
  }
  return [
    ...exact.sort(compareVocabularyCandidates),
    ...prefix.sort(compareVocabularyCandidates),
    ...substring.sort(compareVocabularyCandidates),
  ]
    .map((candidate) => candidate.value);
}

interface EpisodeEntry {
  e: unknown[][];
  n: number;
  op?: [number, number][];
}

export type TextSearchRow =
  | { owner: "subject" | "person" | "character"; id: number; field: "summary" | "infobox"; text: string }
  | { owner: "episode"; id: number; field: "name" | "nameCn"; text: string; entity?: EpisodeRecord }
  | { owner: "episode"; id: number; field: "description"; text: string }
  | { owner: "fact"; id: number; field: "summary"; text: string };

export type ProjectedEntityField =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[]
  | { name: string; count: number }[];

export interface ProjectedEntity {
  kind: "subject" | "person" | "character";
  key: number;
  fields: Record<string, ProjectedEntityField>;
}

function decodeEpisode(row: unknown[], subject: number): EpisodeRecord {
  const [id, name, nameCn, airdate, disc, duration, sort, type, hd] = row as [
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

/** @internal Derives the single compressed span emitted for one entity kind. */
export function contiguousPackSpan(
  ranges: readonly Loc4[],
): [offset: number, length: number] | null {
  const first = ranges[0];
  if (!first) return null;
  const start = first[2];
  let end = start;
  for (const row of ranges) {
    const offset = row[2];
    const length = row[3];
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(length) ||
      length <= 0
    ) throw new TypeError("pack member range is invalid");
    if (offset !== end) throw new TypeError("pack member ranges are not contiguous");
    end += length;
  }
  return [start, end - start];
}

/** @internal Scattered members stop winning once they cover at least half of
 * an owner's contiguous pack span; a whole scan then avoids a Range-request
 * fan-out and may use a narrower verified column projection. */
export function candidateRangesNeedWholeScan(
  ranges: readonly Loc4[],
  selected: readonly Loc4[],
): boolean {
  if (!selected.length) return false;
  const span = contiguousPackSpan(ranges);
  if (!span) return false;
  const selectedBytes = selected.reduce((sum, range) => sum + range[3], 0);
  return selectedBytes * 2 >= span[1];
}

export class Data {
  private readonly vocabFamilies = new AsyncMemo<VocabFamily, string[]>();
  private readonly tagVocabularyIndexes = new Map<
    TagVocabularyField,
    VocabularyIndex
  >();
  private mappingsPromise: Promise<Mappings> | null = null;

  constructor(private readonly manifest?: Manifest) {}

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

  private vocabulary(family: VocabFamily): Promise<string[]> {
    return this.vocabFamilies.get(family, async () => {
      const idx = await loadGzJson<VocabIdx>("vocab.idx");
      const diskFamily = family === "metaTags" ? "meta_tags" : family;
      const parts = await Promise.all(
        (idx.members[diskFamily] ?? []).map(([offset, length]) =>
          member<string[]>(
            "structure",
            "vocab.pack",
            offset,
            length,
          )
        ),
      );
      return parts.flat();
    });
  }

  /** Point reads decode only the compressed vocabulary chunks containing ids
   * that occur in the selected tuple. Member caching still lets a later broad
   * scan or autocomplete reuse those exact decoded chunks. */
  private async selectedVocabulary(
    family: VocabFamily,
    ids: readonly number[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<number, string>> {
    const idx = await loadGzJson<VocabIdx>("vocab.idx");
    signal?.throwIfAborted();
    const diskFamily = family === "metaTags" ? "meta_tags" : family;
    const ranges = idx.members[diskFamily] ?? [];
    const chunks = [...new Set(ids.flatMap((id) => {
      if (!Number.isSafeInteger(id) || id < 0) return [];
      const chunk = Math.floor(id / idx.chunk);
      return chunk < ranges.length ? [chunk] : [];
    }))];
    const parts = new Map(
      await Promise.all(chunks.map(async (chunk) => {
        const [offset, length] = ranges[chunk]!;
        return [
          chunk,
          await member<string[]>(
            "structure",
            "vocab.pack",
            offset,
            length,
            signal,
          ),
        ] as const;
      })),
    );
    const selected = new Map<number, string>();
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id < 0) continue;
      const chunk = Math.floor(id / idx.chunk);
      const value = parts.get(chunk)?.[id % idx.chunk];
      if (value !== undefined) selected.set(id, value);
    }
    return selected;
  }

  private async selectedEntityVocab(
    kind: number,
    tuple: unknown[],
    requested?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<EntityVocab> {
    const ids = entityVocabularyIds(kind, tuple, requested);
    const [career, metaTags, tags] = await Promise.all([
      ids.career
        ? this.selectedVocabulary("career", ids.career, signal)
        : Promise.resolve(EMPTY_VOCABULARY),
      ids.metaTags
        ? this.selectedVocabulary("metaTags", ids.metaTags, signal)
        : Promise.resolve(EMPTY_VOCABULARY),
      ids.tags
        ? this.selectedVocabulary("tags", ids.tags, signal)
        : Promise.resolve(EMPTY_VOCABULARY),
    ]);
    return { career, metaTags, tags };
  }

  private async selectedRowsVocab(
    kind: number,
    tuples: readonly unknown[][],
    requested?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<EntityVocab> {
    const ids = entityVocabularyIdsForRows(kind, tuples, requested);
    const [career, metaTags, tags] = await Promise.all([
      ids.career
        ? this.selectedVocabulary("career", ids.career, signal)
        : Promise.resolve(EMPTY_VOCABULARY),
      ids.metaTags
        ? this.selectedVocabulary("metaTags", ids.metaTags, signal)
        : Promise.resolve(EMPTY_VOCABULARY),
      ids.tags
        ? this.selectedVocabulary("tags", ids.tags, signal)
        : Promise.resolve(EMPTY_VOCABULARY),
    ]);
    return { career, metaTags, tags };
  }

  /** Broad scans eventually visit the whole owner domain, so they retain the
   * full-family path but skip families that owner/field cannot reference. */
  private async fullEntityVocab(
    kind: number,
    requested?: ReadonlySet<string>,
  ): Promise<EntityVocab> {
    const needs = (field: string): boolean => !requested || requested.has(field);
    const [career, metaTags, tags] = await Promise.all([
      kind === 2 && needs("career")
        ? this.vocabulary("career")
        : Promise.resolve(EMPTY_VOCABULARY),
      kind === 1 && needs("metaTags")
        ? this.vocabulary("metaTags")
        : Promise.resolve(EMPTY_VOCABULARY),
      kind === 1 && needs("tags")
        ? this.vocabulary("tags")
        : Promise.resolve(EMPTY_VOCABULARY),
    ]);
    return { career, metaTags, tags };
  }

  async suggestTagValues(
    field: TagVocabularyField,
    text: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[]> {
    options.signal?.throwIfAborted();
    const values = await this.vocabulary(field);
    options.signal?.throwIfAborted();
    let index = this.tagVocabularyIndexes.get(field);
    if (!index) {
      index = buildVocabularyIndex(values);
      this.tagVocabularyIndexes.set(field, index);
    }
    options.signal?.throwIfAborted();
    return suggestVocabularyValues(index, text);
  }

  private decodeEntity(
    kind: number,
    id: number,
    tuple: unknown[],
    vocab: EntityVocab,
  ): StructuralEntity {
    const key = (kind << 24) | id;
    if (kind === 1) {
      const [
        name, nameCn,
        type, platformCode, date, score, bgmRank, nsfw,
        wish, done, doing, onHold, dropped, series,
        scoreDetails, metaTags, tags, hasSummary, hasInfobox,
      ] = tuple as [
        string, string | null,
        number, number | null, string, number | null, number | null,
        number, number, number, number, number, number, number,
        number[], number[], [number, number][], number, number,
      ];
      return {
        kind: "subject",
        key,
        name,
        nameCn: nameCn ?? "",
        type,
        platformCode,
        date,
        score,
        bgmRank,
        nsfw: Boolean(nsfw),
        favorite: [wish, done, doing, onHold, dropped],
        series: Boolean(series),
        scoreDetails,
        metaTags: metaTags.map((tag) => vocabularyValue(vocab.metaTags, tag)),
        tags: tags.map(([tag, count]) => [vocabularyValue(vocab.tags, tag), count]),
        hasSummary: Boolean(hasSummary),
        hasInfobox: Boolean(hasInfobox),
      };
    }
    if (kind === 2) {
      const [name, type, career, comments, collects, hasSummary, hasInfobox] =
        tuple as [string, number, number[], number, number, number, number];
      return {
        kind: "person",
        key,
        name,
        type,
        career: career.map((item) => vocabularyValue(vocab.career, item)),
        comments,
        collects,
        hasSummary: Boolean(hasSummary),
        hasInfobox: Boolean(hasInfobox),
      };
    }
    if (kind === 3) {
      const [name, role, comments, collects, hasSummary, hasInfobox] = tuple as [
        string, number, number, number, number, number,
      ];
      return {
        kind: "character",
        key,
        name,
        role,
        comments,
        collects,
        hasSummary: Boolean(hasSummary),
        hasInfobox: Boolean(hasInfobox),
      };
    }
    throw new TypeError(`unknown structural entity kind ${kind}`);
  }

  private decodeProjectedEntity(
    kind: number,
    id: number,
    tuple: unknown[],
    requested: ReadonlySet<string>,
    vocab: EntityVocab | null,
  ): ProjectedEntity {
    const fields: Record<string, ProjectedEntityField> = {};
    if (kind === 1) {
      for (const field of requested) {
        switch (field) {
          case "name": fields.name = String(tuple[0] ?? ""); break;
          case "nameCn": fields.nameCn = String(tuple[1] ?? ""); break;
          case "type": fields.type = Number(tuple[2]); break;
          case "platformCode":
            fields.platformCode = tuple[3] === null ? null : Number(tuple[3]);
            break;
          case "date": fields.date = String(tuple[4] ?? ""); break;
          case "year": {
            const match = /^(\d{4})(?:-|$)/.exec(String(tuple[4] ?? ""));
            fields.year = match ? Number(match[1]) : null;
            break;
          }
          case "score":
            fields.score = tuple[5] === null || tuple[5] === 0
              ? null
              : Number(tuple[5]);
            break;
          case "rank":
            fields.rank = tuple[6] === null || tuple[6] === 0
              ? null
              : Number(tuple[6]);
            break;
          case "nsfw": fields.nsfw = Boolean(tuple[7]); break;
          case "wish": fields.wish = Number(tuple[8]); break;
          case "done": fields.done = Number(tuple[9]); break;
          case "doing": fields.doing = Number(tuple[10]); break;
          case "onHold": fields.onHold = Number(tuple[11]); break;
          case "dropped": fields.dropped = Number(tuple[12]); break;
          case "series": fields.series = Boolean(tuple[13]); break;
          case "scoreDetails": fields.scoreDetails = tuple[14] as number[]; break;
          case "metaTags":
            fields.metaTags = (tuple[15] as number[]).map(
              (tag) => vocab ? vocabularyValue(vocab.metaTags, tag) : "",
            );
            break;
          case "tags":
            fields.tags = (tuple[16] as [number, number][]).map(
              ([tag, count]) => ({
                name: vocab ? vocabularyValue(vocab.tags, tag) : "",
                count,
              }),
            );
            break;
          case "hasSummary": fields.hasSummary = Boolean(tuple[17]); break;
          case "summaryState": fields.summaryState = tuple[17] ? "HAS" : "EMPTY"; break;
          case "hasInfobox": fields.hasInfobox = Boolean(tuple[18]); break;
        }
      }
      return { kind: "subject", key: (kind << 24) | id, fields };
    }
    if (kind === 2) {
      for (const field of requested) {
        switch (field) {
          case "name": fields.name = String(tuple[0] ?? ""); break;
          case "type": fields.type = Number(tuple[1]); break;
          case "career":
            fields.career = (tuple[2] as number[]).map(
              (career) => vocab ? vocabularyValue(vocab.career, career) : "",
            );
            break;
          case "comments": fields.comments = Number(tuple[3]); break;
          case "collects": fields.collects = Number(tuple[4]); break;
          case "hasSummary": fields.hasSummary = Boolean(tuple[5]); break;
          case "summaryState": fields.summaryState = tuple[5] ? "HAS" : "EMPTY"; break;
          case "hasInfobox": fields.hasInfobox = Boolean(tuple[6]); break;
        }
      }
      return { kind: "person", key: (kind << 24) | id, fields };
    }
    if (kind === 3) {
      for (const field of requested) {
        switch (field) {
          case "name": fields.name = String(tuple[0] ?? ""); break;
          case "role": fields.role = Number(tuple[1]); break;
          case "comments": fields.comments = Number(tuple[2]); break;
          case "collects": fields.collects = Number(tuple[3]); break;
          case "hasSummary": fields.hasSummary = Boolean(tuple[4]); break;
          case "summaryState": fields.summaryState = tuple[4] ? "HAS" : "EMPTY"; break;
          case "hasInfobox": fields.hasInfobox = Boolean(tuple[5]); break;
        }
      }
      return { kind: "character", key: (kind << 24) | id, fields };
    }
    throw new TypeError(`unknown projected entity kind ${kind}`);
  }

  /** 结构实体成员自含名称；点查不依赖视觉 rank 或名称缓存。 */
  async entity(
    key: number,
    signal?: AbortSignal,
  ): Promise<StructuralEntity | null> {
    signal?.throwIfAborted();
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
      signal,
    );
    const pos = m.i.indexOf(id);
    if (pos < 0) return null;
    const tup = m.r[pos];
    if (!tup) return null;
    const vocab = await this.selectedEntityVocab(kind, tup, undefined, signal);
    return this.decodeEntity(kind, id, tup, vocab);
  }

  /** Query-only point projection avoids decoding fields a search result will not use. */
  async projectEntity(
    key: number,
    fieldNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<ProjectedEntity | null> {
    signal?.throwIfAborted();
    const kind = key >>> 24;
    const id = key & 0xffffff;
    const requested = new Set(fieldNames);
    const idx = await loadGzJson<EntitiesIdx>("entities.idx");
    const row = findRange(idx.k[String(kind)] ?? [], id);
    if (!row) return null;
    const block = await member<{ i: number[]; r: unknown[][] }>(
      "structure",
      "entities.pack",
      row[2],
      row[3],
      signal,
    );
    const pos = block.i.indexOf(id);
    if (pos < 0) return null;
    const tuple = block.r[pos];
    if (!tuple) return null;
    const vocab = await this.selectedEntityVocab(
      kind,
      tuple,
      requested,
      signal,
    );
    return this.decodeProjectedEntity(kind, id, tuple, requested, vocab);
  }

  /** Broad indexed lookups switch from scattered member reads to one owner span. */
  async prefetchEntities(
    owner: StructuralEntity["kind"],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const kind = owner === "subject" ? 1 : owner === "person" ? 2 : 3;
    const idx = await loadGzJson<EntitiesIdx>("entities.idx");
    const span = contiguousPackSpan(idx.k[String(kind)] ?? []);
    if (span) await prefetchPackRange("entities.pack", ...span, signal);
  }

  /** 按实体目录成员顺序批量扫描；整包只在扫描时预取，点查仍走 Range。 */
  async *entities(
    owner: StructuralEntity["kind"],
    signal?: AbortSignal,
    access: "stream" | "whole" = "whole",
  ): AsyncIterable<StructuralEntity> {
    const kind = owner === "subject" ? 1 : owner === "person" ? 2 : 3;
    const [idx, vocab] = await Promise.all([
      loadGzJson<EntitiesIdx>("entities.idx"),
      this.fullEntityVocab(kind),
    ]);
    const ranges = idx.k[String(kind)] ?? [];
    const span = access === "whole" ? contiguousPackSpan(ranges) : null;
    if (span) await prefetchPackRange("entities.pack", ...span, signal);
    for (const row of ranges) {
      signal?.throwIfAborted();
      const block = await member<{ i: number[]; r: unknown[][] }>(
        "structure",
        "entities.pack",
        row[2],
        row[3],
        signal,
      );
      if (block.i.length !== block.r.length)
        throw new Error("entities member ids and rows have different lengths");
      for (let index = 0; index < block.i.length; index++) {
        signal?.throwIfAborted();
        const id = block.i[index];
        const tuple = block.r[index];
        if (id === undefined || !tuple)
          throw new Error("entities member contains an incomplete row");
        yield this.decodeEntity(kind, id, tuple, vocab);
      }
    }
  }

  /** Query-only projection pushdown avoids materializing unused entity fields. */
  async *projectEntities(
    owner: ProjectedEntity["kind"],
    fieldNames: readonly string[],
    signal?: AbortSignal,
    access: "stream" | "whole" = "whole",
  ): AsyncIterable<ProjectedEntity> {
    const kind = owner === "subject" ? 1 : owner === "person" ? 2 : 3;
    const requested = new Set(fieldNames);
    if (
      this.manifest &&
      canProjectSubjectQueryColumns(
        this.manifest,
        owner,
        access,
        fieldNames,
      )
    ) {
      yield* projectSubjectQueryEntities(this.manifest, fieldNames, signal);
      return;
    }
    const [idx, vocab] = await Promise.all([
      loadGzJson<EntitiesIdx>("entities.idx"),
      this.fullEntityVocab(kind, requested),
    ]);
    const ranges = idx.k[String(kind)] ?? [];
    const span = access === "whole" ? contiguousPackSpan(ranges) : null;
    if (span) await prefetchPackRange("entities.pack", ...span, signal);
    for (const row of ranges) {
      signal?.throwIfAborted();
      const block = await member<{ i: number[]; r: unknown[][] }>(
        "structure",
        "entities.pack",
        row[2],
        row[3],
        signal,
      );
      if (block.i.length !== block.r.length)
        throw new Error("entities member ids and rows have different lengths");
      for (let index = 0; index < block.i.length; index++) {
        signal?.throwIfAborted();
        const id = block.i[index];
        const tuple = block.r[index];
        if (id === undefined || !tuple)
          throw new Error("entities member contains an incomplete row");
        yield this.decodeProjectedEntity(kind, id, tuple, requested, vocab);
      }
    }
  }

  /** Reads only requested structural entities while retaining full-scan order. */
  async *projectEntityCandidates(
    owner: ProjectedEntity["kind"],
    keys: readonly number[],
    fieldNames: readonly string[],
    signal?: AbortSignal,
  ): AsyncIterable<ProjectedEntity> {
    signal?.throwIfAborted();
    if (!keys.length) return;
    const kind = owner === "subject" ? 1 : owner === "person" ? 2 : 3;
    const requested = new Set(fieldNames);
    const idx = await loadGzJson<EntitiesIdx>("entities.idx");
    const ranges = idx.k[String(kind)] ?? [];
    const rangeCandidates = new Map<Loc4, Set<number>>();
    const requestedKeys = new Set<number>();
    for (const key of new Set(keys)) {
      if (!Number.isSafeInteger(key) || key >>> 24 !== kind)
        throw new TypeError("candidate EntityKey does not match its owner");
      requestedKeys.add(key);
      const id = key & 0xffffff;
      const range = findRange(ranges, id);
      if (!range) continue;
      const ids = rangeCandidates.get(range) ?? new Set<number>();
      ids.add(id);
      rangeCandidates.set(range, ids);
    }
    const selectedRanges = ranges.filter((range) => rangeCandidates.has(range));
    if (!selectedRanges.length) return;
    if (candidateRangesNeedWholeScan(ranges, selectedRanges)) {
      for await (const entity of this.projectEntities(
        owner,
        fieldNames,
        signal,
        "whole",
      )) if (requestedKeys.has(entity.key)) yield entity;
      return;
    }
    for (
      let start = 0;
      start < selectedRanges.length;
      start += ENTITY_CANDIDATE_READ_CONCURRENCY
    ) {
      signal?.throwIfAborted();
      const loaded = await Promise.all(
        selectedRanges
          .slice(start, start + ENTITY_CANDIDATE_READ_CONCURRENCY)
          .map(async (range) => ({
            range,
            block: await member<{ i: number[]; r: unknown[][] }>(
              "structure",
              "entities.pack",
              range[2],
              range[3],
              signal,
            ),
          })),
      );
      signal?.throwIfAborted();
      const selectedRows = loaded.flatMap(({ range, block }) => {
        const ids = rangeCandidates.get(range);
        if (!ids) throw new Error("candidate range lost its requested ids");
        return block.r.filter((_tuple, index) => {
          const id = block.i[index];
          return id !== undefined && ids.has(id);
        });
      });
      const vocab = await this.selectedRowsVocab(
        kind,
        selectedRows,
        requested,
        signal,
      );
      for (const { range, block } of loaded) {
        const ids = rangeCandidates.get(range);
        if (!ids) throw new Error("candidate range lost its requested ids");
        if (block.i.length !== block.r.length)
          throw new Error("entities member ids and rows have different lengths");
        for (let index = 0; index < block.i.length; index++) {
          const id = block.i[index];
          const tuple = block.r[index];
          if (id === undefined || !tuple)
            throw new Error("entities member contains an incomplete row");
          if (!ids.has(id)) continue;
          yield this.decodeProjectedEntity(kind, id, tuple, requested, vocab);
        }
      }
    }
  }

  private async factEntry(
    key: number,
    signal?: AbortSignal,
  ): Promise<FactEntry | null> {
    signal?.throwIfAborted();
    const idx = await loadGzJson<FactsIdx>("facts.idx");
    const bucket = idx.b[key % idx.buckets] ?? [];
    const loc = bucket.find((m) => key <= (m[2] ?? -1));
    if (!loc) return null;
    const m = await member<Record<string, FactEntry>>(
      "structure",
      "facts.pack",
      loc[0],
      loc[1],
      signal,
    );
    return m[String(key)] ?? null;
  }

  /** 完整类型化事实,分页读取。cursor 为溢出页号(条目内嵌偏移)。 */
  async factsFor(
    key: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Fact>> {
    const entry = await this.factEntry(key, signal);
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
      signal,
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

  /** Resolve a release-local FactRef through one canonical participant. */
  async fact(ref: number, signal?: AbortSignal): Promise<Fact | null> {
    const anchor = await anchorForFact(ref, signal);
    if (anchor === null) return null;
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await this.factsFor(anchor, cursor, signal);
      const fact = page.items.find((candidate) => candidate.ref === ref);
      if (fact) return fact;
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
    throw new Error(`fact-anchor.bin points to a participant without fact:${ref}`);
  }

  /** Episode 是 Subject 的分页从属集合;只接受 SubjectKey。 */
  async episodesFor(
    subject: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<EpisodeRecord>> {
    signal?.throwIfAborted();
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
      signal,
    );
    const pos = m.i.indexOf(sid);
    const entry = pos >= 0 ? m.g[pos] : undefined;
    if (!entry) return { items: [], total: 0, next: null };
    if (cursor === undefined)
      return {
        items: entry.e.map((row) => decodeEpisode(row, subject)),
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
      signal,
    );
    return {
      items: page.map((row) => decodeEpisode(row, subject)),
      total: entry.n,
      next: (entry.op?.length ?? 0) > pageIdx + 1
        ? String(pageIdx + 1)
        : null,
    };
  }

  /** 全局 Episode 扫描复用按 Subject 分区的权威成员，不复制字段数据。 */
  async *episodes(
    signal?: AbortSignal,
    access: "stream" | "whole" = "whole",
  ): AsyncIterable<EpisodeRecord> {
    const idx = await loadGzJson<EpisodesIdx>("episodes.idx");
    if (access === "whole")
      await Promise.all([
        prefetchPack("episodes.pack", signal),
        prefetchPack("pages.pack", signal),
      ]);
    for (const range of idx.ranges) {
      signal?.throwIfAborted();
      const block = await member<{ i: number[]; g: EpisodeEntry[] }>(
        "structure",
        "episodes.pack",
        range[2],
        range[3],
        signal,
      );
      if (block.i.length !== block.g.length)
        throw new Error("episodes member subjects and groups have different lengths");
      for (let index = 0; index < block.i.length; index++) {
        const subjectId = block.i[index];
        const entry = block.g[index];
        if (subjectId === undefined || !entry)
          throw new Error("episodes member contains an incomplete group");
        const subject = (1 << 24) | subjectId;
        for (const row of entry.e) yield decodeEpisode(row, subject);
        for (const loc of entry.op ?? []) {
          signal?.throwIfAborted();
          const page = await member<unknown[][]>(
            "structure",
            "pages.pack",
            loc[0],
            loc[1],
            signal,
          );
          for (const row of page) yield decodeEpisode(row, subject);
        }
      }
    }
  }

  async episode(id: number, signal?: AbortSignal): Promise<EpisodeRecord | null> {
    const subjectId = await subjectForEpisode(id, signal);
    if (subjectId === null) return null;
    const subject = (1 << 24) | subjectId;
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await this.episodesFor(subject, cursor, signal);
      const found = page.items.find((episode) => episode.id === id);
      if (found) return found;
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
    return null;
  }

  /** Query highlight ownership without hydrating the Episode record. */
  episodeSubjectId(id: number, signal?: AbortSignal): Promise<number | null> {
    return subjectForEpisode(id, signal);
  }

  private async textSearchMemberLocation(
    descriptor: TextSearchMember,
  ): Promise<{
    cacheFamily: CacheFamily;
    path: string;
    offset: number;
    length: number;
  }> {
    const [family, , fileIndex, offset, length] = descriptor;
    if (family === "episode-identity") {
      if (fileIndex !== 0)
        throw new Error("episode identity member has an invalid storage file");
      return {
        cacheFamily: "structure",
        path: "episodes.pack",
        offset,
        length,
      };
    }
    const index = await loadGzJson<{ families: Record<string, TextFamily> }>(
      "text.idx",
    );
    const definition = index.families[family];
    const path = definition?.files[fileIndex];
    if (!definition || !path)
      throw new Error(`${family}: text search member file is missing`);
    return { cacheFamily: "text", path, offset, length };
  }

  async prefetchTextSearchRows(
    descriptors: readonly TextSearchMember[],
    signal?: AbortSignal,
  ): Promise<() => void> {
    signal?.throwIfAborted();
    const locations = await Promise.all(descriptors.map((descriptor) =>
      this.textSearchMemberLocation(descriptor)
    ));
    const groups = new Map<
      string,
      {
        cacheFamily: CacheFamily;
        path: string;
        ranges: [offset: number, length: number][];
      }
    >();
    for (const { cacheFamily, path, offset, length } of locations) {
      const key = `${cacheFamily}:${path}`;
      const group = groups.get(key) ?? { cacheFamily, path, ranges: [] };
      group.ranges.push([offset, length]);
      groups.set(key, group);
    }
    const releases: (() => void)[] = [];
    try {
      for (const group of groups.values())
        releases.push(await prefetchMemberRanges(
          group.cacheFamily,
          group.path,
          group.ranges,
          signal,
        ));
    } catch (error) {
      for (const release of releases) release();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases) release();
    };
  }

  async textSearchRows(
    descriptor: TextSearchMember,
    signal?: AbortSignal,
  ): Promise<TextSearchRow[]> {
    const [family, entityKind, , offset, length] = descriptor;
    const location = await this.textSearchMemberLocation(descriptor);
    if (family === "episode-identity") {
      const block = await member<{ i: number[]; g: EpisodeEntry[] }>(
        location.cacheFamily,
        location.path,
        offset,
        length,
        signal,
      );
      if (block.i.length !== block.g.length)
        throw new Error("episode identity member groups are misaligned");
      const tuples: { row: unknown[]; subject: number }[] = [];
      for (let index = 0; index < block.g.length; index++) {
        const subjectId = block.i[index];
        const entry = block.g[index];
        if (subjectId === undefined || !entry)
          throw new Error("episode identity member contains an incomplete group");
        const subject = (1 << 24) | subjectId;
        tuples.push(...entry.e.map((row) => ({ row, subject })));
        for (const loc of entry.op ?? [])
          tuples.push(...(await member<unknown[][]>(
            "structure",
            "pages.pack",
            loc[0],
            loc[1],
            signal,
          )).map((row) => ({ row, subject })));
      }
      return tuples.flatMap(({ row, subject }) => {
        const entity = decodeEpisode(row, subject);
        const { id, name, nameCn } = entity;
        return [
          ...(name ? [{ owner: "episode" as const, id, field: "name" as const, text: name, entity }] : []),
          ...(nameCn ? [{ owner: "episode" as const, id, field: "nameCn" as const, text: nameCn, entity }] : []),
        ];
      });
    }
    const block = await member<{ i: number[]; t: unknown[] }>(
      location.cacheFamily,
      location.path,
      offset,
      length,
      signal,
    );
    if (block.i.length !== block.t.length)
      throw new Error(`${family}: text search member rows are misaligned`);
    if (family === "episode-description") {
      const rows: TextSearchRow[] = [];
      for (const pairs of block.t as [number, string][][])
        for (const [id, text] of pairs)
          rows.push({ owner: "episode", id, field: "description", text });
      return rows;
    }
    const field = family === "entity-infobox" ? "infobox" : "summary";
    if (family === "fact-summary")
      return block.i.map((id, index) => ({
        owner: "fact" as const,
        id,
        field: "summary" as const,
        text: String(block.t[index] ?? ""),
      }));
    const owner = (["", "subject", "person", "character"] as const)[entityKind];
    if (!owner) throw new Error(`${family}: invalid entity kind ${entityKind}`);
    return block.i.map((id, index) => ({
      owner,
      id,
      field,
      text: String(block.t[index] ?? ""),
    }));
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
