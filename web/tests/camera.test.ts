import assert from "node:assert/strict";
import { test } from "node:test";

import { Camera, zoomWithoutRetarget } from "../src/camera";
import type { Bounds3D } from "../src/types";

Object.defineProperties(globalThis, {
  innerWidth: { configurable: true, value: 1280 },
  innerHeight: { configurable: true, value: 900 },
  window: {
    configurable: true,
    value: { matchMedia: () => ({ matches: true }) },
  },
});

const cube = (size: number): Bounds3D => [
  [-size / 2, -size / 2, -size / 2],
  [size / 2, size / 2, size / 2],
];

test("uses the bounding box to frame and restore the full graph", () => {
  const camera = new Camera(cube(100));
  const homeZoom = Math.log2(900 / 100) - 0.2;

  assert.equal(camera.viewState.zoom, homeZoom);

  camera.absorb({
    target: [0, 0, 0],
    zoom: 12,
    rotationX: 25,
    rotationOrbit: 0,
    maxZoom: 10,
  });
  assert.equal(camera.viewState.zoom, 12);
  assert.equal("maxZoom" in camera.viewState, false);

  assert.equal(camera.home().zoom, homeZoom);
});

test("keeps focus and explicit zoom independent of full-graph fit", () => {
  const smallWorld = new Camera(cube(100));
  const largeWorld = new Camera(cube(1000));

  smallWorld.absorb({
    target: [0, 0, 0],
    zoom: 1,
    rotationX: 25,
    rotationOrbit: 0,
  });
  largeWorld.absorb({
    target: [0, 0, 0],
    zoom: 1,
    rotationX: 25,
    rotationOrbit: 0,
  });

  const smallFocus = smallWorld.flyTo([1, 2, 3]).zoom;
  const largeFocus = largeWorld.flyTo([1, 2, 3]).zoom;
  assert.equal(smallFocus, 6.2);
  assert.equal(largeFocus, 6.2);

  const explicitZoom = largeWorld.flyTo([4, 5, 6], 12);
  assert.equal(explicitZoom.zoom, 12);
  assert.equal(largeWorld.viewState.zoom, 12);
});

test("centers home and leaves restored or deliberate pans free", () => {
  const bounds: Bounds3D = [
    [-311.69, -89.26, -311.69],
    [311.68, 66.96, 311.69],
  ];
  const camera = new Camera(bounds);

  assert.ok(Math.abs(camera.viewState.target[0] + 0.005) < 1e-10);
  assert.ok(Math.abs(camera.viewState.target[1] + 11.15) < 1e-10);
  assert.equal(camera.viewState.target[2], 0);

  camera.absorb({
    target: [-220.5, 68.72, 138.65],
    zoom: 11.85,
    rotationX: 49.85,
    rotationOrbit: 44.7,
  });
  assert.deepEqual(camera.viewState.target, [-220.5, 68.72, 138.65]);

  camera.absorb({
    ...camera.viewState,
    target: [-320, 120, 330],
  });
  assert.deepEqual(camera.viewState.target, [-320, 120, 330]);
});

test("expands the far plane enough to contain the bounded graph at deep zoom", () => {
  const bounds: Bounds3D = [
    [-311.69, -89.26, -311.69],
    [311.68, 66.96, 311.69],
  ];
  const camera = new Camera(bounds);
  camera.resize(900);
  camera.absorb({
    target: [-400, 228.36, 500],
    zoom: 11.85,
    rotationX: 49.85,
    rotationOrbit: 44.7,
  });

  const target = camera.viewState.target;
  assert.deepEqual(target, [-400, 228.36, 500]);
  const graphDepth =
    Math.hypot(
      Math.max(Math.abs(target[0] - bounds[0][0]), Math.abs(target[0] - bounds[1][0])),
      Math.max(Math.abs(target[1] - bounds[0][1]), Math.abs(target[1] - bounds[1][1])),
      Math.max(Math.abs(target[2] - bounds[0][2]), Math.abs(target[2] - bounds[1][2])),
    ) * 2 ** 11.85 / 900;
  const far = camera.view().props.far;
  assert.equal(typeof far, "number");
  assert.ok((far as number) > 1 + graphDepth);
});

test("blank-space wheel zoom preserves the current focus", () => {
  const state = {
    target: [12, -4, 8] as [number, number, number],
    zoom: 3,
    rotationX: 25,
    rotationOrbit: 40,
  };

  const next = zoomWithoutRetarget(state, 100);
  assert.deepEqual(next.target, state.target);
  assert.notEqual(next.target, state.target);
  assert.equal(next.rotationX, state.rotationX);
  assert.equal(next.rotationOrbit, state.rotationOrbit);
  assert.ok(next.zoom > state.zoom);
});
