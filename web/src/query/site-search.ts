import type { EpisodeRecord, StructuralEntity } from "../types";
import type { ProjectedEntity, TextSearchRow } from "../data";
import { WeightedLru } from "../cache";
import {
  fold,
  foldedUtf8Range,
  loadCharmap,
  loadEntityKeys,
  openNames,
  openSearchAliases,
  searchSubstringPage,
  textSearchMemberPage,
  type SearchRankPage,
  type TextSearchMember,
  type TextSearchMemberPage,
} from "../loader";
import {
  findSubstringEntries,
  matchingAliasEntry,
  type SearchEntryPage,
} from "../search";
import type {
  EntityKind,
  Manifest,
  NameRow,
  SearchAliases,
  SearchEntry,
} from "../types";
import { QUERY_CONTRACT, type Owner, type QueryFactKind } from "./contract";
import type { FullTextField, LookupField } from "./document";
import type { SiteQueryReader, SiteQuerySearch } from "./site-source";

const OWNER_KIND: Record<Exclude<Owner, "episode">, EntityKind> = {
  subject: 1,
  person: 2,
  character: 3,
};

const TEXT_MEMBER_READ_CONCURRENCY = 6;
const SEARCH_ENTITY_READ_CONCURRENCY = 6;
const SEARCH_ALIAS_PREFETCH_CURSOR = 128;
// A few scattered variant rows are cheaper than the 35 MB alias pack. Once a
// lookup has verified this many variant candidates, repeated Range round trips
// dominate and one bounded whole-pack read wins (measured on the formal site).
const SEARCH_ALIAS_PREFETCH_VARIANTS = 768;
const SEARCH_NAME_PREFETCH_CURSOR = 128;
const SUBSTRING_QUERY_PAGE_SIZE = 64;
const SEARCH_PAGE_CACHE_BUDGET = 4_000_000;
const SEARCH_NAME_CACHE_BUDGET = 4_000_000;
const TEXT_MATCH_CACHE_BUDGET = 1_000_000;
const EPISODE_IDENTITY_CACHE_BUDGET = 512_000;
type EntityTextSearchRow = Exclude<TextSearchRow, { owner: "fact" }>;
interface EpisodeIdentityCandidate {
  id: number;
  field: "name" | "nameCn";
  text: string;
  utf8Range: [number, number];
  entity?: EpisodeRecord;
}

function searchPageWeight(page: SearchEntryPage): number {
  return page.entries.reduce(
    (weight, entry) =>
      weight +
      (entry[0].length + entry[1].length + entry[3].length) * 2 +
      24,
    24,
  );
}

function textRowsWeight(rows: readonly EntityTextSearchRow[]): number {
  return rows.reduce((weight, row) => weight + row.text.length * 2 + 64, 24);
}

function nameRowsWeight(rows: ReadonlyMap<number, NameRow>): number {
  let weight = 24;
  for (const [original, chinese] of rows.values())
    weight += (original.length + (chinese?.length ?? 0)) * 2 + 24;
  return weight;
}

function episodeIdentityCandidateWeight(
  candidate: EpisodeIdentityCandidate,
): number {
  const episode = candidate.entity;
  const episodeWeight = episode
    ? (
        episode.name.length +
        episode.nameCn.length +
        episode.airdate.length +
        episode.duration.length
      ) * 2 + 96
    : 0;
  return candidate.text.length * 2 + episodeWeight + 80;
}

async function* textRowBlocks(
  reader: SiteQueryReader,
  descriptors: readonly TextSearchMember[],
  signal: AbortSignal,
): AsyncIterable<TextSearchRow[]> {
  if (!reader.textSearchRows)
    throw new TypeError("published text search index is unavailable");
  for (
    let start = 0;
    start < descriptors.length;
    start += TEXT_MEMBER_READ_CONCURRENCY
  ) {
    signal.throwIfAborted();
    const blocks = await Promise.all(
      descriptors.slice(start, start + TEXT_MEMBER_READ_CONCURRENCY)
        .map((descriptor) => reader.textSearchRows!(descriptor, signal)),
    );
    signal.throwIfAborted();
    for (const rows of blocks) yield rows;
  }
}

