import { canonicalJson } from "./canonical";
import { normalizeBundle, type QueryBundle, type QuerySection } from "./bundle";
import {
  createQueryBundleDocument,
  createQueryEditorDocument,
  createQueryRecipeDocument,
  type LoweredQueryEditorDocument,
} from "./editor";
import {
  QueryDocumentEditor,
  type SelectedQueryEntity,
} from "./editor-view";
import { compileExplorerQuery, decompileExplorerQuery } from "./explorer";
import type { QueryResult, RuntimeValue } from "./engine";
import { renderAnswer } from "./answer-view";
import {
  comparisonRecipe,
  decompileQueryRecipe,
  fullTextRecipe,
  pathRecipe,
} from "./recipes";
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
  execute(
    section: QuerySection,
    options: { offset: number; pageSize: number; signal: AbortSignal },
  ): Promise<QueryResult>;
  selectedEntity?(): Promise<SelectedQueryEntity | null>;
  resolveEntityLabel?(ref: string): Promise<string>;
  releaseId(): string;
  onEntity(ref: string): void;
  mappings?(): Promise<Mappings>;
  onBundle?(bundle: QueryBundle): void;
  updateUrl(): void;
  pushUrl?(): void;
}

type AddableClause = "search" | "condition" | "condition_group" | "relation" |
  "projection" | "aggregate" | "sort" | "limit";
type AddAction = AddableClause | "common" | "path";

const ADD_ACTIONS: Array<[AddAction, string]> = [
  ["search", "搜索文字"],
  ["condition", "筛选条件"],
  ["condition_group", "条件组"],
  ["relation", "关联实体"],
  ["aggregate", "统计"],
  ["common", "比较关联"],
  ["path", "关系路径"],
  ["projection", "返回信息"],
  ["sort", "排序"],
  ["limit", "结果条数"],
];

