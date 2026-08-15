import { canonicalJson } from "./canonical";
import {
  normalizeBundle,
  type QueryBundle,
  type QuerySection,
} from "./bundle";
import {
  compileQueryDraft,
  defaultQueryDraft,
  draftQuery,
  ENTITY_SCOPE_ORDER,
  queryDraftFromBundle,
  type QueryDraft,
} from "./draft";
import type { EntityValue, QueryResult, RuntimeValue } from "./engine";
import type { QueryHighlights } from "./highlights";
import { queryResultEntityRefs, renderAnswer } from "./answer-view";
import { queryRowPrimaryEntityRef, type QueryEntityRef } from "./result-entities";
import {
  QueryBar,
  type EntitySuggestionBatch,
  type NameSuggestion,
  type SelectedQueryEntity,
} from "./query-bar";
import {
  appendQueryResultPage,
  commitRenderedResults,
  revealQueryResult,
} from "./result-buffer";
import { QUERY_SECURITY_PROFILE } from "./security";
import { fieldDefinition, parseEntityRef, type Owner } from "./contract";
import { notify, state } from "../store";
import type { Mappings, TagVocabularyField } from "../types";
import { setQueryIconButton, type QueryIconName } from "./icons";
import {
  RESULT_ENTITY_TYPE_FIELD,
  normalizeResultColumnSelection,
  ownerSupportsResultField,
} from "./result-columns";
import { MISSING } from "./value";

