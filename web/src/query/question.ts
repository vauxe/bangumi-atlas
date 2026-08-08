/** Legacy atlas-question-v1 URL adapter.
 * New UI code must build QueryBundle v2 directly through explorer/recipes. */
import {
  QUERY_CONTRACT,
  assertFieldCapability,
  fieldDefinition,
  fieldsWithCapability,
  parseEntityRef,
  type Owner,
  type QueryFactKind,
} from "./contract";
import type { QueryBundle, QuerySection } from "./bundle";
import type {
  AggregateFunction,
  Expression,
  FullTextField,
  LiteralValue,
  LookupField,
  OrderTerm,
  QueryDocument,
  QueryOperator,
} from "./document";
import { comparisonRecipe, pathRecipe } from "./recipes";
import type { CompareOperator } from "./value";

export type QuestionCondition =
  | {
      kind: "compare";
      field: string;
      operator: CompareOperator;
      value: LiteralValue;
    }
  | { kind: "isNull" | "isMissing"; field: string }
  | { kind: "all" | "any"; terms: QuestionCondition[] }
  | { kind: "not"; term: QuestionCondition };

export interface FindQuestion {
  schema: "atlas-question-v1";
  mode: "find";
  owner: Owner;
  text?: string;
  textFields?: ("name" | "summary" | "infobox" | "description")[];
  condition?: QuestionCondition;
  relations?: RelationCondition[];
  columns?: string[];
  orderBy?: OrderTerm[];
  limit?: number | null;
}

export interface RelationCondition {
  factKind: QueryFactKind;
  candidateRole: string;
  relatedRole: string;
  related: `${Owner}:${number}`;
  exists: boolean;
}

export interface UnderstandQuestion {
  schema: "atlas-question-v1";
  mode: "understand";
  anchor: `${Owner}:${number}`;
}

export interface CompareQuestion {
  schema: "atlas-question-v1";
  mode: "compare";
  left: `${Owner}:${number}`;
  right: `${Owner}:${number}`;
}

export interface ExplainQuestion {
  schema: "atlas-question-v1";
  mode: "explain";
  start: `${Owner}:${number}`;
  target: `${Owner}:${number}`;
  maxHops: number;
  maxPaths: number;
}

export interface AnalyzeQuestion {
  schema: "atlas-question-v1";
  mode: "analyze";
  owner: Owner;
  condition?: QuestionCondition;
  groupBy: string[];
  metrics: {
    name: string;
    function: AggregateFunction;
    field?: string;
  }[];
  orderBy?: OrderTerm[];
  limit?: number | null;
}

export type QuestionState =
  | FindQuestion
  | UnderstandQuestion
  | CompareQuestion
  | ExplainQuestion
  | AnalyzeQuestion;

function legacyBundle(sections: Record<string, QuerySection>): QueryBundle {
  return {
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections,
  };
}

const DEFAULT_COLUMNS: Record<Owner, string[]> = {
  subject: ["ref", "name", "nameCn", "type", "date", "score", "rank"],
  person: ["ref", "name", "type", "career", "comments", "collects"],
  character: ["ref", "name", "role", "comments", "collects"],
  episode: ["ref", "name", "nameCn", "type", "airdate", "duration"],
};

interface RelationTraversal {
  factKind: QueryFactKind;
  anchorRole: string;
  otherRoles: string[];
}

function relationsFor(owner: Owner): RelationTraversal[] {
  const result: RelationTraversal[] = [];
  for (const [factKind, fact] of Object.entries(QUERY_CONTRACT.facts) as [
    QueryFactKind,
    (typeof QUERY_CONTRACT.facts)[QueryFactKind],
  ][])
    for (const [anchorRole, roleOwner] of Object.entries(fact.roles))
      if (roleOwner === owner)
        result.push({
          factKind,
          anchorRole,
          otherRoles: Object.keys(fact.roles).filter((role) => role !== anchorRole),
        });
  return result;
}

