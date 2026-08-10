import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  CharacterEntity,
  Mappings,
  PersonEntity,
  SubjectEntity,
} from "../src/types";
import {
  ambiguousNameSuggestionRanks,
  entitySuggestionContext,
} from "../src/value-labels";

const mappings: Mappings = {
  fact_labels: {},
  subject_type: { "2": "动画" },
  platform: { "2:1001": "TV" },
  person_type: { "1": "个人" },
  character_role: { "1": "主角" },
  episode_type: {},
};

test("describes ambiguous works with type, platform, and year", () => {
  const entity = {
    kind: "subject",
    type: 2,
    platformCode: 1001,
    date: "1995-10-04",
  } as SubjectEntity;

  assert.equal(
    entitySuggestionContext(entity, mappings),
    "动画 · TV · 1995",
  );
});

test("describes ambiguous people and characters with readable domain values", () => {
  const person = {
    kind: "person",
    type: 1,
    career: ["actor", "seiyu", "writer"],
  } as PersonEntity;
  const character = { kind: "character", role: 1 } as CharacterEntity;

  assert.equal(
    entitySuggestionContext(person, mappings),
    "个人 · 演员 · 声优",
  );
  assert.equal(entitySuggestionContext(character, mappings), "主角");
});

test("omits unavailable or technical fallback values from suggestion context", () => {
  const person = {
    kind: "person",
    type: 99,
    career: ["unmapped-career"],
  } as PersonEntity;

  assert.equal(entitySuggestionContext(person, mappings), "");
});

test("asks for extra context only when visible names collide within one entity kind", () => {
  const items = [
    { rank: 1, display: "新世纪福音战士", entityKind: 1 as const },
    { rank: 2, display: " 新世纪福音战士 ", entityKind: 1 as const },
    { rank: 3, display: "新世纪福音战士", entityKind: 2 as const },
    { rank: 4, display: "EVA", entityKind: 1 as const },
  ];

  assert.deepEqual([...ambiguousNameSuggestionRanks(items)], [1, 2]);
});
