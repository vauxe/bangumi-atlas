import assert from "node:assert/strict";
import { test } from "node:test";

import { setQueryIconButton } from "../src/query/icons";

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  title = "";

  constructor(readonly tagName: string) {}

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

test("renders an icon-only button with a stable accessible name", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElementNS(_namespace: string, name: string): FakeElement {
      return new FakeElement(name);
    },
  } as unknown as Document;

  try {
    const button = new FakeElement("button");
    setQueryIconButton(
      button as unknown as HTMLButtonElement,
      "search",
      "执行查询",
    );

    assert.equal(button.attributes.get("aria-label"), "执行查询");
    assert.equal(button.title, "执行查询");
    assert.equal(button.dataset.queryIcon, "search");
    assert.equal(button.children[0]?.tagName, "svg");
    assert.equal(button.children[0]?.attributes.get("aria-hidden"), "true");
    assert.equal(button.children[0]?.attributes.get("focusable"), "false");
    assert.equal(button.children[0]?.attributes.get("viewBox"), "0 0 24 24");
    assert.equal(button.children[0]?.attributes.get("fill"), "none");
    assert.equal(button.children[0]?.attributes.get("stroke"), "currentColor");
    assert.ok(button.children[0]?.children.length);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("replaces the visible glyph when an icon button changes state", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElementNS(_namespace: string, name: string): FakeElement {
      return new FakeElement(name);
    },
  } as unknown as Document;

  try {
    const button = new FakeElement("button");
    setQueryIconButton(
      button as unknown as HTMLButtonElement,
      "search",
      "执行查询",
    );
    const search = button.children[0];

    setQueryIconButton(
      button as unknown as HTMLButtonElement,
      "stop",
      "正在查询，点击停止",
    );

    assert.equal(button.children.length, 1);
    assert.notEqual(button.children[0], search);
    assert.equal(button.dataset.queryIcon, "stop");
    assert.equal(button.attributes.get("aria-label"), "正在查询，点击停止");
  } finally {
    globalThis.document = originalDocument;
  }
});

test("provides a compact completion icon without losing its accessible label", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElementNS(_namespace: string, name: string): FakeElement {
      return new FakeElement(name);
    },
  } as unknown as Document;

  try {
    const button = new FakeElement("button");
    setQueryIconButton(
      button as unknown as HTMLButtonElement,
      "check",
      "添加条件",
    );

    assert.equal(button.dataset.queryIcon, "check");
    assert.equal(button.attributes.get("aria-label"), "添加条件");
    assert.ok(button.children[0]?.children.length);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("provides distinct expand and collapse directions", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElementNS(_namespace: string, name: string): FakeElement {
      return new FakeElement(name);
    },
  } as unknown as Document;

  try {
    const expand = new FakeElement("button");
    const collapse = new FakeElement("button");
    setQueryIconButton(expand as unknown as HTMLButtonElement, "expand", "展开");
    setQueryIconButton(collapse as unknown as HTMLButtonElement, "collapse", "收起");

    const expandPath = expand.children[0]?.children[0]?.attributes.get("d");
    const collapsePath = collapse.children[0]?.children[0]?.attributes.get("d");
    assert.notEqual(expandPath, collapsePath);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("provides a back arrow for nested query panels", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElementNS(_namespace: string, name: string): FakeElement {
      return new FakeElement(name);
    },
  } as unknown as Document;

  try {
    const button = new FakeElement("button");
    setQueryIconButton(
      button as unknown as HTMLButtonElement,
      "back",
      "返回上一页",
    );

    assert.equal(button.dataset.queryIcon, "back");
    assert.equal(button.attributes.get("aria-label"), "返回上一页");
    assert.equal(
      button.children[0]?.children.map((path) => path.attributes.get("d")).join(" "),
      "M19 12H5 M12 5l-7 7 7 7",
    );
  } finally {
    globalThis.document = originalDocument;
  }
});
