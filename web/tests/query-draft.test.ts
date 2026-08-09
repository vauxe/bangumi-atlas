import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeBundle } from "../src/query/bundle";
import {
  executeQuery,
  type EntityValue,
  type QueryDataSource,
} from "../src/query/engine";

import {
  applyQueryAction,
  compileQueryDraft,
  createQueryHistory,
  DEFAULT_ENTITY_SCOPE,
  defaultQueryDraft,
  normalizeEntityScope,
  queryDraftFromBundle,
  redoQueryHistory,
  updateQueryHistory,
  undoQueryHistory,
  type QueryDraft,
} from "../src/query/draft";

test("starts with one canonical scope across works, people, and characters", () => {
  assert.deepEqual(DEFAULT_ENTITY_SCOPE, ["subject", "person", "character"]);
  assert.deepEqual(defaultQueryDraft(), {
    kind: "list",
    query: { scope: ["subject", "person", "character"] },
  });
  assert.deepEqual(
    normalizeEntityScope(["character", "subject", "character", "person"]),
    ["subject", "person", "character"],
  );
  assert.throws(() => normalizeEntityScope([]), /至少选择一种实体/);
});

test("lowers and lifts a multi-entity name query without hidden limits", () => {
  const draft: QueryDraft = {
    kind: "list",
    query: {
      scope: ["subject", "person", "character"],
      text: { value: "机器人", capability: "lookup" },
    },
  };

  const bundle = compileQueryDraft(draft);
  const section = bundle.sections.results;
  assert.ok(section);
  assert.equal(section.query.limit, null);
  assert.equal(section.query.operators[section.query.root]?.kind, "union");
  assert.deepEqual(queryDraftFromBundle(bundle), draft);
  assert.deepEqual(queryDraftFromBundle(normalizeBundle(bundle)), draft);
});

test("keeps original and Chinese names in a multi-entity result", async () => {
  const entities: EntityValue[] = [
    {
      kind: "entity",
      owner: "subject",
      ref: "subject:1",
      fields: { name: "原題", nameCn: "中文名" },
    },
    {
      kind: "entity",
      owner: "person",
      ref: "person:2",
      fields: { name: "人物原名" },
    },
    {
      kind: "entity",
      owner: "character",
      ref: "character:3",
      fields: { name: "角色原名" },
    },
  ];
  const source: QueryDataSource = {
    scan: async function* (owner) {
      yield* entities.filter((entity) => entity.owner === owner);
    },
  };
  const section = compileQueryDraft(defaultQueryDraft()).sections.results;
  assert.ok(section);

  const result = await executeQuery(
    section.query,
    section.parameterValues ?? {},
    source,
    { pageSize: 10 },
  );
  const rows = new Map(result.rows.map((row) => [row.ref, row]));

  assert.deepEqual(rows.get("subject:1"), {
    ref: "subject:1",
    name: "原題",
    nameCn: "中文名",
    entityType: "subject",
  });
  assert.equal(rows.get("person:2")?.nameCn, null);
  assert.equal(rows.get("character:3")?.nameCn, null);
});

test("narrows a multi-entity query and adds a type-specific condition atomically", () => {
  const named = applyQueryAction(defaultQueryDraft(), {
    type: "setText",
    text: { value: "机器人", capability: "lookup" },
  });
  const filtered = applyQueryAction(named, {
    type: "addCondition",
    owner: "subject",
    condition: {
      kind: "compare",
      field: "score",
      operator: "gte",
      value: 8,
    },
  });

  assert.deepEqual(filtered, {
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
    },
  });
});

test("rejects an incompatible scope expansion instead of deleting query meaning", () => {
  const draft: QueryDraft = {
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
    },
  };

  assert.throws(() => applyQueryAction(draft, {
    type: "setScope",
    scope: ["subject", "person"],
  }), /人物.*评分|评分.*人物/);
  assert.deepEqual(draft.query.scope, ["subject"]);
});

test("round-trips every user-visible query shape through QueryBundle", () => {
  const drafts: QueryDraft[] = [
    {
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
      },
    },
    {
      kind: "aggregate",
      query: {
        owner: "subject",
        condition: {
          kind: "compare",
          field: "year",
          operator: "gte",
          value: 2000,
        },
        aggregate: {
          groupBy: ["type"],
          metrics: [{ function: "count" }],
        },
      },
    },
    {
      kind: "list",
      allText: "星空",
    },
    {
      kind: "comparison",
      from: "subject:1",
      to: "person:2",
    },
    {
      kind: "path",
      from: "subject:1",
      to: "person:2",
      maxHops: 6,
      maxPaths: 10,
    },
  ];

  for (const draft of drafts)
    assert.deepEqual(queryDraftFromBundle(compileQueryDraft(draft)), draft);
});

test("uses one reducer for typed input, tokens, and result actions", () => {
  const initial = defaultQueryDraft("subject");
  const named = applyQueryAction(initial, {
    type: "setText",
    text: { value: "机器人", capability: "lookup" },
  });
  const filtered = applyQueryAction(named, {
    type: "addCondition",
    condition: {
      kind: "compare",
      field: "score",
      operator: "gte",
      value: 8,
    },
  });
  const secondFilter = applyQueryAction(filtered, {
    type: "addCondition",
    condition: {
      kind: "compare",
      field: "type",
      operator: "eq",
      value: 2,
    },
  });

  assert.equal(initial.kind, "list");
  assert.deepEqual(initial.query, { scope: ["subject"] });
  if (secondFilter.kind !== "list" || !secondFilter.query)
    assert.fail("list actions returned a non-list draft");
  assert.deepEqual(secondFilter.query.condition, {
    kind: "all",
    terms: [
      { kind: "compare", field: "score", operator: "gte", value: 8 },
      { kind: "compare", field: "type", operator: "eq", value: 2 },
    ],
  });
});

