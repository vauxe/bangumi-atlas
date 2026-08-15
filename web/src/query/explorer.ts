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
import { defaultResultProjection } from "./result-columns";

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
  /** Other fixed roles on the same fact (for example a voice credit's work). */
  additionalEndpoints?: ExplorerRelationEndpoint[];
  exists: boolean;
  /** Predicates over the relationship fact itself (role, position, etc.). */
  condition?: ExplorerCondition;
}

export interface ExplorerRelationEndpoint {
  role: string;
  related: `${Owner}:${number}`;
}

export interface ExplorerQuery {
  owner: Owner;
  text?: {
    value: string;
    parameter?: string;
    capability: "lookup";
  };
  fullText?: {
    value: string;
    parameter?: string;
    field: FullTextField;
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

function relationEndpoints(
  relation: ExplorerRelation,
): Array<ExplorerRelationEndpoint & { owner: Owner }> {
  const fact = QUERY_CONTRACT.facts[relation.factKind];
  const endpoints: ExplorerRelationEndpoint[] = [
    { role: relation.relatedRole, related: relation.related },
    ...(relation.additionalEndpoints ?? []),
  ];
  const seen = new Set<string>();
  return endpoints.map((endpoint) => {
    const expectedOwner = fact.roles[endpoint.role];
    if (
      endpoint.role === relation.candidateRole ||
      !expectedOwner ||
      seen.has(endpoint.role) ||
      parseEntityRef(endpoint.related).owner !== expectedOwner
    ) throw new TypeError("关系的固定端点类型不匹配");
    seen.add(endpoint.role);
    return { ...endpoint, owner: expectedOwner };
  });
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

interface ConditionTarget {
  expression: Expression;
  declaredType?: string;
}

function buildConditionExpression(
  condition: ExplorerCondition,
  collector: ParameterCollector,
  resolveTarget: (field: string) => ConditionTarget,
): Expression {
  switch (condition.kind) {
    case "compare": {
      const target = resolveTarget(condition.field);
      const comparison: Expression = {
        kind: "compare",
        operator: condition.operator,
        left: target.expression,
        right: inputExpression(
          condition.value,
          condition.parameter,
          collector,
          target.declaredType,
        ),
      };
      return condition.negated ? { kind: "not", term: comparison } : comparison;
    }
    case "in": {
      const target = resolveTarget(condition.field);
      if (!condition.values.length) throw new TypeError("值集合不能为空");
      const expression: Expression = {
        kind: "or",
        terms: condition.values.map((value) => ({
          kind: "compare",
          operator: "eq",
          left: target.expression,
          right: { kind: "literal", value },
        })),
      };
      return condition.negated ? { kind: "not", term: expression } : expression;
    }
    case "isNull":
    case "isMissing": {
      const target = resolveTarget(condition.field);
      const presence: Expression = {
        kind: condition.kind,
        term: target.expression,
      };
      return condition.negated ? { kind: "not", term: presence } : presence;
    }
    case "all":
    case "any":
      if (!condition.terms.length) throw new TypeError("条件组不能为空");
      return {
        kind: condition.kind === "all" ? "and" : "or",
        terms: condition.terms.map((term) =>
          buildConditionExpression(term, collector, resolveTarget)
        ),
      };
    case "not":
      return {
        kind: "not",
        term: buildConditionExpression(condition.term, collector, resolveTarget),
      };
  }
}

function conditionExpression(
  owner: Owner,
  binding: string,
  condition: ExplorerCondition,
  collector: ParameterCollector,
): Expression {
  return buildConditionExpression(condition, collector, (field) => {
    assertFieldCapability(owner, field, "filter");
    return {
      expression: { kind: "field", binding, field },
      declaredType: fieldDefinition(owner, field).type,
    };
  });
}

function factConditionExpression(
  kind: QueryFactKind,
  binding: string,
  condition: ExplorerCondition,
  collector: ParameterCollector,
): Expression {
  return buildConditionExpression(condition, collector, (field) => {
    assertFactFieldCapability(kind, field, "filter");
    return {
      expression: { kind: "field", binding, field },
      declaredType: factFieldDefinition(kind, field).type,
    };
  });
}

function columnConditionExpression(
  condition: ExplorerCondition,
  collector: ParameterCollector,
): Expression {
  return buildConditionExpression(condition, collector, (name) => ({
    expression: { kind: "column", name },
  }));
}

export function compileExplorerQuery(draft: ExplorerQuery): QueryBundle {
  const binding = "entity";
  const operators: Record<string, QueryOperator> = {};
  const parameters: ParameterCollector = { types: {}, values: {} };
  const text = draft.text?.value.trim();
  const fullText = draft.fullText?.value.trim();
  let root = "source";
  if (text) {
    operators.source = {
      kind: "lookup",
      owner: draft.owner,
      binding,
      fields: fieldsWithCapability(draft.owner, "lookup") as LookupField[],
      text: inputExpression(text, draft.text?.parameter, parameters, "string"),
    };
  } else if (!fullText) {
    operators.source = { kind: "scan", owner: draft.owner, binding };
  }
  if (fullText) {
    if (!draft.fullText?.field) throw new TypeError("正文检索缺少内容字段");
    assertFieldCapability(draft.owner, draft.fullText.field, "fullText");
    const source = text ? "fullTextSource" : "source";
    const fullTextBinding = text ? "fullTextEntity" : binding;
    operators[source] = {
      kind: "fullText",
      target: "entity",
      owner: draft.owner,
      binding: fullTextBinding,
      field: draft.fullText.field,
      text: inputExpression(fullText, draft.fullText.parameter, parameters, "string"),
    };
    if (text) {
      operators.fullTextExists = {
        kind: "exists",
        input: root,
        match: source,
        columns: [{ outer: binding, inner: fullTextBinding }],
      };
      root = "fullTextExists";
    }
  }
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
    const endpoints = relationEndpoints(relation);
    const prefix = `relation${index}`;
    const fixed = endpoints.map((_, endpointIndex) =>
      endpointIndex === 0 ? `${prefix}Fixed` : `${prefix}Fixed${endpointIndex}`
    );
    const endpointByRole = new Map(
      endpoints.map((endpoint, endpointIndex) => [endpoint.role, endpointIndex]),
    );
    const candidate = `${prefix}Candidate`;
    const roles: Record<string, string> = Object.fromEntries(
      Object.keys(fact.roles).map((role) => {
        const endpointIndex = endpointByRole.get(role);
        return [
          role,
          endpointIndex !== undefined
            ? fixed[endpointIndex]!
            : role === relation.candidateRole
              ? candidate
              : `${prefix}${role}`,
        ];
      }),
    );
    operators[`${prefix}Values`] = {
      kind: "values",
      columns: fixed,
      types: Object.fromEntries(endpoints.map((endpoint, endpointIndex) =>
        [fixed[endpointIndex]!, `entity:${endpoint.owner}`]
      )),
      rows: [endpoints.map((endpoint) => endpoint.related)],
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
    const selectedColumns = draft.columns ?? defaultResultProjection(draft.owner);
    if (!selectedColumns.length || new Set(selectedColumns).size !== selectedColumns.length)
      throw new TypeError("结果列必须非空且唯一");
    for (const { column } of draft.orderBy ?? [])
      assertFieldCapability(draft.owner, column, "sort");
    const selected = new Set(selectedColumns);
    operators.project = {
      kind: "project",
      input: root,
      columns: [
        ...selectedColumns.map((field) => {
          assertFieldCapability(draft.owner, field, "project");
          return {
            name: field,
            value: { kind: "field" as const, binding, field },
          };
        }),
        ...[...new Set((draft.orderBy ?? []).map(({ column }) => column))]
          .filter((column) => !selected.has(column))
          .map((column) => ({
            name: column,
            value: { kind: "field" as const, binding, field: column },
            hidden: true,
          })),
      ],
    };
    root = "project";
  }
  const limit = draft.limit ?? null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0))
    throw new TypeError("结果条数必须是非负整数");
  return {
    schema: "atlas-query-bundle-v1",
    release: { policy: "latest" },
    sections: {
      results: {
        query: {
          schema: "atlas-query-document-v1",
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
  parameterValues: ParameterValues,
): ExplorerRelation | null {
  if (
    operator.columns.length !== 1 ||
    operator.columns[0]?.outer !== binding
  ) return null;
  const innerBinding = operator.columns[0].inner;
  const fixedFilter = query.operators[operator.match];
  if (fixedFilter?.kind !== "filter") return null;
  const match = query.operators[fixedFilter.input];
  if (match?.kind !== "matchFact") return null;
  const candidateRole = Object.entries(match.roles)
    .find(([, roleBinding]) => roleBinding === innerBinding)?.[0];
  if (!candidateRole) return null;
  const fact = QUERY_CONTRACT.facts[match.factKind];
  const terms = fixedFilter.predicate.kind === "and"
    ? fixedFilter.predicate.terms
    : [fixedFilter.predicate];
  const endpoints: ExplorerRelationEndpoint[] = [];
  const remainder: Expression[] = [];
  for (const term of terms) {
    if (
      term.kind !== "compare" || term.operator !== "eq" ||
      term.left.kind !== "field" || term.left.field !== "ref" ||
      term.right.kind !== "literal" || typeof term.right.value !== "string"
    ) {
      remainder.push(term);
      continue;
    }
    const fixedBinding = term.left.binding;
    const role = Object.entries(match.roles)
      .find(([, roleBinding]) => roleBinding === fixedBinding)?.[0];
    if (!role || role === candidateRole) {
      remainder.push(term);
      continue;
    }
    let related: ReturnType<typeof parseEntityRef>;
    try {
      related = parseEntityRef(term.right.value);
    } catch {
      return null;
    }
    if (
      fact.roles[role] !== related.owner ||
      endpoints.some((endpoint) => endpoint.role === role)
    ) return null;
    endpoints.push({
      role,
      related: term.right.value as ExplorerRelationEndpoint["related"],
    });
  }
  if (!endpoints.length) return null;
  const source = query.operators[match.input];
  const primaryBinding = source?.kind === "values" ? source.columns[0] : undefined;
  const primaryIndex = primaryBinding
    ? endpoints.findIndex((endpoint) => match.roles[endpoint.role] === primaryBinding)
    : 0;
  if (primaryIndex < 0) return null;
  const [primary] = endpoints.splice(primaryIndex, 1);
  if (!primary) return null;
  let condition: ExplorerCondition | undefined;
  if (remainder.length) {
    const expression: Expression = remainder.length === 1
      ? remainder[0]!
      : { kind: "and", terms: remainder };
    const restored = explorerConditionWithParameters(
      expression,
      match.factBinding,
      parameterValues,
    );
    if (!restored || !editableRelationCondition(restored)) return null;
    condition = restored;
  }
  return {
    factKind: match.factKind,
    candidateRole,
    relatedRole: primary.role,
    related: primary.related,
    ...(endpoints.length ? { additionalEndpoints: endpoints } : {}),
    exists: operator.kind === "exists",
    ...(condition ? { condition } : {}),
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
    const fields = root.columns.filter((column) => !column.hidden).map((column) =>
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
  let fullText: ExplorerQuery["fullText"];
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
      const textSource = query.operators[operator.match];
      if (
        operator.kind === "exists" &&
        textSource?.kind === "fullText" &&
        textSource.target === "entity" &&
        operator.columns.length === 1 &&
        operator.columns[0]?.outer === binding &&
        operator.columns[0].inner === textSource.binding &&
        !fullText
      ) {
        const value = textInput(textSource.text, parameterValues);
        if (value === null) return null;
        fullText = {
          value: value.value,
          field: textSource.field,
          ...(value.parameter ? { parameter: value.parameter } : {}),
        };
        current = operator.input;
        continue;
      }
      const matchProject = query.operators[operator.match];
      if (matchProject?.kind === "project" && matchProject.columns.length === 1) {
        const candidate = matchProject.columns[0]?.value;
        const possibleFilter = query.operators[matchProject.input];
        const match = possibleFilter?.kind === "filter"
          ? query.operators[possibleFilter.input]
          : possibleFilter;
        if (candidate?.kind !== "column" || match?.kind !== "matchFact") return null;
        const values = query.operators[match.input];
        if (
          values?.kind !== "values" || !values.columns.length ||
          values.rows.length !== 1 ||
          values.rows[0]?.length !== values.columns.length
        ) return null;
        const candidateRole = Object.entries(match.roles)
          .find(([, roleBinding]) => roleBinding === candidate.name)?.[0];
        if (!candidateRole) return null;
        const endpoints: ExplorerRelationEndpoint[] = [];
        for (const [endpointIndex, fixed] of values.columns.entries()) {
          const role = Object.entries(match.roles)
            .find(([, roleBinding]) => roleBinding === fixed)?.[0];
          const related = values.rows[0]?.[endpointIndex];
          if (!role || role === candidateRole || typeof related !== "string")
            return null;
          let parsed: ReturnType<typeof parseEntityRef>;
          try {
            parsed = parseEntityRef(related);
          } catch {
            return null;
          }
          if (QUERY_CONTRACT.facts[match.factKind].roles[role] !== parsed.owner)
            return null;
          endpoints.push({
            role,
            related: related as ExplorerRelationEndpoint["related"],
          });
        }
        const [primary, ...additionalEndpoints] = endpoints;
        if (!primary) return null;
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
          relatedRole: primary.role,
          related: primary.related,
          ...(additionalEndpoints.length ? { additionalEndpoints } : {}),
          exists: operator.kind === "exists",
          ...(factCondition ? { condition: factCondition } : {}),
        });
      } else {
        const relation = sourceExplorerRelation(
          query,
          operator,
          binding,
          parameterValues,
        );
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
      if (fullText) return null;
      fullText = {
        value: value.value,
        field: operator.field,
        ...(value.parameter ? { parameter: value.parameter } : {}),
      };
    } else return null;
    if (operator.binding !== binding) return null;
    const columns = projectedFields?.map((field) => field.field) ?? [];
    const defaults = defaultResultProjection(owner);
    const usesDefaultColumns = columns.length === defaults.length &&
      columns.every((field, index) => field === defaults[index]);
    return {
      owner,
      ...(text ? { text } : {}),
      ...(fullText ? { fullText } : {}),
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
