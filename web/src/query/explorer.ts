import {
  QUERY_CONTRACT,
  assertFieldCapability,
  fieldsWithCapability,
  parseEntityRef,
  type Owner,
  type QueryFactKind,
} from "./contract";
import type { QueryBundle } from "./bundle";
import type {
  Expression,
  FullTextField,
  LiteralValue,
  LookupField,
  OrderTerm,
  QueryDocument,
  QueryOperator,
} from "./document";
import type { CompareOperator } from "./value";

export type ExplorerCondition =
  | {
      kind: "compare";
      field: string;
      operator: CompareOperator;
      value: LiteralValue;
      negated?: boolean;
    }
  | {
      kind: "in";
      field: string;
      values: LiteralValue[];
      negated?: boolean;
    }
  | { kind: "isNull" | "isMissing"; field: string; negated?: boolean }
  | { kind: "all" | "any"; terms: ExplorerCondition[] }
  | { kind: "not"; term: ExplorerCondition };

export interface ExplorerRelation {
  factKind: QueryFactKind;
  candidateRole: string;
  relatedRole: string;
  related: `${Owner}:${number}`;
  exists: boolean;
}

export interface ExplorerQuery {
  owner: Owner;
  text?: {
    value: string;
    capability: "lookup" | "fullText";
    field?: FullTextField;
  };
  condition?: ExplorerCondition;
  relations?: ExplorerRelation[];
  columns?: string[];
  orderBy?: OrderTerm[];
  limit?: number | null;
}

export function explorerTextCriterion(
  value: string,
  capability: "lookup" | "fullText",
  field?: FullTextField,
): ExplorerQuery["text"] | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return {
    value: text,
    capability,
    ...(capability === "fullText" && field ? { field } : {}),
  };
}

const DEFAULT_COLUMNS: Record<Owner, string[]> = {
  subject: ["ref", "name", "nameCn", "type", "date", "score", "rank"],
  person: ["ref", "name", "type", "career", "comments", "collects"],
  character: ["ref", "name", "role", "comments", "collects"],
  episode: ["ref", "name", "nameCn", "type", "airdate", "duration"],
};

const QUERY_OPERATOR: Record<CompareOperator, string> = {
  eq: "=",
  ne: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  contains: "CONTAINS",
};

function queryLiteral(value: LiteralValue): string {
  if (typeof value === "string")
    return `'${value
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'")
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t")}'`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("查询数字必须是有限值");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return "NULL";
}

function conditionSource(condition: ExplorerCondition, parentPrecedence = 0): string {
  switch (condition.kind) {
    case "compare":
      return condition.negated
        ? `NOT (${condition.field} ${QUERY_OPERATOR[condition.operator]} ${queryLiteral(condition.value)})`
        : `${condition.field} ${QUERY_OPERATOR[condition.operator]} ${queryLiteral(condition.value)}`;
    case "in": {
      if (!condition.values.length) throw new TypeError("值集合不能为空");
      const source = `${condition.field} IN [${condition.values.map(queryLiteral).join(", ")}]`;
      return condition.negated ? `NOT (${source})` : source;
    }
    case "isNull":
      return condition.negated
        ? `NOT (${condition.field} IS NULL)`
        : `${condition.field} IS NULL`;
    case "isMissing":
      return condition.negated
        ? `NOT (${condition.field} IS MISSING)`
        : `${condition.field} IS MISSING`;
    case "not":
      return `NOT (${conditionSource(condition.term)})`;
    case "all":
    case "any": {
      if (!condition.terms.length) throw new TypeError("条件组不能为空");
      const precedence = condition.kind === "all" ? 2 : 1;
      const source = condition.terms
        .map((term) => conditionSource(term, precedence))
        .join(condition.kind === "all" ? " AND " : " OR ");
      return precedence < parentPrecedence ? `(${source})` : source;
    }
  }
}

function relationSource(
  owner: Owner,
  relation: ExplorerRelation,
  index: number,
): string {
  const fact = QUERY_CONTRACT.facts[relation.factKind];
  if (fact.roles[relation.candidateRole] !== owner)
    throw new TypeError("关系的候选角色类型不匹配");
  const relatedOwner = fact.roles[relation.relatedRole];
  if (
    relation.candidateRole === relation.relatedRole ||
    !relatedOwner ||
    parseEntityRef(relation.related).owner !== relatedOwner
  ) throw new TypeError("关系的固定端点类型不匹配");
  const related = `relation${index}_related`;
  const roles = [
    relation.relatedRole,
    relation.candidateRole,
    ...Object.keys(fact.roles).filter((role) =>
      role !== relation.relatedRole && role !== relation.candidateRole
    ),
  ].map((role) => {
    const variable = role === relation.candidateRole
      ? "item"
      : role === relation.relatedRole
        ? related
        : `relation${index}_${role}`;
    return `${role}: ${variable}`;
  });
  return `${relation.exists ? "" : "NOT "}EXISTS { MATCH ${relation.factKind}(${roles.join(", ")}) AS relation${index} WHERE ${related}.ref = ${queryLiteral(relation.related)} }`;
}

