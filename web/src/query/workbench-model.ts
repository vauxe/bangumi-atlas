import {
  QUERY_CONTRACT,
  factFieldDefinition,
  parseEntityRef,
  type FieldCapability,
  type Owner,
  type QueryFactKind,
} from "./contract";
import { explorerMetricName } from "./explorer";
import type {
  ExplorerAggregate,
  ExplorerAggregateMetric,
  ExplorerCondition,
} from "./explorer";
import type { AggregateFunction, LiteralValue } from "./document";
import type { CompareOperator } from "./value";
import { MEDIA_NAMES } from "../types";
import type { Mappings } from "../types";
import { CAREER_VALUES } from "../value-labels";
import { FACT_LABEL, OWNER_LABEL } from "./vocabulary";

export { FACT_LABEL, OWNER_LABEL } from "./vocabulary";

export const FIELD_LABEL: Record<string, string> = {
  entityType: "实体类型",
  name: "原名",
  nameCn: "中文名",
  type: "类型",
  platform: "平台",
  date: "首发日期",
  year: "年份",
  score: "评分",
  ratingCount: "评分人数",
  rank: "Bangumi 排名",
  nsfw: "限制级",
  wish: "想看 / 读 / 玩",
  done: "看过 / 读 / 玩过",
  doing: "在看 / 读 / 玩",
  onHold: "搁置",
  dropped: "抛弃",
  totalCollections: "总收藏数",
  series: "是否为系列作品",
  scoreDetails: "评分分布",
  metaTags: "内容标签",
  tags: "用户标签",
  career: "职业",
  comments: "评论数",
  collects: "收藏数",
  role: "角色定位",
  airdate: "播出日期",
  disc: "光盘编号",
  duration: "时长",
  sort: "集序号",
  subjectRef: "所属作品",
  summary: "简介",
  description: "分集介绍",
  summaryState: "是否有简介",
  descriptionState: "是否有分集介绍",
};

export const FACT_FIELD_LABEL: Record<string, string> = {
  relationType: "关系类型",
  position: "职位",
  type: "关系类型",
  spoiler: "包含剧透",
  ended: "已经结束",
  summaryState: "是否有说明",
};

export const OPERATOR_LABEL: Record<string, string> = {
  eq: "等于",
  ne: "不等于",
  lt: "小于",
  lte: "至多",
  gt: "大于",
  gte: "至少",
  contains: "包含",
  notContains: "不包含",
  in: "属于",
  notIn: "不属于",
  isNull: "为空",
  isNotNull: "不为空",
  isMissing: "未提供",
  isPresent: "已提供",
};

export const AGGREGATE_FUNCTION_LABEL: Record<AggregateFunction, string> = {
  count: "条数",
  countDistinct: "去重计数",
  sum: "合计",
  min: "最低",
  max: "最高",
  avg: "平均",
};

export const COMMON_FIELDS: Record<Owner, Set<string>> = {
  subject: new Set([
    "type",
    "year",
    "score",
    "ratingCount",
    "totalCollections",
    "tags",
    "nsfw",
    "summaryState",
  ]),
  person: new Set(["type", "career", "comments", "collects", "summaryState"]),
  character: new Set(["role", "comments", "collects", "summaryState"]),
  episode: new Set(["type", "year", "sort", "disc", "descriptionState"]),
};

export const INTERNAL_FIELDS = new Set(["ref", "id", "subjectRef"]);

export type QueryScalarInputType = "text" | "number" | "date";

interface QueryFieldUi {
  add?: false;
  inputType?: QueryScalarInputType;
}

const QUERY_FIELD_UI: Partial<Record<Owner, Record<string, QueryFieldUi>>> = {
  subject: {
    name: { add: false },
    nameCn: { add: false },
    date: { inputType: "date" },
  },
  person: { name: { add: false } },
  character: { name: { add: false } },
  episode: {
    name: { add: false },
    nameCn: { add: false },
    airdate: { inputType: "date" },
  },
};

export const COMPARE = new Set<CompareOperator>([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
]);

