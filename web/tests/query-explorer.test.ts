import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson, normalizeQuery } from "../src/query/canonical";
import { normalizeBundle } from "../src/query/bundle";
import {
  compileExplorerQuery,
  decompileExplorerQuery,
  formatExplorerQuery,
} from "../src/query/explorer";
import { lowerAtlasQuery } from "../src/query/language";
import { querySortFields } from "../src/query/workbench-model";
import { validateQuery } from "../src/query/validate";
import type { Owner } from "../src/query/contract";

test("reports a malformed body query without referring to a UI scope", () => {
  const draft = {
    owner: "subject" as const,
    fullText: { value: "星海", field: undefined },
  };

  assert.throws(
    () => formatExplorerQuery(draft as never),
    /正文检索缺少内容字段/,
  );
  assert.throws(
    () => compileExplorerQuery(draft as never),
    /正文检索缺少内容字段/,
  );
});

test("does not impose a hidden result limit on an ordinary query", () => {
  const draft = { owner: "subject" as const };
  const bundle = compileExplorerQuery(draft);

  assert.equal(bundle.sections.results?.query.limit, null);
  assert.doesNotMatch(formatExplorerQuery(draft), /LIMIT/);
  assert.equal(decompileExplorerQuery(bundle)?.limit, undefined);
});

test("every sort field exposed by the visual editor compiles into an executable query", () => {
  const owners: Owner[] = ["subject", "person", "character", "episode"];
  for (const owner of owners) {
    for (const column of querySortFields(owner)) {
      const section = compileExplorerQuery({
        owner,
        orderBy: [{ column, direction: "asc", nulls: "last" }],
      }).sections.results;
      assert.ok(section);
      assert.doesNotThrow(
        () => validateQuery(section.query),
        `${owner}.${column} should be a valid sort choice`,
      );
    }
  }
});

test("the unified builder composes lookup, fields, relations, sort, and limit", () => {
  const bundle = normalizeBundle(compileExplorerQuery({
    owner: "subject",
    text: { value: "星空", capability: "lookup" },
    condition: { kind: "compare", field: "score", operator: "gte", value: 8 },
    relations: [{
      factKind: "WORKED_ON",
      candidateRole: "subject",
      relatedRole: "person",
      related: "person:7",
      exists: true,
    }],
    columns: ["ref", "name", "score"],
    orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
    limit: 100,
  }));

  const kinds = Object.values(bundle.sections.results!.query.operators)
    .map((operator) => operator.kind);
  assert.ok(kinds.includes("lookup"));
  assert.ok(kinds.includes("filter"));
  assert.ok(kinds.includes("matchFact"));
  assert.ok(kinds.includes("exists"));
  assert.equal(bundle.sections.results?.query.limit, 100);
  assert.deepEqual(decompileExplorerQuery(bundle), {
    owner: "subject",
    text: { value: "星空", capability: "lookup" },
    condition: { kind: "compare", field: "score", operator: "gte", value: 8 },
    relations: [{
      factKind: "WORKED_ON",
      candidateRole: "subject",
      relatedRole: "person",
      related: "person:7",
      exists: true,
    }],
    columns: ["ref", "name", "score"],
    orderBy: [{ column: "score", direction: "desc", nulls: "last" }],
    limit: 100,
  });
});

test("composes name lookup and body search without replacing either criterion", () => {
  const draft = {
    owner: "subject" as const,
    text: { value: "机器人", capability: "lookup" as const },
    fullText: { value: "未来", field: "summary" as const },
    columns: ["ref", "name"],
    orderBy: [],
  };

  const bundle = compileExplorerQuery(draft);
  const operators = Object.values(bundle.sections.results!.query.operators);

  assert.equal(operators.filter(({ kind }) => kind === "lookup").length, 1);
  assert.equal(operators.filter(({ kind }) => kind === "fullText").length, 1);
  assert.ok(operators.some(({ kind }) => kind === "exists"));
  assert.deepEqual(decompileExplorerQuery(bundle), draft);
  assert.equal(
    canonicalJson(normalizeQuery(lowerAtlasQuery(formatExplorerQuery(draft)), {})),
    canonicalJson(normalizeQuery(bundle.sections.results!.query, {})),
  );
});