function textDescriptorMatches(
  descriptor: TextSearchMember,
  owner: Owner,
  field: FullTextField,
): boolean {
  if (field === "description")
    return owner === "episode" && descriptor[0] === "episode-description";
  return owner !== "episode" &&
    descriptor[0] === "entity-summary" &&
    descriptor[1] === OWNER_KIND[owner];
}

async function* resolveEpisodeIdentityCandidates(
  candidates: readonly EpisodeIdentityCandidate[],
  readEpisode: SiteQueryReader["episode"],
  signal: AbortSignal,
): AsyncIterable<{
  entity: EpisodeRecord;
  field: "name" | "nameCn";
  text: string;
  utf8Range: [number, number];
}> {
  for (
    let start = 0;
    start < candidates.length;
    start += SEARCH_ENTITY_READ_CONCURRENCY
  ) {
    signal.throwIfAborted();
    const batch = candidates.slice(
      start,
      start + SEARCH_ENTITY_READ_CONCURRENCY,
    );
    const episodes = await Promise.all(
      batch.map(({ id, entity }) => {
        if (entity) return entity;
        if (readEpisode) return readEpisode(id, signal);
        throw new TypeError(`Episode identity ${id} is missing`);
      }),
    );
    signal.throwIfAborted();
    for (let index = 0; index < batch.length; index++) {
      const candidate = batch[index];
      const episode = episodes[index];
      if (!candidate) continue;
      if (!episode || episode.id !== candidate.id)
        throw new TypeError(`Episode identity ${candidate.id} is missing`);
      yield {
        entity: episode,
        field: candidate.field,
        text: candidate.text,
        utf8Range: candidate.utf8Range,
      };
    }
  }
}

