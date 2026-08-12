import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { QueryResult } from "../src/query/engine";

import {
  combineExplorerConditions,
  conditionEditorOperator,
  defaultSortDirection,
  describeExplorerQuery,
  enumValuesFor,
  isExplorerConditionComplete,
  parseExplorerLimit,
  factEnumValues,
  FIELD_LABEL,
  parseFactValue,
  parseValue,
  describeAggregateMetric,
  queryAggregateFields,
  queryAddFilterFields,
  queryConditionOperatorLabel,
  queryConditionOperators,
  queryFactConditionOperators,
  queryFactDiscriminatorField,
  queryFactFields,
  queryFilterFields,
  queryFieldsFor,
  queryGroupFields,
  queryScalarInputType,
  queryProjectFields,
  queryReferenceOwner,
  queryRelationOptions,
  queryRelationContextRoles,
  queryRelationTargetOwner,
  querySortFields,
  queryStatisticColumns,
  splitFactDiscriminatorCondition,
} from "../src/query/workbench-model";
import {
  mergeQueryResultRefs,
  queryHighlightStatus,
  queryResultPresentation,
  queryWorkspaceVisibility,
} from "../src/query/workbench";

const workbenchSource = readFileSync("src/query/workbench.ts", "utf8");

test("changes the query draft without scheduling result execution", () => {
  assert.doesNotMatch(workbenchSource, /refreshTimer/);
  const draftChanged = workbenchSource.match(
    /private draftChanged\([\s\S]*?\n  }(?=\n\n  private runCurrent)/,
  )?.[0];
  assert.ok(draftChanged);
  assert.doesNotMatch(draftChanged, /setTimeout|runCurrent/);
});

test("collapses results without cancelling the query or hiding the way back", () => {
  assert.deepEqual(queryWorkspaceVisibility(false, false, true), {
    workspaceHidden: true,
    reopenHidden: false,
  });
  assert.deepEqual(queryWorkspaceVisibility(false, true, false), {
    workspaceHidden: true,
    reopenHidden: false,
  });
  assert.deepEqual(queryWorkspaceVisibility(false, false, false), {
    workspaceHidden: true,
    reopenHidden: true,
  });

  const collapse = workbenchSource.match(
    /private collapse\([\s\S]*?\n  }(?=\n\n  private newQuery)/,
  )?.[0];
  assert.ok(collapse);
  assert.doesNotMatch(collapse, /abortCurrent/);
  assert.match(workbenchSource, /iconAction\("collapse", "收起结果"/);
  assert.match(workbenchSource, /labeledIconAction\("expand", "查看结果"/);
  assert.match(workbenchSource, /action\("清空查询", "query-reset"\)/);
});

test("merges buffered answer entities in stable section order", () => {
  assert.deepEqual(mergeQueryResultRefs(new Map([
    ["matches", ["subject:1", "person:2"]],
    ["paths", ["person:2", "character:3"]],
  ])), ["subject:1", "person:2", "character:3"]);
});

test("highlights every buffered query result while rendering only the first 50", () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({
    ref: `subject:${index + 1}`,
  }));
  const result: QueryResult = {
    rows,
    evidence: rows.map(() => ({})),
    columns: { ref: { type: "string", semantic: "subject.ref" } },
    totalMatches: rows.length,
    visibleMatches: rows.length,
    hasMore: false,
    stability: "exact",
    queryDigest: "query",
    releaseId: "release",
    coverage: { schema: "atlas-coverage-v1", atoms: [], digest: "coverage" },
    terminalEvidence: [],
  };

  const presentation = queryResultPresentation(result, 50);

  assert.equal(presentation.visible.rows.length, 50);
  assert.equal(presentation.visible.evidence.length, 50);
  assert.equal(presentation.visible.hasMore, true);
  assert.equal(presentation.highlightRefs.length, 120);
  assert.deepEqual(presentation.highlightRefs.slice(0, 2), [
    "subject:1",
    "subject:2",
  ]);
  assert.equal(presentation.highlightRefs.at(-1), "subject:120");
});

test("rescans buffered result refs only after a Worker page adds rows", () => {
  const loadSection = workbenchSource.match(
    /private async loadSection\([\s\S]*?\n  }(?=\n\n  private showError)/,
  )?.[0];
  assert.ok(loadSection);
  const render = loadSection.match(
    /const render = \(focusMore = false\): void => \{[\s\S]*?\n      };/,
  )?.[0];
  assert.ok(render);
  assert.match(render, /const visible = revealQueryResult\(result, shown\)/);
  const publishGuard = render.match(
    /if \(publishedRows !== result\.rows\.length\) \{[\s\S]*?\n        }/,
  )?.[0];
  assert.ok(publishGuard);
  assert.match(publishGuard, /queryResultEntityRefs\(result\)/);
  assert.doesNotMatch(render.replace(publishGuard, ""), /queryResultEntityRefs/);
});

