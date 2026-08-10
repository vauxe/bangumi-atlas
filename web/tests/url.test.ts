import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { compileExplorerQuery } from "../src/query/explorer";
import type { QueryBundle } from "../src/query/bundle";
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

test("ignores retired pre-release URL formats", () => {
  const decoded = decode("#n=16777258&r=123&q=path&f=33554439&fr=9");
  assert.deepEqual(decoded, {
    view: null,
    key: 0x0100_002a,
    rank: 123,
    ortho: false,
  });

  for (const hash of ["#aq=retired", "#ac=retired"]) {
    state.queryBundle = null;
    decode(hash);
    assert.equal(state.queryBundle, null);
  }

  decode("#y=2000-2030&m=1&t=2&s=85");
  assert.equal(state.queryBundle, null);
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
  assert.equal(decodedBundle?.schema, "atlas-query-bundle-v1");
  assert.equal(decodedBundle?.sections.results?.query.limit, null);
});

test("an unshareable query does not prevent local URL updates", () => {
  state.queryBundle = {
    schema: "atlas-query-bundle-v1",
    release: { policy: "latest" },
    sections: {
      results: {
        query: {
          schema: "atlas-query-document-v1",
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
