import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  findSubstringEntries,
  highlightMatch,
  matchingAliasEntry,
  rankSearchEntries,
  Search,
  searchNameSuggestions,
} from "../src/search";
import type { SearchDependencies } from "../src/search";
import type {
  NameRow,
  SearchAliases,
  SearchAliasRow,
  SearchEntry,
} from "../src/types";

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  value = "";
  innerHTML = "";
  textContent = "";
  hidden = true;
  disabled = false;
  blurCount = 0;
  scrollCount = 0;
  lastSelector = "";
  private attributes = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
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

  blur(): void {
    this.blurCount++;
  }

  focus(): void {}

  querySelector<T extends Element = Element>(selector: string): T | null {
    this.lastSelector = selector;
    return {
      scrollIntoView: () => this.scrollCount++,
    } as unknown as T;
  }
}

const originalDocument = globalThis.document;
const emptyNames: SearchAliases = {
  row: () => null,
  load: async () => undefined,
  read: async () => new Map(),
};

function aliasesFromNames(rows: Map<number, NameRow>): SearchAliases {
  const row = (rank: number): SearchAliasRow | null => {
    const source = rows.get(rank);
    if (!source) return null;
    const [name, nameCn, kind] = source;
    const aliases = [...new Set([nameCn, name].filter(Boolean))].map(
      (text) => [text, text] as [string, string],
    );
    return [aliases, nameCn || name, kind];
  };
  return {
    row,
    load: async () => undefined,
    read: async (requested) => new Map(
      [...requested].flatMap((rank) => {
        const value = row(rank);
        return value ? [[rank, value] as const] : [];
      }),
    ),
  };
}

function elements(): {
  box: FakeElement;
  panel: FakeElement;
  list: FakeElement;
  status: FakeElement;
  more: FakeElement;
} {
  return {
    box: new FakeElement(),
    panel: new FakeElement(),
    list: new FakeElement(),
    status: new FakeElement(),
    more: new FakeElement(),
  };
}

const immediateDependencies: SearchDependencies = {
  loadCharmap: async () => undefined,
  loadSearchDir: async () => ({}),
  searchMember: async () => [],
  searchSubstringPage: async () => ({ ranks: [], next: null }),
  substringDelayMs: 0,
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { addEventListener: () => undefined, activeElement: null },
  });
});

afterEach(() => {
  if (originalDocument === undefined)
    Reflect.deleteProperty(globalThis, "document");
  else
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
});

test("selects the published alias containing the normalized query", () => {
  const row: SearchAliasRow = [
    [
      ["空之境界", "空之境界"],
      ["kara no kyoukai", "Kara no Kyoukai"],
    ],
    "空之境界",
    1,
  ];

  assert.deepEqual(matchingAliasEntry("之境", row, 42), [
    "空之境界",
    "空之境界",
    42,
    "空之境界",
    1,
  ]);
  assert.equal(matchingAliasEntry("月姬", row, 42), null);
});

test("ranks exact matches first and lets popular substring matches compete", () => {
  const results = rankSearchEntries("境界", [
    ["境界线", "境界线", 40, "境界线", 3],
    ["空之境界", "空之境界", 1, "空之境界", 1],
    ["境界", "境界", 900, "境界", 2],
    ["境界", "境界", 900, "境界", 2],
  ]);

  assert.deepEqual(
    results.map((result) => [result.rank, result.match, result.matched]),
    [
      [900, "exact", "境界"],
      [1, "substring", "空之境界"],
      [40, "prefix", "境界线"],
    ],
  );
});

test("highlights only escaped source text that corresponds to the query", () => {
  assert.equal(
    highlightMatch('<img src=x>空之境界', "之境"),
    "&lt;img src=x&gt;空<mark>之境</mark>界",
  );
  assert.equal(highlightMatch("Kara no Kyoukai", "境界"), "Kara no Kyoukai");
});

