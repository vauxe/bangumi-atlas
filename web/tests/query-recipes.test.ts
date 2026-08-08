import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeBundle } from "../src/query/bundle-url";
import {
  comparisonRecipe,
  decompileQueryRecipe,
  fullTextRecipe,
  pathRecipe,
} from "../src/query/recipes";

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
  assert.deepEqual(Object.keys(comparison.sections), ["all", "common", "leftOnly", "rightOnly"]);
  assert.ok(Object.values(comparison.sections.all!.query.operators)
    .some((operator) => operator.kind === "union"));
  assert.ok(Object.values(comparison.sections.common!.query.operators)
    .some((operator) => operator.kind === "intersect"));

  const path = pathRecipe("subject:1", "person:2");
  assert.equal(path.sections.paths?.answer.shape, "path-list");
  assert.ok(Object.values(path.sections.paths!.query.operators)
    .some((operator) => operator.kind === "path"));

  assert.doesNotThrow(() => encodeBundle(comparison));
  assert.doesNotThrow(() => encodeBundle(path));
});

test("recipes do not truncate result sets behind the user's back", () => {
  const fullText = fullTextRecipe("星空");
  const comparison = comparisonRecipe("subject:1", "subject:2");

  assert.equal(
    Object.values(fullText.sections).every((section) => section.query.limit === null),
    true,
  );
  assert.equal(
    Object.values(comparison.sections).every((section) => section.query.limit === null),
    true,
  );
  assert.doesNotThrow(() => pathRecipe("subject:1", "subject:2", {
    maxHops: 7,
    maxPaths: 21,
  }));
});

test("comparison recipes keep readable names beside stable references", () => {
  const comparison = comparisonRecipe("subject:1", "person:2");

  for (const section of Object.values(comparison.sections)) {
    for (const operator of Object.values(section.query.operators)) {
      if (operator.kind === "project")
        assert.deepEqual(operator.columns.map((column) => column.name), ["ref", "name"]);
      if (
        operator.kind === "union" ||
        operator.kind === "intersect" ||
        operator.kind === "except"
      )
        for (const branch of operator.branches)
          assert.deepEqual(branch.columns.map((column) => column.output), ["ref", "name"]);
    }
  }
});

test("restores every built-in recipe as the same editable meaning", () => {
  assert.deepEqual(decompileQueryRecipe(fullTextRecipe("星空")), {
    kind: "fullText",
    text: "星空",
  });
  assert.deepEqual(decompileQueryRecipe(comparisonRecipe("subject:1", "person:2")), {
    kind: "common",
    from: "subject:1",
    to: "person:2",
  });
  assert.deepEqual(decompileQueryRecipe(pathRecipe("subject:1", "person:2", {
    maxHops: 4,
    maxPaths: 5,
  })), {
    kind: "path",
    from: "subject:1",
    to: "person:2",
    maxHops: 4,
    maxPaths: 5,
  });

  const customized = pathRecipe("subject:1", "person:2");
  customized.sections.paths!.answer.title = "自定义路径";
  assert.equal(decompileQueryRecipe(customized), null);
});
