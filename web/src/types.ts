/** 浏览器数据契约;与烘焙侧 scripts/site_release.py 手写镜像,
 * 变更须同步(participants/attrs 顺序即磁盘元组顺序)。 */

export type Bounds3D = [
  [number, number, number],
  [number, number, number],
];

export interface TextLayout {
  width: number;
  gzip: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  members: number;
}

export interface PositionEncoding {
  encoding: "u16le-affine-3d-v1";
  components: 3;
  offset: [number, number, number];
  scale: [number, number, number];
}

export interface LayoutContract extends Record<string, unknown> {
  dimensions: 3;
  /** Final decoded center-distance floor used to calibrate local navigation. */
  minimum_node_center_distance: number;
}

export interface SubjectQueryColumnLayout {
  order: "source-id";
  count: number;
  date: {
    encoding: "u16le-dictionary-v1";
    codes: string;
    dictionary: string;
  };
  rank: {
    encoding: "u16le-zero-null-v1";
    values: string;
  };
}

export interface Manifest {
  /** 除自身外规范 manifest 内容的 SHA-256(内容身份)。 */
  version: string;
  schema: string;
  profile: string;
  source: { dump_version: string; dump_sha256: string };
  schema_digest: string;
  field_policy: Record<string, Record<string, string>>;
  mapping_digests: Record<string, string>;
  vocab_digests: Record<string, string>;
  owned_collections: Record<string, { parent: string; via: string }>;
  query?: {
    schema: "atlas-release-query-v1";
    capabilities: string[];
    contractDigest: string;
    subjectColumns?: SubjectQueryColumnLayout;
  };
  counts: {
    entities: { subject: number; person: number; character: number };
    facts: number;
    fact_source_rows: number;
    incidence: number;
    episodes: number;
    episode_orphan_groups: number;
    episode_orphan_rows: number;
    unresolved_voice_subject_context: number;
    text: Record<string, { non_empty: number; empty: number }>;
  };
  text_bytes: Record<string, { raw: number; compressed: number }>;
  text_layout: Record<string, TextLayout>;
  limits: {
    member_cap: number;
    member_raw_cap: number;
    /** 整文件加载的 text.idx 压缩上限。 */
    text_index_cap: number;
    pack_cap: number;
    fact_buckets: number;
    fact_inline: number;
    episode_inline: number;
    page_size: number;
    entity_block_ids: number;
    episode_block_subjects: number;
    search_leaf_cap: number;
    search_top: number;
    search_prefix_shards: number;
    search_fold: string;
    search_ngram_width: number;
    search_ngram_buckets: number;
    search_ngram_shards: number;
    search_ngram_member_ranks: number;
    search_alias_block_ranks: number;
    cache_budget: {
      total: number;
      names: number;
      structure: number;
      search: number;
      text: number;
    };
  };
  rank_index: {
    encoding: string;
    sentinel: number;
    segments: Record<string, { offset: number; count: number }>;
  };
  episode_index: {
    encoding: "u32le-subject-id";
    sentinel: number;
    count: number;
  };
  fact_index: {
    encoding: "u32le-anchor-entity-key";
    count: number;
  };
  n_nodes: number;
  n_edges_skeleton: number;
  /** names.pack 每个独立 gzip 成员包含的连续 rank 数。 */
  name_block_size: number;
  /** positions.bin 的逐轴仿射 uint16 解码参数。 */
  position_encoding: PositionEncoding;
  bbox: Bounds3D;
  year_range: [number, number];
  /** top-32 元标签名,下标 = tags.bin 位图的 bit 序。 */
  tags: string[];
  layout: LayoutContract;
  /** 逻辑文件名 -> [bytes, sha256, 不可变物理文件名]。 */
  files: Record<string, [number, string, string]>;
  core_bytes: number;
  total_bytes: number;
  n_files: number;
}

/** 几何 SoA(rank 有序)。 */
export interface Geometry {
  positions: Float32Array;
  key: Uint32Array;
  size: Uint8Array;
  /** bit0 nsfw、bit1 孤立外环、bit2-4 媒介,余位 0。 */
  flags: Uint8Array;
  loaded: number;
  sparse: Map<number, [number, number, number]>;
}

export type EntityKind = 1 | 2 | 3;

export const ENTITY_OWNER_BY_KIND = [
  "",
  "subject",
  "person",
  "character",
] as const;
export type StructuralOwner = Exclude<
  (typeof ENTITY_OWNER_BY_KIND)[number],
  ""
>;
export const ENTITY_KIND_BY_OWNER = {
  subject: 1,
  person: 2,
  character: 3,
} as const satisfies Record<StructuralOwner, EntityKind>;

export type TagVocabularyField = "metaTags" | "tags";

export type NameRow = [
  original: string,
  chinese: string | null,
  entityKind: EntityKind,
];

/** 按 rank 分块、按需填充的名字缓存。 */
export interface Names {
  /** 未加载时返回 null;中文名优先。 */
  get(rank: number): string | null;
  /** 原名与中文名的完整行(Data.entity 组合结构实体用)。 */
  row(rank: number): NameRow | null;
  /** 可选信号取消尚未完成的名称块读取。 */
  load(ranks: Iterable<number>, signal?: AbortSignal): Promise<void>;
  /** 返回一次读取中的稳定行快照，供查询 Worker 避免结构实体解码。 */
  read?(
    ranks: Iterable<number>,
    signal?: AbortSignal,
  ): Promise<Map<number, NameRow>>;
  /** Exhaustive identity lookups may switch from scattered blocks to one pack read. */
  prefetch?(signal?: AbortSignal): Promise<void>;
}

