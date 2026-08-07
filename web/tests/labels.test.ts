import assert from "node:assert/strict";
import { test } from "node:test";

import { OrbitViewport } from "@deck.gl/core";

import {
  buildWorkingLabels,
  declutter,
  perspectiveTextSize,
  workingLabelLayers,
} from "../src/labels";
import type { WorkingEdge, WorkingMember } from "../src/labels";

const members: WorkingMember[] = [
  { rank: 0, pos: [0, 0, 0] },
  { rank: 7, pos: [10, 0, 0] },
];
const edges: WorkingEdge[] = [
  { a: [0, 0, 0], b: [10, 0, 0], label: "← 前传" },
  { a: [0, 0, 0], b: [0, 10, 0], label: "" },
];
const flat = (p: [number, number, number]): [number, number] => [p[0], p[1]];

test("assembles node names, edge names at midpoints, and the charset", () => {
  const data = buildWorkingLabels(members, edges, (rank) =>
    rank === 0 ? "命运石之门" : "命运石之门 0",
  );
  assert.deepEqual(
    data.nodes.map((n) => n.text),
    ["命运石之门", "命运石之门 0"],
  );
  assert.deepEqual(data.missing, []);
  assert.equal(data.edges.length, 1);
  assert.deepEqual(data.edges[0]?.position, [5, 0, 0]);
  assert.equal(data.edges[0]?.text, "← 前传");
  for (const ch of "命运石之门前传←") assert.ok(data.charset.includes(ch));
});

test("collects missing names for batched loading", () => {
  const data = buildWorkingLabels(members, edges, (rank) =>
    rank === 0 ? "命运石之门" : null,
  );
  assert.deepEqual(data.missing, [7]);
  assert.equal(data.nodes.length, 1);
});

test("declutters by priority: the selected node's name always wins", () => {
  const crowded = [
    { position: [0, 0, 0] as [number, number, number], text: "邻居", priority: 10 },
    { position: [2, 0, 0] as [number, number, number], text: "选中", priority: 100 },
  ];
  const kept = declutter(crowded, flat, 12, []);
  assert.deepEqual(
    kept.map((k) => k.text),
    ["选中"],
  );
  const spread = [
    { position: [0, 0, 0] as [number, number, number], text: "甲", priority: 10 },
    { position: [200, 0, 0] as [number, number, number], text: "乙", priority: 10 },
  ];
  assert.equal(declutter(spread, flat, 12, []).length, 2);
});

test("keeps label screen size when another zoom anchor pushes it deeper", () => {
  // 该投影令 clip.w = z + 1；TextLayer 的像素偏移随后会除以 w。
  const viewport = {
    focalDistance: 1,
    viewProjectionMatrix: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 1,
      0, 0, 0, 1,
    ],
  };
  const apparentPixels = (z: number): number => {
    const requested = perspectiveTextSize([0, 0, z], 14, viewport);
    return (requested * viewport.focalDistance) / (z + 1);
  };

  assert.equal(apparentPixels(0), 14);
  assert.equal(apparentPixels(3), 14);
});

test("keeps the arrow direction when its source crosses the camera plane", () => {
  const selected: [number, number, number] = [
    -152.39727783203125, -22.80242347717285, -34.800899505615234,
  ];
  const source: [number, number, number] = [
    78.30078887939453, 20.102764129638672, 87.0003433227539,
  ];
  const angleAt = (
    target: [number, number, number],
    zoom: number,
  ): number => {
    const viewport = new OrbitViewport({
      width: 1200,
      height: 713,
      orbitAxis: "Y",
      fovy: 50,
      target,
      zoom,
      rotationX: 30.95,
      rotationOrbit: -99.53,
    });
    const { layers } = workingLabelLayers(
      [],
      [{ a: selected, b: source, label: "← 片尾曲" }],
      () => null,
      (position) => viewport.project(position) as [number, number],
      viewport,
      zoom,
    );
    const arrow = layers.find(
      (layer) => (layer as { id?: string }).id === "ws-edge-arrows",
    ) as { props: { data: { angle: number }[] } } | undefined;
    assert.ok(arrow);
    return arrow.props.data[0]?.angle ?? NaN;
  };
  const far = angleAt([-44.93, -5.44, 14.63], 2.66);
  const near = angleAt([26.02, 34.87, 5.28], 5.27);
  const difference = Math.abs((((near - far + 180) % 360) + 360) % 360 - 180);

  assert.ok(difference < 2, `${far}° → ${near}°`);
});
