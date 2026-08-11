import assert from "node:assert/strict";
import { test } from "node:test";

import {
  queryGraphEntityKey,
  queryResultGraphRanks,
} from "../src/query/graph-results";

test("maps structural result refs to their stable graph keys", () => {
  assert.equal(queryGraphEntityKey("subject:7"), (1 << 24) | 7);
  assert.equal(queryGraphEntityKey("person:8"), (2 << 24) | 8);
  assert.equal(queryGraphEntityKey("character:9"), (3 << 24) | 9);
  assert.equal(queryGraphEntityKey("person:99999999"), null);
});

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
