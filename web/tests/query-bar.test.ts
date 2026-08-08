import assert from "node:assert/strict";
import { test } from "node:test";

import {
  captureControlFocus,
  createDefaultConditionEdit,
  createConditionEditRoot,
  createQueryNameInput,
  createQueryTokenControl,
  createSortTerm,
  finishConditionEdit,
  findQueryTokenButton,
  fullTextScopeOptions,
  isActionShortcut,
  moveSuggestionIndex,
  queryNameSuggestionOwners,
  resolveSingleChoiceValue,
  rankEntitySuggestions,
  restoreControlFocus,
  shouldSyncQueryInput,
  tokenFocusIndexAfterRemoval,
  visibleNameAction,
} from "../src/query/query-bar";
import type { EditCondition } from "../src/query/query-bar";
import type { QueryToken } from "../src/query/presenter";

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(readonly key = "") {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  title = "";
  type = "";
  private readonly listeners = new Map<string, Listener[]>();

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event = new FakeEvent()): FakeEvent {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  matches(selector: string): boolean {
    return selector === ".query-token" && this.className.split(" ").includes("query-token");
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

const removableToken: QueryToken = {
  id: "condition-0",
  kind: "condition",
  label: "评分 ≥ 8",
  target: { type: "condition", index: 0 },
  editable: true,
  removable: true,
};

test("keeps the persistent query input independent from popover sizing", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
  } as unknown as Document;

  try {
    const control = createQueryNameInput() as unknown as FakeElement;

    assert.equal(control.className, "query-name-input");
    assert.equal(control.attributes.get("aria-label"), "名称关键词");
  } finally {
    globalThis.document = originalDocument;
  }
});

test("keeps a new enum condition's visible default as its real value", () => {
  const edit = createDefaultConditionEdit({
    fields: () => ["type"],
    operators: () => ["eq"],
    values: () => ({ "1": "书籍", "2": "动画" }),
  });

  assert.deepEqual(edit, {
    kind: "leaf",
    field: "type",
    operator: "eq",
    raw: "1",
  });
});

test("keeps the visible enum value real after switching fields", () => {
  const choices = { "1": "书籍", "2": "动画" };

  assert.equal(resolveSingleChoiceValue("", choices), "1");
  assert.equal(resolveSingleChoiceValue("2", choices), "2");
});

