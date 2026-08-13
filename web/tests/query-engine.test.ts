import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueryDocument } from "../src/query/document";
import {
  compareOrderedValue,
  executeQuery,
  insertTop,
  type EntityValue,
  type FactValue,
  type QueryDataSource,
  type QueryResultEntity,
  type RankedRow,
} from "../src/query/engine";
import { QUERY_SECURITY_PROFILE } from "../src/query/security";
import { MISSING } from "../src/query/value";

const subjects: EntityValue[] = [
  {
    kind: "entity",
    owner: "subject",
    ref: "subject:1",
    fields: { name: "C", type: 2, score: 8.1 },
  },
  {
    kind: "entity",
    owner: "subject",
    ref: "subject:2",
    fields: { name: "A", type: 2, score: null },
  },
  {
    kind: "entity",
    owner: "subject",
    ref: "subject:3",
    fields: { name: "B", type: 2, score: 9.2 },
  },
  {
    kind: "entity",
    owner: "subject",
    ref: "subject:4",
    fields: { name: "D", type: 1, score: 9.8 },
  },
  {
    kind: "entity",
    owner: "subject",
    ref: "subject:5",
    fields: { name: "E", type: 2, score: MISSING },
  },
];

const source: QueryDataSource = {
  scan: async function* (owner) {
    if (owner === "subject") yield* subjects;
  },
};

const P = (id: number): EntityValue => ({
  kind: "entity",
  owner: "person",
  ref: `person:${id}`,
  fields: { name: `P${id}`, type: 1, career: [], comments: 0, collects: 0 },
});
const C = (id: number): EntityValue => ({
  kind: "entity",
  owner: "character",
  ref: `character:${id}`,
  fields: { name: `C${id}`, role: 1, comments: 0, collects: 0 },
});

const voiceCredit: FactValue = {
  kind: "fact",
  factKind: "VOICE_CREDIT",
  ref: "fact:9",
  multiplicity: 2,
  roles: {
    person: "person:1",
    character: "character:7",
    subjectContext: "subject:3",
  },
  fields: { type: 1, summary: "" },
};

test("keeps transport batching separate from execution quotas", () => {
  assert.deepEqual(QUERY_SECURITY_PROFILE.execution, { maxPageSize: 500 });
  assert.equal("path" in QUERY_SECURITY_PROFILE, false);
});

test("projects every result entity independently from the 500-row page", async () => {
  const largeSource: QueryDataSource = {
    scan: async function* (owner) {
      if (owner !== "subject") return;
      for (let id = 1; id <= 700; id++) {
        yield {
          kind: "entity",
          owner: "subject",
          ref: `subject:${id}`,
          fields: { name: `S${id}` },
        };
      }
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [{
          name: "ref",
          value: { kind: "field", binding: "subject", field: "ref" },
        }],
      },
    },
  };
  const entities: QueryResultEntity[] = [];

  const result = await executeQuery(query, {}, largeSource, {
    pageSize: 500,
    onResultEntities: (rowEntities) => entities.push(...rowEntities),
  });

  assert.equal(result.rows.length, 500);
  assert.equal(result.totalMatches, 700);
  assert.equal(result.hasMore, true);
  assert.equal(entities.length, 700);
  assert.deepEqual(entities[0], {
    ref: "subject:1",
    graphRef: "subject:1",
  });
  assert.deepEqual(entities.at(-1), {
    ref: "subject:700",
    graphRef: "subject:700",
  });
});

test("does not inspect Subject rows for Episode graph lineage", async () => {
  let ownerReads = 0;
  const measuredSubject = {
    kind: "entity",
    get owner() {
      ownerReads++;
      return "subject" as const;
    },
    ref: "subject:1",
    fields: { name: "Measured" },
  } as EntityValue;
  const measuredSource: QueryDataSource = {
    scan: async function* (owner) {
      if (owner === "subject") yield measuredSubject;
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [{
          name: "ref",
          value: { kind: "field", binding: "subject", field: "ref" },
        }],
      },
    },
  };

  const result = await executeQuery(query, {}, measuredSource, {
    pageSize: 20,
    onResultEntities: () => {},
  });

  assert.deepEqual(result.rows, [{ ref: "subject:1" }]);
  assert.equal(ownerReads, 2);
});

test("uses optional scan batches only for whole-scan execution", async () => {
  let rowScans = 0;
  let batchScans = 0;
  const batchedSource: QueryDataSource = {
    scan: async function* (owner) {
      rowScans++;
      if (owner === "subject") {
        yield {
          kind: "entity",
          owner: "subject",
          ref: "subject:3",
          fields: { score: 9 },
        };
      }
    },
    scanBatches: async function* (owner, _signal, fields) {
      batchScans++;
      assert.equal(owner, "subject");
      assert.deepEqual(fields, ["score"]);
      yield [
        {
          kind: "entity",
          owner: "subject",
          ref: "subject:1",
          fields: { score: 8.5 },
        },
        {
          kind: "entity",
          owner: "subject",
          ref: "subject:2",
          fields: { score: 7.5 },
        },
      ];
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      filter: {
        kind: "filter",
        input: "scan",
        predicate: {
          kind: "compare",
          operator: "gte",
          left: { kind: "field", binding: "subject", field: "score" },
          right: { kind: "literal", value: 8 },
        },
      },
      project: {
        kind: "project",
        input: "filter",
        columns: [{
          name: "score",
          value: { kind: "field", binding: "subject", field: "score" },
        }],
      },
    },
    orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
  };

  const result = await executeQuery(query, {}, batchedSource, { pageSize: 20 });

  assert.deepEqual(result.rows, [{ score: 8.5 }]);
  assert.equal(batchScans, 1);
  assert.equal(rowScans, 0);

  const streamingResult = await executeQuery(
    { ...query, orderBy: [], limit: 1 },
    {},
    batchedSource,
    { pageSize: 20 },
  );

  assert.deepEqual(streamingResult.rows, [{ score: 9 }]);
  assert.equal(batchScans, 1);
  assert.equal(rowScans, 1);
});

