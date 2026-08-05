import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Camera,
  WheelAnchorLatch,
  cruiseTarget,
  wheelDeltaToZoom,
  zoomTowardAnchor,
  zoomWithoutRetarget,
} from "../src/camera";
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
  const largerWorld = new Camera(cube(1000));
  const homeZoom = camera.viewState.zoom;

  assert.ok(homeZoom > largerWorld.viewState.zoom);

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
  assert.equal(smallFocus, largeFocus);
  assert.ok(smallFocus > 1);

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

test("wheel curve is symmetric and capped at one level per event", () => {
  const dz = wheelDeltaToZoom(100);
  assert.ok(dz > 0 && dz < 1);
  assert.equal(wheelDeltaToZoom(-100), -dz);
  assert.ok(wheelDeltaToZoom(1e9) <= 1);
});

test("anchored zoom-in converges the pivot onto the anchor", () => {
  const state = {
    target: [12, -4, 8] as [number, number, number],
    zoom: 3,
    rotationX: 25,
    rotationOrbit: 40,
  };
  const anchor: [number, number, number] = [40, 10, -6];
  const dz = 0.5;

  const next = zoomTowardAnchor(state, anchor, dz);
  assert.equal(next.zoom, state.zoom + dz);
  assert.equal(next.rotationX, state.rotationX);
  assert.equal(next.rotationOrbit, state.rotationOrbit);
  // 像素钉住不变量:2^zoom·(anchor−target) 缩放前后一致
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(
        2 ** next.zoom * ((anchor[i] ?? 0) - (next.target[i] ?? 0)) -
          2 ** state.zoom * ((anchor[i] ?? 0) - (state.target[i] ?? 0)),
      ) < 1e-9,
    );
  }
  // 反复放大后枢轴指数收敛到锚点:深缩放不再停滞
  let s = state;
  for (let i = 0; i < 40; i++) s = zoomTowardAnchor(s, anchor, dz);
  const dist = Math.hypot(
    s.target[0] - anchor[0],
    s.target[1] - anchor[1],
    s.target[2] - anchor[2],
  );
  assert.ok(dist < 1e-4);
});

test("a wheel gesture latches one anchor for smooth convergence", () => {
  const latch = new WheelAnchorLatch();
  let lookups = 0;
  const lookup =
    (a: [number, number, number] | null) => (): typeof a => {
      lookups++;
      return a;
    };

  assert.deepEqual(latch.resolve(1000, 100, 100, lookup([1, 2, 3])), [1, 2, 3]);
  // 同手势(≤400ms、≤24px):沿用首个锚点,不重新解析
  assert.deepEqual(latch.resolve(1200, 110, 95, lookup([9, 9, 9])), [1, 2, 3]);
  assert.equal(lookups, 1);
  assert.deepEqual(latch.resolve(1700, 110, 95, lookup([9, 9, 9])), [9, 9, 9]);
  assert.deepEqual(latch.resolve(1800, 200, 95, lookup([5, 5, 5])), [5, 5, 5]);
  assert.equal(lookups, 3);
});

test("a gesture that starts on the void stays un-anchored", () => {
  const latch = new WheelAnchorLatch();
  let lookups = 0;
  assert.equal(
    latch.resolve(1000, 0, 0, () => {
      lookups++;
      return null;
    }),
    null,
  );
  assert.equal(
    latch.resolve(1100, 0, 0, () => {
      lookups++;
      return [1, 1, 1];
    }),
    null,
  );
  assert.equal(lookups, 1);
});

test("cruise keeps advancing: toward the anchor, through it, then straight", () => {
  const forward: [number, number, number] = [0, 0, 1];
  // 锚点在前方:朝锚点飞,步长恒定,可越过锚点
  let t = cruiseTarget([0, 0, 0], [0, 0, 4], forward, 3);
  assert.deepEqual(t, [0, 0, 3]);
  t = cruiseTarget(t, [0, 0, 4], forward, 3);
  assert.deepEqual(t, [0, 0, 6]);
  // 锚点已在身后:沿视线直进,不回头
  t = cruiseTarget(t, [0, 0, 4], forward, 3);
  assert.deepEqual(t, [0, 0, 9]);
  // 无锚点:沿视线直进
  assert.deepEqual(cruiseTarget([1, 2, 3], null, forward, 2), [1, 2, 5]);
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
