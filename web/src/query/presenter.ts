import { parseEntityRef, type Owner, type QueryFactKind } from "./contract";
import type { ExplorerCondition, ExplorerRelation } from "./explorer";
import {
  DEFAULT_ENTITY_SCOPE,
  type EntityScope,
  type QueryDraft,
} from "./draft";
import {
  describeAggregateMetric,
  enumValuesFor,
  FACT_FIELD_LABEL,
  FACT_LABEL,
  factEnumValues,
  FIELD_LABEL,
  OWNER_LABEL,
  queryRelationOptions,
  queryStatisticColumns,
} from "./workbench-model";
import type { Mappings } from "../types";

export type QueryTokenTarget =
  | { type: "head" }
  | { type: "intent" }
  | { type: "owner" }
  | { type: "text" }
  | { type: "condition"; index: number }
  | { type: "relation"; index: number }
  | { type: "columns" }
  | { type: "aggregate" }
  | { type: "having" }
  | { type: "order" }
  | { type: "limit" }
  | { type: "endpoint"; endpoint: "from" | "to" }
  | { type: "maxHops" }
  | { type: "maxPaths" }
  | { type: "comparisonMode" };

export interface QueryToken {
  id: string;
  kind:
    | "intent"
    | "scope"
    | "text"
    | "condition"
    | "relation"
    | "shape"
    | "order"
    | "limit"
    | "entity";
  label: string;
  target: QueryTokenTarget;
  removable: boolean;
  editable: boolean;
}

export interface QueryPresentationOptions {
  mappings?: Mappings;
  entityLabel?: (ref: string) => string | undefined;
}

export type CompletionActionId =
  | "fullText"
  | "condition"
  | "relation"
  | "columns"
  | "sort"
  | "limit"
  | "aggregate"
  | "list"
  | "comparison"
  | "path";

export interface CompletionAction {
  id: CompletionActionId;
  label: string;
  description: string;
  owner?: Owner;
}

const COMPARE_SYMBOL: Record<string, string> = {
  eq: "=",
  ne: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  contains: "含",
};

function token(
  id: string,
  kind: QueryToken["kind"],
  label: string,
  target: QueryTokenTarget,
  removable = false,
  editable = true,
): QueryToken {
  return { id, kind, label, target, removable, editable };
}

function conditionTerms(condition: ExplorerCondition | undefined): ExplorerCondition[] {
  return condition?.kind === "all"
    ? condition.terms
    : condition
      ? [condition]
      : [];
}

function valueLabel(
  value: unknown,
  values: Record<string, string> | null,
): string {
  const mapped = values?.[String(value)];
  if (mapped !== undefined) return mapped;
  if (typeof value === "string") return `“${value}”`;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null) return "空值";
  return String(value);
}

function describeCondition(
  condition: ExplorerCondition,
  fieldLabel: (field: string) => string,
  valuesFor: (field: string) => Record<string, string> | null,
): string {
  switch (condition.kind) {
    case "compare": {
      const field = fieldLabel(condition.field);
      const value = valueLabel(condition.value, valuesFor(condition.field));
      if (condition.negated && condition.operator === "contains")
        return `${field}不含${value}`;
      const expression = `${field} ${COMPARE_SYMBOL[condition.operator]} ${value}`;
      return condition.negated ? `非（${expression}）` : expression;
    }
    case "in": {
      const values = condition.values
        .map((value) => valueLabel(value, valuesFor(condition.field)))
        .join("、");
      return `${fieldLabel(condition.field)}${condition.negated ? "不属于" : "属于"}（${values}）`;
    }
    case "isNull":
      return `${fieldLabel(condition.field)}${condition.negated ? "不为空" : "为空"}`;
    case "isMissing":
      return `${fieldLabel(condition.field)}${condition.negated ? "已提供" : "未提供"}`;
    case "all":
    case "any": {
      const joiner = condition.kind === "all" ? " 且 " : " 或 ";
      return `（${condition.terms.map((term) =>
        describeCondition(term, fieldLabel, valuesFor)
      ).join(joiner)}）`;
    }
    case "not":
      return `非（${describeCondition(condition.term, fieldLabel, valuesFor)}）`;
  }
}

function describeEntity(ref: string, options: QueryPresentationOptions): string {
  const resolved = options.entityLabel?.(ref);
  if (resolved) return resolved;
  try {
    const { owner, archiveId } = parseEntityRef(ref);
    return `${OWNER_LABEL[owner]} #${archiveId}`;
  } catch {
    return "未知条目";
  }
}

