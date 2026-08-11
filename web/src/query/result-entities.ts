import type { Owner } from "./contract";
import type {
  EntityValue,
  FactValue,
  PathValue,
  QueryResult,
  QueryRow,
  RowEvidence,
  RuntimeValue,
} from "./engine";

export type QueryEntityRef = `${Owner}:${number}`;

const ENTITY_REF = /^(subject|person|character|episode):(0|[1-9][0-9]*)$/;

function entity(value: RuntimeValue): value is EntityValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "kind" in value && value.kind === "entity";
}

function fact(value: RuntimeValue): value is FactValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "kind" in value && value.kind === "fact";
}

function path(value: RuntimeValue): value is PathValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "kind" in value && value.kind === "path";
}

export function collectEntityRefs(
  value: RuntimeValue,
  refs: Set<QueryEntityRef>,
): void {
  if (typeof value === "string" && ENTITY_REF.test(value)) {
    refs.add(value as QueryEntityRef);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEntityRefs(item, refs);
    return;
  }
  if (entity(value)) {
    refs.add(value.ref);
    return;
  }
  if (fact(value)) {
    for (const ref of Object.values(value.roles)) refs.add(ref);
    return;
  }
  if (path(value))
    for (const node of value.nodes) refs.add(node.ref);
}

function projectedEntityRefs(
  row: QueryRow,
  evidence: RowEvidence | undefined,
): QueryEntityRef[] {
  const refs = new Set<QueryEntityRef>();
  for (const [column, items] of Object.entries(evidence ?? {})) {
    if (!Object.hasOwn(row, column)) continue;
    for (const item of items)
      if (item.kind === "entity-field") refs.add(item.ref);
  }
  return [...refs];
}

export function projectedEntityRef(
  row: QueryRow,
  evidence: RowEvidence | undefined,
): QueryEntityRef | null {
  const refs = projectedEntityRefs(row, evidence);
  return refs.length === 1 ? refs[0] as QueryEntityRef : null;
}

export function queryRowVisibleEntityRefs(row: QueryRow): QueryEntityRef[] {
  const refs = new Set<QueryEntityRef>();
  for (const value of Object.values(row)) collectEntityRefs(value, refs);
  return [...refs];
}

export function queryRowEntityRefs(
  row: QueryRow,
  evidence?: RowEvidence,
): QueryEntityRef[] {
  const refs = new Set(queryRowVisibleEntityRefs(row));
  for (const ref of projectedEntityRefs(row, evidence)) refs.add(ref);
  return [...refs];
}

/** Entity identities present in the supplied answer rows. */
export function queryResultEntityRefs(
  result: Pick<QueryResult, "rows"> & Partial<Pick<QueryResult, "evidence">>,
): string[] {
  const refs = new Set<QueryEntityRef>();
  result.rows.forEach((row, index) => {
    for (const ref of queryRowEntityRefs(row, result.evidence?.[index]))
      refs.add(ref);
  });
  return [...refs];
}
