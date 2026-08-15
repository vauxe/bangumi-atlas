/** 查询工作区的浏览器接线。该模块在 Canvas 几何流启动后异步加载，
 * 让编辑器、答案渲染与 Worker 客户端不阻塞星图首包解析。 */

import type { Data } from "../data";
import { decodeDisplayText } from "../html";
import { loadRanksByKey, openSearchAliases } from "../loader";
import { searchNameSuggestions } from "../search";
import type { SearchResult } from "../search";
import { notify, state, subscribe } from "../store";
import type {
  EntityKind,
  Geometry,
  Manifest,
  Names,
} from "../types";
import { ENTITY_KIND_BY_OWNER, ENTITY_OWNER_BY_KIND } from "../types";
import {
  ambiguousNameSuggestionRanks,
  projectedEntitySuggestionContext,
} from "../value-labels";
import { parseEntityRef, QUERY_CONTRACT, type Owner } from "./contract";
import { decodeBundle, encodeShareableBundle } from "./bundle-url";
import { compileExplorerQuery } from "./explorer";
import type { EntityValue } from "./engine";
import { mergeQueryHighlights } from "./highlights";
import {
  rankEntitySuggestions,
  type EntitySuggestion,
  type EntitySuggestionBatch,
  type NameSuggestion,
} from "./query-bar";
import { QUERY_SECURITY_PROFILE } from "./security";
import { SiteQueryDataSource } from "./site-source";
import { QueryWorkbench } from "./workbench";
import { OWNER_LABEL } from "./workbench-model";
import { QueryWorkerClient } from "./worker-client";

const SUGGESTION_CONTEXT_FIELDS = [
  "type",
  "platformCode",
  "date",
  "career",
  "role",
];

type SelectNode = (
  rank: number,
  camera: "fly",
  push?: boolean,
  keyHint?: number | null,
  episodeId?: number | null,
) => Promise<void>;

export interface QueryRuntimeDependencies {
  host: HTMLElement;
  manifest: Manifest;
  data: Data;
  geo: Geometry;
  names: Names;
  rankOfKey(key: number): number | null;
  select: SelectNode;
  updateQueryUrl(query: string | null, push: boolean): void;
}

export interface InstalledQueryRuntime {
  focus(): void;
  /** Restore one opaque URL payload and return its canonical spelling. */
  restoreQuery(query: string | null): string | null;
}

export function mergePreparedNameSuggestions(
  canvas: readonly SearchResult[],
  episodes: readonly EntitySuggestion[],
  contextByRank: ReadonlyMap<number, string>,
): NameSuggestion[] {
  return [
    ...canvas.map((item) => {
      const owner = ENTITY_OWNER_BY_KIND[item.entityKind];
      const context = contextByRank.get(item.rank);
      return {
        key: `rank:${item.rank}`,
        rank: item.rank,
        owner,
        label: item.display,
        detail: context
          ? `${OWNER_LABEL[owner]} · ${context}`
          : OWNER_LABEL[owner],
        ...(item.matched !== item.display
          ? { match: item.matched }
          : {}),
      };
    }),
    ...episodes.map((item) => ({
      key: item.ref,
      ref: item.ref,
      owner: item.owner,
      label: item.label,
      detail: item.detail,
      ...(item.match ? { match: item.match } : {}),
    })),
  ].slice(0, 18);
}