test("does not scan or highlight a zero-limit result", async () => {
  let scans = 0;
  const zeroSource: QueryDataSource = {
    releaseId: "release-zero",
    scan: async function* (owner) {
      scans++;
      if (owner === "subject") yield subjects[0] as EntityValue;
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [{
          name: "ref",
          value: { kind: "field", binding: "subject", field: "ref" },
        }],
      },
    },
    limit: 0,
  };
  const entities: QueryResultEntity[] = [];

  const result = await executeQuery(query, {}, zeroSource, {
    pageSize: 20,
    onResultEntities: (rowEntities) => entities.push(...rowEntities),
  });

  assert.equal(scans, 0);
  assert.deepEqual(entities, []);
  assert.deepEqual(result.rows, []);
  assert.equal(result.totalMatches, 0);
  assert.equal(result.visibleMatches, 0);
  assert.equal(result.hasMore, false);
  assert.equal(result.releaseId, "release-zero");
});

test("projects only entities retained by an ordered semantic limit", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [
          {
            name: "ref",
            value: { kind: "field", binding: "subject", field: "ref" },
          },
          {
            name: "score",
            value: { kind: "field", binding: "subject", field: "score" },
          },
        ],
      },
    },
    orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
    limit: 2,
  };
  const entities: QueryResultEntity[] = [];

  const result = await executeQuery(query, {}, source, {
    pageSize: 1,
    onResultEntities: (rowEntities) => entities.push(...rowEntities),
  });

  assert.deepEqual(result.rows, [{ ref: "subject:4", score: 9.8 }]);
  assert.deepEqual(
    entities.map((entity) => entity.ref).sort(),
    ["subject:3", "subject:4"],
  );
});

test("uses the result row tie-breaker for ordered semantic highlights", async () => {
  const tiedSource: QueryDataSource = {
    scan: async function* (owner) {
      if (owner !== "subject") return;
      for (const id of [2, 1]) {
        yield {
          kind: "entity",
          owner: "subject",
          ref: `subject:${id}`,
          fields: { name: `S${id}`, score: 9 },
        };
      }
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [
          {
            name: "ref",
            value: { kind: "field", binding: "subject", field: "ref" },
          },
          {
            name: "score",
            value: { kind: "field", binding: "subject", field: "score" },
          },
        ],
      },
    },
    orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
    limit: 1,
  };
  const entities: QueryResultEntity[] = [];

  const result = await executeQuery(query, {}, tiedSource, {
    pageSize: 1,
    onResultEntities: (rowEntities) => entities.push(...rowEntities),
  });

  assert.deepEqual(result.rows, [{ ref: "subject:1", score: 9 }]);
  assert.deepEqual(entities, [{
    ref: "subject:1",
    graphRef: "subject:1",
  }]);
});

test("maps ordered Episode fields to their owning Subject without retaining every scan", async () => {
  const episodeSource: QueryDataSource = {
    scan: async function* (owner) {
      if (owner !== "episode") return;
      for (const [episode, subject] of [[17, 3], [18, 4]] as const)
        yield {
          kind: "entity",
          owner: "episode",
          ref: `episode:${episode}`,
          fields: {
            name: `Episode ${episode}`,
            subjectRef: `subject:${subject}`,
          },
        };
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "episode", binding: "episode" },
      project: {
        kind: "project",
        input: "scan",
        columns: [{
          name: "name",
          value: { kind: "field", binding: "episode", field: "name" },
        }],
      },
    },
    orderBy: [{ column: "name", direction: "desc", nulls: "last" }],
    limit: 1,
  };
  const entities: QueryResultEntity[] = [];

  const result = await executeQuery(query, {}, episodeSource, {
    pageSize: 20,
    onResultEntities: (rowEntities) => entities.push(...rowEntities),
  });

  assert.deepEqual(result.rows, [{ name: "Episode 18" }]);
  assert.deepEqual(entities, [{
    ref: "episode:18",
    graphRef: "subject:4",
  }]);
});

test("retains Episode ownership when a set operator merges duplicate rows", async () => {
  const episodeSource: QueryDataSource = {
    scan: async function* (owner) {
      if (owner !== "episode") return;
      yield {
        kind: "entity",
        owner: "episode",
        ref: "episode:17",
        fields: { name: "Episode 17", subjectRef: "subject:3" },
      };
    },
  };
  const project = (input: string) => ({
    kind: "project" as const,
    input,
    columns: [{
      name: "name",
      value: { kind: "field" as const, binding: "episode", field: "name" },
    }],
  });
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "union",
    parameters: {},
    operators: {
      scanA: { kind: "scan", owner: "episode", binding: "episode" },
      projectA: project("scanA"),
      scanB: { kind: "scan", owner: "episode", binding: "episode" },
      projectB: project("scanB"),
      union: {
        kind: "union",
        branches: [
          {
            input: "projectA",
            columns: [
              { output: "name", input: "name" },
            ],
          },
          {
            input: "projectB",
            columns: [
              { output: "name", input: "name" },
            ],
          },
        ],
      },
    },
  };
  const entities: QueryResultEntity[] = [];

  await executeQuery(query, {}, episodeSource, {
    pageSize: 20,
    onResultEntities: (rowEntities) => entities.push(...rowEntities),
  });

  assert.deepEqual(entities, [
    { ref: "episode:17", graphRef: "subject:3" },
  ]);
});

