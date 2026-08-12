import {
  CanonicalValueMap,
  CanonicalValueSet,
  canonicalJson,
  normalizeQuery,
  queryDigest,
} from "./canonical";
import {
  QUERY_CONTRACT,
  fieldDefinition,
  parseEntityRef,
  parseFactRef,
  type Owner,
  type QueryFactKind,
} from "./contract";
import { coverageFor, type CoverageSet } from "./coverage";
import type {
  AggregateOperator,
  Expression,
  FullTextField,
  LiteralValue,
  LookupField,
  ParameterValues,
  PathOperator,
  QueryDocument,
  QueryOperator,
} from "./document";
import { QUERY_SECURITY_PROFILE } from "./security";
import {
  queryResultColumns,
  type QueryResultColumn,
} from "./validate";
import {
  MISSING,
  andTruth,
  compareValues,
  isMissing,
  notTruth,
  orTruth,
  type Missing,
  type QueryScalar,
  type QueryListValue,
  type TagValue,
  type Truth,
} from "./value";
import {
  queryRowEntityRefs,
  type QueryEntityRef,
} from "./result-entities";

export type FieldValue =
  | LiteralValue
  | Missing
  | readonly (LiteralValue | Missing | TagValue)[];

export interface EntityValue {
  kind: "entity";
  owner: Owner;
  ref: `${Owner}:${number}`;
  fields: Record<string, FieldValue>;
  searchMatch?: {
    field: LookupField | FullTextField;
    text: string;
    utf8Range: [number, number];
  };
}

export interface FactValue {
  kind: "fact";
  factKind: QueryFactKind;
  ref: `fact:${number}`;
  multiplicity: number;
  roles: Record<string, `${Owner}:${number}`>;
  fields: Record<string, FieldValue>;
  searchMatch?: {
    field: string;
    text: string;
    utf8Range: [number, number];
  };
}

export interface PathStepValue {
  fromRole: string;
  fact: FactValue;
  toRole: string;
}

export interface PathValue {
  kind: "path";
  policy: "fewest-hops";
  cost: number;
  nodes: EntityValue[];
  steps: PathStepValue[];
}

export type RuntimeValue = FieldValue | EntityValue | FactValue | PathValue;
export type QueryRow = Record<string, RuntimeValue>;
export type ScanAccess = "stream" | "whole";

export interface QueryDataSource {
  readonly releaseId?: string;
  scan(
    owner: Owner,
    signal?: AbortSignal,
    fields?: readonly string[],
    access?: ScanAccess,
  ): AsyncIterable<EntityValue>;
  /** Reads an entity subset in the same relative order as scan(owner).
   * Duplicate refs are ignored and refs absent from the source are omitted. */
  scanCandidates?(
    owner: Owner,
    refs: readonly `${Owner}:${number}`[],
    signal?: AbortSignal,
    fields?: readonly string[],
  ): AsyncIterable<EntityValue>;
  /** Resolves an Episode reference independently from scan history. */
  resolveEpisodeGraphRef?(
    ref: `episode:${number}`,
    signal?: AbortSignal,
  ): Promise<`subject:${number}` | null>;
  lookup?(
    text: string,
    owner: Owner,
    fields: readonly LookupField[],
    signal?: AbortSignal,
    entityFields?: readonly string[],
  ): AsyncIterable<EntityValue>;
  fullText?(
    text: string,
    owner: Owner,
    field: FullTextField,
    signal?: AbortSignal,
    entityFields?: readonly string[],
  ): AsyncIterable<EntityValue>;
  fullTextFact?(
    text: string,
    factKind: QueryFactKind,
    field: string,
    signal?: AbortSignal,
  ): AsyncIterable<FactValue>;
  entity?(
    ref: `${Owner}:${number}`,
    signal?: AbortSignal,
  ): Promise<EntityValue | null>;
  fact?(
    ref: `fact:${number}`,
    signal?: AbortSignal,
  ): Promise<FactValue | null>;
  facts?(
    ref: `${Owner}:${number}`,
    signal?: AbortSignal,
  ): AsyncIterable<FactValue>;
  followRef?(
    anchor: EntityValue,
    referenceOwner: Owner,
    field: string,
    direction: "forward" | "reverse",
    signal?: AbortSignal,
  ): AsyncIterable<EntityValue>;
}

export interface ExecutionOptions {
  pageSize: number;
  offset?: number;
  signal?: AbortSignal;
  /** Receives every entity represented by the complete semantic result set.
   * Delivery is independent from transport pagination and row order. */
  onResultEntities?(entities: readonly QueryResultEntity[]): void;
}

export type QueryGraphEntityRef = `${Exclude<Owner, "episode">}:${number}`;

export interface QueryResultEntity {
  ref: QueryEntityRef;
  /** Episode results resolve to their owning Subject on the star map. */
  graphRef: QueryGraphEntityRef | null;
}

export interface QueryResult {
  rows: QueryRow[];
  evidence: RowEvidence[];
  columns: Record<string, QueryResultColumn>;
  totalMatches: number;
  visibleMatches: number;
  hasMore: boolean;
  stability: "exact";
  queryDigest: string;
  releaseId: string | null;
  coverage: CoverageSet;
  terminalEvidence: Evidence[];
}

export type Evidence =
  | { kind: "entity"; ref: `${Owner}:${number}` }
  | { kind: "entity-field"; ref: `${Owner}:${number}`; field: string }
  | { kind: "fact"; ref: `fact:${number}` }
  | { kind: "fact-field"; ref: `fact:${number}`; field: string }
  | {
      kind: "reference-field";
      ref: `${Owner}:${number}`;
      field: string;
      target: `${Owner}:${number}`;
    }
  | { kind: "search-match"; ref: `${Owner}:${number}`; text: string }
  | {
      kind: "text-range";
      ref: `${Owner}:${number}` | `fact:${number}`;
      field: string;
      utf8Range: [number, number];
      text: string;
      snippet?: string;
    }
  | { kind: "path"; facts: `fact:${number}`[] }
  | {
      kind: "aggregate-lineage";
      operator: string;
      metric: string;
      group: Record<string, unknown>;
    }
  | { kind: "completed-domain"; coverage: string };

export type RowEvidence = Record<string, Evidence[]>;

type EpisodeGraphRefs = Map<
  `episode:${number}`,
  QueryGraphEntityRef | null
>;

type StoredEpisodeGraphRefs = EpisodeGraphRefs | (() => EpisodeGraphRefs);

interface ExecutionContext {
  evidence: WeakMap<QueryRow, RowEvidence | (() => RowEvidence)>;
  episodeGraphRefs: WeakMap<QueryRow, StoredEpisodeGraphRefs> | null;
  scanFields: Map<string, readonly string[]>;
  scanAccess: ScanAccess;
}

interface ScanOrigin {
  source: string;
  binding: string;
  owner: Owner;
}

type ScanOrigins = Map<string, ScanOrigin[]>;

function collectExpressionFields(
  expression: Expression,
  origins: ReadonlyMap<string, ScanOrigin[]>,
  fields: Map<string, Set<string>>,
): void {
  switch (expression.kind) {
    case "literal":
    case "parameter":
    case "column":
      return;
    case "field": {
      for (const origin of origins.get(expression.binding) ?? []) {
        const sourceFields = fields.get(origin.source) ?? new Set<string>();
        sourceFields.add(expression.field);
        fields.set(origin.source, sourceFields);
      }
      return;
    }
    case "compare":
      collectExpressionFields(expression.left, origins, fields);
      collectExpressionFields(expression.right, origins, fields);
      return;
    case "and":
    case "or":
      for (const term of expression.terms)
        collectExpressionFields(term, origins, fields);
      return;
    case "not":
    case "isNull":
    case "isMissing":
      collectExpressionFields(expression.term, origins, fields);
  }
}