export function formatExplorerQuery(draft: ExplorerQuery): string {
  const lines = [`FIND ${draft.owner} AS item`];
  const text = draft.text?.value.trim();
  if (text) {
    if (draft.text?.capability === "fullText" && !draft.text.field)
      throw new TypeError("正文检索必须选择正文范围");
    lines.push(
      `SEARCH ${queryLiteral(text)}${draft.text?.capability === "fullText" ? ` IN ${draft.text.field}` : ""}`,
    );
  }
  const predicates = [
    ...(draft.condition ? [conditionSource(draft.condition)] : []),
    ...(draft.relations ?? []).map((relation, index) =>
      relationSource(draft.owner, relation, index)
    ),
  ];
  if (predicates.length)
    lines.push(`WHERE ${predicates.join("\n  AND ")}`);
  lines.push(`RETURN ${(draft.columns ?? DEFAULT_COLUMNS[draft.owner]).join(", ")}`);
  if (draft.orderBy?.length)
    lines.push(`ORDER BY ${draft.orderBy.map((order) =>
      `${order.column} ${order.direction.toUpperCase()} NULLS ${order.nulls.toUpperCase()}`
    ).join(", ")}`);
  const limit = draft.limit === undefined ? 200 : draft.limit;
  if (limit !== null) lines.push(`LIMIT ${limit}`);
  return lines.join("\n");
}

function conditionExpression(
  owner: Owner,
  binding: string,
  condition: ExplorerCondition,
): Expression {
  switch (condition.kind) {
    case "compare":
      assertFieldCapability(owner, condition.field, "filter");
      const comparison: Expression = {
        kind: "compare",
        operator: condition.operator,
        left: { kind: "field", binding, field: condition.field },
        right: { kind: "literal", value: condition.value },
      };
      return condition.negated ? { kind: "not", term: comparison } : comparison;
    case "in": {
      assertFieldCapability(owner, condition.field, "filter");
      if (!condition.values.length) throw new TypeError("值集合不能为空");
      const expression: Expression = {
        kind: "or",
        terms: condition.values.map((value) => ({
          kind: "compare",
          operator: "eq",
          left: { kind: "field", binding, field: condition.field },
          right: { kind: "literal", value },
        })),
      };
      return condition.negated ? { kind: "not", term: expression } : expression;
    }
    case "isNull":
    case "isMissing":
      assertFieldCapability(owner, condition.field, "filter");
      const presence: Expression = {
        kind: condition.kind,
        term: { kind: "field", binding, field: condition.field },
      };
      return condition.negated ? { kind: "not", term: presence } : presence;
    case "all":
    case "any":
      if (!condition.terms.length)
        throw new TypeError("条件组不能为空");
      return {
        kind: condition.kind === "all" ? "and" : "or",
        terms: condition.terms.map((term) =>
          conditionExpression(owner, binding, term)
        ),
      };
    case "not":
      return {
        kind: "not",
        term: conditionExpression(owner, binding, condition.term),
      };
  }
}

