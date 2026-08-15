import assert from "node:assert/strict";
import { test } from "node:test";

import type { Mappings } from "../src/types";
import {
  ambiguousNameSuggestionRanks,
  projectedEntitySuggestionContext,
} from "../src/value-labels";

const mappings: Mappings = {
  fact_labels: {},
  subject_type: { "2": "动画" },
  platform: { "2:1001": "TV" },
  person_type: { "1": "个人" },
  character_role: { "1": "主角" },
  episode_type: {},
};

test("asks for extra context only when visible names collide within one entity kind", () => {
  const items = [
    { rank: 1, display: "新世纪福音战士", entityKind: 1 as const },
    { rank: 2, display: " 新世纪福音战士 ", entityKind: 1 as const },
    { rank: 3, display: "新世纪福音战士", entityKind: 2 as const },
    { rank: 4, display: "EVA", entityKind: 1 as const },
  ];

  assert.deepEqual([...ambiguousNameSuggestionRanks(items)], [1, 2]);
});

test("builds the same disambiguation labels from minimal entity projections", () => {
  assert.equal(projectedEntitySuggestionContext({
    kind: "subject",
    key: 1 << 24,
    fields: { type: 2, platformCode: 1001, date: "1995-10-04" },
  }, mappings), "动画 · TV · 1995");
  assert.equal(projectedEntitySuggestionContext({
    kind: "person",
    key: 2 << 24,
    fields: { type: 1, career: ["actor", "seiyu", "writer"] },
  }, mappings), "个人 · 演员 · 声优");
  assert.equal(projectedEntitySuggestionContext({
    kind: "character",
    key: 3 << 24,
    fields: { role: 1 },
  }, mappings), "主角");
});
