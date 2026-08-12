import type {
  EpisodeRecord,
  Fact,
  Mappings,
  Page,
  StructuralEntity,
} from "../types";
import type { ProjectedEntity, TextSearchRow } from "../data";
import type { TextSearchMember } from "../loader";
import type { Owner, QueryFactKind } from "./contract";
import { parseEntityRef, parseFactRef } from "./contract";
import type {
  EntityValue,
  FactValue,
  QueryDataSource,
  ScanAccess,
} from "./engine";
import type { FullTextField, LookupField } from "./document";

type StructuralOwner = Exclude<Owner, "episode">;

export interface SiteQueryReader {
  entities(
    owner: StructuralOwner,
    signal?: AbortSignal,
    access?: ScanAccess,
  ): AsyncIterable<StructuralEntity>;
  projectEntities?(
    owner: StructuralOwner,
    fields: readonly string[],
    signal?: AbortSignal,
    access?: ScanAccess,
  ): AsyncIterable<ProjectedEntity>;
  /** Candidate projection preserves projectEntities(owner) relative order. */
  projectEntityCandidates?(
    owner: StructuralOwner,
    keys: readonly number[],
    fields: readonly string[],
    signal?: AbortSignal,
  ): AsyncIterable<ProjectedEntity>;
  projectEntity?(
    key: number,
    fields: readonly string[],
    signal?: AbortSignal,
  ): Promise<ProjectedEntity | null>;
  prefetchEntities?(owner: StructuralOwner, signal?: AbortSignal): Promise<void>;
  entity(key: number, signal?: AbortSignal): Promise<StructuralEntity | null>;
  episodes?(signal?: AbortSignal, access?: ScanAccess): AsyncIterable<EpisodeRecord>;
  episodesFor?(
    subject: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<EpisodeRecord>>;
  episode?(id: number, signal?: AbortSignal): Promise<EpisodeRecord | null>;
  episodeSubjectId?(
    id: number,
    signal?: AbortSignal,
  ): Promise<number | null>;
  textSearchRows?(
    descriptor: TextSearchMember,
    signal?: AbortSignal,
  ): Promise<TextSearchRow[]>;
  factsFor(
    key: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Fact>>;
  fact?(ref: number, signal?: AbortSignal): Promise<Fact | null>;
  mappings?(): Promise<Mappings>;
}

export interface SiteQuerySearch {
  lookup(
    text: string,
    owner: Owner,
    fields: readonly LookupField[],
    signal?: AbortSignal,
    entityFields?: readonly string[],
  ): AsyncIterable<{
    entity: StructuralEntity | ProjectedEntity | EpisodeRecord;
    field: LookupField;
    text: string;
    utf8Range: [number, number];
  }>;
  fullText(
    text: string,
    owner: Owner,
    field: FullTextField,
    signal?: AbortSignal,
    entityFields?: readonly string[],
  ): AsyncIterable<{
    entity: StructuralEntity | ProjectedEntity | EpisodeRecord;
    field: FullTextField;
    text: string;
    utf8Range: [number, number];
  }>;
  factFullText(
    text: string,
    factKind: QueryFactKind,
    field: "summary",
    signal?: AbortSignal,
  ): AsyncIterable<{
    ref: `fact:${number}`;
    field: "summary";
    text: string;
    utf8Range: [number, number];
  }>;
}

const KIND: Record<StructuralOwner, number> = {
  subject: 1,
  person: 2,
  character: 3,
};

function keyFromRef(ref: `${Owner}:${number}`): number {
  const { owner, archiveId } = parseEntityRef(ref);
  if (owner === "episode")
    throw new TypeError("Episode does not use a structural EntityKey");
  if (archiveId > 0xffffff)
    throw new TypeError(`${ref} exceeds the current EntityKey width`);
  return (KIND[owner] << 24) | archiveId;
}

function refFromKey(key: number): `${StructuralOwner}:${number}` {
  const owner = (["", "subject", "person", "character"] as const)[key >>> 24];
  if (!owner) throw new TypeError(`invalid SiteRelease EntityKey ${key}`);
  return `${owner}:${key & 0xffffff}`;
}

function subjectYear(date: string): number | null {
  const match = /^(\d{4})(?:-|$)/.exec(date);
  return match ? Number(match[1]) : null;
}

function platformName(
  type: number,
  code: number | null,
  mappings: Mappings | null,
): string | null {
  if (code === null) return null;
  const mapped = mappings?.platform[`${type}:${code}`];
  if (mapped) return mapped;
  return code === 0 ? null : `未知平台（${code}）`;
}

function personType(value: unknown): number | null {
  if (value === 0) return null;
  if (value === 1 || value === 2 || value === 3) return value;
  throw new TypeError(`unsupported Person type ${String(value)}`);
}

function subjectMetric(
  value: unknown,
  field: "score" | "rank",
): number | null {
  // The archive uses zero for an unavailable score or rank, while the query
  // contract exposes absence as null.
  if (value === 0 || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`Subject ${field} query value is invalid`);
  return value;
}

function entityValue(
  entity: StructuralEntity,
  mappings: Mappings | null = null,
): EntityValue {
  const ref = refFromKey(entity.key);
  if (entity.kind === "subject") {
    const [wish, done, doing, onHold, dropped] = entity.favorite;
    return {
      kind: "entity",
      owner: "subject",
      ref,
      fields: {
        name: entity.name,
        nameCn: entity.nameCn,
        type: entity.type,
        platform: platformName(entity.type, entity.platformCode, mappings),
        date: entity.date,
        year: subjectYear(entity.date),
        score: subjectMetric(entity.score, "score"),
        ratingCount: entity.scoreDetails.reduce((sum, count) => sum + count, 0),
        rank: subjectMetric(entity.bgmRank, "rank"),
        nsfw: entity.nsfw,
        wish,
        done,
        doing,
        onHold,
        dropped,
        totalCollections: wish + done + doing + onHold + dropped,
        series: entity.series,
        scoreDetails: entity.scoreDetails,
        metaTags: entity.metaTags,
        tags: entity.tags.map(([name, count]) => ({ name, count })),
        hasSummary: entity.hasSummary,
        summaryState: entity.hasSummary ? "HAS" : "EMPTY",
        hasInfobox: entity.hasInfobox,
      },
    };
  }
  if (entity.kind === "person")
    return {
      kind: "entity",
      owner: "person",
      ref,
      fields: {
        name: entity.name,
        type: personType(entity.type),
        career: entity.career,
        comments: entity.comments,
        collects: entity.collects,
        hasSummary: entity.hasSummary,
        summaryState: entity.hasSummary ? "HAS" : "EMPTY",
        hasInfobox: entity.hasInfobox,
      },
    };
  return {
    kind: "entity",
    owner: "character",
    ref,
    fields: {
      name: entity.name,
      role: entity.role,
      comments: entity.comments,
      collects: entity.collects,
      hasSummary: entity.hasSummary,
      summaryState: entity.hasSummary ? "HAS" : "EMPTY",
      hasInfobox: entity.hasInfobox,
    },
  };
}

function projectedEntityValue(
  entity: ProjectedEntity,
  requested: ReadonlySet<string>,
  mappings: Mappings | null,
): EntityValue {
  const fields = { ...entity.fields };
  if (entity.kind === "subject" && requested.has("ratingCount")) {
    const scoreDetails = fields.scoreDetails;
    if (!Array.isArray(scoreDetails) || scoreDetails.some((value) =>
      typeof value !== "number" || !Number.isFinite(value)
    )) throw new TypeError("projected Subject scoreDetails is invalid");
    fields.ratingCount = (scoreDetails as number[])
      .reduce((sum, count) => sum + count, 0);
    if (!requested.has("scoreDetails")) delete fields.scoreDetails;
  }
  if (entity.kind === "subject" && requested.has("totalCollections")) {
    const favoriteFields = ["wish", "done", "doing", "onHold", "dropped"];
    const favorite = favoriteFields.map((field) => fields[field]);
    if (favorite.some((value) =>
      typeof value !== "number" || !Number.isFinite(value)
    )) throw new TypeError("projected Subject favorite counters are invalid");
    fields.totalCollections = (favorite as number[])
      .reduce((sum, count) => sum + count, 0);
    for (const field of favoriteFields)
      if (!requested.has(field)) delete fields[field];
  }
  if (entity.kind === "subject" && requested.has("platform")) {
    const type = fields.type;
    const code = fields.platformCode;
    if (typeof type !== "number" || (typeof code !== "number" && code !== null))
      throw new TypeError("projected Subject platform context is invalid");
    fields.platform = platformName(type, code, mappings);
    delete fields.platformCode;
    if (!requested.has("type")) delete fields.type;
  }
  if (entity.kind === "person" && requested.has("type"))
    fields.type = personType(fields.type);
  for (const field of requested) {
    if (field === "ref" || field === "id") continue;
    if (!Object.hasOwn(fields, field))
      throw new TypeError(
        `SiteRelease projection omitted ${entity.kind}.${field}`,
      );
  }
  if (entity.kind === "subject") {
    if (requested.has("score"))
      fields.score = subjectMetric(fields.score, "score");
    if (requested.has("rank"))
      fields.rank = subjectMetric(fields.rank, "rank");
  }
  for (const field of Object.keys(fields))
    if (!requested.has(field)) delete fields[field];
  return {
    kind: "entity",
    owner: entity.kind,
    ref: refFromKey(entity.key),
    fields,
  };
}

function physicalProjectionFields(
  owner: StructuralOwner,
  fields: readonly string[],
): readonly string[] {
  if (owner !== "subject") return fields;
  return [...new Set(fields.flatMap((field) => {
    if (field === "platform") return ["type", "platformCode"];
    if (field === "ratingCount") return ["scoreDetails"];
    if (field === "totalCollections")
      return ["wish", "done", "doing", "onHold", "dropped"];
    return [field];
  }))];
}

function episodeValue(episode: EpisodeRecord): EntityValue {
  return {
    kind: "entity",
    owner: "episode",
    ref: `episode:${episode.id}`,
    fields: {
      name: episode.name,
      nameCn: episode.nameCn,
      subjectRef: refFromKey(episode.subject),
      airdate: episode.airdate,
      year: subjectYear(episode.airdate),
      disc: episode.disc,
      duration: episode.duration,
      sort: episode.sort,
      type: episode.type,
      hasDescription: episode.hasDescription,
      descriptionState: episode.hasDescription ? "HAS" : "EMPTY",
    },
  };
}

/** Keep verified source text inside the worker; result rows carry only a
 * UTF-8-safe context window around the hit. */
function searchSnippet(
  text: string,
  [matchStart, matchEnd]: [number, number],
  contextBytes = 96,
): string {
  const bytes = new TextEncoder().encode(text);
  let start = Math.max(0, matchStart - contextBytes);
  let end = Math.min(bytes.length, matchEnd + contextBytes);
  while (start < matchStart && (bytes[start]! & 0xc0) === 0x80) start++;
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
  const excerpt = new TextDecoder().decode(bytes.subarray(start, end));
  return `${start > 0 ? "…" : ""}${excerpt}${end < bytes.length ? "…" : ""}`;
}

function factValue(fact: Fact): FactValue {
  const base = {
    kind: "fact" as const,
    factKind: fact.kind,
    ref: `fact:${fact.ref}` as const,
    multiplicity: fact.multiplicity,
  };
  switch (fact.kind) {
    case "RELATES_TO":
      return {
        ...base,
        roles: { source: refFromKey(fact.source), target: refFromKey(fact.target) },
        fields: { relationType: fact.relationType, sortOrder: fact.sortOrder },
      };
    case "WORKED_ON":
      return {
        ...base,
        roles: { person: refFromKey(fact.person), subject: refFromKey(fact.subject) },
        fields: { position: fact.position, appearEps: fact.appearEps },
      };
    case "APPEARS_IN":
      return {
        ...base,
        roles: { character: refFromKey(fact.character), subject: refFromKey(fact.subject) },
        fields: { type: fact.type, sortOrder: fact.sortOrder },
      };
    case "VOICE_CREDIT":
      return {
        ...base,
        roles: {
          person: refFromKey(fact.person),
          character: refFromKey(fact.character),
          subjectContext: refFromKey(fact.subjectContext),
        },
        fields: {
          type: fact.type,
          hasSummary: fact.hasSummary,
          summaryState: fact.hasSummary ? "HAS" : "EMPTY",
        },
      };
    case "PERSON_REL":
    case "CHARACTER_REL":
      return {
        ...base,
        roles: { source: refFromKey(fact.source), target: refFromKey(fact.target) },
        fields: {
          relationType: fact.relationType,
          spoiler: fact.spoiler,
          ended: fact.ended,
        },
      };
  }
}

export class SiteQueryDataSource implements QueryDataSource {
  private mappingsPromise: Promise<Mappings | null> | null = null;
  readonly resolveEpisodeGraphRef?: NonNullable<
    QueryDataSource["resolveEpisodeGraphRef"]
  >;

  constructor(
    private reader: SiteQueryReader,
    private searchIndex?: SiteQuerySearch,
    readonly releaseId?: string,
  ) {
    if (reader.episodeSubjectId)
      this.resolveEpisodeGraphRef = async (ref, signal) => {
        const parsed = parseEntityRef(ref);
        if (parsed.owner !== "episode")
          throw new TypeError("Episode graph resolver received another owner");
        const subjectId = await reader.episodeSubjectId!(
          parsed.archiveId,
          signal,
        );
        if (subjectId === null) return null;
        if (
          !Number.isSafeInteger(subjectId) ||
          subjectId < 0 ||
          subjectId > 0xffffff
        ) throw new TypeError("Episode graph resolver returned an invalid Subject id");
        return `subject:${subjectId}`;
      };
  }

  private mappings(): Promise<Mappings | null> {
    this.mappingsPromise ??= this.reader.mappings?.() ?? Promise.resolve(null);
    return this.mappingsPromise;
  }

  async *scan(
    owner: Owner,
    signal?: AbortSignal,
    fields: readonly string[] = [],
    access: ScanAccess = "whole",
  ): AsyncIterable<EntityValue> {
    if (owner === "episode") {
      if (!this.reader.episodes)
        throw new TypeError("episode query storage is unavailable");
      for await (const episode of this.reader.episodes(signal, access)) {
        signal?.throwIfAborted();
        yield episodeValue(episode);
      }
      return;
    }
    if (this.reader.projectEntities) {
      const requested = new Set(fields);
      const physicalFields = physicalProjectionFields(owner, fields);
      const mappings = owner === "subject" && requested.has("platform")
        ? await this.mappings()
        : null;
      for await (const entity of this.reader.projectEntities(
        owner,
        physicalFields,
        signal,
        access,
      )) {
        signal?.throwIfAborted();
        if (entity.kind !== owner)
          throw new TypeError(`SiteRelease returned ${entity.kind} for ${owner} scan`);
        yield projectedEntityValue(entity, requested, mappings);
      }
      return;
    }
    const mappings = owner === "subject" ? await this.mappings() : null;
    for await (const entity of this.reader.entities(owner, signal, access)) {
      signal?.throwIfAborted();
      if (entity.kind !== owner)
        throw new TypeError(`SiteRelease returned ${entity.kind} for ${owner} scan`);
      yield entityValue(entity, mappings);
    }
  }

  async *scanCandidates(
    owner: Owner,
    refs: readonly `${Owner}:${number}`[],
    signal?: AbortSignal,
    fields: readonly string[] = [],
  ): AsyncIterable<EntityValue> {
    const uniqueRefs = [...new Set(refs)];
    for (const ref of uniqueRefs)
      if (parseEntityRef(ref).owner !== owner)
        throw new TypeError("candidate ref owner does not match its scan");
    if (!uniqueRefs.length) return;
    if (owner !== "episode" && this.reader.projectEntityCandidates) {
      const requested = new Set(fields);
      const physicalFields = physicalProjectionFields(owner, fields);
      const keys = uniqueRefs.map(keyFromRef);
      const requestedKeys = new Set(keys);
      const returned = new Set<number>();
      const mappings = owner === "subject" && requested.has("platform")
        ? await this.mappings()
        : null;
      for await (const entity of this.reader.projectEntityCandidates(
        owner,
        keys,
        physicalFields,
        signal,
      )) {
        signal?.throwIfAborted();
        if (entity.kind !== owner || !requestedKeys.has(entity.key))
          throw new TypeError("SiteRelease returned an unrequested candidate");
        if (returned.has(entity.key))
          throw new TypeError("SiteRelease returned a duplicate candidate");
        returned.add(entity.key);
        yield projectedEntityValue(entity, requested, mappings);
      }
      return;
    }
    const remaining = new Set(uniqueRefs);
    for await (const entity of this.scan(owner, signal, fields, "stream")) {
      if (!remaining.delete(entity.ref)) continue;
      yield entity;
      if (!remaining.size) return;
    }
  }

  async entity(
    ref: `${Owner}:${number}`,
    signal?: AbortSignal,
  ): Promise<EntityValue | null> {
    signal?.throwIfAborted();
    const parsed = parseEntityRef(ref);
    if (parsed.owner === "episode") {
      if (!this.reader.episode)
        throw new TypeError("episode query storage is unavailable");
      const episode = await this.reader.episode(parsed.archiveId, signal);
      return episode ? episodeValue(episode) : null;
    }
    const entity = await this.reader.entity(keyFromRef(ref), signal);
    signal?.throwIfAborted();
    return entity
      ? entityValue(entity, parsed.owner === "subject" ? await this.mappings() : null)
      : null;
  }

  async fact(
    ref: `fact:${number}`,
    signal?: AbortSignal,
  ): Promise<FactValue | null> {
    signal?.throwIfAborted();
    if (!this.reader.fact)
      throw new TypeError("fact query storage is unavailable");
    const id = parseFactRef(ref);
    const fact = await this.reader.fact(id, signal);
    signal?.throwIfAborted();
    if (!fact) return null;
    if (fact.ref !== id)
      throw new TypeError(`FactRef ${ref} returned a different fact`);
    return factValue(fact);
  }

  async *lookup(
    text: string,
    owner: Owner,
    fields: readonly LookupField[],
    signal?: AbortSignal,
    entityFields: readonly string[] = [],
  ): AsyncIterable<EntityValue> {
    if (!this.searchIndex)
      throw new TypeError("query lookup index is unavailable");
    const requested = new Set(entityFields);
    const physicalFields = owner === "episode"
      ? entityFields
      : physicalProjectionFields(owner, entityFields);
    for await (const hit of this.searchIndex.lookup(
      text,
      owner,
      fields,
      signal,
      physicalFields,
    )) {
      signal?.throwIfAborted();
      const value = "fields" in hit.entity
        ? projectedEntityValue(
            hit.entity,
            requested,
            hit.entity.kind === "subject" && requested.has("platform")
              ? await this.mappings()
              : null,
          )
        : "key" in hit.entity
          ? entityValue(
              hit.entity,
              hit.entity.kind === "subject" ? await this.mappings() : null,
            )
          : episodeValue(hit.entity);
      if (value.owner !== owner)
        throw new TypeError("query lookup returned the wrong owner");
      value.searchMatch = {
        field: hit.field,
        text: hit.text,
        utf8Range: hit.utf8Range,
      };
      yield value;
    }
  }

  async *fullText(
    text: string,
    owner: Owner,
    field: FullTextField,
    signal?: AbortSignal,
    entityFields: readonly string[] = [],
  ): AsyncIterable<EntityValue> {
    if (!this.searchIndex)
      throw new TypeError("query full-text index is unavailable");
    const requested = new Set(entityFields);
    const physicalFields = owner === "episode"
      ? entityFields
      : physicalProjectionFields(owner, entityFields);
    for await (const hit of this.searchIndex.fullText(
      text,
      owner,
      field,
      signal,
      physicalFields,
    )) {
      signal?.throwIfAborted();
      const value = "fields" in hit.entity
        ? projectedEntityValue(
            hit.entity,
            requested,
            hit.entity.kind === "subject" && requested.has("platform")
              ? await this.mappings()
              : null,
          )
        : "key" in hit.entity
          ? entityValue(
              hit.entity,
              hit.entity.kind === "subject" ? await this.mappings() : null,
            )
          : episodeValue(hit.entity);
      if (value.owner !== owner)
        throw new TypeError("query full text returned the wrong owner");
      value.searchMatch = {
        field: hit.field,
        text: searchSnippet(hit.text, hit.utf8Range),
        utf8Range: hit.utf8Range,
      };
      yield value;
    }
  }

  async *fullTextFact(
    text: string,
    factKind: QueryFactKind,
    field: string,
    signal?: AbortSignal,
  ): AsyncIterable<FactValue> {
    if (factKind !== "VOICE_CREDIT" || field !== "summary")
      throw new TypeError(`unsupported fact full text ${factKind}.${field}`);
    if (!this.searchIndex || !this.reader.fact)
      throw new TypeError("query fact full-text index is unavailable");
    for await (const hit of this.searchIndex.factFullText(
      text,
      factKind,
      "summary",
      signal,
    )) {
      signal?.throwIfAborted();
      const ref = parseFactRef(hit.ref);
      const fact = await this.reader.fact(ref, signal);
      if (!fact || fact.ref !== ref || fact.kind !== factKind)
        throw new TypeError(`fact full-text result ${hit.ref} is missing`);
      const value = factValue(fact);
      value.searchMatch = {
        field: hit.field,
        text: searchSnippet(hit.text, hit.utf8Range),
        utf8Range: hit.utf8Range,
      };
      yield value;
    }
  }

  async *facts(
    ref: `${Owner}:${number}`,
    signal?: AbortSignal,
  ): AsyncIterable<FactValue> {
    if (parseEntityRef(ref).owner === "episode") return;
    const key = keyFromRef(ref);
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await this.reader.factsFor(key, cursor, signal);
      for (const fact of page.items) yield factValue(fact);
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
  }

  async *followRef(
    anchor: EntityValue,
    referenceOwner: Owner,
    field: string,
    direction: "forward" | "reverse",
    signal?: AbortSignal,
  ): AsyncIterable<EntityValue> {
    if (referenceOwner !== "episode" || field !== "subjectRef")
      throw new TypeError(`unsupported reference ${referenceOwner}.${field}`);
    if (direction === "forward") {
      if (anchor.owner !== "episode")
        throw new TypeError("episode.subjectRef requires an Episode anchor");
      if (!this.reader.episode)
        throw new TypeError("episode query storage is unavailable");
      const id = parseEntityRef(anchor.ref).archiveId;
      const episode = await this.reader.episode(id, signal);
      if (!episode)
        throw new TypeError(`reference source ${anchor.ref} is missing`);
      const subject = await this.reader.entity(episode.subject, signal);
      if (!subject) return;
      if (subject.key !== episode.subject)
        throw new TypeError(`reference target ${episode.subject} owner mismatch`);
      yield entityValue(subject, await this.mappings());
      return;
    }
    if (anchor.owner !== "subject")
      throw new TypeError("reverse episode.subjectRef requires a Subject anchor");
    if (!this.reader.episodesFor)
      throw new TypeError("episode reverse-reference index is unavailable");
    const subject = keyFromRef(anchor.ref);
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await this.reader.episodesFor(subject, cursor, signal);
      for (const episode of page.items) {
        if (episode.subject !== subject)
          throw new TypeError("episode reverse-reference owner mismatch");
        yield episodeValue(episode);
      }
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
  }
}
