import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeViewUrl, encodeViewUrl } from "../src/view-url";

const view = {
  target: [1, 2, 3] as [number, number, number],
  zoom: 4,
  rotationX: 25,
  rotationOrbit: 30,
};

test("round-trips view state with an opaque query payload", () => {
  const encoded = encodeViewUrl(view, 0x0100_002a, 123, true, "query-_42");

  assert.deepEqual(decodeViewUrl(encoded), {
    view,
    key: 0x0100_002a,
    rank: 123,
    ortho: true,
    query: "query-_42",
  });
});

test("parses view state without interpreting query documents", () => {
  assert.deepEqual(decodeViewUrl("#qb=not-a-query&n=0&r=-1&o=0"), {
    view: null,
    key: null,
    rank: null,
    ortho: false,
    query: "not-a-query",
  });
});