test("filters hash collisions and continues substring candidate pages", async () => {
  const rows = new Map<number, NameRow>([
    [0, ["unrelated", null, 1]],
    [1, ["Kara no Kyoukai", "空之境界", 1]],
    [2, ["another collision", null, 2]],
    [3, ["Boundary", "境界線", 3]],
  ]);
  const names = aliasesFromNames(rows);
  const cursors: number[] = [];

  const page = await findSubstringEntries("境界", names, {
    loadPage: async (_query, cursor) => {
      cursors.push(cursor);
      return cursor === 0
        ? { ranks: [0, 1, 2], next: 3 }
        : { ranks: [3], next: null };
    },
  });

  assert.deepEqual(page.entries, [
    ["空之境界", "空之境界", 1, "空之境界", 1],
    ["境界線", "境界線", 3, "境界線", 3],
  ]);
  assert.equal(page.next, null);
  assert.equal(page.scannedThroughRank, 3);
  assert.deepEqual(cursors, [0, 3]);
});

test("bounds collision scanning and returns the next candidate cursor", async () => {
  const total = 1_000;
  const names: SearchAliases = {
    row: () => [[[
      "unrelated",
      "unrelated",
    ]], "unrelated", 1],
    load: async () => undefined,
    read: async (ranks) => new Map(
      [...ranks].map((rank) => [
        rank,
        [[[
          "unrelated",
          "unrelated",
        ]], "unrelated", 1],
      ]),
    ),
  };
  const requests: Array<[number, number]> = [];

  const page = await findSubstringEntries("ererer", names, {
    loadPage: async (_query, cursor, limit) => {
      requests.push([cursor, limit]);
      const ranks = Array.from(
        { length: Math.min(limit, total - cursor) },
        (_, index) => cursor + index,
      );
      return { ranks, next: cursor + ranks.length < total
        ? cursor + ranks.length
        : null };
    },
  });

  assert.deepEqual(page, {
    entries: [],
    next: 64,
    scannedThroughRank: 63,
  });
  assert.deepEqual(requests, [[0, 64]]);
});

test("treats a missing alias row after load as a contract failure", async () => {
  await assert.rejects(
    findSubstringEntries("ab", emptyNames, {
      loadPage: async () => ({ ranks: [0], next: null }),
    }),
    /search alias row 0.*missing after load/,
  );
});

test("validates substring candidates from one stable alias snapshot", async () => {
  const ranks = Array.from({ length: 64 }, (_, rank) => rank);
  const aliases: SearchAliases = {
    row: () => null,
    load: async () => {
      throw new Error("legacy cache lookup should not be used");
    },
    read: async (requested) => new Map(
      [...requested].map((rank) => [
        rank,
        [[[`ab ${rank}`, `ab ${rank}`]], `ab ${rank}`, 1],
      ]),
    ),
  };

  const page = await findSubstringEntries("ab", aliases, {
    loadPage: async () => ({ ranks, next: null }),
  });

  assert.deepEqual(page.entries.map((entry) => entry[2]), ranks);
});

test("returns every match from one bounded candidate batch", async () => {
  const rows = new Map<number, NameRow>(
    Array.from({ length: 70 }, (_, rank) => [
      rank,
      [`ab ${rank}`, null, 1] as NameRow,
    ]),
  );
  const names = aliasesFromNames(rows);
  const loadPage = async (
    _query: string,
    cursor: number,
    limit: number,
  ): Promise<{ ranks: number[]; next: number | null }> => ({
    ranks: [...rows.keys()].slice(cursor, cursor + limit),
    next: cursor + limit < rows.size ? cursor + limit : null,
  });

  const first = await findSubstringEntries("ab", names, {
    loadPage,
  });
  const second = await findSubstringEntries("ab", names, {
    cursor: first.next ?? 0,
    loadPage,
  });

  assert.equal(first.entries.length, 64);
  assert.equal(first.next, 64);
  assert.equal(first.scannedThroughRank, 63);
  assert.deepEqual(second.entries.map((entry) => entry[2]), [64, 65, 66, 67, 68, 69]);
  assert.equal(second.next, null);
  assert.equal(second.scannedThroughRank, 69);
});

