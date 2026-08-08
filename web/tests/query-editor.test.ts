import assert from "node:assert/strict";
import { test } from "node:test";

import { undo } from "prosemirror-history";
import { EditorState } from "prosemirror-state";

import type { QueryBundle } from "../src/query/bundle";
import type { QueryOperator } from "../src/query/document";
import {
  createQueryEditorDocument,
  createQueryBundleDocument,
  createQueryRecipeDocument,
  createQueryEditorState,
  lowerQueryEditorDocument,
  queryEditorSchema,
  readableQueryEditorDocument,
} from "../src/query/editor";

test("round-trips the ordinary query through one structural document", () => {
  const doc = createQueryEditorDocument({
    owner: "subject",
    text: { value: "机器人", capability: "fullText", field: "summary" },
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
      condition: { kind: "compare", field: "position", operator: "eq", value: 2 },
    }],
    columns: ["ref", "name", "nameCn", "score"],
    orderBy: [
      { column: "score", direction: "desc", nulls: "last" },
      { column: "name", direction: "asc", nulls: "first" },
    ],
    limit: 50,
  });

  assert.deepEqual(doc.toJSON().content?.map(
    (node: { type: string }) => node.type,
  ), [
    "find",
    "search",
    "condition",
    "relation",
    "projection",
    "sort",
    "sort",
    "limit",
  ]);
  assert.deepEqual(lowerQueryEditorDocument(doc), {
    draft: {
      owner: "subject",
      text: { value: "机器人", capability: "fullText", field: "summary" },
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
        condition: { kind: "compare", field: "position", operator: "eq", value: 2 },
      }],
      columns: ["ref", "name", "nameCn", "score"],
      orderBy: [
        { column: "score", direction: "desc", nulls: "last" },
        { column: "name", direction: "asc", nulls: "first" },
      ],
      limit: 50,
    },
    diagnostics: [],
  });
});

test("starts with only the find clause and keeps defaults semantic", () => {
  const doc = createQueryEditorDocument({ owner: "subject" });
  assert.equal(doc.childCount, 1);
  assert.equal(doc.firstChild?.type.name, "find");
});

test("preserves an incomplete clause without replacing the last valid query", () => {
  const doc = queryEditorSchema.node("doc", null, [
    queryEditorSchema.node("find", { owner: "subject" }),
    queryEditorSchema.node("condition", {
      field: "score",
      operator: "gte",
      raw: "",
    }),
  ]);

  const lowered = lowerQueryEditorDocument(doc);
  assert.equal(lowered.draft, null);
  assert.deepEqual(lowered.diagnostics, [{
    clause: 1,
    message: "请填写评分的值",
  }]);
  assert.equal(doc.childCount, 2);
});

test("round-trips nested all, any, and excluded condition groups structurally", () => {
  const condition = {
    kind: "all" as const,
    terms: [
      { kind: "compare" as const, field: "score", operator: "gte" as const, value: 8 },
      {
        kind: "any" as const,
        terms: [
          { kind: "compare" as const, field: "type", operator: "eq" as const, value: 1 },
          { kind: "compare" as const, field: "type", operator: "eq" as const, value: 2 },
        ],
      },
      {
        kind: "not" as const,
        term: { kind: "compare" as const, field: "year", operator: "lt" as const, value: 2000 },
      },
    ],
  };
  const doc = createQueryEditorDocument({ owner: "subject", condition });
  const group = doc.child(1);

  assert.equal(group.type.name, "condition_group");
  assert.equal(group.attrs.mode, "all");
  assert.equal(group.child(1).type.name, "condition_group");
  assert.equal(group.child(1).attrs.mode, "any");
  assert.equal(group.child(2).attrs.mode, "not");
  assert.deepEqual(lowerQueryEditorDocument(doc).draft?.condition, condition);
  assert.match(readableQueryEditorDocument(doc), /全部满足/);
  assert.match(readableQueryEditorDocument(doc), /任一满足/);
  assert.match(readableQueryEditorDocument(doc), /排除/);
});

test("serializes readable domain language without exposing stored identities", () => {
  const doc = createQueryEditorDocument({
    owner: "subject",
    condition: {
      kind: "compare",
      field: "type",
      operator: "eq",
      value: 2,
    },
    relations: [{
      factKind: "WORKED_ON",
      candidateRole: "subject",
      relatedRole: "person",
      related: "person:7",
      exists: true,
    }],
    limit: 20,
  });

  const text = readableQueryEditorDocument(doc, (ref) =>
    ref === "person:7" ? "宫崎骏" : ref
  );
  assert.match(text, /查找作品/);
  assert.match(text, /类型 等于 动画/);
  assert.match(text, /人物参与.*宫崎骏/);
  assert.doesNotMatch(text, /subject|WORKED_ON|person:7|\b2\b/);
});

