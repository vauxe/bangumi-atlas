import assert from "node:assert/strict";
import { test } from "node:test";

import {
  completionActions,
  queryInputValue,
  queryTokens,
} from "../src/query/presenter";
import type { Mappings } from "../src/types";

const mappings: Mappings = {
  fact_labels: { WORKED_ON: { "2": "导演" } },
  subject_type: { "2": "动画" },
  platform: {},
  person_type: {},
  character_role: {},
  episode_type: {},
};

test("projects a list draft as one readable query sentence", () => {
  const tokens = queryTokens({
    kind: "list",
    query: {
      scope: ["subject"],
      text: { value: "机器人", capability: "lookup" },
      condition: {
        kind: "compare",
        field: "score",
        operator: "gte",
        value: 8,
      },
      relations: [{
        factKind: "WORKED_ON",
        candidateRole: "subject",
        relatedRole: "person",
        related: "person:7",
        exists: true,
        condition: {
          kind: "compare",
          field: "position",
          operator: "eq",
          value: 2,
        },
      }],
      orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
    },
  }, {
    mappings,
    entityLabel: (ref) => ref === "person:7" ? "宫崎骏" : ref,
  });

  assert.deepEqual(tokens.map((token) => token.label), [
    "查找作品",
    "评分 ≥ 8",
    "人物参与 · 人物是宫崎骏 · 职位 = 导演",
    "按评分降序",
  ]);
  assert.equal(queryInputValue({
    kind: "list",
    query: {
      scope: ["subject"],
      text: { value: "机器人", capability: "lookup" },
    },
  }), "机器人");
});

test("keeps full text visible as a semantic token rather than plain name input", () => {
  const draft = {
    kind: "list" as const,
    query: {
      scope: ["character"] as const,
      text: {
        value: "时间旅行",
        capability: "fullText" as const,
        field: "summary" as const,
      },
    },
  };

  assert.equal(queryInputValue(draft), "");
  assert.deepEqual(queryTokens(draft).map((token) => token.label), [
    "查找角色",
    "简介含“时间旅行”",
  ]);
});

test("presents cross-scope long text as one list query", () => {
  const draft = { kind: "list" as const, allText: "星空" };
  assert.deepEqual(queryTokens(draft).map((token) => token.label), [
    "查找正文",
    "所有正文与关系备注",
    "正文含“星空”",
  ]);
  assert.equal(queryInputValue(draft), "");
});

test("describes statistic conditions with their generated column labels", () => {
  const tokens = queryTokens({
    kind: "aggregate",
    query: {
      owner: "subject",
      aggregate: {
        groupBy: ["year"],
        metrics: [{ function: "count" }],
        having: {
          kind: "compare",
          field: "count",
          operator: "gte",
          value: 10,
        },
      },
    },
  });

  assert.equal(tokens.find((token) => token.id === "having")?.label,
    "统计结果中条数 ≥ 10");
});

test("uses domain labels for statistic conditions on grouped enum fields", () => {
  const tokens = queryTokens({
    kind: "aggregate",
    query: {
      owner: "subject",
      aggregate: {
        groupBy: ["type"],
        metrics: [{ function: "count" }],
        having: {
          kind: "compare",
          field: "type",
          operator: "eq",
          value: 2,
        },
      },
    },
  }, { mappings });

  assert.equal(tokens.find((token) => token.id === "having")?.label,
    "统计结果中类型 = 动画");
});

test("offers only actions that are valid for the current answer shape", () => {
  const list = completionActions({
    kind: "list",
    query: { scope: ["subject"] },
  }, "/统");
  assert.deepEqual(list.map((item) => item.id), ["aggregate"]);

  const path = completionActions({
    kind: "path",
    from: "subject:1",
    to: "person:2",
    maxHops: 6,
    maxPaths: 10,
  }, "");
  assert.deepEqual(path.map((item) => item.id), [
    "list",
    "comparison",
    "path",
  ]);

  const episode = completionActions({
    kind: "list",
    query: { scope: ["episode"] },
  }, "");
  assert.equal(episode.some((item) => item.id === "relation"), false);
  assert.equal(completionActions({
    kind: "list",
    query: { scope: ["subject"] },
  }, "").some((item) => item.id === "relation"), true);
});

test("renders comparison and path endpoints by meaning, not stable ids", () => {
  const labels = (ref: string): string => ({
    "subject:1": "千与千寻",
    "person:2": "宫崎骏",
  })[ref] ?? ref;

  assert.deepEqual(queryTokens({
    kind: "comparison",
    from: "subject:1",
    to: "person:2",
  }, { entityLabel: labels }).map((token) => token.label), [
    "比较共同关联",
    "千与千寻",
    "宫崎骏",
  ]);
  assert.deepEqual(queryTokens({
    kind: "path",
    from: "subject:1",
    to: "person:2",
    maxHops: 6,
    maxPaths: 10,
  }, { entityLabel: labels }).map((token) => token.label), [
    "最短路径",
    "千与千寻",
    "宫崎骏",
    "最多 6 跳",
    "最多 10 条",
  ]);
  assert.equal(queryTokens({
    kind: "comparison",
    from: "subject:1",
    to: "person:2",
  })[0]?.target.type, "head");
});

test("makes the default scope readable and labels every narrowing action", () => {
  const draft = {
    kind: "list" as const,
    query: {
      scope: ["subject", "person", "character"] as const,
      text: { value: "机器人", capability: "lookup" as const },
    },
  };

  assert.equal(queryTokens(draft)[0]?.label, "查找全部");
  const conditions = completionActions(draft, "")
    .filter((action) => action.id === "condition");
  assert.deepEqual(conditions.map((action) => [action.label, action.owner]), [
    ["作品 · 添加条件", "subject"],
    ["人物 · 添加条件", "person"],
    ["角色 · 添加条件", "character"],
  ]);
});
