import assert from "node:assert/strict";
import { test } from "node:test";

import { queryResultGraphRanks } from "../src/query/graph-results";

test("maps visible entity refs to unique graph ranks", async () => {
  const subjectKey = (1 << 24) | 7;
  const characterKey = (3 << 24) | 3;
  const ranks = await queryResultGraphRanks([
    "subject:7",
    "episode:9",
    "subject:7",
    "person:99999999",
    "character:3",
  ], {
    episodeSubjectKey: async (id) => id === 9 ? subjectKey : null,
    rankOfKey: (key) => key === subjectKey ? 4 : key === characterKey ? 8 : null,
  });

  assert.deepEqual(ranks, [4, 8]);
});