test("requests complete highlights only for the initial section execution", () => {
  const loadSection = workbenchSource.match(
    /private async loadSection\([\s\S]*?\n  }(?=\n\n  private showError)/,
  )?.[0];
  assert.ok(loadSection);
  assert.match(loadSection, /dependencies\.executeWithHighlights/);
  const showMore = loadSection.match(
    /const showMore = async \(\): Promise<void> => \{[\s\S]*?\n      };/,
  )?.[0];
  assert.ok(showMore);
  assert.match(showMore, /dependencies\.execute\(section/);
  assert.doesNotMatch(showMore, /executeWithHighlights/);
});

test("labels retained graph highlights as previous results after query edits", () => {
  assert.equal(queryHighlightStatus(25, true), "图上 25 个当前结果");
  assert.equal(queryHighlightStatus(25, false), "图上 25 个上次结果");
  assert.equal(queryHighlightStatus(0, false), "");
});

test("publishes the body field for each entity type", () => {
  assert.deepEqual(queryFieldsFor("subject", "fullText"), ["summary"]);
  assert.deepEqual(queryFieldsFor("person", "fullText"), ["summary"]);
  assert.deepEqual(queryFieldsFor("character", "fullText"), ["summary"]);
  assert.deepEqual(queryFieldsFor("episode", "fullText"), ["description"]);
});

test("accepts a user-chosen result count without an arbitrary product maximum", () => {
  assert.equal(parseExplorerLimit("1000000"), 1_000_000);
  assert.throws(() => parseExplorerLimit("0"), /正整数/);
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

test("uses semantic input controls for numeric, date, and raw string fields", () => {
  assert.equal(queryScalarInputType("subject", "score"), "number");
  assert.equal(queryScalarInputType("subject", "ratingCount"), "number");
  assert.equal(queryScalarInputType("subject", "totalCollections"), "number");
  assert.equal(queryScalarInputType("episode", "sort"), "number");
  assert.equal(queryScalarInputType("episode", "duration"), "text");
  assert.equal(queryScalarInputType("subject", "date"), "date");
  assert.equal(queryScalarInputType("episode", "airdate"), "date");
  assert.equal(queryConditionOperatorLabel("subject", "date", "lt"), "早于");
  assert.equal(queryConditionOperatorLabel("episode", "airdate", "gte"), "不早于");
});

test("keeps the full query contract while curating the default condition menu", () => {
  assert.equal(queryFilterFields("subject").includes("name"), true);
  assert.equal(queryFilterFields("subject").includes("nameCn"), true);
  assert.equal(queryFilterFields("episode").includes("duration"), true);
  assert.equal(queryAddFilterFields("subject").includes("name"), false);
  assert.equal(queryAddFilterFields("subject").includes("nameCn"), false);
  assert.equal(queryAddFilterFields("episode").includes("duration"), true);
  assert.equal(queryAddFilterFields("episode").includes("airdate"), true);
});

test("uses release enum names in entity condition controls", () => {
  const mappings = {
    fact_labels: {},
    subject_type: { "2": "动画" },
    platform: {
      "1:0": "其他",
      "1:1001": "漫画",
      "2:0": "其他",
      "2:1": "TV",
    },
    person_type: { "1": "个人" },
    character_role: { "1": "角色" },
    episode_type: { "0": "本篇", "1": "特别篇" },
  };

  assert.deepEqual(enumValuesFor("episode", "type", mappings), {
    "0": "本篇",
    "1": "特别篇",
  });
  assert.deepEqual(enumValuesFor("subject", "type", mappings), { "2": "动画" });
  assert.deepEqual(enumValuesFor("subject", "platform", mappings), {
    "其他": "其他",
    "漫画": "漫画",
    "TV": "TV",
  });
  assert.deepEqual(enumValuesFor("person", "career", mappings), {
    actor: "演员",
    artist: "艺术家",
    illustrator: "插画家",
    mangaka: "漫画家",
    producer: "制作人",
    seiyu: "声优",
    writer: "作家",
  });
});

test("derives relationship attribute controls from the same query contract", () => {
  assert.deepEqual(queryFactFields("WORKED_ON", "filter"), ["position"]);
  assert.deepEqual(queryFactConditionOperators("WORKED_ON", "position"), [
    "eq",
    "ne",
    "in",
    "notIn",
  ]);
  assert.deepEqual(factEnumValues("WORKED_ON", "position", {
    fact_labels: { WORKED_ON: { "1": "原作", "2": "导演" } },
    subject_type: {},
    platform: {},
    person_type: {},
    character_role: {},
    episode_type: {},
  }), { "1": "原作", "2": "导演" });
  assert.equal(parseFactValue("WORKED_ON", "position", "2"), 2);
});

test("separates a concrete relationship from its true additional conditions", () => {
  assert.equal(queryFactDiscriminatorField("PERSON_REL"), "relationType");
  assert.equal(queryFactDiscriminatorField("WORKED_ON"), "position");

  assert.deepEqual(splitFactDiscriminatorCondition("PERSON_REL", {
    kind: "all",
    terms: [
      {
        kind: "compare",
        field: "relationType",
        operator: "eq",
        value: 1001,
      },
      {
        kind: "compare",
        field: "spoiler",
        operator: "eq",
        value: true,
      },
    ],
  }), {
    discriminator: {
      kind: "compare",
      field: "relationType",
      operator: "eq",
      value: 1001,
    },
    values: [1001],
    remainder: {
      kind: "compare",
      field: "spoiler",
      operator: "eq",
      value: true,
    },
  });
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

test("offers projectable result fields and validates a positive result count", () => {
  assert.equal(queryProjectFields("episode").includes("subjectRef"), false);
  assert.equal(queryProjectFields("episode").includes("descriptionState"), true);
  assert.equal(queryProjectFields("subject").includes("scoreDetails"), false);
  assert.equal(parseExplorerLimit("50"), 50);
  assert.throws(() => parseExplorerLimit("0"), /正整数/);
  assert.equal(parseExplorerLimit("10001"), 10_001);
});

test("exposes Episode ownership as an entity-valued filter without exposing ids", () => {
  assert.equal(queryFilterFields("episode").includes("subjectRef"), true);
  assert.equal(queryFilterFields("episode").includes("ref"), false);
  assert.equal(queryFilterFields("episode").includes("id"), false);
  assert.equal(queryReferenceOwner("episode", "subjectRef"), "subject");
  assert.equal(queryReferenceOwner("subject", "score"), null);
  assert.equal(parseValue("episode", "subjectRef", "subject:265"), "subject:265");
  assert.throws(
    () => parseValue("episode", "subjectRef", "person:265"),
    /所属作品.*作品/,
  );
});

test("distinguishes integer validation from general numeric validation", () => {
  assert.equal(parseValue("subject", "score", "8.5"), 8.5);
  assert.throws(
    () => parseValue("subject", "year", "2020.5"),
    /年份必须是整数/,
  );
  assert.throws(
    () => parseValue("subject", "score", "not-a-number"),
    /评分请输入有效数字/,
  );
  assert.throws(
    () => parseFactValue("RELATES_TO", "relationType", "1.5"),
    /必须是整数/,
  );
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

test("derives the optional endpoints of a complete relationship fact", () => {
  assert.deepEqual(
    queryRelationContextRoles("VOICE_CREDIT", "character", "person"),
    [{ role: "subjectContext", owner: "subject", label: "作品" }],
  );
  assert.deepEqual(
    queryRelationContextRoles("WORKED_ON", "subject", "person"),
    [],
  );
});

test("names same-type relationship directions without duplicate choices", () => {
  const related = queryRelationOptions("subject")
    .filter((item) => item.value.startsWith("RELATES_TO|"));

  assert.equal(related.length, 2);
  assert.equal(new Set(related.map((item) => item.label)).size, 2);
  assert.deepEqual(related.map((item) => item.label), [
    "作品关系 · 关联到的作品",
    "作品关系 · 关联到它的作品",
  ]);
});

test("uses domain language for fields and content availability", () => {
  assert.equal(FIELD_LABEL.date, "首发日期");
  assert.equal(FIELD_LABEL.metaTags, "内容标签");
  assert.equal(FIELD_LABEL.summaryState, "是否有简介");
  assert.equal(FIELD_LABEL.series, "是否为系列作品");
  assert.equal(FIELD_LABEL.sort, "集序号");
  assert.equal(FIELD_LABEL.disc, "光盘编号");
  assert.equal(FIELD_LABEL.descriptionState, "是否有分集介绍");
  assert.deepEqual(enumValuesFor("subject", "summaryState"), {
    HAS: "有简介",
    EMPTY: "无简介",
  });
  assert.deepEqual(enumValuesFor("episode", "descriptionState"), {
    HAS: "有分集介绍",
    EMPTY: "无分集介绍",
  });
  assert.deepEqual(factEnumValues("VOICE_CREDIT", "summaryState"), {
    HAS: "有说明",
    EMPTY: "无说明",
  });
});

test("uses the direction users expect for common result sorts", () => {
  assert.equal(defaultSortDirection("score"), "desc");
  assert.equal(defaultSortDirection("year"), "desc");
  assert.equal(defaultSortDirection("rank"), "asc");
  assert.equal(defaultSortDirection("name"), "asc");
});

test("derives readable statistic choices and output columns", () => {
  assert.equal(queryGroupFields("subject").includes("type"), true);
  assert.equal(queryAggregateFields("subject").includes("score"), true);
  assert.equal(queryAggregateFields("subject").includes("name"), false);
  assert.equal(describeAggregateMetric({ function: "avg", field: "score" }), "平均评分");
  assert.deepEqual(queryStatisticColumns({
    groupBy: ["type"],
    metrics: [{ function: "count" }, { function: "avg", field: "score" }],
  }), [
    { value: "type", label: "类型" },
    { value: "count", label: "条数" },
    { value: "avg_score", label: "平均评分" },
  ]);
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
    fullText: { value: "再会", field: "description" },
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
  assert.equal(describeExplorerQuery({
    owner: "person",
    condition: { kind: "compare", field: "career", operator: "contains", value: "seiyu" },
  }), "人物 · 职业 含 声优");
});
