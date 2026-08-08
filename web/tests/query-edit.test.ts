import assert from "node:assert/strict";
import { test } from "node:test";

import {
  conditionEditValue,
  createEntityCondition,
  createFactCondition,
  createStatisticCondition,
} from "../src/query/edit";

test("creates every visible entity-condition family from one edit session", () => {
  assert.deepEqual(createEntityCondition("subject", "score", "gte", "8"), {
    kind: "compare", field: "score", operator: "gte", value: 8,
  });
  assert.deepEqual(createEntityCondition("subject", "tags", "notContains", "科幻"), {
    kind: "compare", field: "tags", operator: "contains", value: "科幻", negated: true,
  });
  assert.deepEqual(createEntityCondition("subject", "type", "notIn", "1、2"), {
    kind: "in", field: "type", values: [1, 2], negated: true,
  });
  assert.deepEqual(createEntityCondition("subject", "score", "isNotNull", ""), {
    kind: "isNull", field: "score", negated: true,
  });
});

test("uses the same typed conversion for relationship attributes", () => {
  assert.deepEqual(createFactCondition("WORKED_ON", "position", "eq", "2"), {
    kind: "compare", field: "position", operator: "eq", value: 2,
  });
  assert.deepEqual(createFactCondition("PERSON_REL", "spoiler", "eq", "true"), {
    kind: "compare", field: "spoiler", operator: "eq", value: true,
  });
});

test("restores an existing leaf into editable field, operator, and text", () => {
  assert.deepEqual(conditionEditValue({
    kind: "in", field: "type", values: [1, 2], negated: true,
  }), { field: "type", operator: "notIn", raw: "1、2" });
  assert.equal(conditionEditValue({
    kind: "any",
    terms: [{ kind: "compare", field: "score", operator: "gte", value: 8 }],
  }), null);
});

test("types statistic-result conditions without exposing generated column syntax", () => {
  const aggregate = {
    groupBy: ["type"],
    metrics: [{ function: "count" as const }, { function: "avg" as const, field: "score" }],
  };
  assert.deepEqual(
    createStatisticCondition("subject", aggregate, "count", "gte", "10"),
    { kind: "compare", field: "count", operator: "gte", value: 10 },
  );
  assert.deepEqual(
    createStatisticCondition("subject", aggregate, "type", "eq", "2"),
    { kind: "compare", field: "type", operator: "eq", value: 2 },
  );
});
