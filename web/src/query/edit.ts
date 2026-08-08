import type { QueryFactKind } from "./contract";
import type { ExplorerAggregate, ExplorerCondition } from "./explorer";
import type { CompareOperator } from "./value";
import {
  conditionEditorOperator,
  FIELD_LABEL,
  FACT_FIELD_LABEL,
  parseFactValue,
  parseFactValues,
  parseValue,
  parseValues,
  queryConditionOperators,
  queryFactConditionOperators,
  queryStatisticColumns,
} from "./workbench-model";
import type { Owner } from "./contract";

export interface ConditionEditValue {
  field: string;
  operator: string;
  raw: string;
}

type LeafCondition = Extract<
  ExplorerCondition,
  { kind: "compare" | "in" | "isNull" | "isMissing" }
>;

export function conditionEditValue(
  condition: ExplorerCondition,
): ConditionEditValue | null {
  if (
    condition.kind !== "compare" && condition.kind !== "in" &&
    condition.kind !== "isNull" && condition.kind !== "isMissing"
  ) return null;
  const operator = conditionEditorOperator(condition);
  if (!operator) return null;
  return {
    field: condition.field,
    operator,
    raw: condition.kind === "compare"
      ? String(condition.value)
      : condition.kind === "in"
        ? condition.values.map(String).join("、")
        : "",
  };
}

function createCondition(
  field: string,
  operator: string,
  raw: string,
  allowed: readonly string[],
  parseOne: (raw: string) => string | number | boolean,
  parseMany: (raw: string) => Array<string | number | boolean>,
  fieldName: string,
): LeafCondition {
  if (!field || !allowed.includes(operator))
    throw new TypeError("请选择有效的字段和比较方式");
  if (operator === "isNull" || operator === "isNotNull") {
    return {
      kind: "isNull",
      field,
      ...(operator === "isNotNull" ? { negated: true } : {}),
    };
  }
  if (operator === "isMissing" || operator === "isPresent") {
    return {
      kind: "isMissing",
      field,
      ...(operator === "isPresent" ? { negated: true } : {}),
    };
  }
  if (!raw.trim()) throw new TypeError(`请填写${fieldName}的值`);
  if (operator === "in" || operator === "notIn") {
    return {
      kind: "in",
      field,
      values: parseMany(raw),
      ...(operator === "notIn" ? { negated: true } : {}),
    };
  }
  return {
    kind: "compare",
    field,
    operator: (operator === "notContains" ? "contains" : operator) as CompareOperator,
    value: parseOne(raw),
    ...(operator === "notContains" ? { negated: true } : {}),
  };
}

export function createEntityCondition(
  owner: Owner,
  field: string,
  operator: string,
  raw: string,
): LeafCondition {
  return createCondition(
    field,
    operator,
    raw,
    queryConditionOperators(owner, field),
    (value) => parseValue(owner, field, value),
    (value) => parseValues(owner, field, value),
    FIELD_LABEL[field] ?? field,
  );
}

export function createFactCondition(
  kind: QueryFactKind,
  field: string,
  operator: string,
  raw: string,
): LeafCondition {
  return createCondition(
    field,
    operator,
    raw,
    queryFactConditionOperators(kind, field),
    (value) => parseFactValue(kind, field, value),
    (value) => parseFactValues(kind, field, value),
    FACT_FIELD_LABEL[field] ?? field,
  );
}

const STATISTIC_OPERATORS = [
  "eq", "ne", "lt", "lte", "gt", "gte", "in", "notIn",
  "isNull", "isNotNull",
] as const;

export function statisticConditionOperators(
  owner: Owner,
  aggregate: ExplorerAggregate,
  field: string,
): string[] {
  if (!queryStatisticColumns(aggregate).some((column) => column.value === field))
    return [];
  return aggregate.groupBy.includes(field)
    ? queryConditionOperators(owner, field)
    : [...STATISTIC_OPERATORS];
}

function statisticNumber(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new TypeError("统计结果条件需要有效数字");
  return value;
}

export function createStatisticCondition(
  owner: Owner,
  aggregate: ExplorerAggregate,
  field: string,
  operator: string,
  raw: string,
): LeafCondition {
  if (aggregate.groupBy.includes(field))
    return createEntityCondition(owner, field, operator, raw);
  return createCondition(
    field,
    operator,
    raw,
    statisticConditionOperators(owner, aggregate, field),
    statisticNumber,
    (value) => {
      const values = value.split(/[,，、\n]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map(statisticNumber);
      if (!values.length) throw new TypeError("值集合不能为空");
      return values;
    },
    "统计结果",
  );
}