function scanFieldRequirements(
  operators: Record<string, QueryOperator>,
  root: string,
  resultColumns: Readonly<Record<string, QueryResultColumn>>,
): Map<string, readonly string[]> {
  const fields = new Map<string, Set<string>>();
  const originCache = new Map<string, ScanOrigins>();
  const originsFor = (id: string): ScanOrigins => {
    const cached = originCache.get(id);
    if (cached) return cached;
    const operator = operators[id];
    if (!operator) return new Map();
    let origins: ScanOrigins;
    switch (operator.kind) {
      case "scan":
        origins = new Map([[
          operator.binding,
          [{ source: id, binding: operator.binding, owner: operator.owner }],
        ]]);
        break;
      case "filter":
      case "path":
        origins = new Map(originsFor(operator.input));
        break;
      case "matchFact":
      case "followRef":
        origins = new Map(originsFor(operator.input));
        break;
      case "exists":
      case "notExists":
        origins = new Map(originsFor(operator.input));
        break;
      case "project": {
        const input = originsFor(operator.input);
        origins = new Map();
        for (const column of operator.columns) {
          if (column.value.kind !== "column") continue;
          const source = input.get(column.value.name);
          if (source) origins.set(column.name, source);
        }
        break;
      }
      case "union":
      case "intersect":
      case "except": {
        origins = new Map();
        for (const branch of operator.branches) {
          const input = originsFor(branch.input);
          for (const column of branch.columns) {
            const source = input.get(column.input);
            if (!source) continue;
            const previous = origins.get(column.output) ?? [];
            const merged = new Map(
              [...previous, ...source].map((origin) => [origin.source, origin]),
            );
            origins.set(column.output, [...merged.values()]);
          }
        }
        break;
      }
      case "lookup":
        origins = new Map([[
          operator.binding,
          [{ source: id, binding: operator.binding, owner: operator.owner }],
        ]]);
        break;
      case "fullText":
        origins = operator.target === "entity"
          ? new Map([[
              operator.binding,
              [{ source: id, binding: operator.binding, owner: operator.owner }],
            ]])
          : new Map();
        break;
      case "factLookup":
      case "values":
      case "aggregate":
        origins = new Map();
        break;
    }
    originCache.set(id, origins);
    return origins;
  };
  for (const [id, operator] of Object.entries(operators)) {
    switch (operator.kind) {
      case "filter":
        collectExpressionFields(operator.predicate, originsFor(operator.input), fields);
        break;
      case "project":
        for (const column of operator.columns)
          collectExpressionFields(column.value, originsFor(operator.input), fields);
        break;
      case "aggregate":
        for (const group of operator.groupBy)
          collectExpressionFields(group.value, originsFor(operator.input), fields);
        for (const metric of operator.metrics)
          if (metric.value)
            collectExpressionFields(metric.value, originsFor(operator.input), fields);
        break;
      case "path":
        collectExpressionFields(operator.start, originsFor(operator.input), fields);
        collectExpressionFields(operator.target, originsFor(operator.input), fields);
        break;
    }
    originsFor(id);
  }
  const resultOrigins = originsFor(root);
  for (const [columnName, column] of Object.entries(resultColumns)) {
    for (const origin of resultOrigins.get(columnName) ?? []) {
      if (column.type !== `entity:${origin.owner}`) continue;
      const required = fields.get(origin.source) ?? new Set<string>();
      required.add("name");
      if (origin.owner === "subject" || origin.owner === "episode")
        required.add("nameCn");
      fields.set(origin.source, required);
    }
  }
  return new Map(
    [...fields].map(([binding, names]) => [binding, [...names].sort()]),
  );
}

function isEntityValue(value: RuntimeValue): value is EntityValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "entity"
  );
}

function isFactValue(value: RuntimeValue): value is FactValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "fact"
  );
}

function isPathValue(value: RuntimeValue): value is PathValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "path"
  );
}

function own(row: QueryRow, name: string): RuntimeValue {
  return Object.hasOwn(row, name) ? (row[name] as RuntimeValue) : MISSING;
}

function bindingField(binding: EntityValue | FactValue, name: string): FieldValue {
  if (isEntityValue(binding)) {
    fieldDefinition(binding.owner, name);
    if (name === "ref") return binding.ref;
    if (name === "id") return parseEntityRef(binding.ref).archiveId;
  } else {
    const definition = QUERY_CONTRACT.facts[binding.factKind];
    if (name !== "ref" && name !== "multiplicity" && !definition.fields[name])
      throw new TypeError(`unknown query field ${binding.factKind}.${name}`);
    if (name === "ref") return binding.ref;
    if (name === "multiplicity") return binding.multiplicity;
  }
  return Object.hasOwn(binding.fields, name)
    ? (binding.fields[name] as FieldValue)
    : MISSING;
}

function scalarOrList(
  value: RuntimeValue,
): QueryScalar | readonly QueryListValue[] {
  if (isEntityValue(value) || isFactValue(value) || isPathValue(value))
    throw new TypeError("structured bindings cannot be used as scalar values");
  if (Array.isArray(value))
    for (const item of value)
      if (
        typeof item === "object" &&
        item !== null &&
        !(typeof item.name === "string" && Number.isSafeInteger(item.count))
      )
        throw new TypeError("query lists contain an unknown structured value");
  return value as QueryScalar | readonly QueryListValue[];
}

function truth(value: RuntimeValue): Truth {
  if (value === true || value === false || value === null) return value;
  if (isMissing(value)) return null;
  throw new TypeError("predicate expression did not produce a boolean");
}

function evaluate(expression: Expression, row: QueryRow): RuntimeValue {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "parameter":
      throw new TypeError("normalized query contains a parameter");
    case "column":
      return own(row, expression.name);
    case "field": {
      const binding = own(row, expression.binding);
      if (isMissing(binding)) return MISSING;
      if (!isEntityValue(binding) && !isFactValue(binding))
        throw new TypeError(`${expression.binding} is not a field binding`);
      return bindingField(binding, expression.field);
    }
    case "compare":
      return compareValues(
        expression.operator,
        scalarOrList(evaluate(expression.left, row)),
        scalarOrList(evaluate(expression.right, row)),
      );
    case "and": {
      let result: Truth = true;
      for (const term of expression.terms) {
        result = andTruth(result, truth(evaluate(term, row)));
        if (result === false) break;
      }
      return result;
    }
    case "or": {
      let result: Truth = false;
      for (const term of expression.terms) {
        result = orTruth(result, truth(evaluate(term, row)));
        if (result === true) break;
      }
      return result;
    }
    case "not":
      return notTruth(truth(evaluate(expression.term, row)));
    case "isNull":
      return evaluate(expression.term, row) === null;
    case "isMissing":
      return isMissing(evaluate(expression.term, row));
  }
}

function uniqueEvidence(items: Iterable<Evidence>): Evidence[] {
  const values = new Map<string, Evidence>();
  for (const item of items) values.set(canonicalJson(item), item);
  return [...values.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, item]) => item);
}

