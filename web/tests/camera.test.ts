import assert from "node:assert/strict";
import { test } from "node:test";

import { Camera } from "../src/camera";

Object.defineProperties(globalThis, {
  innerWidth: { configurable: true, value: 1280 },
  innerHeight: { configurable: true, value: 900 },
  window: {
    configurable: true,
    value: { matchMedia: () => ({ matches: true }) },
  },
});

test("uses fit zoom to frame and restore the full graph", () => {
  const camera = new Camera(100);
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
  const smallWorld = new Camera(100);
  const largeWorld = new Camera(1000);

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
