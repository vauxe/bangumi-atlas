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
import type { QueryResult } from "./engine";
import { renderAnswer } from "./answer-view";
import { comparisonRecipe, fullTextRecipe, pathRecipe } from "./recipes";
import {
  appendQueryResultPage,
  commitRenderedResults,
  revealQueryResult,
} from "./result-buffer";
import { QUERY_SECURITY_PROFILE } from "./security";
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
}

type AddableClause = "search" | "condition" | "condition_group" | "relation" |
  "projection" | "sort" | "limit";

const ADD_ACTIONS: Array<[AddableClause, string]> = [
  ["search", "搜索文字"],
  ["condition", "筛选条件"],
  ["condition_group", "条件组"],
  ["relation", "关联实体"],
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
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: LoweredQueryEditorDocument | null = null;
  private lastBundle = "";
  private ready = false;

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
      reportError: (error) => this.showError(error),
    });
    this.ready = true;

    this.openButton.addEventListener("click", () =>
      this.panel.hidden ? this.open() : this.close()
    );
    close.addEventListener("click", () => this.close());
    reset.addEventListener("click", () => this.newQuery());
    this.runButton.addEventListener("click", () => this.runCurrent());
    addList.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement)
        .closest<HTMLButtonElement>("[data-clause]");
      if (!button) return;
      const inserted = this.editor.insert(button.dataset.clause as AddableClause);
      add.open = false;
      if (!inserted) this.setStatus("这项已经在查询中");
    });
    this.panel.addEventListener("keydown", (event) => {
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
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.panel.hidden) {
        event.stopImmediatePropagation();
        this.close();
      }
    });
  }

  askFullText(text: string): void {
    const recipe = { kind: "fullText" as const, text: text.trim() };
    this.replaceEditor(createQueryRecipeDocument(recipe));
    this.open();
    this.runCurrent();
  }

  askRelationship(
    kind: "common" | "path",
    from: `${"subject" | "person" | "character" | "episode"}:${number}`,
    to: `${"subject" | "person" | "character" | "episode"}:${number}`,
  ): void {
    this.replaceEditor(createQueryRecipeDocument({ kind, from, to }));
    this.open();
    this.runCurrent();
  }

  sync(bundle: QueryBundle | null): void {
    if (!bundle) return;
    const normalized = normalizeBundle(bundle);
    const key = canonicalJson(normalized);
    if (key === this.lastBundle) return;
    const draft = decompileExplorerQuery(normalized);
    this.replaceEditor(
      draft
        ? createQueryEditorDocument(draft)
        : createQueryBundleDocument(normalized),
    );
    this.open();
    void this.runBundle(normalized, false);
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
    this.controller?.abort(new DOMException("new query", "AbortError"));
    this.lastBundle = "";
    state.queryBundle = null;
    notify();
    this.dependencies.updateUrl();
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

  private editorChanged(result: LoweredQueryEditorDocument): void {
    this.pending = result;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (result.diagnostics.length) {
      this.controller?.abort(new DOMException("incomplete query", "AbortError"));
      this.runButton.disabled = true;
      this.setStatus(result.diagnostics[0]?.message ?? "当前查询不完整");
      return;
    }
    this.runButton.disabled = false;
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
                )
              : current.draft
                ? compileExplorerQuery(current.draft)
                : null;
      if (!bundle) throw new TypeError("当前查询不完整");
      void this.runBundle(bundle, true);
    } catch (error) {
      this.showError(error);
    }
  }

  private async runBundle(bundle: QueryBundle, persist: boolean): Promise<void> {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const normalized = normalizeBundle(bundle);
    this.controller?.abort(new DOMException("superseded query", "AbortError"));
    const controller = new AbortController();
    this.controller = controller;
    this.lastBundle = canonicalJson(normalized);
    const currentRelease = this.dependencies.releaseId();
    if (
      normalized.release.policy === "fixed" &&
      normalized.release.version !== currentRelease
    ) {
      this.answers.setAttribute("aria-busy", "false");
      this.setStatus("此查询使用的数据版本不在当前站点中");
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
    this.setStatus("查询中…");
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
        }
      };
      const render = (): void => {
        const visible = revealQueryResult(result, shown);
        renderAnswer(card, section.answer, visible, {
          onEntity: (ref) => this.dependencies.onEntity(ref),
          onMore: visible.hasMore ? () => void showMore() : undefined,
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

  private setStatus(message: string): void {
    this.status.textContent = message;
  }
}
