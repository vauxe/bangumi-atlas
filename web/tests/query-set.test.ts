import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeQuery, queryDigest } from "../src/query/canonical";
import type { QueryDocument } from "../src/query/document";
import { executeQuery, type QueryDataSource } from "../src/query/engine";

const empty: QueryDataSource = { scan: async function* () {} };

const setQuery = (
  kind: "union" | "intersect" | "except",
  reverse = false,
): QueryDocument => {
  const branches = [
    { input: "left", columns: [{ output: "value", input: "a" }] },
    { input: "right", columns: [{ output: "value", input: "b" }] },
  ];
  return {
    schema: "atlas-query-document-v1",
    root: "set",
    parameters: {},
    operators: {
      left: { kind: "values", columns: ["a"], rows: [[1], [1], [2]] },
      right: { kind: "values", columns: ["b"], rows: [[2], [3], [3]] },
      set: { kind, branches: reverse ? branches.reverse() : branches },
    },
    orderBy: [{ column: "value", direction: "asc", nulls: "last" }],
  };
};

test("set operators use explicit mappings and distinct row semantics", async () => {
  const union = await executeQuery(setQuery("union"), {}, empty, { pageSize: 20 });
  const intersection = await executeQuery(setQuery("intersect"), {}, empty, { pageSize: 20 });
  const difference = await executeQuery(setQuery("except"), {}, empty, { pageSize: 20 });

  assert.deepEqual(union.rows, [{ value: 1 }, { value: 2 }, { value: 3 }]);
  assert.equal(intersection.totalMatches, 1);
  assert.deepEqual(intersection.rows, [{ value: 2 }]);
  assert.deepEqual(difference.rows, [{ value: 1 }]);
});

test("normalizes commutative set branches but preserves except order", async () => {
  const union = normalizeQuery(setQuery("union"), {});
  const reversedUnion = normalizeQuery(setQuery("union", true), {});
  const difference = normalizeQuery(setQuery("except"), {});
  const reversedDifference = normalizeQuery(setQuery("except", true), {});

  assert.equal(await queryDigest(union), await queryDigest(reversedUnion));
  assert.notEqual(await queryDigest(difference), await queryDigest(reversedDifference));
});

test("exists and notExists perform typed correlation without changing the outer row", async () => {
  const query = (kind: "exists" | "notExists"): QueryDocument => ({
    schema: "atlas-query-document-v1",
    root: "correlate",
    parameters: {},
    operators: {
      outer: { kind: "values", columns: ["entity", "label"], rows: [[1, "a"], [2, "b"], [3, "c"]] },
      inner: { kind: "values", columns: ["matched"], rows: [[2], [2], [3]] },
      correlate: {
        kind,
        input: "outer",
        match: "inner",
        columns: [{ outer: "entity", inner: "matched" }],
      },
    },
    orderBy: [{ column: "entity", direction: "asc", nulls: "last" }],
  });

  assert.deepEqual(
    (await executeQuery(query("exists"), {}, empty, { pageSize: 20 })).rows,
    [{ entity: 2, label: "b" }, { entity: 3, label: "c" }],
  );
  assert.deepEqual(
    (await executeQuery(query("notExists"), {}, empty, { pageSize: 20 })).rows,
    [{ entity: 1, label: "a" }],
  );
});

test("validates exists correlation columns and types", async () => {
  const invalid: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "exists",
    parameters: {},
    operators: {
      outer: { kind: "values", columns: ["entity"], rows: [[1]] },
      inner: { kind: "values", columns: ["name"], rows: [["one"]] },
      exists: {
        kind: "exists",
        input: "outer",
        match: "inner",
        columns: [{ outer: "entity", inner: "name" }],
      },
    },
  };
  await assert.rejects(
    executeQuery(invalid, {}, empty, { pageSize: 20 }),
    /type mismatch/,
  );
});

test("does not impose a row quota on set branches", async () => {
  const result = await executeQuery(setQuery("union"), {}, empty, { pageSize: 20 });
  assert.deepEqual(result.rows, [{ value: 1 }, { value: 2 }, { value: 3 }]);
});

test("does not impose a row quota on correlated existence", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "exists",
    parameters: {},
    operators: {
      outer: { kind: "values", columns: ["entity"], rows: [[1]] },
      inner: { kind: "values", columns: ["matched"], rows: [[1], [1], [1]] },
      exists: {
        kind: "exists",
        input: "outer",
        match: "inner",
        columns: [{ outer: "entity", inner: "matched" }],
      },
    },
  };
  const result = await executeQuery(query, {}, empty, { pageSize: 20 });
  assert.deepEqual(result.rows, [{ entity: 1 }]);
});
