import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalJson,
  normalizeQuery,
  queryDigest,
} from "../src/query/canonical";
import type { QueryDocument } from "../src/query/document";
import { QUERY_SECURITY_PROFILE } from "../src/query/security";

const document = (
  scanId: string,
  filterId: string,
  reverseTerms = false,
): QueryDocument => {
  const terms = [
    {
      kind: "compare" as const,
      operator: "gte" as const,
      left: { kind: "field" as const, binding: "s", field: "score" },
      right: { kind: "parameter" as const, name: "min" },
    },
    {
      kind: "compare" as const,
      operator: "eq" as const,
      left: { kind: "field" as const, binding: "s", field: "type" },
      right: { kind: "literal" as const, value: 2 },
    },
  ];
  return {
    schema: "atlas-query-document-v2",
    root: filterId,
    parameters: { min: "number" },
    operators: {
      [scanId]: { kind: "scan", owner: "subject", binding: "s" },
      [filterId]: {
        kind: "filter",
        input: scanId,
        predicate: {
          kind: "and",
          terms: reverseTerms ? terms.reverse() : terms,
        },
      },
      unreachable: { kind: "scan", owner: "person", binding: "p" },
    },
  };
};

test("normalizes ids, parameters, unreachable nodes, and commutative predicates", async () => {
  const first = normalizeQuery(document("source", "filtered"), { min: 8 });
  const second = normalizeQuery(document("x", "y", true), { min: 8 });

  assert.deepEqual(first, second);
  assert.equal(Object.keys(first.operators).length, 2);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(await queryDigest(first), await queryDigest(second));
});

test("alpha-renames internal bindings without renaming projected columns", () => {
  const make = (binding: string): QueryDocument => ({
    schema: "atlas-query-document-v2",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding },
      project: {
        kind: "project",
        input: "scan",
        columns: [
          {
            name: "name",
            value: { kind: "field", binding, field: "name" },
          },
        ],
      },
    },
  });

  const first = normalizeQuery(make("subject"), {});
  const second = normalizeQuery(make("s"), {});
  assert.deepEqual(first, second);
  const root = first.operators[first.root];
  assert.equal(root?.kind === "project" ? root.columns[0]?.name : null, "name");
});

test("preserves values row order and duplicate bag entries", async () => {
  const values = (rows: number[][]): QueryDocument => ({
    schema: "atlas-query-document-v2",
    root: "values",
    parameters: {},
    operators: {
      values: { kind: "values", columns: ["n"], rows },
    },
  });

  const repeated = normalizeQuery(values([[1], [1], [2]]), {});
  const reordered = normalizeQuery(values([[1], [2], [1]]), {});

  assert.notEqual(await queryDigest(repeated), await queryDigest(reordered));
});

test("rejects parameter mismatches, cycles, and non-finite literals", () => {
  assert.throws(
    () => normalizeQuery(document("a", "b"), { min: 8, extra: 1 }),
    /parameter extra/,
  );
  assert.throws(
    () => normalizeQuery(document("a", "b"), {}),
    /parameter min/,
  );

  const cyclic = document("a", "b");
  cyclic.operators.a = { kind: "filter", input: "b", predicate: {
    kind: "literal", value: true,
  } };
  assert.throws(() => normalizeQuery(cyclic, { min: 8 }), /cycle/);

  const invalid = document("a", "b");
  invalid.operators.b = {
    kind: "filter",
    input: "a",
    predicate: { kind: "literal", value: Number.NaN },
  };
  assert.throws(() => normalizeQuery(invalid, { min: 8 }), /finite/);
});

test("rejects unsafe names before building row objects", () => {
  const invalid: QueryDocument = {
    schema: "atlas-query-document-v2",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [
          {
            name: "__proto__",
            value: { kind: "field", binding: "subject", field: "name" },
          },
        ],
      },
    },
  };

  assert.throws(() => normalizeQuery(invalid, {}), /query name/);
  assert.throws(
    () => normalizeQuery({ ...invalid, root: "constructor" }, {}),
    /query name/,
  );

  const invalidOwner = structuredClone(invalid);
  invalidOwner.root = "scan";
  invalidOwner.operators = {
    scan: { kind: "scan", owner: "unknown" as "subject", binding: "entity" },
  };
  assert.throws(() => normalizeQuery(invalidOwner, {}), /query owner/);
});

test("rejects incompatible contains element types", () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v2",
    root: "filter",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "person", binding: "person" },
      filter: {
        kind: "filter",
        input: "scan",
        predicate: {
          kind: "compare",
          operator: "contains",
          left: { kind: "field", binding: "person", field: "career" },
          right: { kind: "literal", value: 7 },
        },
      },
    },
  };

  assert.throws(() => normalizeQuery(query, {}), /contains operand type mismatch/);
});

test("type-checks entity-reference fields against canonical references", () => {
  const episodeBySubject = (value: string): QueryDocument => ({
    schema: "atlas-query-document-v2",
    root: "filter",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "episode", binding: "episode" },
      filter: {
        kind: "filter",
        input: "scan",
        predicate: {
          kind: "compare",
          operator: "eq",
          left: { kind: "field", binding: "episode", field: "subjectRef" },
          right: { kind: "literal", value },
        },
      },
    },
  });

  assert.doesNotThrow(() => normalizeQuery(episodeBySubject("subject:265"), {}));
  assert.throws(
    () => normalizeQuery(episodeBySubject("person:265"), {}),
    /entity reference type mismatch/,
  );
  assert.throws(
    () => normalizeQuery(episodeBySubject("265"), {}),
    /entity reference/,
  );
});

test("enforces the Values cell limit across the whole query", () => {
  const rows = Array.from(
    { length: QUERY_SECURITY_PROFILE.document.maxValuesCells / 2 + 1 },
    (_, value) => [value],
  );
  const query: QueryDocument = {
    schema: "atlas-query-document-v2",
    root: "union",
    parameters: {},
    operators: {
      left: { kind: "values", columns: ["n"], rows },
      right: { kind: "values", columns: ["n"], rows },
      union: {
        kind: "union",
        branches: [
          { input: "left", columns: [{ input: "n", output: "n" }] },
          { input: "right", columns: [{ input: "n", output: "n" }] },
        ],
      },
    },
  };

  assert.throws(() => normalizeQuery(query, {}), /query exceeds its Values cell limit/);
});
