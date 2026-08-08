import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeBundle, type QueryBundle } from "../src/query/bundle";
import { QUERY_SECURITY_PROFILE } from "../src/query/security";

test("bounds the number of independently executed bundle sections", () => {
  const maximum = QUERY_SECURITY_PROFILE.document.maxBundleSections;
  const sections = Object.fromEntries(
    Array.from(
      { length: maximum + 1 },
      (_, index) => [`section-${index}`, {
        query: {
          schema: "atlas-query-document-v2" as const,
          root: "values",
          parameters: {},
          operators: {
            values: { kind: "values" as const, columns: ["value"], rows: [[index]] },
          },
        },
        answer: { shape: "table" as const, title: `结果 ${index}` },
      }],
    ),
  );
  const bundle: QueryBundle = {
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections,
  };

  assert.throws(() => normalizeBundle(bundle), /too many sections/);
});
