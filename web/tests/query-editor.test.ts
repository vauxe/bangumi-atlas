import assert from "node:assert/strict";
import { test } from "node:test";

import { undo } from "prosemirror-history";
import { EditorState } from "prosemirror-state";

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
    }],
    columns: ["ref", "name", "nameCn", "score"],
    orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
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
      }],
      columns: ["ref", "name", "nameCn", "score"],
      orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
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

test("keeps a non-editable restored bundle inside the structural document", () => {
  const bundle = {
    schema: "atlas-query-bundle-v2" as const,
    release: { policy: "latest" as const },
    sections: {
      results: {
        query: {
          schema: "atlas-query-document-v2" as const,
          root: "source",
          parameters: {},
          operators: {
            source: { kind: "scan" as const, owner: "subject" as const, binding: "item" },
          },
          limit: 10,
        },
        answer: { shape: "table" as const, title: "收藏分析" },
      },
    },
  };
  const doc = createQueryBundleDocument(bundle);

  assert.deepEqual(lowerQueryEditorDocument(doc), {
    draft: null,
    bundle,
    diagnostics: [],
  });
  assert.equal(readableQueryEditorDocument(doc), "已保存查询：收藏分析");
});
