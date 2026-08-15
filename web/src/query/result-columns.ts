import {
  QUERY_CONTRACT,
  fieldsWithCapability,
  type Owner,
} from "./contract";

export const RESULT_IDENTITY_FIELDS = ["ref", "name", "nameCn"] as const;
export const RESULT_ENTITY_TYPE_FIELD = "entityType";

const NON_SELECTABLE_RESULT_FIELDS = new Set([
  ...RESULT_IDENTITY_FIELDS,
  "id",
  "subjectRef",
]);

/** Raw entity projections used when the user has not chosen result columns. */
export const DEFAULT_RESULT_FIELDS: Readonly<Record<Owner, readonly string[]>> = {
  subject: ["ref", "name", "nameCn", "type", "date", "score", "rank"],
  person: ["ref", "name", "type", "career", "comments", "collects"],
  character: ["ref", "name", "role", "comments", "collects"],
  episode: ["ref", "name", "nameCn", "type", "airdate", "duration"],
};

export interface ResultColumnChoice {
  field: string;
  owners: Owner[];
}

export function ownerSupportsResultField(owner: Owner, field: string): boolean {
  const definition = QUERY_CONTRACT.owners[owner].fields[field];
  return Boolean(
    definition && definition.exposure !== "private" &&
    definition.capabilities.includes("project"),
  );
}

export function defaultResultProjection(owner: Owner): string[] {
  return [...DEFAULT_RESULT_FIELDS[owner]];
}

function identityProjection(scope: readonly Owner[]): string[] {
  return RESULT_IDENTITY_FIELDS.filter((field) =>
    scope.some((owner) => ownerSupportsResultField(owner, field))
  );
}

export function resultColumnChoices(
  scope: readonly Owner[],
): ResultColumnChoice[] {
  if (!scope.length) throw new TypeError("至少选择一种实体");
  const orderedFields = new Set<string>();
  if (scope.length > 1) orderedFields.add(RESULT_ENTITY_TYPE_FIELD);
  for (const owner of scope)
    for (const field of DEFAULT_RESULT_FIELDS[owner]) orderedFields.add(field);
  for (const owner of scope) {
    for (const field of fieldsWithCapability(owner, "project"))
      orderedFields.add(field);
  }
  return [...orderedFields].flatMap((field) => {
    if (NON_SELECTABLE_RESULT_FIELDS.has(field)) return [];
    if (field === RESULT_ENTITY_TYPE_FIELD)
      return [{ field, owners: [...scope] }];
    const owners = scope.filter((owner) => ownerSupportsResultField(owner, field));
    return owners.length ? [{ field, owners }] : [];
  });
}

export function defaultResultColumnSelection(scope: readonly Owner[]): string[] {
  if (!scope.length) throw new TypeError("至少选择一种实体");
  if (scope.length > 1) return [RESULT_ENTITY_TYPE_FIELD];
  const owner = scope[0]!;
  const selectable = new Set(resultColumnChoices(scope).map(({ field }) => field));
  return DEFAULT_RESULT_FIELDS[owner].filter((field) => selectable.has(field));
}

/** Removes identity fields, duplicates, and fields unavailable in the new scope. */
export function normalizeResultColumnSelection(
  scope: readonly Owner[],
  fields: readonly string[],
): string[] {
  const available = new Set(resultColumnChoices(scope).map(({ field }) => field));
  return [...new Set(fields.filter((field) => available.has(field)))];
}

/** Complete baseline projection executed before result-only columns are chosen. */
export function resultProjection(
  scope: readonly Owner[],
): string[] {
  return [
    ...identityProjection(scope),
    ...defaultResultColumnSelection(scope),
  ];
}