export function installQueryRuntime(
  dependencies: QueryRuntimeDependencies,
): InstalledQueryRuntime {
  const {
    host,
    manifest,
    data,
    geo,
    names,
    rankOfKey,
    select,
    updateQueryUrl,
  } = dependencies;
  const searchAliases = openSearchAliases(manifest);
  const resultSource = new SiteQueryDataSource(data);
  let queryClient: QueryWorkerClient | null = null;
  const client = (): QueryWorkerClient => {
    queryClient ??= new QueryWorkerClient(
      () => new Worker(new URL("query-worker.js", document.baseURI)),
    );
    return queryClient;
  };
  let suggestionClient: QueryWorkerClient | null = null;
  const suggestions = (): QueryWorkerClient => {
    suggestionClient ??= new QueryWorkerClient(
      new Worker(new URL("query-worker.js", document.baseURI)),
    );
    return suggestionClient;
  };

  const queryEntitySuggestionPage = async (
    text: string,
    owner: Owner,
    offset: number,
    pageSize: number,
    signal: AbortSignal,
  ): Promise<{ items: EntitySuggestion[]; consumed: number; hasMore: boolean }> => {
    const columns = [
      "ref",
      "name",
      ...(owner === "subject" || owner === "episode" ? ["nameCn"] : []),
      ...(owner === "episode" ? ["subjectRef"] : []),
    ];
    const section = compileExplorerQuery({
      owner,
      text: { value: text, capability: "lookup" },
      columns,
      limit: offset + pageSize + 1,
    }).sections.results!;
    const result = await suggestions().execute(
      section.query,
      section.parameterValues ?? {},
      { offset, pageSize, signal },
    );
    const items = await Promise.all(result.rows.map(async (row, index) => {
      const ref = row.ref;
      const projectedName = typeof row.nameCn === "string" && row.nameCn
        ? row.nameCn
        : row.name;
      if (typeof ref !== "string" || typeof projectedName !== "string")
        return null;
      const projectedMatch = Object.values(result.evidence[index] ?? {}).flat()
        .find((item) => item.kind === "text-range")?.snippet;
      let detail = OWNER_LABEL[owner];
      if (owner === "episode" && typeof row.subjectRef === "string") {
        const subjectRef = parseEntityRef(row.subjectRef);
        if (subjectRef.owner === "subject" && subjectRef.archiveId <= 0xffffff) {
          const subject = await data.entity((1 << 24) | subjectRef.archiveId, signal);
          if (subject?.kind === "subject")
            detail = `${detail} · ${decodeDisplayText(subject.nameCn || subject.name)}`;
        }
      }
      return {
        ref: ref as `${Owner}:${number}`,
        owner,
        label: projectedName,
        detail,
        ...(projectedMatch ? { match: projectedMatch } : {}),
      } satisfies EntitySuggestion;
    }));
    signal.throwIfAborted();
    return {
      items: items.filter((item) => item !== null),
      consumed: result.rows.length,
      hasMore: result.hasMore,
    };
  };

  const suggestQueryEntities = async function* (
    text: string,
    owners: readonly Owner[],
    signal: AbortSignal,
  ): AsyncGenerator<EntitySuggestionBatch> {
    if (
      [...text.trim()].length <
        QUERY_CONTRACT.search.lookup.minNormalizedCharacters
    ) {
      yield { items: [], complete: true };
      return;
    }
    let cursors = [...new Set(owners)].map((owner) => ({ owner, offset: 0 }));
    if (!cursors.length) {
      yield { items: [], complete: true };
      return;
    }
    while (cursors.length) {
      const pages = await Promise.all(cursors.map(async ({ owner, offset }) => ({
        owner,
        offset,
        page: await queryEntitySuggestionPage(
          text,
          owner,
          offset,
          QUERY_SECURITY_PROFILE.execution.maxPageSize,
          signal,
        ),
      })));
      signal.throwIfAborted();
      const next: { owner: Owner; offset: number }[] = [];
      for (const { owner, offset, page } of pages) {
        if (!page.hasMore) continue;
        if (!page.consumed)
          throw new TypeError("实体建议分页没有向前推进");
        next.push({ owner, offset: offset + page.consumed });
      }
      const items = rankEntitySuggestions(
        text,
        pages.flatMap(({ page }) => page.items),
      );
      cursors = next;
      if (items.length || !cursors.length)
        yield { items, complete: cursors.length === 0 };
    }
  };

  const navigateEntity = async (ref: string): Promise<void> => {
    const parsed = parseEntityRef(ref);
    if (parsed.owner === "episode") {
      const episode = await data.episode(parsed.archiveId);
      if (!episode) throw new TypeError(`${ref} 不在当前数据版本中`);
      const rank = rankOfKey(episode.subject) ??
        (await loadRanksByKey([episode.subject])).get(episode.subject) ?? null;
      if (rank === null) throw new TypeError(`${ref} 所属作品不在当前星图中`);
      await select(rank, "fly", true, episode.subject, episode.id);
      return;
    }
    const kind = ENTITY_KIND_BY_OWNER[parsed.owner];
    if (parsed.archiveId > 0xffffff)
      throw new TypeError(`${ref} 不能在当前星图中定位`);
    const key = (kind << 24) | parsed.archiveId;
    const rank = rankOfKey(key) ??
      (await loadRanksByKey([key])).get(key) ?? null;
    if (rank === null) throw new TypeError(`${ref} 不在当前数据版本中`);
    await select(rank, "fly", true, key);
  };

  const highlightQueryResults = (
    highlights: Parameters<typeof mergeQueryHighlights>[0],
  ): number => {
    const ranks = mergeQueryHighlights(highlights);
    state.queryResultRanks = ranks;
    notify();
    return ranks.length;
  };

  const currentQueryUrl = (): string | null => state.queryBundle
    ? encodeShareableBundle(state.queryBundle)
    : null;

  const queryWorkbench = new QueryWorkbench({
    host,
    execute: (section, options) =>
      client().execute(section.query, section.parameterValues ?? {}, options),
    executeWithHighlights: (section, options) =>
      client().executeWithHighlights(
        section.query,
        section.parameterValues ?? {},
        options,
      ),
    selectedEntity: async () => {
      const key = state.selectionKey;
      const rank = state.selection;
      if (!key || rank === null) return null;
      const owner = ENTITY_OWNER_BY_KIND[key >>> 24];
      if (!owner) return null;
      await names.load([rank]);
      return {
        ref: `${owner}:${key & 0xffffff}`,
        label: decodeDisplayText(
          names.get(rank) ?? `${owner} #${key & 0xffffff}`,
        ),
      };
    },
    resolveEntityLabel: async (ref) => {
      const parsed = parseEntityRef(ref);
      if (parsed.owner === "episode") {
        const episode = await data.episode(parsed.archiveId);
        return decodeDisplayText(
          episode?.name || `分集 #${parsed.archiveId}`,
        );
      }
      const kind = ENTITY_KIND_BY_OWNER[parsed.owner];
      if (parsed.archiveId > 0xffffff)
        throw new TypeError("实体不在当前数据版本中");
      const entity = await data.entity((kind << 24) | parsed.archiveId);
      if (!entity) throw new TypeError("实体不在当前数据版本中");
      return decodeDisplayText(
        entity.kind === "subject" ? entity.nameCn || entity.name : entity.name,
      );
    },
    suggestEntities: suggestQueryEntities,
    suggestNames: async (text, owners, signal) => {
      const canvasKinds = owners.flatMap((owner): EntityKind[] =>
        owner === "episode" ? [] : [ENTITY_KIND_BY_OWNER[owner]]
      );
      const [canvas, episodes] = await Promise.all([
        canvasKinds.length
          ? searchNameSuggestions(text, searchAliases, {
              limit: 18,
              entityKinds: canvasKinds,
              signal,
            })
          : [],
        owners.includes("episode")
          ? queryEntitySuggestionPage(text, "episode", 0, 18, signal)
              .then(({ items }) => items)
          : [],
      ]);
      const ambiguousRanks = ambiguousNameSuggestionRanks(canvas);
      const contextTargets = canvas.flatMap((item) => {
        const key = geo.key[item.rank];
        return ambiguousRanks.has(item.rank) && key
          ? [{ rank: item.rank, key }]
          : [];
      });
      const contextByRank = new Map<number, string>();
      if (contextTargets.length) {
        const mappings = await data.mappings();
        const contexts = await Promise.allSettled(contextTargets.map(
          async ({ rank, key }) => {
            const entity = await data.projectEntity(
              key,
              SUGGESTION_CONTEXT_FIELDS,
              signal,
            );
            return entity
              ? [rank, projectedEntitySuggestionContext(entity, mappings)] as const
              : null;
          },
        ));
        signal.throwIfAborted();
        for (const context of contexts) {
          if (context.status === "fulfilled" && context.value?.[1])
            contextByRank.set(...context.value);
        }
      }
      return mergePreparedNameSuggestions(canvas, episodes, contextByRank);
    },
    suggestTagValues: (field, text, signal) =>
      data.suggestTagValues(field, text, { signal }),
    featuredMetaTagValues: manifest.tags,
    onNameSuggestion: async (suggestion) => {
      if (suggestion.rank !== undefined) {
        await select(suggestion.rank, "fly");
        return;
      }
      if (suggestion.ref) {
        await navigateEntity(suggestion.ref);
        return;
      }
      throw new TypeError("无法定位这个名称建议");
    },
    releaseId: () => manifest.version,
    mappings: () => data.mappings(),
    projectResultEntities: async (owner, refs, fields, signal) => {
      const entities: EntityValue[] = [];
      for await (const entity of resultSource.scanCandidates(
        owner,
        refs,
        signal,
        fields,
      )) entities.push(entity);
      return entities;
    },
    onEntity: navigateEntity,
    onResultHighlights: highlightQueryResults,
    updateUrl: () => updateQueryUrl(currentQueryUrl(), false),
    pushUrl: () => updateQueryUrl(currentQueryUrl(), true),
  });
  subscribe(() => queryWorkbench.sync(state.queryBundle));
  queryWorkbench.sync(state.queryBundle);
  return {
    focus: () => queryWorkbench.focus(),
    restoreQuery: (query) => {
      state.queryBundle = decodeBundle(query ?? "");
      notify();
      return currentQueryUrl();
    },
  };
}
