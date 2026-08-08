import assert from "node:assert/strict";
import { test } from "node:test";

import { inferCypherParameters } from "../src/query/parameters";

test("infers safe query parameter types from a flat JSON object", () => {
  assert.deepEqual(
    inferCypherParameters(
      '{"minimum":8.5,"owner":"subject:12","fact":"fact:7","exact":true}',
    ),
    {
      types: {
        minimum: "number",
        owner: "entity:subject",
        fact: "fact-ref",
        exact: "boolean",
      },
      values: { minimum: 8.5, owner: "subject:12", fact: "fact:7", exact: true },
    },
  );
});

test("rejects structured, null, non-finite, and invalid-name parameters", () => {
  assert.throws(() => inferCypherParameters("[]"), /JSON 对象/);
  assert.throws(() => inferCypherParameters('{"value":null}'), /只接受/);
  assert.throws(() => inferCypherParameters('{"bad-name":1}'), /参数名/);
});
