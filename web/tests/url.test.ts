import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { compileExplorerQuery } from "../src/query/explorer";
import type { QueryBundle } from "../src/query/bundle";
import { encodeCypherState } from "../src/query/cypher-url";
import { encodeQuestion } from "../src/query/question-url";
import { state } from "../src/store";
import { decode, encode } from "../src/url";

const view = {
  target: [1, 2, 3] as [number, number, number],
  zoom: 4,
  rotationX: 25,
  rotationOrbit: 30,
};

beforeEach(() => {
  state.queryBundle = null;
});

test("reads legacy link-query identity without writing it again", () => {
  const decoded = decode(
    "#n=16777258&r=123&q=path&f=33554439&fr=9",
  );
  assert.equal(decoded.key, 0x0100_002a);
  assert.equal(decoded.rank, 123);
  assert.deepEqual(decoded.link, {
    kind: "path",
    fromKey: 0x0200_0007,
    fromRank: 9,
  });
  assert.doesNotMatch(encode(view, decoded.key, decoded.rank), /(?:^|&)(?:q|f|fr)=/);
});

test("keeps old selection URLs compatible and ignores partial link state", () => {
  assert.equal(decode("#n=16777258&r=123").link, null);
  assert.equal(decode("#n=16777258&r=123&q=common&f=33554439").link, null);
});

test("encodes one canonical QueryBundle and no parallel filter state", () => {
  state.queryBundle = compileExplorerQuery({
    owner: "subject",
    condition: { kind: "compare", field: "score", operator: "gte", value: 8 },
    columns: ["ref", "name", "score"],
  });

  const hash = encode(view, null, null);
  assert.match(hash, /(?:^|&)qb=/);
  assert.doesNotMatch(hash, /(?:^|&)(?:aq|ac|m|t|s|y)=/);

  state.queryBundle = null;
  decode(hash);
  const decodedBundle = state.queryBundle as QueryBundle | null;
  assert.equal(decodedBundle?.schema, "atlas-query-bundle-v2");
  assert.equal(decodedBundle?.sections.results?.query.limit, null);
});

test("an unshareable query does not prevent local URL updates", () => {
  state.queryBundle = {
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: {
      results: {
        query: {
          schema: "atlas-query-document-v2",
          root: "values",
          parameters: {},
          operators: {
            values: {
              kind: "values",
              columns: ["value"],
              rows: Array.from({ length: 1_000 }, (_, index) => [
                `本地查询参数 ${index.toString().padStart(4, "0")} ${"内容".repeat(20)}`,
              ]),
            },
          },
        },
        answer: { shape: "table", title: "结果" },
      },
    },
  };

  assert.doesNotThrow(() => encode(view, null, null));
  assert.doesNotMatch(encode(view, null, null), /(?:^|&)qb=/);
  assert.ok(state.queryBundle);
});

test("does not revive obsolete canvas filter state", () => {
  decode("#y=2000-2030&m=1&t=2&s=85");
  assert.equal(state.queryBundle, null);
  assert.doesNotMatch(encode(view, null, null), /(?:^|&)(?:m|t|s|y)=/);
});

test("migrates a legacy ordinary-user question into QueryBundle v2", () => {
  const encoded = encodeQuestion({
    schema: "atlas-question-v1",
    mode: "find",
    owner: "subject",
    condition: { kind: "compare", field: "score", operator: "gte", value: 8 },
    columns: ["ref", "name", "score"],
  });

  decode(`#aq=${encoded}`);

  assert.equal(state.queryBundle?.schema, "atlas-query-bundle-v2");
  assert.ok(state.queryBundle?.sections.results);
});

test("migrates legacy Atlas Cypher into the same QueryBundle state", () => {
  const encoded = encodeCypherState({
    schema: "atlas-cypher-source-v1",
    source: "MATCH (s:Subject) WHERE s.score >= $min RETURN s AS subject",
    parameters: { min: 8 },
  });

  decode(`#ac=${encoded}`);

  assert.equal(state.queryBundle?.schema, "atlas-query-bundle-v2");
  assert.ok(state.queryBundle?.sections.results);
});