test("requests only unconsumed substring candidates", async () => {
  const rows = new Map<number, NameRow>(
    Array.from({ length: 70 }, (_, rank) => [
      rank,
      [`ab ${rank}`, null, 1] as NameRow,
    ]),
  );
  const names = aliasesFromNames(rows);
  const requests: Array<[number, number]> = [];
  const loadPage = async (
    _query: string,
    cursor: number,
    limit: number,
  ): Promise<{ ranks: number[]; next: number | null }> => {
    requests.push([cursor, limit]);
    const ranks = [...rows.keys()].slice(cursor, cursor + limit);
    const next = cursor + ranks.length < rows.size
      ? cursor + ranks.length
      : null;
    return { ranks, next };
  };

  const first = await findSubstringEntries("ab", names, {
    loadPage,
  });
  const second = await findSubstringEntries("ab", names, {
    cursor: first.next ?? 0,
    loadPage,
  });

  assert.deepEqual(first.entries.map((entry) => entry[2]), [...rows.keys()].slice(0, 64));
  assert.deepEqual(second.entries.map((entry) => entry[2]), [...rows.keys()].slice(64));
  assert.deepEqual(requests, [[0, 64], [64, 64]]);
});

test("rejects an empty substring page whose cursor does not advance", async () => {
  let calls = 0;
  await assert.rejects(
    findSubstringEntries("ab", emptyNames, {
      loadPage: async () => {
        calls++;
        if (calls > 1) throw new Error("helper looped");
        return { ranks: [], next: 0 };
      },
    }),
    /cursor did not advance/,
  );
});

test("forwards substring cancellation to candidate name loading", async () => {
  let loadStarted = false;
  let receivedSignal: AbortSignal | undefined;
  const names: SearchAliases = {
    row: () => null,
    load: async (_ranks, signal?: AbortSignal) => {
      signal?.throwIfAborted();
    },
    read: async (_ranks, signal?: AbortSignal) => {
      loadStarted = true;
      receivedSignal = signal;
      if (!signal) throw new Error("missing AbortSignal");
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  };
  const controller = new AbortController();
  const pending = findSubstringEntries("境界", names, {
    loadPage: async () => ({ ranks: [1], next: null }),
    signal: controller.signal,
  });
  const rejected = assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  await waitFor(() => loadStarted);
  controller.abort();

  await rejected;
  assert.equal(receivedSignal, controller.signal);
});

test("builds compact name suggestions from the published index and current scope", async () => {
  const aliases = aliasesFromNames(new Map<number, NameRow>([
    [0, ["x-ab-work", null, 1]],
    [1, ["x-ab-person", null, 2]],
    [2, ["x-ab-character", null, 3]],
  ]));
  const results = await searchNameSuggestions("ab", aliases, {
    limit: 3,
    entityKinds: [1, 3],
    dependencies: {
      ...immediateDependencies,
      loadSearchDir: async () => ({ ab: { l: [0, 1] } }),
      searchMember: async () => [
        ["ab prefix", "ab prefix", 8, "ab prefix", 1],
      ],
      searchSubstringPage: async () => ({ ranks: [0, 1, 2], next: null }),
    },
  });

  assert.deepEqual(results.map((result) => [result.rank, result.entityKind]), [
    [0, 1],
    [8, 1],
    [2, 3],
  ]);
});

test("keeps one-character suggestions on the compact prefix projection", async () => {
  let substringReads = 0;
  const results = await searchNameSuggestions("a", emptyNames, {
    limit: 5,
    entityKinds: [1, 2, 3],
    dependencies: {
      ...immediateDependencies,
      loadSearchDir: async () => ({ a: { t: [0, 1] } }),
      searchMember: async () => [
        ["anime", "anime", 4, "Anime", 1],
      ],
      searchSubstringPage: async () => {
        substringReads++;
        return { ranks: [], next: null };
      },
    },
  });

  assert.equal(substringReads, 0);
  assert.deepEqual(results.map((result) => result.display), ["Anime"]);
});

test("closes stale suggestions when search loses focus", () => {
  const { box, panel, list, status, more } = elements();
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    immediateDependencies,
  );
  list.innerHTML = "<div>旧结果</div>";
  status.textContent = "旧状态";
  panel.hidden = false;
  box.setAttribute("aria-expanded", "true");
  box.setAttribute("aria-activedescendant", "search-hit-0");

  box.emit("blur");

  assert.equal(list.innerHTML, "");
  assert.equal(status.textContent, "");
  assert.equal(panel.hidden, true);
  assert.equal(box.getAttribute("aria-expanded"), "false");
  assert.equal(box.getAttribute("aria-activedescendant"), null);
});

