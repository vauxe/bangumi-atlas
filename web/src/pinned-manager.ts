import { html, raw } from "./html";
import {
  clearPinnedSelections,
  removePinnedSelection,
  state,
} from "./store";

export interface PinnedManagerItem {
  rank: number;
  name: string;
  type: string;
  current: boolean;
}

export interface PinnedManagerDeps {
  nameOf(rank: number): string | null;
  typeOf(rank: number): string;
  loadNames(ranks: number[]): Promise<void>;
  focus(rank: number): void;
  restoreFocus(): void;
  reportError(context: string, error: unknown): void;
}

export function pinnedManagerMarkup(
  items: readonly PinnedManagerItem[],
  expanded: boolean,
): string {
  const rows = items.map((item) => html`<li class="pinned-item">
    <button
      class="pinned-focus"
      type="button"
      data-pinned-action="focus"
      data-rank="${item.rank}"
      ${raw(item.current ? 'aria-current="true"' : "")}
    >
      <span class="pinned-name">${item.name}</span>
      <small>${item.type}${item.current ? " · 查看中" : ""}</small>
    </button>
    <button
      class="pinned-remove"
      type="button"
      data-pinned-action="remove"
      data-rank="${item.rank}"
      aria-label="取消保留 ${item.name}"
      title="取消保留"
    >×</button>
  </li>`).join("");
  return html`<button
    id="pinned-toggle"
    class="pinned-toggle"
    type="button"
    data-pinned-action="toggle"
    aria-expanded="${expanded}"
    aria-controls="pinned-panel"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5Z"></path>
      <path d="M12 13v8"></path>
    </svg>
    <span aria-live="polite">已保留 <strong>${items.length}</strong> 个</span>
  </button>
  <div id="pinned-panel" class="pinned-panel"${raw(expanded ? "" : " hidden")}>
    <header>
      <strong>保留的节点与关系</strong>
      <button
        type="button"
        class="pinned-clear"
        data-pinned-action="clear"
      >全部清除</button>
    </header>
    <ul aria-label="已保留节点及其关系">${raw(rows)}</ul>
  </div>`;
}

/** 管理会话内累积展开的根节点；Canvas 仍负责绘制节点和边。 */
export class PinnedManager {
  private root: HTMLElement;
  private deps: PinnedManagerDeps;
  private expanded = false;
  private loadingKey = "";
  private renderedMarkup = "";

  constructor(root: HTMLElement, deps: PinnedManagerDeps) {
    this.root = root;
    this.deps = deps;
    root.addEventListener("click", (event) => {
      const target = event.target as { closest?: (selector: string) => {
        getAttribute(name: string): string | null;
      } | null };
      const control = target.closest?.("[data-pinned-action]");
      const action = control?.getAttribute("data-pinned-action");
      if (!action) return;
      if (action === "toggle") {
        this.expanded = !this.expanded;
        this.sync();
        this.root.querySelector<HTMLButtonElement>("#pinned-toggle")?.focus();
        return;
      }
      if (action === "clear") {
        clearPinnedSelections();
        this.expanded = false;
        this.sync();
        this.deps.restoreFocus();
        return;
      }
      const rank = Number(control?.getAttribute("data-rank"));
      if (!Number.isInteger(rank) || !state.pinnedSelections.has(rank)) return;
      if (action === "focus") {
        this.expanded = false;
        this.sync();
        this.deps.focus(rank);
        return;
      }
      if (action !== "remove") return;
      const before = [...state.pinnedSelections];
      const index = before.indexOf(rank);
      removePinnedSelection(rank);
      this.sync();
      const next = before.slice(index + 1).find((candidate) =>
        state.pinnedSelections.has(candidate)
      ) ?? before.slice(0, index).reverse().find((candidate) =>
        state.pinnedSelections.has(candidate)
      );
      if (next === undefined) this.deps.restoreFocus();
      else
        this.root.querySelector<HTMLButtonElement>(
          `[data-pinned-action="remove"][data-rank="${next}"]`,
        )?.focus();
    });
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.expanded) return;
      event.preventDefault();
      event.stopPropagation();
      this.expanded = false;
      this.sync();
      this.root.querySelector<HTMLButtonElement>("#pinned-toggle")?.focus();
    });
  }

  /** 仅在语义内容变化时替换 DOM；必须替换时恢复列表内的键盘焦点。 */
  private render(markup: string): void {
    if (markup === this.renderedMarkup) return;
    const focused = this.root.querySelector<HTMLElement>(
      "[data-pinned-action]:focus",
    );
    const action = focused?.getAttribute("data-pinned-action") ?? null;
    const rank = focused?.getAttribute("data-rank") ?? null;
    this.root.innerHTML = markup;
    this.renderedMarkup = markup;
    if (!action || !/^(toggle|clear|focus|remove)$/.test(action)) return;
    const rankSelector = rank !== null && /^\d+$/.test(rank)
      ? `[data-rank="${rank}"]`
      : "";
    this.root.querySelector<HTMLButtonElement>(
      `[data-pinned-action="${action}"]${rankSelector}`,
    )?.focus();
  }

  sync(): void {
    const ranks = [...state.pinnedSelections];
    if (!ranks.length) {
      this.expanded = false;
      this.root.hidden = true;
      this.render("");
      return;
    }
    const missing: number[] = [];
    const items = ranks.map((rank): PinnedManagerItem => {
      const name = this.deps.nameOf(rank);
      if (name === null) missing.push(rank);
      return {
        rank,
        name: name ?? `节点 #${rank}`,
        type: this.deps.typeOf(rank),
        current: state.selection === rank,
      };
    });
    this.root.hidden = false;
    this.render(pinnedManagerMarkup(items, this.expanded));
    const loadingKey = missing.join(",");
    if (!loadingKey || loadingKey === this.loadingKey) return;
    this.loadingKey = loadingKey;
    void this.deps.loadNames(missing).then(
      () => {
        if (this.loadingKey === loadingKey) this.loadingKey = "";
        this.sync();
      },
      (error: unknown) => {
        if (this.loadingKey === loadingKey) this.loadingKey = "";
        this.deps.reportError("保留节点名称加载", error);
      },
    );
  }
}