export interface QueryWorkbenchDependencies {
  host?: HTMLElement;
  execute(
    section: QuerySection,
    options: { offset: number; pageSize: number; signal: AbortSignal },
  ): Promise<QueryResult>;
  executeWithHighlights?(
    section: QuerySection,
    options: { offset: number; pageSize: number; signal: AbortSignal },
  ): Promise<{ result: QueryResult; highlights: QueryHighlights }>;
  selectedEntity?(): Promise<SelectedQueryEntity | null>;
  resolveEntityLabel?(ref: string): Promise<string>;
  suggestEntities?(
    text: string,
    owners: readonly Owner[],
    signal: AbortSignal,
  ): AsyncIterable<EntitySuggestionBatch>;
  suggestNames?(
    text: string,
    owners: readonly Owner[],
    signal: AbortSignal,
  ): Promise<NameSuggestion[]>;
  suggestTagValues?(
    field: TagVocabularyField,
    text: string,
    signal: AbortSignal,
  ): Promise<readonly string[]>;
  featuredMetaTagValues?: readonly string[];
  onNameSuggestion?(suggestion: NameSuggestion): void | Promise<void>;
  releaseId(): string;
  onEntity(ref: string): void | Promise<void>;
  onResultEntities?(refs: readonly string[]): number | Promise<number>;
  onResultHighlights?(highlights: readonly QueryHighlights[]): number | Promise<number>;
  mappings?(): Promise<Mappings>;
  projectResultEntities?(
    owner: Owner,
    refs: readonly QueryEntityRef[],
    fields: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly EntityValue[]>;
  onBundle?(bundle: QueryBundle): void;
  updateUrl(): void;
  pushUrl?(): void;
}

function action(label: string, className = ""): HTMLButtonElement {
  const result = document.createElement("button");
  result.type = "button";
  result.className = className;
  result.textContent = label;
  return result;
}

function iconAction(
  icon: QueryIconName,
  label: string,
  className = "",
): HTMLButtonElement {
  const result = action("", className);
  setQueryIconButton(result, icon, label);
  return result;
}

function labeledIconAction(
  icon: QueryIconName,
  label: string,
  className = "",
): HTMLButtonElement {
  const result = iconAction(icon, label, className);
  const text = document.createElement("span");
  text.textContent = label;
  result.append(text);
  return result;
}

function enoughText(draft: QueryDraft): boolean {
  const text = draft.kind === "list" && !draft.query
    ? draft.allText.trim()
    : draftQuery(draft)?.text?.value.trim();
  return !text || [...text].length >= 2;
}

/** Merge the entities present in each buffered answer section. */
export function mergeQueryResultRefs(
  sections: ReadonlyMap<string, readonly string[]>,
): string[] {
  const refs = new Set<string>();
  for (const section of sections.values())
    for (const ref of section) refs.add(ref);
  return [...refs];
}

/** Adds presentation-only fields while preserving the executed result metadata. */
export function hydrateQueryResultColumns(
  result: QueryResult,
  selectedColumns: readonly string[],
  entities: readonly EntityValue[],
): QueryResult {
  const entityByRef = new Map<QueryEntityRef, EntityValue>();
  for (const entity of entities) {
    if (entityByRef.has(entity.ref))
      throw new TypeError(`结果列返回了重复实体：${entity.ref}`);
    entityByRef.set(entity.ref, entity);
  }
  const columns = { ...result.columns };
  for (const field of selectedColumns) {
    if (columns[field]) continue;
    if (field === RESULT_ENTITY_TYPE_FIELD) {
      columns[field] = { type: "string" };
      continue;
    }
    const owners = ENTITY_SCOPE_ORDER.filter((owner) =>
      ownerSupportsResultField(owner, field)
    );
    const owner = owners[0];
    if (!owner) continue;
    columns[field] = {
      type: fieldDefinition(owner, field).type,
      ...(owners.length === 1 ? { semantic: `${owner}.${field}` } : {}),
    };
  }
  const evidence = [...result.evidence];
  const rows = result.rows.map((row, index) => {
    const ref = queryRowPrimaryEntityRef(row, result.evidence[index]);
    if (!ref) return row;
    const owner = parseEntityRef(ref).owner;
    let next = row;
    let nextEvidence = result.evidence[index] ?? {};
    for (const field of selectedColumns) {
      if (Object.hasOwn(row, field)) continue;
      let value: RuntimeValue;
      if (field === RESULT_ENTITY_TYPE_FIELD) value = owner;
      else if (!ownerSupportsResultField(owner, field)) value = null;
      else {
        const entity = entityByRef.get(ref);
        value = entity && Object.hasOwn(entity.fields, field)
          ? entity.fields[field]!
          : MISSING;
        if (entity && Object.hasOwn(entity.fields, field)) {
          if (nextEvidence === result.evidence[index])
            nextEvidence = { ...nextEvidence };
          nextEvidence[field] = [{ kind: "entity-field", ref, field }];
        }
      }
      if (next === row) next = { ...row };
      next[field] = value;
    }
    if (nextEvidence !== result.evidence[index]) evidence[index] = nextEvidence;
    return next;
  });
  return { ...result, rows, evidence, columns };
}

export function queryWorkspaceVisibility(
  expanded: boolean,
  hasAnswer: boolean,
  running: boolean,
): { workspaceHidden: boolean; reopenHidden: boolean } {
  return {
    workspaceHidden: !expanded,
    reopenHidden: expanded || !(hasAnswer || running),
  };
}

export function queryHighlightStatus(count: number, current: boolean): string {
  return count > 0 && !current ? "图中仍显示上次结果" : "";
}

export class QueryWorkbench {
  private readonly panel = document.createElement("main");
  private readonly workspace = document.createElement("section");
  private readonly status = document.createElement("div");
  private readonly highlightStatus = document.createElement("span");
  private readonly answers = document.createElement("div");
  private readonly reopenButton = labeledIconAction("expand", "查看结果", "query-reopen");
  private readonly bar: QueryBar;
  private controller: AbortController | null = null;
  private running = false;
  private runnable = true;
  private expanded = false;
  private hasAnswer = false;
  private lastBundle = "";
  private answerBundle = "";
  private resultRefsBySection = new Map<string, string[]>();
  private resultHighlightsBySection = new Map<string, QueryHighlights>();
  private highlightSerial = 0;
  private highlightCount = 0;
  private resultsCurrent = false;

