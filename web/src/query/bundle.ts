import { canonicalJson, normalizeQuery } from "./canonical";
import type { ParameterValues, QueryDocument } from "./document";
import { QUERY_SECURITY_PROFILE, safeRecordKey } from "./security";

export type AnswerShape =
  | "entity-list"
  | "fact-list"
  | "relation-group"
  | "field-comparison"
  | "path-list"
  | "aggregate-table"
  | "table";

export interface AnswerSpec {
  shape: AnswerShape;
  title: string;
}

export interface QuerySection {
  query: QueryDocument;
  /** Typed values belong to the executable section and travel with shared URLs. */
  parameterValues?: ParameterValues;
  answer: AnswerSpec;
}

export type ReleaseSelection =
  | { policy: "latest" }
  | { policy: "fixed"; version: string };

export interface QueryBundle {
  schema: "atlas-query-bundle-v2";
  release: ReleaseSelection;
  sections: Record<string, QuerySection>;
}

const ANSWER_SHAPES = new Set<AnswerShape>([
  "entity-list",
  "fact-list",
  "relation-group",
  "field-comparison",
  "path-list",
  "aggregate-table",
  "table",
]);

export function normalizeBundle(bundle: QueryBundle): QueryBundle {
  if (bundle?.schema !== "atlas-query-bundle-v2")
    throw new TypeError("query bundle schema is unsupported");
  if (
    bundle.release?.policy !== "latest" &&
    !(
      bundle.release?.policy === "fixed" &&
      /^[0-9a-f]{64}$/.test(bundle.release.version)
    )
  )
    throw new TypeError("query bundle release selection is invalid");
  const entries = Object.entries(bundle.sections).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  if (!entries.length)
    throw new TypeError("query bundle requires at least one section");
  if (entries.length > QUERY_SECURITY_PROFILE.document.maxBundleSections)
    throw new TypeError("query bundle has too many sections");
  const sections: Record<string, QuerySection> = {};
  for (const [name, section] of entries) {
    safeRecordKey(name, "query section name");
    if (!name || !section?.answer?.title || !ANSWER_SHAPES.has(section.answer.shape))
      throw new TypeError("query bundle answer specification is invalid");
    const parameterValues = Object.fromEntries(
      Object.entries(section.parameterValues ?? {}).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      ),
    );
    sections[name] = {
      query: normalizeQuery(section.query, parameterValues),
      ...(Object.keys(parameterValues).length ? { parameterValues } : {}),
      answer: { ...section.answer },
    };
  }
  return {
    schema: "atlas-query-bundle-v2",
    release: { ...bundle.release },
    sections,
  };
}

export async function queryBundleDigest(bundle: QueryBundle): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(normalizeBundle(bundle)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