test("gives a removable token an independent mouse delete button", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
  } as unknown as Document;
  let edits = 0;
  let removals = 0;

  try {
    const control = createQueryTokenControl(removableToken, {
      edit: () => edits++,
      remove: () => removals++,
    }) as unknown as FakeElement;
    const [token, remove] = control.children;

    assert.equal(control.className, "query-token-shell");
    assert.equal(token?.textContent, "评分 ≥ 8");
    assert.equal(remove?.textContent, "×");
    assert.equal(remove?.attributes.get("aria-label"), "删除：评分 ≥ 8");

    const click = remove?.emit("click");
    assert.equal(click?.defaultPrevented, true);
    assert.equal(click?.propagationStopped, true);
    assert.equal(removals, 1);
    assert.equal(edits, 0);

    token?.emit("click");
    assert.equal(edits, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("keeps keyboard deletion on the token itself", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
  } as unknown as Document;
  let removals = 0;

  try {
    const control = createQueryTokenControl(removableToken, {
      edit: () => undefined,
      remove: () => removals++,
    }) as unknown as FakeElement;
    const event = control.children[0]?.emit("keydown", new FakeEvent("Delete"));

    assert.equal(event?.defaultPrevented, true);
    assert.equal(removals, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("finds the token button inside its removable mouse-control shell", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
  } as unknown as Document;

  try {
    const control = createQueryTokenControl(removableToken, {
      edit: () => undefined,
      remove: () => undefined,
    }) as unknown as FakeElement;

    assert.equal(
      findQueryTokenButton(control as unknown as Element),
      control.children[0],
    );
  } finally {
    globalThis.document = originalDocument;
  }
});

test("focuses the nearest surviving token after mouse or keyboard deletion", () => {
  assert.equal(tokenFocusIndexAfterRemoval(2, 4), 2);
  assert.equal(tokenFocusIndexAfterRemoval(4, 4), 3);
  assert.equal(tokenFocusIndexAfterRemoval(0, 0), -1);
});

test("forces the active text input to follow history navigation", () => {
  assert.equal(shouldSyncQueryInput(true, "星空", true), true);
  assert.equal(shouldSyncQueryInput(true, "星空", false), false);
});

test("commits the visible name before a structural action can restore stale text", () => {
  const draft = {
    kind: "list" as const,
    query: {
      scope: ["episode"] as const,
      text: { value: "机", capability: "lookup" as const },
    },
  };

  assert.deepEqual(visibleNameAction(draft, ""), {
    type: "setText",
    text: undefined,
  });
  assert.equal(visibleNameAction(draft, "机"), null);
});

test("accepts the conjunction selected for the outer condition group", () => {
  const config = {
    fields: () => ["score"],
    fieldLabel: (field: string) => field,
    operators: () => ["gte"],
    values: () => null,
    inputType: () => "number" as const,
    create: (field: string, operator: string, raw: string) => ({
      kind: "compare" as const,
      field,
      operator: operator as "gte",
      value: Number(raw),
    }),
  };

  const edit: EditCondition = {
      kind: "any",
      terms: [
        { kind: "leaf", field: "score", operator: "gte", raw: "8" },
        { kind: "leaf", field: "score", operator: "gte", raw: "9" },
      ],
    };
  const saved = finishConditionEdit(edit, config);

  assert.deepEqual(saved, {
      kind: "any",
      terms: [
        { kind: "compare", field: "score", operator: "gte", value: 8 },
        { kind: "compare", field: "score", operator: "gte", value: 9 },
      ],
    });
  assert.deepEqual(createConditionEditRoot(saved), edit);
});

test("restores focus to the same repeated control after an editor redraw", () => {
  const before = [new FakeElement(), new FakeElement()];
  const after = [new FakeElement(), new FakeElement()];
  for (const control of [...before, ...after]) control.setAttribute("aria-label", "字段");

  const focus = captureControlFocus(
    before[1] as unknown as Element,
    before as unknown as HTMLElement[],
  );

  assert.deepEqual(focus, { key: "字段", index: 1 });
  assert.equal(
    restoreControlFocus(focus, after as unknown as HTMLElement[]),
    after[1],
  );
});

test("starts common sort fields in their user-expected direction", () => {
  assert.deepEqual(createSortTerm("score"), {
    column: "score",
    direction: "desc",
    nulls: "last",
  });
  assert.deepEqual(createSortTerm("rank"), {
    column: "rank",
    direction: "asc",
    nulls: "first",
  });
});

test("puts an exact entity name before earlier substring suggestions", () => {
  assert.deepEqual(
    rankEntitySuggestions("宮崎駿", [
      { ref: "subject:1", owner: "subject", label: "宮崎駿：十年一夢" },
      { ref: "person:1", owner: "person", label: "宮崎駿", match: "宮崎駿" },
    ]).map((item) => item.ref),
    ["person:1", "subject:1"],
  );
});

test("keeps full-text search in the current entity scope by default", () => {
  assert.deepEqual(fullTextScopeOptions("person"), [
    { value: "fullText:summary", label: "简介含" },
    { value: "all", label: "所有正文与关系备注" },
  ]);
});

test("moves autocomplete selection with wrapping arrow-key navigation", () => {
  assert.equal(moveSuggestionIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(moveSuggestionIndex(0, 3, "ArrowUp"), 2);
  assert.equal(moveSuggestionIndex(2, 3, "ArrowDown"), 0);
  assert.equal(moveSuggestionIndex(0, 0, "ArrowDown"), -1);
});

test("uses slash as an action shortcut only in an otherwise empty name input", () => {
  assert.equal(isActionShortcut("/", ""), true);
  assert.equal(isActionShortcut("/", "已有文字"), false);
  assert.equal(isActionShortcut("/条件", ""), false);
  assert.equal(isActionShortcut("机器人/动画", "机器人"), false);
});

test("derives name suggestions from the same visible entity scope", () => {
  assert.deepEqual(queryNameSuggestionOwners({
    kind: "list",
    query: { scope: ["subject", "person", "character"] },
  }), ["subject", "person", "character"]);
  assert.deepEqual(queryNameSuggestionOwners({
    kind: "list",
    allText: "时间旅行",
  }), []);
  assert.deepEqual(queryNameSuggestionOwners({
    kind: "path",
    from: "subject:1",
    to: "person:2",
    maxHops: 6,
    maxPaths: 10,
  }), []);
});
