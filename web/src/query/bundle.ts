import { normalizeQuery } from "./canonical";
import { QUERY_CONTRACT, type Owner } from "./contract";
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

export type AnswerSpec =
  | {
      shape: "entity-list";
      title: string;
      /** Entity types whose fields can be chosen in this result view. */
      entityScope: Owner[];
    }
  | {
      shape: Exclude<AnswerShape, "entity-list">;
      title: string;
      entityScope?: never;
    };

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
  schema: "atlas-query-bundle-v1";
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

const OWNER_ORDER = Object.keys(QUERY_CONTRACT.owners) as Owner[];

function normalizeAnswer(answer: AnswerSpec): AnswerSpec {
  if (!answer?.title || !ANSWER_SHAPES.has(answer.shape))
    throw new TypeError("query bundle answer specification is invalid");
  if (answer.shape !== "entity-list") {
    if (answer.entityScope !== undefined)
      throw new TypeError("query bundle answer entity scope is invalid");
    return { shape: answer.shape, title: answer.title };
  }
  if (
    !Array.isArray(answer.entityScope) ||
    !answer.entityScope.length ||
    answer.entityScope.some((owner) => !OWNER_ORDER.includes(owner))
  ) throw new TypeError("query bundle answer entity scope is invalid");
  const selected = new Set(answer.entityScope);
  return {
    shape: answer.shape,
    title: answer.title,
    entityScope: OWNER_ORDER.filter((owner) => selected.has(owner)),
  };
}

export function normalizeBundle(bundle: QueryBundle): QueryBundle {
  if (bundle?.schema !== "atlas-query-bundle-v1")
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
    if (!name || !section?.answer)
      throw new TypeError("query bundle answer specification is invalid");
    const parameterValues = Object.fromEntries(
      Object.entries(section.parameterValues ?? {}).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      ),
    );
    sections[name] = {
      query: normalizeQuery(section.query, parameterValues, {
        preserveParameters: true,
      }),
      ...(Object.keys(parameterValues).length ? { parameterValues } : {}),
      answer: normalizeAnswer(section.answer),
    };
  }
  return {
    schema: "atlas-query-bundle-v1",
    release: { ...bundle.release },
    sections,
  };
}
