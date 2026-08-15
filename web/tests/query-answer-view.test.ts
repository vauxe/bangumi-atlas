import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  queryMatchSnippet,
  queryResultEntityRefs,
  queryRowMatchSnippet,
  queryValueText,
  renderAnswer,
} from "../src/query/answer-view";
import { executeQuery, type QueryDataSource } from "../src/query/engine";
import { MISSING } from "../src/query/value";
import type { Mappings } from "../src/types";

const mappings: Mappings = {
  fact_labels: {
    WORKED_ON: { "1": "原作" },
    RELATES_TO: { "1002": "系列" },
    VOICE_CREDIT: { "4": "日配" },
  },
  subject_type: { "2": "动画" },
  platform: { "2:1001": "TV" },
  person_type: { "2": "公司" },
  character_role: { "3": "舰船" },
  episode_type: { "0": "本篇", "1": "特别篇" },
};

class FakeElement {
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  className = "";
  textContent = "";
  style = { minWidth: "", width: "" };
  focused = false;
  type = "";
  title = "";
  scope = "";
  tabIndex = -1;
  colSpan = 1;
  checked = false;
  open = false;
  rectWidth?: number | (() => number);
  private listeners = new Map<string, Array<(event?: Record<string, unknown>) => void>>();

  constructor(readonly tagName = "") {}

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  addEventListener(
    type: string,
    listener: (event?: Record<string, unknown>) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  createTHead(): FakeElement {
    const head = new FakeElement();
    this.append(head);
    return head;
  }

  createTBody(): FakeElement {
    const body = new FakeElement();
    this.append(body);
    return body;
  }

  insertRow(): FakeElement {
    const row = new FakeElement();
    this.append(row);
    return row;
  }

  insertCell(): FakeElement {
    const cell = new FakeElement();
    this.append(cell);
    return cell;
  }

  getBoundingClientRect(): DOMRect {
    const width = typeof this.rectWidth === "function"
      ? this.rectWidth()
      : this.rectWidth;
    return {
      width: width ?? (Number.parseFloat(this.style.width) || 112),
    } as DOMRect;
  }

  setPointerCapture(_pointerId: number): void {}

  focus(): void {
    this.focused = true;
    this.dispatch("focus");
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click(): void {
    this.dispatch("click");
  }
}

function visibleText(element: FakeElement): string {
  return [element.textContent, ...element.children.map(visibleText)]
    .filter(Boolean)
    .join(" ");
}

function countElements(element: FakeElement, tagName: string): number {
  return Number(element.tagName === tagName) + element.children.reduce(
    (count, child) => count + countElements(child, tagName),
    0,
  );
}

function findElements(
  element: FakeElement,
  predicate: (candidate: FakeElement) => boolean,
): FakeElement[] {
  return [
    ...(predicate(element) ? [element] : []),
    ...element.children.flatMap((child) => findElements(child, predicate)),
  ];
}

test("renders missing and explicit null as different user-visible states", () => {
  assert.equal(queryValueText(MISSING), "未提供");
  assert.equal(queryValueText(null), "未记录");
  assert.equal(queryValueText(""), "暂无内容");
  assert.equal(queryValueText([]), "暂无内容");
  assert.equal(queryValueText(false), "否");
});

test("distinguishes an unavailable multi-entity column from a missing value", () => {
  assert.equal(queryValueText(null, {
    column: "score",
    row: { ref: "person:7" },
  }), "不适用");
  assert.equal(queryValueText(null, {
    column: "score",
    row: { ref: "subject:7" },
  }), "未记录");
});

test("renders stable references as domain labels instead of storage IDs", () => {
  assert.equal(queryValueText("subject:42"), "作品 #42");
  assert.equal(queryValueText("person:7"), "人物 #7");
  assert.equal(queryValueText("fact:9"), "关系事实 #9");
});

test("renders structured tags with their names and counts", () => {
  assert.equal(
    queryValueText([
      { name: "科幻", count: 12_345 },
      { name: "机器人", count: 678 },
    ]),
    "科幻（12,345）、机器人（678）",
  );
});

test("passes display-ready archive values through unchanged", () => {
  assert.equal(
    queryValueText([{ name: "Chapter &lt; End", count: 2 }]),
    "Chapter &lt; End（2）",
  );
  assert.equal(queryValueText({
    kind: "entity",
    owner: "subject",
    ref: "subject:42",
    fields: { name: "Rock &lt; Roll", nameCn: "" },
  }), "Rock &lt; Roll");
});

test("keeps Values query strings unchanged", async () => {
  const source: QueryDataSource = { scan: async function* () {} };
  const result = await executeQuery({
    schema: "atlas-query-document-v1",
    root: "values",
    parameters: {},
    operators: {
      values: {
        kind: "values",
        columns: ["text"],
        rows: [["&lt;"], ["&amp;amp;amp;lt;"]],
      },
    },
  }, {}, source, { pageSize: 20 });

  assert.deepEqual(result.rows, [
    { text: "&lt;" },
    { text: "&amp;amp;amp;lt;" },
  ]);
  assert.equal(queryValueText(result.rows[0]?.text ?? null), "&lt;");
  assert.equal(
    queryValueText(result.rows[1]?.text ?? null),
    "&amp;amp;amp;lt;",
  );
});

test("uses an entity's readable name while retaining its stable ref elsewhere", () => {
  assert.equal(queryValueText({
    kind: "entity",
    owner: "subject",
    ref: "subject:42",
    fields: { name: "Original", nameCn: "中文名" },
  }), "中文名");
});

test("shows context only for full-text matches, not duplicate name matches", () => {
  assert.equal(queryMatchSnippet({ result: [{
    kind: "text-range",
    ref: "subject:42",
    field: "nameCn",
    utf8Range: [0, 6],
    text: "机器人",
    snippet: "机器人总动员",
  }] }), undefined);
  assert.equal(queryMatchSnippet({ result: [{
    kind: "text-range",
    ref: "subject:42",
    field: "summary",
    utf8Range: [3, 9],
    text: "机器人",
    snippet: "这是一个机器人的故事",
  }] }), "这是一个机器人的故事");
});

test("does not project an already-visible full-text snippet again", () => {
  assert.equal(queryMatchSnippet({ result: [{
    kind: "text-range",
    ref: "subject:42",
    field: "summary",
    utf8Range: [0, 4],
    text: "&lt;",
    snippet: "&lt;",
  }] }), "&lt;");
});

test("does not present one member snippet as context for an aggregate row", () => {
  const evidence = { result: [{
    kind: "text-range" as const,
    ref: "person:1" as const,
    field: "summary",
    utf8Range: [0, 6] as [number, number],
    text: "动画",
    snippet: "一条成员简介",
  }] };

  assert.equal(queryRowMatchSnippet({ count: 2885 }, evidence), undefined);
  assert.equal(
    queryRowMatchSnippet({ ref: "person:1" }, evidence),
    "一条成员简介",
  );
});

test("renders common entity codes as user-facing labels", () => {
  assert.equal(
    queryValueText(4, { column: "type", row: { ref: "subject:42" } }),
    "游戏",
  );
  assert.equal(
    queryValueText(2, { column: "type", row: { ref: "person:42" } }),
    "公司",
  );
  assert.equal(
    queryValueText(3, { column: "role", row: { ref: "character:42" } }),
    "舰船",
  );
  assert.equal(
    queryValueText(99, { column: "type", row: { ref: "subject:42" } }),
    "未知作品类型（99）",
  );
});

test("renders person careers as readable labels without changing raw data", () => {
  assert.equal(queryValueText(["seiyu", "writer"], {
    column: "career",
    row: { ref: "person:42" },
    semantic: "person.career",
  }), "声优、作家");
  assert.equal(queryValueText(["seiyu", "writer"], {
    column: "career",
    row: { ref: "person:42" },
  }), "声优、作家");
});

test("renders content presence states as user-facing labels", () => {
  assert.equal(queryValueText("HAS", {
    column: "summaryState",
    row: { ref: "subject:42" },
  }), "有简介");
  assert.equal(queryValueText("EMPTY", {
    column: "summaryState",
    row: { ref: "person:42" },
  }), "无简介");
  assert.equal(queryValueText("HAS", {
    column: "descriptionState",
    row: { ref: "episode:42" },
  }), "有分集介绍");
  assert.equal(queryValueText("EMPTY", {
    column: "descriptionState",
    row: { ref: "episode:42" },
  }), "无分集介绍");
  assert.equal(queryValueText("HAS", {
    column: "summaryState",
    row: { ref: "fact:42" },
    semantic: "VOICE_CREDIT.summaryState",
  }), "有说明");
});

test("labels unknown release enum values with their domain meaning", () => {
  assert.equal(queryValueText(99, {
    column: "type",
    row: { ref: "episode:7" },
    semantic: "episode.type",
    mappings,
  }), "未知分集类型（99）");
  assert.equal(queryValueText(99, {
    column: "position",
    row: {},
    semantic: "WORKED_ON.position",
    mappings,
  }), "未知职位（99）");
});

test("renders release-scoped relation and platform codes as domain labels", () => {
  assert.equal(queryValueText(1, {
    column: "position",
    row: {},
    semantic: "WORKED_ON.position",
    mappings,
  }), "原作");
  assert.equal(queryValueText(4, {
    column: "type",
    row: {},
    semantic: "VOICE_CREDIT.type",
    mappings,
  }), "日配");
  assert.equal(queryValueText(2, {
    column: "copies",
    row: {},
    semantic: "VOICE_CREDIT.multiplicity",
    mappings,
  }), "2");
});

test("uses the contract enum namespace for Episode types", () => {
  assert.equal(queryValueText(1, {
    column: "type",
    row: { ref: "episode:7" },
    semantic: "episode.type",
    mappings,
  }), "特别篇");
  assert.equal(queryValueText(1, {
    column: "type",
    row: { ref: "episode:7" },
    mappings,
  }), "特别篇");
});

test("renders union entity types as readable labels", () => {
  assert.equal(queryValueText("subject", {
    column: "entityType",
    row: {},
  }), "作品");
  assert.equal(queryValueText("episode", {
    column: "entityType",
    row: {},
  }), "分集");
});

test("collects every visible answer entity for graph highlighting", () => {
  assert.deepEqual(queryResultEntityRefs({
    rows: [{
      ref: "subject:1",
      participant: {
        kind: "entity",
        owner: "person",
        ref: "person:2",
        fields: { name: "人物" },
      },
      fact: {
        kind: "fact",
        factKind: "APPEARS_IN",
        ref: "fact:3",
        multiplicity: 1,
        roles: { character: "character:3", subject: "subject:1" },
        fields: {},
      },
      path: {
        kind: "path",
        policy: "fewest-hops",
        cost: 1,
        nodes: [{
          kind: "entity",
          owner: "subject",
          ref: "subject:4",
          fields: { name: "路径终点" },
        }],
        steps: [],
      },
      episode: "episode:5",
      unrelated: "fact:9",
    }],
  }), ["subject:1", "person:2", "character:3", "subject:4", "episode:5"]);
});

test("recovers one row entity from field evidence when ref is not projected", () => {
  assert.deepEqual(queryResultEntityRefs({
    rows: [{ name: "原題", score: 8.8 }],
    evidence: [{
      name: [{ kind: "entity-field", ref: "subject:7", field: "name" }],
      score: [{ kind: "entity-field", ref: "subject:7", field: "score" }],
    }],
  }), ["subject:7"]);
});

test("recovers every evidence entity when scalar columns represent multiple nodes", () => {
  assert.deepEqual(queryResultEntityRefs({
    rows: [{ subjectName: "作品", personName: "人物" }],
    evidence: [{
      subjectName: [{
        kind: "entity-field",
        ref: "subject:7",
        field: "name",
      }],
      personName: [{
        kind: "entity-field",
        ref: "person:8",
        field: "name",
      }],
    }],
  }), ["subject:7", "person:8"]);
});

test("combines visible references with other evidence-backed result entities", () => {
  assert.deepEqual(queryResultEntityRefs({
    rows: [{ ref: "subject:7", personName: "人物" }],
    evidence: [{
      personName: [{
        kind: "entity-field",
        ref: "person:8",
        field: "name",
      }],
    }],
  }), ["subject:7", "person:8"]);
});

test("keeps an evidence-backed entity clickable after choosing display columns", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  try {
    const opened: string[] = [];
    const container = new FakeElement();
    renderAnswer(
      container as unknown as HTMLElement,
      { shape: "table", title: "查询结果" },
      {
        rows: [{
          name: "原題",
          nameCn: "中文名",
          tags: [{ name: "科幻", count: 12_345 }],
        }],
        evidence: [{
          name: [{ kind: "entity-field", ref: "subject:7", field: "name" }],
          nameCn: [{ kind: "entity-field", ref: "subject:7", field: "nameCn" }],
          tags: [{ kind: "entity-field", ref: "subject:7", field: "tags" }],
        }],
        columns: {
          name: { type: "string", semantic: "subject.name" },
          nameCn: { type: "string", semantic: "subject.nameCn" },
          tags: { type: "tag[]", semantic: "subject.tags" },
        },
        totalMatches: 1,
        visibleMatches: 1,
        hasMore: false,
        stability: "exact",
        queryDigest: "a".repeat(64),
        releaseId: "b".repeat(64),
        coverage: {
          schema: "atlas-coverage-v1",
          atoms: ["owner:subject"],
          digest: "c".repeat(64),
        },
        terminalEvidence: [{ kind: "completed-domain", coverage: "c".repeat(64) }],
      },
      { onEntity: (ref) => opened.push(ref) },
    );

    const body = container.children[2]?.children[0]?.children[1];
    const identity = body?.children[0]?.children[0]?.children[0];
    assert.equal(visibleText(identity as FakeElement), "中文名 原題");
    identity?.click();
    assert.deepEqual(opened, ["subject:7"]);
    assert.match(visibleText(body as FakeElement), /科幻（12,345）/);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("uses one direct result count without restating completeness", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  try {
    const container = new FakeElement();
    renderAnswer(
      container as unknown as HTMLElement,
      { shape: "table", title: "查询结果" },
      {
        rows: [],
        evidence: [],
        columns: {},
        totalMatches: 1,
        visibleMatches: 1,
        hasMore: false,
        stability: "exact",
        queryDigest: "a".repeat(64),
        releaseId: "b".repeat(64),
        coverage: {
          schema: "atlas-coverage-v1",
          atoms: [],
          digest: "c".repeat(64),
        },
        terminalEvidence: [],
      },
    );

    assert.equal(container.children[1]?.textContent, "1 条结果");
  } finally {
    globalThis.document = originalDocument;
  }
});

test("appends newly revealed rows without rebuilding the existing table", () => {
  const originalDocument = globalThis.document;
  let created = 0;
  globalThis.document = {
    createElement: (tag: string) => {
      created++;
      return new FakeElement(tag.toUpperCase());
    },
  } as unknown as Document;
  try {
    const container = new FakeElement();
    const first = { ref: "subject:1", name: "第一部" };
    const second = { ref: "subject:2", name: "第二部" };
    const third = { ref: "subject:3", name: "第三部" };
    const fourth = { ref: "subject:4", name: "第四部" };
    const firstEvidence = {};
    const secondEvidence = {};
    const result = {
      rows: [first, second],
      evidence: [firstEvidence, secondEvidence],
      columns: {
        ref: { type: "entity-ref" as const, semantic: "subject.ref" },
        name: { type: "string" as const, semantic: "subject.name" },
      },
      totalMatches: 4,
      visibleMatches: 4,
      hasMore: true,
      stability: "exact" as const,
      queryDigest: "a".repeat(64),
      releaseId: "b".repeat(64),
      coverage: {
        schema: "atlas-coverage-v1" as const,
        atoms: ["owner:subject"],
        digest: "c".repeat(64),
      },
      terminalEvidence: [{
        kind: "completed-domain" as const,
        coverage: "c".repeat(64),
      }],
    };
    const view = renderAnswer(
      container as unknown as HTMLElement,
      { shape: "table", title: "查询结果" },
      result,
      { onMore: () => {} },
    );
    const table = container.children[2]?.children[0];
    const body = table?.children[1];
    const firstRow = body?.children[0];
    const more = container.children[3]?.children[0];
    const createdInitially = created;

    view.update({
      ...result,
      rows: [first, second, third],
      evidence: [firstEvidence, secondEvidence, {}],
      hasMore: true,
    });

    assert.equal(container.children[2]?.children[0], table);
    assert.equal(table?.children[1], body);
    assert.equal(body?.children[0], firstRow);
    assert.equal(body?.children.length, 3);
    assert.equal(container.children[3]?.children[0], more);
    assert.ok(created - createdInitially < createdInitially);

    view.update({
      ...result,
      rows: [{ ref: "subject:1", name: "已更新" }, second, third, fourth],
      evidence: [firstEvidence, secondEvidence, {}, {}],
      hasMore: false,
    });

    assert.notEqual(container.children[2]?.children[0], table);
    assert.match(visibleText(container), /已更新/);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("lets users open an Episode result like every other entity", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
  } as unknown as Document;
  try {
    const opened: string[] = [];
    const container = new FakeElement();
    renderAnswer(
      container as unknown as HTMLElement,
      { shape: "table", title: "查询结果" },
      {
        rows: [{ ref: "episode:7", name: "第 7 话" }],
        evidence: [],
        columns: { ref: { type: "entity-ref", semantic: "episode.ref" } },
        totalMatches: 1,
        visibleMatches: 1,
        hasMore: false,
        stability: "exact",
        queryDigest: "a".repeat(64),
        releaseId: "b".repeat(64),
        coverage: {
          schema: "atlas-coverage-v1",
          atoms: ["owner:episode"],
          digest: "c".repeat(64),
        },
        terminalEvidence: [{ kind: "completed-domain", coverage: "c".repeat(64) }],
      },
      { onEntity: (ref) => opened.push(ref) },
    );

    const resultButton = container.children[2]
      ?.children[0]
      ?.children[1]
      ?.children[0]
      ?.children[0]
      ?.children[0];
    assert.equal(resultButton?.textContent, "第 7 话");
    resultButton?.click();
    assert.deepEqual(opened, ["episode:7"]);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("shows Chinese and original entity names without repeating identical names", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  try {
    const container = new FakeElement();
    renderAnswer(
      container as unknown as HTMLElement,
      { shape: "table", title: "查询结果" },
      {
        rows: [
          { ref: "subject:1", name: "原題", nameCn: "中文名" },
          { ref: "subject:2", name: "同名", nameCn: "同名" },
        ],
        evidence: [{}, {}],
        columns: {
          ref: { type: "entity-ref", semantic: "subject.ref" },
          name: { type: "string", semantic: "subject.name" },
          nameCn: { type: "string", semantic: "subject.nameCn" },
        },
        totalMatches: 2,
        visibleMatches: 2,
        hasMore: false,
        stability: "exact",
        queryDigest: "a".repeat(64),
        releaseId: "b".repeat(64),
        coverage: {
          schema: "atlas-coverage-v1",
          atoms: ["owner:subject"],
          digest: "c".repeat(64),
        },
        terminalEvidence: [{ kind: "completed-domain", coverage: "c".repeat(64) }],
      },
    );

    const body = container.children[2]?.children[0]?.children[1];
    const bilingual = body?.children[0]?.children[0]?.children[0];
    const identical = body?.children[1]?.children[0]?.children[0];
    assert.equal(visibleText(bilingual as FakeElement), "中文名 原題");
    assert.equal(visibleText(identical as FakeElement), "同名");
    assert.equal(bilingual?.attributes.has("aria-label"), false);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("keeps result links readable", () => {
  const styles = readFileSync("src/query/workbench.css", "utf8");
  assert.match(styles, /\.query-entity-link\s*\{[^}]*text-align:\s*left;/s);
});

test("keeps names from squeezing the other result columns", () => {
  const styles = readFileSync("src/query/workbench.css", "utf8");

  assert.match(
    styles,
    /\.query-table\s*\{[^}]*table-layout:\s*fixed;/s,
  );
  assert.match(
    styles,
    /\.query-table th\s*\{[^}]*width:\s*8rem;/s,
  );
  assert.match(
    styles,
    /\.query-entity-table th:first-child\s*\{[^}]*width:\s*16rem;/s,
  );
  assert.match(
    styles,
    /\.query-table td\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
  );
});

test("resizes result columns without losing their widths when columns change", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  try {
    const container = new FakeElement();
    const result = {
      rows: [{ ref: "subject:1", name: "原题", score: 8.8, rank: 42 }],
      evidence: [{}],
      columns: {
        ref: { type: "entity-ref" as const, semantic: "subject.ref" },
        name: { type: "string" as const, semantic: "subject.name" },
        score: { type: "number" as const, semantic: "subject.score" },
        rank: { type: "number" as const, semantic: "subject.rank" },
      },
      totalMatches: 1,
      visibleMatches: 1,
      hasMore: false,
      stability: "exact" as const,
      queryDigest: "a".repeat(64),
      releaseId: "b".repeat(64),
      coverage: {
        schema: "atlas-coverage-v1" as const,
        atoms: ["owner:subject"],
        digest: "c".repeat(64),
      },
      terminalEvidence: [{
        kind: "completed-domain" as const,
        coverage: "c".repeat(64),
      }],
    };
    const view = renderAnswer(
      container as unknown as HTMLElement,
      {
        shape: "entity-list",
        title: "查询结果",
        entityScope: ["subject"],
      },
      result,
    );
    const resizer = (label: string): FakeElement | undefined =>
      findElements(container, (element) =>
        element.className === "query-column-resizer" &&
        element.attributes.get("aria-label") === `${label}列宽`
      )[0];

    const scoreResizer = resizer("评分");
    const rankResizer = resizer("Bangumi 排名");
    assert.ok(scoreResizer);
    assert.ok(rankResizer);
    assert.equal(scoreResizer.attributes.get("role"), "separator");
    assert.equal(scoreResizer.attributes.get("aria-orientation"), "vertical");
    assert.equal(scoreResizer.tabIndex, 0);
    assert.equal(scoreResizer.title, "拖动调整列宽");

    const entityHeader = findElements(container, (element) =>
      element.tagName === "TH" && element.textContent === "条目"
    )[0];
    const scoreHeader = findElements(container, (element) =>
      element.tagName === "TH" && element.textContent === "评分"
    )[0];
    const rankHeader = findElements(container, (element) =>
      element.tagName === "TH" && element.textContent === "Bangumi 排名"
    )[0];
    assert.ok(entityHeader);
    assert.ok(scoreHeader);
    assert.ok(rankHeader);
    entityHeader.rectWidth = 318;
    scoreHeader.rectWidth = 159;
    rankHeader.rectWidth = () =>
      entityHeader.style.width || scoreHeader.style.width ? 127 : 159;

    let keyboardPrevented = false;
    scoreResizer.dispatch("keydown", {
      key: "ArrowRight",
      shiftKey: false,
      preventDefault: () => keyboardPrevented = true,
    });
    assert.equal(keyboardPrevented, true);
    assert.equal(entityHeader.style.width, "318px");
    assert.equal(scoreHeader.style.width, "167px");
    assert.equal(rankHeader.style.width, "159px");
    assert.equal(scoreResizer.attributes.get("aria-valuenow"), "167");

    let pointerPrevented = false;
    rankResizer.dispatch("pointerdown", {
      button: 0,
      pointerId: 7,
      clientX: 10,
      preventDefault: () => pointerPrevented = true,
    });
    assert.equal(rankResizer.focused, true);
    rankResizer.dispatch("pointermove", { pointerId: 7, clientX: 50 });
    rankResizer.dispatch("pointerup", { pointerId: 7 });
    const table = findElements(container, ({ tagName }) => tagName === "TABLE")[0];
    assert.equal(pointerPrevented, true);
    assert.equal(rankHeader.style.width, "199px");
    assert.equal(table?.style.minWidth, "0");
    assert.equal(table?.style.width, "684px");

    view.update(result, ["rank"]);
    view.update(result, ["score", "rank"]);
    const rebuiltScore = findElements(container, (element) =>
      element.tagName === "TH" && element.textContent === "评分"
    )[0];
    const rebuiltRank = findElements(container, (element) =>
      element.tagName === "TH" && element.textContent === "Bangumi 排名"
    )[0];
    assert.equal(rebuiltScore?.style.width, "167px");
    assert.equal(rebuiltRank?.style.width, "199px");
  } finally {
    globalThis.document = originalDocument;
  }
});

test("spans a full-text snippet across every visible result column", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  try {
    const container = new FakeElement();
    renderAnswer(
      container as unknown as HTMLElement,
      {
        shape: "entity-list",
        title: "查询结果",
        entityScope: ["subject"],
      },
      {
        rows: [{ ref: "subject:1", name: "原题", score: 8.8 }],
        evidence: [{
          result: [{
            kind: "text-range",
            ref: "subject:1",
            field: "summary",
            utf8Range: [0, 6],
            text: "机器人",
            snippet: "机器人的故事",
          }],
        }],
        columns: {
          ref: { type: "entity-ref", semantic: "subject.ref" },
          name: { type: "string", semantic: "subject.name" },
          score: { type: "number", semantic: "subject.score" },
        },
        totalMatches: 1,
        visibleMatches: 1,
        hasMore: false,
        stability: "exact",
        queryDigest: "a".repeat(64),
        releaseId: "b".repeat(64),
        coverage: {
          schema: "atlas-coverage-v1",
          atoms: ["owner:subject"],
          digest: "c".repeat(64),
        },
        terminalEvidence: [{ kind: "completed-domain", coverage: "c".repeat(64) }],
      },
    );

    const snippet = findElements(container, (element) =>
      element.textContent === "机器人的故事"
    )[0];
    assert.ok(snippet);
    assert.equal(snippet.colSpan, 2);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("shows a clear column resize affordance for mouse and keyboard", () => {
  const styles = readFileSync("src/query/workbench.css", "utf8");
  const resizer = styles.match(
    /\.query-column-resizer\s*\{(?<body>[^}]*)\}/s,
  )?.groups?.body ?? "";
  const marker = styles.match(
    /\.query-column-resizer::after\s*\{(?<body>[^}]*)\}/s,
  )?.groups?.body ?? "";

  assert.match(resizer, /right:\s*0/);
  assert.match(resizer, /cursor:\s*col-resize/);
  assert.match(marker, /right:\s*0/);
  assert.match(
    styles,
    /\.query-column-resizer:focus-visible\s*\{[^}]*outline:/s,
  );
});

test("keeps one table layout without narrow-screen card metadata", () => {
  const styles = readFileSync("src/query/workbench.css", "utf8");
  const source = readFileSync("src/query/answer-view.ts", "utf8");
  const design = readFileSync("../docs/QUERY_CAPABILITY_DESIGN.md", "utf8");

  assert.doesNotMatch(styles, /container-type:\s*inline-size/);
  assert.doesNotMatch(styles, /@container\s*\(max-width:/);
  assert.doesNotMatch(source, /["']data-label["']/);
  assert.match(design, /结果始终使用表格/);
  assert.doesNotMatch(design, /转换为卡片/);
});

test("keeps result tables for reading instead of duplicating the query editor", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  try {
    const container = new FakeElement();
    renderAnswer(
      container as unknown as HTMLElement,
      {
        shape: "entity-list",
        title: "查询结果",
        entityScope: ["subject"],
      },
      {
        rows: [{ ref: "subject:1", name: "原題", nameCn: "中文名", score: 8.8 }],
        evidence: [{}],
        columns: {
          ref: { type: "entity-ref", semantic: "subject.ref" },
          name: { type: "string", semantic: "subject.name" },
          nameCn: { type: "string", semantic: "subject.nameCn" },
          score: { type: "number", semantic: "subject.score" },
        },
        totalMatches: 1,
        visibleMatches: 1,
        hasMore: false,
        stability: "exact",
        queryDigest: "a".repeat(64),
        releaseId: "b".repeat(64),
        coverage: {
          schema: "atlas-coverage-v1",
          atoms: ["owner:subject"],
          digest: "c".repeat(64),
        },
        terminalEvidence: [{ kind: "completed-domain", coverage: "c".repeat(64) }],
      },
      {},
    );

    assert.equal(countElements(container, "DETAILS"), 0);
    assert.doesNotMatch(visibleText(container), /只看此值|排除此值|按此分组/);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("lets users choose entity columns from the current result", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  try {
    const changes: string[][] = [];
    const container = new FakeElement();
    renderAnswer(
      container as unknown as HTMLElement,
      {
        shape: "entity-list",
        title: "查询结果",
        entityScope: ["subject"],
      },
      {
        rows: [{ ref: "subject:1", name: "原题", score: 8.8 }],
        evidence: [{}],
        columns: {
          ref: { type: "entity-ref", semantic: "subject.ref" },
          name: { type: "string", semantic: "subject.name" },
          score: { type: "number", semantic: "subject.score" },
        },
        totalMatches: 1,
        visibleMatches: 1,
        hasMore: false,
        stability: "exact",
        queryDigest: "a".repeat(64),
        releaseId: "b".repeat(64),
        coverage: {
          schema: "atlas-coverage-v1",
          atoms: ["owner:subject"],
          digest: "c".repeat(64),
        },
        terminalEvidence: [{ kind: "completed-domain", coverage: "c".repeat(64) }],
      },
      { onColumnsChange: (columns) => changes.push([...columns]) },
    );

    const details = findElements(container, ({ tagName }) => tagName === "DETAILS");
    assert.equal(details.length, 1);
    assert.match(visibleText(details[0]!), /显示列/);
    const rank = findElements(container, (element) =>
      element.tagName === "INPUT" &&
      element.attributes.get("aria-label") === "Bangumi 排名"
    )[0];
    assert.ok(rank);
    rank.checked = true;
    const apply = findElements(container, (element) =>
      element.tagName === "BUTTON" && element.textContent === "应用"
    )[0];
    assert.ok(apply);
    apply.click();

    assert.deepEqual(changes, [["score", "rank"]]);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("keeps horizontal result scrolling on the visible answer region", () => {
  const styles = readFileSync("src/query/workbench.css", "utf8");
  const answers = styles.match(/\.query-answers\s*\{(?<body>[^}]*)\}/s)?.groups?.body ?? "";
  const wrapper = styles.match(/\.query-table-wrap\s*\{(?<body>[^}]*)\}/s)?.groups?.body ?? "";
  const table = styles.match(/\.query-table\s*\{(?<body>[^}]*)\}/s)?.groups?.body ?? "";

  assert.match(answers, /overflow:\s*auto/);
  assert.doesNotMatch(wrapper, /overflow:\s*(?:auto|scroll)/);
  assert.match(wrapper, /width:\s*max-content/);
  assert.match(wrapper, /min-width:\s*100%/);
  assert.match(table, /width:\s*auto/);
  assert.match(table, /min-width:\s*100%/);
  assert.doesNotMatch(table, /min-width:\s*max-content/);
});

test("keeps result UI focused on the answer instead of export internals", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  try {
    const container = new FakeElement();
    renderAnswer(
      container as unknown as HTMLElement,
      { shape: "table", title: "查询结果" },
      {
        rows: [],
        evidence: [],
        columns: {},
        totalMatches: 0,
        visibleMatches: 0,
        hasMore: false,
        stability: "exact",
        queryDigest: "a".repeat(64),
        releaseId: "b".repeat(64),
        coverage: {
          schema: "atlas-coverage-v1",
          atoms: ["owner:subject"],
          digest: "c".repeat(64),
        },
        terminalEvidence: [{ kind: "completed-domain", coverage: "c".repeat(64) }],
      },
    );

    const text = visibleText(container);
    assert.equal(container.children[0]?.tagName, "H2");
    assert.match(text, /查询结果/);
    assert.match(text, /没有找到符合条件的结果/);
    assert.doesNotMatch(text, /下载|证据与覆盖|Release|查询 [0-9a-f]{12}|覆盖/);
  } finally {
    globalThis.document = originalDocument;
  }
});