test("formats the visual editor as executable Atlas Query", () => {
  const draft: Parameters<typeof formatExplorerQuery>[0] = {
    owner: "subject" as const,
    text: { value: "星空", capability: "lookup" as const },
    condition: { kind: "compare" as const, field: "score", operator: "gte" as const, value: 8 },
    columns: ["ref", "name", "score"],
    orderBy: [{ column: "score", direction: "desc" as const, nulls: "last" as const }],
    limit: 100,
  };

  const source = formatExplorerQuery(draft);

  assert.equal(source, [
    "FIND subject AS item",
    "SEARCH '星空'",
    "WHERE score >= 8",
    "RETURN ref, name, score",
    "ORDER BY score DESC NULLS LAST",
    "LIMIT 100",
  ].join("\n"));
  assert.equal(
    canonicalJson(normalizeQuery(lowerAtlasQuery(source), {})),
    canonicalJson(normalizeQuery(compileExplorerQuery(draft).sections.results!.query, {})),
  );
});

test("keeps multi-value and any-match conditions executable and editable", () => {
  const draft: Parameters<typeof formatExplorerQuery>[0] = {
    owner: "subject",
    condition: {
      kind: "any",
      terms: [
        { kind: "in", field: "type", values: [1, 2] },
        { kind: "compare", field: "score", operator: "gte", value: 8 },
      ],
    },
    columns: ["ref", "name", "type", "score"],
    orderBy: [],
    limit: 50,
  };

  const source = formatExplorerQuery(draft);

  assert.match(source, /WHERE type IN \[1, 2\] OR score >= 8/);
  assert.equal(
    canonicalJson(normalizeQuery(lowerAtlasQuery(source), {})),
    canonicalJson(normalizeQuery(compileExplorerQuery(draft).sections.results!.query, {})),
  );
  assert.deepEqual(decompileExplorerQuery(compileExplorerQuery(draft)), draft);
});

test("formats an excluded value set without inventing another query model", () => {
  const draft: Parameters<typeof formatExplorerQuery>[0] = {
    owner: "episode",
    condition: { kind: "in", field: "type", values: [0, 1], negated: true },
    columns: ["ref", "name", "type"],
    orderBy: [],
    limit: 20,
  };

  assert.match(formatExplorerQuery(draft), /WHERE NOT \(type IN \[0, 1\]\)/);
  assert.deepEqual(decompileExplorerQuery(compileExplorerQuery(draft)), draft);
});

test("keeps owning-subject filters executable and editable", () => {
  const draft: Parameters<typeof formatExplorerQuery>[0] = {
    owner: "episode",
    condition: {
      kind: "in",
      field: "subjectRef",
      values: ["subject:265", "subject:213"],
    },
    columns: ["ref", "name", "subjectRef"],
    orderBy: [],
  };

  const source = formatExplorerQuery(draft);
  assert.match(source, /subjectRef IN \['subject:265', 'subject:213'\]/);
  assert.doesNotThrow(() => normalizeQuery(compileExplorerQuery(draft).sections.results!.query, {}));
  assert.doesNotThrow(() => normalizeQuery(lowerAtlasQuery(source), {}));
  assert.deepEqual(decompileExplorerQuery(compileExplorerQuery(draft)), draft);
});

test("round-trips complementary contains and null conditions", () => {
  const draft: Parameters<typeof formatExplorerQuery>[0] = {
    owner: "subject",
    condition: {
      kind: "all",
      terms: [
        { kind: "compare", field: "tags", operator: "contains", value: "科幻", negated: true },
        { kind: "isNull", field: "score", negated: true },
      ],
    },
    columns: ["ref", "name", "score"],
    orderBy: [],
    limit: 20,
  };

  assert.match(formatExplorerQuery(draft), /NOT \(tags CONTAINS '科幻'\) AND NOT \(score IS NULL\)/);
  assert.deepEqual(decompileExplorerQuery(compileExplorerQuery(draft)), draft);
});

