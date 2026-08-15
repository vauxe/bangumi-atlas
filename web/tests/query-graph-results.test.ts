import assert from "node:assert/strict";
import { test } from "node:test";

import { queryGraphEntityKey } from "../src/query/graph-results";

test("maps structural result refs to their stable graph keys", () => {
  assert.equal(queryGraphEntityKey("subject:7"), (1 << 24) | 7);
  assert.equal(queryGraphEntityKey("person:8"), (2 << 24) | 8);
  assert.equal(queryGraphEntityKey("character:9"), (3 << 24) | 9);
  assert.equal(queryGraphEntityKey("person:99999999"), null);
});
