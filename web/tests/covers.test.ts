import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COVER_SIZES,
  coverItems,
  coverUrl,
  drawerCover,
  chipCover,
} from "../src/covers";

test("uses right-sized cover assets for each UI context", () => {
  assert.deepEqual(COVER_SIZES, {
    map: "grid",
    chip: "grid",
    drawer: "small",
  });
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

test("renders covers with a stable type-dot fallback", () => {
  const chip = chipCover(0x0200_0007);
  assert.match(chip, /class="chip-media type-2"/);
  assert.match(chip, /class="chip-mark type-2"/);
  assert.match(chip, /class="chip-av"/);
  assert.match(chip, /onerror="this\.remove\(\)"/);

  const drawer = drawerCover(0x0100_002a);
  assert.match(drawer, /class="cover"/);
  assert.match(drawer, /type=small/);
  assert.match(drawer, /alt=""/);
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