test("keeps suggestions open while focus moves to the more button", () => {
  const { box, panel, list, status, more } = elements();
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    immediateDependencies,
  );
  list.innerHTML = "<div>现有结果</div>";
  panel.hidden = false;

  box.emit("blur", { relatedTarget: more });
  assert.equal(panel.hidden, false);
  assert.equal(list.innerHTML, "<div>现有结果</div>");

  more.emit("blur");
  assert.equal(panel.hidden, true);
});

test("does not invent an active option when the result list is empty", () => {
  const { box, panel, list, status, more } = elements();
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    immediateDependencies,
  );

  box.emit("keydown", {
    key: "ArrowDown",
    preventDefault: () => undefined,
  });

  assert.equal(box.getAttribute("aria-activedescendant"), null);
});

test("renders a primary name, entity kind, matched alias, and highlight", async () => {
  const { box, panel, list, status, more } = elements();
  const dependencies: SearchDependencies = {
    ...immediateDependencies,
    loadSearchDir: async () => ({ k: { l: [0, 1] } }),
    searchMember: async () => [
      ["kara no kyoukai", "Kara no Kyoukai", 42, "空之境界", 1],
    ],
  };
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    dependencies,
  );

  box.value = "Kara";
  box.emit("input");
  await waitFor(() => list.innerHTML.includes("空之境界"));

  assert.equal(panel.hidden, false);
  assert.match(list.innerHTML, /作品/);
  assert.match(list.innerHTML, /匹配：<mark>Kara<\/mark> no Kyoukai/);
});

test("keeps the first batch compact and loads every remaining result", async () => {
  const { box, panel, list, status, more } = elements();
  const rows = new Map<number, NameRow>(
    Array.from({ length: 5 }, (_, rank) => [
      rank,
      [`ab ${rank}`, null, 1] as NameRow,
    ]),
  );
  const cursors: number[] = [];
  const names = aliasesFromNames(rows);
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    names,
    2,
    () => {},
    {
      ...immediateDependencies,
      searchSubstringPage: async (_query, cursor, limit) => {
        cursors.push(cursor);
        const ranks = [...rows.keys()].slice(cursor, cursor + limit);
        return {
          ranks,
          next: cursor + ranks.length < rows.size
            ? cursor + ranks.length
            : null,
        };
      },
    },
  );

  box.value = "ab";
  box.emit("input");
  await waitFor(() => status.textContent === "显示最相关的 2 个结果");
  assert.equal((list.innerHTML.match(/data-rank=/g) ?? []).length, 2);
  assert.equal(more.hidden, false);

  more.emit("click");
  await waitFor(() => status.textContent === "显示最相关的 4 个结果");
  assert.equal((list.innerHTML.match(/data-rank=/g) ?? []).length, 4);

  more.emit("click");
  await waitFor(() => status.textContent === "共 5 个结果");
  assert.equal((list.innerHTML.match(/data-rank=/g) ?? []).length, 5);
  assert.equal(more.hidden, true);
  assert.deepEqual(cursors, [0]);
});