const DESCENDING_SORT_FIELDS = new Set([
  "date",
  "year",
  "score",
  "ratingCount",
  "totalCollections",
  "wish",
  "done",
  "doing",
  "onHold",
  "dropped",
  "comments",
  "collects",
  "airdate",
]);

export function queryFieldsFor(
  owner: Owner,
  capability: FieldCapability,
): string[] {
  return Object.entries(QUERY_CONTRACT.owners[owner].fields)
    .filter(([, field]) => field.capabilities.includes(capability))
    .map(([field]) => field);
}

export function queryReferenceOwner(owner: Owner, field: string): Owner | null {
  const type = QUERY_CONTRACT.owners[owner].fields[field]?.type;
  if (!type?.startsWith("entity:")) return null;
  const referenceOwner = type.slice("entity:".length) as Owner;
  return referenceOwner in QUERY_CONTRACT.owners ? referenceOwner : null;
}

/** Fields the visual condition editor can represent without exposing raw ids. */
export function queryFilterFields(owner: Owner): string[] {
  return queryFieldsFor(owner, "filter").filter((field) =>
    !INTERNAL_FIELDS.has(field) ||
    (field !== "ref" && queryReferenceOwner(owner, field) !== null)
  );
}

/** Fields worth presenting in the default menu; the complete contract remains editable. */
export function queryAddFilterFields(owner: Owner): string[] {
  return queryFilterFields(owner).filter((field) =>
    QUERY_FIELD_UI[owner]?.[field]?.add !== false
  );
}

export function queryScalarInputType(
  owner: Owner,
  field: string,
): QueryScalarInputType {
  const semanticType = QUERY_FIELD_UI[owner]?.[field]?.inputType;
  if (semanticType) return semanticType;
  const type = QUERY_CONTRACT.owners[owner].fields[field]?.type;
  return type === "integer" || type === "number" ? "number" : "text";
}

const DATE_OPERATOR_LABEL: Partial<Record<string, string>> = {
  lt: "早于",
  lte: "不晚于",
  gt: "晚于",
  gte: "不早于",
};

export function queryConditionOperatorLabel(
  owner: Owner,
  field: string,
  operator: string,
): string {
  return queryScalarInputType(owner, field) === "date"
    ? DATE_OPERATOR_LABEL[operator] ?? OPERATOR_LABEL[operator] ?? operator
    : OPERATOR_LABEL[operator] ?? operator;
}

export function enumValuesFor(
  owner: Owner,
  field: string,
  mappings?: Mappings,
): Record<string, string> | null {
  const definition = QUERY_CONTRACT.owners[owner].fields[field];
  if (owner === "subject" && field === "platform" && mappings) {
    const labels = [...new Set(Object.values(mappings.platform).filter(Boolean))];
    if (labels.length)
      return Object.fromEntries(labels.map((label) => [label, label]));
  }
  if (owner === "person" && field === "career") return { ...CAREER_VALUES };
  const namespace = definition?.enum;
  if (namespace && mappings && !namespace.startsWith("fact_labels.")) {
    const values = mappings[
      namespace as Exclude<keyof Mappings, "fact_labels">
    ];
    if (values) return values;
  }
  if (owner === "subject" && field === "type")
    return Object.fromEntries(
      Object.entries(MEDIA_NAMES).map(([value, label]) => [value, label]),
    );
  if (owner === "person" && field === "type")
    return { "1": "个人", "2": "公司", "3": "组合" };
  if (owner === "character" && field === "role")
    return { "1": "角色", "2": "机体", "3": "舰船", "4": "组织" };
  if (field === "summaryState") return { HAS: "有简介", EMPTY: "无简介" };
  if (field === "descriptionState")
    return { HAS: "有分集介绍", EMPTY: "无分集介绍" };
  if (definition?.type === "boolean") return { true: "是", false: "否" };
  return null;
}

export function queryConditionOperators(owner: Owner, field: string): string[] {
  const definition = QUERY_CONTRACT.owners[owner].fields[field];
  return conditionOperators(definition);
}

