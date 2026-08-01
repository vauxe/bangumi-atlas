import assert from "node:assert/strict";
import { test } from "node:test";

import { drawerTopActions } from "../src/drawer";

test("renders the Bangumi link as an accessible top action", () => {
  const markup = drawerTopActions((1 << 24) | 42);
  const icon = markup.match(
    /<a[\s\S]*?class="[^"]*\bdrawer-external\b[^"]*"[\s\S]*?>([\s\S]*?)<\/a>/,
  )?.[1];

  assert.match(markup, /href="https:\/\/bgm\.tv\/subject\/42"/);
  assert.match(markup, /title="在 bgm\.tv 查看"/);
  assert.match(markup, /aria-label="在 bgm\.tv 查看"/);
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener"/);
  assert.match(icon ?? "", /<svg/);
  assert.doesNotMatch(icon ?? "", /在 bgm\.tv 查看|→/);
});

test("omits the external action outside node details", () => {
  assert.doesNotMatch(drawerTopActions(), /drawer-external|bgm\.tv/);
});
