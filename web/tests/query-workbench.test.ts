import assert from "node:assert/strict";
import { test } from "node:test";

import {
  combineExplorerConditions,
  conditionEditorOperator,
  defaultSortDirection,
  describeExplorerQuery,
  isExplorerConditionComplete,
  parseExplorerLimit,
  queryConditionOperators,
  queryProjectFields,
  queryRelationOptions,
  queryRelationTargetOwner,
  querySortFields,
  queryTextScopes,
} from "../src/query/workbench-model";

test("offers one readable text-scope control for each entity type", () => {
  assert.deepEqual(queryTextScopes("subject"), [
    { value: "lookup", label: "名称含" },
    { value: "fullText:summary", label: "简介含" },
  ]);
  assert.deepEqual(queryTextScopes("episode"), [
    { value: "lookup", label: "名称含" },
    { value: "fullText:description", label: "分集介绍含" },
  ]);
});

test("keeps internal identifiers out of user-facing sort options", () => {
  assert.equal(querySortFields("subject").includes("id"), false);
  assert.equal(querySortFields("subject").includes("ref"), false);
  assert.equal(querySortFields("subject").includes("score"), true);
});

test("derives friendly condition operators from the field contract", () => {
  assert.deepEqual(queryConditionOperators("subject", "type"), [
    "eq",
    "ne",
    "in",
    "notIn",
  ]);
  assert.deepEqual(queryConditionOperators("subject", "score"), [
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "in",
    "notIn",
    "isNull",
    "isNotNull",
  ]);
  assert.deepEqual(queryConditionOperators("subject", "tags"), [
    "contains",
    "notContains",
  ]);
});

test("maps editable complementary conditions without hiding unsupported negation", () => {
  assert.equal(conditionEditorOperator({
    kind: "compare",
    field: "tags",
    operator: "contains",
    value: "科幻",
    negated: true,
  }), "notContains");
  assert.equal(conditionEditorOperator({
    kind: "compare",
    field: "score",
    operator: "gte",
    value: 8,
    negated: true,
  }), null);
  assert.equal(conditionEditorOperator({
    kind: "isMissing",
    field: "date",
    negated: true,
  }), "isPresent");
});

test("combines visible conditions with the conjunction the user selected", () => {
  const terms = [
    { kind: "compare" as const, field: "score", operator: "gte" as const, value: 8 },
    { kind: "in" as const, field: "type", values: [1, 2] },
  ];

  assert.deepEqual(combineExplorerConditions("any", terms), { kind: "any", terms });
  assert.deepEqual(combineExplorerConditions("all", [terms[0]!]), terms[0]);
  assert.equal(combineExplorerConditions("all", []), undefined);
});

test("offers projectable result fields and validates a bounded result count", () => {
  assert.equal(queryProjectFields("episode").includes("subjectRef"), false);
  assert.equal(queryProjectFields("episode").includes("descriptionState"), true);
  assert.equal(queryProjectFields("subject").includes("scoreDetails"), false);
  assert.equal(parseExplorerLimit("50"), 50);
  assert.throws(() => parseExplorerLimit("0"), /1 到 10000/);
  assert.throws(() => parseExplorerLimit("10001"), /1 到 10000/);
});

test("resolves the related entity type from the fact role", () => {
  assert.equal(
    queryRelationTargetOwner("RELATES_TO|source|target"),
    "subject",
  );
  assert.equal(
    queryRelationTargetOwner("VOICE_CREDIT|person|subjectContext"),
    "subject",
  );
  assert.throws(
    () => queryRelationTargetOwner("RELATES_TO|subject|unknownRole"),
    /关联类型无效/,
  );
});

test("names same-type relationship directions without duplicate choices", () => {
  const related = queryRelationOptions("subject")
    .filter((item) => item.value.startsWith("RELATES_TO|"));

  assert.equal(related.length, 2);
  assert.equal(new Set(related.map((item) => item.label)).size, 2);
  assert.deepEqual(related.map((item) => item.label), [
    "作品关系 · 目标作品",
    "作品关系 · 来源作品",
  ]);
});

test("uses the direction users expect for common result sorts", () => {
  assert.equal(defaultSortDirection("score"), "desc");
  assert.equal(defaultSortDirection("year"), "desc");
  assert.equal(defaultSortDirection("rank"), "asc");
  assert.equal(defaultSortDirection("name"), "asc");
});

test("waits for a visible condition value before refreshing live results", () => {
  assert.equal(isExplorerConditionComplete("subject", "score", "gte", ""), false);
  assert.equal(isExplorerConditionComplete("subject", "score", "gte", "8"), true);
  assert.equal(isExplorerConditionComplete("subject", "tags", "contains", "  "), false);
  assert.equal(isExplorerConditionComplete("subject", "tags", "notContains", "科幻"), true);
  assert.equal(isExplorerConditionComplete("subject", "date", "isMissing", ""), true);
  assert.equal(isExplorerConditionComplete("subject", "score", "isNotNull", ""), true);
  assert.equal(isExplorerConditionComplete("subject", "type", "in", "动画、书籍"), true);
  assert.equal(isExplorerConditionComplete("subject", "type", "notIn", "  "), false);
});

test("describes an editable query in compact user language", () => {
  assert.equal(describeExplorerQuery({
    owner: "subject",
    text: { value: "星海", capability: "lookup" },
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
    }],
    orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
  }), "作品 · 名称含「星海」 · 评分 ≥ 8 · 与人物 #7 有人物参与 · 评分降序");
});

test("makes empty and nested query intent visible without exposing syntax", () => {
  assert.equal(describeExplorerQuery({ owner: "character" }), "角色 · 全部条目");
  assert.equal(describeExplorerQuery({
    owner: "episode",
    text: { value: "再会", capability: "fullText", field: "description" },
    condition: {
      kind: "any",
      terms: [
        { kind: "isMissing", field: "airdate" },
        { kind: "compare", field: "year", operator: "gte", value: 2020 },
      ],
    },
  }), "分集 · 分集介绍含「再会」 · 任一（播出日期未提供、年份 ≥ 2020）");
  assert.equal(describeExplorerQuery({
    owner: "subject",
    condition: { kind: "compare", field: "type", operator: "eq", value: 1 },
  }), "作品 · 类型 = 书籍");
  assert.equal(describeExplorerQuery({
    owner: "subject",
    condition: { kind: "in", field: "type", values: [1, 2], negated: true },
  }), "作品 · 类型不属于（书籍、动画）");
  assert.equal(describeExplorerQuery({
    owner: "subject",
    condition: { kind: "compare", field: "tags", operator: "contains", value: "科幻", negated: true },
  }), "作品 · 用户标签不含「科幻」");
});
