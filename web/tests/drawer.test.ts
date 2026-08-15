import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Drawer, drawerTopActions } from "../src/drawer";
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
  focusCount = 0;
  classList = new FakeClassList();
  focusedChild: object | null = null;
  focusedEpisode = "";
  private attributes = new Map<string, string>();
  private clickListener: ((event: { target: object }) => void) | null = null;

  addEventListener(
    type: string,
    listener: (event: { target: object }) => void,
  ): void {
    if (type === "click") this.clickListener = listener;
  }

  clickClose(): void {
    this.clickTarget({ id: "drawer-close" });
  }

  clickTarget({
    id = "",
    tab = null,
  }: {
    id?: string;
    tab?: string | null;
  }): void {
    this.clickListener?.({
      target: {
        id,
        classList: { contains: () => false },
        closest: (selector: string) =>
          selector === "[data-tab]" && tab !== null
            ? { getAttribute: () => tab }
            : selector === `#${id}`
              ? { getAttribute: () => null }
            : null,
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

  querySelector(selector: string): { focus(): void; scrollIntoView(): void } | null {
    if (!selector.includes("data-episode-row")) return null;
    return {
      focus: () => this.focusedEpisode = selector,
      scrollIntoView: () => undefined,
    };
  }

  focus(): void {
    this.focusCount++;
  }
}

class FakeButton {
  hidden = true;
  focusCount = 0;
  private clickListener: (() => void) | null = null;

  addEventListener(type: string, listener: () => void): void {
    if (type === "click") this.clickListener = listener;
  }

  click(): void {
    this.clickListener?.();
  }

  focus(): void {
    this.focusCount++;
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
        episode_type: {},
      }),
    },
    walk: () => undefined,
    reportError: () => undefined,
    ...overrides,
  } as unknown as DrawerDeps;
  return new Drawer(
    element as unknown as HTMLElement,
    new FakeButton() as unknown as HTMLButtonElement,
    deps,
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("renders the Bangumi link as an accessible top action", () => {
  const markup = drawerTopActions((1 << 24) | 42, false);

  assert.match(markup, /href="https:\/\/bgm\.tv\/subject\/42"/);
  assert.match(markup, /aria-label="[^"]*bgm\.tv[^"]*"/);
  assert.match(markup, /data-tooltip="[^"]*bgm\.tv[^"]*"/);
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener"/);
  assert.match(markup, /<svg/);
  assert.match(markup, /id="drawer-pin"/);
  assert.match(markup, /aria-pressed="false"/);
  assert.match(markup, /aria-label="固定节点"/);
  assert.match(markup, /data-tooltip="固定节点"/);
  assert.match(markup, /id="drawer-close"/);
  assert.match(markup, /aria-label="关闭详情"/);
  assert.match(markup, /data-tooltip="关闭详情"/);
  assert.doesNotMatch(markup, /\stitle=/);
});

test("shows top-action explanations on pointer hover and keyboard focus", () => {
  const pageSource = readFileSync("../site/index.html", "utf8");

  assert.match(pageSource, /\.drawer-action::after\s*\{/);
  assert.match(
    pageSource,
    /\.drawer-action:hover::after,\s*\.drawer-action:focus-visible::after/,
  );
  assert.match(pageSource, /content:\s*attr\(data-tooltip\)/);
});

test("exposes the pinned state through the drawer action", () => {
  const markup = drawerTopActions((1 << 24) | 42, true);

  assert.match(markup, /id="drawer-pin"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /aria-label="取消固定"/);
  assert.match(markup, /data-tooltip="取消固定"/);
});

test("toggles the current node from the drawer pin action", () => {
  const previousSelection = state.selection;
  const previousPinned = new Set(state.pinnedSelections);
  const previousWorkingSets = new Map(state.pinnedWorkingSets);
  const element = new FakeDrawerElement();
  const drawer = makeDrawer(element);
  let rerenders = 0;
  try {
    state.pinnedSelections.clear();
    state.pinnedWorkingSets.clear();
    state.selection = 42;
    Reflect.set(drawer, "cur", { rank: 42 });
    Reflect.set(drawer, "rerender", () => rerenders++);

    element.clickTarget({ id: "drawer-pin" });
    assert.deepEqual([...state.pinnedSelections], [42]);
    assert.equal(rerenders, 1);

    element.clickTarget({ id: "drawer-pin" });
    assert.deepEqual([...state.pinnedSelections], []);
    assert.equal(rerenders, 2);
  } finally {
    state.selection = previousSelection;
    state.pinnedSelections.clear();
    for (const rank of previousPinned) state.pinnedSelections.add(rank);
    state.pinnedWorkingSets.clear();
    for (const [rank, workingSet] of previousWorkingSets)
      state.pinnedWorkingSets.set(rank, workingSet);
  }
});

test("replaces stale details while the next selection is loading", () => {
  const previousSelection = state.selection;
  const element = new FakeDrawerElement();
  const drawer = makeDrawer(element);
  try {
    state.selection = 42;
    Reflect.set(drawer, "cur", { rank: 42 });

    state.selection = 99;
    drawer.syncState();

    assert.match(element.innerHTML, /加载中/);
    assert.equal(Reflect.get(drawer, "cur"), null);
    assert.equal(element.classList.contains("open"), true);
    assert.equal(element.inert, false);
    assert.equal(element.getAttribute("aria-hidden"), "false");
  } finally {
    state.selection = previousSelection;
  }
});

test("omits the external action outside node details", () => {
  const markup = drawerTopActions();
  assert.doesNotMatch(markup, /bgm\.tv/);
  assert.doesNotMatch(markup, /drawer-pin/);
});

test("keeps query construction out of the node overview", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const renderOverview = Reflect.get(drawer, "renderOverview") as (
    current: unknown,
  ) => string;
  const markup = renderOverview.call(drawer, {
    key: (2 << 24) | 1,
    entity: null,
    mappings: {
      fact_labels: {}, subject_type: {}, platform: {},
      person_type: {}, character_role: {}, episode_type: {},
    },
    factsTotal: 12,
    summary: { s: "idle" },
    summaryOpen: false,
  });

  assert.match(markup, /基本资料/);
  assert.doesNotMatch(markup, /探索 12 条关联/);
  assert.doesNotMatch(markup, /共同关联/);
  assert.doesNotMatch(markup, /查找路径/);
  assert.doesNotMatch(markup, /data-arm|overview-actions/);
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

test("offers an explicit way to reopen the selected node after closing", () => {
  const originalDocument = globalThis.document;
  const previousSelection = state.selection;
  const element = new FakeDrawerElement();
  const reopen = new FakeButton();
  let walked: number | null = null;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { activeElement: null, querySelector: () => null },
  });

  try {
    new Drawer(
      element as unknown as HTMLElement,
      reopen as unknown as HTMLButtonElement,
      { walk: (rank: number) => { walked = rank; } } as DrawerDeps,
    );
    state.selection = 42;
    element.classList.add("open");
    element.setAttribute("aria-hidden", "false");

    element.clickClose();

    assert.equal(reopen.hidden, false);
    reopen.click();
    assert.equal(walked, 42);
    assert.equal(element.classList.contains("open"), true);
    assert.equal(element.getAttribute("aria-hidden"), "false");
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
      episode_type: {},
    },
    facts: [],
    factsTotal: 0,
    factsNext: null,
    tab: "overview",
    relationsLoading: false,
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

test("makes the complete subject overview the default dossier view", () => {
  const element = new FakeDrawerElement();
  const drawer = makeDrawer(element);
  Reflect.set(drawer, "cur", {
    rank: 0,
    key: (1 << 24) | 1,
    entity: {
      kind: "subject",
      key: (1 << 24) | 1,
      name: "Example",
      nameCn: "完整示例",
      type: 4,
      platformCode: null,
      date: "2026-01-02",
      score: 8.8,
      bgmRank: 12,
      nsfw: true,
      favorite: [11, 22, 33, 44, 55],
      series: true,
      scoreDetails: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      metaTags: ["科幻", "游戏"],
      tags: [["时间旅行", 1200], ["世界线", 300]],
      hasSummary: true,
      hasInfobox: true,
    },
    mappings: {
      fact_labels: {},
      subject_type: { "4": "游戏" },
      platform: {},
      person_type: {},
      character_role: {},
      episode_type: {},
    },
    facts: [],
    factsTotal: 0,
    factsNext: null,
    tab: "overview",
    relationsLoading: false,
    expanded: false,
    loading: false,
    eps: null,
    epsTotal: 0,
    epsNext: null,
    epsExpanded: false,
    summary: { s: "ready", text: "这是简介", shown: 10_000 },
    summaryOpen: false,
    infobox: { s: "idle" },
    descs: new Map(),
  });

  const rerender = Reflect.get(drawer, "rerender") as () => void;
  rerender.call(drawer);

  assert.match(element.innerHTML, /role="tablist"/);
  assert.match(
    element.innerHTML,
    /data-tab="overview"[^>]*aria-selected="true"/,
  );
  assert.doesNotMatch(element.innerHTML, /tabindex="-1"/);
  assert.match(
    element.innerHTML,
    /role="tabpanel"[^>]*aria-labelledby="dossier-tab-overview"/,
  );
  assert.match(element.innerHTML, /想玩/);
  assert.match(element.innerHTML, /玩过/);
  assert.match(element.innerHTML, /10 分/);
  assert.match(element.innerHTML, /时间旅行/);
  assert.match(element.innerHTML, /世界线/);
  assert.match(element.innerHTML, /系列作品/);
  assert.match(element.innerHTML, /成人内容/);
  assert.match(element.innerHTML, /这是简介/);
  assert.doesNotMatch(element.innerHTML, /<dt>条目<\/dt>/);
  assert.equal(element.innerHTML.match(/2026-01-02/g)?.length, 1);
  assert.doesNotMatch(element.innerHTML, /收藏 165/);
});

test("keeps repeated overview facts out of the detail header", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const statsOf = Reflect.get(drawer, "statsOf") as (
    current: unknown,
  ) => string[];

  assert.deepEqual(statsOf.call(drawer, {
    entity: {
      kind: "subject",
      score: 8.8,
      bgmRank: 12,
      favorite: [1, 2, 3, 4, 5],
      date: "2026-01-02",
      platformCode: 1001,
      type: 2,
    },
    mappings: { platform: { "2:1001": "TV" } },
  }), ["评分 8.8", "Rank #12"]);
  assert.deepEqual(statsOf.call(drawer, {
    entity: {
      kind: "person",
      collects: 120,
      comments: 30,
      career: ["seiyu"],
    },
    mappings: { platform: {} },
  }), []);
});

test("labels unknown subject codes without exposing bare enum values", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const current = {
    entity: {
      kind: "subject",
      key: (1 << 24) | 7,
      name: "Unknown",
      nameCn: null,
      type: 99,
      platformCode: 88,
      date: "",
      score: null,
      bgmRank: null,
      nsfw: false,
      favorite: [0, 0, 0, 0, 0],
      series: false,
      scoreDetails: [],
      metaTags: [],
      tags: [],
      hasSummary: false,
      hasInfobox: false,
    },
    mappings: {
      fact_labels: {}, subject_type: {}, platform: {},
      person_type: {}, character_role: {}, episode_type: {},
    },
    summary: { s: "idle" },
    summaryOpen: false,
  };
  const badge = Reflect.get(drawer, "badge") as (cur: unknown) => string;
  const renderOverview = Reflect.get(drawer, "renderSubjectOverview") as (
    cur: unknown,
  ) => string;

  assert.equal(badge.call(drawer, current), "未知作品类型（99）");
  assert.match(renderOverview.call(drawer, current), /未知平台（88）/);
});

test("renders named infobox list items without flattening their meaning", () => {
  const element = new FakeDrawerElement();
  const drawer = makeDrawer(element);
  Reflect.set(drawer, "cur", {
    rank: 0,
    key: (2 << 24) | 1,
    entity: null,
    mappings: {
      fact_labels: {}, subject_type: {}, platform: {},
      person_type: {}, character_role: {}, episode_type: {},
    },
    facts: [],
    factsTotal: 0,
    factsNext: null,
    tab: "reference",
    relationsLoading: false,
    expanded: false,
    loading: false,
    eps: null,
    epsTotal: 0,
    epsNext: null,
    epsExpanded: false,
    summary: { s: "idle" },
    summaryOpen: false,
    infobox: {
      s: "ready",
      text: `{{Infobox Crt
|别名={
[日文名|テスト]
[Test]
}
|危险输入={
[<img src=x>|<script>alert(1)</script>]
}
}}`,
      shown: 10_000,
    },
    descs: new Map(),
  });

  const rerender = Reflect.get(drawer, "rerender") as () => void;
  rerender.call(drawer);

  assert.match(element.innerHTML, /class="reference-values"/);
  assert.match(
    element.innerHTML,
    /class="reference-item-label">日文名<\/span><span>テスト<\/span>/,
  );
  assert.match(element.innerHTML, /<li>\s*<span>Test<\/span>\s*<\/li>/);
  assert.doesNotMatch(element.innerHTML, /<img src=x>/);
  assert.doesNotMatch(element.innerHTML, /<script>alert\(1\)<\/script>/);
  assert.match(element.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(element.innerHTML, /查看原始 Wiki 源码/);
});

test("shows resolved relations only on their tab while the rank cache is cold", async () => {
  const previousSelection = state.selection;
  const element = new FakeDrawerElement();
  const selfKey = (1 << 24) | 1;
  const otherRank = 7;
  const otherKey = (1 << 24) | 2;
  const facts = [{
    kind: "RELATES_TO" as const,
    ref: 1,
    multiplicity: 1,
    source: selfKey,
    target: otherKey,
    relationType: 1,
    sortOrder: 0,
  }];
  const drawer = makeDrawer(element, {
    data: {
      rankOf: () => null,
      entity: async () => null,
      factsFor: async () => ({ items: facts, total: 1, next: null }),
      mappings: async () => ({
        fact_labels: { RELATES_TO: { "1": "续集" } },
        subject_type: {},
        platform: {},
        person_type: {},
        character_role: {},
        episode_type: {},
      }),
    },
  } as unknown as Partial<DrawerDeps>);

  try {
    state.selection = 0;
    await drawer.show(0, selfKey, new Map([[otherKey, otherRank]]));
    assert.doesNotMatch(element.innerHTML, /作品谱系/);
    assert.doesNotMatch(element.innerHTML, /节点 7/);

    element.clickTarget({ tab: "relations" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.match(element.innerHTML, /作品谱系/);
    assert.match(element.innerHTML, /续集/);
    assert.match(element.innerHTML, /节点 7/);
  } finally {
    state.selection = previousSelection;
  }
});

test("shows node details while the complete relation fan is still resolving", async () => {
  const previousSelection = state.selection;
  const element = new FakeDrawerElement();
  const selfKey = (1 << 24) | 1;
  const otherKey = (1 << 24) | 2;
  const relationRanks = deferred<ReadonlyMap<number, number>>();
  const drawer = makeDrawer(element, {
    data: {
      rankOf: () => null,
      entity: async () => ({
        kind: "subject",
        key: selfKey,
        name: "Example",
        nameCn: "立即可见的详情",
        type: 2,
        platformCode: null,
        date: "",
        score: null,
        bgmRank: null,
        nsfw: false,
        favorite: [0, 0, 0, 0, 0],
        series: false,
        scoreDetails: [],
        metaTags: [],
        tags: [],
        hasSummary: false,
        hasInfobox: false,
      }),
      factsFor: async () => ({
        items: [{
          kind: "RELATES_TO",
          ref: 1,
          multiplicity: 1,
          source: selfKey,
          target: otherKey,
          relationType: 1,
          sortOrder: 0,
        }],
        total: 1,
        next: null,
      }),
      mappings: async () => ({
        fact_labels: { RELATES_TO: { "1": "续集" } },
        subject_type: {},
        platform: {},
        person_type: {},
        character_role: {},
        episode_type: {},
      }),
    },
  } as unknown as Partial<DrawerDeps>);

  try {
    state.selection = 0;
    await drawer.show(0, selfKey, relationRanks.promise);

    assert.match(element.innerHTML, /立即可见的详情/);
    assert.match(
      element.innerHTML,
      /id="drawer-pin"[^>]*aria-disabled="true"/s,
    );
    assert.match(element.innerHTML, /加载完成后可固定/);

    element.clickTarget({ tab: "relations" });
    assert.match(element.innerHTML, /正在加载关联/);

    relationRanks.resolve(new Map([[otherKey, 7]]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.match(element.innerHTML, /续集/);
    assert.match(element.innerHTML, /节点 7/);
    assert.doesNotMatch(element.innerHTML, /aria-disabled="true"/);
  } finally {
    state.selection = previousSelection;
  }
});

test("keeps resolved relations usable when relation names fail to load", async () => {
  const previousSelection = state.selection;
  const element = new FakeDrawerElement();
  const selfKey = (1 << 24) | 1;
  const otherKey = (1 << 24) | 2;
  const relationRanks = deferred<ReadonlyMap<number, number>>();
  const failure = new Error("name pack unavailable");
  const failures: [string, unknown][] = [];
  const drawer = makeDrawer(element, {
    names: {
      get: () => null,
      row: () => null,
      load: async () => { throw failure; },
    },
    data: {
      rankOf: () => null,
      entity: async () => null,
      factsFor: async () => ({
        items: [{
          kind: "RELATES_TO",
          ref: 1,
          multiplicity: 1,
          source: selfKey,
          target: otherKey,
          relationType: 1,
          sortOrder: 0,
        }],
        total: 1,
        next: null,
      }),
      mappings: async () => ({
        fact_labels: { RELATES_TO: { "1": "续集" } },
        subject_type: {},
        platform: {},
        person_type: {},
        character_role: {},
        episode_type: {},
      }),
    },
    reportError: (context: string, error: unknown) =>
      failures.push([context, error]),
  } as unknown as Partial<DrawerDeps>);

  try {
    state.selection = 0;
    await drawer.show(0, selfKey, relationRanks.promise);
    element.clickTarget({ tab: "relations" });

    relationRanks.resolve(new Map([[otherKey, 7]]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const current = Reflect.get(drawer, "cur") as {
      relationRankState: string;
    };
    assert.equal(current.relationRankState, "ready");
    assert.match(element.innerHTML, /续集/);
    assert.match(element.innerHTML, /#7/);
    assert.doesNotMatch(element.innerHTML, /关联暂时加载失败/);
    assert.doesNotMatch(element.innerHTML, /aria-disabled="true"/);
    assert.deepEqual(failures, [["关系名称加载", failure]]);
  } finally {
    state.selection = previousSelection;
  }
});

test("does not explain unresolved references when the node has no relation records", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const renderRelations = Reflect.get(drawer, "renderRelations") as (
    current: unknown,
  ) => string;
  const markup = renderRelations.call(drawer, {
    rank: 0,
    key: (1 << 24) | 1,
    mappings: { fact_labels: {} },
    facts: [],
    relationRanks: new Map(),
    factsTotal: 0,
    factsNext: null,
    relationsLoading: false,
    expanded: false,
  });

  assert.match(markup, /<strong>暂无关联<\/strong>/);
  assert.doesNotMatch(markup, /<span>/);
  assert.doesNotMatch(markup, /未解析引用|错误跳转/);
});

test("distinguishes unavailable relation targets from an actually empty node", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const selfKey = (1 << 24) | 1;
  const missingKey = (1 << 24) | 2;
  const renderRelations = Reflect.get(drawer, "renderRelations") as (
    current: unknown,
  ) => string;
  const markup = renderRelations.call(drawer, {
    rank: 0,
    key: selfKey,
    mappings: { fact_labels: { RELATES_TO: { "1": "续集" } } },
    facts: [{
      kind: "RELATES_TO",
      ref: 1,
      multiplicity: 1,
      source: selfKey,
      target: missingKey,
      relationType: 1,
      sortOrder: 0,
    }],
    relationRanks: new Map(),
    factsTotal: 1,
    factsNext: null,
    relationsLoading: false,
    expanded: false,
  });

  assert.match(markup, /暂无可打开的关联/);
  assert.match(markup, /1 条关联未收录/);
  assert.doesNotMatch(markup, /无法打开/);
  assert.doesNotMatch(markup, /错误跳转/);
});

test("does not repeat an empty relation state while another page is available", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const selfKey = (1 << 24) | 1;
  const missingKey = (1 << 24) | 2;
  const renderRelations = Reflect.get(drawer, "renderRelations") as (
    current: unknown,
  ) => string;
  const markup = renderRelations.call(drawer, {
    rank: 0,
    key: selfKey,
    mappings: { fact_labels: { RELATES_TO: { "1": "续集" } } },
    facts: [{
      kind: "RELATES_TO",
      ref: 1,
      multiplicity: 1,
      source: selfKey,
      target: missingKey,
      relationType: 1,
      sortOrder: 0,
    }],
    relationRanks: new Map(),
    relationRankState: "ready",
    factsTotal: 2,
    factsNext: "next-page",
    relationsLoading: false,
    expanded: false,
  });

  assert.equal(markup.match(/暂无可打开的关联/g)?.length, 1);
  assert.match(markup, /继续加载 · 1 \/ 2/);
});

test("uses direct loading and source-fallback copy", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const renderRelations = Reflect.get(drawer, "renderRelations") as (
    current: unknown,
  ) => string;
  const renderEpisodes = Reflect.get(drawer, "renderEpisodes") as (
    current: unknown,
  ) => string;
  const renderReference = Reflect.get(drawer, "renderReference") as (
    current: unknown,
  ) => string;

  assert.match(renderRelations.call(drawer, {
    factsTotal: 1,
    relationRankState: "ready",
    relationsLoading: true,
  }), /正在加载关联/);
  assert.doesNotMatch(renderRelations.call(drawer, {
    factsTotal: 1,
    relationRankState: "ready",
    relationsLoading: true,
  }), /准备关系名称/);
  assert.match(renderEpisodes.call(drawer, {
    loading: false,
    eps: null,
  }), /正在加载分集/);
  assert.doesNotMatch(renderEpisodes.call(drawer, {
    loading: false,
    eps: null,
  }), /准备分集数据/);
  const reference = renderReference.call(drawer, {
    infobox: { s: "ready", text: "free-form source", shown: 10_000 },
  });
  assert.match(reference, /第 1 行无法整理/);
  assert.doesNotMatch(reference, /仍完整保留/);
});

test("labels a paged relation action as continuation from the first page", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const selfKey = (1 << 24) | 1;
  const otherKey = (1 << 24) | 2;
  const renderRelations = Reflect.get(drawer, "renderRelations") as (
    current: unknown,
  ) => string;
  const markup = renderRelations.call(drawer, {
    rank: 0,
    key: selfKey,
    mappings: { fact_labels: { RELATES_TO: { "1": "续集" } } },
    facts: [{
      kind: "RELATES_TO",
      ref: 1,
      multiplicity: 1,
      source: selfKey,
      target: otherKey,
      relationType: 1,
      sortOrder: 0,
    }],
    relationRanks: new Map([[otherKey, 7]]),
    relationRankState: "ready",
    factsTotal: 2,
    factsNext: "next-page",
    relationsLoading: false,
    expanded: false,
  });

  assert.match(markup, /继续加载 · 1 \/ 2/);
  assert.doesNotMatch(markup, /显示全部 · 2 条/);
});

test("keeps a loaded relation page usable when its names fail to load", async () => {
  const element = new FakeDrawerElement();
  const selfKey = (1 << 24) | 1;
  const firstKey = (1 << 24) | 2;
  const secondKey = (1 << 24) | 3;
  const failure = new Error("name pack unavailable");
  const failures: [string, unknown][] = [];
  const drawer = makeDrawer(element, {
    names: {
      get: () => null,
      row: () => null,
      load: async () => { throw failure; },
    },
    data: {
      factsFor: async (_key: number, page: string | null = null) => {
        assert.equal(page, "next-page");
        return {
          items: [{
            kind: "RELATES_TO" as const,
            ref: 2,
            multiplicity: 1,
            source: selfKey,
            target: secondKey,
            relationType: 1,
            sortOrder: 1,
          }],
          total: 2,
          next: null,
        };
      },
    },
    reportError: (context: string, error: unknown) =>
      failures.push([context, error]),
  } as unknown as Partial<DrawerDeps>);
  const current = {
    rank: 0,
    key: selfKey,
    mappings: { fact_labels: { RELATES_TO: { "1": "续集" } } },
    facts: [{
      kind: "RELATES_TO" as const,
      ref: 1,
      multiplicity: 1,
      source: selfKey,
      target: firstKey,
      relationType: 1,
      sortOrder: 0,
    }],
    relationRanks: new Map([[firstKey, 7], [secondKey, 8]]),
    relationRankState: "ready",
    factsTotal: 2,
    factsNext: "next-page",
    relationsLoading: false,
    relationsLoaded: true,
    expanded: false,
    loading: false,
  };
  Reflect.set(drawer, "cur", current);
  Reflect.set(drawer, "rerender", () => undefined);
  const expandRelations = Reflect.get(drawer, "expandRelations") as (
    anchor: null,
  ) => Promise<void>;

  await expandRelations.call(drawer, null);

  assert.equal(current.facts.length, 2);
  assert.equal(current.factsNext, null);
  assert.deepEqual(failures, [["关系名称加载", failure]]);
  const renderRelations = Reflect.get(drawer, "renderRelations") as (
    value: unknown,
  ) => string;
  const markup = renderRelations.call(drawer, current);
  assert.match(markup, /#7/);
  assert.match(markup, /#8/);
  assert.doesNotMatch(markup, /关联节点|条记录|单击节点|已合并重复项/);
});

test("deduplicates navigation entries without explaining internal bookkeeping", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const selfKey = (1 << 24) | 1;
  const otherKey = (2 << 24) | 2;
  const fact = {
    kind: "WORKED_ON",
    multiplicity: 1,
    subject: selfKey,
    person: otherKey,
    position: 23,
  };
  const current = {
    rank: 0,
    key: selfKey,
    mappings: {
      fact_labels: { WORKED_ON: { "23": "助理制片人", "53": "助理制片人" } },
    },
    facts: [
      { ...fact, ref: 1 },
      { ...fact, ref: 2, position: 53 },
    ],
    relationRanks: new Map([[otherKey, 7]]),
    factsTotal: 2,
    factsNext: null,
    relationsLoading: false,
    expanded: false,
  };
  const renderRelations = Reflect.get(drawer, "renderRelations") as (
    current: unknown,
  ) => string;
  const renderTabs = Reflect.get(drawer, "renderTabs") as (
    current: unknown,
  ) => string;
  const markup = renderRelations.call(drawer, current);

  assert.equal(markup.match(/data-rank="7"/g)?.length, 1);
  assert.doesNotMatch(markup, /关联节点|条记录|单击节点|已合并重复项/);
  assert.doesNotMatch(markup, /id="expand-rel"/);
  assert.match(renderTabs.call(drawer, current), /关联 2/);
});

test("counts one node once when it appears in different relationship groups", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const selfKey = (1 << 24) | 1;
  const otherKey = (2 << 24) | 2;
  const current = {
    rank: 0,
    key: selfKey,
    mappings: {
      fact_labels: { WORKED_ON: { "23": "导演", "24": "原作" } },
    },
    facts: [
      {
        kind: "WORKED_ON",
        ref: 1,
        multiplicity: 1,
        subject: selfKey,
        person: otherKey,
        position: 23,
      },
      {
        kind: "WORKED_ON",
        ref: 2,
        multiplicity: 1,
        subject: selfKey,
        person: otherKey,
        position: 24,
      },
    ],
    relationRanks: new Map([[otherKey, 7]]),
    factsTotal: 2,
    factsNext: null,
    relationsLoading: false,
    expanded: false,
  };
  const renderRelations = Reflect.get(drawer, "renderRelations") as (
    current: unknown,
  ) => string;
  const markup = renderRelations.call(drawer, current);

  assert.equal(markup.match(/data-rank="7"/g)?.length, 2);
  assert.doesNotMatch(markup, /关联节点|条记录|单击节点|已合并重复项/);
});

test("decodes character references in summaries and episode text without enabling markup", () => {
  const drawer = makeDrawer(new FakeDrawerElement());
  const renderSummary = Reflect.get(drawer, "renderSummary") as (
    current: unknown,
  ) => string;
  const summary = renderSummary.call(drawer, {
    entity: { hasSummary: true },
    summary: {
      s: "ready",
      text: "キャラ&amp;ストーリー &lt;script&gt;x&lt;/script&gt; &Bass;",
      shown: 10_000,
    },
    summaryOpen: false,
  });

  assert.match(summary, /キャラ&amp;ストーリー/);
  assert.doesNotMatch(summary, /&amp;amp;/);
  assert.match(summary, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(summary, /<script>/);
  assert.match(summary, /&amp;Bass;/);

  const episodeRow = Reflect.get(drawer, "episodeRow") as (
    current: unknown,
    episode: unknown,
  ) => string;
  const episode = episodeRow.call(drawer, {
    descs: new Map([[9, {
      s: "ready",
      text: "介绍&amp;补充",
      shown: 10_000,
    }]]),
  }, {
    id: 9,
    name: "Title&amp;Story",
    nameCn: "标题&amp;故事",
    airdate: "",
    sort: 1,
    hasDescription: true,
  });

  assert.match(episode, /标题&amp;故事/);
  assert.match(episode, /介绍&amp;补充/);
  assert.doesNotMatch(episode, /&amp;amp;/);
});

test("loads summary eagerly but defers episodes and reference by tab", async () => {
  const originalSelection = state.selection;
  const element = new FakeDrawerElement();
  const reads: string[] = [];
  const key = (1 << 24) | 1;
  const drawer = makeDrawer(element, {
    data: {
      entity: async () => ({
        kind: "subject",
        key,
        name: "Example",
        nameCn: "示例",
        type: 2,
        platformCode: null,
        date: "",
        score: null,
        bgmRank: null,
        nsfw: false,
        favorite: [0, 0, 0, 0, 0],
        series: false,
        scoreDetails: [],
        metaTags: [],
        tags: [],
        hasSummary: true,
        hasInfobox: true,
      }),
      factsFor: async () => ({ items: [], total: 0, next: null }),
      mappings: async () => ({
        fact_labels: {}, subject_type: {}, platform: {},
        person_type: {}, character_role: {}, episode_type: {},
      }),
      longText: async (ref: { kind: string }) => {
        reads.push(ref.kind);
        return { kind: "present", text: "loaded" };
      },
      episodesFor: async () => {
        reads.push("episodes");
        return { items: [], total: 0, next: null };
      },
      rankOf: () => null,
    },
  } as unknown as Partial<DrawerDeps>);

  try {
    state.selection = 0;
    await drawer.show(0, key, new Map());
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(reads, ["entity-summary"]);

    element.clickTarget({ tab: "episodes" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(reads, ["entity-summary", "episodes"]);

    element.clickTarget({ tab: "reference" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(reads, [
      "entity-summary", "episodes", "entity-infobox",
    ]);
  } finally {
    state.selection = originalSelection;
  }
});

test("opens the owning subject directly on a requested episode", async () => {
  const originalSelection = state.selection;
  const element = new FakeDrawerElement();
  const key = (1 << 24) | 1;
  const drawer = makeDrawer(element, {
    data: {
      entity: async () => ({
        kind: "subject", key, name: "Work", nameCn: "作品", type: 2,
        platformCode: null, date: "", score: null, bgmRank: null,
        nsfw: false, favorite: [0, 0, 0, 0, 0], series: false,
        scoreDetails: [], metaTags: [], tags: [], hasSummary: false,
        hasInfobox: false,
      }),
      factsFor: async () => ({ items: [], total: 0, next: null }),
      mappings: async () => ({
        fact_labels: {}, subject_type: {}, platform: {}, person_type: {},
        character_role: {}, episode_type: {},
      }),
      episodesFor: async () => ({
        items: [{
          id: 42, subject: key, name: "Episode", nameCn: "目标分集",
          airdate: "", disc: 0, duration: "", sort: 3, type: 0,
          hasDescription: false,
        }],
        total: 1,
        next: null,
      }),
      rankOf: () => null,
    },
  } as unknown as Partial<DrawerDeps>);

  try {
    state.selection = 0;
    await drawer.show(0, key, new Map(), 42);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.match(element.innerHTML, /dossier-tab-episodes/);
    assert.match(element.innerHTML, /data-episode-row="42"/);
    assert.match(element.focusedEpisode, /42/);
  } finally {
    state.selection = originalSelection;
  }
});