test("formats relationship filters with every canonical fact role", () => {
  const draft: Parameters<typeof formatExplorerQuery>[0] = {
    owner: "subject",
    relations: [{
      factKind: "VOICE_CREDIT",
      candidateRole: "subjectContext",
      relatedRole: "person",
      related: "person:7",
      exists: false,
    }],
    columns: ["ref", "name"],
    orderBy: [],
    limit: 20,
  };
  const source = formatExplorerQuery(draft);

  assert.match(source, /NOT EXISTS \{ MATCH VOICE_CREDIT\(person: relation0_related, subjectContext: item, character: relation0_character\) AS relation0 WHERE relation0_related\.ref = 'person:7' \}/);
  const query = normalizeQuery(lowerAtlasQuery(source), {});
  assert.ok(Object.values(query.operators).some((operator) => operator.kind === "notExists"));
  const match = Object.values(query.operators).find(
    (operator) => operator.kind === "matchFact" && operator.factKind === "VOICE_CREDIT",
  );
  assert.equal(
    match?.kind === "matchFact" ? query.operators[match.input]?.kind : undefined,
    "values",
  );
  assert.deepEqual(decompileExplorerQuery({
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: {
      results: {
        query,
        answer: { shape: "entity-list", title: "探索结果" },
      },
    },
  }), draft);
});

test("binds every selected endpoint on the same ternary relationship fact", () => {
  const draft: Parameters<typeof formatExplorerQuery>[0] = {
    owner: "character",
    relations: [{
      factKind: "VOICE_CREDIT",
      candidateRole: "character",
      relatedRole: "person",
      related: "person:7",
      additionalEndpoints: [{
        role: "subjectContext",
        related: "subject:265",
      }],
      exists: true,
    }],
    columns: ["ref", "name"],
    orderBy: [],
    limit: 20,
  };

  const bundle = compileExplorerQuery(draft);
  const query = bundle.sections.results!.query;
  const match = Object.values(query.operators).find((operator) =>
    operator.kind === "matchFact" && operator.factKind === "VOICE_CREDIT"
  );
  assert.ok(match?.kind === "matchFact");
  const values = query.operators[match.input];
  assert.deepEqual(values, {
    kind: "values",
    columns: ["relation0Fixed", "relation0Fixed1"],
    types: {
      relation0Fixed: "entity:person",
      relation0Fixed1: "entity:subject",
    },
    rows: [["person:7", "subject:265"]],
  });
  assert.match(
    formatExplorerQuery(draft),
    /person: relation0_related, subjectContext: relation0_related1, character: item/,
  );
  assert.match(
    formatExplorerQuery(draft),
    /relation0_related\.ref = 'person:7' AND relation0_related1\.ref = 'subject:265'/,
  );
  assert.deepEqual(decompileExplorerQuery(bundle), draft);

  const parsed = lowerAtlasQuery(formatExplorerQuery(draft));
  assert.deepEqual(decompileExplorerQuery({
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: {
      results: {
        query: parsed,
        answer: { shape: "entity-list", title: "探索结果" },
      },
    },
  }), draft);
});

test("filters attributes on the matched fact and round-trips them", () => {
  const draft: Parameters<typeof formatExplorerQuery>[0] = {
    owner: "subject",
    relations: [{
      factKind: "WORKED_ON",
      candidateRole: "subject",
      relatedRole: "person",
      related: "person:7",
      exists: true,
      condition: {
        kind: "in",
        field: "position",
        values: [1, 2],
      },
    }],
    columns: ["ref", "name"],
    orderBy: [
      { column: "score", direction: "desc", nulls: "last" },
      { column: "name", direction: "asc", nulls: "first" },
    ],
    limit: 20,
  };

  const bundle = compileExplorerQuery(draft);
  const query = bundle.sections.results!.query;
  const factFilter = Object.values(query.operators).find((operator) =>
    operator.kind === "filter" &&
    operator.predicate.kind === "or" &&
    operator.predicate.terms.every((term) =>
      term.kind === "compare" &&
      term.left.kind === "field" &&
      term.left.binding === "relation0Fact"
    )
  );

  assert.ok(factFilter);
  assert.match(
    formatExplorerQuery(draft),
    /relation0\.position IN \[1, 2\]/,
  );
  assert.deepEqual(decompileExplorerQuery(bundle), draft);
});

