import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkingLabels,
  declutter,
  workingLabelLayers,
} from "../src/labels";
import type { WorkingEdge, WorkingMember } from "../src/labels";

const members: WorkingMember[] = [
  { rank: 0, pos: [0, 0, 0] },
  { rank: 7, pos: [10, 0, 0] },
];
const edges: WorkingEdge[] = [
  { a: [0, 0, 0], b: [10, 0, 0], label: "← 前传" },
  { a: [0, 0, 0], b: [0, 10, 0], label: "" }, // 对比扇:无标签
];
// 世界 xy 直接当屏幕像素用的平面投影
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
  // 只有带文案的边出关系名,位置在边中点
  assert.equal(data.edges.length, 1);
  assert.deepEqual(data.edges[0]?.position, [5, 0, 0]);
  assert.equal(data.edges[0]?.text, "← 前传");
  // 字符集覆盖两类名字与方向箭头
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
  // 相距足够远则共存
  const spread = [
    { position: [0, 0, 0] as [number, number, number], text: "甲", priority: 10 },
    { position: [200, 0, 0] as [number, number, number], text: "乙", priority: 10 },
  ];
  assert.equal(declutter(spread, flat, 12, []).length, 2);
});

test("styles node names and edge names as distinct layers", () => {
  const spread: WorkingMember[] = [
    { rank: 0, pos: [0, 0, 0] },
    { rank: 7, pos: [400, 0, 0] },
  ];
  const spreadEdges: WorkingEdge[] = [
    { a: [0, 0, 0], b: [400, 300, 0], label: "← 前传" },
  ];
  const { layers, missing } = workingLabelLayers(
    spread,
    spreadEdges,
    () => "名",
    flat,
    5,
  );
  assert.deepEqual(missing, []);
  const byId = new Map(
    (layers as { id: string; props: Record<string, unknown> }[]).map(
      (l) => [l.id, l.props],
    ),
  );
  const nodesLayer = byId.get("ws-node-names");
  const edgesLayer = byId.get("ws-edge-names");
  assert.ok(nodesLayer && edgesLayer);
  // 字号与颜色区分两类名字
  assert.ok((nodesLayer.getSize as number) > (edgesLayer.getSize as number));
  assert.notDeepEqual(nodesLayer.getColor, edgesLayer.getColor);
});
