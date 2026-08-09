import assert from "node:assert/strict";
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

test("separates typed connections from the overview scroll", () => {
  const element = new FakeDrawerElement();
  const otherRank = 7;
  const otherKey = (1 << 24) | 2;
  const drawer = makeDrawer(element, {
    data: {
      rankOf: (key: number) => key === otherKey ? otherRank : null,
    },
  } as Partial<DrawerDeps>);
  Reflect.set(drawer, "cur", {
    rank: 0,
    key: (1 << 24) | 1,
    entity: null,
    mappings: {
      fact_labels: { RELATES_TO: { "1": "续集" } },
      subject_type: {},
      platform: {},
      person_type: {},
      character_role: {},
      episode_type: {},
    },
    facts: [{
      kind: "RELATES_TO",
      ref: 1,
      multiplicity: 1,
      source: (1 << 24) | 1,
      target: otherKey,
      relationType: 1,
      sortOrder: 0,
    }],
    factsTotal: 1,
    factsNext: null,
    tab: "overview",
    relationsLoading: false,
    expanded: false,
    loading: false,
    eps: null,
    epsTotal: 0,
    epsNext: null,
    epsExpanded: false,
    summary: { s: "idle" },
    summaryOpen: false,
    infobox: { s: "idle" },
    descs: new Map(),
  });
  const rerender = Reflect.get(drawer, "rerender") as () => void;

  rerender.call(drawer);
  assert.doesNotMatch(element.innerHTML, /作品谱系/);
  assert.doesNotMatch(element.innerHTML, /节点 7/);

  Reflect.get(drawer, "cur").tab = "relations";
  rerender.call(drawer);
  assert.match(element.innerHTML, /作品谱系/);
  assert.match(element.innerHTML, /续集/);
  assert.match(element.innerHTML, /节点 7/);
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
    await drawer.show(0, key);
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
    await drawer.show(0, key, 42);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.match(element.innerHTML, /dossier-tab-episodes/);
    assert.match(element.innerHTML, /data-episode-row="42"/);
    assert.match(element.focusedEpisode, /42/);
  } finally {
    state.selection = originalSelection;
  }
});
