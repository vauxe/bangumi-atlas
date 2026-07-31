import assert from "node:assert/strict";
import { test } from "node:test";

import { assertByteLength } from "../src/data-integrity";

test("rejects truncated and oversized fixed-length artifacts", () => {
  assert.doesNotThrow(() => assertByteLength("key.bin", 40, 40));
  assert.throws(
    () => assertByteLength("key.bin", 36, 40),
    /key\.bin: expected 40 bytes, received 36/,
  );
  assert.throws(
    () => assertByteLength("key.bin", 44, 40),
    /key\.bin: expected 40 bytes, received 44/,
  );
});
