import assert from "node:assert/strict";
import { test } from "node:test";

import { lowerAtlasQuery } from "../src/query/language";
import { canonicalJson, normalizeQuery } from "../src/query/canonical";
import { compileExplorerQuery } from "../src/query/explorer";

test("FIND lowers to the same plan as the ordinary query builder", () => {
  const text = lowerAtlasQuery(`
    FIND subject
    WHERE score >= $minimum AND tags CONTAINS '科幻'
    RETURN ref, name, score
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
    canonicalJson(normalizeQuery(text, { minimum: 8 })),
    canonicalJson(normalizeQuery(builder, {})),
  );
});

test("MATCH binds complete relationship facts by named role", () => {
  const query = lowerAtlasQuery(`
    FIND subject AS s
    MATCH VOICE_CREDIT(
      person: p,
      character: c,
      subjectContext: s
    ) AS credit
    WHERE p.name = '花泽香菜'
    RETURN c AS character, s AS subject, credit AS evidence
    LIMIT 20
  `);
  const match = Object.values(query.operators).find(
    (operator) => operator.kind === "matchFact",
  );

  assert.deepEqual(match, {
    kind: "matchFact",
    input: "scan0",
    factKind: "VOICE_CREDIT",
    factBinding: "credit",
    roles: { person: "p", character: "c", subjectContext: "s" },
  });
  assert.doesNotThrow(() => normalizeQuery(query, {}));
});

test("SEARCH is a first-class lookup or full-text source", () => {
  const lookup = lowerAtlasQuery(`
    FIND person
    SEARCH '宫崎骏'
    RETURN ref, name
    LIMIT 20
  `);
  const fullText = lowerAtlasQuery(`
    FIND episode
    SEARCH $needle IN description
    RETURN ref, name
    LIMIT 20
  `, { needle: "string" });

  assert.equal(lookup.operators.scan0?.kind, "lookup");
  assert.deepEqual(fullText.operators.scan0, {
    kind: "fullText",
    target: "entity",
    owner: "episode",
    binding: "item",
    text: { kind: "parameter", name: "needle" },
    field: "description",
  });
  assert.doesNotThrow(() => normalizeQuery(fullText, { needle: "毕业" }));
});

test("GROUP BY and HAVING use returned aggregate names", () => {
  const query = lowerAtlasQuery(`
    FIND subject
    WHERE type IN [1, 2]
    RETURN type, COUNT(*) AS count, AVG(score) AS average
    GROUP BY type
    HAVING count >= 2
    ORDER BY count DESC NULLS LAST
  `);
  const aggregate = Object.values(query.operators).find(
    (operator) => operator.kind === "aggregate",
  );
  const having = Object.values(query.operators).find(
    (operator) => operator.kind === "filter" && operator.input.startsWith("aggregate"),
  );

  assert.equal(aggregate?.kind, "aggregate");
  assert.deepEqual(
    aggregate?.kind === "aggregate" ? aggregate.groupBy.map((item) => item.name) : [],
    ["type"],
  );
  assert.deepEqual(having, {
    kind: "filter",
    input: "aggregate2",
    predicate: {
      kind: "compare",
      operator: "gte",
      left: { kind: "column", name: "count" },
      right: { kind: "literal", value: 2 },
    },
  });
  assert.doesNotThrow(() => normalizeQuery(query, {}));
});

test("FIND PATH produces the same bounded path operator used by the UI", () => {
  const query = lowerAtlasQuery(`
    FIND PATH
    FROM person:7
    TO subject:123
    MAX HOPS 4
    LIMIT 3
  `);
  const path = Object.values(query.operators).find(
    (operator) => operator.kind === "path",
  );

  assert.equal(path?.kind, "path");
  if (path?.kind === "path") {
    assert.deepEqual(path.start, { kind: "literal", value: "person:7" });
    assert.deepEqual(path.target, { kind: "literal", value: "subject:123" });
    assert.equal(path.maxHops, 4);
    assert.equal(path.maxPaths, 3);
  }
  assert.doesNotThrow(() => normalizeQuery(query, {}));
});

test("set clauses combine complete FIND queries with one final ordering", () => {
  const query = lowerAtlasQuery(`
    FIND subject
    WHERE type = 1
    RETURN ref, name
    INTERSECT
    FIND subject
    WHERE score >= 8
    RETURN ref, name
    ORDER BY name ASC
    LIMIT 20
  `);
  const set = Object.values(query.operators).find(
    (operator) => operator.kind === "intersect",
  );

  assert.equal(set?.kind, "intersect");
  assert.equal(set?.kind === "intersect" ? set.branches.length : 0, 2);
  assert.deepEqual(query.orderBy, [
    { column: "name", direction: "asc", nulls: "last" },
  ]);
  assert.equal(query.limit, 20);
  assert.doesNotThrow(() => normalizeQuery(query, {}));
});

test("Atlas Query rejects Cypher and mutation syntax", () => {
  assert.throws(
    () => lowerAtlasQuery("MATCH (s:Subject) RETURN s"),
    /需要 FIND/,
  );
  assert.throws(
    () => lowerAtlasQuery("DELETE subject"),
    /需要 FIND/,
  );
  assert.throws(
    () => lowerAtlasQuery(`FIND PATH FROM person:7 TO subject:123 ${" ".repeat(16_384)}`),
    /Atlas Query 输入过长/,
  );
});
