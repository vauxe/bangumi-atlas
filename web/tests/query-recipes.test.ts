import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeBundle } from "../src/query/bundle-url";
import { comparisonRecipe, fullTextRecipe, pathRecipe } from "../src/query/recipes";

test("one full-text action covers every published long-text family", () => {
  const bundle = fullTextRecipe("星空");

  assert.deepEqual(Object.keys(bundle.sections), [
    "VOICE_CREDIT-summary",
    "character-summary",
    "episode-description",
    "person-summary",
    "subject-summary",
  ]);
  assert.equal(bundle.sections["episode-description"]?.query.operators.op0?.kind, "fullText");
  assert.equal(bundle.sections["VOICE_CREDIT-summary"]?.answer.shape, "fact-list");
});

test("context actions compile to exact set and path sections", () => {
  const comparison = comparisonRecipe("subject:1", "person:2");
  assert.deepEqual(Object.keys(comparison.sections), ["common", "leftOnly", "rightOnly"]);
  assert.ok(Object.values(comparison.sections.common!.query.operators)
    .some((operator) => operator.kind === "intersect"));

  const path = pathRecipe("subject:1", "person:2");
  assert.equal(path.sections.paths?.answer.shape, "path-list");
  assert.ok(Object.values(path.sections.paths!.query.operators)
    .some((operator) => operator.kind === "path"));

  assert.doesNotThrow(() => encodeBundle(comparison));
  assert.doesNotThrow(() => encodeBundle(path));
});
