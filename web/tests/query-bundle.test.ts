import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeBundle,
  queryBundleDigest,
  type QueryBundle,
} from "../src/query/bundle";
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

test("keeps typed parameter values with the section they execute", async () => {
  const bundle: QueryBundle = {
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: {
      results: {
        query: {
          schema: "atlas-query-document-v2",
          root: "filter",
          parameters: { minimum: "number" },
          operators: {
            source: { kind: "scan", owner: "subject", binding: "item" },
            filter: {
              kind: "filter",
              input: "source",
              predicate: {
                kind: "compare",
                operator: "gte",
                left: { kind: "field", binding: "item", field: "score" },
                right: { kind: "parameter", name: "minimum" },
              },
            },
          },
        },
        parameterValues: { minimum: 8 },
        answer: { shape: "entity-list", title: "高分作品" },
      },
    },
  };

  const normalized = normalizeBundle(bundle);
  assert.deepEqual(normalized.sections.results?.parameterValues, { minimum: 8 });
  assert.deepEqual(normalized.sections.results?.query.parameters, { minimum: "number" });
  assert.deepEqual(
    normalizeBundle(normalized),
    normalized,
    "a normalized parameterized bundle must remain valid and stable",
  );
  assert.throws(
    () => normalizeBundle({
      ...bundle,
      sections: {
        results: { ...bundle.sections.results!, parameterValues: {} },
      },
    }),
    /parameter minimum is missing/,
  );

  const changed = structuredClone(bundle);
  changed.sections.results!.parameterValues!.minimum = 9;
  assert.notEqual(
    await queryBundleDigest(bundle),
    await queryBundleDigest(changed),
  );
});
