import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeDisplayText, html } from "../src/html";

test("decodes supported HTML character references only at the display boundary", () => {
  assert.equal(
    decodeDisplayText(
      "キャラ&amp;ストーリー &#12539; &ldquo;测试&rdquo; &hellip; &Eacute;",
    ),
    "キャラ&ストーリー ・ “测试” … É",
  );
  assert.equal(decodeDisplayText("&#39; &#x1f49a; &nbsp;"), "' 💚 \u00a0");
  assert.equal(
    decodeDisplayText("Chapter 1 &ndash; Lament of the Shadow Elves"),
    "Chapter 1 – Lament of the Shadow Elves",
  );
  assert.equal(
    decodeDisplayText("&amp;quot;双重编码&amp;quot;"),
    '"双重编码"',
  );
  assert.equal(
    decodeDisplayText("来源原文 &Bass; &hl; &br;"),
    "来源原文 &Bass; &hl; &br;",
  );
  assert.equal(
    decodeDisplayText("&constructor; &toString;"),
    "&constructor; &toString;",
  );
});

test("stops after the configured display projection depth", () => {
  assert.equal(
    decodeDisplayText("&amp;amp;amp;lt;"),
    "&lt;",
  );
});

test("decoded display text is still escaped before entering markup", () => {
  const value = decodeDisplayText(
    "正常&amp;文本 &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;",
  );
  const markup = html`<p>${value}</p>`;

  assert.equal(
    markup,
    "<p>正常&amp;文本 &lt;script&gt;alert(1)&lt;/script&gt;</p>",
  );
  assert.doesNotMatch(markup, /<script>/);
});