export function sameFilterFieldSemantics(
  leftOwner: Owner,
  rightOwner: Owner,
  field: string,
): boolean {
  const left = QUERY_CONTRACT.owners[leftOwner].fields[field];
  const right = QUERY_CONTRACT.owners[rightOwner].fields[field];
  if (
    !left?.capabilities.includes("filter") ||
    !right?.capabilities.includes("filter") ||
    left.type !== right.type ||
    left.enum !== right.enum
  ) return false;
  const leftOperators = queryConditionOperators(leftOwner, field);
  const rightOperators = queryConditionOperators(rightOwner, field);
  return leftOperators.length === rightOperators.length &&
    leftOperators.every((operator, index) => operator === rightOperators[index]);
}

export function sameSortFieldSemantics(
  leftOwner: Owner,
  rightOwner: Owner,
  field: string,
): boolean {
  const left = QUERY_CONTRACT.owners[leftOwner].fields[field];
  const right = QUERY_CONTRACT.owners[rightOwner].fields[field];
  return Boolean(
    left?.capabilities.includes("sort") &&
    right?.capabilities.includes("sort") &&
    left.type === right.type &&
    left.enum === right.enum
  );
}

function conditionOperators(
  definition: { operators?: string; nullable?: boolean; missing?: boolean } | undefined,
): string[] {
  const names = definition?.operators
    ? QUERY_CONTRACT.operatorSets[definition.operators] ?? []
    : [];
  const operators: string[] = [];
  for (const name of names) {
    if (name === "contains") operators.push("contains", "notContains");
    else if (COMPARE.has(name as CompareOperator)) operators.push(name);
    else if (name === "in") operators.push("in", "notIn");
    else if (name === "isNull" && definition?.nullable)
      operators.push("isNull", "isNotNull");
  }
  if (definition?.missing) operators.push("isMissing", "isPresent");
  return operators;
}

export function queryFactFields(
  kind: QueryFactKind,
  capability: FieldCapability,
): string[] {
  return Object.entries(QUERY_CONTRACT.facts[kind].fields)
    .filter(([, definition]) =>
      definition.exposure !== "private" &&
      definition.capabilities.includes(capability)
    )
    .map(([field]) => field);
}

/** The enum field that gives a fact its user-facing relationship name. */
export function queryFactDiscriminatorField(kind: QueryFactKind): string | null {
  return queryFactFields(kind, "filter")
    .find((field) => Boolean(factFieldDefinition(kind, field).enum)) ?? null;
}

export interface FactDiscriminatorSplit {
  discriminator?: ExplorerCondition;
  values: LiteralValue[];
  remainder?: ExplorerCondition;
}

function discriminatorValues(
  condition: ExplorerCondition,
  field: string,
): LiteralValue[] | null {
  if (
    condition.kind === "compare" &&
    condition.field === field &&
    condition.operator === "eq" &&
    !condition.negated &&
    !condition.parameter
  ) return [condition.value];
  if (
    condition.kind === "in" &&
    condition.field === field &&
    !condition.negated &&
    condition.values.length
  ) return condition.values;
  return null;
}

/**
 * Pull a directly selectable relationship name out of a condition while
 * leaving all genuinely additional fact conditions unchanged.
 */
export function splitFactDiscriminatorCondition(
  kind: QueryFactKind,
  condition?: ExplorerCondition,
): FactDiscriminatorSplit {
  const field = queryFactDiscriminatorField(kind);
  if (!field || !condition) return { values: [], remainder: condition };
  const direct = discriminatorValues(condition, field);
  if (direct) return { discriminator: condition, values: direct };
  if (condition.kind !== "all") return { values: [], remainder: condition };
  const matches = condition.terms
    .map((term, index) => ({ term, index, values: discriminatorValues(term, field) }))
    .filter((match) => match.values !== null);
  if (matches.length !== 1) return { values: [], remainder: condition };
  const match = matches[0]!;
  const remainder = combineExplorerConditions(
    "all",
    condition.terms.filter((_, index) => index !== match.index),
  );
  return {
    discriminator: match.term,
    values: match.values!,
    ...(remainder ? { remainder } : {}),
  };
}

