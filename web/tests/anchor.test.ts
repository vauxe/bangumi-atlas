import assert from "node:assert/strict";
import { test } from "node:test";

import { OrbitViewport } from "@deck.gl/core";

import { cursorRay, nearestAlongRay } from "../src/anchor";
import { zoomTowardAnchor } from "../src/camera";

const ORIGIN: [number, number, number] = [0, 0, 0];
const FORWARD: [number, number, number] = [0, 0, 1];

const pack = (...nodes: [number, number, number][]): Float32Array =>
  Float32Array.from(nodes.flat());

test("picks the node with the smallest angle, not the nearest one", () => {
  // A 距离远但几乎正对射线,B 更近却偏出 26°
  const positions = pack([2, 0, 4], [0.5, 0, 10]);
  const rank = nearestAlongRay(positions, 2, ORIGIN, FORWARD, 0.6);
  assert.equal(rank, 1);
});

test("ignores nodes behind the camera and beyond the cutoff cone", () => {
  const positions = pack([0, 0, -5], [8, 0, 4]);
  assert.equal(nearestAlongRay(positions, 2, ORIGIN, FORWARD, 0.1), -1);
});

test("skips rejected candidates and falls back to the next best", () => {
  const positions = pack([0.1, 0, 10], [1, 0, 10]);
  const rank = nearestAlongRay(
    positions,
    2,
    ORIGIN,
    FORWARD,
    0.6,
    (r) => r !== 0,
  );
  assert.equal(rank, 1);
});

test("only scans the streamed prefix of the geometry", () => {
  const positions = pack([1, 0, 10], [0, 0, 10]);
  assert.equal(nearestAlongRay(positions, 1, ORIGIN, FORWARD, 0.6), 0);
});

const VIEW = {
  width: 1280,
  height: 900,
  orbitAxis: "Y" as const,
  fovy: 50,
};

test("cursorRay hits the node under its own projected pixel", () => {
  const viewport = new OrbitViewport({
    ...VIEW,
    target: [12, -4, 8],
    rotationX: 25,
    rotationOrbit: 40,
    zoom: 3,
  });
  const node: [number, number, number] = [10, -5, 20];
  const [px, py] = viewport.project(node) as [number, number];
  const ray = cursorRay(viewport, px, py);
  assert.ok(ray);
  const positions = pack([12, -4, 8], [40, 10, -6], node, [9, -5, 21]);
  const rank = nearestAlongRay(positions, 4, ray.origin, ray.dir, 0.05);
  assert.equal(rank, 2);
});

test("zoomTowardAnchor keeps the anchor pinned to its screen pixel", () => {
  const state = {
    target: [12, -4, 8] as [number, number, number],
    zoom: 3,
    rotationX: 25,
    rotationOrbit: 40,
  };
  const anchor: [number, number, number] = [30, 5, -14];
  const before = new OrbitViewport({ ...VIEW, ...state }).project(anchor);
  const next = zoomTowardAnchor(state, anchor, 0.7);
  const after = new OrbitViewport({ ...VIEW, ...next }).project(anchor);
  assert.ok(Math.abs((before[0] ?? 0) - (after[0] ?? 0)) < 1e-6);
  assert.ok(Math.abs((before[1] ?? 0) - (after[1] ?? 0)) < 1e-6);
});