export function compileExplorerQuery(draft: ExplorerQuery): QueryBundle {
  const binding = "entity";
  const operators: Record<string, QueryOperator> = {};
  const text = draft.text?.value.trim();
  if (text && draft.text?.capability === "fullText") {
    if (!draft.text.field)
      throw new TypeError("正文检索必须选择正文范围");
    assertFieldCapability(draft.owner, draft.text.field, "fullText");
    operators.source = {
      kind: "fullText",
      target: "entity",
      owner: draft.owner,
      binding,
      field: draft.text.field,
      text: { kind: "literal", value: text },
    };
  } else if (text) {
    operators.source = {
      kind: "lookup",
      owner: draft.owner,
      binding,
      fields: fieldsWithCapability(draft.owner, "lookup") as LookupField[],
      text: { kind: "literal", value: text },
    };
  } else {
    operators.source = { kind: "scan", owner: draft.owner, binding };
  }
  let root = "source";
  if (draft.condition) {
    operators.filter = {
      kind: "filter",
      input: root,
      predicate: conditionExpression(draft.owner, binding, draft.condition),
    };
    root = "filter";
  }
  for (const [index, relation] of (draft.relations ?? []).entries()) {
    const fact = QUERY_CONTRACT.facts[relation.factKind];
    if (fact.roles[relation.candidateRole] !== draft.owner)
      throw new TypeError("关系的候选角色类型不匹配");
    const relatedOwner = fact.roles[relation.relatedRole];
    if (
      relation.candidateRole === relation.relatedRole ||
      !relatedOwner ||
      parseEntityRef(relation.related).owner !== relatedOwner
    )
      throw new TypeError("关系的固定端点类型不匹配");
    const prefix = `relation${index}`;
    const fixed = `${prefix}Fixed`;
    const candidate = `${prefix}Candidate`;
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
    operators[`${prefix}Match`] = {
      kind: "matchFact",
      input: `${prefix}Values`,
      factKind: relation.factKind,
      factBinding: `${prefix}Fact`,
      roles,
    };
    operators[`${prefix}Project`] = {
      kind: "project",
      input: `${prefix}Match`,
      columns: [{
        name: "candidate",
        value: { kind: "column", name: candidate },
      }],
    };
    operators[`${prefix}Exists`] = {
      kind: relation.exists ? "exists" : "notExists",
      input: root,
      match: `${prefix}Project`,
      columns: [{ outer: binding, inner: "candidate" }],
    };
    root = `${prefix}Exists`;
  }
  const columns = draft.columns ?? DEFAULT_COLUMNS[draft.owner];
  if (!columns.length || new Set(columns).size !== columns.length)
    throw new TypeError("结果列必须非空且唯一");
  operators.project = {
    kind: "project",
    input: root,
    columns: columns.map((field) => {
      assertFieldCapability(draft.owner, field, "project");
      return {
        name: field,
        value: { kind: "field" as const, binding, field },
      };
    }),
  };
  const limit = draft.limit === undefined ? 200 : draft.limit;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000))
    throw new TypeError("结果上限必须在 0 到 10000 之间");
  return {
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: {
      results: {
        query: {
          schema: "atlas-query-document-v2",
          root: "project",
          parameters: {},
          operators,
          orderBy: draft.orderBy ?? [],
          limit,
        },
        answer: { shape: "entity-list", title: "探索结果" },
      },
    },
  };
}

function literalText(expression: Expression): string | null {
  return expression.kind === "literal" && typeof expression.value === "string"
    ? expression.value
    : null;
}

function explorerInCondition(
  expression: Expression,
  binding: string,
): Extract<ExplorerCondition, { kind: "in" }> | null {
  if (expression.kind !== "or" || !expression.terms.length) return null;
  let field: string | undefined;
  const values: LiteralValue[] = [];
  for (const term of expression.terms) {
    if (
      term.kind !== "compare" ||
      term.operator !== "eq" ||
      term.left.kind !== "field" ||
      term.left.binding !== binding ||
      term.right.kind !== "literal"
    ) return null;
    if (field !== undefined && field !== term.left.field) return null;
    field = term.left.field;
    values.push(term.right.value);
  }
  return field === undefined ? null : { kind: "in", field, values };
}

function explorerCondition(expression: Expression, binding: string): ExplorerCondition | null {
  if (
    expression.kind === "compare" &&
    expression.left.kind === "field" &&
    expression.left.binding === binding &&
    expression.right.kind === "literal"
  )
    return {
      kind: "compare",
      field: expression.left.field,
      operator: expression.operator,
      value: expression.right.value,
    };
  if (
    (expression.kind === "isNull" || expression.kind === "isMissing") &&
    expression.term.kind === "field" &&
    expression.term.binding === binding
  )
    return { kind: expression.kind, field: expression.term.field };
  if (expression.kind === "and" || expression.kind === "or") {
    const inCondition = explorerInCondition(expression, binding);
    if (inCondition) return inCondition;
    const terms = expression.terms.map((term) => explorerCondition(term, binding));
    if (terms.some((term) => term === null)) return null;
    return {
      kind: expression.kind === "and" ? "all" : "any",
      terms: terms as ExplorerCondition[],
    };
  }
  if (expression.kind === "not") {
    const inCondition = explorerInCondition(expression.term, binding);
    if (inCondition) return { ...inCondition, negated: true };
    const term = explorerCondition(expression.term, binding);
    if (!term) return null;
    if (
      term.kind === "compare" ||
      term.kind === "isNull" ||
      term.kind === "isMissing"
    ) return { ...term, negated: true };
    return { kind: "not", term };
  }
  return null;
}