  constructor(private readonly dependencies: QueryWorkbenchDependencies) {
    this.panel.id = "query-workbench";
    this.panel.className = "query-workbench";
    this.panel.setAttribute("aria-label", "统一查询");

    const compose = document.createElement("section");
    compose.className = "query-compose";
    compose.setAttribute("aria-label", "查询内容");
    const barHost = document.createElement("div");
    barHost.className = "query-bar-host";
    this.reopenButton.hidden = true;
    this.reopenButton.setAttribute("aria-controls", "query-workspace");
    compose.append(barHost, this.reopenButton);

    this.workspace.id = "query-workspace";
    this.workspace.className = "query-workspace";
    this.workspace.hidden = true;
    this.workspace.setAttribute("aria-label", "查询答案");
    const toolbar = document.createElement("header");
    const meta = document.createElement("div");
    meta.className = "query-workspace-meta";
    const reset = action("清空查询", "query-reset");
    const collapse = iconAction("collapse", "收起结果", "query-collapse");
    this.status.className = "query-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.highlightStatus.className = "query-highlight-status";
    meta.append(this.status, this.highlightStatus);
    toolbar.append(meta, reset, collapse);

    this.answers.className = "query-answers";
    this.answers.setAttribute("aria-label", "查询答案内容");
    this.workspace.append(toolbar, this.answers);
    this.panel.append(compose, this.workspace);
    (dependencies.host ?? document.body).append(this.panel);

    this.bar = new QueryBar({
      draft: defaultQueryDraft(),
      onChange: (draft) => this.draftChanged(draft),
      onSubmit: () => this.runCurrent(),
      onCancel: () => this.cancelCurrent(),
      reportError: (error) => this.showError(error),
      selectedEntity: dependencies.selectedEntity,
      resolveEntityLabel: dependencies.resolveEntityLabel,
      suggestEntities: dependencies.suggestEntities,
      suggestNames: dependencies.suggestNames,
      suggestTagValues: dependencies.suggestTagValues,
      featuredMetaTagValues: dependencies.featuredMetaTagValues,
      onNameSuggestion: dependencies.onNameSuggestion
        ? (suggestion) => {
            void Promise.resolve(dependencies.onNameSuggestion?.(suggestion))
              .catch((error) => this.showError(error));
          }
        : undefined,
      mappings: dependencies.mappings,
    });
    barHost.append(this.bar.dom);

    this.reopenButton.addEventListener("click", () => this.expand(false));
    collapse.addEventListener("click", () => this.collapse());
    reset.addEventListener("click", () => this.newQuery());
    this.panel.addEventListener("keydown", (event) => {
      if (event.isComposing || event.defaultPrevented || event.key !== "Escape") return;
      if (this.bar.dismissCompletion()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.expanded) {
        event.preventDefault();
        event.stopPropagation();
        this.collapse();
      }
    });
  }

  focus(): void {
    this.bar.focus();
  }

  sync(bundle: QueryBundle | null): void {
    if (!bundle) {
      if (!this.lastBundle) return;
      this.abortCurrent(new DOMException("query navigation", "AbortError"));
      this.resetQuery("navigation");
      return;
    }
    const normalized = normalizeBundle(bundle);
    const key = canonicalJson(normalized);
    if (key === this.lastBundle) return;
    const draft = queryDraftFromBundle(normalized);
    if (draft) {
      this.bar.replace(draft);
      this.runnable = true;
      this.updateRunState();
    }
    this.expand();
    void this.runBundle(normalized, false).then(() => {
      if (!draft) this.setStatus("此查询不可编辑");
    }).catch((error) => this.showError(error));
  }

  private expand(focus = true): void {
    this.expanded = true;
    this.syncWorkspaceVisibility();
    if (focus) this.bar.focus();
  }

  private collapse(focus = true): void {
    this.expanded = false;
    this.syncWorkspaceVisibility();
    if (focus) this.bar.focus();
  }

  private syncWorkspaceVisibility(): void {
    const visibility = queryWorkspaceVisibility(
      this.expanded,
      this.hasAnswer,
      this.running,
    );
    this.workspace.hidden = visibility.workspaceHidden;
    this.reopenButton.hidden = visibility.reopenHidden;
  }

  private newQuery(): void {
    this.abortCurrent(new DOMException("new query", "AbortError"));
    this.resetQuery("user");
  }

  private resetQuery(origin: "navigation" | "user"): void {
    this.lastBundle = "";
    this.answerBundle = "";
    this.hasAnswer = false;
    this.resultsCurrent = false;
    this.highlightCount = 0;
    this.renderHighlightStatus();
    this.resultRefsBySection = new Map();
    this.resultHighlightsBySection = new Map();
    this.publishResultEntities();
    if (origin === "user") {
      state.queryBundle = null;
      notify();
      if (this.dependencies.pushUrl) this.dependencies.pushUrl();
      else this.dependencies.updateUrl();
    }
    this.answers.replaceChildren();
    this.setStatus("");
    this.bar.replace(defaultQueryDraft());
    this.runnable = true;
    this.updateRunState();
    this.collapse(origin === "user");
  }

