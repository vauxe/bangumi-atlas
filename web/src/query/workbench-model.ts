import {
  QUERY_CONTRACT,
  parseEntityRef,
  type FieldCapability,
  type Owner,
} from "./contract";
import type { ExplorerCondition, ExplorerQuery } from "./explorer";
import type { CompareOperator } from "./value";
import { MEDIA_NAMES } from "../types";

export const OWNER_LABEL: Record<Owner, string> = {
  subject: "作品",
  person: "人物",
  character: "角色",
  episode: "分集",
};

export const FIELD_LABEL: Record<string, string> = {
  name: "原名",
  nameCn: "中文名",
  type: "类型",
  platform: "平台",
  date: "日期",
  year: "年份",
  score: "评分",
  rank: "Bangumi 排名",
  nsfw: "限制级",
  wish: "想看 / 读 / 玩",
  done: "看过 / 读 / 玩过",
  doing: "在看 / 读 / 玩",
  onHold: "搁置",
  dropped: "抛弃",
  series: "系列",
  scoreDetails: "评分分布",
  metaTags: "元标签",
  tags: "用户标签",
  career: "职业",
  comments: "评论数",
  collects: "收藏数",
  role: "角色定位",
  airdate: "播出日期",
  disc: "碟片",
  duration: "时长",
  sort: "集数",
  summary: "简介",
  description: "分集介绍",
  summaryState: "简介状态",
  descriptionState: "分集介绍状态",
};

export const OPERATOR_LABEL: Record<string, string> = {
  eq: "等于",
  ne: "不等于",
  lt: "小于",
  lte: "不大于",
  gt: "大于",
  gte: "不小于",
  contains: "包含",
  notContains: "不包含",
  in: "属于",
  notIn: "不属于",
  isNull: "为空",
  isNotNull: "不为空",
  isMissing: "未提供",
  isPresent: "已提供",
};

export const COMMON_FIELDS: Record<Owner, Set<string>> = {
  subject: new Set(["type", "year", "score", "tags", "nsfw", "summaryState"]),
  person: new Set(["type", "career", "comments", "collects", "summaryState"]),
  character: new Set(["role", "comments", "collects", "summaryState"]),
  episode: new Set(["type", "year", "sort", "disc", "descriptionState"]),
};

export const INTERNAL_FIELDS = new Set(["ref", "id", "subjectRef"]);

export const DEFAULT_RESULT_FIELDS: Record<Owner, string[]> = {
  subject: ["name", "nameCn", "type", "date", "year", "score", "rank"],
  person: ["name", "type", "career", "comments", "collects"],
  character: ["name", "role", "comments", "collects"],
  episode: ["name", "nameCn", "type", "airdate", "year", "duration"],
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

const FACT_LABEL: Record<string, string> = {
  RELATES_TO: "作品关系",
  WORKED_ON: "人物参与",
  APPEARS_IN: "角色登场",
  VOICE_CREDIT: "配音",
  PERSON_REL: "人物关系",
  CHARACTER_REL: "角色关系",
};

const DESCENDING_SORT_FIELDS = new Set([
  "date",
  "year",
  "score",
  "wish",
  "done",
  "doing",
  "onHold",
  "dropped",
  "comments",
  "collects",
  "airdate",
]);

const SUMMARY_OPERATOR: Record<CompareOperator, string> = {
  eq: "=",
  ne: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  contains: "含",
};

export function queryFieldsFor(
  owner: Owner,
  capability: FieldCapability,
): string[] {
  return Object.entries(QUERY_CONTRACT.owners[owner].fields)
    .filter(([, field]) => field.capabilities.includes(capability))
    .map(([field]) => field);
}

export function enumValuesFor(
  owner: Owner,
  field: string,
): Record<string, string> | null {
  const definition = QUERY_CONTRACT.owners[owner].fields[field];
  return owner === "subject" && field === "type"
    ? Object.fromEntries(Object.entries(MEDIA_NAMES).map(([value, label]) => [value, label]))
    : owner === "person" && field === "type"
      ? { "1": "个人", "2": "公司", "3": "组合" }
      : owner === "character" && field === "role"
        ? { "1": "角色", "2": "机体", "3": "舰船", "4": "组织" }
        : field === "summaryState" || field === "descriptionState"
          ? { "HAS": "有内容", "EMPTY": "无内容" }
          : definition?.type === "boolean"
            ? { "true": "是", "false": "否" }
            : null;
}

function summaryValue(owner: Owner, field: string, value: unknown): string {
  const enumValue = Object.entries(enumValuesFor(owner, field) ?? {})
    .find(([candidate]) => candidate === String(value))?.[1];
  if (enumValue) return enumValue;
  if (typeof value === "string") return `「${value}」`;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null) return "空值";
  return String(value);
}

