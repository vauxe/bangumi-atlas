import assert from "node:assert/strict";
import { test } from "node:test";

import type { UrlState } from "../src/url";
import {
  locateStableTarget,
  resolveUrlSelection,
} from "../src/url-restore";

test("resolves a rank-only selection when its key is not loaded", async () => {
  const state: UrlState = {
    view: null,
    key: null,
    rank: 4,
    ortho: false,
  };

  assert.deepEqual(
    await resolveUrlSelection(state, async (key, rankHint) =>
      key === null && rankHint === 4 ? { key: 303, rank: 4 } : null,
    ),
    { key: 303, rank: 4, camera: "fly" },
  );
});

test("rechecks the stable key when streaming finishes during a hint read", async () => {
  let geometryComplete = false;

  const located = await locateStableTarget(
    101,
    7,
    (key) => (geometryComplete && key === 101 ? 70 : null),
    async () => {
      geometryComplete = true;
      return { key: 999 };
    },
  );

  assert.deepEqual(located, { key: 101, rank: 70 });
});
