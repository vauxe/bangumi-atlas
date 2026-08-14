import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PinnedManager,
  pinnedManagerMarkup,
} from "../src/pinned-manager";
import { state } from "../src/store";

class FakeRoot {
  hidden = true;
  private markup = "";
  focusedSelector = "";
  focusedAction: string | null = null;
  focusedRank: number | null = null;
  private clickListener: ((event: { target: object }) => void) | null = null;
  private keydownListener: ((event: {
    key: string;
    preventDefault(): void;
    stopPropagation(): void;
  }) => void) | null = null;

  get innerHTML(): string {
    return this.markup;
  }

  set innerHTML(value: string) {
    this.markup = value;
    this.focusedAction = null;
    this.focusedRank = null;
  }

  addEventListener(
    type: string,
    listener: ((event: { target: object }) => void) | ((event: {
      key: string;
      preventDefault(): void;
      stopPropagation(): void;
    }) => void),
  ): void {
    if (type === "click")
      this.clickListener = listener as (event: { target: object }) => void;
    if (type === "keydown")
      this.keydownListener = listener as (event: {
        key: string;
        preventDefault(): void;
        stopPropagation(): void;
      }) => void;
  }

  click(action: string, rank?: number): void {
    this.clickListener?.({
      target: {
        closest: (selector: string) =>
          selector === "[data-pinned-action]"
            ? {
                getAttribute: (name: string) =>
                  name === "data-pinned-action"
                    ? action
                    : name === "data-rank" && rank !== undefined
                      ? String(rank)
                      : null,
              }
            : null,
      },
    });
  }

  keydown(key: string): { prevented: boolean; stopped: boolean } {
    const result = { prevented: false, stopped: false };
    this.keydownListener?.({
      key,
      preventDefault: () => result.prevented = true,
      stopPropagation: () => result.stopped = true,
    });
    return result;
  }

  focusControl(action: string, rank: number | null = null): void {
    this.focusedAction = action;
    this.focusedRank = rank;
  }