function conditionExpression(
  owner: Owner,
  binding: string,
  condition: QuestionCondition,
): Expression {
  switch (condition.kind) {
    case "compare":
      fieldDefinition(owner, condition.field);
      return {
        kind: "compare",
        operator: condition.operator,
        left: { kind: "field", binding, field: condition.field },
        right: { kind: "literal", value: condition.value },
      };
    case "isNull":
    case "isMissing":
      fieldDefinition(owner, condition.field);
      return {
        kind: condition.kind,
        term: { kind: "field", binding, field: condition.field },
      };
    case "all":
    case "any":
      if (!condition.terms.length)
        throw new TypeError(`${condition.kind} condition cannot be empty`);
      return {
        kind: condition.kind === "all" ? "and" : "or",
        terms: condition.terms.map((term) =>
          conditionExpression(owner, binding, term),
        ),
      };
    case "not":
      return {
        kind: "not",
        term: conditionExpression(owner, binding, condition.term),
      };
  }
}

function baseOperators(
  owner: Owner,
  condition?: QuestionCondition,
  text?: string,
  textFields?: FindQuestion["textFields"],
): { operators: Record<string, QueryOperator>; root: string; binding: string } {
  const binding = "entity";
  const operators: Record<string, QueryOperator> = {};
  if (text?.trim()) {
    const fields = textFields ?? fieldsWithCapability(owner, "lookup");
    const fullText = fields.filter((field) =>
      field === "summary" || field === "description"
    ) as FullTextField[];
    if (fullText.length) {
      if (fields.length !== 1)
        throw new TypeError("full text and name lookup must be separate queries");
      assertFieldCapability(owner, fullText[0] as FullTextField, "fullText");
      operators.source = {
        kind: "fullText",
        target: "entity",
        owner,
        binding,
        field: fullText[0] as FullTextField,
        text: { kind: "literal", value: text.trim() },
      };
    } else {
      const lookupFields = fields as LookupField[];
      for (const field of lookupFields)
        assertFieldCapability(owner, field, "lookup");
      operators.source = {
        kind: "lookup",
        owner,
        binding,
        fields: lookupFields,
        text: { kind: "literal", value: text.trim() },
      };
    }
  } else operators.source = { kind: "scan", owner, binding };
  let root = "source";
  if (condition) {
    operators.filter = {
      kind: "filter",
      input: root,
      predicate: conditionExpression(owner, binding, condition),
    };
    root = "filter";
  }
  return { operators, root, binding };
}

function limit(value: number | null | undefined): number | null {
  if (value === undefined) return null;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError("question limit must be a non-negative integer");
  return value;
}

function findBundle(question: FindQuestion): QueryBundle {
  const { operators, root: baseRoot, binding } = baseOperators(
    question.owner,
    question.condition,
    question.text,
    question.textFields,
  );
  let root = baseRoot;
  for (const [index, relation] of (question.relations ?? []).entries()) {
    const fact = QUERY_CONTRACT.facts[relation.factKind];
    if (!fact) throw new TypeError(`unknown fact kind ${relation.factKind}`);
    if (fact.roles[relation.candidateRole] !== question.owner)
      throw new TypeError(`${relation.factKind}.${relation.candidateRole} does not bind ${question.owner}`);
    if (relation.candidateRole === relation.relatedRole)
      throw new TypeError("relation roles must be different");
    const relatedOwner = fact.roles[relation.relatedRole];
    if (!relatedOwner || parseEntityRef(relation.related).owner !== relatedOwner)
      throw new TypeError(`${relation.factKind}.${relation.relatedRole} has the wrong owner`);
    const prefix = `relation${index}`;
    const fixed = `${prefix}Fixed`;
    const candidate = `${prefix}Candidate`;
    const factBinding = `${prefix}Fact`;
    const roles = Object.fromEntries(
      Object.keys(fact.roles).map((role) => [
        role,
        role === relation.relatedRole
          ? fixed
          : role === relation.candidateRole
            ? candidate
            : `${prefix}${role}`,
      ]),
    );
    operators[`${prefix}Values`] = {
      kind: "values",
      columns: [fixed],
      types: { [fixed]: `entity:${relatedOwner}` },
      rows: [[relation.related]],
    };
    operators[`${prefix}Expand`] = {
      kind: "matchFact",
      input: `${prefix}Values`,
      factKind: relation.factKind,
      factBinding,
      roles,
    };
    operators[`${prefix}Project`] = {
      kind: "project",
      input: `${prefix}Expand`,
      columns: [{ name: "candidate", value: { kind: "column", name: candidate } }],
    };
    operators[`${prefix}Exists`] = {
      kind: relation.exists ? "exists" : "notExists",
      input: root,
      match: `${prefix}Project`,
      columns: [{ outer: binding, inner: "candidate" }],
    };
    root = `${prefix}Exists`;
  }
  const columns = question.columns ?? DEFAULT_COLUMNS[question.owner];
  if (!columns.length || new Set(columns).size !== columns.length)
    throw new TypeError("find columns must be non-empty and unique");
  operators.project = {
    kind: "project",
    input: root,
    columns: columns.map((field) => {
      fieldDefinition(question.owner, field);
      return {
        name: field,
        value: { kind: "field", binding, field },
      };
    }),
  };
  return legacyBundle({
      results: {
        query: {
          schema: "atlas-query-document-v2",
          root: "project",
          parameters: {},
          operators,
          orderBy: question.orderBy ?? [],
          limit: limit(question.limit),
        },
        answer: { shape: "entity-list", title: "符合条件的条目" },
      },
  });
}

