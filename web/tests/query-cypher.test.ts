import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson, normalizeQuery } from "../src/query/canonical";
import { lowerAtlasCypher } from "../src/query/language";
import { compileExplorerQuery } from "../src/query/explorer";

test("lowers Atlas Cypher to the same canonical plan as the ordinary builder", () => {
  const cypher = lowerAtlasCypher(`
    MATCH (s:Subject)
    WHERE s.score >= $minimum AND s.tags CONTAINS '科幻'
    RETURN s.ref AS ref, s.name AS name, s.score AS score
    ORDER BY score DESC NULLS LAST
    LIMIT 20
  `, { minimum: "number" });
  const builder = compileExplorerQuery({
    owner: "subject",
    condition: {
      kind: "all",
      terms: [
        { kind: "compare", field: "score", operator: "gte", value: 8 },
        { kind: "compare", field: "tags", operator: "contains", value: "科幻" },
      ],
    },
    columns: ["ref", "name", "score"],
    orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
    limit: 20,
  }).sections.results!.query;

  assert.equal(
    canonicalJson(normalizeQuery(cypher, { minimum: 8 })),
    canonicalJson(normalizeQuery(builder, {})),
  );
});

test("requires the complete three-role form for voice credits", () => {
  const query = lowerAtlasCypher(`
    MATCH FACT credit:VOICE_CREDIT(
      person:p,
      character:c,
      subjectContext:s
    )
    RETURN p AS person, c AS character, s AS subject, credit AS evidence
  `);
  const expand = Object.values(query.operators).find((operator) => operator.kind === "matchFact");

  assert.deepEqual(expand, {
    kind: "matchFact",
    input: "scan0",
    factKind: "VOICE_CREDIT",
    factBinding: "credit",
    roles: { person: "p", character: "c", subjectContext: "s" },
  });
  assert.throws(
    () => lowerAtlasCypher(`
      MATCH (p:Person)-[credit:VOICE_CREDIT]->(c:Character)
      RETURN p AS person
    `),
    /完整三角色/,
  );
});

test("supports grouped aggregates and IN without adding another executor", () => {
  const query = lowerAtlasCypher(`
    MATCH (s:Subject)
    WHERE s.type IN [1, 2]
    RETURN s.type AS type, COUNT(*) AS rows, AVG(s.score) AS score
    ORDER BY rows DESC NULLS LAST
  `);
  const aggregate = Object.values(query.operators).find((operator) => operator.kind === "aggregate");

  assert.equal(aggregate?.kind, "aggregate");
  if (aggregate?.kind === "aggregate") {
    assert.deepEqual(aggregate.groupBy.map((group) => group.name), ["type"]);
    assert.deepEqual(aggregate.metrics.map((metric) => metric.function), ["count", "avg"]);
  }
});

test("does not expose full text as an ordinary projected field", () => {
  const query = lowerAtlasCypher(`
    MATCH (s:Subject)
    WHERE s.summary CONTAINS $needle AND s.score >= 8
    RETURN s.ref AS ref, s.summary AS summary
    LIMIT 20
  `, { needle: "string" });
  assert.throws(
    () => normalizeQuery(query, { needle: "时间机器" }),
    /summary does not support (?:filter|project)/,
  );
});

test("turns a literal stable identity into a point lookup", () => {
  const query = lowerAtlasCypher(`
    MATCH (p:Person)-[work:WORKED_ON]->(s:Subject)
    WHERE p.ref = 'person:7'
    RETURN s.ref AS ref, s.name AS name
    LIMIT 20
  `);
  const values = Object.values(query.operators).find(
    (operator) => operator.kind === "values",
  );

  assert.deepEqual(values, {
    kind: "values",
    columns: ["p"],
    types: { p: "entity:person" },
    rows: [["person:7"]],
  });
  assert.doesNotThrow(() => normalizeQuery(query, {}));
});

test("keeps raw infobox outside query projection", () => {
  const query = lowerAtlasCypher(`
    MATCH (s:Subject)
    RETURN s.ref AS ref, s.infobox AS infobox
    LIMIT 20
  `);

  assert.throws(
    () => normalizeQuery(query, {}),
    /infobox does not support project/,
  );
});

test("lowers correlated EXISTS and NOT EXISTS to typed semi-joins", () => {
  const query = lowerAtlasCypher(`
    MATCH (s:Subject)
    WHERE s.score >= 8 AND EXISTS {
      MATCH (p:Person)-[work:WORKED_ON]->(s:Subject)
      WHERE p.collects > 100
    }
    AND NOT EXISTS {
      MATCH (c:Character)-[appearance:APPEARS_IN]->(s:Subject)
      WHERE c.role = 2
    }
    RETURN s AS subject
  `);
  const kinds = Object.values(query.operators).map((operator) => operator.kind);
  assert.ok(kinds.includes("exists"));
  assert.ok(kinds.includes("notExists"));
  const correlation = Object.values(query.operators).find(
    (operator) => operator.kind === "exists",
  );
  assert.deepEqual(
    correlation?.kind === "exists" ? correlation.columns : null,
    [{ outer: "s", inner: "s" }],
  );
  assert.doesNotThrow(() => normalizeQuery(query, {}));
});

test("rejects disconnected, mutating, and undeclared-parameter statements", () => {
  assert.throws(
    () => lowerAtlasCypher("MATCH (s:Subject), (p:Person) RETURN s AS subject"),
    /不连通/,
  );
  assert.throws(
    () => lowerAtlasCypher("CREATE (s:Subject) RETURN s AS subject"),
    /需要 MATCH/,
  );
  assert.throws(
    () => lowerAtlasCypher("MATCH (s:Subject) WHERE s.score > $min RETURN s AS subject"),
    /没有类型声明/,
  );
});