function rowEvidence(context: ExecutionContext, row: QueryRow): RowEvidence {
  const stored = context.evidence.get(row);
  if (typeof stored === "function") {
    const resolved = stored();
    context.evidence.set(row, resolved);
    return resolved;
  }
  if (stored) return stored;
  const inferred: RowEvidence = {};
  for (const [column, value] of Object.entries(row)) {
    if (isEntityValue(value))
      inferred[column] = [{ kind: "entity", ref: value.ref }];
    else if (isFactValue(value))
      inferred[column] = [{ kind: "fact", ref: value.ref }];
    else if (isPathValue(value))
      inferred[column] = [{
        kind: "path",
        facts: value.steps.map((step) => step.fact.ref),
      }];
  }
  return inferred;
}

function episodeGraphRefsInRow(
  row: QueryRow,
): EpisodeGraphRefs {
  const graphRefs: EpisodeGraphRefs = new Map();
  const remember = (value: RuntimeValue): void => {
    if (Array.isArray(value)) return;
    if (isEntityValue(value)) {
      if (value.owner === "episode") {
        const subjectRef = value.fields.subjectRef;
        let graphRef: QueryGraphEntityRef | null = null;
        if (typeof subjectRef === "string") {
          const parsed = parseEntityRef(subjectRef);
          if (parsed.owner !== "subject")
            throw new TypeError("Episode subjectRef must identify a Subject");
          graphRef = subjectRef as QueryGraphEntityRef;
        }
        graphRefs.set(value.ref as `episode:${number}`, graphRef);
      }
      return;
    }
    if (isPathValue(value))
      for (const node of value.nodes) remember(node);
  };
  for (const value of Object.values(row)) remember(value);
  return graphRefs;
}

function episodeLineageRefs(evidence: RowEvidence): Set<`episode:${number}`> {
  const refs = new Set<`episode:${number}`>();
  for (const items of Object.values(evidence))
    for (const item of items)
      if (item.kind === "entity-field" && item.ref.startsWith("episode:"))
        refs.add(item.ref as `episode:${number}`);
  return refs;
}

function rowEpisodeGraphRefs(
  context: ExecutionContext,
  row: QueryRow,
): EpisodeGraphRefs | undefined {
  const stored = context.episodeGraphRefs?.get(row);
  if (typeof stored !== "function") return stored;
  const resolved = stored();
  context.episodeGraphRefs?.set(row, resolved);
  return resolved;
}

function rememberRowGraphEntities(
  context: ExecutionContext,
  row: QueryRow,
  sources: readonly QueryRow[] = [],
  evidence?: RowEvidence | (() => RowEvidence),
): QueryRow {
  const directGraphRefs = episodeGraphRefsInRow(row);
  if (!context.episodeGraphRefs) return row;
  const resolve = (): EpisodeGraphRefs => {
    const graphRefs = new Map(directGraphRefs);
    const lineageRefs = evidence
      ? episodeLineageRefs(typeof evidence === "function" ? evidence() : evidence)
      : new Set<`episode:${number}`>();
    for (const source of sources) {
      const sourceGraphRefs = rowEpisodeGraphRefs(context, source);
      for (const ref of lineageRefs) {
        const graphRef = sourceGraphRefs?.get(ref);
        if (graphRef !== undefined && !graphRefs.has(ref))
          graphRefs.set(ref, graphRef);
      }
    }
    return graphRefs;
  };
  if (typeof evidence === "function") context.episodeGraphRefs.set(row, resolve);
  else {
    const graphRefs = resolve();
    if (graphRefs.size) context.episodeGraphRefs.set(row, graphRefs);
  }
  return row;
}

function mergeRowGraphEntities(
  context: ExecutionContext,
  target: QueryRow,
  source: QueryRow,
): void {
  const sourceRefs = rowEpisodeGraphRefs(context, source);
  if (!sourceRefs?.size) return;
  const targetRefs = rowEpisodeGraphRefs(context, target) ?? new Map();
  for (const [ref, graphRef] of sourceRefs)
    if (!targetRefs.has(ref)) targetRefs.set(ref, graphRef);
  context.episodeGraphRefs?.set(target, targetRefs);
}

function rememberEvidence(
  context: ExecutionContext,
  row: QueryRow,
  evidence: RowEvidence,
  sources: readonly QueryRow[] = [],
): QueryRow {
  context.evidence.set(row, evidence);
  rememberRowGraphEntities(context, row, sources, evidence);
  return row;
}

function rememberLazyEvidence(
  context: ExecutionContext,
  row: QueryRow,
  evidence: () => RowEvidence,
  sources: readonly QueryRow[] = [],
): QueryRow {
  context.evidence.set(row, evidence);
  rememberRowGraphEntities(context, row, sources, () => rowEvidence(context, row));
  return row;
}

function mergeRowEvidence(left: RowEvidence, right: RowEvidence): RowEvidence {
  const result: RowEvidence = { ...left };
  for (const [column, evidence] of Object.entries(right))
    result[column] = uniqueEvidence([...(result[column] ?? []), ...evidence]);
  return result;
}

function expressionEvidence(
  expression: Expression,
  row: QueryRow,
  context: ExecutionContext,
): Evidence[] {
  switch (expression.kind) {
    case "literal":
    case "parameter":
      return [];
    case "column":
      return rowEvidence(context, row)[expression.name] ?? [];
    case "field": {
      const binding = own(row, expression.binding);
      if (isEntityValue(binding))
        return uniqueEvidence([
          ...(rowEvidence(context, row)[expression.binding] ?? []).filter(
            (item) => item.kind === "search-match" || item.kind === "text-range",
          ),
          { kind: "entity-field", ref: binding.ref, field: expression.field },
        ]);
      if (isFactValue(binding))
        return uniqueEvidence([
          ...(rowEvidence(context, row)[expression.binding] ?? []).filter(
            (item) => item.kind === "text-range",
          ),
          { kind: "fact-field", ref: binding.ref, field: expression.field },
        ]);
      return [];
    }
    case "compare":
      return uniqueEvidence([
        ...expressionEvidence(expression.left, row, context),
        ...expressionEvidence(expression.right, row, context),
      ]);
    case "and":
    case "or":
      return uniqueEvidence(
        expression.terms.flatMap((term) => expressionEvidence(term, row, context)),
      );
    case "not":
    case "isNull":
    case "isMissing":
      return expressionEvidence(expression.term, row, context);
  }
}

interface AggregateState {
  row: QueryRow;
  evidence: RowEvidence;
  metrics: {
    count: number;
    sum: number;
    min: RuntimeValue | null;
    max: RuntimeValue | null;
    distinct?: CanonicalValueSet;
  }[];
}

function createAggregateState(
  operator: AggregateOperator,
  row: QueryRow,
  evidence: RowEvidence,
): AggregateState {
  return {
    row,
    evidence,
    metrics: operator.metrics.map((metric) => ({
      count: 0,
      sum: 0,
      min: null,
      max: null,
      ...(metric.function === "countDistinct"
        ? { distinct: new CanonicalValueSet() }
        : {}),
    })),
  };
}

