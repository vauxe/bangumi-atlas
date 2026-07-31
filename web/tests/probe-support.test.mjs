import assert from "node:assert/strict";
import { test } from "node:test";

import { coverRequestType } from "../probe_support.mjs";

test("recognizes only supported Bangumi image requests", () => {
  assert.equal(
    coverRequestType(
      "https://api.bgm.tv/v0/subjects/42/image?type=small",
    ),
    "small",
  );
  assert.equal(
    coverRequestType(
      "https://api.bgm.tv/v0/persons/7/image?type=grid",
    ),
    "grid",
  );
  assert.equal(
    coverRequestType(
      "https://api.bgm.tv/v0/characters/9/image?type=medium",
    ),
    "medium",
  );
  assert.equal(
    coverRequestType("https://api.bgm.tv/v0/subjects/no/image?type=small"),
    null,
  );
  assert.equal(
    coverRequestType("https://example.com/subjects/42/image?type=small"),
    null,
  );
});
