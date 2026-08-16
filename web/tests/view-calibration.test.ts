import assert from "node:assert/strict";
import { test } from "node:test";

import { viewCalibration } from "../src/view-calibration";

const closeTo = (actual: number, expected: number): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `${actual} should equal ${expected}`,
  );
};

test("keeps local screen-space interaction scales stable across releases", () => {
  const legacy = viewCalibration(0.28);
  const current = viewCalibration(2);

  closeTo(legacy.focusZoom, 6.2);
  for (const key of ["focusZoom", "nearbyLabelZoom", "maxZoom"] as const)
    closeTo(
      0.28 * 2 ** legacy[key],
      2 * 2 ** current[key],
    );
  closeTo(current.worldUnitsPerFocusPixel * 2 ** current.focusZoom, 1);
  assert.ok(current.nearbyLabelZoom < legacy.nearbyLabelZoom);
  assert.ok(current.maxZoom < legacy.maxZoom);
});

test("rejects invalid published center-distance calibration", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => viewCalibration(value), /center distance/i);
});