test("resolves an Episode literal after its scanned row left an ordered Top-N", async () => {
  const episodeSource = {
    scan: async function* (owner: Parameters<QueryDataSource["scan"]>[0]) {
      if (owner !== "episode") return;
      for (const [episode, subject] of [[17, 3], [18, 4]] as const)
        yield {
          kind: "entity" as const,
          owner: "episode" as const,
          ref: `episode:${episode}` as const,
          fields: { subjectRef: `subject:${subject}` },
        };
    },
    resolveEpisodeGraphRef: async (ref: `episode:${number}`) =>
      ref === "episode:17" ? "subject:3" as const
        : ref === "episode:18" ? "subject:4" as const
        : null,
  } as QueryDataSource & {
    resolveEpisodeGraphRef(
      ref: `episode:${number}`,
    ): Promise<`subject:${number}` | null>;
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "episode", binding: "episode" },
      project: {
        kind: "project",
        input: "scan",
        columns: [
          {
            name: "literal",
            value: { kind: "literal", value: "episode:17" },
          },
          {
            name: "sort",
            value: { kind: "field", binding: "episode", field: "id" },
          },
        ],
      },
    },
    orderBy: [{ column: "sort", direction: "desc", nulls: "last" }],
    limit: 1,
  };
  const entities: QueryResultEntity[] = [];

  const result = await executeQuery(query, {}, episodeSource, {
    pageSize: 20,
    onResultEntities: (rowEntities) => entities.push(...rowEntities),
  });

  assert.deepEqual(result.rows, [{ literal: "episode:17", sort: 18 }]);
  assert.deepEqual(entities, [
    { ref: "episode:17", graphRef: "subject:3" },
    { ref: "episode:18", graphRef: "subject:4" },
  ]);
});

test("does not resolve Episode refs from rows discarded by ordered Top-N", async () => {
  const episodeSource: QueryDataSource = {
    scan: async function* () {},
    resolveEpisodeGraphRef: async (ref) => {
      if (ref === "episode:17")
        throw new Error("discarded Episode must not be resolved");
      return ref === "episode:18" ? "subject:4" : null;
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "values",
    parameters: {},
    operators: {
      values: {
        kind: "values",
        columns: ["episode", "sort"],
        rows: [["episode:17", 17], ["episode:18", 18]],
      },
    },
    orderBy: [{ column: "sort", direction: "desc", nulls: "last" }],
    limit: 1,
  };
  const entities: QueryResultEntity[] = [];

  const result = await executeQuery(query, {}, episodeSource, {
    pageSize: 20,
    onResultEntities: (rowEntities) => entities.push(...rowEntities),
  });

  assert.deepEqual(result.rows, [{ episode: "episode:18", sort: 18 }]);
  assert.deepEqual(entities, [{
    ref: "episode:18",
    graphRef: "subject:4",
  }]);
});

test("does not retain Episode ownership from rows discarded by an intermediate operator", async () => {
  const resolved: string[] = [];
  const episodeSource: QueryDataSource = {
    scan: async function* (owner) {
      if (owner !== "episode") return;
      yield {
        kind: "entity",
        owner: "episode",
        ref: "episode:17",
        fields: { subjectRef: "subject:3" },
      };
    },
    resolveEpisodeGraphRef: async (ref) => {
      resolved.push(ref);
      return "subject:4";
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "union",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "episode", binding: "episode" },
      discarded: {
        kind: "filter",
        input: "scan",
        predicate: { kind: "literal", value: false },
      },
      discardedProjection: {
        kind: "project",
        input: "discarded",
        columns: [{
          name: "episode",
          value: { kind: "literal", value: "episode:17" },
        }],
      },
      literal: {
        kind: "values",
        columns: ["episode"],
        rows: [["episode:17"]],
      },
      union: {
        kind: "union",
        branches: [
          {
            input: "discardedProjection",
            columns: [{ output: "episode", input: "episode" }],
          },
          {
            input: "literal",
            columns: [{ output: "episode", input: "episode" }],
          },
        ],
      },
    },
  };
  const entities: QueryResultEntity[] = [];

  const result = await executeQuery(query, {}, episodeSource, {
    pageSize: 20,
    onResultEntities: (rowEntities) => entities.push(...rowEntities),
  });

  assert.deepEqual(result.rows, [{ episode: "episode:17" }]);
  assert.deepEqual(resolved, ["episode:17"]);
  assert.deepEqual(entities, [{
    ref: "episode:17",
    graphRef: "subject:4",
  }]);
});

test("validates Episode ownership even when highlights are disabled", async () => {
  const invalidEpisodeSource: QueryDataSource = {
    scan: async function* () {
      yield {
        kind: "entity",
        owner: "episode",
        ref: "episode:17",
        fields: { subjectRef: "person:3" },
      };
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "scan",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "episode", binding: "episode" },
    },
  };

  await assert.rejects(
    executeQuery(query, {}, invalidEpisodeSource, { pageSize: 20 }),
    /subjectRef must identify a Subject/,
  );

  const valuesQuery: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "values",
    parameters: {},
    operators: {
      values: {
        kind: "values",
        columns: ["episode"],
        types: { episode: "entity:episode" },
        rows: [["episode:17"]],
      },
    },
  };
  const invalidEpisodeValueSource: QueryDataSource = {
    scan: async function* () {},
    entity: async () => ({
      kind: "entity",
      owner: "episode",
      ref: "episode:17",
      fields: { subjectRef: "person:3" },
    }),
  };

  await assert.rejects(
    executeQuery(valuesQuery, {}, invalidEpisodeValueSource, { pageSize: 20 }),
    /subjectRef must identify a Subject/,
  );
});