export type SearchAlias = [normalized: string, matched: string];
export type SearchAliasRow = [
  aliases: SearchAlias[],
  display: string,
  entityKind: EntityKind,
];

/** 子串候选最终校验所用的派生搜索别名，不污染实体名称权威。 */
export interface SearchAliases {
  row(rank: number): SearchAliasRow | null;
  load(ranks: Iterable<number>, signal?: AbortSignal): Promise<void>;
  /** Exhaustive query scans may switch from scattered blocks to one pack read. */
  prefetch?(signal?: AbortSignal): Promise<void>;
  /** 返回一次读取中的稳定行快照，避免分块在校验前被 LRU 淘汰。 */
  read(
    ranks: Iterable<number>,
    signal?: AbortSignal,
  ): Promise<Map<number, SearchAliasRow>>;
}

// ---- 结构语义契约(设计 §7)----

export type FactKind =
  | "RELATES_TO"
  | "WORKED_ON"
  | "APPEARS_IN"
  | "VOICE_CREDIT"
  | "PERSON_REL"
  | "CHARACTER_REL";

export const FACT_TAGS: Record<string, FactKind> = {
  R: "RELATES_TO",
  W: "WORKED_ON",
  A: "APPEARS_IN",
  V: "VOICE_CREDIT",
  P: "PERSON_REL",
  C: "CHARACTER_REL",
};

interface FactBase {
  ref: number;
  multiplicity: number;
}

/** 完整类型化事实:方向由角色字段表达,不编码为展示字符串。 */
export type Fact =
  | (FactBase & {
      kind: "RELATES_TO";
      source: number;
      target: number;
      relationType: number;
      sortOrder: number;
    })
  | (FactBase & {
      kind: "WORKED_ON";
      person: number;
      subject: number;
      position: number;
      appearEps: string;
    })
  | (FactBase & {
      kind: "APPEARS_IN";
      character: number;
      subject: number;
      type: number;
      sortOrder: number;
    })
  | (FactBase & {
      kind: "VOICE_CREDIT";
      person: number;
      character: number;
      subjectContext: number;
      type: number;
      hasSummary: boolean;
    })
  | (FactBase & {
      kind: "PERSON_REL";
      source: number;
      target: number;
      relationType: number;
      spoiler: boolean;
      ended: boolean;
    })
  | (FactBase & {
      kind: "CHARACTER_REL";
      source: number;
      target: number;
      relationType: number;
      spoiler: boolean;
      ended: boolean;
    });

export interface SubjectEntity {
  kind: "subject";
  key: number;
  name: string;
  nameCn: string;
  type: number;
  platformCode: number | null;
  date: string;
  score: number | null;
  /** 源字段 Subject.rank;与 VisualRank 不能混用。 */
  bgmRank: number | null;
  nsfw: boolean;
  favorite: [number, number, number, number, number];
  series: boolean;
  scoreDetails: number[];
  metaTags: string[];
  tags: [string, number][];
  hasSummary: boolean;
  hasInfobox: boolean;
}

export interface PersonEntity {
  kind: "person";
  key: number;
  name: string;
  type: number;
  career: string[];
  comments: number;
  collects: number;
  hasSummary: boolean;
  hasInfobox: boolean;
}

export interface CharacterEntity {
  kind: "character";
  key: number;
  name: string;
  role: number;
  comments: number;
  collects: number;
  hasSummary: boolean;
  hasInfobox: boolean;
}

export type StructuralEntity =
  | SubjectEntity
  | PersonEntity
  | CharacterEntity;

export interface EpisodeRecord {
  id: number;
  subject: number;
  name: string;
  nameCn: string;
  airdate: string;
  disc: number;
  duration: string;
  sort: number | null;
  type: number;
  hasDescription: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  next: string | null;
}

export type LongTextRef =
  | { kind: "entity-summary"; entity: number; present: boolean }
  | { kind: "entity-infobox"; entity: number; present: boolean }
  | {
      kind: "episode-description";
      subject: number;
      episode: number;
      present: boolean;
    }
  | { kind: "fact-summary"; fact: number; present: boolean };

export type LongTextResult =
  | { kind: "present"; text: string }
  | { kind: "empty" };

/** 原始枚举码 -> 显示文本(mappings.json;未知码按数值显示)。 */
export interface Mappings {
  fact_labels: Record<string, Record<string, string>>;
  subject_type: Record<string, string>;
  platform: Record<string, string>;
  person_type: Record<string, string>;
  character_role: Record<string, string>;
  episode_type: Record<string, string>;
}

/** 搜索投影内嵌主名称和种类，避免常规前缀联想扇出读取名字块。 */
export type SearchEntry = [
  norm: string,
  matched: string,
  rank: number,
  display: string,
  entityKind: EntityKind,
];

export type SearchNode =
  | { l: [number, number] }
  | { t: [number, number] };

export const TYPE_NAMES = ["", "作品", "人物", "角色"] as const;
// 三类数据色经画布底色的 CVD 与对比度校验，不随主题色漂移。
export const TYPE_COLORS: [number, number, number][] = [
  [0, 0, 0],
  [61, 142, 222], // 作品
  [229, 106, 64], // 人物
  [39, 171, 124], // 角色
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
  const kind = ENTITY_OWNER_BY_KIND[etype(key)];
  return `https://bgm.tv/${kind}/${eid(key)}`;
};
