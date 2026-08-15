import assert from "node:assert/strict";
import { test } from "node:test";

import { mergePreparedNameSuggestions } from "../src/query/runtime";

test("keeps provider-projected name suggestion text unchanged", () => {
  const projected = "&lt;";
  const projectedAlias = "别名 &lt;";
  const suggestions = mergePreparedNameSuggestions(
    [{
      normalized: "别名 &lt;",
      matched: projectedAlias,
      display: projected,
      rank: 7,
      entityKind: 1,
      match: "exact",
    }],
    [{
      ref: "episode:9",
      owner: "episode",
      label: projected,
      detail: `分集 · ${projected}`,
      match: projected,
    }],
    new Map(),
  );

  assert.equal(suggestions[0]?.label, projected);
  assert.equal(suggestions[0]?.match, projectedAlias);
  assert.equal(suggestions[1]?.label, projected);
  assert.equal(suggestions[1]?.detail, `分集 · ${projected}`);
  assert.equal(suggestions[1]?.match, projected);
});
