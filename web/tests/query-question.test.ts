import assert from "node:assert/strict";
import { test } from "node:test";

import { executeQuery, type EntityValue, type QueryDataSource } from "../src/query/engine";
import { queryBundleDigest } from "../src/query/bundle";
import { compileQuestion } from "../src/query/question";

const subjects: EntityValue[] = [
  { kind: "entity", owner: "subject", ref: "subject:1", fields: { name: "A", nameCn: "", type: 2, date: "2020-01-01", score: 8, rank: 2 } },
  { kind: "entity", owner: "subject", ref: "subject:2", fields: { name: "B", nameCn: "", type: 2, date: "2021-01-01", score: 9, rank: 1 } },
];
const source: QueryDataSource = {
  scan: async function* (owner) {
    if (owner === "subject") yield* subjects;
  },
};

test("compiles an ordinary find question to the shared typed executor", async () => {
  const bundle = compileQuestion({
    schema: "atlas-question-v1",
    mode: "find",
    owner: "subject",
    condition: { kind: "compare", field: "score", operator: "gte", value: 8.5 },
    columns: ["ref", "name", "score"],
    orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
    limit: 20,
  });

  const result = await executeQuery(
    bundle.sections.results!.query,
    {},
    source,
    { pageSize: 20 },
  );

  assert.deepEqual(result.rows, [{ ref: "subject:2", name: "B", score: 9 }]);
  assert.equal(bundle.sections.results?.answer.shape, "entity-list");
});

test("compiles positive and negative relationship conditions as exact correlations", () => {
  const bundle = compileQuestion({
    schema: "atlas-question-v1",
    mode: "find",
    owner: "subject",
    relations: [
      {
        factKind: "WORKED_ON",
        candidateRole: "subject",
        relatedRole: "person",
        related: "person:7",
        exists: true,
      },
      {
        factKind: "APPEARS_IN",
        candidateRole: "subject",
        relatedRole: "character",
        related: "character:9",
        exists: false,
      },
    ],
  });
  const operators = bundle.sections.results?.query.operators ?? {};
  assert.equal(operators.relation0Exists?.kind, "exists");
  assert.equal(operators.relation1Exists?.kind, "notExists");
  assert.deepEqual(
    operators.relation0Expand?.kind === "matchFact"
      ? operators.relation0Expand.roles
      : null,
    { person: "relation0Fixed", subject: "relation0Candidate" },
  );
});

test("bundle digest covers sorted sections and answer shape", async () => {
  const first = compileQuestion({
    schema: "atlas-question-v1",
    mode: "find",
    owner: "subject",
    limit: 10,
  });
  const same = {
    ...first,
    sections: Object.fromEntries(Object.entries(first.sections).reverse()),
  };
  assert.equal(await queryBundleDigest(first), await queryBundleDigest(same));
  const changed = structuredClone(first);
  changed.sections.results!.answer.title = "不同答案";
  assert.notEqual(await queryBundleDigest(first), await queryBundleDigest(changed));
});

test("keeps all roles of a multi-role fact in an understand section", () => {
  const bundle = compileQuestion({
    schema: "atlas-question-v1",
    mode: "understand",
    anchor: "person:1",
  });
  const voice = bundle.sections["VOICE_CREDIT-person"]?.query;
  const expand = voice?.operators.matchFact;

  assert.deepEqual(expand, {
    kind: "matchFact",
    input: "anchor",
    factKind: "VOICE_CREDIT",
    factBinding: "fact",
    roles: {
      person: "anchor",
      character: "character",
      subjectContext: "subjectContext",
    },
  });
});

test("compiles comparison as exact intersection and both differences", () => {
  const bundle = compileQuestion({
    schema: "atlas-question-v1",
    mode: "compare",
    left: "subject:1",
    right: "subject:2",
  });

  assert.deepEqual(Object.keys(bundle.sections), ["all", "common", "leftOnly", "rightOnly"]);
  assert.ok(Object.values(bundle.sections.all?.query.operators ?? {})
    .some((operator) => operator.kind === "union"));
  assert.ok(Object.values(bundle.sections.common?.query.operators ?? {})
    .some((operator) => operator.kind === "intersect"));
  assert.ok(Object.values(bundle.sections.leftOnly?.query.operators ?? {})
    .some((operator) => operator.kind === "except"));
});