function addAggregateValue(
  operator: AggregateOperator,
  state: AggregateState,
  input: QueryRow,
): void {
  operator.metrics.forEach((metric, index) => {
    const accumulator = state.metrics[index];
    if (!accumulator) throw new TypeError("aggregate state is incomplete");
    if (metric.function === "count" && !metric.value) {
      accumulator.count++;
      return;
    }
    if (!metric.value) throw new TypeError(`${metric.function} requires a value`);
    const value = evaluate(metric.value, input);
    if (value === null || isMissing(value)) return;
    if (metric.function === "countDistinct") {
      accumulator.distinct?.add(jsonValue(value));
      return;
    }
    accumulator.count++;
    if (metric.function === "count") return;
    if (metric.function === "sum" || metric.function === "avg") {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new TypeError(`${metric.function} requires a finite number`);
      accumulator.sum += value;
      return;
    }
    if (metric.function === "min") {
      if (
        accumulator.min === null ||
        compareOrderedValue(value, accumulator.min, "asc", "last") < 0
      )
        accumulator.min = value;
      return;
    }
    if (
      accumulator.max === null ||
      compareOrderedValue(value, accumulator.max, "asc", "last") > 0
    )
      accumulator.max = value;
  });
}

function finishAggregate(
  operatorId: string,
  operator: AggregateOperator,
  state: AggregateState,
  context: ExecutionContext,
): QueryRow {
  const row = { ...state.row };
  const evidence = { ...state.evidence };
  operator.metrics.forEach((metric, index) => {
    const accumulator = state.metrics[index];
    if (!accumulator) throw new TypeError("aggregate state is incomplete");
    switch (metric.function) {
      case "count":
        row[metric.name] = accumulator.count;
        break;
      case "countDistinct":
        row[metric.name] = accumulator.distinct?.size ?? 0;
        break;
      case "sum":
        row[metric.name] = accumulator.count ? accumulator.sum : null;
        break;
      case "avg":
        row[metric.name] = accumulator.count
          ? accumulator.sum / accumulator.count
          : null;
        break;
      case "min":
        row[metric.name] = accumulator.count ? accumulator.min : null;
        break;
      case "max":
        row[metric.name] = accumulator.count ? accumulator.max : null;
        break;
    }
    evidence[metric.name] = [{
      kind: "aggregate-lineage",
      operator: operatorId,
      metric: metric.name,
      group: Object.fromEntries(
        Object.entries(state.row).map(([name, value]) => [name, jsonValue(value)]),
      ),
    }];
  });
  return rememberEvidence(context, row, evidence, [state.row]);
}

interface PathCandidate {
  value: PathValue;
  nodeRefs: Set<string>;
  factRefs: Set<string>;
}

interface PendingPathCandidate {
  previous: PathCandidate;
  toRef: `${Owner}:${number}`;
  steps: PathStepValue[];
}

function endpoint(
  value: RuntimeValue,
  name: "start" | "target",
): { ref: `${Owner}:${number}`; entity?: EntityValue } {
  if (isEntityValue(value)) {
    if (value.owner === "episode")
      throw new TypeError(`path ${name} cannot be an episode`);
    return { ref: value.ref, entity: value };
  }
  if (typeof value === "string") {
    const parsed = parseEntityRef(value);
    if (parsed.owner === "episode")
      throw new TypeError(`path ${name} cannot be an episode`);
    return { ref: value as `${Owner}:${number}` };
  }
  throw new TypeError(`path ${name} is not a canonical entity reference`);
}

function pathCandidateKey(
  nodes: EntityValue[],
  steps: PathStepValue[],
): string {
  return canonicalJson({
    nodes: nodes.map((node) => node.ref),
    steps: steps.map((step) => [step.fact.ref, step.fromRole, step.toRole]),
  });
}

function validateFactRoles(fact: FactValue): void {
  const definition = QUERY_CONTRACT.facts[fact.factKind];
  parseFactRef(fact.ref);
  for (const [role, owner] of Object.entries(definition.roles)) {
    const ref = fact.roles[role];
    if (!ref || parseEntityRef(ref).owner !== owner)
      throw new TypeError(`${fact.factKind}.${role} owner mismatch`);
  }
}

async function findShortestPaths(
  operator: PathOperator,
  input: QueryRow,
  source: QueryDataSource,
  signal?: AbortSignal,
): Promise<PathValue[]> {
  if (!source.entity || !source.facts)
    throw new TypeError("query data source does not support paths");
  const start = endpoint(evaluate(operator.start, input), "start");
  const target = endpoint(evaluate(operator.target, input), "target");
  const entityCache = new Map<string, Promise<EntityValue | null>>();
  const remember = (value: EntityValue | undefined): void => {
    if (value) entityCache.set(value.ref, Promise.resolve(value));
  };
  remember(start.entity);
  remember(target.entity);
  const loadEntity = (ref: `${Owner}:${number}`): Promise<EntityValue | null> => {
    const previous = entityCache.get(ref);
    if (previous) return previous;
    const pending = source.entity!(ref, signal);
    entityCache.set(ref, pending);
    return pending;
  };
  const startEntity = await loadEntity(start.ref);
  if (!startEntity) throw new TypeError(`path entity ${start.ref} is missing`);
  if (start.ref === target.ref)
    return [{
      kind: "path",
      policy: "fewest-hops",
      cost: 0,
      nodes: [startEntity],
      steps: [],
    }];

  const traversals = new Map(
    operator.traversals.map((traversal) => [traversal.factKind, traversal.rolePairs]),
  );
  let frontier: PathCandidate[] = [{
    value: {
      kind: "path",
      policy: "fewest-hops",
      cost: 0,
      nodes: [startEntity],
      steps: [],
    },
    nodeRefs: new Set([start.ref]),
    factRefs: new Set(),
  }];

  const materialize = async (
    pending: ReadonlyMap<string, PendingPathCandidate>,
  ): Promise<Map<string, PathCandidate>> => {
    const result = new Map<string, PathCandidate>();
    for (const [key, candidate] of pending) {
      signal?.throwIfAborted();
      const entity = await loadEntity(candidate.toRef);
      if (!entity) continue;
      result.set(key, {
        value: {
          kind: "path",
          policy: "fewest-hops",
          cost: candidate.previous.value.cost + 1,
          nodes: [...candidate.previous.value.nodes, entity],
          steps: candidate.steps,
        },
        nodeRefs: new Set([...candidate.previous.nodeRefs, candidate.toRef]),
        factRefs: new Set([
          ...candidate.previous.factRefs,
          candidate.steps.at(-1)!.fact.ref,
        ]),
      });
    }
    return result;
  };

  for (let depth = 0; depth < operator.maxHops && frontier.length; depth++) {
    const nextPending = new Map<string, PendingPathCandidate>();
    const foundPending = new Map<string, PendingPathCandidate>();
    for (const candidate of frontier) {
      signal?.throwIfAborted();
      const current = candidate.value.nodes.at(-1);
      if (!current) throw new TypeError("path candidate has no current node");
      for await (const fact of source.facts(current.ref, signal)) {
        signal?.throwIfAborted();
        const rolePairs = traversals.get(fact.factKind);
        if (!rolePairs || candidate.factRefs.has(fact.ref)) continue;
        validateFactRoles(fact);
        for (const pair of rolePairs) {
          if (fact.roles[pair.from] !== current.ref) continue;
          const toRef = fact.roles[pair.to];
          if (!toRef || toRef === current.ref || candidate.nodeRefs.has(toRef))
            continue;
          const steps = [
            ...candidate.value.steps,
            { fromRole: pair.from, fact, toRole: pair.to },
          ];
          const key = canonicalJson({
            nodes: [...candidate.nodeRefs, toRef],
            steps: steps.map((step) => [
              step.fact.ref,
              step.fromRole,
              step.toRole,
            ]),
          });
          const destination = toRef === target.ref ? foundPending : nextPending;
          if (destination.has(key)) continue;
          destination.set(key, {
            previous: candidate,
            toRef,
            steps,
          });
        }
      }
    }
    const found = await materialize(foundPending);
    if (found.size)
      return [...found.values()]
        .sort((left, right) => {
          const a = pathCandidateKey(left.value.nodes, left.value.steps);
          const b = pathCandidateKey(right.value.nodes, right.value.steps);
          return a < b ? -1 : a > b ? 1 : 0;
        })
        .slice(0, operator.maxPaths)
        .map((candidate) => candidate.value);
    const next = await materialize(nextPending);
    frontier = [...next.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, candidate]) => candidate);
  }
  return [];
}

