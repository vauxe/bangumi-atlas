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

test("clamps absorbed and flight views to a useful zoom range", () => {
  const camera = new Camera(100);
  const maxZoom = camera.fitZoom + 7;

  camera.absorb({
    target: [0, 0, 0],
    zoom: maxZoom + 20,
    rotationX: 25,
    rotationOrbit: 0,
  });

  assert.equal(camera.viewState.zoom, maxZoom);
  assert.equal(camera.viewState.maxZoom, maxZoom);

  const flight = camera.flyTo([1, 2, 3], maxZoom + 20);
  assert.equal(flight.zoom, maxZoom);
  assert.equal(camera.viewState.zoom, maxZoom);
});
