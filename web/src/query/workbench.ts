import { canonicalJson } from "./canonical";
import { normalizeBundle, type QueryBundle, type QuerySection } from "./bundle";
import {
  compileQueryDraft,
  defaultQueryDraft,
  draftOwner,
  draftQuery,
  queryDraftFromBundle,
  type EntityRef,
  type QueryDraft,
} from "./draft";
import type { QueryResult, RuntimeValue } from "./engine";
import { renderAnswer } from "./answer-view";
import {
  QueryBar,
  type EntitySuggestion,
  type NameSuggestion,
  type SelectedQueryEntity,
} from "./query-bar";
import {
  appendQueryResultPage,
  commitRenderedResults,
  revealQueryResult,
} from "./result-buffer";
import { QUERY_SECURITY_PROFILE } from "./security";
import { isMissing } from "./value";
import { INTERNAL_FIELDS, queryFieldsFor } from "./workbench-model";
import type { FieldCapability, Owner } from "./contract";
import { notify, state } from "../store";
import type { Mappings } from "../types";

export interface QueryWorkbenchDependencies {
  host?: HTMLElement;
  execute(
    section: QuerySection,
    options: { offset: number; pageSize: number; signal: AbortSignal },
  ): Promise<QueryResult>;
  selectedEntity?(): Promise<SelectedQueryEntity | null>;
  resolveEntityLabel?(ref: string): Promise<string>;
  suggestEntities?(
    text: string,
    owners: readonly Owner[],
    signal: AbortSignal,
  ): Promise<EntitySuggestion[]>;
  suggestNames?(
    text: string,
    owners: readonly Owner[],
    signal: AbortSignal,
  ): Promise<NameSuggestion[]>;
  onNameSuggestion?(suggestion: NameSuggestion): void | Promise<void>;
  releaseId(): string;
  onEntity(ref: string): void | Promise<void>;
  mappings?(): Promise<Mappings>;
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

function enoughText(draft: QueryDraft): boolean {
  const text = draft.kind === "list" && !draft.query
    ? draft.allText.trim()
    : draftQuery(draft)?.text?.value.trim();
  return !text || [...text].length >= 2;
}

/** Plain name location stays on the canvas; every exact/structured answer uses the workspace. */
export function queryNeedsWorkspace(draft: QueryDraft): boolean {
  if (draft.kind !== "list" || !draft.query) return true;
  const query = draft.query;
  return query.text?.capability === "fullText" || Boolean(
    query.condition || query.relations?.length || query.columns?.length ||
    query.orderBy?.length || query.limit !== undefined,
  );
}

export class QueryWorkbench {
  private readonly panel = document.createElement("main");
  private readonly workspace = document.createElement("section");
  private readonly status = document.createElement("div");
  private readonly answers = document.createElement("div");
  private readonly stopButton = action("停止", "query-stop");
  private readonly reopenButton = action("↗", "query-reopen");
  private readonly bar: QueryBar;
  private controller: AbortController | null = null;
  private running = false;
  private runnable = true;
  private expanded = false;
  private hasAnswer = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBundle = "";
  private editableBundle = true;

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
    this.reopenButton.setAttribute("aria-label", "重新打开查询答案");
    this.reopenButton.setAttribute("aria-controls", "query-workspace");
    compose.append(barHost, this.reopenButton);

    this.workspace.id = "query-workspace";
    this.workspace.className = "query-workspace";
    this.workspace.hidden = true;
    this.workspace.setAttribute("aria-label", "查询答案");
    const toolbar = document.createElement("header");
    const reset = action("清空", "query-reset");
    const collapse = action("×", "query-collapse");
    collapse.setAttribute("aria-label", "收起查询答案");
    this.stopButton.hidden = true;
    this.stopButton.setAttribute("aria-label", "停止当前查询");
    this.status.className = "query-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    toolbar.append(this.status, this.stopButton, reset, collapse);

    this.answers.className = "query-answers";
    this.answers.setAttribute("aria-label", "查询答案内容");
    this.workspace.append(toolbar, this.answers);
    this.panel.append(compose, this.workspace);
    (dependencies.host ?? document.body).append(this.panel);