function describeCondition(owner: Owner, condition: ExplorerCondition): string {
  switch (condition.kind) {
    case "compare":
      if (condition.negated && condition.operator === "contains")
        return `${FIELD_LABEL[condition.field] ?? condition.field}不含${summaryValue(owner, condition.field, condition.value)}`;
      if (condition.negated)
        return `排除（${FIELD_LABEL[condition.field] ?? condition.field} ${SUMMARY_OPERATOR[condition.operator]} ${summaryValue(owner, condition.field, condition.value)}）`;
      return `${FIELD_LABEL[condition.field] ?? condition.field} ${SUMMARY_OPERATOR[condition.operator]} ${summaryValue(owner, condition.field, condition.value)}`;
    case "in":
      return `${FIELD_LABEL[condition.field] ?? condition.field}${condition.negated ? "不属于" : "属于"}（${condition.values.map((value) => summaryValue(owner, condition.field, value)).join("、")}）`;
    case "isNull":
      return `${FIELD_LABEL[condition.field] ?? condition.field}${condition.negated ? "不为空" : "为空"}`;
    case "isMissing":
      return `${FIELD_LABEL[condition.field] ?? condition.field}${condition.negated ? "已提供" : "未提供"}`;
    case "all":
    case "any":
      return `${condition.kind === "all" ? "全部" : "任一"}（${condition.terms.map((term) => describeCondition(owner, term)).join("、")}）`;
    case "not":
      return `排除（${describeCondition(owner, condition.term)}）`;
  }
}

export function describeExplorerQuery(draft: ExplorerQuery): string {
  const parts = [OWNER_LABEL[draft.owner]];
  if (draft.text) {
    const scope = draft.text.capability === "lookup"
      ? "名称"
      : draft.text.field === "description"
        ? "分集介绍"
        : "简介";
    parts.push(`${scope}含「${draft.text.value}」`);
  }
  if (draft.condition) parts.push(describeCondition(draft.owner, draft.condition));
  for (const relation of draft.relations ?? []) {
    const related = parseEntityRef(relation.related);
    parts.push(
      `与${OWNER_LABEL[related.owner]} #${related.archiveId} ${relation.exists ? "有" : "无"}${FACT_LABEL[relation.factKind] ?? relation.factKind}`,
    );
  }
  for (const order of draft.orderBy ?? [])
    parts.push(
      `${FIELD_LABEL[order.column] ?? order.column}${order.direction === "asc" ? "升序" : "降序"}`,
    );
  if (parts.length === 1) parts.push("全部条目");
  return parts.join(" · ");
}

export function queryConditionOperators(owner: Owner, field: string): string[] {
  const definition = QUERY_CONTRACT.owners[owner].fields[field];
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

export function queryProjectFields(owner: Owner): string[] {
  return queryFieldsFor(owner, "project")
    .filter((field) => !INTERNAL_FIELDS.has(field));
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
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    throw new TypeError("结果条数必须在 1 到 10000 之间");
  return limit;
}

export function queryRelationOptions(owner: Owner): Array<{
  value: string;
  label: string;
}> {
  const options: Array<{ value: string; label: string }> = [];
  for (const [factKind, fact] of Object.entries(QUERY_CONTRACT.facts)) {
    for (const [candidateRole, candidateOwner] of Object.entries(fact.roles)) {
      if (candidateOwner !== owner) continue;
      for (const [relatedRole, relatedOwner] of Object.entries(fact.roles)) {
        if (candidateRole === relatedRole) continue;
        const direction = candidateOwner === relatedOwner
          ? relatedRole === "target"
            ? "目标"
            : relatedRole === "source"
              ? "来源"
              : `${relatedRole} · `
          : "";
        options.push({
          value: `${factKind}|${candidateRole}|${relatedRole}`,
          label: `${FACT_LABEL[factKind] ?? factKind} · ${direction}${OWNER_LABEL[relatedOwner]}`,
        });
      }
    }
  }
  return options;
}

export function queryTextScopes(owner: Owner): Array<{
  value: string;
  label: string;
}> {
  return [
    { value: "lookup", label: "名称含" },
    ...queryFieldsFor(owner, "fullText").map((field) => ({
      value: `fullText:${field}`,
      label: `${FIELD_LABEL[field] ?? field}含`,
    })),
  ];
}

export function querySortFields(owner: Owner): string[] {
  return queryFieldsFor(owner, "sort")
    .filter((field) => !INTERNAL_FIELDS.has(field));
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

export function parseValue(
  owner: Owner,
  field: string,
  raw: string,
): string | number | boolean {
  const type = QUERY_CONTRACT.owners[owner].fields[field]?.type;
  if (type === "integer" || type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value) || (type === "integer" && !Number.isSafeInteger(value)))
      throw new TypeError(`${FIELD_LABEL[field] ?? field} 需要有效数字`);
    return value;
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

export function isExplorerConditionComplete(
  owner: Owner,
  field: string,
  operator: string,
  raw: string,
): boolean {
  if (
    operator === "isNull" || operator === "isNotNull" ||
    operator === "isMissing" || operator === "isPresent"
  ) return true;
  if (!field || !raw.trim()) return false;
  if (operator === "in" || operator === "notIn") {
    try {
      parseValues(owner, field, raw);
      return true;
    } catch {
      return false;
    }
  }
  if (operator !== "notContains" && !COMPARE.has(operator as CompareOperator)) return false;
  const type = QUERY_CONTRACT.owners[owner].fields[field]?.type;
  if (type === "integer" || type === "number") {
    const value = Number(raw);
    return Number.isFinite(value) && (type !== "integer" || Number.isSafeInteger(value));
  }
  if (type === "boolean") return raw === "true" || raw === "false";
  return true;
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