export interface SiteSearchDependencies {
  normalize(text: string): Promise<string>;
  page(
    query: string,
    cursor: number,
    signal: AbortSignal,
    acceptRank?: (rank: number) => boolean,
    prefetchAliases?: boolean,
  ): Promise<SearchEntryPage>;
  keys(signal?: AbortSignal): Promise<Uint32Array>;
  rankPage?(
    query: string,
    cursor: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<SearchRankPage>;
  aliasRows?(
    ranks: Iterable<number>,
    signal: AbortSignal,
  ): Promise<Map<number, import("../types").SearchAliasRow>>;
  prefetchAliases?(signal: AbortSignal): Promise<void>;
  nameRows?(
    ranks: Iterable<number>,
    signal: AbortSignal,
  ): Promise<Map<number, NameRow>>;
  prefetchNames?(signal: AbortSignal): Promise<void>;
  textPage?(
    query: string,
    cursor: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<TextSearchMemberPage>;
}

function defaultDependencies(
  manifest: Manifest,
  aliases: SearchAliases,
): SiteSearchDependencies {
  const names = openNames(manifest);
  return {
    async normalize(text) {
      await loadCharmap();
      return fold(text);
    },
    page: (query, cursor, signal, acceptRank, prefetchAliases) =>
      findSubstringEntries(query, aliases, {
        acceptRank,
        cursor,
        prefetchAliases,
        signal,
      }),
    keys: loadEntityKeys,
    rankPage: (query, cursor, limit, signal) =>
      searchSubstringPage(query, cursor, limit, signal),
    aliasRows: (ranks, signal) => aliases.read(ranks, signal),
    prefetchAliases: (signal) => aliases.prefetch?.(signal) ?? Promise.resolve(),
    nameRows: (ranks, signal) => {
      if (!names.read)
        throw new TypeError("published identity names are unavailable");
      return names.read(ranks, signal);
    },
    prefetchNames: (signal) => names.prefetch?.(signal) ?? Promise.resolve(),
    textPage: textSearchMemberPage,
  };
}

export class SiteQuerySearchIndex implements SiteQuerySearch {
  private readonly dependencies: SiteSearchDependencies;
  private readonly structuralPages = new WeightedLru<string, SearchEntryPage>(
    SEARCH_PAGE_CACHE_BUDGET,
  );
  private readonly textMatches = new WeightedLru<
    string,
    readonly EntityTextSearchRow[]
  >(TEXT_MATCH_CACHE_BUDGET);
  private readonly episodeIdentityMatches = new WeightedLru<
    string,
    readonly EpisodeIdentityCandidate[]
  >(EPISODE_IDENTITY_CACHE_BUDGET);
  private readonly structuralPrefetchThreshold: Record<
    Exclude<Owner, "episode">,
    number
  >;

  constructor(
    private readonly reader: SiteQueryReader,
    manifest: Manifest,
    dependencies?: SiteSearchDependencies,
  ) {
    this.dependencies = dependencies ?? defaultDependencies(
      manifest,
      openSearchAliases(manifest),
    );
    const blockSize = manifest.limits?.entity_block_ids;
    const counts = manifest.counts?.entities;
    const threshold = (owner: Exclude<Owner, "episode">): number =>
      Number.isSafeInteger(blockSize) && (blockSize ?? 0) > 0 &&
          Number.isSafeInteger(counts?.[owner])
        ? Math.max(1, Math.ceil((counts?.[owner] ?? 0) / (blockSize as number)))
        : Number.POSITIVE_INFINITY;
    this.structuralPrefetchThreshold = {
      subject: threshold("subject"),
      person: threshold("person"),
      character: threshold("character"),
    };
  }

  private async normalized(
    text: string,
    kind: "lookup" | "fullText",
  ): Promise<string> {
    const query = await this.dependencies.normalize(text.trim());
    const minimum = QUERY_CONTRACT.search[kind].minNormalizedCharacters;
    if ([...query].length < minimum)
      throw new TypeError(
        `${kind} requires at least ${minimum} normalized characters`,
      );
    return query;
  }

  private async structuralPage(
    query: string,
    owner: Exclude<Owner, "episode">,
    cursor: number,
    signal: AbortSignal,
    acceptRank: (rank: number) => boolean,
  ): Promise<SearchEntryPage> {
    signal.throwIfAborted();
    const shared = cursor >= SEARCH_ALIAS_PREFETCH_CURSOR;
    const cacheKey = JSON.stringify([shared ? "*" : owner, query, cursor]);
    const cached = this.structuralPages.get(cacheKey);
    if (cached) return cached;
    const page = await this.dependencies.page(
      query,
      cursor,
      signal,
      shared ? undefined : acceptRank,
      shared,
    );
    signal.throwIfAborted();
    const weight = searchPageWeight(page);
    if (weight <= SEARCH_PAGE_CACHE_BUDGET)
      this.structuralPages.set(cacheKey, page, weight);
    return page;
  }

  private async verifiedTextRows(
    descriptor: TextSearchMember,
    query: string,
    owner: Owner,
    field: FullTextField,
    signal: AbortSignal,
  ): Promise<readonly EntityTextSearchRow[]> {
    signal.throwIfAborted();
    const cacheKey = JSON.stringify([descriptor, query, owner, field]);
    const cached = this.textMatches.get(cacheKey);
    if (cached) return cached;
    const rows = await this.reader.textSearchRows?.(descriptor, signal);
    if (!rows) throw new TypeError("published text search index is unavailable");
    signal.throwIfAborted();
    const matches = rows.filter((row): row is EntityTextSearchRow =>
      row.owner !== "fact" &&
      row.owner === owner &&
      row.field === field &&
      fold(row.text).includes(query)
    );
    const weight = textRowsWeight(matches);
    if (weight <= TEXT_MATCH_CACHE_BUDGET)
      this.textMatches.set(cacheKey, matches, weight);
    return matches;
  }

  private async structuralRankPage(
    query: string,
    cursor: number,
    signal: AbortSignal,
  ): Promise<SearchRankPage> {
    const cacheKey = JSON.stringify([query, cursor]);
    const cached = this.structuralRanks.get(cacheKey);
    if (cached) return cached;
    const page = await this.dependencies.rankPage!(
      query,
      cursor,
      SUBSTRING_QUERY_PAGE_SIZE,
      signal,
    );
    signal.throwIfAborted();
    const weight = page.ranks.length * 4 + 24;
    this.structuralRanks.set(cacheKey, page, weight);
    return page;
  }

  private readonly structuralRanks = new WeightedLru<string, SearchRankPage>(
    1_000_000,
  );

  private readonly structuralNames = new WeightedLru<
    string,
    Map<number, NameRow>
  >(SEARCH_NAME_CACHE_BUDGET);

  private async structuralNamePage(
    query: string,
    cursor: number,
    ranks: readonly number[],
    signal: AbortSignal,
  ): Promise<Map<number, NameRow>> {
    const cacheKey = JSON.stringify([query, cursor]);
    const cached = this.structuralNames.get(cacheKey);
    if (cached) return cached;
    const rows = await this.dependencies.nameRows!(ranks, signal);
    signal.throwIfAborted();
    if (rows.size !== ranks.length || ranks.some((rank) => !rows.has(rank)))
      throw new TypeError("lookup identity page omitted a candidate rank");
    const weight = nameRowsWeight(rows);
    if (weight <= SEARCH_NAME_CACHE_BUDGET)
      this.structuralNames.set(cacheKey, rows, weight);
    return rows;
  }

  private async *lookupRanks(
    query: string,
    owner: Exclude<Owner, "episode">,
    allowedFields: ReadonlySet<LookupField>,
    entityFields: readonly string[],
    signal: AbortSignal,
  ): AsyncIterable<{
    entity: StructuralEntity | ProjectedEntity;
    field: LookupField;
    text: string;
    utf8Range: [number, number];
  }> {
    const allowedKind = OWNER_KIND[owner];
    const identityOnly = Boolean(this.dependencies.nameRows) &&
      entityFields.every((field) =>
        field === "ref" ||
        field === "id" ||
        field === "name" ||
        field === "nameCn"
      );
    const projectedFields = [...new Set([
      ...entityFields,
      "name",
      ...(owner === "subject" ? ["nameCn"] : []),
    ])];
    const keys = await this.dependencies.keys(signal);
    const seen = new Set<string>();
    let cursor = 0;
    let priorRank = -1;
    let candidateReads = 0;
    let variantReads = 0;
    let prefetchedEntities = false;
    let prefetchedAliases = false;
    let prefetchedNames = false;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.structuralRankPage(query, cursor, signal);
      if (page.ranks.length > SUBSTRING_QUERY_PAGE_SIZE)
        throw new TypeError("lookup candidate page exceeded its limit");
      if (
        identityOnly &&
        !prefetchedNames &&
        this.dependencies.prefetchNames &&
        cursor >= SEARCH_NAME_PREFETCH_CURSOR
      ) {
        await this.dependencies.prefetchNames(signal);
        prefetchedNames = true;
      }
      const identityRows = identityOnly
        ? await this.structuralNamePage(
            query,
            cursor,
            page.ranks,
            signal,
          )
        : null;
      const candidates: { rank: number; key: number; identity: string }[] = [];
      for (const rank of page.ranks) {
        if (!Number.isSafeInteger(rank) || rank <= priorRank)
          throw new TypeError("lookup candidate ranks are not increasing");
        priorRank = rank;
        const key = keys[rank];
        if (key === undefined)
          throw new TypeError(`search rank ${rank} has no stable key`);
        if (key >>> 24 !== allowedKind) continue;
        const identity = `${owner}:${key & 0xffffff}`;
        if (!seen.has(identity)) candidates.push({ rank, key, identity });
      }
      candidateReads += candidates.length;
      if (
        !identityRows &&
        !prefetchedEntities &&
        this.reader.prefetchEntities &&
        candidateReads >= this.structuralPrefetchThreshold[owner]
      ) {
        await this.reader.prefetchEntities(owner, signal);
        prefetchedEntities = true;
      }
      let entities: (StructuralEntity | ProjectedEntity | null)[];
      if (identityRows) {
        entities = candidates.map(({ rank, key }) => {
          const row = identityRows.get(rank);
          if (!row || row[2] !== allowedKind)
            throw new TypeError(
              `search identity ${rank} does not match entity ${key}`,
            );
          return {
            kind: owner,
            key,
            fields: {
              name: row[0],
              ...(owner === "subject" ? { nameCn: row[1] ?? "" } : {}),
            },
          };
        });
      } else {
        entities = new Array(candidates.length).fill(null);
        for (
          let start = 0;
          start < candidates.length;
          start += SEARCH_ENTITY_READ_CONCURRENCY
        ) {
          signal.throwIfAborted();
          const batch = candidates.slice(
            start,
            start + SEARCH_ENTITY_READ_CONCURRENCY,
          );
          const loaded = await Promise.all(batch.map(({ key }) =>
            this.reader.projectEntity
              ? this.reader.projectEntity(key, projectedFields, signal)
              : this.reader.entity(key, signal)
          ));
          entities.splice(start, loaded.length, ...loaded);
        }
      }
      signal.throwIfAborted();
      const direct = entities.map((entity, index) => {
        const candidate = candidates[index];
        if (!candidate) return null;
        if (!entity || entity.key !== candidate.key)
          throw new TypeError(`search entity ${candidate.key} is missing`);
        const name = "fields" in entity ? entity.fields.name : entity.name;
        const nameCn = entity.kind === "subject"
          ? "fields" in entity ? entity.fields.nameCn : entity.nameCn
          : "";
        if (typeof name !== "string" || typeof nameCn !== "string")
          throw new TypeError(
            `search entity ${candidate.key} omitted its identity fields`,
          );
        const aliases: [string, string][] = [];
        if (allowedFields.has("nameCn") && nameCn)
          aliases.push([fold(nameCn), nameCn]);
        if (allowedFields.has("name") && name)
          aliases.push([fold(name), name]);
        const entry = matchingAliasEntry(
          query,
          [aliases, nameCn || name, allowedKind],
          candidate.rank,
        );
        if (!entry) return null;
        const field: LookupField = entry[1] === nameCn ? "nameCn" : "name";
        const utf8Range = foldedUtf8Range(entry[1], query);
        if (!utf8Range)
          throw new TypeError("direct lookup match has no source range");
        return { entity, field, text: entry[1], utf8Range };
      });
      const fallbackRanks = candidates.flatMap((candidate, index) =>
        direct[index] || !allowedFields.has("nameVariant")
          ? []
          : [candidate.rank]
      );
      variantReads += fallbackRanks.length;
      if (
        !prefetchedAliases &&
        this.dependencies.prefetchAliases &&
        variantReads >= SEARCH_ALIAS_PREFETCH_VARIANTS
      ) {
        await this.dependencies.prefetchAliases(signal);
        prefetchedAliases = true;
      }
      const aliasRows = fallbackRanks.length
        ? await this.dependencies.aliasRows!(fallbackRanks, signal)
        : new Map();
      signal.throwIfAborted();
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        const entity = entities[index];
        if (!candidate || !entity || seen.has(candidate.identity)) continue;
        const hit = direct[index];
        if (hit) {
          seen.add(candidate.identity);
          yield hit;
          continue;
        }
        const row = aliasRows.get(candidate.rank);
        if (!row) continue;
        const entry = matchingAliasEntry(query, row, candidate.rank);
        if (!entry) continue;
        const name = "fields" in entity ? entity.fields.name : entity.name;
        const nameCn = entity.kind === "subject"
          ? "fields" in entity ? entity.fields.nameCn : entity.nameCn
          : "";
        const field: LookupField = entry[1] === name
          ? "name"
          : nameCn && entry[1] === nameCn
            ? "nameCn"
            : "nameVariant";
        if (!allowedFields.has(field)) continue;
        const utf8Range = foldedUtf8Range(entry[1], query);
        if (!utf8Range)
          throw new TypeError("verified lookup candidate has no source range");
        seen.add(candidate.identity);
        yield { entity, field, text: entry[1], utf8Range };
      }
      if (page.next === null) return;
      if (page.next !== cursor + page.ranks.length || page.next <= cursor)
        throw new TypeError("lookup candidate cursor did not advance");
      cursor = page.next;
    }
  }