test("looks up one release-local fact by its typed FactRef", async () => {
  let requested: string | undefined;
  const pointSource: QueryDataSource = {
    scan: async function* () {},
    fact: async (ref) => {
      requested = ref;
      return ref === "fact:9" ? voiceCredit : null;
    },
    entity: async (ref) => {
      if (ref === "person:1") return P(1);
      if (ref === "character:7") return C(7);
      return null;
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: { ref: "fact-ref" },
    operators: {
      fact: {
        kind: "factLookup",
        factKind: "VOICE_CREDIT",
        factBinding: "credit",
        roles: { person: "person", character: "character", subjectContext: "subject" },
        ref: { kind: "parameter", name: "ref" },
      },
      project: {
        kind: "project",
        input: "fact",
        columns: [
          { name: "ref", value: { kind: "field", binding: "credit", field: "ref" } },
          { name: "type", value: { kind: "field", binding: "credit", field: "type" } },
          { name: "person", value: { kind: "field", binding: "person", field: "ref" } },
        ],
      },
    },
  };

  const result = await executeQuery(
    query,
    { ref: "fact:9" },
    pointSource,
    { pageSize: 20 },
  );

  assert.equal(requested, "fact:9");
  assert.deepEqual(result.rows, [{ ref: "fact:9", type: 1, person: "person:1" }]);
  assert.equal(result.columns.ref!.semantic, "VOICE_CREDIT.ref");
});

const rankedSubjects: QueryDocument = {
  schema: "atlas-query-document-v1",
  root: "project",
  parameters: { minimum: "number" },
  operators: {
    scan: { kind: "scan", owner: "subject", binding: "s" },
    filter: {
      kind: "filter",
      input: "scan",
      predicate: {
        kind: "and",
        terms: [
          {
            kind: "compare",
            operator: "eq",
            left: { kind: "field", binding: "s", field: "type" },
            right: { kind: "literal", value: 2 },
          },
          {
            kind: "compare",
            operator: "gte",
            left: { kind: "field", binding: "s", field: "score" },
            right: { kind: "parameter", name: "minimum" },
          },
        ],
      },
    },
    project: {
      kind: "project",
      input: "filter",
      columns: [
        { name: "ref", value: { kind: "field", binding: "s", field: "ref" } },
        { name: "name", value: { kind: "field", binding: "s", field: "name" } },
        { name: "score", value: { kind: "field", binding: "s", field: "score" } },
      ],
    },
  },
  orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
  limit: 2,
};

test("executes typed scan, filter, project, order, and semantic limit", async () => {
  const result = await executeQuery(
    rankedSubjects,
    { minimum: 8 },
    source,
    { pageSize: 1 },
  );

  assert.deepEqual(result.rows, [{ ref: "subject:3", name: "B", score: 9.2 }]);
  assert.equal(result.totalMatches, 2);
  assert.equal(result.visibleMatches, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.stability, "exact");
  assert.deepEqual(result.evidence[0]?.score, [{
    kind: "entity-field",
    ref: "subject:3",
    field: "score",
  }]);
  assert.equal(result.coverage.atoms.includes("field:subject.score"), true);
  assert.match(result.queryDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.terminalEvidence, [{
    kind: "completed-domain",
    coverage: result.coverage.digest,
  }]);
});

test("uses hidden projection columns for sorting without leaking them to results", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [
          {
            name: "ref",
            value: { kind: "field", binding: "subject", field: "ref" },
          },
          {
            name: "score",
            value: { kind: "field", binding: "subject", field: "score" },
            hidden: true,
          },
        ],
      },
    },
    orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
    limit: 3,
  };

  const result = await executeQuery(query, {}, source, { pageSize: 20 });

  assert.deepEqual(result.rows, [
    { ref: "subject:4" },
    { ref: "subject:3" },
    { ref: "subject:1" },
  ]);
  assert.deepEqual(Object.keys(result.columns), ["ref"]);
  assert.equal(result.evidence.some((row) => "score" in row), false);
});

test("accepts pagination offsets without an arbitrary product maximum", async () => {
  const result = await executeQuery(rankedSubjects, { minimum: 8 }, source, {
    pageSize: 1,
    offset: 200_001,
  });

  assert.deepEqual(result.rows, []);
  assert.equal(result.hasMore, false);
});

test("pushes only referenced entity fields into a structural scan", async () => {
  let requested: readonly string[] | undefined;
  const projectedSource: QueryDataSource = {
    scan: async function* (owner, _signal, fields) {
      requested = fields;
      if (owner === "subject") yield* subjects;
    },
  };

  await executeQuery(
    rankedSubjects,
    { minimum: 8 },
    projectedSource,
    { pageSize: 1 },
  );

  assert.deepEqual(requested, ["name", "ref", "score", "type"]);
});

test("applies projection before distinct and semantic limit", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      values: { kind: "values", columns: ["n"], rows: [[2], [1], [1], [3]] },
      project: {
        kind: "project",
        input: "values",
        columns: [{ name: "n", value: { kind: "column", name: "n" } }],
      },
    },
    distinct: true,
    orderBy: [{ column: "n", direction: "asc", nulls: "last" }],
    limit: 2,
  };

  const result = await executeQuery(query, {}, source, { pageSize: 20 });

  assert.deepEqual(result.rows, [{ n: 1 }, { n: 2 }]);
  assert.equal(result.totalMatches, 2);
  assert.equal(result.visibleMatches, 2);
  assert.equal(result.hasMore, false);
});

