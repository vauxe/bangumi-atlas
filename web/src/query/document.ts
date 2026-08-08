import type { Owner, QueryFactKind } from "./contract";
import type { CompareOperator, QueryScalar } from "./value";

export type ParameterType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "fact-ref"
  | `entity:${Owner}`;

export type LiteralValue = Exclude<QueryScalar, symbol>;

export type Expression =
  | { kind: "literal"; value: LiteralValue }
  | { kind: "parameter"; name: string }
  | { kind: "column"; name: string }
  | { kind: "field"; binding: string; field: string }
  | {
      kind: "compare";
      operator: CompareOperator;
      left: Expression;
      right: Expression;
    }
  | { kind: "and" | "or"; terms: Expression[] }
  | { kind: "not"; term: Expression }
  | { kind: "isNull" | "isMissing"; term: Expression };

export interface ScanOperator {
  kind: "scan";
  owner: Owner;
  binding: string;
}

export type LookupField = "name" | "nameCn" | "nameVariant";
export type FullTextField = "summary" | "description";

export interface LookupOperator {
  kind: "lookup";
  owner: Owner;
  binding: string;
  text: Expression;
  fields?: LookupField[];
}

export interface EntityFullTextOperator {
  kind: "fullText";
  target: "entity";
  owner: Owner;
  binding: string;
  text: Expression;
  field: FullTextField;
}

export interface FactFullTextOperator {
  kind: "fullText";
  target: "fact";
  factKind: QueryFactKind;
  factBinding: string;
  roles: Record<string, string>;
  text: Expression;
  field: "summary";
}

export type FullTextOperator = EntityFullTextOperator | FactFullTextOperator;

export interface ValuesOperator {
  kind: "values";
  columns: string[];
  types?: Partial<Record<string, ParameterType>>;
  rows: LiteralValue[][];
}

export interface FactLookupOperator {
  kind: "factLookup";
  factKind: QueryFactKind;
  factBinding: string;
  roles: Record<string, string>;
  ref: Expression;
}

export interface FilterOperator {
  kind: "filter";
  input: string;
  predicate: Expression;
}

export interface ProjectOperator {
  kind: "project";
  input: string;
  columns: { name: string; value: Expression }[];
}

export interface MatchFactOperator {
  kind: "matchFact";
  input: string;
  factKind: QueryFactKind;
  factBinding: string;
  /** Fact role -> row binding. At least one binding must already exist. */
  roles: Record<string, string>;
}

export interface FollowRefOperator {
  kind: "followRef";
  input: string;
  /** Owner that declares the reference field. */
  referenceOwner: Owner;
  field: string;
  anchorBinding: string;
  resultBinding: string;
  direction: "forward" | "reverse";
}

export type AggregateFunction =
  | "count"
  | "countDistinct"
  | "sum"
  | "min"
  | "max"
  | "avg";

export interface AggregateOperator {
  kind: "aggregate";
  input: string;
  groupBy: { name: string; value: Expression }[];
  metrics: {
    name: string;
    function: AggregateFunction;
    value?: Expression;
  }[];
}

export interface PathOperator {
  kind: "path";
  input: string;
  start: Expression;
  target: Expression;
  binding: string;
  policy: "fewest-hops";
  maxHops: number;
  maxPaths: number;
  traversals: {
    factKind: QueryFactKind;
    rolePairs: { from: string; to: string }[];
  }[];
}

export interface SetBranch {
  input: string;
  columns: { output: string; input: string }[];
}

export interface SetOperator {
  kind: "union" | "intersect" | "except";
  branches: SetBranch[];
}

export interface ExistsOperator {
  kind: "exists" | "notExists";
  input: string;
  match: string;
  columns: { outer: string; inner: string }[];
}

export interface OrderTerm {
  column: string;
  direction: "asc" | "desc";
  nulls: "first" | "last";
}

export type QueryOperator =
  | ScanOperator
  | LookupOperator
  | FullTextOperator
  | FactLookupOperator
  | ValuesOperator
  | FilterOperator
  | ProjectOperator
  | MatchFactOperator
  | FollowRefOperator
  | AggregateOperator
  | PathOperator
  | SetOperator
  | ExistsOperator;

export interface QueryDocument {
  schema: "atlas-query-document-v2";
  root: string;
  parameters: Record<string, ParameterType>;
  operators: Record<string, QueryOperator>;
  distinct?: boolean;
  orderBy?: OrderTerm[];
  limit?: number | null;
}

export type ParameterValues = Record<string, LiteralValue>;
