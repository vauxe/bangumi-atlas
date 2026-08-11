import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueryDocument } from "../src/query/document";
import {
  executeQuery,
  type EntityValue,
  type QueryDataSource,
} from "../src/query/engine";
import { MISSING } from "../src/query/value";

const rows: EntityValue[] = [
  { kind: "entity", owner: "subject", ref: "subject:1", fields: { type: 2, score: 8, wish: 10 } },
  { kind: "entity", owner: "subject", ref: "subject:2", fields: { type: 2, score: null, wish: 20 } },
  { kind: "entity", owner: "subject", ref: "subject:3", fields: { type: 2, score: MISSING, wish: 30 } },
  { kind: "entity", owner: "subject", ref: "subject:4", fields: { type: 1, score: 6, wish: 5 } },
];

const source: QueryDataSource = {
  scan: async function* () {
    yield* rows;
  },
};

test("aggregates groups while ignoring null and missing measure values", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "aggregate",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "s" },
      aggregate: {
        kind: "aggregate",
        input: "scan",
        groupBy: [{ name: "type", value: { kind: "field", binding: "s", field: "type" } }],
        metrics: [
          { name: "rows", function: "count" },
          { name: "unique", function: "countDistinct", value: { kind: "field", binding: "s", field: "id" } },
          { name: "scored", function: "count", value: { kind: "field", binding: "s", field: "score" } },
          { name: "wish", function: "sum", value: { kind: "field", binding: "s", field: "wish" } },
          { name: "minimum", function: "min", value: { kind: "field", binding: "s", field: "score" } },
          { name: "maximum", function: "max", value: { kind: "field", binding: "s", field: "score" } },
          { name: "average", function: "avg", value: { kind: "field", binding: "s", field: "score" } },
        ],
      },
    },
    orderBy: [{ column: "type", direction: "asc", nulls: "last" }],
  };

  const result = await executeQuery(query, {}, source, { pageSize: 20 });

  assert.deepEqual(result.rows, [
    { type: 1, rows: 1, unique: 1, scored: 1, wish: 5, minimum: 6, maximum: 6, average: 6 },
    { type: 2, rows: 3, unique: 3, scored: 1, wish: 60, minimum: 8, maximum: 8, average: 8 },
  ]);
  assert.equal(result.evidence[0]?.average?.[0]?.kind, "aggregate-lineage");
});

test("returns the defined empty global aggregate", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "aggregate",
    parameters: {},
    operators: {
      values: { kind: "values", columns: ["n"], rows: [] },
      aggregate: {
        kind: "aggregate",
        input: "values",
        groupBy: [],
        metrics: [
          { name: "rows", function: "count" },
          { name: "sum", function: "sum", value: { kind: "column", name: "n" } },
          { name: "min", function: "min", value: { kind: "column", name: "n" } },
        ],
      },
    },
  };

  const result = await executeQuery(query, {}, source, { pageSize: 20 });

  assert.deepEqual(result.rows, [{ rows: 0, sum: null, min: null }]);
});

test("does not let projection bypass aggregate field capabilities", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "aggregate",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [{ name: "name", value: { kind: "field", binding: "subject", field: "name" } }],
      },
      aggregate: {
        kind: "aggregate",
        input: "project",
        groupBy: [],
        metrics: [{ name: "minimum", function: "min", value: { kind: "column", name: "name" } }],
      },
    },
  };

  await assert.rejects(
    executeQuery(query, {}, source, { pageSize: 20 }),
    /subject\.name does not support aggregate/,
  );
});

test("does not let projection bypass sort field capabilities", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [{ name: "nsfw", value: { kind: "field", binding: "subject", field: "nsfw" } }],
      },
    },
    orderBy: [{ column: "nsfw", direction: "asc", nulls: "last" }],
  };

  await assert.rejects(
    executeQuery(query, {}, source, { pageSize: 20 }),
    /subject\.nsfw does not support sort/,
  );
});
