import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COVER_SIZES,
  coverItems,
  coverUrl,
  drawerCover,
  chipCover,
} from "../src/covers";

test("uses a CORS-compatible resized asset for WebGL map covers", () => {
  assert.equal(
    coverUrl(0x0200_0007, COVER_SIZES.map),
    "https://api.bgm.tv/v0/persons/7/image?type=small",
  );
});

test("builds typed Bangumi cover URLs and rejects invalid entity keys", () => {
  assert.equal(
    coverUrl(0x0100_002a, "small"),
    "https://api.bgm.tv/v0/subjects/42/image?type=small",
  );
  assert.equal(
    coverUrl(0x0200_0007, "grid"),
    "https://api.bgm.tv/v0/persons/7/image?type=grid",
  );
  assert.equal(
    coverUrl(0x0300_0009, "medium"),
    "https://api.bgm.tv/v0/characters/9/image?type=medium",
  );
  assert.equal(coverUrl(0, "small"), null);
  assert.equal(coverUrl(0x0400_0001, "small"), null);
});

test("renders optional covers as decorative and self-removing", () => {
  for (const markup of [
    chipCover(0x0200_0007),
    drawerCover(0x0100_002a),
  ]) {
    assert.match(markup, /alt=""/);
    assert.match(markup, /onerror="this\.remove\(\)"/);
  }
});

test("omits invalid and duplicate map cover items", () => {
  const keys = new Uint32Array([
    0x0100_002a,
    0,
    0x0200_0007,
    0x0400_0001,
  ]);

  assert.deepEqual(coverItems([0, 1, 2, 0, 3], keys), [
    { rank: 0, key: 0x0100_002a, index: 0 },
    { rank: 2, key: 0x0200_0007, index: 2 },
  ]);
});