  querySelector(selector: string): {
    focus(): void;
    getAttribute(name: string): string | null;
  } | null {
    if (selector === "[data-pinned-action]:focus") {
      if (this.focusedAction === null) return null;
      const action = this.focusedAction;
      const rank = this.focusedRank;
      return {
        focus: () => undefined,
        getAttribute: (name: string) =>
          name === "data-pinned-action"
            ? action
            : name === "data-rank" && rank !== null
              ? String(rank)
              : null,
      };
    }
    return {
      focus: () => {
        this.focusedSelector = selector;
        const action = selector.match(/data-pinned-action=\"([^\"]+)\"/)?.[1];
        const rank = selector.match(/data-rank=\"(\d+)\"/)?.[1];
        this.focusedAction = action ?? (selector === "#pinned-toggle" ? "toggle" : null);
        this.focusedRank = rank === undefined ? null : Number(rank);
      },
      getAttribute: () => null,
    };
  }
}

test("renders a visible, keyboard-operable retained-node collection", () => {
  const markup = pinnedManagerMarkup([
    { rank: 7, name: "<节点七>", type: "作品", current: false },
    { rank: 9, name: "节点九", type: "角色", current: true },
  ], true);

  assert.match(markup, /已保留\s*<strong[^>]*>2<\/strong>\s*个/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /id="pinned-panel"/);
  assert.doesNotMatch(markup, /id="pinned-panel"[^>]*hidden/);
  assert.match(markup, /&lt;节点七&gt;/);
  assert.match(markup, /作品/);
  assert.match(markup, /查看中/);
  assert.match(markup, /aria-current="true"/);
  assert.match(markup, /aria-label="取消保留 节点九"/);
  assert.match(markup, />全部清除</);
});

test("focuses, removes, and clears retained nodes from one manager", () => {
  const previousSelection = state.selection;
  const previousPinned = new Set(state.pinnedSelections);
  const previousWorkingSets = new Map(state.pinnedWorkingSets);
  const root = new FakeRoot();
  const focused: number[] = [];
  let restored = 0;
  try {
    state.selection = 9;
    state.pinnedSelections.clear();
    state.pinnedWorkingSets.clear();
    state.pinnedSelections.add(7);
    state.pinnedSelections.add(9);
    const manager = new PinnedManager(root as unknown as HTMLElement, {
      nameOf: (rank) => `节点 ${rank}`,
      typeOf: (rank) => rank === 7 ? "作品" : "角色",
      loadNames: async () => undefined,
      focus: (rank) => focused.push(rank),
      restoreFocus: () => restored++,
      reportError: () => undefined,
    });

    manager.sync();
    assert.equal(root.hidden, false);
    assert.match(root.innerHTML, /aria-expanded="false"/);

    root.click("toggle");
    assert.match(root.innerHTML, /aria-expanded="true"/);
    root.click("focus", 7);
    assert.deepEqual(focused, [7]);

    root.click("toggle");
    root.click("remove", 7);
    assert.deepEqual([...state.pinnedSelections], [9]);
    assert.match(root.focusedSelector, /data-rank="9"/);

    root.click("clear");
    assert.deepEqual([...state.pinnedSelections], []);
    assert.equal(root.hidden, true);
    assert.equal(restored, 1);
  } finally {
    state.selection = previousSelection;
    state.pinnedSelections.clear();
    for (const rank of previousPinned) state.pinnedSelections.add(rank);
    state.pinnedWorkingSets.clear();
    for (const [rank, workingSet] of previousWorkingSets)
      state.pinnedWorkingSets.set(rank, workingSet);
  }
});

test("loads missing retained-node names and replaces rank fallbacks", async () => {
  const previousPinned = new Set(state.pinnedSelections);
  const previousWorkingSets = new Map(state.pinnedWorkingSets);
  const root = new FakeRoot();
  let loaded = false;
  try {
    state.pinnedSelections.clear();
    state.pinnedWorkingSets.clear();
    state.pinnedSelections.add(12);
    const manager = new PinnedManager(root as unknown as HTMLElement, {
      nameOf: () => loaded ? "已加载名称" : null,
      typeOf: () => "人物",
      loadNames: async (ranks) => {
        assert.deepEqual(ranks, [12]);
        loaded = true;
      },
      focus: () => undefined,
      restoreFocus: () => undefined,
      reportError: () => undefined,
    });

    manager.sync();
    assert.match(root.innerHTML, /节点 #12/);
    await Promise.resolve();
    await Promise.resolve();
    assert.match(root.innerHTML, /已加载名称/);
  } finally {
    state.pinnedSelections.clear();
    for (const rank of previousPinned) state.pinnedSelections.add(rank);
    state.pinnedWorkingSets.clear();
    for (const [rank, workingSet] of previousWorkingSets)
      state.pinnedWorkingSets.set(rank, workingSet);
  }
});

test("preserves the focused retained-node action when an async name redraws the panel", async () => {
  const previousPinned = new Set(state.pinnedSelections);
  const previousWorkingSets = new Map(state.pinnedWorkingSets);
  const root = new FakeRoot();
  let loaded = false;
  let finishLoading = (): void => undefined;
  try {
    state.pinnedSelections.clear();
    state.pinnedWorkingSets.clear();
    state.pinnedSelections.add(12);
    const manager = new PinnedManager(root as unknown as HTMLElement, {
      nameOf: () => loaded ? "已加载名称" : null,
      typeOf: () => "人物",
      loadNames: () => new Promise<void>((resolve) => {
        finishLoading = () => {
          loaded = true;
          resolve();
        };
      }),
      focus: () => undefined,
      restoreFocus: () => undefined,
      reportError: () => undefined,
    });

    manager.sync();
    root.click("toggle");
    root.focusControl("remove", 12);
    finishLoading();
    await Promise.resolve();
    await Promise.resolve();

    assert.match(root.innerHTML, /已加载名称/);
    assert.equal(root.focusedAction, "remove");
    assert.equal(root.focusedRank, 12);
  } finally {
    state.pinnedSelections.clear();
    for (const rank of previousPinned) state.pinnedSelections.add(rank);
    state.pinnedWorkingSets.clear();
    for (const [rank, workingSet] of previousWorkingSets)
      state.pinnedWorkingSets.set(rank, workingSet);
  }
});

test("Escape closes the retained-node collection before the current view", () => {
  const previousPinned = new Set(state.pinnedSelections);
  const previousWorkingSets = new Map(state.pinnedWorkingSets);
  const root = new FakeRoot();
  try {
    state.pinnedSelections.clear();
    state.pinnedWorkingSets.clear();
    state.pinnedSelections.add(12);
    const manager = new PinnedManager(root as unknown as HTMLElement, {
      nameOf: () => "节点十二",
      typeOf: () => "人物",
      loadNames: async () => undefined,
      focus: () => undefined,
      restoreFocus: () => undefined,
      reportError: () => undefined,
    });
    manager.sync();
    root.click("toggle");

    const event = root.keydown("Escape");

    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.match(root.innerHTML, /aria-expanded="false"/);
    assert.equal(root.focusedSelector, "#pinned-toggle");
    assert.deepEqual([...state.pinnedSelections], [12]);
  } finally {
    state.pinnedSelections.clear();
    for (const rank of previousPinned) state.pinnedSelections.add(rank);
    state.pinnedWorkingSets.clear();
    for (const [rank, workingSet] of previousWorkingSets)
      state.pinnedWorkingSets.set(rank, workingSet);
  }
});