function sourceExplorerRelation(
  query: QueryDocument,
  operator: Extract<QueryOperator, { kind: "exists" | "notExists" }>,
  binding: string,
): ExplorerRelation | null {
  if (
    operator.columns.length !== 1 ||
    operator.columns[0]?.outer !== binding
  ) return null;
  const innerBinding = operator.columns[0].inner;
  const fixedFilter = query.operators[operator.match];
  if (
    fixedFilter?.kind !== "filter" ||
    fixedFilter.predicate.kind !== "compare" ||
    fixedFilter.predicate.operator !== "eq" ||
    fixedFilter.predicate.left.kind !== "field" ||
    fixedFilter.predicate.left.field !== "ref" ||
    fixedFilter.predicate.right.kind !== "literal" ||
    typeof fixedFilter.predicate.right.value !== "string"
  ) return null;
  const fixedBinding = fixedFilter.predicate.left.binding;
  const relatedRef = fixedFilter.predicate.right.value;
  const match = query.operators[fixedFilter.input];
  if (match?.kind !== "matchFact") return null;
  const candidateRole = Object.entries(match.roles)
    .find(([, roleBinding]) => roleBinding === innerBinding)?.[0];
  const relatedRole = Object.entries(match.roles)
    .find(([, roleBinding]) => roleBinding === fixedBinding)?.[0];
  if (!candidateRole || !relatedRole || candidateRole === relatedRole) return null;
  let related: ReturnType<typeof parseEntityRef>;
  try {
    related = parseEntityRef(relatedRef);
  } catch {
    return null;
  }
  const fact = QUERY_CONTRACT.facts[match.factKind];
  if (fact.roles[relatedRole] !== related.owner) return null;
  return {
    factKind: match.factKind,
    candidateRole,
    relatedRole,
    related: relatedRef as ExplorerRelation["related"],
    exists: operator.kind === "exists",
  };
}

/** Recover the ordinary editor state only when the plan is exactly representable. */
export function decompileExplorerQuery(bundle: QueryBundle): ExplorerQuery | null {
  const section = Object.keys(bundle.sections).length === 1
    ? bundle.sections.results
    : undefined;
  if (!section) return null;
  const query = section.query;
  const project = query.operators[query.root];
  if (project?.kind !== "project") return null;
  const projectedFields = project.columns.map((column) =>
    column.value.kind === "field" ? column.value : null
  );
  if (projectedFields.some((field) => field === null)) return null;
  const binding = projectedFields[0]?.binding;
  if (!binding || projectedFields.some((field) => field?.binding !== binding)) return null;
  const conditions: ExplorerCondition[] = [];
  const relations: ExplorerRelation[] = [];
  let current = project.input;
  while (true) {
    const operator = query.operators[current];
    if (!operator) return null;
    if (operator.kind === "filter") {
      const condition = explorerCondition(operator.predicate, binding);
      if (!condition) return null;
      conditions.push(condition);
      current = operator.input;
      continue;
    }
    if (operator.kind === "exists" || operator.kind === "notExists") {
      const matchProject = query.operators[operator.match];
      if (matchProject?.kind === "project" && matchProject.columns.length === 1) {
        const candidate = matchProject.columns[0]?.value;
        const match = query.operators[matchProject.input];
        if (candidate?.kind !== "column" || match?.kind !== "matchFact") return null;
        const values = query.operators[match.input];
        if (values?.kind !== "values" || values.columns.length !== 1 || values.rows.length !== 1)
          return null;
        const fixed = values.columns[0] as string;
        const related = values.rows[0]?.[0];
        const candidateRole = Object.entries(match.roles)
          .find(([, roleBinding]) => roleBinding === candidate.name)?.[0];
        const relatedRole = Object.entries(match.roles)
          .find(([, roleBinding]) => roleBinding === fixed)?.[0];
        if (
          !candidateRole || !relatedRole || typeof related !== "string" ||
          !related.includes(":")
        ) return null;
        relations.push({
          factKind: match.factKind,
          candidateRole,
          relatedRole,
          related: related as ExplorerRelation["related"],
          exists: operator.kind === "exists",
        });
      } else {
        const relation = sourceExplorerRelation(query, operator, binding);
        if (!relation) return null;
        relations.push(relation);
      }
      current = operator.input;
      continue;
    }
    let owner: Owner;
    let text: ExplorerQuery["text"];
    if (operator.kind === "scan") owner = operator.owner;
    else if (operator.kind === "lookup") {
      const value = literalText(operator.text);
      if (value === null) return null;
      owner = operator.owner;
      text = { value, capability: "lookup" };
    } else if (operator.kind === "fullText" && operator.target === "entity") {
      const value = literalText(operator.text);
      if (value === null) return null;
      owner = operator.owner;
      text = { value, capability: "fullText", field: operator.field };
    } else return null;
    if (operator.binding !== binding) return null;
    return {
      owner,
      ...(text ? { text } : {}),
      ...(conditions.length
        ? { condition: conditions.length === 1 ? conditions[0] : { kind: "all", terms: conditions } }
        : {}),
      ...(relations.length ? { relations: relations.reverse() } : {}),
      columns: projectedFields.map((field) => field?.field as string),
      orderBy: query.orderBy ?? [],
      limit: query.limit,
    };
  }
}