test("keeps hidden sort columns out of distinct result identity", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      values: {
        kind: "values",
        columns: ["n", "sortKey"],
        rows: [[1, 2], [1, 1], [2, 0]],
      },
      project: {
        kind: "project",
        input: "values",
        columns: [
          { name: "n", value: { kind: "column", name: "n" } },
          {
            name: "sortKey",
            value: { kind: "column", name: "sortKey" },
            hidden: true,
          },
        ],
      },
    },
    distinct: true,
    orderBy: [{ column: "sortKey", direction: "asc", nulls: "last" }],
  };

  const result = await executeQuery(query, {}, source, { pageSize: 20 });

  assert.deepEqual(result.rows, [{ n: 2 }, { n: 1 }]);
  assert.equal(result.totalMatches, 2);
});

test("stops an unordered stable scan at the semantic result limit", async () => {
  let scanned = 0;
  let access: string | undefined;
  const limitedSource: QueryDataSource = {
    scan: async function* (_owner, _signal, _fields, requestedAccess) {
      access = requestedAccess;
      for (let id = 1; id <= 1_000; id++) {
        scanned++;
        yield {
          kind: "entity",
          owner: "subject",
          ref: `subject:${id}`,
          fields: { name: `S${id}` },
        };
      }
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "scan",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
    },
    limit: 3,
  };

  const result = await executeQuery(query, {}, limitedSource, { pageSize: 2 });

  assert.equal(scanned, 3);
  assert.equal(access, "stream");
  assert.equal(result.totalMatches, 3);
  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.rows.map((row) => (Object.values(row)[0] as EntityValue).ref),
    ["subject:1", "subject:2"],
  );
});

test("requests display identity when a scanned entity is returned as a value", async () => {
  let requested: readonly string[] = [];
  const identitySource: QueryDataSource = {
    scan: async function* (_owner, _signal, fields) {
      requested = fields ?? [];
      yield {
        kind: "entity",
        owner: "subject",
        ref: "subject:1",
        fields: { name: "Original", nameCn: "中文名" },
      };
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [
          { name: "subject", value: { kind: "column", name: "subject" } },
        ],
      },
    },
    limit: 1,
  };

  await executeQuery({
    schema: "atlas-query-document-v1",
    root: "scan",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
    },
    limit: 1,
  }, {}, identitySource, { pageSize: 1 });
  assert.deepEqual(requested, ["name", "nameCn"]);

  const result = await executeQuery(query, {}, identitySource, { pageSize: 1 });

  assert.deepEqual(requested, ["name", "nameCn"]);
  assert.equal(
    (result.rows[0]?.subject as EntityValue | undefined)?.fields.nameCn,
    "中文名",
  );
});

test("pushes fields through projected entity aliases", async () => {
  let requested: readonly string[] = [];
  const projectedSource: QueryDataSource = {
    scan: async function* (_owner, _signal, fields) {
      requested = fields ?? [];
      const projected: Record<string, string | number> = {};
      for (const field of requested) {
        if (field === "name") projected[field] = "Original";
        else if (field === "nameCn") projected[field] = "原名";
        else if (field === "score") projected[field] = 8.5;
      }
      yield {
        kind: "entity",
        owner: "subject",
        ref: "subject:1",
        fields: projected,
      };
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "score",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      alias: {
        kind: "project",
        input: "scan",
        columns: [{ name: "entity", value: { kind: "column", name: "subject" } }],
      },
      score: {
        kind: "project",
        input: "alias",
        columns: [{ name: "score", value: { kind: "field", binding: "entity", field: "score" } }],
      },
    },
    limit: 1,
  };

  const result = await executeQuery(query, {}, projectedSource, { pageSize: 1 });

  assert.deepEqual(requested, ["score"]);
  assert.deepEqual(result.rows, [{ score: 8.5 }]);
});

test("uses a canonical row tie-breaker when order keys are equal", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "values",
    parameters: {},
    operators: {
      values: {
        kind: "values",
        columns: ["group", "name"],
        rows: [[1, "B"], [1, "A"]],
      },
    },
    orderBy: [{ column: "group", direction: "asc", nulls: "last" }],
  };

  const result = await executeQuery(query, {}, source, { pageSize: 20 });

  assert.deepEqual(result.rows, [
    { group: 1, name: "A" },
    { group: 1, name: "B" },
  ]);
});

test("rejects invalid fields and types before touching the data source", async () => {
  let scans = 0;
  const empty: QueryDataSource = {
    scan: async function* () {
      scans++;
    },
  };
  const invalid = (predicate: QueryDocument["operators"][string] & { kind: "filter" }): QueryDocument => ({
    schema: "atlas-query-document-v1",
    root: "filter",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "person", binding: "p" },
      filter: predicate,
    },
  });

  await assert.rejects(
    executeQuery(
      invalid({
        kind: "filter",
        input: "scan",
        predicate: {
          kind: "compare",
          operator: "gte",
          left: { kind: "field", binding: "p", field: "score" },
          right: { kind: "literal", value: 8 },
        },
      }),
      {},
      empty,
      { pageSize: 10 },
    ),
    /person.score/,
  );
  await assert.rejects(
    executeQuery(
      invalid({
        kind: "filter",
        input: "scan",
        predicate: {
          kind: "compare",
          operator: "gte",
          left: { kind: "field", binding: "p", field: "comments" },
          right: { kind: "literal", value: "many" },
        },
      }),
      {},
      empty,
      { pageSize: 10 },
    ),
    /type/,
  );
  assert.equal(scans, 0);
});

