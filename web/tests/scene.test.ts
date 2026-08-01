import assert from "node:assert/strict";
import { test } from "node:test";

import { EDGE_WIDTHS, NodeStyleExtension } from "../src/scene";

test("keeps node connections visually subordinate to nodes", () => {
  assert.ok(EDGE_WIDTHS.context <= 0.5);
  assert.ok(EDGE_WIDTHS.relation <= 1);
  assert.ok(EDGE_WIDTHS.path <= 1.5);
  assert.ok(EDGE_WIDTHS.context < EDGE_WIDTHS.relation);
  assert.ok(EDGE_WIDTHS.relation < EDGE_WIDTHS.path);
});

test("clamps the final context-node radius in screen pixels", () => {
  const shaders = new NodeStyleExtension().getShaders() as {
    inject: Record<string, string>;
  };
  const sizeFilter = shaders.inject["vs:DECKGL_FILTER_SIZE"] ?? "";
  assert.match(
    sizeFilter,
    /float radius = abs\(size\.x\) -/,
  );
  assert.match(
    sizeFilter,
    /float screenRadius = radius \* project\.focalDistance \/ gl_Position\.w;/,
  );
  assert.match(
    sizeFilter,
    /clamp\(screenRadius, scatterplot\.radiusMinPixels,\s*scatterplot\.radiusMaxPixels\) \/ screenRadius/,
  );
  assert.doesNotMatch(sizeFilter, /outerRadiusPixels/);
});
