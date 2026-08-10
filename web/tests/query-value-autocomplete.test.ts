import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachValueAutocomplete,
  moveValueSuggestionIndex,
  valueSuggestionPlacement,
} from "../src/query/value-autocomplete";

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(
    readonly key = "",
    readonly isComposing = false,
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

type Listener = (event: FakeEvent) => void;

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly classList = {
    toggle: (name: string, active: boolean): void => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (active) names.add(name);
      else names.delete(name);
      this.className = [...names].join(" ");
    },
  };
  className = "";
  hidden = false;
  id = "";
  textContent = "";
  type = "";
  value = "";
  scrollTop = 0;
  clientHeight = 0;
  scrollHeight = 0;
  parent: FakeElement | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0);
    this.append(...children);
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
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

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  focus(): void {
    fakeDocument.activeElement = this;
  }

  contains(candidate: FakeElement | null): boolean {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  scrollIntoView(): void {}
}

const fakeDocument = {
  activeElement: null as FakeElement | null,
  body: new FakeElement(),
  createElement: () => new FakeElement(),
};

test("moves through tag suggestions without inventing an item", () => {
  assert.equal(moveValueSuggestionIndex(-1, 0, "ArrowDown"), -1);
  assert.equal(moveValueSuggestionIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(moveValueSuggestionIndex(0, 3, "ArrowUp"), 2);
  assert.equal(moveValueSuggestionIndex(2, 3, "ArrowDown"), 0);
});

test("keeps the suggestion popup in the viewport and flips it when needed", () => {
  assert.deepEqual(valueSuggestionPlacement(
    { left: 280, top: 650, bottom: 684, width: 160, height: 34 },
    { width: 280, height: 220 },
    { width: 320, height: 720 },
  ), {
    left: 28,
    top: 426,
    width: 280,
    maxHeight: 220,
    side: "above",
  });
});

test("mounts the suggestion popup outside a clipping query panel", () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument as unknown as Document;
  const host = new FakeElement();
  const input = new FakeElement();
  host.append(input);

  try {
    const cleanup = attachValueAutocomplete({
      host: host as unknown as HTMLElement,
      input: input as unknown as HTMLInputElement,
      label: "用户标签",
      suggest: async () => [],
      onValue: () => {},
    });

    assert.deepEqual(host.children, [input]);
    assert.equal(
      fakeDocument.body.children[0]?.className,
      "query-value-suggestions",
    );
    cleanup();
    assert.equal(fakeDocument.body.children.length, 0);
  } finally {
    fakeDocument.body.replaceChildren();
    globalThis.document = originalDocument;
  }
});

test("offers featured tags to mouse users before they type", () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument as unknown as Document;
  const host = new FakeElement();
  const input = new FakeElement();
  host.append(input);
  let queries = 0;
  let selected = "";

  try {
    const cleanup = attachValueAutocomplete({
      host: host as unknown as HTMLElement,
      input: input as unknown as HTMLInputElement,
      label: "用户标签",
      featuredValues: ["动画", "游戏"],
      suggest: async () => {
        queries++;
        return [];
      },
      onValue: (value) => selected = value,
    });
    input.focus();
    input.emit("focus");

    const list = fakeDocument.body.children[0]?.children[1];
    assert.deepEqual(list?.children.map((choice) => choice.textContent), [
      "动画",
      "游戏",
    ]);
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(queries, 0);

    list?.children[0]?.emit("click");
    assert.equal(input.value, "动画");
    assert.equal(selected, "动画");
    cleanup();
  } finally {
    fakeDocument.activeElement = null;
    globalThis.document = originalDocument;
  }
});

test("reopens a complete direct-choice list and reports the chosen value", () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument as unknown as Document;
  const host = new FakeElement();
  const input = new FakeElement();
  host.append(input);
  input.value = "导演";
  let chosen = "";

  try {
    const cleanup = attachValueAutocomplete({
      host: host as unknown as HTMLElement,
      input: input as unknown as HTMLInputElement,
      label: "具体关系",
      featuredValues: ["导演", "前传", "主角"],
      openFeaturedOnFocus: true,
      suggest: async () => [],
      onValue: () => {},
      onChoose: (value) => chosen = value,
    });
    input.focus();
    input.emit("focus");

    const list = fakeDocument.body.children[0]?.children[1];
    assert.deepEqual(list?.children.map((choice) => choice.textContent), [
      "导演",
      "前传",
      "主角",
    ]);
    list?.children[1]?.emit("click");
    assert.equal(chosen, "前传");
    cleanup();
  } finally {
    fakeDocument.activeElement = null;
    globalThis.document = originalDocument;
  }
});

test("keeps every large-list choice reachable while rendering in scroll batches", () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument as unknown as Document;
  const host = new FakeElement();
  const input = new FakeElement();
  const values = Array.from({ length: 205 }, (_, index) => `关系 ${index + 1}`);
  host.append(input);

  try {
    const cleanup = attachValueAutocomplete({
      host: host as unknown as HTMLElement,
      input: input as unknown as HTMLInputElement,
      label: "具体关系",
      featuredValues: values,
      openFeaturedOnFocus: true,
      suggest: async () => [],
      onValue: () => {},
    });
    input.focus();
    input.emit("focus");

    const popover = fakeDocument.body.children[0]!;
    const status = popover.children[0]!;
    const list = popover.children[1]!;
    assert.ok(list.children.length < values.length);
    assert.equal(status.textContent, "共 205 项，继续滚动查看");

    for (let index = 0; index < 81; index++)
      input.emit("keydown", new FakeEvent("ArrowDown"));
    assert.equal(list.children.length, 160);
    assert.match(input.getAttribute("aria-activedescendant") ?? "", /-80$/);

    popover.clientHeight = 100;
    popover.scrollHeight = 1000;
    popover.scrollTop = 1000;
    while (list.children.length < values.length) popover.emit("scroll");

    assert.deepEqual(
      list.children.map((choice) => choice.textContent),
      values,
    );
    assert.equal(status.hidden, true);
    cleanup();
  } finally {
    fakeDocument.activeElement = null;
    globalThis.document = originalDocument;
  }
});