    this.bar = new QueryBar({
      draft: defaultQueryDraft(),
      onChange: (draft) => this.draftChanged(draft),
      onSubmit: () => this.runCurrent(),
      reportError: (error) => this.showError(error),
      selectedEntity: dependencies.selectedEntity,
      resolveEntityLabel: dependencies.resolveEntityLabel,
      suggestEntities: dependencies.suggestEntities,
      suggestNames: dependencies.suggestNames,
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
    this.stopButton.addEventListener("click", () => this.cancelCurrent());
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

  askRelationship(
    kind: "common" | "path",
    from: EntityRef,
    to: EntityRef,
  ): void {
    const draft: QueryDraft = kind === "path"
      ? { kind: "path", from, to, maxHops: 6, maxPaths: 10 }
      : { kind: "comparison", from, to };
    this.editableBundle = true;
    this.bar.replace(draft);
    this.expand();
    this.runCurrent();
  }

  sync(bundle: QueryBundle | null): void {
    if (!bundle) {
      if (!this.lastBundle) return;
      this.abortCurrent(new DOMException("query navigation", "AbortError"));
      this.lastBundle = "";
      this.editableBundle = true;
      this.hasAnswer = false;
      this.answers.replaceChildren();
      this.setStatus("");
      this.bar.replace(defaultQueryDraft());
      this.collapse(false);
      return;
    }
    const normalized = normalizeBundle(bundle);
    const key = canonicalJson(normalized);
    if (key === this.lastBundle) return;
    const draft = queryDraftFromBundle(normalized);
    this.editableBundle = draft !== null;
    if (draft) this.bar.replace(draft);
    this.expand();
    void this.runBundle(normalized, false).then(() => {
      if (!draft) this.setStatus("此旧查询只能查看结果");
    }).catch((error) => this.showError(error));
  }

  private expand(focus = true): void {
    this.expanded = true;
    this.panel.classList.add("expanded");
    this.workspace.hidden = false;
    this.reopenButton.hidden = true;
    if (focus) this.bar.focus();
  }

  private collapse(focus = true): void {
    if (this.running)
      this.abortCurrent(new DOMException("query workspace collapsed", "AbortError"));
    this.expanded = false;
    this.panel.classList.remove("expanded");
    this.workspace.hidden = true;
    this.reopenButton.hidden = !this.hasAnswer;
    if (focus) this.bar.focus();
  }

  private newQuery(): void {
    this.abortCurrent(new DOMException("new query", "AbortError"));
    this.lastBundle = "";
    this.editableBundle = true;
    this.hasAnswer = false;
    state.queryBundle = null;
    notify();
    if (this.dependencies.pushUrl) this.dependencies.pushUrl();
    else this.dependencies.updateUrl();
    this.answers.replaceChildren();
    this.setStatus("");
    this.bar.replace(defaultQueryDraft());
    this.collapse();
  }

  private draftChanged(draft: QueryDraft): void {
    this.editableBundle = true;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.abortCurrent(new DOMException("query changed", "AbortError"));
    this.setStatus("");
    if (!enoughText(draft)) {
      this.runnable = false;
      this.setStatus("名称至少需要两个字才能查看完整结果");
      return;
    }
    try {
      compileQueryDraft(draft);
      this.runnable = true;
      if (queryNeedsWorkspace(draft)) this.expand(false);
      if (!this.expanded) return;
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        this.runCurrent(false);
      }, 220);
    } catch (error) {
      this.runnable = false;
      this.showError(error);
    }
  }

  private runCurrent(focus = true): void {
    if (!this.runnable) return;
    try {
      this.expand(focus);
      const bundle = compileQueryDraft(this.bar.current());
      void this.runBundle(bundle, true).catch((error) => this.showError(error));
    } catch (error) {
      this.showError(error);
    }
  }

