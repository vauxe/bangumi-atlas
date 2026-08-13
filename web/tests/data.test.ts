import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  Data,
  buildVocabularyIndex,
  candidateRangesNeedWholeScan,
  contiguousPackSpan,
  entityVocabularyIds,
  entityVocabularyIdsForRows,
  requireLongTextValue,
  suggestVocabularyValues,
} from "../src/data";
import {
  canProjectSubjectQueryColumns,
  projectSubjectQueryEntity,
} from "../src/subject-query-projection";
import type { Manifest } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("derives one exact byte span from contiguous member locators", () => {
  assert.deepEqual(contiguousPackSpan([
    [1, 10, 100, 25],
    [11, 20, 125, 40],
    [21, 30, 165, 15],
  ]), [100, 80]);
  assert.equal(contiguousPackSpan([]), null);
  assert.throws(
    () => contiguousPackSpan([
      [1, 10, 100, 25],
      [11, 20, 126, 40],
    ]),
    /not contiguous/,
  );
});

test("loads only vocabulary families referenced by one entity tuple", () => {
  const subject: unknown[] = Array.from({ length: 19 }, () => null);
  subject[15] = [241, 185];
  subject[16] = [[72_834, 5], [1_617, 3]];
  assert.deepEqual(entityVocabularyIds(1, subject), {
    metaTags: [241, 185],
    tags: [72_834, 1_617],
  });

  const person = ["name", 1, [4, 7], 0, 0, 0, 0];
  assert.deepEqual(entityVocabularyIds(2, person), { career: [4, 7] });
  assert.deepEqual(entityVocabularyIds(3, ["name", 1, 0, 0, 0, 0]), {});

  assert.deepEqual(entityVocabularyIds(1, subject, new Set(["name"])), {});
  assert.deepEqual(
    entityVocabularyIds(1, subject, new Set(["tags"])),
    { tags: [72_834, 1_617] },
  );
});

test("deduplicates only referenced vocabulary ids across candidate rows", () => {
  const first: unknown[] = Array.from({ length: 19 }, () => null);
  first[15] = [241];
  first[16] = [[72_834, 5], [1_617, 3]];
  const second: unknown[] = Array.from({ length: 19 }, () => null);
  second[15] = [185];
  second[16] = [[1_617, 7], [99, 2]];

  assert.deepEqual(
    entityVocabularyIdsForRows(
      1,
      [first, second],
      new Set(["tags"]),
    ),
    { tags: [72_834, 1_617, 99] },
  );
});

test("switches dense candidate ranges to a whole scan by compressed cost", () => {
  const ranges: [number, number, number, number][] = [
    [1, 10, 100, 20],
    [11, 20, 120, 30],
    [21, 30, 150, 50],
  ];

  assert.equal(candidateRangesNeedWholeScan(ranges, [ranges[0]!]), false);
  assert.equal(candidateRangesNeedWholeScan(ranges, [ranges[2]!]), true);
  assert.equal(
    candidateRangesNeedWholeScan(ranges, [ranges[0]!, ranges[1]!]),
    true,
  );
  assert.equal(candidateRangesNeedWholeScan(ranges, []), false);
});

test("projects exact Subject query values from verified rank columns", () => {
  const requested = new Set([
    "name",
    "nameCn",
    "type",
    "year",
    "score",
    "nsfw",
  ]);
  const columns = {
    nodeCount: 2,
    year: Uint16Array.of(2024, 0),
    score: Uint8Array.of(85, 0),
    flags: Uint8Array.of((2 << 2) | 1, 6 << 2),
  };

  assert.deepEqual(
    projectSubjectQueryEntity(
      7,
      0,
      requested,
      columns,
      ["Original", "中文名", 1],
    ),
    {
      kind: "subject",
      key: (1 << 24) | 7,
      fields: {
        name: "Original",
        nameCn: "中文名",
        type: 2,
        year: 2024,
        score: 8.5,
        nsfw: true,
      },
    },
  );
  assert.deepEqual(
    projectSubjectQueryEntity(
      9,
      1,
      requested,
      columns,
      ["No metrics", null, 1],
    ).fields,
    {
      name: "No metrics",
      nameCn: "",
      type: 6,
      year: null,
      score: null,
      nsfw: false,
    },
  );
});

test("gates Subject query columns on release capability and whole scans", () => {
  const manifest = {
    query: {
      schema: "atlas-release-query-v1",
      capabilities: ["subject-query-columns-v1"],
      contractDigest: "0".repeat(64),
    },
  } as Manifest;

  assert.equal(
    canProjectSubjectQueryColumns(manifest, "subject", "whole", ["score"]),
    true,
  );
  assert.equal(
    canProjectSubjectQueryColumns(manifest, "subject", "stream", ["score"]),
    false,
  );
  assert.equal(
    canProjectSubjectQueryColumns(manifest, "subject", "whole", ["rank"]),
    false,
  );
  assert.equal(
    canProjectSubjectQueryColumns(
      { ...manifest, query: undefined },
      "subject",
      "whole",
      ["score"],
    ),
    false,
  );
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
