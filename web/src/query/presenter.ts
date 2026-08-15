import {
  parseEntityRef,
  QUERY_CONTRACT,
  type Owner,
  type QueryFactKind,
} from "./contract";
import type { ExplorerCondition, ExplorerRelation } from "./explorer";
import {
  ENTITY_SCOPE_ORDER,
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
  queryFactDiscriminatorField,
  queryReferenceOwner,
  queryStatisticColumns,
  sameFilterFieldSemantics,
  splitFactDiscriminatorCondition,
} from "./workbench-model";
import type { Mappings } from "../types";
import { normalizeResultColumnSelection } from "./result-columns";

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
  options?: QueryPresentationOptions,
  referenceOwner?: Owner | null,
): string {
  const mapped = values?.[String(value)];
  if (mapped !== undefined) return mapped;
  if (typeof value === "string" && options && referenceOwner) {
    try {
      if (parseEntityRef(value).owner === referenceOwner)
        return describeEntity(value, options);
    } catch {
      // Invalid references keep their quoted value below.
    }
  }
  if (typeof value === "string") return `“${value}”`;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null) return "空值";
  return String(value);
}

function describeCondition(
  condition: ExplorerCondition,
  fieldLabel: (field: string) => string,
  valuesFor: (field: string) => Record<string, string> | null,
  options?: QueryPresentationOptions,
  referenceOwnerFor?: (field: string) => Owner | null,
): string {
  switch (condition.kind) {
    case "compare": {
      const field = fieldLabel(condition.field);
      const value = valueLabel(
        condition.value,
        valuesFor(condition.field),
        options,
        referenceOwnerFor?.(condition.field),
      );
      if (condition.negated && condition.operator === "contains")
        return `${field}不含${value}`;
      const expression = `${field} ${COMPARE_SYMBOL[condition.operator]} ${value}`;
      return condition.negated ? `非（${expression}）` : expression;
    }
    case "in": {
      const values = condition.values
        .map((value) => valueLabel(
          value,
          valuesFor(condition.field),
          options,
          referenceOwnerFor?.(condition.field),
        ))
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
        describeCondition(term, fieldLabel, valuesFor, options, referenceOwnerFor)
      ).join(joiner)}）`;
    }
    case "not":
      return `非（${describeCondition(
        condition.term,
        fieldLabel,
        valuesFor,
        options,
        referenceOwnerFor,
      )}）`;
  }
}

export function describeFactCondition(
  kind: QueryFactKind,
  condition: ExplorerCondition,
  mappings?: Mappings,
): string {
  return describeCondition(
    condition,
    (field) => FACT_FIELD_LABEL[field] ?? field,
    (field) => factEnumValues(kind, field, mappings),
  );
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
  const split = splitFactDiscriminatorCondition(
    relation.factKind,
    relation.condition,
  );
  const discriminatorField = queryFactDiscriminatorField(relation.factKind);
  const relationship = split.discriminator && discriminatorField
    ? [...new Set(split.values.map((value) =>
        valueLabel(
          value,
          factEnumValues(
            relation.factKind,
            discriminatorField,
            options.mappings,
          ),
        )
      ))].join("、")
    : FACT_LABEL[relation.factKind] ?? relation.factKind;
  const entity = describeEntity(relation.related, options);
  const description = split.discriminator
    ? `${relationship}是${entity}`
    : `${relationship}：${entity}`;
  const parts = [relation.exists ? description : `排除：${description}`];
  for (const endpoint of relation.additionalEndpoints ?? []) {
    const owner = QUERY_CONTRACT.facts[relation.factKind].roles[endpoint.role];
    if (!owner) continue;
    parts.push(`${OWNER_LABEL[owner]}：${describeEntity(endpoint.related, options)}`);
  }
  if (split.remainder) {
    parts.push(describeFactCondition(
      relation.factKind as QueryFactKind,
      split.remainder,
      options.mappings,
    ));
  }
  return parts.join(" · ");
}

function sameScope(left: readonly Owner[], right: readonly Owner[]): boolean {
  return left.length === right.length && left.every((owner, index) => owner === right[index]);
}

export function entityScopeLabel(scope: EntityScope): string {
  if (sameScope(scope, ENTITY_SCOPE_ORDER)) return "全部类型";
  return scope.map((owner) => OWNER_LABEL[owner]).join("、");
}

function listTokens(
  draft: { kind: "list"; query: import("./draft").ListQuery } |
    { kind: "aggregate"; query: import("./draft").AggregateQuery },
  options: QueryPresentationOptions,
): QueryToken[] {
  const { query } = draft;
  const ownerForField = (field: string): Owner | null => {
    if (draft.kind === "aggregate") return draft.query.owner;
    const [first, ...rest] = draft.query.scope;
    return first && rest.every((owner) =>
      sameFilterFieldSemantics(first, owner, field)
    ) ? first : null;
  };
  const result: QueryToken[] = [draft.kind === "aggregate"
    ? token(
        "head",
        "intent",
        `统计${OWNER_LABEL[draft.query.owner]}`,
        { type: "owner" },
      )
    : token(
        "head",
        "scope",
        entityScopeLabel(draft.query.scope),
        { type: "owner" },
      )];

  if (query.fullText) {
    const label = draft.kind === "aggregate"
      ? FIELD_LABEL[draft.query.fullText!.field] ?? draft.query.fullText!.field
      : draft.query.scope.includes("episode") &&
          draft.query.scope.some((owner) => owner !== "episode")
        ? "简介与分集介绍"
        : draft.query.scope[0] === "episode" ? "分集介绍" : "简介";
    result.push(token(
      "text",
      "text",
      `${label}含“${query.fullText.value}”`,
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
        (field) => {
          const owner = ownerForField(field);
          return owner ? enumValuesFor(owner, field, options.mappings) : null;
        },
        options,
        (field) => {
          const owner = ownerForField(field);
          return owner ? queryReferenceOwner(owner, field) : null;
        },
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

  if (draft.kind === "list" && query.columns !== undefined) {
    const columns = normalizeResultColumnSelection(
      draft.query.scope,
      query.columns,
    );
    result.push(token(
      "columns",
      "shape",
      columns.length
        ? `显示${columns.map((field) => FIELD_LABEL[field] ?? field).join("、")}`
        : "仅显示条目",
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
          options,
          (field) => aggregate.groupBy.includes(field)
            ? queryReferenceOwner(draft.query.owner, field)
            : null,
        )}`,
        { type: "having" },
        true,
      ));
    }
  }

  if (query.orderBy?.length) {
    const prefix = query.limit !== undefined && query.limit !== null
      ? `前 ${query.limit} 条 · `
      : "";
    const labels = query.orderBy.map((order) => {
      const field = FIELD_LABEL[order.column] ?? order.column;
      const label = "owners" in order && order.owners?.length
        ? `${order.owners.map((owner) => OWNER_LABEL[owner]).join("、")}的${field}`
        : field;
      return `${label}${order.direction === "asc" ? "升序" : "降序"}`;
    });
    const terms = labels.length === 1
      ? `按${labels[0]}`
      : labels.map((label, index) => `${index === 0 ? "先按" : "再按"}${label}`).join("，");
    result.push(token(
      "order",
      "order",
      `${prefix}${terms}`,
      { type: "order" },
      true,
    ));
  }
  if (
    query.limit !== undefined && query.limit !== null &&
    !query.orderBy?.length
  ) {
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
      token("intent", "intent", "查找正文", { type: "intent" }, false, false),
      token("text-scope", "scope", "所有正文与关系备注", { type: "text" }),
      token("text", "text", `正文含“${draft.allText}”`, { type: "text" }, true),
    ];
  }
  if ((draft.kind === "list" || draft.kind === "aggregate") && draft.query)
    return listTokens(draft, options);
  if (draft.kind === "comparison") {
    return [
      token("head", "intent", "比较共同关联", { type: "head" }, false, false),
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
    token("head", "intent", "最短路径", { type: "head" }, false, false),
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
  return draft.query?.text?.value ?? "";
}