test("filters tags by name without dropping their source counts", async () => {
  const tagged: QueryDataSource = {
    scan: async function* (owner) {
      if (owner !== "subject") return;
      yield {
        kind: "entity",
        owner: "subject",
        ref: "subject:8",
        fields: {
          name: "Atlas",
          tags: [{ name: "科幻", count: 42 }],
        },
      };
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      filter: {
        kind: "filter",
        input: "scan",
        predicate: {
          kind: "compare",
          operator: "contains",
          left: { kind: "field", binding: "subject", field: "tags" },
          right: { kind: "literal", value: "科幻" },
        },
      },
      project: {
        kind: "project",
        input: "filter",
        columns: [
          { name: "tags", value: { kind: "field", binding: "subject", field: "tags" } },
        ],
      },
    },
  };

  const result = await executeQuery(query, {}, tagged, { pageSize: 20 });

  assert.deepEqual(result.rows, [{ tags: [{ name: "科幻", count: 42 }] }]);
});

test("keeps all sort directions and null placements independent", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "values",
    parameters: {},
    operators: {
      values: { kind: "values", columns: ["n"], rows: [[1], [null], [2]] },
    },
  };
  for (const [direction, nulls, expected] of [
    ["asc", "first", [null, 1, 2]],
    ["asc", "last", [1, 2, null]],
    ["desc", "first", [null, 2, 1]],
    ["desc", "last", [2, 1, null]],
  ] as const) {
    query.orderBy = [{ column: "n", direction, nulls }];
    const result = await executeQuery(query, {}, source, { pageSize: 20 });
    assert.deepEqual(
      result.rows,
      expected.map((n) => ({ n })),
      `${direction} nulls ${nulls}`,
    );
  }
});

test("orders primitive values without canonical JSON serialization", () => {
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((value: unknown) => {
    calls++;
    return stringify(value);
  }) as typeof JSON.stringify;
  try {
    assert.equal(compareOrderedValue(1, 2, "asc", "last"), -1);
    assert.equal(compareOrderedValue("b", "a", "desc", "last"), -1);
    assert.equal(calls, 0);
  } finally {
    JSON.stringify = stringify;
  }
});

test("rejects a row outside a full Top-N boundary with one value comparison", () => {
  const rows: RankedRow[] = Array.from({ length: 50 }, (_, index) => ({
    row: { score: 100 - index },
    key: null,
    ordinal: index,
  }));
  let scoreReads = 0;
  const row = new Proxy({ score: -1 }, {
    get(target, property, receiver) {
      if (property === "score") scoreReads++;
      return Reflect.get(target, property, receiver);
    },
  });

  insertTop(
    rows,
    { row, key: null, ordinal: rows.length },
    50,
    [{ column: "score", direction: "desc", nulls: "last" }],
  );

  assert.equal(scoreReads, 1);
  assert.equal(rows.length, 50);
  assert.equal(rows.at(-1)?.row.score, 51);
});

test("orders projected stable references as typed scalar identities", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "subject", binding: "subject" },
      project: {
        kind: "project",
        input: "scan",
        columns: [{
          name: "ref",
          value: { kind: "field", binding: "subject", field: "ref" },
        }],
      },
    },
    orderBy: [{ column: "ref", direction: "desc", nulls: "last" }],
  };

  const result = await executeQuery(query, {}, source, { pageSize: 20 });
  assert.deepEqual(
    result.rows,
    [...subjects].reverse().map((subject) => ({ ref: subject.ref })),
  );
});

test("expands one canonical multi-role fact without losing its context", async () => {
  const entities = new Map<string, EntityValue>([
    ["person:1", P(1)],
    ["character:7", C(7)],
    ["subject:3", subjects[2] as EntityValue],
  ]);
  const relationalSource: QueryDataSource = {
    scan: async function* (owner) {
      if (owner === "person") yield P(1);
    },
    facts: async function* (ref) {
      if (ref === "person:1") yield voiceCredit;
    },
    entity: async (ref) => entities.get(ref) ?? null,
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "person", binding: "p" },
      filter: {
        kind: "filter",
        input: "scan",
        predicate: {
          kind: "compare",
          operator: "eq",
          left: { kind: "field", binding: "p", field: "ref" },
          right: { kind: "literal", value: "person:1" },
        },
      },
      matchFact: {
        kind: "matchFact",
        input: "filter",
        factKind: "VOICE_CREDIT",
        factBinding: "credit",
        roles: { person: "p", character: "c", subjectContext: "s" },
      },
      project: {
        kind: "project",
        input: "matchFact",
        columns: [
          { name: "fact", value: { kind: "field", binding: "credit", field: "ref" } },
          { name: "creditType", value: { kind: "field", binding: "credit", field: "type" } },
          { name: "character", value: { kind: "field", binding: "c", field: "ref" } },
          { name: "subject", value: { kind: "field", binding: "s", field: "ref" } },
        ],
      },
    },
  };

  const result = await executeQuery(query, {}, relationalSource, { pageSize: 20 });

  assert.deepEqual(result.rows, [{
    fact: "fact:9",
    creditType: 1,
    character: "character:7",
    subject: "subject:3",
  }]);
  assert.equal(result.columns.creditType!.semantic, "VOICE_CREDIT.type");
  assert.equal(result.columns.character!.semantic, "character.ref");
});