test("paginates every exact one-character result", async () => {
  const { box, panel, list, status, more } = elements();
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    2,
    () => {},
    {
      ...immediateDependencies,
      loadSearchDir: async () => ({ a: { t: [0, 1] } }),
      searchMember: async () => [
        ["a", "a", 0, "a", 1],
        ["a", "a", 1, "a", 2],
        ["a", "a", 2, "a", 3],
      ],
    },
  );

  box.value = "a";
  box.emit("input");
  await waitFor(() => status.textContent.includes("再输入一个字"));
  assert.equal((list.innerHTML.match(/data-rank=/g) ?? []).length, 2);
  assert.equal(more.hidden, false);

  more.emit("click");
  await waitFor(() => (list.innerHTML.match(/data-rank=/g) ?? []).length === 3);
  assert.equal(more.hidden, true);
  assert.equal(
    status.textContent,
    "显示最相关的 3 个开头建议；再输入一个字可搜索名称中间",
  );
});

test("bounds the suggestion list and asks for a narrower query", async () => {
  const { box, panel, list, status, more } = elements();
  const rows = new Map<number, NameRow>(
    Array.from({ length: 100 }, (_, rank) => [
      rank,
      [`ab ${rank}`, null, 1] as NameRow,
    ]),
  );
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    aliasesFromNames(rows),
    12,
    () => {},
    {
      ...immediateDependencies,
      searchSubstringPage: async (_query, cursor, limit) => {
        const ranks = [...rows.keys()].slice(cursor, cursor + limit);
        return {
          ranks,
          next: cursor + ranks.length < rows.size
            ? cursor + ranks.length
            : null,
        };
      },
    },
  );

  box.value = "ab";
  box.emit("input");
  for (const expected of [12, 24, 36, 48, 60]) {
    await waitFor(
      () => (list.innerHTML.match(/data-rank=/g) ?? []).length === expected,
    );
    if (expected < 60) more.emit("click");
  }

  assert.equal(more.hidden, true);
  assert.match(status.textContent, /继续输入可缩小范围/);
});

test("lets a hotter substring compete after prefix results fill the cap", async () => {
  const { box, panel, list, status, more } = elements();
  const substringRank = 0;
  const aliases: SearchAliases = {
    row: (rank) => rank === substringRank
      ? [[["x-ab-y", "x-ab-y"]], "x-ab-y", 1]
      : null,
    load: async () => undefined,
    read: async (ranks) => new Map(
      [...ranks].flatMap((rank) => rank === substringRank
        ? [[rank, [[["x-ab-y", "x-ab-y"]], "x-ab-y", 1]] as const]
        : []),
    ),
  };
  const prefixEntries: SearchEntry[] = Array.from(
    { length: 60 },
    (_, index) => {
      const rank = index + 100;
      const value = `ab prefix ${rank}`;
      return [value, value, rank, value, 1];
    },
  );
  let substringReads = 0;
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    aliases,
    12,
    () => {},
    {
      ...immediateDependencies,
      loadSearchDir: async () => ({ ab: { l: [0, 1] } }),
      searchMember: async () => prefixEntries,
      searchSubstringPage: async () => {
        substringReads++;
        return { ranks: [substringRank], next: null };
      },
    },
  );

  box.value = "ab";
  box.emit("input");
  await waitFor(() => status.getAttribute("aria-busy") === "false");

  assert.equal(substringReads, 1);
  assert.match(list.innerHTML, /data-rank="0"/);
});

test("keeps scanning at the cap while an unseen rank can enter top K", async () => {
  const { box, panel, list, status, more } = elements();
  const rows = new Map<number, NameRow>(
    Array.from({ length: 65 }, (_, rank) => [
      rank,
      [rank === 64 ? "x-ab-y" : `collision ${rank}`, null, 1] as NameRow,
    ]),
  );
  const prefixEntries: SearchEntry[] = Array.from(
    { length: 60 },
    (_, index) => {
      const rank = index + 1_000;
      const value = `ab prefix ${rank}`;
      return [value, value, rank, value, 1];
    },
  );
  let reads = 0;
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    aliasesFromNames(rows),
    60,
    () => {},
    {
      ...immediateDependencies,
      loadSearchDir: async () => ({ ab: { l: [0, 1] } }),
      searchMember: async () => prefixEntries,
      searchSubstringPage: async () => {
        reads++;
        return reads === 1
          ? {
            ranks: Array.from({ length: 64 }, (_, rank) => rank),
            next: 64,
          }
          : { ranks: [64], next: null };
      },
    },
  );

  box.value = "ab";
  box.emit("input");
  await waitFor(() => more.textContent === "继续查找");
  assert.match(status.textContent, /当前找到的 60/);

  more.emit("click");
  await waitFor(() => list.innerHTML.includes('data-rank="64"'));
  assert.equal(reads, 2);
});