export function queryFactConditionOperators(
  kind: QueryFactKind,
  field: string,
): string[] {
  return conditionOperators(factFieldDefinition(kind, field));
}

export function factEnumValues(
  kind: QueryFactKind,
  field: string,
  mappings?: Mappings,
): Record<string, string> | null {
  const definition = factFieldDefinition(kind, field);
  if (definition.enum?.startsWith("fact_labels.")) {
    const namespace = definition.enum.slice("fact_labels.".length);
    return mappings?.fact_labels[namespace] ?? null;
  }
  if (definition.type === "boolean") return { true: "是", false: "否" };
  if (field === "summaryState") return { HAS: "有说明", EMPTY: "无说明" };
  return null;
}

function parseNumericValue(
  raw: string,
  type: "integer" | "number",
  label: string,
): number {
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new TypeError(`${label}请输入有效数字`);
  if (type === "integer" && !Number.isSafeInteger(value))
    throw new TypeError(`${label}必须是整数`);
  return value;
}

export function parseFactValue(
  kind: QueryFactKind,
  field: string,
  raw: string,
): string | number | boolean {
  const type = factFieldDefinition(kind, field).type;
  if (type === "integer" || type === "number")
    return parseNumericValue(raw, type, FACT_FIELD_LABEL[field] ?? field);
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false")
      throw new TypeError(`${FACT_FIELD_LABEL[field] ?? field}请选择是或否`);
    return raw === "true";
  }
  return raw;
}

export function parseFactValues(
  kind: QueryFactKind,
  field: string,
  raw: string,
  mappings?: Mappings,
): Array<string | number | boolean> {
  const labels = factEnumValues(kind, field, mappings);
  const byLabel = new Map(
    Object.entries(labels ?? {}).map(([value, label]) => [label, value]),
  );
  const values = raw
    .split(/[,，、\n]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseFactValue(kind, field, byLabel.get(value) ?? value));
  if (!values.length) throw new TypeError("值集合不能为空");
  return values;
}

export function combineExplorerConditions(
  mode: "all" | "any",
  terms: ExplorerCondition[],
): ExplorerCondition | undefined {
  if (!terms.length) return undefined;
  return terms.length === 1 ? terms[0] : { kind: mode, terms };
}

export function parseExplorerLimit(raw: string): number {
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new TypeError("结果条数必须是正整数");
  return limit;
}

export function queryRelationOptions(owner: Owner): Array<{
  value: string;
  label: string;
  factKind: QueryFactKind;
  candidateRole: string;
  relatedRole: string;
  targetLabel: string;
}> {
  const options: Array<{
    value: string;
    label: string;
    factKind: QueryFactKind;
    candidateRole: string;
    relatedRole: string;
    targetLabel: string;
  }> = [];
  for (const [factKind, fact] of Object.entries(QUERY_CONTRACT.facts)) {
    for (const [candidateRole, candidateOwner] of Object.entries(fact.roles)) {
      if (candidateOwner !== owner) continue;
      for (const [relatedRole, relatedOwner] of Object.entries(fact.roles)) {
        if (candidateRole === relatedRole) continue;
        const direction = candidateOwner === relatedOwner
          ? relatedRole === "target"
            ? "关联到的"
            : relatedRole === "source"
              ? "关联到它的"
              : `${relatedRole} · `
          : "";
        const targetLabel = `${direction}${OWNER_LABEL[relatedOwner]}`;
        options.push({
          value: `${factKind}|${candidateRole}|${relatedRole}`,
          label: `${FACT_LABEL[factKind as QueryFactKind]} · ${targetLabel}`,
          factKind: factKind as QueryFactKind,
          candidateRole,
          relatedRole,
          targetLabel,
        });
      }
    }
  }
  return options;
}

export function querySortFields(owner: Owner): string[] {
  return queryFieldsFor(owner, "sort")
    .filter((field) => !INTERNAL_FIELDS.has(field));
}

export function queryGroupFields(owner: Owner): string[] {
  return queryFieldsFor(owner, "group")
    .filter((field) => !INTERNAL_FIELDS.has(field));
}

