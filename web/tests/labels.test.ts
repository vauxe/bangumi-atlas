import assert from "node:assert/strict";
import { test } from "node:test";

import { labelLayers } from "../src/labels";
import type { LabelCache, LabelData } from "../src/labels";
import type { Geometry } from "../src/types";

const labels: LabelData = {
  nodes: [[0, "节点"]],
  comm: { 7: ["社区", [1, 2, 3]] },
  charset: "节点社区",
};
const geometry = {
  positions: new Float32Array([1, 2, 3]),
  loaded: 1,
} as Geometry;

const idsAt = (zoom: number): string[] =>
  labelLayers(
    labels,
    geometry,
    zoom,
    () => true,
    0,
    {} as LabelCache,
  ).map((layer) => (layer as { id: string }).id);

test("uses separate zoom levels for community and node labels", () => {
  assert.deepEqual(idsAt(1), ["labels-comm"]);
  assert.deepEqual(idsAt(1.9), ["labels-nodes"]);
});
