import type { StructuralEntity } from "../types";
import type { TextSearchRow } from "../data";
import {
  fold,
  foldedUtf8Range,
  loadCharmap,
  loadEntityKeys,
  openSearchAliases,
  textSearchMemberPage,
  type TextSearchMember,
  type TextSearchMemberPage,
} from "../loader";
import { findSubstringEntries, type SearchEntryPage } from "../search";
import type { Manifest, SearchAliases } from "../types";
import { QUERY_CONTRACT, type Owner, type QueryFactKind } from "./contract";
import type { FullTextField, LookupField } from "./document";
import type { SiteQueryReader, SiteQuerySearch } from "./site-source";

const OWNER_KIND: Record<Exclude<Owner, "episode">, number> = {
  subject: 1,
  person: 2,
  character: 3,
};

const TEXT_MEMBER_READ_CONCURRENCY = 6;

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

export interface SiteSearchDependencies {
  normalize(text: string): Promise<string>;
  page(
    query: string,
    cursor: number,
    signal: AbortSignal,
  ): Promise<SearchEntryPage>;
  keys(signal?: AbortSignal): Promise<Uint32Array>;
  textPage?(
    query: string,
    cursor: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<TextSearchMemberPage>;
}

function defaultDependencies(
  aliases: SearchAliases,
): SiteSearchDependencies {
  return {
    async normalize(text) {
      await loadCharmap();
      return fold(text);
    },
    page: (query, cursor, signal) =>
      findSubstringEntries(query, aliases, { cursor, signal }),
    keys: loadEntityKeys,
    textPage: textSearchMemberPage,
  };
}

export class SiteQuerySearchIndex implements SiteQuerySearch {
  private readonly dependencies: SiteSearchDependencies;

  constructor(
    private readonly reader: SiteQueryReader,
    manifest: Manifest,
    dependencies?: SiteSearchDependencies,
  ) {
    this.dependencies = dependencies ?? defaultDependencies(openSearchAliases(manifest));
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

  async *lookup(
    text: string,
    owner: Owner,
    fields: readonly LookupField[] = ["name"],
    signal = new AbortController().signal,
  ): AsyncIterable<{
    entity: StructuralEntity | import("../types").EpisodeRecord;
    field: LookupField;
    text: string;
    utf8Range: [number, number];
  }> {
    const query = await this.normalized(text, "lookup");
    const allowedFields = new Set(fields);
    if (owner === "episode") {
      if (!this.dependencies.textPage || !this.reader.textSearchRows || !this.reader.episode)
        throw new TypeError("published Episode identity index is unavailable");
      const seen = new Set<number>();
      let textCursor = 0;
      for (;;) {
        signal.throwIfAborted();
        const page = await this.dependencies.textPage(query, textCursor, 256, signal);
        const descriptors = page.members.filter(
          (descriptor) => descriptor[0] === "episode-identity",
        );
        for await (const rows of textRowBlocks(this.reader, descriptors, signal)) {
          for (const row of rows) {
            if (
              row.owner !== "episode" ||
              (row.field !== "name" && row.field !== "nameCn") ||
              !allowedFields.has(row.field) ||
              seen.has(row.id)
            ) continue;
            const range = foldedUtf8Range(row.text, query);
            if (!range) continue;
            const episode = await this.reader.episode(row.id, signal);
            if (!episode || episode.id !== row.id)
              throw new TypeError(`Episode identity ${row.id} is missing`);
            seen.add(row.id);
            yield { entity: episode, field: row.field, text: row.text, utf8Range: range };
          }
        }
        if (page.next === null) return;
        if (page.next <= textCursor)
          throw new TypeError("Episode lookup candidate cursor did not advance");
        textCursor = page.next;
      }
    }
    const allowedKind = OWNER_KIND[owner];
    const seen = new Set<string>();
    const keys = await this.dependencies.keys(signal);
    let cursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.dependencies.page(query, cursor, signal);
      for (const entry of page.entries) {
        if (entry[4] !== allowedKind) continue;
        const rank = entry[2];
        const key = keys[rank];
        if (key === undefined || key >>> 24 !== entry[4])
          throw new TypeError(`search rank ${rank} has no matching stable key`);
        const identity = `${owner}:${key & 0xffffff}`;
        if (seen.has(identity)) continue;
        const entity = await this.reader.entity(key, signal);
        signal.throwIfAborted();
        if (!entity || entity.key !== key)
          throw new TypeError(`search entity ${key} is missing`);
        const nameCn = entity.kind === "subject" ? entity.nameCn : "";
        const field: LookupField = entry[1] === entity.name
          ? "name"
          : nameCn && entry[1] === nameCn
            ? "nameCn"
            : "nameVariant";
        if (!allowedFields.has(field)) continue;
        const range = foldedUtf8Range(entry[1], query);
        if (!range)
          throw new TypeError("verified lookup candidate has no source range");
        seen.add(identity);
        yield { entity, field, text: entry[1], utf8Range: range };
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
  ): AsyncIterable<{
    entity: StructuralEntity | import("../types").EpisodeRecord;
    field: FullTextField;
    text: string;
    utf8Range: [number, number];
  }> {
    const query = await this.normalized(text, "fullText");
    if (!this.dependencies.textPage || !this.reader.textSearchRows)
      throw new TypeError("published text search index is unavailable");
    const seen = new Set<string>();
    let textCursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.dependencies.textPage(query, textCursor, 256, signal);
      const descriptors = page.members.filter((descriptor) =>
        textDescriptorMatches(descriptor, owner, field)
      );
      for await (const rows of textRowBlocks(this.reader, descriptors, signal)) {
        for (const row of rows) {
          if (row.owner === "fact" || row.owner !== owner || row.field !== field)
            continue;
          if (!fold(row.text).includes(query)) continue;
          const identity = `${row.owner}:${row.id}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          const entity = row.owner === "episode"
            ? await this.reader.episode?.(row.id, signal)
            : await this.reader.entity(
                (OWNER_KIND[row.owner] << 24) | row.id,
                signal,
              );
          if (!entity) throw new TypeError(`text search entity ${identity} is missing`);
          const range = foldedUtf8Range(row.text, query);
          if (!range) throw new TypeError("verified text candidate has no source range");
          yield { entity, field, text: row.text, utf8Range: range };
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