async function* rowsFor(
  id: string,
  operators: Record<string, QueryOperator>,
  source: QueryDataSource,
  context: ExecutionContext,
  signal?: AbortSignal,
): AsyncIterable<QueryRow> {
  signal?.throwIfAborted();
  const operator = operators[id];
  if (!operator) throw new TypeError(`query operator ${id} is missing`);
  switch (operator.kind) {
    case "scan":
      for await (const entity of source.scan(
        operator.owner,
        signal,
        context.scanFields.get(id) ?? [],
        context.scanAccess,
      )) {
        signal?.throwIfAborted();
        if (entity.owner !== operator.owner)
          throw new TypeError("data source returned the wrong entity owner");
        yield rememberRowGraphEntities(context, { [operator.binding]: entity });
      }
      return;
    case "lookup": {
      if (!source.lookup)
        throw new TypeError("query data source does not support lookup");
      const text = evaluate(operator.text, {});
      if (typeof text !== "string") throw new TypeError("lookup text must be a string");
      for await (const entity of source.lookup(
        text,
        operator.owner,
        operator.fields ?? ["name"],
        signal,
        context.scanFields.get(id) ?? [],
      )) {
        signal?.throwIfAborted();
        if (entity.owner !== operator.owner)
          throw new TypeError("lookup returned the wrong entity owner");
        const row = { [operator.binding]: entity };
        yield rememberEvidence(context, row, {
          [operator.binding]: [
            { kind: "entity", ref: entity.ref },
            entity.searchMatch
              ? {
                  kind: "text-range",
                  ref: entity.ref,
                  field: entity.searchMatch.field,
                  utf8Range: entity.searchMatch.utf8Range,
                  text,
                  snippet: entity.searchMatch.text,
                }
              : { kind: "search-match", ref: entity.ref, text },
          ],
        });
      }
      return;
    }
    case "fullText": {
      const text = evaluate(operator.text, {});
      if (typeof text !== "string")
        throw new TypeError("full-text query must be a string");
      if (operator.target === "fact") {
        if (!source.fullTextFact || !source.entity)
          throw new TypeError("query data source does not support fact full text");
        for await (const fact of source.fullTextFact(
          text,
          operator.factKind,
          operator.field,
          signal,
        )) {
          signal?.throwIfAborted();
          if (fact.factKind !== operator.factKind)
            throw new TypeError("fact full text returned the wrong fact kind");
          if (fact.searchMatch && fact.searchMatch.field !== operator.field)
            throw new TypeError("fact full text returned the wrong field");
          parseFactRef(fact.ref);
          const row: QueryRow = { [operator.factBinding]: fact };
          const evidence: RowEvidence = {
            [operator.factBinding]: [
              { kind: "fact", ref: fact.ref },
              fact.searchMatch
                ? {
                    kind: "text-range",
                    ref: fact.ref,
                    field: fact.searchMatch.field,
                    utf8Range: fact.searchMatch.utf8Range,
                    text,
                    snippet: fact.searchMatch.text,
                  }
              : { kind: "fact-field", ref: fact.ref, field: operator.field },
            ],
          };
          for (const [role, binding] of Object.entries(operator.roles)) {
            const ref = fact.roles[role];
            if (!ref)
              throw new TypeError(`${fact.factKind} fact is missing role ${role}`);
            const entity = await source.entity(ref, signal);
            if (!entity) {
              row[binding] = MISSING;
              continue;
            }
            row[binding] = entity;
            evidence[binding] = [{ kind: "entity", ref: entity.ref }];
          }
          yield rememberEvidence(context, row, evidence);
        }
        return;
      }
      if (!source.fullText)
        throw new TypeError("query data source does not support full text");
      for await (const entity of source.fullText(
        text,
        operator.owner,
        operator.field,
        signal,
        context.scanFields.get(id) ?? [],
      )) {
        signal?.throwIfAborted();
        if (entity.owner !== operator.owner)
          throw new TypeError("full text returned the wrong entity owner");
        if (entity.searchMatch && entity.searchMatch.field !== operator.field)
          throw new TypeError("full text returned the wrong field");
        const row = { [operator.binding]: entity };
        yield rememberEvidence(context, row, {
          [operator.binding]: [
            { kind: "entity", ref: entity.ref },
            entity.searchMatch
              ? {
                  kind: "text-range",
                  ref: entity.ref,
                  field: entity.searchMatch.field,
                  utf8Range: entity.searchMatch.utf8Range,
                  text,
                  snippet: entity.searchMatch.text,
                }
              : { kind: "search-match", ref: entity.ref, text },
          ],
        });
      }
      return;
    }
    case "factLookup": {
      if (!source.fact || !source.entity)
        throw new TypeError("query data source does not support FactRef lookup");
      const ref = evaluate(operator.ref, {});
      if (typeof ref !== "string")
        throw new TypeError("factLookup ref must be a FactRef");
      parseFactRef(ref);
      const fact = await source.fact(ref as `fact:${number}`, signal);
      signal?.throwIfAborted();
      if (!fact) return;
      if (fact.ref !== ref || fact.factKind !== operator.factKind)
        throw new TypeError("FactRef lookup returned the wrong fact");
      const row: QueryRow = { [operator.factBinding]: fact };
      const evidence: RowEvidence = {
        [operator.factBinding]: [{ kind: "fact", ref: fact.ref }],
      };
      for (const [role, binding] of Object.entries(operator.roles)) {
        const roleRef = fact.roles[role];
        if (!roleRef)
          throw new TypeError(`${fact.factKind} fact is missing role ${role}`);
        const expectedOwner = QUERY_CONTRACT.facts[fact.factKind].roles[role];
        if (parseEntityRef(roleRef).owner !== expectedOwner)
          throw new TypeError(`${fact.factKind}.${role} owner mismatch`);
        const entity = await source.entity(roleRef, signal);
        if (!entity) {
          row[binding] = MISSING;
          continue;
        }
        row[binding] = entity;
        evidence[binding] = [{ kind: "entity", ref: entity.ref }];
      }
      yield rememberEvidence(context, row, evidence);
      return;
    }
    case "values":
      for (const values of operator.rows) {
        signal?.throwIfAborted();
        const row: QueryRow = {};
        const evidence: RowEvidence = {};
        for (let index = 0; index < operator.columns.length; index++) {
          const column = operator.columns[index] as string;
          const value = values[index] as LiteralValue;
          const type = operator.types?.[column];
          if (type?.startsWith("entity:")) {
            if (!source.entity || typeof value !== "string")
              throw new TypeError("query data source does not support entity values");
            const ref = value as `${Owner}:${number}`;
            const entity = await source.entity(ref, signal);
            if (!entity) throw new TypeError(`entity value ${ref} is missing`);
            row[column] = entity;
            evidence[column] = [{ kind: "entity", ref: entity.ref }];
          } else row[column] = value;
        }
        yield rememberEvidence(context, row, evidence);
      }
      return;
    case "filter":
      for await (const row of rowsFor(operator.input, operators, source, context, signal))
        if (truth(evaluate(operator.predicate, row)) === true) yield row;
      return;
    case "project":
      for await (const row of rowsFor(operator.input, operators, source, context, signal)) {
        const projected: QueryRow = {};
        for (const column of operator.columns)
          projected[column.name] = evaluate(column.value, row);
        yield rememberLazyEvidence(
          context,
          projected,
          () => Object.fromEntries(
            operator.columns.map((column) => [
              column.name,
              expressionEvidence(column.value, row, context),
            ]),
          ),
          [row],
        );
      }
      return;
    case "matchFact": {
      if (!source.facts || !source.entity)
        throw new TypeError("query data source does not support facts");
      for await (const row of rowsFor(operator.input, operators, source, context, signal)) {
        const roleBindings = Object.entries(operator.roles);
        const anchor = roleBindings.find(([, bindingName]) =>
          isEntityValue(own(row, bindingName)),
        );
        if (!anchor) throw new TypeError("fact match has no bound role");
        const anchorEntity = own(row, anchor[1]);
        if (!isEntityValue(anchorEntity))
          throw new TypeError("fact-match anchor is not an entity");
        for await (const fact of source.facts(anchorEntity.ref, signal)) {
          signal?.throwIfAborted();
          if (fact.factKind !== operator.factKind) continue;
          parseFactRef(fact.ref);
          const anchorRef = fact.roles[anchor[0]];
          if (anchorRef !== anchorEntity.ref) continue;
          const expanded: QueryRow = { ...row };
          const evidence: RowEvidence = { ...rowEvidence(context, row) };
          let matches = true;
          for (const [role, bindingName] of roleBindings) {
            const ref = fact.roles[role];
            if (!ref) throw new TypeError(`${fact.factKind} fact is missing role ${role}`);
            const expectedOwner = QUERY_CONTRACT.facts[fact.factKind].roles[role];
            if (parseEntityRef(ref).owner !== expectedOwner)
              throw new TypeError(`${fact.factKind}.${role} owner mismatch`);
            const existing = own(expanded, bindingName);
            if (!isMissing(existing)) {
              if (!isEntityValue(existing) || existing.ref !== ref) matches = false;
              if (!matches) break;
              continue;
            }
            const entity = await source.entity(ref, signal);
            if (!entity) {
              expanded[bindingName] = MISSING;
              continue;
            }
            expanded[bindingName] = entity;
            evidence[bindingName] = [{ kind: "entity", ref: entity.ref }];
          }
          if (!matches) continue;
          expanded[operator.factBinding] = fact;
          evidence[operator.factBinding] = [{ kind: "fact", ref: fact.ref }];
          yield rememberEvidence(context, expanded, evidence, [row]);
        }
      }
      return;
    }
    case "followRef": {
      if (!source.followRef)
        throw new TypeError("query data source does not support references");
      const definition = fieldDefinition(operator.referenceOwner, operator.field);
      if (!definition.type.startsWith("entity:"))
        throw new TypeError("reference field does not target an entity");
      const targetOwner = definition.type.slice(7) as Owner;
      const expectedOwner = operator.direction === "forward"
        ? targetOwner
        : operator.referenceOwner;
      for await (const row of rowsFor(
        operator.input,
        operators,
        source,
        context,
        signal,
      )) {
        const anchor = own(row, operator.anchorBinding);
        if (!isEntityValue(anchor))
          throw new TypeError("reference anchor is not an entity");
        for await (const result of source.followRef(
          anchor,
          operator.referenceOwner,
          operator.field,
          operator.direction,
          signal,
        )) {
          signal?.throwIfAborted();
          if (result.owner !== expectedOwner)
            throw new TypeError("reference traversal returned the wrong owner");
          const reference = operator.direction === "forward" ? anchor : result;
          const target = operator.direction === "forward" ? result : anchor;
          const expanded = { ...row, [operator.resultBinding]: result };
          yield rememberEvidence(context, expanded, {
            ...rowEvidence(context, row),
            [operator.resultBinding]: [
              { kind: "entity", ref: result.ref },
              {
                kind: "reference-field",
                ref: reference.ref,
                field: operator.field,
                target: target.ref,
              },
            ],
          }, [row]);
        }
      }
      return;
    }
    case "aggregate": {
      const groups = new Map<string, AggregateState>();
      const scalarGroups = operator.groupBy.length === 1
        ? new CanonicalValueMap<AggregateState>()
        : null;
      for await (const row of rowsFor(operator.input, operators, source, context, signal)) {
        signal?.throwIfAborted();
        const groupRow: QueryRow = {};
        const groupEvidence: RowEvidence = {};
        for (const group of operator.groupBy) {
          groupRow[group.name] = evaluate(group.value, row);
          groupEvidence[group.name] = expressionEvidence(group.value, row, context);
        }
        rememberRowGraphEntities(context, groupRow, [row], groupEvidence);
        const create = (): AggregateState =>
          createAggregateState(operator, groupRow, groupEvidence);
        let state: AggregateState;
        if (scalarGroups) {
          const groupName = operator.groupBy[0]!.name;
          state = scalarGroups.getOrCreate(jsonValue(own(groupRow, groupName)), create);
        } else {
          const key = rowKey(groupRow);
          state = groups.get(key) ?? create();
          if (!groups.has(key)) groups.set(key, state);
        }
        addAggregateValue(operator, state, row);
      }
      if (!(scalarGroups?.size ?? groups.size) && !operator.groupBy.length) {
        const state = createAggregateState(operator, {}, {});
        groups.set(rowKey(state.row), state);
      }
      const states = scalarGroups
        ? [...scalarGroups.values()]
        : [...groups.values()];
      states.sort((left, right) => {
        const a = rowKey(left.row);
        const b = rowKey(right.row);
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (const state of states) {
        signal?.throwIfAborted();
        yield finishAggregate(id, operator, state, context);
      }
      return;
    }
    case "path":
      for await (const row of rowsFor(operator.input, operators, source, context, signal)) {
        const paths = await findShortestPaths(operator, row, source, signal);
        for (const path of paths) {
          const expanded = { ...row, [operator.binding]: path };
          yield rememberEvidence(context, expanded, {
            ...rowEvidence(context, row),
            [operator.binding]: [{
              kind: "path",
              facts: path.steps.map((step) => step.fact.ref),
            }],
          }, [row]);
        }
      }
      return;
    case "exists":
    case "notExists": {
      const matches = new Map<string, RowEvidence>();
      const outer = operators[operator.input];
      const candidateColumn = operator.kind === "exists" &&
          source.scanCandidates &&
          outer?.kind === "scan" &&
          operator.columns.length === 1 &&
          operator.columns[0]?.outer === outer.binding
        ? operator.columns[0]
        : null;
      const candidateRefs: `${Owner}:${number}`[] = [];
      let candidateScanIsSafe = candidateColumn !== null;
      for await (const row of rowsFor(operator.match, operators, source, context, signal)) {
        signal?.throwIfAborted();
        const key = canonicalJson(operator.columns.map((column) =>
          jsonValue(own(row, column.inner)),
        ));
        if (!matches.has(key)) {
          matches.set(key, rowEvidence(context, row));
          if (candidateColumn) {
            const candidate = own(row, candidateColumn.inner);
            if (
              isEntityValue(candidate) &&
              outer?.kind === "scan" &&
              candidate.owner === outer.owner
            ) candidateRefs.push(candidate.ref);
            else candidateScanIsSafe = false;
          }
        }
      }
      if (
        candidateScanIsSafe &&
        candidateColumn &&
        outer?.kind === "scan" &&
        source.scanCandidates
      ) {
        const requested = new Set(candidateRefs);
        const returned = new Set<string>();
        for await (const entity of source.scanCandidates(
          outer.owner,
          candidateRefs,
          signal,
          context.scanFields.get(operator.input) ?? [],
        )) {
          signal?.throwIfAborted();
          if (entity.owner !== outer.owner || !requested.has(entity.ref))
            throw new TypeError("candidate scan returned an unrequested entity");
          if (returned.has(entity.ref))
            throw new TypeError("candidate scan returned a duplicate entity");
          returned.add(entity.ref);
          const row = rememberRowGraphEntities(context, {
            [outer.binding]: entity,
          });
          const key = canonicalJson(operator.columns.map((column) =>
            jsonValue(own(row, column.outer)),
          ));
          const matched = matches.get(key);
          if (!matched)
            throw new TypeError("candidate scan returned an unmatched entity");
          context.evidence.set(
            row,
            mergeRowEvidence(rowEvidence(context, row), matched),
          );
          yield row;
        }
        return;
      }
      for await (const row of rowsFor(operator.input, operators, source, context, signal)) {
        signal?.throwIfAborted();
        const key = canonicalJson(operator.columns.map((column) =>
          jsonValue(own(row, column.outer)),
        ));
        const matched = matches.get(key);
        if ((operator.kind === "exists") !== Boolean(matched)) continue;
        if (matched)
          context.evidence.set(
            row,
            mergeRowEvidence(rowEvidence(context, row), matched),
          );
        yield row;
      }
      return;
    }
    case "union":
    case "intersect":
    case "except": {
      const branchRows = async (
        branch: (typeof operator.branches)[number],
      ): Promise<Map<string, QueryRow>> => {
        const values = new Map<string, QueryRow>();
        for await (const row of rowsFor(branch.input, operators, source, context, signal)) {
          const mapped: QueryRow = {};
          const evidence: RowEvidence = {};
          for (const column of branch.columns) {
            const value = own(row, column.input);
            if (isMissing(value))
              throw new TypeError(`set input column ${column.input} is missing`);
            mapped[column.output] = value;
            evidence[column.output] = rowEvidence(context, row)[column.input] ?? [];
          }
          const key = rowKey(mapped);
          const previous = values.get(key);
          if (!previous)
            values.set(key, rememberEvidence(context, mapped, evidence, [row]));
          else mergeRowGraphEntities(context, previous, row);
        }
        return values;
      };
      const result = await branchRows(operator.branches[0] as (typeof operator.branches)[number]);
      for (let index = 1; index < operator.branches.length; index++) {
        const rows = await branchRows(operator.branches[index] as (typeof operator.branches)[number]);
        if (operator.kind === "union") {
          for (const [key, row] of rows) {
            const previous = result.get(key);
            if (previous)
              context.evidence.set(
                previous,
                mergeRowEvidence(
                  rowEvidence(context, previous),
                  rowEvidence(context, row),
                ),
              );
            if (previous) mergeRowGraphEntities(context, previous, row);
            else result.set(key, row);
          }
        } else if (operator.kind === "intersect") {
          for (const [key, row] of result) {
            const matched = rows.get(key);
            if (!matched) result.delete(key);
            else {
              context.evidence.set(
                row,
                mergeRowEvidence(
                  rowEvidence(context, row),
                  rowEvidence(context, matched),
                ),
              );
              mergeRowGraphEntities(context, row, matched);
            }
          }
        } else {
          for (const key of rows.keys()) result.delete(key);
        }
      }
      for (const key of [...result.keys()].sort()) {
        signal?.throwIfAborted();
        yield result.get(key) as QueryRow;
      }
      return;
    }
  }
}

function jsonValue(value: RuntimeValue): unknown {
  if (isMissing(value)) return { $missing: true };
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (isPathValue(value))
    return {
      kind: "path",
      policy: value.policy,
      cost: value.cost,
      nodes: value.nodes.map((node) => node.ref),
      steps: value.steps.map((step) => ({
        fromRole: step.fromRole,
        fact: step.fact.ref,
        toRole: step.toRole,
      })),
    };
  if (isEntityValue(value) || isFactValue(value)) return value.ref;
  return value;
}

function rowKey(row: QueryRow): string {
  return canonicalJson(
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonValue(value)])),
  );
}