function describeRelation(
  relation: ExplorerRelation,
  options: QueryPresentationOptions,
): string {
  const relatedOwner = parseEntityRef(relation.related).owner;
  const parts = [
    `${relation.exists ? "" : "没有"}${FACT_LABEL[relation.factKind] ?? relation.factKind}`,
    `${OWNER_LABEL[relatedOwner]}是${describeEntity(relation.related, options)}`,
  ];
  if (relation.condition) {
    parts.push(describeCondition(
      relation.condition,
      (field) => FACT_FIELD_LABEL[field] ?? field,
      (field) => factEnumValues(
        relation.factKind as QueryFactKind,
        field,
        options.mappings,
      ),
    ));
  }
  return parts.join(" · ");
}

function sameScope(left: readonly Owner[], right: readonly Owner[]): boolean {
  return left.length === right.length && left.every((owner, index) => owner === right[index]);
}

export function entityScopeLabel(scope: EntityScope): string {
  if (sameScope(scope, DEFAULT_ENTITY_SCOPE)) return "全部";
  return scope.map((owner) => OWNER_LABEL[owner]).join("、");
}

function listTokens(
  draft: { kind: "list"; query: import("./draft").ListQuery } |
    { kind: "aggregate"; query: import("./draft").AggregateQuery },
  options: QueryPresentationOptions,
): QueryToken[] {
  const { query } = draft;
  const owner = draft.kind === "aggregate"
    ? draft.query.owner
    : draft.query.scope.length === 1 ? draft.query.scope[0] : null;
  const result: QueryToken[] = [
    token(
      "head",
      "intent",
      draft.kind === "aggregate"
        ? `统计${OWNER_LABEL[draft.query.owner]}`
        : `查找${entityScopeLabel(draft.query.scope)}`,
      { type: "head" },
    ),
  ];

  if (query.text?.capability === "fullText") {
    const field = query.text.field ?? "summary";
    result.push(token(
      "text",
      "text",
      `${FIELD_LABEL[field] ?? field}含“${query.text.value}”`,
      { type: "text" },
      true,
    ));
  }

  conditionTerms(query.condition).forEach((condition, index) => {
    result.push(token(
      `condition:${index}`,
      "condition",
      describeCondition(
        condition,
        (field) => FIELD_LABEL[field] ?? field,
        (field) => owner ? enumValuesFor(owner, field, options.mappings) : null,
      ),
      { type: "condition", index },
      true,
    ));
  });

  for (const [index, relation] of (query.relations ?? []).entries()) {
    result.push(token(
      `relation:${index}`,
      "relation",
      describeRelation(relation, options),
      { type: "relation", index },
      true,
    ));
  }

  if (draft.kind === "list" && query.columns?.length) {
    result.push(token(
      "columns",
      "shape",
      `显示${query.columns.map((field) => FIELD_LABEL[field] ?? field).join("、")}`,
      { type: "columns" },
      true,
    ));
  }

  if (draft.kind === "aggregate") {
    const aggregate = draft.query.aggregate;
    const parts = [
      ...(aggregate.groupBy.length
        ? [`按${aggregate.groupBy.map((field) => FIELD_LABEL[field] ?? field).join("、")}分组`]
        : []),
      aggregate.metrics.map(describeAggregateMetric).join("、"),
    ].filter(Boolean);
    result.push(token(
      "aggregate",
      "shape",
      parts.join(" · "),
      { type: "aggregate" },
    ));
    if (aggregate.having) {
      const statisticLabels = Object.fromEntries(
        queryStatisticColumns(aggregate).map(({ value, label }) => [value, label]),
      );
      result.push(token(
        "having",
        "condition",
        `统计结果中${describeCondition(
          aggregate.having,
          (field) => statisticLabels[field] ?? field,
          (field) => aggregate.groupBy.includes(field)
            ? enumValuesFor(draft.query.owner, field, options.mappings)
            : null,
        )}`,
        { type: "having" },
        true,
      ));
    }
  }

  if (query.orderBy?.length) {
    result.push(token(
      "order",
      "order",
      `按${query.orderBy.map((order) =>
        `${FIELD_LABEL[order.column] ?? order.column}${order.direction === "asc" ? "升序" : "降序"}`
      ).join("、")}`,
      { type: "order" },
      true,
    ));
  }
  if (query.limit !== undefined && query.limit !== null) {
    result.push(token(
      "limit",
      "limit",
      `最多 ${query.limit} 条`,
      { type: "limit" },
      true,
    ));
  }
  return result;
}