  private async runBundle(bundle: QueryBundle, persist: boolean): Promise<void> {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const normalized = normalizeBundle(bundle);
    this.abortCurrent(new DOMException("superseded query", "AbortError"));
    const controller = new AbortController();
    this.controller = controller;
    this.setRunning(true);
    this.lastBundle = canonicalJson(normalized);
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
    const cards = Object.entries(normalized.sections).map(([name, section]) => {
      const card = document.createElement("section");
      card.className = "query-answer-card loading";
      card.dataset.section = name;
      card.textContent = `${section.answer.title}：加载中…`;
      return { card, section };
    });
    this.answers.setAttribute("aria-busy", "true");
    this.setStatus("正在查询");
    try {
      const results = await commitRenderedResults(
        controller.signal,
        cards.map(({ card, section }) =>
          this.loadSection(card, section, currentRelease, controller.signal)
        ),
        () => {
          this.answers.replaceChildren(...cards.map(({ card }) => card));
          this.answers.setAttribute("aria-busy", "false");
          this.hasAnswer = true;
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
  ): Promise<boolean> {
    try {
      const fetchSize = Math.min(
        section.query.limit ?? QUERY_SECURITY_PROFILE.execution.maxPageSize,
        QUERY_SECURITY_PROFILE.execution.maxPageSize,
      );
      const [initial, mappings] = await Promise.all([
        this.dependencies.execute(section, {
          offset: 0,
          pageSize: fetchSize,
          signal,
        }),
        this.dependencies.mappings?.(),
      ]);
      let result = initial;
      if (result.releaseId !== releaseId)
        throw new TypeError("查询结果来自不同的数据版本，请刷新页面后重试");
      let shown = Math.min(50, result.rows.length);
      let loadingMore = false;
      const showMore = async (): Promise<void> => {
        if (loadingMore) return;
        if (shown < result.rows.length) {
          shown = Math.min(shown + 50, result.rows.length);
          render(true);
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
          render(true);
        } catch (error) {
          this.showError(error);
        } finally {
          loadingMore = false;
          if (this.controller?.signal === signal) this.setRunning(false);
        }
      };
      const render = (focusMore = false): void => {
        const visible = revealQueryResult(result, shown);
        renderAnswer(card, section.answer, visible, {
          onEntity: (ref) => {
            void Promise.resolve(this.dependencies.onEntity(ref))
              .catch((error) => this.showError(error));
          },
          onMore: visible.hasMore ? () => void showMore() : undefined,
          onSort: this.editableBundle
            ? (semantic, direction) => this.sortResult(semantic, direction)
            : undefined,
          onGroup: this.editableBundle
            ? (semantic) => this.groupResult(semantic)
            : undefined,
          onFilter: this.editableBundle
            ? (semantic, value, exclude) => this.filterResult(semantic, value, exclude)
            : undefined,
          canSort: (semantic) => this.resultField(semantic, "sort") !== null,
          canGroup: (semantic) => this.resultField(semantic, "group") !== null,
          canFilter: (semantic) => this.resultField(semantic, "filter") !== null,
          mappings,
        });
        if (focusMore)
          card.querySelector<HTMLElement>(".query-more")?.focus();
      };
      card.classList.remove("loading");
      render();
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
    this.stopButton.hidden = !running;
  }

  private resultField(
    semantic: string,
    capability: FieldCapability,
  ): { owner: Owner; field: string } | null {
    const split = semantic.indexOf(".");
    const owner = semantic.slice(0, split) as Owner;
    const field = semantic.slice(split + 1);
    const query = draftQuery(this.bar.current());
    const currentOwner = draftOwner(this.bar.current());
    if (
      split <= 0 || !query || currentOwner !== owner || INTERNAL_FIELDS.has(field) ||
      !queryFieldsFor(owner, capability).includes(field)
    ) return null;
    return { owner, field };
  }

  private filterResult(
    semantic: string,
    value: RuntimeValue,
    exclude: boolean,
  ): void {
    const target = this.resultField(semantic, "filter");
    if (!target) return;
    const condition = isMissing(value)
      ? { kind: "isMissing" as const, field: target.field, ...(exclude ? { negated: true } : {}) }
      : value === null
        ? { kind: "isNull" as const, field: target.field, ...(exclude ? { negated: true } : {}) }
        : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? {
              kind: "compare" as const,
              field: target.field,
              operator: exclude ? "ne" as const : "eq" as const,
              value,
            }
          : null;
    if (condition) {
      this.bar.dispatch({ type: "addCondition", condition, owner: target.owner });
      this.bar.focus();
    }
  }

  private sortResult(semantic: string, direction: "asc" | "desc"): void {
    const target = this.resultField(semantic, "sort");
    if (!target) return;
    this.bar.dispatch({
      type: "setOrder",
      owner: target.owner,
      orderBy: [{
        column: target.field,
        direction,
        nulls: direction === "asc" ? "first" : "last",
      }],
    });
    this.bar.focus();
  }

  private groupResult(semantic: string): void {
    const target = this.resultField(semantic, "group");
    if (!target) return;
    const draft = this.bar.current();
    const aggregate = draft.kind === "aggregate"
      ? {
          ...draft.query.aggregate,
          groupBy: draft.query.aggregate.groupBy.includes(target.field)
            ? draft.query.aggregate.groupBy
            : [...draft.query.aggregate.groupBy, target.field],
        }
      : { groupBy: [target.field], metrics: [{ function: "count" as const }] };
    this.bar.dispatch({ type: "setAggregate", aggregate, owner: target.owner });
    this.bar.focus();
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }
}
