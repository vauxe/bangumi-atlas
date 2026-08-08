import assert from "node:assert/strict";
import { test } from "node:test";

import {
  queryValueText,
  renderAnswer,
} from "../src/query/answer-view";
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
  children: FakeElement[] = [];
  className = "";
  textContent = "";
  type = "";

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  addEventListener(): void {}
}

function visibleText(element: FakeElement): string {
  return [element.textContent, ...element.children.map(visibleText)]
    .filter(Boolean)
    .join(" ");
}

test("renders missing and explicit null as different user-visible states", () => {
  assert.equal(queryValueText(MISSING), "未提供");
  assert.equal(queryValueText(null), "空值");
  assert.equal(queryValueText(""), "空字符串");
  assert.equal(queryValueText([]), "空列表");
  assert.equal(queryValueText(false), "否");
});

test("uses an entity's readable name while retaining its stable ref elsewhere", () => {
  assert.equal(queryValueText({
    kind: "entity",
    owner: "subject",
    ref: "subject:42",
    fields: { name: "Original", nameCn: "中文名" },
  }), "中文名");
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
    "99",
  );
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
});

test("keeps result UI focused on the answer instead of export internals", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
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
    assert.match(text, /查询结果/);
    assert.match(text, /没有找到符合条件的结果/);
    assert.doesNotMatch(text, /下载|证据与覆盖|Release|查询 [0-9a-f]{12}|覆盖/);
  } finally {
    globalThis.document = originalDocument;
  }
});