test("keeps a fact match when an archived role has no entity", async () => {
  const relationalSource: QueryDataSource = {
    scan: async function* (owner) {
      if (owner === "person") yield P(1);
    },
    facts: async function* (ref) {
      if (ref === "person:1") yield voiceCredit;
    },
    entity: async (ref) => ref === "character:7" ? C(7) : null,
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: { kind: "scan", owner: "person", binding: "p" },
      matchFact: {
        kind: "matchFact",
        input: "scan",
        factKind: "VOICE_CREDIT",
        factBinding: "credit",
        roles: { person: "p", character: "c", subjectContext: "s" },
      },
      project: {
        kind: "project",
        input: "matchFact",
        columns: [
          { name: "fact", value: { kind: "field", binding: "credit", field: "ref" } },
          { name: "subject", value: { kind: "field", binding: "s", field: "ref" } },
        ],
      },
    },
  };

  const result = await executeQuery(query, {}, relationalSource, { pageSize: 20 });

  assert.deepEqual(result.rows, [{ fact: "fact:9", subject: MISSING }]);
});

test("keeps lookup and full text as distinct verified sources", async () => {
  let lookupEntityFields: readonly string[] | undefined;
  let fullTextEntityFields: readonly string[] | undefined;
  const searched: QueryDataSource = {
    scan: async function* () {},
    lookup: async function* (text, owner, _lookupFields, _signal, entityFields) {
      assert.equal(text, "Atlas");
      assert.equal(owner, "subject");
      lookupEntityFields = entityFields;
      yield subjects[2] as EntityValue;
    },
    fullText: async function* (text, owner, field, _signal, entityFields) {
      assert.equal(text, "Atlas");
      assert.equal(owner, "subject");
      assert.equal(field, "summary");
      fullTextEntityFields = entityFields;
      yield {
        ...(subjects[0] as EntityValue),
        searchMatch: {
          field: "summary",
          text: "An Atlas story",
          utf8Range: [3, 8],
        },
      };
    },
  };
  const lookup: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: { text: "string" },
    operators: {
      lookup: {
        kind: "lookup",
        owner: "subject",
        binding: "s",
        text: { kind: "parameter", name: "text" },
        fields: ["name", "nameCn", "nameVariant"],
      },
      project: {
        kind: "project",
        input: "lookup",
        columns: [
          { name: "ref", value: { kind: "field", binding: "s", field: "ref" } },
        ],
      },
    },
  };
  const fullText: QueryDocument = {
    ...lookup,
    operators: {
      fullText: {
        kind: "fullText",
        target: "entity",
        owner: "subject",
        binding: "s",
        text: { kind: "parameter", name: "text" },
        field: "summary",
      },
      project: {
        kind: "project",
        input: "fullText",
        columns: [
          { name: "ref", value: { kind: "field", binding: "s", field: "ref" } },
        ],
      },
    },
  };

  const lookupResult = await executeQuery(
    lookup,
    { text: "Atlas" },
    searched,
    { pageSize: 20 },
  );
  const fullTextResult = await executeQuery(
    fullText,
    { text: "Atlas" },
    searched,
    { pageSize: 20 },
  );

  assert.deepEqual(lookupResult.rows, [{ ref: "subject:3" }]);
  assert.deepEqual(fullTextResult.rows, [{ ref: "subject:1" }]);
  assert.deepEqual(lookupEntityFields, ["ref"]);
  assert.deepEqual(fullTextEntityFields, ["ref"]);
  assert.ok(fullTextResult.evidence[0]?.ref?.some((item) =>
    item.kind === "text-range" && item.utf8Range[0] === 3 && item.utf8Range[1] === 8
  ));
});

test("isolates projected fields for lookup branches that reuse a binding name", async () => {
  const requested = new Map<"subject" | "character", readonly string[]>();
  const searched: QueryDataSource = {
    scan: async function* () {},
    lookup: async function* (_text, owner, _lookupFields, _signal, entityFields) {
      if (owner !== "subject" && owner !== "character") return;
      requested.set(owner, entityFields ?? []);
      const value: EntityValue = owner === "subject"
        ? {
            kind: "entity",
            owner,
            ref: "subject:1",
            fields: { name: "Original", nameCn: "中文名" },
          }
        : {
            kind: "entity",
            owner,
            ref: "character:2",
            fields: { name: "Character" },
          };
      yield value;
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "union",
    parameters: {},
    operators: {
      subjectLookup: {
        kind: "lookup",
        owner: "subject",
        binding: "entity",
        text: { kind: "literal", value: "Atlas" },
        fields: ["name"],
      },
      subjectProject: {
        kind: "project",
        input: "subjectLookup",
        columns: [{
          name: "value",
          value: { kind: "field", binding: "entity", field: "nameCn" },
        }],
      },
      characterLookup: {
        kind: "lookup",
        owner: "character",
        binding: "entity",
        text: { kind: "literal", value: "Atlas" },
        fields: ["name"],
      },
      characterProject: {
        kind: "project",
        input: "characterLookup",
        columns: [{
          name: "value",
          value: { kind: "field", binding: "entity", field: "name" },
        }],
      },
      union: {
        kind: "union",
        branches: ["subjectProject", "characterProject"].map((input) => ({
          input,
          columns: [{ input: "value", output: "value" }],
        })),
      },
    },
  };

  const result = await executeQuery(query, {}, searched, { pageSize: 20 });

  assert.deepEqual(result.rows, [{ value: "Character" }, { value: "中文名" }]);
  assert.deepEqual(requested.get("subject"), ["nameCn"]);
  assert.deepEqual(requested.get("character"), ["name"]);
});

test("follows a typed reference in both directions", async () => {
  const subject = subjects[0] as EntityValue;
  const episode: EntityValue = {
    kind: "entity",
    owner: "episode",
    ref: "episode:10",
    fields: { name: "Episode 1", subjectRef: subject.ref },
  };
  const references: QueryDataSource = {
    scan: async function* (owner) {
      if (owner === "subject") yield subject;
      if (owner === "episode") yield episode;
    },
    followRef: async function* (anchor, referenceOwner, field, direction) {
      assert.equal(referenceOwner, "episode");
      assert.equal(field, "subjectRef");
      if (direction === "forward" && anchor.ref === episode.ref) yield subject;
      if (direction === "reverse" && anchor.ref === subject.ref) yield episode;
    },
  };
  const query = (direction: "forward" | "reverse"): QueryDocument => ({
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      scan: {
        kind: "scan",
        owner: direction === "forward" ? "episode" : "subject",
        binding: "anchor",
      },
      follow: {
        kind: "followRef",
        input: "scan",
        referenceOwner: "episode",
        field: "subjectRef",
        anchorBinding: "anchor",
        resultBinding: "result",
        direction,
      },
      project: {
        kind: "project",
        input: "follow",
        columns: [{
          name: "ref",
          value: { kind: "field", binding: "result", field: "ref" },
        }],
      },
    },
  });

  assert.deepEqual(
    (await executeQuery(query("forward"), {}, references, { pageSize: 20 })).rows,
    [{ ref: "subject:1" }],
  );
  assert.deepEqual(
    (await executeQuery(query("reverse"), {}, references, { pageSize: 20 })).rows,
    [{ ref: "episode:10" }],
  );
});