test("keeps a concise label while returning a structured choice identity", () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument as unknown as Document;
  const host = new FakeElement();
  const input = new FakeElement();
  host.append(input);
  let chosen = "";

  try {
    const cleanup = attachValueAutocomplete({
      host: host as unknown as HTMLElement,
      input: input as unknown as HTMLInputElement,
      label: "具体关系",
      featuredValues: [{
        value: "WORKED_ON|subject|person",
        label: "导演",
        detail: "作品 → 人物",
      }],
      openFeaturedOnFocus: true,
      suggest: async () => [],
      onValue: () => {},
      onChoose: (value) => chosen = value,
    });
    input.focus();
    input.emit("focus");

    const choice = fakeDocument.body.children[0]?.children[1]?.children[0];
    assert.equal(choice?.children[0]?.textContent, "导演");
    assert.equal(choice?.children[1]?.textContent, "作品 → 人物");
    assert.equal(choice?.getAttribute("aria-label"), "导演，作品 → 人物");
    choice?.emit("click");
    assert.equal(input.value, "导演");
    assert.equal(chosen, "WORKED_ON|subject|person");
    cleanup();
  } finally {
    fakeDocument.activeElement = null;
    globalThis.document = originalDocument;
  }
});

test("lets a user choose a real tag suggestion with the keyboard", async () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument as unknown as Document;
  const host = new FakeElement();
  const input = new FakeElement();
  host.append(input);
  let selected = "";

  try {
    const cleanup = attachValueAutocomplete({
      host: host as unknown as HTMLElement,
      input: input as unknown as HTMLInputElement,
      label: "用户标签",
      delay: 0,
      suggest: async () => ["科幻", "科幻动画"],
      onValue: (value) => selected = value,
    });
    input.value = "科";
    input.emit("input");
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(input.emit("keydown", new FakeEvent("ArrowDown")).defaultPrevented, true);
    assert.equal(input.emit("keydown", new FakeEvent("Enter")).defaultPrevented, true);
    assert.equal(input.value, "科幻");
    assert.equal(selected, "科幻");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    cleanup();
  } finally {
    globalThis.document = originalDocument;
  }
});

test("does not load a large unfeatured vocabulary until the user types", async () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument as unknown as Document;
  const host = new FakeElement();
  const input = new FakeElement();
  host.append(input);
  let queries = 0;

  try {
    const cleanup = attachValueAutocomplete({
      host: host as unknown as HTMLElement,
      input: input as unknown as HTMLInputElement,
      label: "内容标签",
      delay: 0,
      suggest: async (text) => {
        queries++;
        assert.equal(text, "科");
        return ["科幻", "科学"];
      },
      onValue: () => {},
    });
    input.focus();
    input.emit("focus");
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(queries, 0);
    assert.equal(input.getAttribute("aria-expanded"), "false");

    input.value = "科";
    input.emit("input");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const list = fakeDocument.body.children[0]?.children[1];
    assert.deepEqual(list?.children.map((choice) => choice.textContent), [
      "科幻",
      "科学",
    ]);
    assert.equal(queries, 1);
    assert.equal(input.getAttribute("aria-expanded"), "true");
    cleanup();
  } finally {
    fakeDocument.activeElement = null;
    globalThis.document = originalDocument;
  }
});

test("uses a constrained-choice empty message when free input is invalid", async () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument as unknown as Document;
  const host = new FakeElement();
  const input = new FakeElement();
  host.append(input);

  try {
    const cleanup = attachValueAutocomplete({
      host: host as unknown as HTMLElement,
      input: input as unknown as HTMLInputElement,
      label: "具体关系",
      noResultsMessage: "没有匹配的具体关系",
      delay: 0,
      suggest: async () => [],
      onValue: () => {},
    });
    input.focus();
    input.value = "不存在";
    input.emit("input");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const status = fakeDocument.body.children[0]?.children[0];
    assert.equal(status?.textContent, "没有匹配的具体关系");
    cleanup();
  } finally {
    fakeDocument.activeElement = null;
    globalThis.document = originalDocument;
  }
});

test("does not reopen stale suggestions after focus leaves the editor", async () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument as unknown as Document;
  const host = new FakeElement();
  const input = new FakeElement();
  const outside = new FakeElement();
  host.append(input);
  let finish: ((values: readonly string[]) => void) | undefined;

  try {
    const cleanup = attachValueAutocomplete({
      host: host as unknown as HTMLElement,
      input: input as unknown as HTMLInputElement,
      label: "用户标签",
      delay: 0,
      suggest: () => new Promise((resolve) => finish = resolve),
      onValue: () => {},
    });
    input.focus();
    input.value = "科";
    input.emit("input");
    await new Promise((resolve) => setTimeout(resolve, 1));

    outside.focus();
    input.emit("blur");
    await new Promise((resolve) => setTimeout(resolve, 1));
    finish?.(["科幻"]);
    await new Promise((resolve) => setTimeout(resolve, 1));

    assert.equal(input.getAttribute("aria-expanded"), "false");
    cleanup();
  } finally {
    fakeDocument.activeElement = null;
    globalThis.document = originalDocument;
  }
});