  private draftChanged(draft: QueryDraft): void {
    this.abortCurrent(new DOMException("query changed", "AbortError"));
    this.setStatus("");
    if (!enoughText(draft)) {
      this.resultsCurrent = false;
      this.renderHighlightStatus();
      this.runnable = false;
      this.setStatus("名称至少需要两个字");
      this.updateRunState();
      return;
    }
    try {
      const bundle = normalizeBundle(compileQueryDraft(draft));
      this.resultsCurrent = this.hasAnswer &&
        canonicalJson(bundle) === this.answerBundle;
      this.renderHighlightStatus();
      this.runnable = true;
      this.updateRunState();
    } catch (error) {
      this.resultsCurrent = false;
      this.renderHighlightStatus();
      this.runnable = false;
      this.updateRunState();
      this.showError(error);
    }
  }

  private runCurrent(focus = true): void {
    if (!this.runnable) return;
    try {
      this.expand(focus);
      const bundle = compileQueryDraft(this.bar.current());
      this.runnable = true;
      this.updateRunState();
      void this.runBundle(bundle, true).catch((error) => this.showError(error));
    } catch (error) {
      this.runnable = false;
      this.updateRunState();
      this.showError(error);
    }
  }

  private async runBundle(bundle: QueryBundle, persist: boolean): Promise<void> {
    const normalized = normalizeBundle(bundle);
    const bundleKey = canonicalJson(normalized);
    this.abortCurrent(new DOMException("superseded query", "AbortError"));
    const controller = new AbortController();
    this.controller = controller;
    this.setRunning(true);
    this.lastBundle = bundleKey;
    this.resultsCurrent = this.hasAnswer && bundleKey === this.answerBundle;
    this.renderHighlightStatus();
    const currentRelease = this.dependencies.releaseId();
    if (
      normalized.release.policy === "fixed" &&
      normalized.release.version !== currentRelease
    ) {
      this.answers.setAttribute("aria-busy", "false");
      this.setStatus("此查询使用的数据版本不在当前站点中");
      this.controller = null;
      this.setRunning(false);
      return;
    }
    if (persist) {
      state.queryBundle = normalized;
      this.dependencies.onBundle?.(normalized);
      notify();
      this.dependencies.updateUrl();
    }
    const pendingRefs = new Map<string, string[]>();
    const pendingHighlights = new Map<string, QueryHighlights>();
    const cards = Object.entries(normalized.sections).map(([name, section]) => {
      const card = document.createElement("section");
      card.className = "query-answer-card loading";
      card.dataset.section = name;
      card.textContent = `${section.answer.title}：加载中…`;
      pendingRefs.set(name, []);
      return { card, name, section };
    });
    this.answers.setAttribute("aria-busy", "true");
    this.setStatus("正在查询");
    try {
      const results = await commitRenderedResults(
        controller.signal,
        cards.map(({ card, name, section }) =>
          this.loadSection(
            card,
            section,
            currentRelease,
            controller.signal,
            (refs, highlights) => {
              pendingRefs.set(name, refs);
              if (highlights) pendingHighlights.set(name, highlights);
              if (
                this.resultRefsBySection === pendingRefs ||
                this.resultHighlightsBySection === pendingHighlights
              )
                this.publishResultEntities();
            },
          )
        ),
        () => {
          this.answers.replaceChildren(...cards.map(({ card }) => card));
          this.answers.setAttribute("aria-busy", "false");
          this.hasAnswer = true;
          this.answerBundle = bundleKey;
          this.resultsCurrent = true;
          this.highlightCount = 0;
          this.renderHighlightStatus();
          this.syncWorkspaceVisibility();
          this.resultRefsBySection = pendingRefs;
          this.resultHighlightsBySection = pendingHighlights;
          this.publishResultEntities();
        },
      );
      if (results) {
        const failed = results.filter((ok) => !ok).length;
        this.setStatus(failed ? `${failed} 组结果加载失败` : "");
      }
    } finally {
      if (this.controller === controller) {
        this.setRunning(false);
      }
    }
  }

