import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Data, requireLongTextValue } from "../src/data";
import type { Manifest, Names } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("returns an absent long text without loading the text index", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error("unexpected request");
  }) as typeof fetch;
  const names: Names = {
    get: () => null,
    row: () => null,
    load: async () => undefined,
  };
  const data = new Data({} as Manifest, names);

  const result = await data.longText({
    kind: "entity-summary",
    entity: (1 << 24) | 42,
    present: false,
  });

  assert.deepEqual(result, { kind: "empty" });
  assert.equal(requests, 0);
});

test("does not disguise a missing published text as a source empty value", () => {
  assert.throws(
    () => requireLongTextValue("entity-summary", undefined),
    /存在位为真.*侧车缺失/,
  );
  assert.deepEqual(requireLongTextValue("entity-summary", "完整文本"), {
    kind: "present",
    text: "完整文本",
  });
});