test("changes answer shape without losing compatible selection criteria", () => {
  const list = applyQueryAction(defaultQueryDraft("subject"), {
    type: "addCondition",
    condition: {
      kind: "compare",
      field: "score",
      operator: "gte",
      value: 8,
    },
  });
  const aggregate = applyQueryAction(list, {
    type: "setAggregate",
    aggregate: { groupBy: ["year"], metrics: [{ function: "count" }] },
  });
  const restored = applyQueryAction(aggregate, { type: "setList" });

  assert.equal(aggregate.kind, "aggregate");
  if (
    list.kind !== "list" || !list.query || aggregate.kind !== "aggregate" ||
    restored.kind !== "list" || !restored.query
  )
    assert.fail("answer-shape actions returned the wrong draft kind");
  assert.deepEqual(aggregate.query.condition, list.query.condition);
  assert.deepEqual(restored.query.condition, list.query.condition);
  assert.equal(restored.query.aggregate, undefined);
});

test("drops answer-specific sorting when switching between list and statistics", () => {
  const aggregate = applyQueryAction({
    kind: "list",
    query: {
      scope: ["subject"],
      orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
      limit: 5,
    },
  }, {
    type: "setAggregate",
    aggregate: { groupBy: [], metrics: [{ function: "count" }] },
  });

  assert.equal(aggregate.kind, "aggregate");
  if (aggregate.kind !== "aggregate") assert.fail("statistics action returned a list draft");
  assert.equal(aggregate.query.orderBy, undefined);
  assert.equal(aggregate.query.limit, 5);

  const restored = applyQueryAction({
    ...aggregate,
    query: {
      ...aggregate.query,
      orderBy: [{ column: "count", direction: "desc", nulls: "last" }],
    },
  }, { type: "setList" });

  assert.equal(restored.kind, "list");
  if (restored.kind !== "list" || !restored.query)
    assert.fail("list action returned a non-list draft");
  assert.equal(restored.query.orderBy, undefined);
  assert.equal(restored.query.limit, 5);
});

test("changing entity scope keeps meaning or reports an incompatibility", () => {
  const draft: QueryDraft = {
    kind: "list",
    query: {
      scope: ["subject"],
      text: { value: "星空", capability: "lookup" },
      condition: {
        kind: "compare",
        field: "score",
        operator: "gte",
        value: 8,
      },
      orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
    },
  };

  assert.throws(() => applyQueryAction(draft, {
    type: "setOwner",
    owner: "person",
  }), /人物不支持当前查询片段/);
});

test("changing statistic entity keeps its complete meaning or reports a conflict", () => {
  const draft: QueryDraft = {
    kind: "aggregate",
    query: {
      owner: "episode",
      text: { value: "再会", capability: "lookup" },
      aggregate: {
        groupBy: ["type"],
        metrics: [{ function: "avg", field: "duration" }],
      },
    },
  };

  assert.throws(() => applyQueryAction(draft, {
    type: "setOwner",
    owner: "person",
  }), /person\.duration|人物/);
});

test("merges continuous text input into one undo step", () => {
  let history = createQueryHistory(defaultQueryDraft("subject"));
  history = updateQueryHistory(history, {
    type: "setText",
    text: { value: "机", capability: "lookup" },
  }, "name");
  history = updateQueryHistory(history, {
    type: "setText",
    text: { value: "机器", capability: "lookup" },
  }, "name");
  history = updateQueryHistory(history, {
    type: "setText",
    text: { value: "机器人", capability: "lookup" },
  }, "name");

  const undone = undoQueryHistory(history);
  assert.deepEqual(undone.current, defaultQueryDraft("subject"));
  assert.deepEqual(redoQueryHistory(undone).current, history.current);
});

test("comparison and path transitions expose every execution boundary", () => {
  const initial = defaultQueryDraft("subject");
  const comparison = applyQueryAction(initial, {
    type: "setComparison",
    from: "subject:1",
    to: "person:2",
  });
  const path = applyQueryAction(comparison, {
    type: "setPath",
    from: "subject:1",
    to: "person:2",
    maxHops: 7,
    maxPaths: 21,
  });

  assert.deepEqual(comparison, {
    kind: "comparison",
    from: "subject:1",
    to: "person:2",
  });
  assert.deepEqual(path, {
    kind: "path",
    from: "subject:1",
    to: "person:2",
    maxHops: 7,
    maxPaths: 21,
  });
  assert.equal(
    compileQueryDraft(path).sections.paths?.query.limit,
    21,
  );
});

test("keeps all published long text in the list answer shape", () => {
  const draft = applyQueryAction(defaultQueryDraft(), {
    type: "setAllText",
    text: "星空",
  });
  assert.deepEqual(draft, { kind: "list", allText: "星空" });
  assert.equal(Object.keys(compileQueryDraft(draft).sections).includes("VOICE_CREDIT-summary"), true);
  assert.throws(() => applyQueryAction(defaultQueryDraft(), {
    type: "setAllText",
    text: "星",
  }), /至少需要/);
});