test("composes grouped statistics and post-statistic conditions", () => {
  const draft: Parameters<typeof compileExplorerQuery>[0] = {
    owner: "subject",
    condition: { kind: "in", field: "type", values: [1, 2] },
    aggregate: {
      groupBy: ["type"],
      metrics: [
        { function: "count" },
        { function: "avg", field: "score" },
      ],
      having: {
        kind: "compare",
        field: "count",
        operator: "gte",
        value: 2,
      },
    },
    orderBy: [{ column: "count", direction: "desc", nulls: "last" }],
    limit: 20,
  };

  const bundle = compileExplorerQuery(draft);
  const query = bundle.sections.results!.query;
  const aggregate = Object.values(query.operators).find(
    (operator) => operator.kind === "aggregate",
  );
  const having = Object.values(query.operators).find((operator) =>
    operator.kind === "filter" && operator.input === "aggregate"
  );

  assert.deepEqual(aggregate, {
    kind: "aggregate",
    input: "filter",
    groupBy: [{
      name: "type",
      value: { kind: "field", binding: "entity", field: "type" },
    }],
    metrics: [
      { name: "count", function: "count" },
      {
        name: "avg_score",
        function: "avg",
        value: { kind: "field", binding: "entity", field: "score" },
      },
    ],
  });
  assert.deepEqual(having, {
    kind: "filter",
    input: "aggregate",
    predicate: {
      kind: "compare",
      operator: "gte",
      left: { kind: "column", name: "count" },
      right: { kind: "literal", value: 2 },
    },
  });
  assert.equal(bundle.sections.results?.answer.shape, "aggregate-table");
  assert.deepEqual(decompileExplorerQuery(bundle), draft);
});

test("keeps reusable values typed, editable, and shareable", () => {
  const draft: Parameters<typeof compileExplorerQuery>[0] = {
    owner: "subject",
    fullText: {
      value: "机器人",
      field: "summary",
      parameter: "keyword",
    },
    condition: {
      kind: "compare",
      field: "score",
      operator: "gte",
      value: 8,
      parameter: "minimumScore",
    },
    aggregate: {
      groupBy: ["type"],
      metrics: [{ function: "count" }],
      having: {
        kind: "compare",
        field: "count",
        operator: "gte",
        value: 2,
        parameter: "minimumCount",
      },
    },
    orderBy: [],
    limit: 20,
  };

  const bundle = compileExplorerQuery(draft);
  const section = bundle.sections.results!;
  assert.deepEqual(section.query.parameters, {
    keyword: "string",
    minimumScore: "number",
    minimumCount: "integer",
  });
  assert.deepEqual(section.parameterValues, {
    keyword: "机器人",
    minimumScore: 8,
    minimumCount: 2,
  });
  assert.match(formatExplorerQuery(draft), /\$minimumScore/);
  assert.deepEqual(decompileExplorerQuery(bundle), draft);
});

test("rejects one reused parameter with conflicting values", () => {
  assert.throws(() => compileExplorerQuery({
    owner: "subject",
    condition: {
      kind: "all",
      terms: [
        {
          kind: "compare",
          field: "score",
          operator: "gte",
          value: 8,
          parameter: "threshold",
        },
        {
          kind: "compare",
          field: "score",
          operator: "lte",
          value: 9,
          parameter: "threshold",
        },
      ],
    },
  }), /值必须保持一致/);
});

test("keeps escaped text and negative numeric filters executable", () => {
  const source = formatExplorerQuery({
    owner: "subject",
    text: { value: "A'B\nC", capability: "lookup" },
    condition: { kind: "compare", field: "rank", operator: "gte", value: -1 },
    columns: ["ref"],
    limit: 1,
  });

  assert.match(source, /SEARCH 'A\\'B\\nC'/);
  assert.doesNotThrow(() => normalizeQuery(lowerAtlasQuery(source), {}));
});

test("rejects unsafe section names from shared links", () => {
  const bundle = JSON.parse(`{
    "schema":"atlas-query-bundle-v2",
    "release":{"policy":"latest"},
    "sections":{"__proto__":{}}
  }`) as Parameters<typeof normalizeBundle>[0];

  assert.throws(() => normalizeBundle(bundle), /section name/);
});