test("records slot changes as ProseMirror transactions in one undo history", () => {
  let state = createQueryEditorState(createQueryEditorDocument({
    owner: "subject",
    limit: 200,
  }));
  const before = state.doc.toJSON();
  const limitPosition = state.doc.child(0).nodeSize;
  state = state.apply(state.tr.setNodeAttribute(limitPosition, "raw", "50"));
  assert.equal(state.doc.child(1).attrs.raw, "50");

  const captured: { state?: EditorState } = {};
  assert.equal(undo(state, (transaction) => {
    captured.state = state.apply(transaction);
  }), true);
  assert.deepEqual(captured.state?.doc.toJSON(), before);
});

test("restores the editor document exactly from its structured JSON", () => {
  const original = createQueryEditorDocument({
    owner: "episode",
    text: {
      value: "再会",
      capability: "fullText",
      field: "description",
    },
    limit: 30,
  });
  const restored = queryEditorSchema.nodeFromJSON(original.toJSON());

  assert.deepEqual(restored.toJSON(), original.toJSON());
  assert.deepEqual(
    lowerQueryEditorDocument(restored),
    lowerQueryEditorDocument(original),
  );
});

test("represents context recipes in the same editor document", () => {
  const doc = createQueryRecipeDocument({
    kind: "path",
    from: "subject:1",
    to: "person:2",
  });

  assert.deepEqual(lowerQueryEditorDocument(doc), {
    draft: null,
    recipe: { kind: "path", from: "subject:1", to: "person:2" },
    diagnostics: [],
  });
  assert.equal(readableQueryEditorDocument(doc, (ref) => ({
    "subject:1": "千与千寻",
    "person:2": "宫崎骏",
  })[ref] ?? ref), "查找 千与千寻 到 宫崎骏 的关系路径");
});

test("represents every executable operator as a structural editor node", () => {
  const operators: Record<string, QueryOperator> = {
    scan: { kind: "scan", owner: "subject", binding: "item" },
    lookup: {
      kind: "lookup", owner: "subject", binding: "item",
      text: { kind: "literal", value: "星" },
    },
    fullText: {
      kind: "fullText", target: "entity", owner: "subject", binding: "item",
      field: "summary", text: { kind: "parameter", name: "keyword" },
    },
    factLookup: {
      kind: "factLookup", factKind: "WORKED_ON", factBinding: "fact",
      roles: { person: "person", subject: "subject" },
      ref: { kind: "literal", value: "fact:1" },
    },
    values: { kind: "values", columns: ["item"], rows: [["subject:1"]] },
    filter: {
      kind: "filter", input: "scan",
      predicate: { kind: "isNull", term: { kind: "field", binding: "item", field: "score" } },
    },
    project: {
      kind: "project", input: "scan",
      columns: [{ name: "name", value: { kind: "field", binding: "item", field: "name" } }],
    },
    matchFact: {
      kind: "matchFact", input: "scan", factKind: "WORKED_ON",
      factBinding: "fact", roles: { person: "person", subject: "item" },
    },
    followRef: {
      kind: "followRef", input: "scan", referenceOwner: "episode",
      field: "subjectRef", anchorBinding: "episode", resultBinding: "subject",
      direction: "forward",
    },
    aggregate: {
      kind: "aggregate", input: "scan",
      groupBy: [{ name: "type", value: { kind: "field", binding: "item", field: "type" } }],
      metrics: [{ name: "count", function: "count" }],
    },
    path: {
      kind: "path", input: "values",
      start: { kind: "column", name: "from" },
      target: { kind: "column", name: "to" }, binding: "path",
      policy: "fewest-hops", maxHops: 6, maxPaths: 10,
      traversals: [{ factKind: "WORKED_ON", rolePairs: [{ from: "person", to: "subject" }] }],
    },
    union: { kind: "union", branches: [{ input: "scan", columns: [] }] },
    intersect: { kind: "intersect", branches: [{ input: "scan", columns: [] }] },
    except: { kind: "except", branches: [{ input: "scan", columns: [] }] },
    exists: { kind: "exists", input: "scan", match: "lookup", columns: [] },
    notExists: { kind: "notExists", input: "scan", match: "lookup", columns: [] },
  };
  const bundle: QueryBundle = {
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: {
      results: {
        query: {
          schema: "atlas-query-document-v2",
          root: "scan",
          parameters: { keyword: "string" },
          operators,
          limit: 10,
        },
        parameterValues: { keyword: "机器人" },
        answer: { shape: "table" as const, title: "收藏分析" },
      },
    },
  };
  const doc = createQueryBundleDocument(bundle);

  const section = doc.firstChild?.firstChild;
  assert.equal(doc.firstChild?.type.name, "query_bundle");
  assert.equal(section?.type.name, "query_section");
  assert.deepEqual(
    section?.content.content.map((node) => node.type.name),
    [
      "op_scan", "op_lookup", "op_full_text", "op_fact_lookup",
      "op_values", "op_filter", "op_project", "op_match_fact",
      "op_follow_ref", "op_aggregate", "op_path", "op_union",
      "op_intersect", "op_except", "op_exists", "op_not_exists",
    ],
  );
  assert.deepEqual(lowerQueryEditorDocument(doc), { draft: null, bundle, diagnostics: [] });
  assert.match(readableQueryEditorDocument(doc), /收藏分析/);
  assert.doesNotMatch(readableQueryEditorDocument(doc), /scan|WORKED_ON|keyword/);
});
