import assert from "node:assert/strict";
import { test } from "node:test";

import type { UrlState } from "../src/url";
import {
  locateStableTarget,
  resolveUrlSelection,
} from "../src/url-restore";

const linkedUrl: UrlState = {
  view: {
    target: [1, 2, 3],
    zoom: 4,
    rotationX: 25,
    rotationOrbit: 30,
  },
  key: 101,
  rank: 7,
  link: { kind: "common", fromKey: 202, fromRank: 9 },
  ortho: false,
};

test("keeps the full linked URL pending until both stable keys resolve", async () => {
  const staleHints = new Map([
    [7, 999],
    [9, 888],
  ]);
  let loadedRanks = new Map<number, number>();
  const locate = async (
    key: number | null,
    rankHint: number | null,
  ): Promise<{ key: number; rank: number } | null> =>
    locateStableTarget(
      key,
      rankHint,
      (stableKey) => loadedRanks.get(stableKey) ?? null,
      async (rank) => {
        const hintedKey = staleHints.get(rank);
        return hintedKey === undefined ? null : { key: hintedKey };
      },
    );

  assert.equal(await resolveUrlSelection(linkedUrl, locate), null);

  loadedRanks = new Map([
    [101, 70],
    [202, 90],
  ]);
  assert.deepEqual(await resolveUrlSelection(linkedUrl, locate), {
    key: 101,
    rank: 70,
    link: { kind: "common", fromKey: 202, fromRank: 90 },
    camera: "none",
  });
});

test("retains old rank-only URL compatibility", async () => {
  const state: UrlState = {
    view: null,
    key: null,
    rank: 4,
    link: null,
    ortho: false,
  };

  assert.deepEqual(
    await resolveUrlSelection(state, async (key, rankHint) =>
      key === null && rankHint === 4 ? { key: 303, rank: 4 } : null,
    ),
    { key: 303, rank: 4, link: null, camera: "fly" },
  );
});
