import assert from "node:assert/strict";
import { test } from "node:test";

import { Drawer, drawerTopActions, pathArrow } from "../src/drawer";
import type { CommonItem } from "../src/graph";
import type { DrawerDeps } from "../src/drawer";
import { state } from "../src/store";

class FakeClassList {
  private values = new Set<string>();

  add(value: string): void {
    this.values.add(value);
  }

  remove(value: string): void {
    this.values.delete(value);
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }
}

class FakeDrawerElement {
  innerHTML = "";
  inert = false;
  scrollTop = 0;
  classList = new FakeClassList();
  focusedChild: object | null = null;
  private attributes = new Map<string, string>();
  private clickListener: ((event: { target: object }) => void) | null = null;

  addEventListener(
    type: string,
    listener: (event: { target: object }) => void,
  ): void {
    if (type === "click") this.clickListener = listener;
  }

  clickClose(): void {
    this.clickListener?.({
      target: {
        id: "drawer-close",
        classList: { contains: () => false },
        closest: () => null,
      },
    });
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  contains(node: object | null): boolean {
    return node !== null && node === this.focusedChild;
  }

  querySelector(): null {
    return null;
  }
}

function makeDrawer(
  element: FakeDrawerElement,
  overrides: Partial<DrawerDeps> = {},
): Drawer {
  const deps = {
    geo: { key: new Uint32Array(256) },
    names: {
      get: (rank: number) => `节点 ${rank}`,
      row: (rank: number) => [`节点 ${rank}`, null, 1] as const,
      load: async () => undefined,
    },
    manifest: {},
    data: {
      rankOf: () => null,
      mappings: async () => ({
        fact_labels: {},
        subject_type: {},
        platform: {},
        person_type: {},
        character_role: {},
      }),
    },
    walk: () => undefined,
    arm: () => undefined,
    reportError: () => undefined,
    ...overrides,
  } as unknown as DrawerDeps;
  return new Drawer(element as unknown as HTMLElement, deps);
}

test("renders the Bangumi link as an accessible top action", () => {
  const markup = drawerTopActions((1 << 24) | 42);

  assert.match(markup, /href="https:\/\/bgm\.tv\/subject\/42"/);
  assert.match(markup, /title="[^"]*bgm\.tv[^"]*"/);
  assert.match(markup, /aria-label="[^"]*bgm\.tv[^"]*"/);
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener"/);
  assert.match(markup, /<svg/);
});

test("omits the external action outside node details", () => {
  assert.doesNotMatch(drawerTopActions(), /bgm\.tv/);
});

test("points each path arrow in the published relationship direction", () => {
  assert.equal(pathArrow("配音角色", 1), "↓ 配音角色");
  assert.equal(pathArrow("声优", -1), "↑ 声优");
});

test("keeps a closed drawer out of focus navigation", () => {
  const originalDocument = globalThis.document;
  const element = new FakeDrawerElement();
  const focusedChild = {};
  const search = { focusCount: 0, focus(): void { this.focusCount++; } };
  element.focusedChild = focusedChild;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement: focusedChild,
      querySelector: () => search,
    },
  });

  try {
    const drawer = makeDrawer(element);
    assert.equal(element.inert, true);
    assert.equal(element.getAttribute("aria-hidden"), "true");

    drawer.hide();
    assert.equal(search.focusCount, 1);
  } finally {
    if (originalDocument === undefined)
      Reflect.deleteProperty(globalThis, "document");
    else
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
  }
});

test("hides the drawer without clearing the selected node", () => {
  const originalDocument = globalThis.document;
  const previousSelection = state.selection;
  const element = new FakeDrawerElement();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { activeElement: null, querySelector: () => null },
  });

  try {
    state.selection = 42;
    makeDrawer(element);
    element.classList.add("open");
    element.setAttribute("aria-hidden", "false");

    element.clickClose();

    assert.equal(element.classList.contains("open"), false);
    assert.equal(element.getAttribute("aria-hidden"), "true");
    assert.equal(state.selection, 42);
  } finally {
    state.selection = previousSelection;
    if (originalDocument === undefined)
      Reflect.deleteProperty(globalThis, "document");
    else
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
  }
});

test("reports asynchronous drawer failures through the page error channel", async () => {
  const element = new FakeDrawerElement();
  const failures: [string, unknown][] = [];
  const drawer = makeDrawer(element, {
    reportError: (context, error) => failures.push([context, error]),
  } as Partial<DrawerDeps>);
  const run = Reflect.get(drawer, "run") as (
    task: Promise<void>,
    context: string,
  ) => void;
  const failure = new Error("network failed");

  run.call(drawer, Promise.reject(failure), "关系分页");
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  assert.deepEqual(failures, [["关系分页", failure]]);
});

test("keeps an expanded summary out of the DOM until each segment is requested", () => {
  const element = new FakeDrawerElement();
  const drawer = makeDrawer(element);
  Reflect.set(drawer, "cur", {
    rank: 0,
    key: (2 << 24) | 1,
    entity: {
      kind: "person",
      key: (2 << 24) | 1,
      name: "测试人物",
      nameCn: "",
      type: 1,
      career: [],
      comments: 0,
      collects: 0,
      hasSummary: true,
      hasInfobox: false,
    },
    mappings: {
      fact_labels: {},
      subject_type: {},
      platform: {},
      person_type: { "1": "个人" },
      character_role: {},
    },
    facts: [],
    factsTotal: 0,
    factsNext: null,
    expanded: false,
    loading: false,
    eps: null,
    epsTotal: 0,
    epsNext: null,
    epsExpanded: false,
    summary: {
      s: "ready",
      text: `${"a".repeat(10_001)}TAIL`,
      shown: 10_000,
    },
    summaryOpen: true,
    infobox: { s: "idle" },
    descs: new Map(),
  });

  const rerender = Reflect.get(drawer, "rerender") as () => void;
  rerender.call(drawer);

  assert.doesNotMatch(element.innerHTML, /TAIL/);
  assert.match(element.innerHTML, /继续显示/);
});

test("renders every published common neighbor instead of dropping the tail", async () => {
  const element = new FakeDrawerElement();
  const loaded: number[] = [];
  const items: CommonItem[] = Array.from({ length: 101 }, (_, index) => ({
    rank: index + 2,
    la: "关联",
    lb: "关联",
  }));
  const drawer = makeDrawer(element, {
    names: {
      get: (rank) => `节点 ${rank}`,
      row: (rank) => [`节点 ${rank}`, null, 1],
      load: async (ranks) => {
        loaded.push(...ranks);
      },
    },
  });

  await drawer.showCompare(0, 1, items, null);

  assert.equal(loaded.length, 103);
  assert.match(element.innerHTML, /data-rank="102"/);
  assert.equal(element.inert, false);
  assert.equal(element.getAttribute("aria-hidden"), "false");
});
