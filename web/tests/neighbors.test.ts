import assert from "node:assert/strict";
import { test } from "node:test";

import {
  factDirection,
  factLabel,
  factPrimaryOther,
  relationNeighbors,
  uniqueNeighbors,
} from "../src/neighbors";
import type { Fact, Mappings } from "../src/types";

const S = (id: number): number => (1 << 24) | id;
const P = (id: number): number => (2 << 24) | id;
const C = (id: number): number => (3 << 24) | id;

const mappings: Mappings = {
  fact_labels: {
    RELATES_TO: { "1": "改编", "2": "前传" },
    WORKED_ON: { "2001": "作者" },
    APPEARS_IN: { "1": "主角" },
    PERSON_REL: {},
    CHARACTER_REL: {},
  },
  subject_type: { "2": "动画" },
  platform: {},
  person_type: { "1": "个人" },
  character_role: { "1": "角色" },
};

const relates = (
  source: number,
  target: number,
  relationType = 1,
): Fact => ({
  kind: "RELATES_TO",
  ref: 1,
  multiplicity: 1,
  source,
  target,
  relationType,
  sortOrder: 0,
});

test("directional facts label the target side with a reverse arrow", () => {
  const fact = relates(S(1), S(2));
  assert.equal(factLabel(fact, S(1), mappings), "改编");
  assert.equal(factLabel(fact, S(2), mappings), "← 改编");
  assert.equal(factDirection(fact, S(1)), 1);
  assert.equal(factDirection(fact, S(2)), -1);
});

test("unknown raw codes stay visible as numbers instead of dropping", () => {
  assert.equal(
    factLabel(relates(S(1), S(2), 99), S(1), mappings),
    "关系 99",
  );
});

test("voice credits pick the most relevant chip per viewpoint", () => {
  const fact: Fact = {
    kind: "VOICE_CREDIT",
    ref: 7,
    multiplicity: 1,
    person: P(5),
    character: C(6),
    subjectContext: S(7),
    type: 0,
    hasSummary: false,
  };
  assert.equal(factPrimaryOther(fact, P(5)), C(6));
  assert.equal(factPrimaryOther(fact, C(6)), P(5));
  assert.equal(factPrimaryOther(fact, S(7)), P(5));
  assert.equal(factLabel(fact, P(5), mappings), "配音角色");
  assert.equal(factLabel(fact, C(6), mappings), "声优");
  assert.equal(factLabel(fact, S(7), mappings), "配音出演");
});

test("keeps every relationship label in the visual working set", () => {
  const self = S(1);
  const facts: Fact[] = [
    relates(self, S(2), 1),
    relates(S(2), self, 2),
    relates(self, S(3), 1),
  ];
  const rankByKey = new Map([
    [S(2), 1],
    [S(3), 3],
  ]);
  const rankOf = (key: number): number | null =>
    rankByKey.get(key) ?? null;

  const ws = relationNeighbors(facts, self, mappings, rankOf, 4);
  assert.deepEqual(ws.ranks, [1, 1, 3]);
  assert.deepEqual(ws.labels, ["改编", "← 前传", "改编"]);

  const unique = uniqueNeighbors(facts, self, mappings, rankOf, 4);
  assert.deepEqual(unique.ranks, [1, 3]);
  assert.deepEqual(unique.labels, ["改编", "改编"]);
});

test("unresolved references never reach the canvas working set", () => {
  const self = S(1);
  const facts: Fact[] = [relates(self, S(999))];
  const ws = relationNeighbors(facts, self, mappings, () => null, 4);
  assert.deepEqual(ws.ranks, []);
  assert.deepEqual(ws.labels, []);
});