/** @internal Exported for deterministic performance-contract coverage. */
export function compareOrderedValue(
  left: RuntimeValue,
  right: RuntimeValue,
  direction: "asc" | "desc",
  nulls: "first" | "last",
): number {
  const leftNull = left === null || isMissing(left);
  const rightNull = right === null || isMissing(right);
  if (leftNull || rightNull) {
    if (leftNull && rightNull) {
      if (left === right) return 0;
      return isMissing(left) ? 1 : -1;
    }
    return leftNull === (nulls === "first") ? -1 : 1;
  }
  let order: number;
  if (typeof left === "number" && typeof right === "number")
    order = left < right ? -1 : left > right ? 1 : 0;
  else if (typeof left === "string" && typeof right === "string")
    order = left < right ? -1 : left > right ? 1 : 0;
  else {
    const a = canonicalJson(jsonValue(left));
    const b = canonicalJson(jsonValue(right));
    order = a < b ? -1 : a > b ? 1 : 0;
  }
  return direction === "asc" ? order : -order;
}

/** @internal Exported for deterministic performance-contract coverage. */
export interface RankedRow {
  row: QueryRow;
  key: string | null;
  ordinal: number;
}

function rankedKey(value: RankedRow): string {
  value.key ??= rowKey(value.row);
  return value.key;
}

