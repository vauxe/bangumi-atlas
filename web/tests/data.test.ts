import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  Data,
  buildVocabularyIndex,
  requireLongTextValue,
  suggestVocabularyValues,
} from "../src/data";

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
  const data = new Data();

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

test("ranks tag suggestions by exact, prefix, then substring match", () => {
  const index = buildVocabularyIndex([
    "作品 ABC",
    "ABC 剧场版",
    "ＡＢＣ",
    "abc 原声",
    "无关标签",
  ]);

  assert.deepEqual(suggestVocabularyValues(index, "abc"), [
    "ＡＢＣ",
    "abc 原声",
    "ABC 剧场版",
    "作品 ABC",
  ]);
  assert.deepEqual(suggestVocabularyValues(index, ""), []);
});

test("returns every matching vocabulary value instead of a hidden top-N", () => {
  const values = Array.from({ length: 37 }, (_, index) => `动画 ${index + 1}`);
  const index = buildVocabularyIndex(["无关", ...values]);

  assert.deepEqual(suggestVocabularyValues(index, "动画"), values);
});

test("prefers concise matches when the vocabulary has no popularity data", () => {
  const index = buildVocabularyIndex([
    "科学ADV系列最完成作",
    "科幻",
    "某个科幻作品",
    "科学",
    "科",
  ]);

  assert.deepEqual(suggestVocabularyValues(index, "科"), [
    "科",
    "科幻",
    "科学",
    "科学ADV系列最完成作",
    "某个科幻作品",
  ]);
});

test("rejects an already cancelled tag suggestion before loading vocabulary", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error("unexpected request");
  }) as typeof fetch;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    new Data().suggestTagValues("tags", "动画", {
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(requests, 0);
});