function action(label: string, className = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

export class QueryWorkbench {
  private readonly openButton = action("详细查询");
  private readonly panel = document.createElement("aside");
  private readonly status = document.createElement("div");
  private readonly answers = document.createElement("div");
  private readonly runButton = action("查询", "query-run");
  private readonly editor: QueryDocumentEditor;
  private controller: AbortController | null = null;
  private running = false;
  private runnable = true;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: LoweredQueryEditorDocument | null = null;
  private lastBundle = "";
  private ready = false;
  private pushNextUrl = false;

  constructor(private readonly dependencies: QueryWorkbenchDependencies) {
    this.openButton.id = "query-open";
    this.openButton.setAttribute("aria-controls", "query-workbench");
    this.openButton.setAttribute("aria-expanded", "false");

    this.panel.id = "query-workbench";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "详细查询");

    const header = document.createElement("header");
    const mark = document.createElement("span");
    mark.className = "query-mascot";
    mark.textContent = "✦";
    mark.setAttribute("aria-hidden", "true");
    const heading = document.createElement("h2");
    heading.textContent = "详细查询";
    const reset = action("新查询", "query-reset");
    const close = action("×", "query-close");
    close.setAttribute("aria-label", "关闭详细查询");
    header.append(mark, heading, reset, close);

    const compose = document.createElement("section");
    compose.className = "query-compose";
    compose.setAttribute("aria-label", "查询内容");
    const editorHost = document.createElement("div");
    editorHost.className = "query-editor-host";

    const controls = document.createElement("div");
    controls.className = "query-compose-actions";
    const add = document.createElement("details");
    add.className = "query-add-menu";
    const addSummary = document.createElement("summary");
    addSummary.textContent = "＋ 添加";
    const addList = document.createElement("div");
    for (const [name, label] of ADD_ACTIONS) {
      const button = action(label);
      button.dataset.clause = name;
      addList.append(button);
    }
    add.append(addSummary, addList);
    controls.append(add, this.runButton);
    compose.append(editorHost, controls);

    this.status.className = "query-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.answers.className = "query-answers";
    this.answers.setAttribute("aria-live", "polite");
    this.panel.append(header, compose, this.status, this.answers);

    document.querySelector("#searchwrap-dock")?.append(this.openButton);
    document.body.append(this.panel);

    this.editor = new QueryDocumentEditor(editorHost, {
      doc: createQueryEditorDocument({ owner: "subject" }),
      onChange: (result) => this.editorChanged(result),
      selectedEntity: dependencies.selectedEntity,
      resolveEntityLabel: dependencies.resolveEntityLabel,
      mappings: dependencies.mappings,
      reportError: (error) => this.showError(error),
    });
    this.ready = true;

    this.openButton.addEventListener("click", () =>
      this.panel.hidden ? this.open() : this.close()
    );
    close.addEventListener("click", () => this.close());
    reset.addEventListener("click", () => this.newQuery());
    this.runButton.addEventListener("click", () =>
      this.running ? this.cancelCurrent() : this.runCurrent()
    );
    addList.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement)
        .closest<HTMLButtonElement>("[data-clause]");
      if (!button) return;
      const name = button.dataset.clause as AddAction;
      const inserted = name === "common" || name === "path"
        ? (() => {
            this.transitionEditor(createQueryRecipeDocument(
              name === "common"
                ? { kind: name, from: "", to: "" }
                : {
                    kind: name,
                    from: "",
                    to: "",
                    maxHops: 6,
                    maxPaths: 10,
                  },
            ));
            return true;
          })()
        : this.editor.insert(name);
      add.open = false;
      if (!inserted) this.setStatus("这项已经在查询中");
    });
    this.panel.addEventListener("keydown", (event) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape") {
        const opened = [...this.panel.querySelectorAll<HTMLDetailsElement>("details[open]")];
        const current = opened.at(-1);
        if (current) {
          current.open = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      const modified = event.metaKey || event.ctrlKey;
      if (modified && event.key.toLowerCase() === "z") {
        const changed = event.shiftKey ? this.editor.redo() : this.editor.undo();
        if (changed) event.preventDefault();
        return;
      }
      if (modified && event.key.toLowerCase() === "y") {
        if (this.editor.redo()) event.preventDefault();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.runCurrent();
        return;
      }
      if (
        event.key === "/" && !modified && !event.altKey &&
        event.target instanceof HTMLElement &&
        event.target.closest(".query-document") &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLSelectElement) &&
        !(event.target instanceof HTMLButtonElement)
      ) {
        event.preventDefault();
        add.open = true;
        addList.querySelector<HTMLButtonElement>("button")?.focus();
        return;
      }
      if (
        event.key === "Enter" && !modified && !event.altKey &&
        event.target instanceof HTMLInputElement
      ) {
        event.preventDefault();
        event.target.blur();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (!event.isComposing && event.key === "Escape" && !this.panel.hidden) {
        event.stopImmediatePropagation();
        this.close();
      }
    });
  }

  askFullText(text: string): void {
    const recipe = { kind: "fullText" as const, text: text.trim() };
    this.transitionEditor(createQueryRecipeDocument(recipe));
    this.open();
    this.runCurrent();
  }

  askRelationship(
    kind: "common" | "path",
    from: `${"subject" | "person" | "character" | "episode"}:${number}`,
    to: `${"subject" | "person" | "character" | "episode"}:${number}`,
  ): void {
    this.transitionEditor(createQueryRecipeDocument(
      kind === "path"
        ? { kind, from, to, maxHops: 6, maxPaths: 10 }
        : { kind, from, to },
    ));
    this.open();
    this.runCurrent();
  }

  sync(bundle: QueryBundle | null): void {
    if (!bundle) {
      if (!this.lastBundle) return;
      this.abortCurrent(new DOMException("query navigation", "AbortError"));
      this.lastBundle = "";
      this.pushNextUrl = false;
      this.answers.replaceChildren();
      this.setStatus("");
      this.replaceEditor(createQueryEditorDocument({ owner: "subject" }));
      this.close();
      return;
    }
    const normalized = normalizeBundle(bundle);
    const key = canonicalJson(normalized);
    if (key === this.lastBundle) return;
    this.pushNextUrl = false;
    const draft = decompileExplorerQuery(normalized);
    const recipe = draft ? null : decompileQueryRecipe(normalized);
    this.replaceEditor(
      draft
        ? createQueryEditorDocument(draft)
        : recipe
          ? createQueryRecipeDocument(recipe)
        : createQueryBundleDocument(normalized),
    );
    this.open();
    void this.runBundle(normalized, false).catch((error) => this.showError(error));
  }

  private open(): void {
    this.panel.hidden = false;
    this.openButton.setAttribute("aria-expanded", "true");
    this.editor.focus();
    if (!this.lastBundle && this.pending?.diagnostics.length === 0)
      this.runCurrent();
  }

  private close(): void {
    this.panel.hidden = true;
    this.openButton.setAttribute("aria-expanded", "false");
    this.openButton.focus();
  }

  private newQuery(): void {
    this.abortCurrent(new DOMException("new query", "AbortError"));
    this.lastBundle = "";
    this.pushNextUrl = false;
    state.queryBundle = null;
    notify();
    if (this.dependencies.pushUrl) this.dependencies.pushUrl();
    else this.dependencies.updateUrl();
    this.answers.replaceChildren();
    this.setStatus("");
    this.replaceEditor(createQueryEditorDocument({ owner: "subject" }));
    this.editor.focus();
  }

  private replaceEditor(doc: Parameters<QueryDocumentEditor["replace"]>[0]): void {
    this.ready = false;
    this.editor.replace(doc);
    this.ready = true;
  }

  private transitionEditor(doc: Parameters<QueryDocumentEditor["replace"]>[0]): void {
    this.pushNextUrl = true;
    this.editor.replaceTransaction(doc);
  }

  private editorChanged(result: LoweredQueryEditorDocument): void {
    this.pending = result;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (result.diagnostics.length) {
      this.runnable = false;
      this.abortCurrent(new DOMException("incomplete query", "AbortError"));
      this.setStatus("");
      return;
    }
    this.runnable = true;
    this.updateRunButton();
    this.setStatus("");
    if (!this.ready || this.panel.hidden) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.runCurrent();
    }, 260);
  }

  private runCurrent(): void {
    const current = this.pending;
    if (!current || current.diagnostics.length) return;
    try {
      const bundle = current.bundle
        ? current.bundle
        : current.recipe?.kind === "fullText"
          ? fullTextRecipe(current.recipe.text)
          : current.recipe?.kind === "common"
            ? comparisonRecipe(
                current.recipe.from as `${"subject" | "person" | "character" | "episode"}:${number}`,
                current.recipe.to as `${"subject" | "person" | "character" | "episode"}:${number}`,
              )
            : current.recipe?.kind === "path"
              ? pathRecipe(
                  current.recipe.from as `${"subject" | "person" | "character" | "episode"}:${number}`,
                  current.recipe.to as `${"subject" | "person" | "character" | "episode"}:${number}`,
                  {
                    maxHops: current.recipe.maxHops,
                    maxPaths: current.recipe.maxPaths,
                  },
                )
              : current.draft
                ? compileExplorerQuery(current.draft)
                : null;
      if (!bundle) throw new TypeError("当前查询不完整");
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
      if (this.pushNextUrl) {
        this.pushNextUrl = false;
        if (this.dependencies.pushUrl) this.dependencies.pushUrl();
        else this.dependencies.updateUrl();
      } else this.dependencies.updateUrl();
    }
    const cards = Object.entries(normalized.sections).map(([name, section]) => {
      const card = document.createElement("section");
      card.className = "query-answer-card loading";
      card.dataset.section = name;
      card.textContent = `${section.answer.title}：加载中…`;
      return { card, section };
    });
    this.answers.setAttribute("aria-busy", "true");
    this.setStatus("查询中…");
    try {
      const results = await commitRenderedResults(
        controller.signal,
        cards.map(({ card, section }) =>
          this.loadSection(card, section, currentRelease, controller.signal)
        ),
        () => {
          this.answers.replaceChildren(...cards.map(({ card }) => card));
          this.answers.setAttribute("aria-busy", "false");
        },
      );
      if (results) {
        const failed = results.filter((ok) => !ok).length;
        this.setStatus(failed ? `${failed} 组结果加载失败` : "");
      }
    } finally {
      if (this.controller === controller) this.setRunning(false);
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
          render();
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
          render();
        } catch (error) {
          this.showError(error);
        } finally {
          loadingMore = false;
          if (this.controller?.signal === signal) this.setRunning(false);
        }
      };
      const render = (): void => {
        const visible = revealQueryResult(result, shown);
        renderAnswer(card, section.answer, visible, {
          onEntity: (ref) => this.dependencies.onEntity(ref),
          onMore: visible.hasMore ? () => void showMore() : undefined,
          onSort: (semantic, direction) => this.sortResult(semantic, direction),
          onGroup: (semantic) => this.groupResult(semantic),
          onFilter: (semantic, value, exclude) =>
            this.filterResult(semantic, value, exclude),
          canSort: (semantic) => this.resultField(semantic, "sort") !== null,
          canGroup: (semantic) => this.resultField(semantic, "group") !== null,
          canFilter: (semantic) => this.resultField(semantic, "filter") !== null,
          mappings,
        });
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
    this.abortCurrent(new DOMException("用户取消查询", "AbortError"));
    this.setStatus("已取消");
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
    this.updateRunButton();
  }

  private updateRunButton(): void {
    this.runButton.textContent = this.running ? "取消" : "查询";
    this.runButton.disabled = !this.running && !this.runnable;
  }

  private resultField(
    semantic: string,
    capability: FieldCapability,
  ): { owner: Owner; field: string } | null {
    const split = semantic.indexOf(".");
    const owner = semantic.slice(0, split) as Owner;
    const field = semantic.slice(split + 1);
    const draft = this.pending?.draft;
    if (
      split <= 0 || !draft || draft.owner !== owner ||
      INTERNAL_FIELDS.has(field) ||
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
    let operator: string;
    let raw = "";
    if (isMissing(value)) operator = exclude ? "isPresent" : "isMissing";
    else if (value === null) operator = exclude ? "isNotNull" : "isNull";
    else if (
      typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    ) {
      operator = exclude ? "ne" : "eq";
      raw = String(value);
    } else return;
    if (!this.editor.addFilter(target.field, operator, raw))
      this.setStatus("当前字段不能使用这个筛选");
  }

  private sortResult(semantic: string, direction: "asc" | "desc"): void {
    const target = this.resultField(semantic, "sort");
    if (target && !this.editor.setSort(target.field, direction))
      this.setStatus("当前结果不能按此列排序");
  }

  private groupResult(semantic: string): void {
    const target = this.resultField(semantic, "group");
    if (target && !this.editor.addGroup(target.field))
      this.setStatus("当前结果不能按此列分组");
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }
}