  private async loadSection(
    card: HTMLElement,
    section: QuerySection,
    releaseId: string,
    signal: AbortSignal,
    onResult: (refs: string[], highlights?: QueryHighlights) => void,
  ): Promise<boolean> {
    try {
      const fetchSize = Math.min(
        section.query.limit ?? QUERY_SECURITY_PROFILE.execution.maxPageSize,
        QUERY_SECURITY_PROFILE.execution.maxPageSize,
      );
      const options = { offset: 0, pageSize: fetchSize, signal };
      const initialExecution: Promise<{
        result: QueryResult;
        highlights?: QueryHighlights;
      }> = this.dependencies.executeWithHighlights
        ? this.dependencies.executeWithHighlights(section, options)
        : this.dependencies.execute(section, options)
            .then((result) => ({ result }));
      const [execution, mappings] = await Promise.all([
        initialExecution,
        this.dependencies.mappings?.(),
      ]);
      let result = execution.result;
      const sectionHighlights = execution.highlights;
      if (result.releaseId !== releaseId)
        throw new TypeError("查询结果来自不同的数据版本，请刷新页面后重试");
      const entityScope = section.answer.shape === "entity-list"
        ? [...section.answer.entityScope]
        : [];
      let selectedColumns = entityScope.length
        ? normalizeResultColumnSelection(entityScope, Object.keys(result.columns))
        : [];
      const hydratedEntities = new Map<QueryEntityRef, EntityValue>();
      let presentedResult: QueryResult | null = null;
      let presentedSource: QueryResult | null = null;
      let presentedColumns = "";
      let shown = Math.min(50, result.rows.length);
      let loadingMore = false;
      let publishedRows = -1;
      let answerView: ReturnType<typeof renderAnswer> | null = null;
      let renderSerial = 0;
      let columnChangeSerial = 0;
      const hydrateColumns = async (selection: readonly string[]): Promise<void> => {
        const projector = this.dependencies.projectResultEntities;
        if (!projector || !entityScope.length) return;
        const requests = entityScope.flatMap((owner) => {
          const available = selection.filter((field) =>
            field !== RESULT_ENTITY_TYPE_FIELD &&
            ownerSupportsResultField(owner, field)
          );
          if (!available.length) return [];
          const refs: QueryEntityRef[] = [];
          const fields = new Set<string>();
          result.rows.forEach((row, index) => {
            const ref = queryRowPrimaryEntityRef(row, result.evidence[index]);
            if (!ref || parseEntityRef(ref).owner !== owner) return;
            const cached = hydratedEntities.get(ref);
            const missing = available.filter((field) =>
              !Object.hasOwn(row, field) &&
              !(cached && Object.hasOwn(cached.fields, field))
            );
            if (!missing.length) return;
            refs.push(ref);
            for (const field of missing) fields.add(field);
          });
          return refs.length ? [{ owner, refs: [...new Set(refs)], fields: [...fields] }] : [];
        });
        const batches = await Promise.all(requests.map(({ owner, refs, fields }) =>
          projector(owner, refs, fields, signal).then((entities) => ({
            owner,
            refs,
            fields,
            entities,
          }))
        ));
        signal.throwIfAborted();
        for (const { owner, refs, fields, entities } of batches) {
          const requested = new Set(refs);
          const returned = new Set<QueryEntityRef>();
          for (const entity of entities) {
            if (entity.owner !== owner || !requested.has(entity.ref))
              throw new TypeError("结果列返回了未请求的实体");
            if (returned.has(entity.ref))
              throw new TypeError(`结果列返回了重复实体：${entity.ref}`);
            returned.add(entity.ref);
            const previous = hydratedEntities.get(entity.ref);
            hydratedEntities.set(entity.ref, {
              ...entity,
              fields: { ...previous?.fields, ...entity.fields },
            });
          }
          const missing = refs.find((ref) => !returned.has(ref));
          if (missing)
            throw new TypeError(`当前数据版本缺少结果实体：${missing}`);
          for (const entity of entities)
            for (const field of fields)
              if (!Object.hasOwn(entity.fields, field))
                throw new TypeError(`结果实体缺少显示列：${entity.ref}.${field}`);
        }
      };
      let render: (focusMore?: boolean) => Promise<void>;
      const showMore = async (): Promise<void> => {
        if (loadingMore) return;
        if (shown < result.rows.length) {
          shown = Math.min(shown + 50, result.rows.length);
          await render(true);
          return;
        }
        if (!result.hasMore) return;
        loadingMore = true;
        if (this.controller?.signal === signal) this.setRunning(true);
        try {
          const next = await this.dependencies.execute(section, {
            offset: result.rows.length,
            pageSize: fetchSize,
            signal,
          });
          result = appendQueryResultPage(result, next);
          shown = Math.min(shown + 50, result.rows.length);
          await render(true);
        } catch (error) {
          this.showError(error);
        } finally {
          loadingMore = false;
          if (this.controller?.signal === signal) this.setRunning(false);
        }
      };
      const changeColumns = (columns: readonly string[]): void => {
        const serial = ++columnChangeSerial;
        selectedColumns = normalizeResultColumnSelection(entityScope, columns);
        card.setAttribute("aria-busy", "true");
        void render()
          .catch((error) => {
            if (!signal.aborted && serial === columnChangeSerial)
              this.showError(error);
          })
          .finally(() => {
            if (serial === columnChangeSerial)
              card.removeAttribute("aria-busy");
          });
      };
      render = async (focusMore = false): Promise<void> => {
        const serial = ++renderSerial;
        const selection = [...selectedColumns];
        await hydrateColumns(selection);
        if (signal.aborted || serial !== renderSerial) return;
        const selectionKey = selection.join("\u0000");
        if (presentedSource !== result || presentedColumns !== selectionKey) {
          presentedResult = hydrateQueryResultColumns(
            result,
            selection,
            [...hydratedEntities.values()],
          );
          presentedSource = result;
          presentedColumns = selectionKey;
        }
        const visible = revealQueryResult(presentedResult ?? result, shown);
        if (publishedRows !== result.rows.length) {
          const highlightRefs = queryResultEntityRefs(result);
          publishedRows = result.rows.length;
          onResult(highlightRefs, sectionHighlights);
        }
        if (answerView) answerView.update(visible, selection);
        else {
          answerView = renderAnswer(card, section.answer, visible, {
            onEntity: (ref) => {
              void Promise.resolve(this.dependencies.onEntity(ref))
                .catch((error) => this.showError(error));
            },
            onMore: visible.hasMore ? () => void showMore() : undefined,
            ...(entityScope.length && this.dependencies.projectResultEntities
              ? { onColumnsChange: changeColumns }
              : {}),
            mappings,
          });
        }
        if (focusMore)
          card.querySelector<HTMLElement>(".query-more")?.focus();
      };
      card.classList.remove("loading");
      await render();
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      card.className = "query-answer-card query-answer-error";
      card.textContent = error instanceof Error ? error.message : "查询执行失败";
      return false;
    }
  }

