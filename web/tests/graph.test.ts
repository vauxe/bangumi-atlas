import assert from "node:assert/strict";
import { test } from "node:test";

import { findPath } from "../src/graph";
import type { AdjEntry, Geometry } from "../src/types";

test("preserves relationship direction when the searches meet", async () => {
  const geo = {
    key: new Uint32Array([100, 200, 300, 400]),
  } as Geometry;
  const adjacency = new Map<number, AdjEntry>([
    [100, { g: [[10, 2, [1, 3]]], n: 2 }],
    [200, { g: [[11, 1, [0]], [20, 1, [2]]], n: 2 }],
    [300, { g: [[21, 1, [1]]], n: 1 }],
    [400, { g: [[12, 1, [0]]], n: 1 }],
  ]);

  const path = await findPath(
    0,
    2,
    geo,
    8,
    async (key) => adjacency.get(key) ?? null,
  );

  assert.deepEqual(path, {
    ranks: [0, 1, 2],
    labels: [10, 21],
    directions: [1, -1],
  });
});
