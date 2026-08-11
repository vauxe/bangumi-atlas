import assert from "node:assert/strict";
import { test } from "node:test";

import {
  QueryHighlightBuilder,
  mergeQueryHighlights,
  queryHighlightRanks,
  validateQueryHighlights,
} from "../src/query/highlights";

test("keeps sparse query highlights in a sorted u32 payload", () => {
  const builder = new QueryHighlightBuilder(1_000);
  for (const rank of [500, 2, 500, 17]) builder.add(rank);

  const highlights = builder.finish();

  assert.equal(highlights.encoding, "ranks-u32");
  assert.equal(highlights.count, 3);
  assert.deepEqual([...queryHighlightRanks(highlights)], [2, 17, 500]);
});

test("switches dense query highlights to a fixed-size rank bitset", () => {
  const builder = new QueryHighlightBuilder(100);
  for (let rank = 0; rank < 40; rank++) builder.add(rank);

  const highlights = builder.finish();

  assert.equal(highlights.encoding, "rank-bitset");
  assert.equal(highlights.count, 40);
  assert.equal(
    highlights.encoding === "rank-bitset" ? highlights.bits.byteLength : 0,
    13,
  );
  assert.deepEqual(
    [...queryHighlightRanks(highlights)],
    Array.from({ length: 40 }, (_, rank) => rank),
  );
});

test("merges sparse and dense section highlights without duplicate ranks", () => {
  const sparse = new QueryHighlightBuilder(100);
  sparse.add(2);
  sparse.add(90);
  const dense = new QueryHighlightBuilder(100);
  for (const rank of [1, 2, 3, 4]) dense.add(rank);

  assert.deepEqual(
    [...mergeQueryHighlights([sparse.finish(), dense.finish()])],
    [1, 2, 3, 4, 90],
  );
});

test("rejects malformed highlight payloads at the worker boundary", () => {
  assert.throws(() => validateQueryHighlights({
    encoding: "ranks-u32",
    nodeCount: 10,
    count: 2,
    ranks: new Uint32Array([2, 2]),
  }), /invalid query highlights/);
  assert.throws(() => validateQueryHighlights({
    encoding: "rank-bitset",
    nodeCount: 9,
    count: 1,
    bits: new Uint8Array([0, 2]),
  }), /invalid query highlights/);
});
