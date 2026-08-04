import assert from "node:assert/strict";
import { test } from "node:test";

import { findCommon, findPath } from "../src/graph";
import type { Data } from "../src/data";
import type { Fact, Geometry, Mappings, Page } from "../src/types";

const S = (id: number): number => (1 << 24) | id;

const mappings: Mappings = {
  fact_labels: {
    RELATES_TO: { "1": "改编", "2": "前传" },
    WORKED_ON: {},
    APPEARS_IN: {},
    PERSON_REL: {},
    CHARACTER_REL: {},
  },
  subject_type: {},
  platform: {},
  person_type: {},
  character_role: {},
};

const relates = (
  source: number,
  target: number,
  relationType = 1,
): Fact => ({
  kind: "RELATES_TO",
  ref: source ^ target,
  multiplicity: 1,
  source,
  target,
  relationType,
  sortOrder: 0,
});

/** rank i 的稳定键为 S(i+1)(测试布置)。 */
function stubData(factsByKey: Map<number, Fact[]>): Data {
  return {
    factsFor: async (key: number): Promise<Page<Fact>> => ({
      items: factsByKey.get(key) ?? [],
      total: factsByKey.get(key)?.length ?? 0,
      next: null,
    }),
    mappings: async () => mappings,
    rankOf: (key: number) => (key & 0xffffff) - 1,
  } as unknown as Data;
}

test("preserves relationship direction when the searches meet", async () => {
  const geo = {
    key: new Uint32Array([S(1), S(2), S(3), S(4)]),
  } as Geometry;
  // A=rank0, B=rank2;链 A →(改编) rank1 ←(前传) B
  const facts = new Map<number, Fact[]>([
    [S(1), [relates(S(1), S(2), 1)]],
    [S(2), [relates(S(1), S(2), 1), relates(S(3), S(2), 2)]],
    [S(3), [relates(S(3), S(2), 2)]],
    [S(4), []],
  ]);

  const path = await findPath(0, 2, geo, stubData(facts));

  assert.ok(path);
  assert.deepEqual(path.ranks, [0, 1, 2]);
  assert.deepEqual(path.labels, ["改编", "前传"]);
  // 第二跳的源关系由 B 指向中间节点:关系由后者指向前者
  assert.deepEqual(path.directions, [1, -1]);
});

test("reports common neighbors with both relationship labels", async () => {
  const geo = {
    key: new Uint32Array([S(1), S(2), S(3)]),
  } as Geometry;
  const facts = new Map<number, Fact[]>([
    [S(1), [relates(S(1), S(3), 1)]],
    [S(2), [relates(S(3), S(2), 2)]],
    [S(3), [relates(S(1), S(3), 1), relates(S(3), S(2), 2)]],
  ]);

  const { items, direct } = await findCommon(0, 1, geo, stubData(facts));

  assert.equal(direct, null);
  assert.deepEqual(items, [{ rank: 2, la: "改编", lb: "← 前传" }]);
});