export function queryTokens(
  draft: QueryDraft,
  options: QueryPresentationOptions = {},
): QueryToken[] {
  if (draft.kind === "list" && !draft.query) {
    return [
      token("intent", "intent", "查找正文", { type: "intent" }),
      token("text-scope", "scope", "所有正文与关系备注", { type: "text" }),
      token("text", "text", `正文含“${draft.allText}”`, { type: "text" }, true),
    ];
  }
  if ((draft.kind === "list" || draft.kind === "aggregate") && draft.query)
    return listTokens(draft, options);
  if (draft.kind === "comparison") {
    return [
      token("head", "intent", "比较共同关联", { type: "head" }),
      token("from", "entity", describeEntity(draft.from, options), {
        type: "endpoint",
        endpoint: "from",
      }),
      token("to", "entity", describeEntity(draft.to, options), {
        type: "endpoint",
        endpoint: "to",
      }),
    ];
  }
  return [
    token("head", "intent", "最短路径", { type: "head" }),
    token("from", "entity", describeEntity(draft.from, options), {
      type: "endpoint",
      endpoint: "from",
    }),
    token("to", "entity", describeEntity(draft.to, options), {
      type: "endpoint",
      endpoint: "to",
    }),
    token("max-hops", "limit", `最多 ${draft.maxHops} 跳`, { type: "maxHops" }),
    token("max-paths", "limit", `最多 ${draft.maxPaths} 条`, { type: "maxPaths" }),
  ];
}

export function queryInputValue(draft: QueryDraft): string {
  if (draft.kind !== "list" && draft.kind !== "aggregate") return "";
  return draft.query?.text?.capability === "lookup" ? draft.query.text.value : "";
}

const LIST_ACTIONS: CompletionAction[] = [
  { id: "fullText", label: "检索正文", description: "在简介或分集介绍中查找文字" },
  { id: "condition", label: "添加条件", description: "按字段和值缩小范围" },
  { id: "relation", label: "添加关联", description: "按相关作品、人物或角色筛选" },
  { id: "columns", label: "选择显示列", description: "决定列表中显示哪些属性" },
  { id: "sort", label: "排序", description: "按一个或多个字段排列结果" },
  { id: "limit", label: "限定条数", description: "只在明确需要时限制结果" },
  { id: "aggregate", label: "统计", description: "分组并计算条数、合计或平均值" },
  { id: "comparison", label: "比较两个条目", description: "查看共同关联与差异" },
  { id: "path", label: "查找关系路径", description: "寻找两个条目之间的最短关联" },
];

const SHAPE_ACTIONS: CompletionAction[] = [
  { id: "list", label: "查找条目", description: "返回可继续筛选的条目列表" },
  { id: "comparison", label: "比较两个条目", description: "查看共同关联与差异" },
  { id: "path", label: "查找关系路径", description: "寻找两个条目之间的最短关联" },
];

const LIST_SHAPE_ACTION: CompletionAction = {
  id: "list",
  label: "查找条目",
  description: "返回可继续筛选的条目列表",
};

function listActions(owner: Owner): CompletionAction[] {
  return LIST_ACTIONS.filter((action) =>
    action.id !== "relation" || queryRelationOptions(owner).length > 0
  );
}

function scopedActions(scope: EntityScope): CompletionAction[] {
  const shared = LIST_ACTIONS.filter((action) =>
    action.id === "fullText" || action.id === "limit" ||
    action.id === "comparison" || action.id === "path"
  );
  const typedIds = new Set<CompletionActionId>([
    "condition", "relation", "columns", "sort", "aggregate",
  ]);
  const typed = scope.flatMap((owner) =>
    listActions(owner)
      .filter((action) => typedIds.has(action.id))
      .map((action) => ({
        ...action,
        owner,
        label: `${OWNER_LABEL[owner]} · ${action.label}`,
      }))
  );
  return [shared[0]!, ...typed, ...shared.slice(1)];
}

export function completionActions(
  draft: QueryDraft,
  input: string,
): CompletionAction[] {
  const actions = draft.kind === "list"
    ? draft.query
      ? draft.query.scope.length === 1
        ? listActions(draft.query.scope[0]!)
        : scopedActions(draft.query.scope)
      : [LIST_ACTIONS[0]!, LIST_SHAPE_ACTION, ...SHAPE_ACTIONS.slice(1)]
    : draft.kind === "aggregate"
      ? [
          ...listActions(draft.query.owner).filter((action) =>
            action.id !== "columns" && action.id !== "aggregate"
          ),
          LIST_SHAPE_ACTION,
        ]
      : SHAPE_ACTIONS;
  const needle = input.trim().replace(/^\//, "").toLocaleLowerCase();
  if (!needle) return actions;
  return actions.filter((action) =>
    `${action.label} ${action.description}`.toLocaleLowerCase().includes(needle)
  );
}
