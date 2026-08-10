import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueryDocument } from "../src/query/document";
import {
  executeQuery,
  type EntityValue,
  type FactValue,
  type PathValue,
  type QueryDataSource,
} from "../src/query/engine";

const entities: EntityValue[] = [
  { kind: "entity", owner: "person", ref: "person:1", fields: { name: "P" } },
  { kind: "entity", owner: "character", ref: "character:7", fields: { name: "C" } },
  { kind: "entity", owner: "subject", ref: "subject:2", fields: { name: "S2" } },
  { kind: "entity", owner: "subject", ref: "subject:3", fields: { name: "S3" } },
  { kind: "entity", owner: "subject", ref: "subject:99", fields: { name: "context" } },
];

const facts: FactValue[] = [
  {
    kind: "fact",
    factKind: "RELATES_TO",
    ref: "fact:12",
    multiplicity: 1,
    roles: { source: "subject:2", target: "subject:3" },
    fields: { relationType: 1, sortOrder: 0 },
  },
  {
    kind: "fact",
    factKind: "WORKED_ON",
    ref: "fact:11",
    multiplicity: 1,
    roles: { person: "person:1", subject: "subject:2" },
    fields: { position: "原作", appearEps: "" },
  },
  {
    kind: "fact",
    factKind: "APPEARS_IN",
    ref: "fact:10",
    multiplicity: 1,
    roles: { character: "character:7", subject: "subject:3" },
    fields: { type: 1, sortOrder: 0 },
  },
  {
    kind: "fact",
    factKind: "VOICE_CREDIT",
    ref: "fact:9",
    multiplicity: 1,
    roles: {
      person: "person:1",
      character: "character:7",
      subjectContext: "subject:99",
    },
    fields: { type: 1, hasSummary: false },
  },
];

const entityByRef = new Map(entities.map((entity) => [entity.ref, entity]));
const source: QueryDataSource = {
  scan: async function* () {},
  entity: async (ref) => entityByRef.get(ref) ?? null,
  facts: async function* (ref) {
    for (const fact of facts)
      if (Object.values(fact.roles).includes(ref)) yield fact;
  },
};

const pathQuery = (target: string): QueryDocument => ({
  schema: "atlas-query-document-v1",
  root: "path",
  parameters: {},
  operators: {
    endpoints: {
      kind: "values",
      columns: ["start", "target"],
      rows: [["person:1", target]],
    },
    path: {
      kind: "path",
      input: "endpoints",
      start: { kind: "column", name: "start" },
      target: { kind: "column", name: "target" },
      binding: "route",
      policy: "fewest-hops",
      maxHops: 3,
      maxPaths: 2,
      traversals: [
        { factKind: "VOICE_CREDIT", rolePairs: [{ from: "person", to: "character" }] },
        { factKind: "APPEARS_IN", rolePairs: [{ from: "character", to: "subject" }] },
        { factKind: "WORKED_ON", rolePairs: [{ from: "person", to: "subject" }] },
        { factKind: "RELATES_TO", rolePairs: [{ from: "source", to: "target" }] },
      ],
    },
  },
});

test("returns all deterministic shortest simple paths with full fact context", async () => {
  const result = await executeQuery(pathQuery("subject:3"), {}, source, {
    pageSize: 10,
  });

  assert.equal(result.rows.length, 2);
  const paths = result.rows.map((row) => row.route as PathValue);
  assert.deepEqual(
    paths.map((path) => path.nodes.map((node) => node.ref)),
    [
      ["person:1", "character:7", "subject:3"],
      ["person:1", "subject:2", "subject:3"],
    ],
  );
  assert.deepEqual(
    paths[0]?.steps.map((step) => [step.fact.ref, step.fromRole, step.toRole]),
    [
      ["fact:9", "person", "character"],
      ["fact:10", "character", "subject"],
    ],
  );
  assert.deepEqual(paths[0]?.steps[0]?.fact.roles, {
    person: "person:1",
    character: "character:7",
    subjectContext: "subject:99",
  });
  assert.deepEqual(result.evidence[0]?.route, [{
    kind: "path",
    facts: ["fact:9", "fact:10"],
  }]);
});

test("does not traverse an unlisted role pair of a multi-role fact", async () => {
  const result = await executeQuery(pathQuery("subject:99"), {}, source, {
    pageSize: 10,
  });

  assert.deepEqual(result.rows, []);
});

test("ignores an unresolved archived role without aborting other path branches", async () => {
  const unresolvedFacts = facts.map((fact) =>
    fact.factKind === "VOICE_CREDIT"
      ? {
          ...fact,
          roles: { ...fact.roles, subjectContext: "subject:404" as const },
        }
      : fact
  );
  const unresolvedSource: QueryDataSource = {
    scan: async function* () {},
    entity: async (ref) => entityByRef.get(ref) ?? null,
    facts: async function* (ref) {
      for (const fact of unresolvedFacts)
        if (Object.values(fact.roles).includes(ref)) yield fact;
    },
  };
  const query = pathQuery("subject:3");
  const path = query.operators.path;
  assert.equal(path?.kind, "path");
  if (path?.kind === "path") {
    path.traversals[0] = {
      factKind: "VOICE_CREDIT",
      rolePairs: [
        { from: "person", to: "subjectContext" },
        { from: "person", to: "character" },
      ],
    };
  }

  const result = await executeQuery(query, {}, unresolvedSource, { pageSize: 10 });

  assert.equal(result.rows.length, 2);
});

test("does not impose a hidden fact-read quota on paths", async () => {
  const relation = facts[0] as FactValue;
  const boundedSource: QueryDataSource = {
    scan: async function* () {},
    entity: async (ref) => entityByRef.get(ref) ?? null,
    facts: async function* (ref) {
      if (ref === "subject:2") yield relation;
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "path",
    parameters: {},
    operators: {
      endpoints: {
        kind: "values",
        columns: ["start", "target"],
        rows: [
          ["subject:2", "subject:3"],
          ["subject:2", "subject:3"],
        ],
      },
      path: {
        kind: "path",
        input: "endpoints",
        start: { kind: "column", name: "start" },
        target: { kind: "column", name: "target" },
        binding: "route",
        policy: "fewest-hops",
        maxHops: 1,
        maxPaths: 1,
        traversals: [{
          factKind: "RELATES_TO",
          rolePairs: [{ from: "source", to: "target" }],
        }],
      },
    },
  };
  const result = await executeQuery(query, {}, boundedSource, { pageSize: 10 });
  assert.equal(result.rows.length, 2);
});
