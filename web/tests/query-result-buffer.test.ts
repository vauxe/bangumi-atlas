import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueryResult } from "../src/query/engine";
import {
  appendQueryResultPage,
  commitRenderedResults,
  revealQueryResult,
} from "../src/query/result-buffer";

function queryResult(
  rows: number[],
  options: { offset?: number; total?: number; hasMore?: boolean } = {},
): QueryResult {
  const offset = options.offset ?? 0;
  const total = options.total ?? rows.length;
  return {
    rows: rows.map((value) => ({ value })),
    evidence: rows.map(() => ({})),
    columns: { value: { type: "integer" } },
    totalMatches: total,
    visibleMatches: total,
    hasMore: options.hasMore ?? offset + rows.length < total,
    stability: "exact",
    queryDigest: "query",
    releaseId: "release",
    coverage: { schema: "atlas-coverage-v1", atoms: [], digest: "coverage" },
    terminalEvidence: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("keeps the previous result until every replacement is rendered", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  let visible = ["previous"];

  const committed = commitRenderedResults(
    new AbortController().signal,
    [first.promise, second.promise],
    (results) => {
      visible = [...results];
    },
  );

  first.resolve("first");
  await Promise.resolve();
  assert.deepEqual(visible, ["previous"]);

  second.resolve("second");
  assert.deepEqual(await committed, ["first", "second"]);
  assert.deepEqual(visible, ["first", "second"]);
});

test("does not commit a replacement from a cancelled query", async () => {
  const result = deferred<string>();
  const controller = new AbortController();
  let visible = ["current"];

  const committed = commitRenderedResults(
    controller.signal,
    [result.promise],
    (results) => {
      visible = [...results];
    },
  );
  controller.abort();
  result.resolve("stale");

  assert.equal(await committed, null);
  assert.deepEqual(visible, ["current"]);
});

test("reveals buffered rows without pretending the query is complete", () => {
  const buffered = queryResult(Array.from({ length: 120 }, (_, index) => index), {
    total: 200,
    hasMore: true,
  });

  const visible = revealQueryResult(buffered, 50);

  assert.equal(visible.rows.length, 50);
  assert.equal(visible.evidence.length, 50);
  assert.equal(visible.visibleMatches, 200);
  assert.equal(visible.hasMore, true);
});

test("appends one consistent execution page to the buffered result", () => {
  const first = queryResult([0, 1], { total: 4, hasMore: true });
  const second = queryResult([2, 3], { offset: 2, total: 4, hasMore: false });

  const combined = appendQueryResultPage(first, second);

  assert.deepEqual(combined.rows.map((row) => row.value), [0, 1, 2, 3]);
  assert.equal(combined.hasMore, false);
  assert.throws(
    () => appendQueryResultPage(first, { ...second, releaseId: "other" }),
    /数据版本/,
  );
});