function compareRows(
  left: RankedRow,
  right: RankedRow,
  orderBy: NonNullable<QueryDocument["orderBy"]>,
): number {
  for (const term of orderBy) {
    const order = compareOrderedValue(
      own(left.row, term.column),
      own(right.row, term.column),
      term.direction,
      term.nulls,
    );
    if (order) return order;
  }
  const leftKey = rankedKey(left);
  const rightKey = rankedKey(right);
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  return left.ordinal - right.ordinal;
}

/** @internal Exported for deterministic performance-contract coverage. */
export function insertTop(
  rows: RankedRow[],
  value: RankedRow,
  cap: number,
  orderBy: NonNullable<QueryDocument["orderBy"]>,
): void {
  if (cap === 0) return;
  const boundary = rows.length === cap ? rows.at(-1) : undefined;
  if (boundary && compareRows(boundary, value, orderBy) <= 0) return;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareRows(rows[mid] as RankedRow, value, orderBy) <= 0) lo = mid + 1;
    else hi = mid;
  }
  rows.splice(lo, 0, value);
  if (rows.length > cap) rows.pop();
}

interface PendingResultEntities {
  entities: QueryResultEntity[];
  unresolved: { index: number; ref: `episode:${number}` }[];
}

interface RankedResultEntities extends PendingResultEntities {
  ranked: RankedRow;
}

function compareRankedResultEntities(
  left: RankedResultEntities,
  right: RankedResultEntities,
  orderBy: NonNullable<QueryDocument["orderBy"]>,
): number {
  return compareRows(left.ranked, right.ranked, orderBy);
}

