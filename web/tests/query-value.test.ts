import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MISSING,
  andTruth,
  compareValues,
  isMissing,
  isNull,
  notTruth,
  orTruth,
  type CompareOperator,
} from "../src/query/value";

test("keeps missing and explicit null as different query values", () => {
  assert.equal(isMissing(MISSING), true);
  assert.equal(isMissing(null), false);
  assert.equal(isNull(null), true);
  assert.equal(isNull(MISSING), false);
});

test("uses Kleene three-valued logic for nullable predicates", () => {
  assert.equal(compareValues("eq", null, null), null);
  assert.equal(compareValues("eq", MISSING, 1), null);
  assert.equal(compareValues("eq", "1", 1), false);
  assert.equal(compareValues("gt", 2, 1), true);
  assert.equal(compareValues("contains", "Bangumi Atlas", "Atlas"), true);

  assert.equal(andTruth(false, null), false);
  assert.equal(andTruth(true, null), null);
  assert.equal(orTruth(true, null), true);
  assert.equal(orTruth(false, null), null);
  assert.equal(notTruth(null), null);
});

test("executes every comparison operator with an explicit expected result", () => {
  const cases: [
    operator: CompareOperator,
    left: Parameters<typeof compareValues>[1],
    right: Parameters<typeof compareValues>[2],
    expected: boolean,
  ][] = [
    ["eq", "atlas", "atlas", true],
    ["ne", "atlas", "bangumi", true],
    ["lt", 1, 2, true],
    ["lte", 2, 2, true],
    ["gt", 2, 1, true],
    ["gte", 2, 2, true],
    ["contains", "Bangumi Atlas", "Atlas", true],
    ["contains", ["anime", "book"], "book", true],
  ];

  for (const [operator, left, right, expected] of cases)
    assert.equal(compareValues(operator, left, right), expected, operator);
});

test("rejects non-finite numbers at the query value boundary", () => {
  assert.throws(() => compareValues("eq", Number.NaN, 1), /finite/);
  assert.throws(() => compareValues("lt", 1, Number.POSITIVE_INFINITY), /finite/);
});
