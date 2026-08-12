import assert from "node:assert/strict";
import { test } from "node:test";

import {
  queryCanReuseLoadedEntityKeys,
  resolveQueryHighlights,
} from "../src/query/highlight-resolver";
import { queryHighlightRanks } from "../src/query/highlights";
import type { QueryDocument } from "../src/query/document";

const lookupQuery = (root = "project"): QueryDocument => ({
  schema: "atlas-query-document-v1",
  root,
  parameters: {},
  operators: {
    lookup: {
      kind: "lookup",
      owner: "subject",
      binding: "s",
      text: { kind: "literal", value: "命运石之门" },
    },
    project: {
      kind: "project",
      input: "lookup",
      columns: [{
        name: "ref",
        value: { kind: "field", binding: "s", field: "ref" },
      }],
    },
    values: { kind: "values", columns: ["n"], rows: [[1]] },
  },
});

test("only selects a reachable structural lookup for key-index reuse", () => {
  assert.equal(queryCanReuseLoadedEntityKeys(lookupQuery()), true);
  assert.equal(queryCanReuseLoadedEntityKeys(lookupQuery("values")), false);

  const episode = lookupQuery();
  const operator = episode.operators.lookup;
  assert.equal(operator?.kind, "lookup");
  if (operator?.kind === "lookup") operator.owner = "episode";
  assert.equal(queryCanReuseLoadedEntityKeys(episode), false);

  const mixed = lookupQuery("union");
  mixed.operators.scan = {
    kind: "scan",
    owner: "subject",
    binding: "other",
  };
  mixed.operators.union = {
    kind: "union",
    branches: [
      { input: "project", columns: [] },
      { input: "scan", columns: [] },
    ],
  };
  assert.equal(queryCanReuseLoadedEntityKeys(mixed), false);

  const correlated = lookupQuery("exists");
  correlated.operators.exists = {
    kind: "exists",
    input: "values",
    match: "lookup",
    columns: [],
  };
  assert.equal(queryCanReuseLoadedEntityKeys(correlated), false);
});

test("reuses loaded rank-ordered entity keys without loading the reverse index", async () => {
  const keysByRank = new Uint32Array([
    (1 << 24) | 11,
    (2 << 24) | 7,
    (3 << 24) | 5,
    (1 << 24) | 99,
  ]);
  let reverseIndexLoads = 0;

  const highlights = await resolveQueryHighlights(
    new Set([keysByRank[3]!, keysByRank[1]!, (1 << 24) | 404]),
    {
      nodeCount: keysByRank.length,
      loadedEntityKeys: () => keysByRank,
      ensureRankIndex: async () => {
        reverseIndexLoads++;
      },
      rankOfKey: () => {
        throw new Error("reverse lookup must not run when key.bin is loaded");
      },
    },
  );

  assert.equal(reverseIndexLoads, 0);
  assert.deepEqual([...queryHighlightRanks(highlights)], [1, 3]);
});

test("falls back to the reverse index when rank-ordered keys are unavailable", async () => {
  const first = (1 << 24) | 11;
  const second = (3 << 24) | 5;
  let reverseIndexReady = false;

  const highlights = await resolveQueryHighlights(new Set([first, second]), {
    nodeCount: 10,
    loadedEntityKeys: () => null,
    ensureRankIndex: async () => {
      reverseIndexReady = true;
    },
    rankOfKey: (key) => {
      assert.equal(reverseIndexReady, true);
      return key === first ? 8 : key === second ? 2 : null;
    },
  });

  assert.deepEqual([...queryHighlightRanks(highlights)], [2, 8]);
});

test("forward and reverse indexes resolve identical dense highlights", async () => {
  const keysByRank = Uint32Array.from(
    { length: 128 },
    (_, rank) => (1 << 24) | (rank + 1),
  );
  const keys = new Set<number>();
  const rankByKey = new Map<number, number>();
  keysByRank.forEach((key, rank) => {
    rankByKey.set(key, rank);
    if (rank % 3 === 0) keys.add(key);
  });
  keys.add((2 << 24) | 404);

  const forward = await resolveQueryHighlights(keys, {
    nodeCount: keysByRank.length,
    loadedEntityKeys: () => keysByRank,
    ensureRankIndex: async () => {},
    rankOfKey: () => null,
  });
  const reverse = await resolveQueryHighlights(keys, {
    nodeCount: keysByRank.length,
    loadedEntityKeys: () => null,
    ensureRankIndex: async () => {},
    rankOfKey: (key) => rankByKey.get(key) ?? null,
  });

  assert.deepEqual(
    [...queryHighlightRanks(forward)],
    [...queryHighlightRanks(reverse)],
  );
});

test("does not load either rank representation for an empty result", async () => {
  let touched = false;
  const highlights = await resolveQueryHighlights(new Set(), {
    nodeCount: 10,
    loadedEntityKeys: () => {
      touched = true;
      return null;
    },
    ensureRankIndex: async () => {
      touched = true;
    },
    rankOfKey: () => {
      touched = true;
      return null;
    },
  });

  assert.equal(touched, false);
  assert.deepEqual([...queryHighlightRanks(highlights)], []);
});