function anchorOperator(ref: `${Owner}:${number}`): QueryOperator {
  const owner = parseEntityRef(ref).owner;
  return {
    kind: "values",
    columns: ["anchor"],
    types: { anchor: `entity:${owner}` },
    rows: [[ref]],
  };
}

function understandBundle(question: UnderstandQuestion): QueryBundle {
  const owner = parseEntityRef(question.anchor).owner;
  const sections: Record<string, QuerySection> = {
    details: {
      query: {
        schema: "atlas-query-document-v2",
        root: "project",
        parameters: {},
        operators: {
          anchor: anchorOperator(question.anchor),
          project: {
            kind: "project",
            input: "anchor",
            columns: DEFAULT_COLUMNS[owner].map((field) => ({
              name: field,
              value: { kind: "field", binding: "anchor", field },
            })),
          },
        },
        limit: 1,
      },
      answer: { shape: "entity-list", title: "条目档案" },
    },
  };
  for (const relation of relationsFor(owner)) {
    const roles = Object.fromEntries([
      [relation.anchorRole, "anchor"],
      ...relation.otherRoles.map((role) => [role, role]),
    ]);
    const key = `${relation.factKind}-${relation.anchorRole}`;
    sections[key] = {
      query: {
        schema: "atlas-query-document-v2",
        root: "matchFact",
        parameters: {},
        operators: {
          anchor: anchorOperator(question.anchor),
          matchFact: {
            kind: "matchFact",
            input: "anchor",
            factKind: relation.factKind,
            factBinding: "fact",
            roles,
          },
        },
        limit: null,
      },
      answer: {
        shape: "relation-group",
        title: `${relation.factKind} · ${relation.anchorRole}`,
      },
    };
  }
  return legacyBundle(sections);
}

function compareBundle(question: CompareQuestion): QueryBundle {
  return comparisonRecipe(question.left, question.right);
}

function explainBundle(question: ExplainQuestion): QueryBundle {
  return pathRecipe(question.start, question.target, {
    maxHops: question.maxHops,
    maxPaths: question.maxPaths,
  });
}

function analyzeBundle(question: AnalyzeQuestion): QueryBundle {
  const { operators, root, binding } = baseOperators(
    question.owner,
    question.condition,
  );
  for (const field of question.groupBy) fieldDefinition(question.owner, field);
  operators.aggregate = {
    kind: "aggregate",
    input: root,
    groupBy: question.groupBy.map((field) => ({
      name: field,
      value: { kind: "field", binding, field },
    })),
    metrics: question.metrics.map((metric) => {
      if (metric.field) fieldDefinition(question.owner, metric.field);
      return {
        name: metric.name,
        function: metric.function,
        ...(metric.field
          ? { value: { kind: "field" as const, binding, field: metric.field } }
          : {}),
      };
    }),
  };
  return legacyBundle({
      analysis: {
        query: {
          schema: "atlas-query-document-v2",
          root: "aggregate",
          parameters: {},
          operators,
          orderBy: question.orderBy ?? [],
          limit: limit(question.limit),
        },
        answer: { shape: "aggregate-table", title: "数据分布" },
      },
  });
}

export function compileQuestion(question: QuestionState): QueryBundle {
  if (question.schema !== "atlas-question-v1")
    throw new TypeError("unsupported question schema");
  switch (question.mode) {
    case "find":
      return findBundle(question);
    case "understand":
      return understandBundle(question);
    case "compare":
      return compareBundle(question);
    case "explain":
      return explainBundle(question);
    case "analyze":
      return analyzeBundle(question);
  }
}