test("aborts the complete stale query, including its prefix member", async () => {
  const { box, panel, list, status, more } = elements();
  let staleSignal: AbortSignal | undefined;
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    {
      ...immediateDependencies,
      loadSearchDir: async () => ({
        a: { l: [0, 1] },
        b: { l: [1, 1] },
      }),
      searchMember: async (loc, signal) => {
        if (loc[0] === 1) return [];
        staleSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    },
  );

  box.value = "a";
  box.emit("input");
  await waitFor(() => staleSignal !== undefined);
  box.value = "b";
  box.emit("input");
  await waitFor(() => status.textContent.includes("再输入一个字"));

  assert.equal(staleSignal?.aborted, true);
});

test("keeps the more button focusable while loading", async () => {
  const { box, panel, list, status, more } = elements();
  const rows = new Map<number, NameRow>(
    Array.from({ length: 65 }, (_, rank) => [
      rank,
      [
        rank === 0 ? "ab zero" : rank === 64 ? "ab one" : `collision ${rank}`,
        null,
        1,
      ] as NameRow,
    ]),
  );
  let resolveMore: ((page: { ranks: number[]; next: null }) => void) | undefined;
  let calls = 0;
  const names = aliasesFromNames(rows);
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    names,
    1,
    () => {},
    {
      ...immediateDependencies,
      searchSubstringPage: async () => {
        calls++;
        if (calls === 1)
          return {
            ranks: Array.from({ length: 64 }, (_, rank) => rank),
            next: 64,
          };
        return new Promise((resolve) => (resolveMore = resolve));
      },
    },
  );

  box.value = "ab";
  box.emit("input");
  await waitFor(() => more.hidden === false);
  more.emit("click");

  assert.equal(more.disabled, false);
  assert.equal(more.getAttribute("aria-disabled"), "true");
  assert.equal(panel.hidden, false);
  resolveMore?.({ ranks: [64], next: null });
  await waitFor(() => status.textContent === "共 2 个结果");
});

test("reveals buffered results before reading another candidate page", async () => {
  const { box, panel, list, status, more } = elements();
  const rows = new Map<number, NameRow>(
    Array.from({ length: 70 }, (_, rank) => [
      rank,
      [`ab ${rank}`, null, 1] as NameRow,
    ]),
  );
  let candidateReads = 0;
  const names = aliasesFromNames(rows);
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    names,
    2,
    () => {},
    {
      ...immediateDependencies,
      searchSubstringPage: async (_query, cursor, limit) => {
        candidateReads++;
        const ranks = [...rows.keys()].slice(cursor, cursor + limit);
        return {
          ranks,
          next: cursor + ranks.length < rows.size
            ? cursor + ranks.length
            : null,
        };
      },
    },
  );

  box.value = "ab";
  box.emit("input");
  await waitFor(() => status.textContent === "显示最相关的 2 个结果");
  assert.equal(candidateReads, 1);

  more.emit("click");
  await waitFor(() => status.textContent === "显示最相关的 4 个结果");
  assert.equal(candidateReads, 1);

  assert.equal(more.hidden, false);
});