test("returns a fact full-text hit with every participant binding", async () => {
  const entities = new Map<string, EntityValue>([
    ["person:1", P(1)],
    ["character:7", C(7)],
    ["subject:3", subjects[2] as EntityValue],
  ]);
  const factSearch: QueryDataSource = {
    scan: async function* () {},
    entity: async (ref) => entities.get(ref) ?? null,
    fullTextFact: async function* (text, kind, field) {
      assert.equal(text, "hero");
      assert.equal(kind, "VOICE_CREDIT");
      assert.equal(field, "summary");
      yield {
        ...voiceCredit,
        searchMatch: {
          field: "summary",
          text: "the hero voice",
          utf8Range: [4, 8],
        },
      };
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      fullText: {
        kind: "fullText",
        target: "fact",
        factKind: "VOICE_CREDIT",
        factBinding: "credit",
        roles: {
          person: "person",
          character: "character",
          subjectContext: "subject",
        },
        text: { kind: "literal", value: "hero" },
        field: "summary",
      },
      project: {
        kind: "project",
        input: "fullText",
        columns: [
          { name: "fact", value: { kind: "field", binding: "credit", field: "ref" } },
          { name: "person", value: { kind: "field", binding: "person", field: "ref" } },
          { name: "character", value: { kind: "field", binding: "character", field: "ref" } },
          { name: "subject", value: { kind: "field", binding: "subject", field: "ref" } },
        ],
      },
    },
  };

  const result = await executeQuery(query, {}, factSearch, { pageSize: 20 });

  assert.deepEqual(result.rows, [{
    fact: "fact:9",
    person: "person:1",
    character: "character:7",
    subject: "subject:3",
  }]);
  assert.ok(result.evidence[0]?.fact?.some((item) =>
    item.kind === "text-range" && item.ref === "fact:9"
  ));
});

test("keeps a fact full-text hit whose archived role is unresolved", async () => {
  const factSearch: QueryDataSource = {
    scan: async function* () {},
    entity: async (ref) =>
      ref === "person:1" ? P(1) : ref === "character:7" ? C(7) : null,
    fullTextFact: async function* () {
      yield voiceCredit;
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      fullText: {
        kind: "fullText",
        target: "fact",
        factKind: "VOICE_CREDIT",
        factBinding: "credit",
        roles: {
          person: "person",
          character: "character",
          subjectContext: "subject",
        },
        text: { kind: "literal", value: "hero" },
        field: "summary",
      },
      project: {
        kind: "project",
        input: "fullText",
        columns: [
          { name: "fact", value: { kind: "field", binding: "credit", field: "ref" } },
          { name: "subject", value: { kind: "field", binding: "subject", field: "ref" } },
        ],
      },
    },
  };

  const result = await executeQuery(query, {}, factSearch, { pageSize: 20 });

  assert.deepEqual(result.rows, [{ fact: "fact:9", subject: MISSING }]);
});

test("establishes an entity binding from a typed canonical value", async () => {
  let lookups = 0;
  const lookupSource: QueryDataSource = {
    scan: async function* () {},
    entity: async (ref) => {
      lookups++;
      return subjects.find((subject) => subject.ref === ref) ?? null;
    },
  };
  const query: QueryDocument = {
    schema: "atlas-query-document-v1",
    root: "project",
    parameters: {},
    operators: {
      anchor: {
        kind: "values",
        columns: ["subject"],
        types: { subject: "entity:subject" },
        rows: [["subject:3"]],
      },
      project: {
        kind: "project",
        input: "anchor",
        columns: [
          { name: "name", value: { kind: "field", binding: "subject", field: "name" } },
        ],
      },
    },
  };

  const result = await executeQuery(query, {}, lookupSource, { pageSize: 10 });

  assert.deepEqual(result.rows, [{ name: "B" }]);
  assert.equal(lookups, 1);
});
