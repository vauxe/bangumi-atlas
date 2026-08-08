import {
  QUERY_CONTRACT,
  assertFactFieldCapability,
  assertFieldCapability,
  factFieldDefinition,
  fieldDefinition,
  fieldsWithCapability,
  parseEntityRef,
  type Owner,
  type QueryFactKind,
} from "./contract";
import type { QueryBundle } from "./bundle";
import type {
  Expression,
  AggregateFunction,
  FullTextField,
  LiteralValue,
  LookupField,
  OrderTerm,
  ParameterType,
  ParameterValues,
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
      parameter?: string;
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
  /** Predicates over the relationship fact itself (role, position, etc.). */
  condition?: ExplorerCondition;
}

export interface ExplorerQuery {
  owner: Owner;
  text?: {
    value: string;
    parameter?: string;
    capability: "lookup" | "fullText";
    field?: FullTextField;
  };
  condition?: ExplorerCondition;
  relations?: ExplorerRelation[];
  aggregate?: ExplorerAggregate;
  columns?: string[];
  orderBy?: OrderTerm[];
  limit?: number | null;
}

export interface ExplorerAggregateMetric {
  function: AggregateFunction;
  field?: string;
}

export interface ExplorerAggregate {
  groupBy: string[];
  metrics: ExplorerAggregateMetric[];
  /** Conditions over generated statistic column names. */
  having?: ExplorerCondition;
}

