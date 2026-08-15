import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeFactCondition,
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

test("describes a relationship attribute condition in user language", () => {
  assert.equal(describeFactCondition("WORKED_ON", {
    kind: "compare",
    field: "position",
    operator: "eq",
    value: 2,
  }, mappings), "职位 = 导演");
});

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
    "作品",
    "评分 ≥ 8",
    "导演是宫崎骏",
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

test("describes only the columns the user can change", () => {
  assert.deepEqual(queryTokens({
    kind: "list",
    query: {
      scope: ["subject", "person", "character"],
      columns: ["entityType", "score"],
    },
  }).map(({ label }) => label), [
    "作品、人物、角色",
    "显示实体类型、评分",
  ]);
  assert.equal(queryTokens({
    kind: "list",
    query: { scope: ["subject"], columns: [] },
  }).at(-1)?.label, "仅显示条目");
});

test("uses readable enum labels for conditions shared by multiple entity types", () => {
  const condition = queryTokens({
    kind: "list",
    query: {
      scope: ["subject", "person", "character"],
      condition: {
        kind: "compare",
        field: "summaryState",
        operator: "eq",
        value: "HAS",
      },
    },
  }).find(({ kind }) => kind === "condition");

  assert.equal(condition?.label, "是否有简介 = 有简介");
});

test("names the entity scope of a type-specific sort rule", () => {
  const order = queryTokens({
    kind: "list",
    query: {
      scope: ["subject", "person", "character"],
      orderBy: [{
        column: "score",
        owners: ["subject"],
        direction: "desc",
        nulls: "last",
      }, {
        column: "name",
        direction: "asc",
        nulls: "first",
      }],
    },
  }).find(({ kind }) => kind === "order");

  assert.equal(order?.label, "先按作品的评分降序，再按原名升序");
});

test("states a negative relationship as an exclusion", () => {
  const token = queryTokens({
    kind: "list",
    query: {
      scope: ["subject"],
      relations: [{
        factKind: "WORKED_ON",
        candidateRole: "subject",
        relatedRole: "person",
        related: "person:7",
        exists: false,
        condition: {
          kind: "compare",
          field: "position",
          operator: "eq",
          value: 2,
        },
      }],
    },
  }, {
    mappings,
    entityLabel: () => "宫崎骏",
  }).find(({ kind }) => kind === "relation");

  assert.equal(token?.label, "排除：导演是宫崎骏");
});

test("shows an Episode's owning Subject by name instead of its reference", () => {
  const token = queryTokens({
    kind: "list",
    query: {
      scope: ["episode"],
      condition: {
        kind: "compare",
        field: "subjectRef",
        operator: "eq",
        value: "subject:265",
      },
    },
  }, {
    entityLabel: (ref) => ref === "subject:265" ? "新世纪福音战士" : ref,
  }).find(({ kind }) => kind === "condition");

  assert.equal(token?.label, "所属作品 = 新世纪福音战士");
});

test("keeps reference-shaped ordinary text as text", () => {
  const token = queryTokens({
    kind: "list",
    query: {
      scope: ["subject"],
      condition: {
        kind: "compare",
        field: "name",
        operator: "eq",
        value: "subject:265",
      },
    },
  }, {
    entityLabel: () => "不应使用的条目名",
  }).find(({ kind }) => kind === "condition");

  assert.equal(token?.label, "原名 = “subject:265”");
});

test("describes a generic relationship without technical sentence fragments", () => {
  const token = queryTokens({
    kind: "list",
    query: {
      scope: ["subject"],
      relations: [{
        factKind: "RELATES_TO",
        candidateRole: "source",
        relatedRole: "target",
        related: "subject:265",
        exists: true,
      }],
    },
  }, {
    entityLabel: () => "新世纪福音战士",
  }).find(({ kind }) => kind === "relation");

  assert.equal(token?.label, "作品关系：新世纪福音战士");
});

test("describes every endpoint constrained on one voice-credit fact", () => {
  const token = queryTokens({
    kind: "list",
    query: {
      scope: ["character"],
      relations: [{
        factKind: "VOICE_CREDIT",
        candidateRole: "character",
        relatedRole: "person",
        related: "person:7",
        additionalEndpoints: [{
          role: "subjectContext",
          related: "subject:265",
        }],
        exists: true,
      }],
    },
  }, {
    entityLabel: (ref) => ({
      "person:7": "花泽香菜",
      "subject:265": "化物语",
    })[ref],
  }).find(({ kind }) => kind === "relation");

  assert.equal(token?.label, "配音：花泽香菜 · 作品：化物语");
});

test("presents an ordered top-N answer as one semantic token", () => {
  const tokens = queryTokens({
    kind: "list",
    query: {
      scope: ["subject"],
      orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
      limit: 10,
    },
  });

  assert.deepEqual(tokens.map((token) => token.label), [
    "作品",
    "前 10 条 · 按评分降序",
  ]);
  assert.deepEqual(tokens.map((token) => token.target.type), ["owner", "order"]);
});

test("keeps a restored standalone limit visible for compatibility", () => {
  const tokens = queryTokens({
    kind: "list",
    query: { scope: ["subject"], limit: 10 },
  });

  assert.deepEqual(tokens.map((token) => token.label), [
    "作品",
    "最多 10 条",
  ]);
  assert.equal(tokens[1]?.target.type, "limit");
});

test("keeps full text visible as a semantic token rather than plain name input", () => {
  const draft = {
    kind: "list" as const,
    query: {
      scope: ["character"] as const,
      fullText: { value: "时间旅行" },
    },
  };

  assert.equal(queryInputValue(draft), "");
  assert.deepEqual(queryTokens(draft).map((token) => token.label), [
    "角色",
    "简介含“时间旅行”",
  ]);
});

test("presents cross-scope long text as one list query", () => {
  const draft = { kind: "list" as const, allText: "星空" };
  const tokens = queryTokens(draft);
  assert.deepEqual(tokens.map((token) => token.label), [
    "查找正文",
    "所有正文与关系备注",
    "正文含“星空”",
  ]);
  assert.equal(tokens[0]?.editable, false);
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
  assert.equal(queryTokens({
    kind: "comparison",
    from: "subject:1",
    to: "person:2",
  })[0]?.editable, false);
});

test("makes the default scope readable and labels every narrowing action", () => {
  const draft = {
    kind: "list" as const,
    query: {
      scope: ["subject", "person", "character"] as const,
      text: { value: "机器人", capability: "lookup" as const },
    },
  };

  assert.equal(queryTokens(draft)[0]?.label, "作品、人物、角色");
  assert.equal(queryTokens(draft)[0]?.target.type, "owner");
});

test("names multi-type scopes by what they actually contain", () => {
  assert.equal(queryTokens({
    kind: "list",
    query: { scope: ["subject", "character"] },
  })[0]?.label, "作品、角色");
  assert.equal(queryTokens({
    kind: "list",
    query: { scope: ["subject", "person", "character", "episode"] },
  })[0]?.label, "全部类型");
});