/** Maintain a max-heap whose root is the worst row retained by the Top-N. */
function insertResultEntityTop(
  heap: RankedResultEntities[],
  value: RankedResultEntities,
  cap: number,
  orderBy: NonNullable<QueryDocument["orderBy"]>,
): void {
  if (cap === 0) return;
  const worse = (left: RankedResultEntities, right: RankedResultEntities): boolean =>
    compareRankedResultEntities(left, right, orderBy) > 0;
  const siftUp = (start: number): void => {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!worse(heap[index] as RankedResultEntities, heap[parent] as RankedResultEntities))
        break;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
  };
  const siftDown = (): void => {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= heap.length) return;
      const right = left + 1;
      const child = right < heap.length &&
          worse(heap[right] as RankedResultEntities, heap[left] as RankedResultEntities)
        ? right
        : left;
      if (!worse(heap[child] as RankedResultEntities, heap[index] as RankedResultEntities))
        return;
      [heap[index], heap[child]] = [heap[child]!, heap[index]!];
      index = child;
    }
  };
  if (heap.length < cap) {
    heap.push(value);
    siftUp(heap.length - 1);
    return;
  }
  if (compareRankedResultEntities(value, heap[0] as RankedResultEntities, orderBy) >= 0)
    return;
  heap[0] = value;
  siftDown();
}

export async function executeQuery(
  document: QueryDocument,
  parameters: ParameterValues,
  source: QueryDataSource,
  options: ExecutionOptions,
): Promise<QueryResult> {
  if (
    !Number.isSafeInteger(options.pageSize) ||
    options.pageSize <= 0 ||
    options.pageSize > QUERY_SECURITY_PROFILE.execution.maxPageSize
  )
    throw new TypeError(
      `pageSize must be between 1 and ${QUERY_SECURITY_PROFILE.execution.maxPageSize}`,
    );
  const offset = options.offset ?? 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new TypeError("offset must be a non-negative integer");
  const query = normalizeQuery(document, parameters);
  const columns = queryResultColumns(query);
  const visibleColumns = new Set(Object.keys(columns));
  const publicRow = (row: QueryRow): QueryRow => Object.fromEntries(
    Object.entries(row).filter(([column]) => visibleColumns.has(column)),
  );
  const limit = query.limit ?? Number.POSITIVE_INFINITY;
  const cap = Math.min(limit, offset + options.pageSize);
  const orderBy = query.orderBy ?? [];
  const canStopAtLimit = Number.isFinite(limit) && orderBy.length === 0;
  const top: RankedRow[] = [];
  const context: ExecutionContext = {
    evidence: new WeakMap(),
    episodeGraphRefs: options.onResultEntities ? new WeakMap() : null,
    scanFields: scanFieldRequirements(query.operators, query.root, columns),
    scanAccess: canStopAtLimit ? "stream" : "whole",
  };
  const metadata = Promise.all([queryDigest(query), coverageFor(query)]);
  if (limit === 0) {
    const [digest, coverage] = await metadata;
    return {
      rows: [],
      evidence: [],
      columns,
      totalMatches: 0,
      visibleMatches: 0,
      hasMore: false,
      stability: "exact",
      queryDigest: digest,
      releaseId: source.releaseId ?? null,
      coverage,
      terminalEvidence: [{ kind: "completed-domain", coverage: coverage.digest }],
    };
  }
  const distinct = query.distinct ? new Set<string>() : null;
  const deferredEntities = options.onResultEntities &&
      orderBy.length > 0 && Number.isFinite(limit)
    ? [] as RankedResultEntities[]
    : null;
  let totalMatches = 0;
  let ordinal = 0;
  const publicEvidence = (row: QueryRow): RowEvidence => Object.fromEntries(
    Object.entries(rowEvidence(context, row))
      .filter(([column]) => visibleColumns.has(column)),
  );
  const pendingResultEntities = (row: QueryRow): PendingResultEntities => {
    const visibleRow = publicRow(row);
    const evidence = publicEvidence(row);
    const refs = queryRowEntityRefs(visibleRow, evidence);
    const visibleGraphRefs = episodeGraphRefsInRow(visibleRow);
    const lineageRefs = episodeLineageRefs(evidence);
    const rememberedGraphRefs = rowEpisodeGraphRefs(context, row);
    const unresolved: { index: number; ref: `episode:${number}` }[] = [];
    const entities = refs.map((ref, index): QueryResultEntity => {
      const parsed = parseEntityRef(ref);
      if (parsed.owner !== "episode")
        return { ref, graphRef: ref as QueryGraphEntityRef };
      const episodeRef = ref as `episode:${number}`;
      if (visibleGraphRefs.has(episodeRef))
        return { ref, graphRef: visibleGraphRefs.get(episodeRef) ?? null };
      if (lineageRefs.has(episodeRef) && rememberedGraphRefs?.has(episodeRef))
        return { ref, graphRef: rememberedGraphRefs.get(episodeRef) ?? null };
      if (source.resolveEpisodeGraphRef)
        unresolved.push({ index, ref: episodeRef });
      return {
        ref,
        graphRef: null,
      };
    });
    return { entities, unresolved };
  };
  const resolveResultEntities = async (
    pending: PendingResultEntities,
  ): Promise<QueryResultEntity[]> => {
    await Promise.all(pending.unresolved.map(async ({ index, ref }) => {
      const graphRef = await source.resolveEpisodeGraphRef!(ref, options.signal);
      if (graphRef !== null && parseEntityRef(graphRef).owner !== "subject")
        throw new TypeError("Episode graph resolver must return a Subject");
      pending.entities[index] = { ref, graphRef };
    }));
    return pending.entities;
  };

  for await (const row of rowsFor(
    query.root,
    query.operators,
    source,
    context,
    options.signal,
  )) {
    options.signal?.throwIfAborted();
    const key = distinct ? rowKey(publicRow(row)) : null;
    if (key !== null && distinct?.has(key)) continue;
    if (key !== null) distinct?.add(key);
    totalMatches++;
    const currentOrdinal = ordinal++;
    const ranked = { row, key, ordinal: currentOrdinal };
    if (options.onResultEntities) {
      const pendingEntities = pendingResultEntities(row);
      if (deferredEntities) {
        insertResultEntityTop(
          deferredEntities,
          {
            ranked,
            ...pendingEntities,
          },
          limit,
          orderBy,
        );
      } else {
        const entities = await resolveResultEntities(pendingEntities);
        if (entities.length) options.onResultEntities(entities);
      }
    }
    if (orderBy.length) insertTop(top, ranked, cap, orderBy);
    else if (top.length < cap) top.push(ranked);
    if (canStopAtLimit && totalMatches >= limit) break;
  }

  if (deferredEntities)
    for (const row of deferredEntities) {
      const entities = await resolveResultEntities(row);
      if (entities.length) options.onResultEntities?.(entities);
    }

  totalMatches = Math.min(totalMatches, limit);
  const visibleMatches = totalMatches;
  const page = top.slice(offset, Math.min(offset + options.pageSize, visibleMatches));
  const [digest, coverage] = await metadata;
  return {
    rows: page.map((ranked) => publicRow(ranked.row)),
    evidence: page.map((ranked) => publicEvidence(ranked.row)),
    columns,
    totalMatches,
    visibleMatches,
    hasMore: visibleMatches > offset + page.length,
    stability: "exact",
    queryDigest: digest,
    releaseId: source.releaseId ?? null,
    coverage,
    terminalEvidence: [{ kind: "completed-domain", coverage: coverage.digest }],
  };
}