test("exposes loading, one-character guidance, empty, and error states", async () => {
  let resolveCharmap: (() => void) | undefined;
  const charmapReady = new Promise<void>((resolve) => {
    resolveCharmap = resolve;
  });
  const first = elements();
  new Search(
    {
      box: first.box as unknown as HTMLInputElement,
      panel: first.panel as unknown as HTMLElement,
      list: first.list as unknown as HTMLElement,
      status: first.status as unknown as HTMLElement,
      more: first.more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    {
      ...immediateDependencies,
      loadCharmap: async () => charmapReady,
    },
  );

  first.box.value = "境";
  first.box.emit("input");
  assert.equal(first.status.textContent, "正在加载搜索索引…");
  assert.equal(first.status.getAttribute("aria-busy"), "true");
  resolveCharmap?.();
  await waitFor(() => first.status.textContent.includes("再输入一个字"));
  assert.match(first.status.textContent, /未找到开头匹配/);
  assert.equal(first.status.getAttribute("aria-busy"), "false");

  const empty = elements();
  new Search(
    {
      box: empty.box as unknown as HTMLInputElement,
      panel: empty.panel as unknown as HTMLElement,
      list: empty.list as unknown as HTMLElement,
      status: empty.status as unknown as HTMLElement,
      more: empty.more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    immediateDependencies,
  );
  empty.box.value = "境界";
  empty.box.emit("input");
  await waitFor(() => empty.status.textContent.startsWith("未找到"));

  const failed = elements();
  new Search(
    {
      box: failed.box as unknown as HTMLInputElement,
      panel: failed.panel as unknown as HTMLElement,
      list: failed.list as unknown as HTMLElement,
      status: failed.status as unknown as HTMLElement,
      more: failed.more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    {
      ...immediateDependencies,
      loadCharmap: async () => {
        throw new Error("private detail");
      },
    },
  );
  failed.box.value = "境界";
  failed.box.emit("input");
  await waitFor(() => failed.status.textContent.includes("加载失败"));
  assert.doesNotMatch(failed.status.textContent, /private detail/);
});

test("retries an initial index failure from the visible error action", async () => {
  const { box, panel, list, status, more } = elements();
  let attempts = 0;
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    {
      ...immediateDependencies,
      loadCharmap: async () => {
        attempts++;
        if (attempts === 1) throw new Error("temporary index failure");
      },
    },
  );

  box.value = "ab";
  box.emit("input");
  await waitFor(() => status.textContent.includes("加载失败"));
  assert.equal(more.hidden, false);
  assert.equal(more.textContent, "重试搜索");

  more.emit("click");
  await waitFor(() => status.textContent.startsWith("未找到"));
  assert.equal(attempts, 2);
});

test("does not resolve search prefixes through Object.prototype", async () => {
  const { box, panel, list, status, more } = elements();
  let memberReads = 0;
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    {
      ...immediateDependencies,
      searchMember: async () => {
        memberReads++;
        return [];
      },
    },
  );

  box.value = "constructor";
  box.emit("input");
  await waitFor(() => status.textContent.startsWith("未找到"));
  assert.equal(memberReads, 0);
});

test("keeps prefix results when substring enrichment fails", async () => {
  const { box, panel, list, status, more } = elements();
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    {
      ...immediateDependencies,
      loadSearchDir: async () => ({ "境界": { l: [0, 1] } }),
      searchMember: async () => [
        ["境界线", "境界线", 7, "境界线", 1],
      ],
      searchSubstringPage: async () => {
        throw new Error("substring unavailable");
      },
    },
  );

  box.value = "境界";
  box.emit("input");
  await waitFor(() => status.textContent.includes("加载失败"));

  assert.match(list.innerHTML, /<mark>境界<\/mark>线/);
  assert.equal(status.textContent, "更多结果加载失败，可继续使用现有结果");
  assert.equal(more.hidden, false);
  assert.equal(more.textContent, "重试加载更多");
});

test("retries a failed substring search without prefix results", async () => {
  const { box, panel, list, status, more } = elements();
  const names: SearchAliases = {
    row: () => [[["x-ab-y", "x-ab-y"]], "x-ab-y", 1],
    load: async () => undefined,
    read: async (ranks) => new Map(
      [...ranks].map((rank) => [
        rank,
        [[["x-ab-y", "x-ab-y"]], "x-ab-y", 1],
      ]),
    ),
  };
  let attempts = 0;
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    names,
    12,
    () => {},
    {
      ...immediateDependencies,
      searchSubstringPage: async () => {
        attempts++;
        if (attempts === 1) throw new Error("temporary failure");
        return { ranks: [0], next: null };
      },
    },
  );

  box.value = "ab";
  box.emit("input");
  await waitFor(() => status.textContent.includes("失败"));
  assert.equal(more.hidden, false);
  assert.equal(more.textContent, "重试加载更多");

  more.emit("click");
  await waitFor(() => list.innerHTML.includes("x-<mark>ab</mark>-y"));
  assert.equal(attempts, 2);
});