  private showError(error: unknown): void {
    this.setStatus(error instanceof Error ? error.message : "查询无效");
  }

  private cancelCurrent(): void {
    if (!this.controller) return;
    this.abortCurrent(new DOMException("用户停止查询", "AbortError"));
    this.setStatus("已停止");
  }

  private abortCurrent(reason: DOMException): void {
    const controller = this.controller;
    this.controller = null;
    controller?.abort(reason);
    this.answers.setAttribute("aria-busy", "false");
    this.setRunning(false);
  }

  private setRunning(running: boolean): void {
    this.running = running;
    this.syncWorkspaceVisibility();
    this.updateRunState();
  }

  private updateRunState(): void {
    this.bar.setExecutionState({
      running: this.running,
      runnable: this.runnable,
    });
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }

  private publishResultEntities(): void {
    const serial = ++this.highlightSerial;
    const refs = mergeQueryResultRefs(this.resultRefsBySection);
    const highlights = [...this.resultHighlightsBySection.values()];
    const publish = this.dependencies.onResultHighlights
      ? () => this.dependencies.onResultHighlights?.(highlights) ?? 0
      : this.dependencies.onResultEntities
        ? () => this.dependencies.onResultEntities?.(refs) ?? 0
        : null;
    if (!publish) {
      this.highlightCount = 0;
      this.renderHighlightStatus();
      return;
    }
    void Promise.resolve().then(publish).then((count) => {
      if (serial !== this.highlightSerial) return;
      this.highlightCount = count;
      this.renderHighlightStatus();
    }).catch((error) => {
      if (serial === this.highlightSerial) this.showError(error);
    });
  }

  private renderHighlightStatus(): void {
    this.highlightStatus.textContent = queryHighlightStatus(
      this.highlightCount,
      this.resultsCurrent,
    );
  }
}
