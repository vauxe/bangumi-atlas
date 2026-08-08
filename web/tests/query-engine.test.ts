import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueryDocument } from "../src/query/document";
import {
  executeQuery,
  type EntityValue,
  type FactValue,
  type QueryDataSource,
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
    schema: "atlas-query-document-v2",
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
  schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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

test("keeps explicit null placement independent from sort direction", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v2",
    root: "values",
    parameters: {},
    operators: {
      values: { kind: "values", columns: ["n"], rows: [[1], [null], [2]] },
    },
    orderBy: [{ column: "n", direction: "desc", nulls: "last" }],
  };

  const result = await executeQuery(query, {}, source, { pageSize: 20 });

  assert.deepEqual(result.rows, [{ n: 2 }, { n: 1 }, { n: null }]);
});

test("orders projected stable references as typed scalar identities", async () => {
  const query: QueryDocument = {
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
  const searched: QueryDataSource = {
    scan: async function* () {},
    lookup: async function* (text, owner) {
      assert.equal(text, "Atlas");
      assert.equal(owner, "subject");
      yield subjects[2] as EntityValue;
    },
    fullText: async function* (text, owner, field) {
      assert.equal(text, "Atlas");
      assert.equal(owner, "subject");
      assert.equal(field, "summary");
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
    schema: "atlas-query-document-v2",
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
  assert.ok(fullTextResult.evidence[0]?.ref?.some((item) =>
    item.kind === "text-range" && item.utf8Range[0] === 3 && item.utf8Range[1] === 8
  ));
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
    schema: "atlas-query-document-v2",
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
