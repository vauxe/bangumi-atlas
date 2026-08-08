import rawContract from "../../../scripts/query-contract.json";

export type Owner = "subject" | "person" | "character" | "episode";
export type QueryFactKind =
  | "RELATES_TO"
  | "WORKED_ON"
  | "APPEARS_IN"
  | "VOICE_CREDIT"
  | "PERSON_REL"
  | "CHARACTER_REL";

export type FieldCapability =
  | "lookup"
  | "fullText"
  | "project"
  | "filter"
  | "sort"
  | "group"
  | "aggregate"
  | "traverse"
  | "evidence";

export type FieldExposure = "query" | "evidence" | "private";

export interface FieldDefinition {
  type: string;
  operators?: string;
  enum?: string;
  source?: string;
  exposure: FieldExposure;
  capabilities: FieldCapability[];
  nullable?: boolean;
  missing?: boolean;
}

interface SearchSemantics {
  minNormalizedCharacters: number;
}

interface OwnerDefinition {
  fields: Record<string, FieldDefinition>;
}

interface FactDefinition {
  roles: Record<string, Owner>;
  fields: Record<string, FieldDefinition>;
}

interface QueryContract {
  schema: "atlas-query-v2";
  capabilities: FieldCapability[];
  operatorSets: Record<string, string[]>;
  search: Record<"lookup" | "fullText", SearchSemantics>;
  owners: Record<Owner, OwnerDefinition>;
  factFields: Record<"ref" | "multiplicity", FieldDefinition>;
  facts: Record<QueryFactKind, FactDefinition>;
}

export const QUERY_CONTRACT = rawContract as QueryContract;

const OWNERS = new Set<Owner>(["subject", "person", "character", "episode"]);
const CANONICAL_ID = /^(?:0|[1-9][0-9]*)$/;

function parseCanonicalId(raw: string, label: string): number {
  if (!CANONICAL_ID.test(raw))
    throw new TypeError(`${label} is not a canonical reference`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw new TypeError(`${label} is not a safe canonical reference`);
  return value;
}

export function fieldDefinition(owner: Owner, field: string): FieldDefinition {
  const definition = QUERY_CONTRACT.owners[owner]?.fields[field];
  if (!definition) throw new TypeError(`unknown query field ${owner}.${field}`);
  return definition;
}

export function assertFieldCapability(
  owner: Owner,
  field: string,
  capability: FieldCapability,
): FieldDefinition {
  const definition = fieldDefinition(owner, field);
  if (definition.exposure === "private")
    throw new TypeError(`${owner}.${field} is private`);
  if (!definition.capabilities.includes(capability))
    throw new TypeError(`${owner}.${field} does not support ${capability}`);
  return definition;
}

export function fieldsWithCapability(
  owner: Owner,
  capability: FieldCapability,
): string[] {
  return Object.entries(QUERY_CONTRACT.owners[owner].fields)
    .filter(([, definition]) =>
      definition.exposure !== "private" &&
      definition.capabilities.includes(capability)
    )
    .map(([field]) => field);
}

export function factFieldDefinition(
  kind: QueryFactKind,
  field: string,
): FieldDefinition {
  const common = QUERY_CONTRACT.factFields[field as keyof typeof QUERY_CONTRACT.factFields];
  if (common) return common;
  const definition = QUERY_CONTRACT.facts[kind]?.fields[field];
  if (!definition) throw new TypeError(`unknown query field ${kind}.${field}`);
  return definition;
}

export function assertFactFieldCapability(
  kind: QueryFactKind,
  field: string,
  capability: FieldCapability,
): FieldDefinition {
  const definition = factFieldDefinition(kind, field);
  if (definition.exposure === "private")
    throw new TypeError(`${kind}.${field} is private`);
  if (!definition.capabilities.includes(capability))
    throw new TypeError(`${kind}.${field} does not support ${capability}`);
  return definition;
}

export function parseEntityRef(ref: string): {
  owner: Owner;
  archiveId: number;
} {
  const split = ref.indexOf(":");
  const owner = ref.slice(0, split) as Owner;
  if (split <= 0 || !OWNERS.has(owner))
    throw new TypeError(`${ref} is not an entity reference`);
  return {
    owner,
    archiveId: parseCanonicalId(ref.slice(split + 1), ref),
  };
}

export function parseFactRef(ref: string): number {
  if (!ref.startsWith("fact:"))
    throw new TypeError(`${ref} is not a fact reference`);
  return parseCanonicalId(ref.slice(5), ref);
}
