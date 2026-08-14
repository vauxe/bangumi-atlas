import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allRelationFacts,
  factDirection,
  factLabel,
  factPrimaryOther,
  relationNeighbors,
  relationNeighborKeys,
  resolveLoadedNeighborRanks,
  uniqueNeighbors,
} from "../src/neighbors";
import type { Fact, Mappings, Page } from "../src/types";

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
  episode_type: { "0": "本篇" },
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

test("reads every fact page before exposing the complete relation set", async () => {
  const key = S(1);
  const pages = new Map<string | undefined, Page<Fact>>([
    [undefined, {
      items: [relates(key, S(2)), relates(key, S(3))],
      total: 5,
      next: "0",
    }],
    ["0", {
      items: [relates(key, S(4)), relates(key, S(5))],
      total: 5,
      next: "1",
    }],
    ["1", { items: [relates(key, S(6))], total: 5, next: null }],
  ]);
  const cursors: Array<string | undefined> = [];
  const facts = await allRelationFacts({
    factsFor: async (_key, cursor) => {
      cursors.push(cursor);
      const page = pages.get(cursor);
      if (!page) throw new Error(`unexpected cursor ${cursor}`);
      return page;
    },
  }, key);

  assert.deepEqual(cursors, [undefined, "0", "1"]);
  assert.deepEqual(facts.map(({ ref }) => ref), [1, 1, 1, 1, 1]);
  assert.deepEqual(
    facts.map((fact) => fact.kind === "RELATES_TO" && fact.target),
    [S(2), S(3), S(4), S(5), S(6)],
  );
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
    "未知关系（99）",
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

test("keeps every relationship edge when no explicit cap is requested", () => {
  const self = S(1);
  const facts = Array.from({ length: 75 }, (_, index) =>
    relates(self, S(index + 2))
  );
  const rankOf = (key: number): number | null =>
    key === self ? 0 : (key & 0xffffff) - 1;

  const ws = relationNeighbors(facts, self, mappings, rankOf);

  assert.equal(ws.ranks.length, 75);
  assert.equal(ws.labels.length, 75);
  assert.deepEqual(ws.ranks.slice(0, 3), [1, 2, 3]);
  assert.deepEqual(ws.ranks.slice(-3), [73, 74, 75]);
});

test("collects each non-self relationship participant once", () => {
  const self = S(1);
  const subject = S(2);
  const person = P(3);
  const character = C(4);
  const facts: Fact[] = [
    relates(self, subject),
    relates(subject, self),
    {
      kind: "VOICE_CREDIT",
      ref: 3,
      multiplicity: 1,
      person,
      character,
      subjectContext: self,
      type: 0,
      hasSummary: false,
    },
  ];

  assert.deepEqual(relationNeighborKeys(facts, self), [
    subject,
    person,
    character,
  ]);
});

test("unresolved references never reach the canvas working set", () => {
  const self = S(1);
  const facts: Fact[] = [relates(self, S(999))];
  const ws = relationNeighbors(facts, self, mappings, () => null, 4);
  assert.deepEqual(ws.ranks, []);
  assert.deepEqual(ws.labels, []);
});

test("resolves every cold neighbor with one loaded-key pass", () => {
  const self = S(1);
  const known = S(2);
  const coldA = P(3);
  const coldB = C(4);
  const facts: Fact[] = [
    relates(self, known),
    relates(self, coldA),
    relates(self, coldB),
    relates(coldA, self),
  ];
  const keys = Uint32Array.of(self, C(99), coldB, coldA, S(88), S(77));
  let knownLookups = 0;

  const ranks = resolveLoadedNeighborRanks(
    facts,
    self,
    keys,
    5,
    (key) => {
      knownLookups++;
      return key === known ? 42 : null;
    },
  );

  assert.deepEqual([...ranks], [[known, 42], [coldB, 2], [coldA, 3]]);
  assert.equal(knownLookups, 3, "each distinct neighbor is probed once");
});

test("bounds temporary neighbor lookup memory for sparse archive ids", () => {
  const self = S(1);
  const far = S(0xffffff);
  const ranks = resolveLoadedNeighborRanks(
    [relates(self, far)],
    self,
    Uint32Array.of(far),
    1,
    () => null,
  );
  assert.equal(ranks.get(far), 0);
});
