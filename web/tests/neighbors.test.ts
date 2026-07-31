import assert from "node:assert/strict";
import { test } from "node:test";

import { uniqueNeighbors } from "../src/neighbors";
import type { AdjEntry } from "../src/types";

test("caps unique neighbor nodes without losing the primary label", () => {
  const adj: AdjEntry = {
    g: [
      [9, 2, [3, 1]],
      [2, 2, [1, 2]],
    ],
    n: 4,
  };

  assert.deepEqual(uniqueNeighbors(adj, 3), {
    ranks: [1, 2, 3],
    labels: [9, 2, 9],
  });
  assert.deepEqual(uniqueNeighbors(adj, 2).ranks, [1, 2]);
});
