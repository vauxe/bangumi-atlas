import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { state } from "../src/store";
import { decode, encode } from "../src/url";

const view = {
  target: [1, 2, 3] as [number, number, number],
  zoom: 4,
  rotationX: 25,
  rotationOrbit: 30,
};

beforeEach(() => {
  state.filters.yearMin = 0;
  state.filters.yearMax = 9999;
  state.filters.media = new Set();
  state.filters.scoreMin = 0;
  state.filters.tags = new Set();
});

test("round-trips stable selection and link-query identity", () => {
  const hash = encode(view, 0x0100_002a, 123, false, {
    kind: "path",
    fromKey: 0x0200_0007,
    fromRank: 9,
  });

  const decoded = decode(hash);
  assert.equal(decoded.key, 0x0100_002a);
  assert.equal(decoded.rank, 123);
  assert.deepEqual(decoded.link, {
    kind: "path",
    fromKey: 0x0200_0007,
    fromRank: 9,
  });
});

test("keeps old selection URLs compatible and ignores partial link state", () => {
  assert.equal(decode("#n=16777258&r=123").link, null);
  assert.equal(decode("#n=16777258&r=123&q=common&f=33554439").link, null);
});

test("encodes filters canonically regardless of Set insertion order", () => {
  state.filters.media = new Set([6, 1, 4]);
  state.filters.tags = new Set([9, 2, 5]);

  const hash = encode(view, null, null);

  assert.match(hash, /(?:^|&)m=1,4,6(?:&|$)/);
  assert.match(hash, /(?:^|&)t=2,5,9(?:&|$)/);
});

test("rejects malformed, reversed, and fractional filter parameters", () => {
  decode("#y=2030-2000&m=1,5,6.5&t=2,3.5,99&s=101");

  assert.equal(state.filters.yearMin, 0);
  assert.equal(state.filters.yearMax, 9999);
  assert.deepEqual([...state.filters.media], [1]);
  assert.deepEqual([...state.filters.tags], [2]);
  assert.equal(state.filters.scoreMin, 0);
});