test("reranks enrichment while retaining only the keyboard selection", async () => {
  const { box, panel, list, status, more } = elements();
  const rows = new Map<number, NameRow>([
    [0, ["x-ab-zero", null, 1]],
    [1, ["x-ab-one", null, 1]],
  ]);
  let resolveSubstring:
    | ((page: { ranks: number[]; next: null }) => void)
    | undefined;
  const names = aliasesFromNames(rows);
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    names,
    2,
    () => {},
    {
      ...immediateDependencies,
      loadSearchDir: async () => ({ ab: { l: [0, 1] } }),
      searchMember: async () => [
        ["ab-old", "ab-old", 100, "ab-old", 1],
        ["ab-selected", "ab-selected", 101, "ab-selected", 1],
      ],
      searchSubstringPage: async () =>
        new Promise((resolve) => (resolveSubstring = resolve)),
    },
  );

  box.value = "ab";
  box.emit("input");
  await waitFor(() => list.innerHTML.includes('data-rank="101"'));
  box.emit("keydown", {
    key: "ArrowDown",
    preventDefault: () => undefined,
  });
  await waitFor(() => resolveSubstring !== undefined);
  resolveSubstring?.({ ranks: [0, 1], next: null });
  await waitFor(() => status.textContent.includes("2 个结果"));

  assert.deepEqual(
    [...list.innerHTML.matchAll(/data-rank="(\d+)"/g)].map((match) =>
      Number(match[1])
    ),
    [0, 101],
  );
  assert.match(
    list.innerHTML,
    /class="hit active"[^>]*data-rank="101"/,
  );
});

test("scrolls the active keyboard option into view", async () => {
  const { box, panel, list, status, more } = elements();
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    2,
    () => {},
    {
      ...immediateDependencies,
      loadSearchDir: async () => ({ a: { l: [0, 1] } }),
      searchMember: async () => [
        ["a0", "a0", 0, "a0", 1],
        ["a1", "a1", 1, "a1", 1],
      ],
    },
  );

  box.value = "a";
  box.emit("input");
  await waitFor(() => list.innerHTML.includes('data-rank="1"'));
  box.emit("keydown", {
    key: "ArrowDown",
    preventDefault: () => undefined,
  });

  assert.equal(list.lastSelector, "#search-hit-1");
  assert.equal(list.scrollCount, 1);
});

test("debounces substring work and aborts an in-flight stale query", async () => {
  const { box, panel, list, status, more } = elements();
  const calls: Array<{ query: string; signal: AbortSignal }> = [];
  const dependencies: SearchDependencies = {
    ...immediateDependencies,
    substringDelayMs: 10,
    searchSubstringPage: async (query, _cursor, _limit, signal) => {
      calls.push({ query, signal });
      if (query === "ab")
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      return { ranks: [], next: null };
    },
  };
  new Search(
    {
      box: box as unknown as HTMLInputElement,
      panel: panel as unknown as HTMLElement,
      list: list as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
      more: more as unknown as HTMLButtonElement,
    },
    emptyNames,
    12,
    () => {},
    dependencies,
  );

  box.value = "a";
  box.emit("input");
  box.value = "ab";
  box.emit("input");
  await waitFor(() => calls.length === 1);
  box.value = "abc";
  box.emit("input");
  await waitFor(() => calls.length === 2);

  assert.deepEqual(calls.map((call) => call.query), ["ab", "abc"]);
  assert.equal(calls[0]?.signal.aborted, true);
  assert.equal(calls[1]?.signal.aborted, false);
});
