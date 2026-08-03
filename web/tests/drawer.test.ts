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
      load: async () => undefined,
    },
    manifest: { buckets: 8, labels: ["关联"] },
    walk: () => undefined,
    arm: () => undefined,
    reportError: () => undefined,
    ...overrides,
  } as unknown as DrawerDeps;
  return new Drawer(element as unknown as HTMLElement, deps);
}

test("renders the Bangumi link as an accessible top action", () => {
  const markup = drawerTopActions((1 << 24) | 42);
  const icon = markup.match(
    /<a[\s\S]*?class="[^"]*\bdrawer-external\b[^"]*"[\s\S]*?>([\s\S]*?)<\/a>/,
  )?.[1];

  assert.match(markup, /href="https:\/\/bgm\.tv\/subject\/42"/);
  assert.match(markup, /title="在 bgm\.tv 查看"/);
  assert.match(markup, /aria-label="在 bgm\.tv 查看"/);
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener"/);
  assert.match(icon ?? "", /<svg/);
  assert.doesNotMatch(icon ?? "", /在 bgm\.tv 查看|→/);
});

test("omits the external action outside node details", () => {
  assert.doesNotMatch(drawerTopActions(), /drawer-external|bgm\.tv/);
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

test("renders every published common neighbor instead of dropping the tail", async () => {
  const element = new FakeDrawerElement();
  const loaded: number[] = [];
  const items: CommonItem[] = Array.from({ length: 101 }, (_, index) => ({
    rank: index + 2,
    la: 0,
    lb: 0,
  }));
  const drawer = makeDrawer(element, {
    names: {
      get: (rank) => `节点 ${rank}`,
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
