import assert from "node:assert/strict";
import { test } from "node:test";

import { assertByteLength, sha256Hex } from "../src/data-integrity";

test("rejects truncated and oversized fixed-length artifacts", () => {
  assert.doesNotThrow(() => assertByteLength("key.bin", 40, 40));
  assert.throws(
    () => assertByteLength("key.bin", 36, 40),
    /key\.bin/,
  );
  assert.throws(
    () => assertByteLength("key.bin", 44, 40),
    /key\.bin/,
  );
});

test("hashes text as the same UTF-8 bytes used by published artifacts", async () => {
  assert.equal(
    await sha256Hex("星图"),
    await sha256Hex(new TextEncoder().encode("星图")),
  );
});