export function queryAggregateFields(owner: Owner): string[] {
  return queryFieldsFor(owner, "aggregate")
    .filter((field) => !INTERNAL_FIELDS.has(field));
}

export function describeAggregateMetric(metric: ExplorerAggregateMetric): string {
  const label = AGGREGATE_FUNCTION_LABEL[metric.function];
  return metric.field ? `${label}${FIELD_LABEL[metric.field] ?? metric.field}` : label;
}

export function queryStatisticColumns(
  aggregate: ExplorerAggregate,
): Array<{ value: string; label: string }> {
  return [
    ...aggregate.groupBy.map((field) => ({
      value: field,
      label: FIELD_LABEL[field] ?? field,
    })),
    ...aggregate.metrics.map((metric) => ({
      value: explorerMetricName(metric),
      label: describeAggregateMetric(metric),
    })),
  ];
}

export function defaultSortDirection(field: string): "asc" | "desc" {
  return DESCENDING_SORT_FIELDS.has(field) ? "desc" : "asc";
}

export function queryRelationTargetOwner(selection: string): Owner {
  const [factKind, , relatedRole] = selection.split("|");
  const fact = (QUERY_CONTRACT.facts as Record<string, {
    roles: Record<string, Owner>;
  }>)[factKind ?? ""];
  const owner = fact?.roles[relatedRole ?? ""];
  if (!owner) throw new TypeError("关联类型无效");
  return owner;
}

export function queryRelationContextRoles(
  factKind: QueryFactKind,
  candidateRole: string,
  relatedRole: string,
): Array<{ role: string; owner: Owner; label: string }> {
  const fact = QUERY_CONTRACT.facts[factKind];
  return Object.entries(fact.roles)
    .filter(([role]) => role !== candidateRole && role !== relatedRole)
    .map(([role, owner]) => ({ role, owner, label: OWNER_LABEL[owner] }));
}

export function parseValue(
  owner: Owner,
  field: string,
  raw: string,
): string | number | boolean {
  const type = QUERY_CONTRACT.owners[owner].fields[field]?.type;
  if (type?.startsWith("entity:")) {
    const expected = type.slice("entity:".length) as Owner;
    let actual: Owner;
    try {
      actual = parseEntityRef(raw).owner;
    } catch {
      throw new TypeError(`${FIELD_LABEL[field] ?? field}需要有效的${OWNER_LABEL[expected]}`);
    }
    if (actual !== expected)
      throw new TypeError(`${FIELD_LABEL[field] ?? field}需要选择${OWNER_LABEL[expected]}`);
    return raw;
  }
  if (type === "integer" || type === "number") {
    return parseNumericValue(raw, type, FIELD_LABEL[field] ?? field);
  }
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false")
      throw new TypeError(`${FIELD_LABEL[field] ?? field} 请输入 true 或 false`);
    return raw === "true";
  }
  return raw;
}

export function parseValues(
  owner: Owner,
  field: string,
  raw: string,
): Array<string | number | boolean> {
  const enumValues = enumValuesFor(owner, field);
  const byLabel = new Map(
    Object.entries(enumValues ?? {}).map(([value, label]) => [label, value]),
  );
  const values = raw
    .split(/[,，、\n]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseValue(owner, field, byLabel.get(value) ?? value));
  if (!values.length) throw new TypeError("值集合不能为空");
  return values;
}

type EditableExplorerCondition = Extract<
  ExplorerCondition,
  { kind: "compare" | "in" | "isNull" | "isMissing" }
>;

export function conditionEditorOperator(
  condition: EditableExplorerCondition,
): string | null {
  switch (condition.kind) {
    case "compare":
      if (!condition.negated) return condition.operator;
      return condition.operator === "contains" ? "notContains" : null;
    case "in":
      return condition.negated ? "notIn" : "in";
    case "isNull":
      return condition.negated ? "isNotNull" : "isNull";
    case "isMissing":
      return condition.negated ? "isPresent" : "isMissing";
  }
}