export function explorerMetricName(metric: ExplorerAggregateMetric): string {
  return metric.field ? `${metric.function}_${metric.field}` : metric.function;
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

function queryInput(value: LiteralValue, parameter?: string): string {
  return parameter ? `$${parameter}` : queryLiteral(value);
}

function conditionSource(
  condition: ExplorerCondition,
  parentPrecedence = 0,
  fieldName: (field: string) => string = (field) => field,
): string {
  switch (condition.kind) {
    case "compare":
      return condition.negated
        ? `NOT (${fieldName(condition.field)} ${QUERY_OPERATOR[condition.operator]} ${queryInput(condition.value, condition.parameter)})`
        : `${fieldName(condition.field)} ${QUERY_OPERATOR[condition.operator]} ${queryInput(condition.value, condition.parameter)}`;
    case "in": {
      if (!condition.values.length) throw new TypeError("值集合不能为空");
      const source = `${fieldName(condition.field)} IN [${condition.values.map(queryLiteral).join(", ")}]`;
      return condition.negated ? `NOT (${source})` : source;
    }
    case "isNull":
      return condition.negated
        ? `NOT (${fieldName(condition.field)} IS NULL)`
        : `${fieldName(condition.field)} IS NULL`;
    case "isMissing":
      return condition.negated
        ? `NOT (${fieldName(condition.field)} IS MISSING)`
        : `${fieldName(condition.field)} IS MISSING`;
    case "not":
      return `NOT (${conditionSource(condition.term, 0, fieldName)})`;
    case "all":
    case "any": {
      if (!condition.terms.length) throw new TypeError("条件组不能为空");
      const precedence = condition.kind === "all" ? 2 : 1;
      const source = condition.terms
        .map((term) => conditionSource(term, precedence, fieldName))
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
  const predicates = [
    `${related}.ref = ${queryLiteral(relation.related)}`,
    ...(relation.condition
      ? [conditionSource(
          relation.condition,
          0,
          (field) => `relation${index}.${field}`,
        )]
      : []),
  ];
  return `${relation.exists ? "" : "NOT "}EXISTS { MATCH ${relation.factKind}(${roles.join(", ")}) AS relation${index} WHERE ${predicates.join(" AND ")} }`;
}

export function formatExplorerQuery(draft: ExplorerQuery): string {
  const lines = [`FIND ${draft.owner} AS item`];
  const text = draft.text?.value.trim();
  if (text) {
    if (draft.text?.capability === "fullText" && !draft.text.field)
      throw new TypeError("正文检索必须选择正文范围");
    lines.push(
      `SEARCH ${queryInput(text, draft.text?.parameter)}${draft.text?.capability === "fullText" ? ` IN ${draft.text.field}` : ""}`,
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
  if (draft.aggregate) {
    if (!draft.aggregate.metrics.length)
      throw new TypeError("统计至少需要一个指标");
    lines.push(`RETURN ${[
      ...draft.aggregate.groupBy,
      ...draft.aggregate.metrics.map((metric) =>
        `${metric.function === "countDistinct" ? "COUNT" : metric.function.toUpperCase()}(${metric.function === "countDistinct" ? `DISTINCT ${metric.field ?? "*"}` : metric.field ?? "*"}) AS ${explorerMetricName(metric)}`
      ),
    ].join(", ")}`);
    if (draft.aggregate.groupBy.length)
      lines.push(`GROUP BY ${draft.aggregate.groupBy.join(", ")}`);
    if (draft.aggregate.having)
      lines.push(`HAVING ${conditionSource(draft.aggregate.having)}`);
  } else {
    lines.push(`RETURN ${(draft.columns ?? DEFAULT_COLUMNS[draft.owner]).join(", ")}`);
  }
  if (draft.orderBy?.length)
    lines.push(`ORDER BY ${draft.orderBy.map((order) =>
      `${order.column} ${order.direction.toUpperCase()} NULLS ${order.nulls.toUpperCase()}`
    ).join(", ")}`);
  const limit = draft.limit ?? null;
  if (limit !== null) lines.push(`LIMIT ${limit}`);
  return lines.join("\n");
}

interface ParameterCollector {
  types: Record<string, ParameterType>;
  values: ParameterValues;
}

function parameterTypeFor(value: LiteralValue, declaredType?: string): ParameterType {
  if (declaredType?.startsWith("entity:")) return declaredType as ParameterType;
  if (declaredType === "fact-ref") return "fact-ref";
  if (declaredType === "number") return "number";
  if (declaredType === "integer") return "integer";
  if (declaredType === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isSafeInteger(value) ? "integer" : "number";
  throw new TypeError("空值不能作为可复用参数");
}

function inputExpression(
  value: LiteralValue,
  parameter: string | undefined,
  collector: ParameterCollector,
  declaredType?: string,
): Expression {
  if (!parameter) return { kind: "literal", value };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter))
    throw new TypeError("参数名只能使用英文字母、数字和下划线，且不能以数字开头");
  const type = parameterTypeFor(value, declaredType);
  const previousType = collector.types[parameter];
  const previousValue = collector.values[parameter];
  if (
    previousType && previousType !== type &&
    !([previousType, type].includes("number") && [previousType, type].every((item) =>
      item === "number" || item === "integer"
    ))
  ) throw new TypeError(`参数 ${parameter} 被用于不兼容的值类型`);
  if (Object.hasOwn(collector.values, parameter) && !Object.is(previousValue, value))
    throw new TypeError(`参数 ${parameter} 的值必须保持一致`);
  collector.types[parameter] = previousType === "number" || type === "number"
    ? "number"
    : type;
  collector.values[parameter] = value;
  return { kind: "parameter", name: parameter };
}

function conditionExpression(
  owner: Owner,
  binding: string,
  condition: ExplorerCondition,
  collector: ParameterCollector,
): Expression {
  switch (condition.kind) {
    case "compare":
      assertFieldCapability(owner, condition.field, "filter");
      const comparison: Expression = {
        kind: "compare",
        operator: condition.operator,
        left: { kind: "field", binding, field: condition.field },
        right: inputExpression(
          condition.value,
          condition.parameter,
          collector,
          fieldDefinition(owner, condition.field).type,
        ),
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
          conditionExpression(owner, binding, term, collector)
        ),
      };
    case "not":
      return {
        kind: "not",
        term: conditionExpression(owner, binding, condition.term, collector),
      };
  }
}

function factConditionExpression(
  kind: QueryFactKind,
  binding: string,
  condition: ExplorerCondition,
  collector: ParameterCollector,
): Expression {
  switch (condition.kind) {
    case "compare": {
      assertFactFieldCapability(kind, condition.field, "filter");
      const comparison: Expression = {
        kind: "compare",
        operator: condition.operator,
        left: { kind: "field", binding, field: condition.field },
        right: inputExpression(
          condition.value,
          condition.parameter,
          collector,
          factFieldDefinition(kind, condition.field).type,
        ),
      };
      return condition.negated ? { kind: "not", term: comparison } : comparison;
    }
    case "in": {
      assertFactFieldCapability(kind, condition.field, "filter");
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
    case "isMissing": {
      assertFactFieldCapability(kind, condition.field, "filter");
      const presence: Expression = {
        kind: condition.kind,
        term: { kind: "field", binding, field: condition.field },
      };
      return condition.negated ? { kind: "not", term: presence } : presence;
    }
    case "all":
    case "any":
      if (!condition.terms.length) throw new TypeError("条件组不能为空");
      return {
        kind: condition.kind === "all" ? "and" : "or",
        terms: condition.terms.map((term) =>
          factConditionExpression(kind, binding, term, collector)
        ),
      };
    case "not":
      return {
        kind: "not",
        term: factConditionExpression(kind, binding, condition.term, collector),
      };
  }
}

function columnConditionExpression(
  condition: ExplorerCondition,
  collector: ParameterCollector,
): Expression {
  switch (condition.kind) {
    case "compare": {
      const comparison: Expression = {
        kind: "compare",
        operator: condition.operator,
        left: { kind: "column", name: condition.field },
        right: inputExpression(
          condition.value,
          condition.parameter,
          collector,
        ),
      };
      return condition.negated ? { kind: "not", term: comparison } : comparison;
    }
    case "in": {
      if (!condition.values.length) throw new TypeError("值集合不能为空");
      const expression: Expression = {
        kind: "or",
        terms: condition.values.map((value) => ({
          kind: "compare",
          operator: "eq",
          left: { kind: "column", name: condition.field },
          right: { kind: "literal", value },
        })),
      };
      return condition.negated ? { kind: "not", term: expression } : expression;
    }
    case "isNull":
    case "isMissing": {
      const presence: Expression = {
        kind: condition.kind,
        term: { kind: "column", name: condition.field },
      };
      return condition.negated ? { kind: "not", term: presence } : presence;
    }
    case "all":
    case "any":
      if (!condition.terms.length) throw new TypeError("条件组不能为空");
      return {
        kind: condition.kind === "all" ? "and" : "or",
        terms: condition.terms.map((term) =>
          columnConditionExpression(term, collector)
        ),
      };
    case "not":
      return {
        kind: "not",
        term: columnConditionExpression(condition.term, collector),
      };
  }
}

export function compileExplorerQuery(draft: ExplorerQuery): QueryBundle {
  const binding = "entity";
  const operators: Record<string, QueryOperator> = {};
  const parameters: ParameterCollector = { types: {}, values: {} };
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
      text: inputExpression(text, draft.text.parameter, parameters, "string"),
    };
  } else if (text) {
    operators.source = {
      kind: "lookup",
      owner: draft.owner,
      binding,
      fields: fieldsWithCapability(draft.owner, "lookup") as LookupField[],
      text: inputExpression(text, draft.text?.parameter, parameters, "string"),
    };
  } else {
    operators.source = { kind: "scan", owner: draft.owner, binding };
  }
  let root = "source";
  if (draft.condition) {
    operators.filter = {
      kind: "filter",
      input: root,
      predicate: conditionExpression(
        draft.owner,
        binding,
        draft.condition,
        parameters,
      ),
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
    const matchRoot = relation.condition ? `${prefix}Filter` : `${prefix}Match`;
    if (relation.condition) {
      operators[matchRoot] = {
        kind: "filter",
        input: `${prefix}Match`,
        predicate: factConditionExpression(
          relation.factKind,
          `${prefix}Fact`,
          relation.condition,
          parameters,
        ),
      };
    }
    operators[`${prefix}Project`] = {
      kind: "project",
      input: matchRoot,
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
  let answerShape: "entity-list" | "aggregate-table" = "entity-list";
  if (draft.aggregate) {
    const { groupBy, metrics } = draft.aggregate;
    if (!metrics.length) throw new TypeError("统计至少需要一个指标");
    if (new Set(groupBy).size !== groupBy.length)
      throw new TypeError("统计分组字段不能重复");
    const metricNames = metrics.map(explorerMetricName);
    if (new Set(metricNames).size !== metricNames.length)
      throw new TypeError("统计指标不能重复");
    for (const field of groupBy)
      assertFieldCapability(draft.owner, field, "group");
    operators.aggregate = {
      kind: "aggregate",
      input: root,
      groupBy: groupBy.map((field) => ({
        name: field,
        value: { kind: "field", binding, field },
      })),
      metrics: metrics.map((metric) => {
        if (metric.function !== "count" && !metric.field)
          throw new TypeError("该统计指标必须选择字段");
        if (metric.field)
          assertFieldCapability(draft.owner, metric.field, "aggregate");
        return {
          name: explorerMetricName(metric),
          function: metric.function,
          ...(metric.field
            ? { value: { kind: "field" as const, binding, field: metric.field } }
            : {}),
        };
      }),
    };
    root = "aggregate";
    if (draft.aggregate.having) {
      operators.having = {
        kind: "filter",
        input: root,
        predicate: columnConditionExpression(
          draft.aggregate.having,
          parameters,
        ),
      };
      root = "having";
    }
    answerShape = "aggregate-table";
  } else {
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
    root = "project";
  }
  const limit = draft.limit ?? null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0))
    throw new TypeError("结果条数必须是非负整数");
  return {
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: {
      results: {
        query: {
          schema: "atlas-query-document-v2",
          root,
          parameters: parameters.types,
          operators,
          orderBy: draft.orderBy ?? [],
          limit,
        },
        answer: {
          shape: answerShape,
          title: answerShape === "aggregate-table" ? "统计结果" : "探索结果",
        },
        ...(Object.keys(parameters.values).length
          ? { parameterValues: parameters.values }
          : {}),
      },
    },
  };
}

function expressionInput(
  expression: Expression,
  parameters: ParameterValues,
): { value: LiteralValue; parameter?: string } | null {
  if (expression.kind === "literal") return { value: expression.value };
  if (
    expression.kind === "parameter" &&
    Object.hasOwn(parameters, expression.name) &&
    parameters[expression.name] !== undefined
  ) return {
    value: parameters[expression.name] as LiteralValue,
    parameter: expression.name,
  };
  return null;
}

function textInput(
  expression: Expression,
  parameters: ParameterValues,
): { value: string; parameter?: string } | null {
  const input = expressionInput(expression, parameters);
  return input && typeof input.value === "string"
    ? { value: input.value, ...(input.parameter ? { parameter: input.parameter } : {}) }
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

function explorerConditionWithParameters(
  expression: Expression,
  binding: string,
  parameters: ParameterValues,
): ExplorerCondition | null {
  const input = expression.kind === "compare"
    ? expressionInput(expression.right, parameters)
    : null;
  if (
    expression.kind === "compare" &&
    expression.left.kind === "field" &&
    expression.left.binding === binding &&
    input
  )
    return {
      kind: "compare",
      field: expression.left.field,
      operator: expression.operator,
      value: input.value,
      ...(input.parameter ? { parameter: input.parameter } : {}),
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
    const terms = expression.terms.map((term) =>
      explorerConditionWithParameters(term, binding, parameters)
    );
    if (terms.some((term) => term === null)) return null;
    return {
      kind: expression.kind === "and" ? "all" : "any",
      terms: terms as ExplorerCondition[],
    };
  }
  if (expression.kind === "not") {
    const inCondition = explorerInCondition(expression.term, binding);
    if (inCondition) return { ...inCondition, negated: true };
    const term = explorerConditionWithParameters(expression.term, binding, parameters);
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

function explorerColumnInCondition(
  expression: Expression,
): Extract<ExplorerCondition, { kind: "in" }> | null {
  if (expression.kind !== "or" || !expression.terms.length) return null;
  let field: string | undefined;
  const values: LiteralValue[] = [];
  for (const term of expression.terms) {
    if (
      term.kind !== "compare" || term.operator !== "eq" ||
      term.left.kind !== "column" || term.right.kind !== "literal"
    ) return null;
    if (field !== undefined && field !== term.left.name) return null;
    field = term.left.name;
    values.push(term.right.value);
  }
  return field === undefined ? null : { kind: "in", field, values };
}

function explorerColumnCondition(
  expression: Expression,
  parameters: ParameterValues = {},
): ExplorerCondition | null {
  const input = expression.kind === "compare"
    ? expressionInput(expression.right, parameters)
    : null;
  if (
    expression.kind === "compare" && expression.left.kind === "column" &&
    input
  ) return {
    kind: "compare",
    field: expression.left.name,
    operator: expression.operator,
    value: input.value,
    ...(input.parameter ? { parameter: input.parameter } : {}),
  };
  if (
    (expression.kind === "isNull" || expression.kind === "isMissing") &&
    expression.term.kind === "column"
  ) return { kind: expression.kind, field: expression.term.name };
  if (expression.kind === "and" || expression.kind === "or") {
    const inCondition = explorerColumnInCondition(expression);
    if (inCondition) return inCondition;
    const terms = expression.terms.map((term) =>
      explorerColumnCondition(term, parameters)
    );
    if (terms.some((term) => term === null)) return null;
    return {
      kind: expression.kind === "and" ? "all" : "any",
      terms: terms as ExplorerCondition[],
    };
  }
  if (expression.kind === "not") {
    const inCondition = explorerColumnInCondition(expression.term);
    if (inCondition) return { ...inCondition, negated: true };
    const term = explorerColumnCondition(expression.term, parameters);
    if (!term) return null;
    if (
      term.kind === "compare" || term.kind === "isNull" ||
      term.kind === "isMissing"
    ) return { ...term, negated: true };
    return { kind: "not", term };
  }
  return null;
}

function sourceBinding(query: QueryDocument, root: string): string | null {
  const visited = new Set<string>();
  let current = root;
  while (!visited.has(current)) {
    visited.add(current);
    const operator = query.operators[current];
    if (!operator) return null;
    if (
      operator.kind === "scan" || operator.kind === "lookup" ||
      (operator.kind === "fullText" && operator.target === "entity")
    ) return operator.binding;
    if (
      operator.kind === "filter" || operator.kind === "project" ||
      operator.kind === "exists" || operator.kind === "notExists"
    ) {
      current = operator.input;
      continue;
    }
    return null;
  }
  return null;
}

function editableRelationCondition(condition: ExplorerCondition): boolean {
  if (condition.kind === "all")
    return condition.terms.length > 0 && condition.terms.every(editableRelationCondition);
  if (condition.kind === "any" || condition.kind === "not") return false;
  return condition.kind !== "compare" ||
    !condition.negated || condition.operator === "contains";
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
  const parameterValues = section.parameterValues ?? {};
  const root = query.operators[query.root];
  let aggregate: ExplorerAggregate | undefined;
  let projectedFields: Array<Extract<Expression, { kind: "field" }>> | undefined;
  let binding: string | null;
  let current: string;
  const possibleAggregate = root?.kind === "filter"
    ? query.operators[root.input]
    : root;
  if (possibleAggregate?.kind === "aggregate") {
    let having: ExplorerCondition | undefined;
    if (root?.kind === "filter") {
      having = explorerColumnCondition(root.predicate, parameterValues) ?? undefined;
      if (!having) return null;
    }
    binding = sourceBinding(query, possibleAggregate.input);
    if (!binding) return null;
    const groupBy = possibleAggregate.groupBy.map((group) =>
      group.value.kind === "field" && group.value.binding === binding &&
        group.name === group.value.field
        ? group.value.field
        : null
    );
    if (groupBy.some((field) => field === null)) return null;
    const metrics: ExplorerAggregateMetric[] = [];
    for (const metric of possibleAggregate.metrics) {
      if (metric.value) {
        if (metric.value.kind !== "field" || metric.value.binding !== binding)
          return null;
        const candidate = { function: metric.function, field: metric.value.field };
        if (metric.name !== explorerMetricName(candidate)) return null;
        metrics.push(candidate);
      } else {
        const candidate = { function: metric.function };
        if (metric.name !== explorerMetricName(candidate)) return null;
        metrics.push(candidate);
      }
    }
    aggregate = {
      groupBy: groupBy as string[],
      metrics,
      ...(having ? { having } : {}),
    };
    current = possibleAggregate.input;
  } else {
    if (root?.kind !== "project") return null;
    const fields = root.columns.map((column) =>
      column.value.kind === "field" ? column.value : null
    );
    if (fields.some((field) => field === null)) return null;
    projectedFields = fields as Array<Extract<Expression, { kind: "field" }>>;
    binding = projectedFields[0]?.binding ?? null;
    if (!binding || projectedFields.some((field) => field.binding !== binding)) return null;
    current = root.input;
  }
  const conditions: ExplorerCondition[] = [];
  const relations: ExplorerRelation[] = [];
  while (true) {
    const operator = query.operators[current];
    if (!operator) return null;
    if (operator.kind === "filter") {
      const condition = explorerConditionWithParameters(
        operator.predicate,
        binding,
        parameterValues,
      );
      if (!condition) return null;
      conditions.push(condition);
      current = operator.input;
      continue;
    }
    if (operator.kind === "exists" || operator.kind === "notExists") {
      const matchProject = query.operators[operator.match];
      if (matchProject?.kind === "project" && matchProject.columns.length === 1) {
        const candidate = matchProject.columns[0]?.value;
        const possibleFilter = query.operators[matchProject.input];
        const match = possibleFilter?.kind === "filter"
          ? query.operators[possibleFilter.input]
          : possibleFilter;
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
        let factCondition: ExplorerCondition | undefined;
        if (possibleFilter?.kind === "filter") {
          const condition = explorerConditionWithParameters(
            possibleFilter.predicate,
            match.factBinding,
            parameterValues,
          );
          if (!condition || !editableRelationCondition(condition)) return null;
          factCondition = condition;
        }
        relations.push({
          factKind: match.factKind,
          candidateRole,
          relatedRole,
          related: related as ExplorerRelation["related"],
          exists: operator.kind === "exists",
          ...(factCondition ? { condition: factCondition } : {}),
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
      const value = textInput(operator.text, parameterValues);
      if (value === null) return null;
      owner = operator.owner;
      text = {
        value: value.value,
        capability: "lookup",
        ...(value.parameter ? { parameter: value.parameter } : {}),
      };
    } else if (operator.kind === "fullText" && operator.target === "entity") {
      const value = textInput(operator.text, parameterValues);
      if (value === null) return null;
      owner = operator.owner;
      text = {
        value: value.value,
        capability: "fullText",
        field: operator.field,
        ...(value.parameter ? { parameter: value.parameter } : {}),
      };
    } else return null;
    if (operator.binding !== binding) return null;
    const columns = projectedFields?.map((field) => field.field) ?? [];
    const usesDefaultColumns = columns.length === DEFAULT_COLUMNS[owner].length &&
      columns.every((field, index) => field === DEFAULT_COLUMNS[owner][index]);
    return {
      owner,
      ...(text ? { text } : {}),
      ...(conditions.length
        ? { condition: conditions.length === 1 ? conditions[0] : { kind: "all", terms: conditions } }
        : {}),
      ...(relations.length ? { relations: relations.reverse() } : {}),
      ...(aggregate
        ? { aggregate }
        : usesDefaultColumns ? {} : { columns }),
      orderBy: query.orderBy ?? [],
      ...(query.limit === null ? {} : { limit: query.limit }),
    };
  }
}