  async *lookup(
    text: string,
    owner: Owner,
    fields: readonly LookupField[] = ["name"],
    signal = new AbortController().signal,
    entityFields: readonly string[] = [],
  ): AsyncIterable<{
    entity: StructuralEntity | ProjectedEntity | EpisodeRecord;
    field: LookupField;
    text: string;
    utf8Range: [number, number];
  }> {
    const query = await this.normalized(text, "lookup");
    const allowedFields = new Set(fields);
    if (owner === "episode") {
      if (!this.dependencies.textPage || !this.reader.textSearchRows)
        throw new TypeError("published Episode identity index is unavailable");
      const readEpisode = this.reader.episode?.bind(this.reader);
      const identityFieldScope = [...allowedFields].sort();
      const seen = new Set<number>();
      let textCursor = 0;
      for (;;) {
        signal.throwIfAborted();
        const page = await this.dependencies.textPage(query, textCursor, 256, signal);
        const descriptors = page.members.filter(
          (descriptor) => descriptor[0] === "episode-identity",
        );
        for (
          let descriptorStart = 0;
          descriptorStart < descriptors.length;
          descriptorStart += TEXT_MEMBER_READ_CONCURRENCY
        ) {
          signal.throwIfAborted();
          const batch = descriptors.slice(
            descriptorStart,
            descriptorStart + TEXT_MEMBER_READ_CONCURRENCY,
          );
          const cacheKeys = batch.map((descriptor) => JSON.stringify([
            query,
            identityFieldScope,
            descriptor,
          ]));
          const cached = cacheKeys.map((key) =>
            this.episodeIdentityMatches.get(key)
          );
          const blocks = await Promise.all(batch.map((descriptor, index) =>
            cached[index]
              ? Promise.resolve(null)
              : this.reader.textSearchRows!(descriptor, signal)
          ));
          signal.throwIfAborted();
          for (let index = 0; index < batch.length; index++) {
            let candidates = cached[index];
            if (!candidates) {
              const rows = blocks[index];
              if (!rows)
                throw new TypeError("Episode identity member is unavailable");
              const verified: EpisodeIdentityCandidate[] = [];
              for (const row of rows) {
                if (
                  row.owner !== "episode" ||
                  (row.field !== "name" && row.field !== "nameCn") ||
                  !allowedFields.has(row.field) ||
                  seen.has(row.id)
                ) continue;
                const utf8Range = foldedUtf8Range(row.text, query);
                if (!utf8Range) continue;
                seen.add(row.id);
                verified.push({
                  id: row.id,
                  field: row.field,
                  text: row.text,
                  utf8Range,
                  entity: row.entity,
                });
              }
              const weight = verified.reduce(
                (total, candidate) =>
                  total + episodeIdentityCandidateWeight(candidate),
                24,
              );
              if (weight <= EPISODE_IDENTITY_CACHE_BUDGET)
                this.episodeIdentityMatches.set(
                  cacheKeys[index] as string,
                  verified,
                  weight,
                );
              candidates = verified;
            } else {
              candidates = candidates.filter(({ id }) => {
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
              });
            }
            yield* resolveEpisodeIdentityCandidates(
              candidates,
              readEpisode,
              signal,
            );
          }
        }
        if (page.next === null) return;
        if (page.next <= textCursor)
          throw new TypeError("Episode lookup candidate cursor did not advance");
        textCursor = page.next;
      }
    }
    if (this.dependencies.rankPage && this.dependencies.aliasRows) {
      yield* this.lookupRanks(
        query,
        owner,
        allowedFields,
        entityFields,
        signal,
      );
      return;
    }
    const allowedKind = OWNER_KIND[owner];
    const projectedFields = [...new Set([
      ...entityFields,
      "name",
      ...(owner === "subject" ? ["nameCn"] : []),
    ])];
    const seen = new Set<string>();
    const keys = await this.dependencies.keys(signal);
    const acceptRank = (rank: number): boolean => {
      const key = keys[rank];
      if (key === undefined)
        throw new TypeError(`search rank ${rank} has no stable key`);
      return key >>> 24 === allowedKind;
    };
    let cursor = 0;
    let candidateReads = 0;
    let prefetchedEntities = false;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.structuralPage(
        query,
        owner,
        cursor,
        signal,
        acceptRank,
      );
      const candidates: {
        entry: SearchEntry;
        identity: string;
        key: number;
      }[] = [];
      for (const entry of page.entries) {
        if (entry[4] !== allowedKind) continue;
        const rank = entry[2];
        const key = keys[rank];
        if (key === undefined || key >>> 24 !== entry[4])
          throw new TypeError(`search rank ${rank} has no matching stable key`);
        const identity = `${owner}:${key & 0xffffff}`;
        if (seen.has(identity)) continue;
        candidates.push({ entry, identity, key });
      }
      candidateReads += candidates.length;
      if (
        !prefetchedEntities &&
        this.reader.prefetchEntities &&
        candidateReads >= this.structuralPrefetchThreshold[owner]
      ) {
        await this.reader.prefetchEntities(owner, signal);
        prefetchedEntities = true;
      }
      for (
        let start = 0;
        start < candidates.length;
        start += SEARCH_ENTITY_READ_CONCURRENCY
      ) {
        signal.throwIfAborted();
        const batch = candidates.slice(
          start,
          start + SEARCH_ENTITY_READ_CONCURRENCY,
        );
        const entities = await Promise.all(
          batch.map(({ key }) => this.reader.projectEntity
            ? this.reader.projectEntity(key, projectedFields, signal)
            : this.reader.entity(key, signal)),
        );
        signal.throwIfAborted();
        for (let index = 0; index < batch.length; index++) {
          const candidate = batch[index];
          const entity = entities[index];
          if (!candidate) continue;
          const { entry, identity, key } = candidate;
          if (seen.has(identity)) continue;
          if (!entity || entity.key !== key)
            throw new TypeError(`search entity ${key} is missing`);
          const entityName = "fields" in entity
            ? entity.fields.name
            : entity.name;
          const entityNameCn = entity.kind === "subject"
            ? "fields" in entity
              ? entity.fields.nameCn
              : entity.nameCn
            : "";
          if (typeof entityName !== "string" || typeof entityNameCn !== "string")
            throw new TypeError(`search entity ${key} omitted its identity fields`);
          const field: LookupField = entry[1] === entityName
            ? "name"
            : entityNameCn && entry[1] === entityNameCn
              ? "nameCn"
              : "nameVariant";
          if (!allowedFields.has(field)) continue;
          const range = foldedUtf8Range(entry[1], query);
          if (!range)
            throw new TypeError("verified lookup candidate has no source range");
          seen.add(identity);
          yield { entity, field, text: entry[1], utf8Range: range };
        }
      }
      if (page.next === null) return;
      if (page.next <= cursor)
        throw new TypeError("lookup candidate cursor did not advance");
      cursor = page.next;
    }
  }

  async *fullText(
    text: string,
    owner: Owner,
    field: FullTextField,
    signal = new AbortController().signal,
    entityFields: readonly string[] = [],
  ): AsyncIterable<{
    entity: StructuralEntity | ProjectedEntity | EpisodeRecord;
    field: FullTextField;
    text: string;
    utf8Range: [number, number];
  }> {
    const query = await this.normalized(text, "fullText");
    if (!this.dependencies.textPage || !this.reader.textSearchRows)
      throw new TypeError("published text search index is unavailable");
    const seen = new Set<string>();
    let textCursor = 0;
    let candidateReads = 0;
    let prefetchedEntities = false;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.dependencies.textPage(query, textCursor, 256, signal);
      const descriptors = page.members.filter((descriptor) =>
        textDescriptorMatches(descriptor, owner, field)
      );
      for (
        let descriptorStart = 0;
        descriptorStart < descriptors.length;
        descriptorStart += TEXT_MEMBER_READ_CONCURRENCY
      ) {
        signal.throwIfAborted();
        const blocks = await Promise.all(
          descriptors
            .slice(
              descriptorStart,
              descriptorStart + TEXT_MEMBER_READ_CONCURRENCY,
            )
            .map((descriptor) =>
              this.verifiedTextRows(descriptor, query, owner, field, signal)
            ),
        );
        signal.throwIfAborted();
        for (const rows of blocks) {
          const candidates: { row: EntityTextSearchRow; identity: string }[] = [];
          for (const row of rows) {
            const identity = `${row.owner}:${row.id}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            candidates.push({ row, identity });
          }
          candidateReads += candidates.length;
          if (
            owner !== "episode" &&
            !prefetchedEntities &&
            this.reader.prefetchEntities &&
            candidateReads >= this.structuralPrefetchThreshold[owner]
          ) {
            await this.reader.prefetchEntities(owner, signal);
            prefetchedEntities = true;
          }
          for (
            let start = 0;
            start < candidates.length;
            start += SEARCH_ENTITY_READ_CONCURRENCY
          ) {
            signal.throwIfAborted();
            const batch = candidates.slice(
              start,
              start + SEARCH_ENTITY_READ_CONCURRENCY,
            );
            const entities = await Promise.all(batch.map(({ row }) =>
              row.owner === "episode"
                ? this.reader.episode?.(row.id, signal)
                : this.reader.projectEntity
                  ? this.reader.projectEntity(
                      (OWNER_KIND[row.owner] << 24) | row.id,
                      entityFields,
                      signal,
                    )
                  : this.reader.entity(
                      (OWNER_KIND[row.owner] << 24) | row.id,
                      signal,
                    )
            ));
            signal.throwIfAborted();
            for (let index = 0; index < batch.length; index++) {
              const candidate = batch[index];
              const entity = entities[index];
              if (!candidate) continue;
              if (!entity)
                throw new TypeError(
                  `text search entity ${candidate.identity} is missing`,
                );
              const range = foldedUtf8Range(candidate.row.text, query);
              if (!range)
                throw new TypeError("verified text candidate has no source range");
              yield { entity, field, text: candidate.row.text, utf8Range: range };
            }
          }
        }
      }
      if (page.next === null) return;
      if (page.next <= textCursor)
        throw new TypeError("text search cursor did not advance");
      textCursor = page.next;
    }
  }

  async *factFullText(
    text: string,
    factKind: QueryFactKind,
    field: "summary",
    signal = new AbortController().signal,
  ): AsyncIterable<{
    ref: `fact:${number}`;
    field: "summary";
    text: string;
    utf8Range: [number, number];
  }> {
    if (factKind !== "VOICE_CREDIT" || field !== "summary")
      throw new TypeError(`unsupported fact full text ${factKind}.${field}`);
    const query = await this.normalized(text, "fullText");
    if (!this.dependencies.textPage || !this.reader.textSearchRows)
      throw new TypeError("published text search index is unavailable");
    const seen = new Set<number>();
    let cursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.dependencies.textPage(query, cursor, 256, signal);
      const descriptors = page.members.filter((descriptor) =>
        descriptor[0] === "fact-summary"
      );
      for await (const rows of textRowBlocks(this.reader, descriptors, signal)) {
        for (const row of rows) {
          if (row.owner !== "fact" || row.field !== "summary" || seen.has(row.id))
            continue;
          const range = foldedUtf8Range(row.text, query);
          if (!range) continue;
          seen.add(row.id);
          yield {
            ref: `fact:${row.id}`,
            field: "summary",
            text: row.text,
            utf8Range: range,
          };
        }
      }
      if (page.next === null) return;
      if (page.next <= cursor)
        throw new TypeError("text search cursor did not advance");
      cursor = page.next;
    }
  }
}
