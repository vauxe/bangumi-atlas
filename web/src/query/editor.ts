import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Node as ProseMirrorNode, Schema, type NodeSpec } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

import type { ExplorerCondition, ExplorerQuery } from "./explorer";
import type { Owner, QueryFactKind } from "./contract";
import {
  FIELD_LABEL,
  OPERATOR_LABEL,
  OWNER_LABEL,
  conditionEditorOperator,
  enumValuesFor,
  parseExplorerLimit,
  parseValue,
  parseValues,
  queryConditionOperators,
  queryRelationOptions,
} from "./workbench-model";

const clause = (name: string, attrs: NodeSpec["attrs"]): NodeSpec => ({
  group: "query_clause",
  atom: true,
  selectable: true,
  attrs,
  toDOM: () => ["div", { "data-query-clause": name }],
});

/** The editor schema stores query meaning, never source text or form state. */
export const queryEditorSchema = new Schema({
  nodes: {
    doc: { content: "find query_clause*" },
    find: {
      atom: true,
      selectable: true,
      attrs: { owner: { default: "subject" } },
      toDOM: () => ["div", { "data-query-clause": "find" }],
    },
    search: clause("search", {
      scope: { default: "lookup" },
      raw: { default: "" },
    }),
    condition: clause("condition", {
      field: { default: "" },
      operator: { default: "" },
      raw: { default: "" },
      expression: { default: null },
    }),
    relation: clause("relation", {
      selection: { default: "" },
      exists: { default: true },
      related: { default: "" },
    }),
    projection: clause("projection", {
      columns: { default: [] },
    }),
    sort: clause("sort", {
      field: { default: "" },
      direction: { default: "asc" },
    }),
    limit: clause("limit", {
      raw: { default: "200" },
    }),
    text: {},
  },
});

export interface QueryEditorDiagnostic {
  /** Zero-based top-level clause index. */
  clause: number;
  message: string;
}

export interface LoweredQueryEditorDocument {
  draft: ExplorerQuery | null;
  diagnostics: QueryEditorDiagnostic[];
}

function editableCondition(
  condition: ExplorerCondition,
): { field: string; operator: string; raw: string; expression: null } | null {
  if (
    condition.kind !== "compare" &&
    condition.kind !== "in" &&
    condition.kind !== "isNull" &&
    condition.kind !== "isMissing"
  ) return null;
  const operator = conditionEditorOperator(condition);
  if (!operator) return null;
  const raw = condition.kind === "compare"
    ? String(condition.value)
    : condition.kind === "in"
      ? condition.values.map(String).join("、")
      : "";
  return { field: condition.field, operator, raw, expression: null };
}

export function createQueryEditorDocument(draft: ExplorerQuery): ProseMirrorNode {
  const children: ProseMirrorNode[] = [
    queryEditorSchema.node("find", { owner: draft.owner }),
  ];
  if (draft.text) {
    children.push(queryEditorSchema.node("search", {
      scope: draft.text.capability === "lookup"
        ? "lookup"
        : `fullText:${draft.text.field ?? ""}`,
      raw: draft.text.value,
    }));
  }
  if (draft.condition) {
    children.push(queryEditorSchema.node(
      "condition",
      editableCondition(draft.condition) ?? {
        field: "",
        operator: "",
        raw: "",
        expression: draft.condition,
      },
    ));
  }
  for (const relation of draft.relations ?? []) {
    children.push(queryEditorSchema.node("relation", {
      selection: [
        relation.factKind,
        relation.candidateRole,
        relation.relatedRole,
      ].join("|"),
      exists: relation.exists,
      related: relation.related,
    }));
  }
  if (draft.columns) {
    children.push(queryEditorSchema.node("projection", {
      columns: [...draft.columns],
    }));
  }
  for (const order of draft.orderBy ?? []) {
    children.push(queryEditorSchema.node("sort", {
      field: order.column,
      direction: order.direction,
    }));
  }
  if (draft.limit !== null) {
    children.push(queryEditorSchema.node("limit", {
      raw: String(draft.limit ?? 200),
    }));
  }
  return queryEditorSchema.node("doc", null, children);
}

export function createQueryEditorState(doc: ProseMirrorNode): EditorState {
  return EditorState.create({
    doc,
    plugins: [
      history(),
      keymap({
        "Mod-z": undo,
        "Mod-Shift-z": redo,
        "Mod-y": redo,
      }),
    ],
  });
}

function conditionFromAttrs(
  owner: Owner,
  attrs: Record<string, unknown>,
): ExplorerCondition {
  const expression = attrs.expression;
  if (expression) return expression as ExplorerCondition;
  const field = String(attrs.field ?? "");
  const operator = String(attrs.operator ?? "");
  const raw = String(attrs.raw ?? "");
  const allowed = queryConditionOperators(owner, field);
  if (!field || !allowed.includes(operator))
    throw new TypeError("请选择有效的条件字段和比较方式");
  if (
    operator !== "isNull" && operator !== "isNotNull" &&
    operator !== "isMissing" && operator !== "isPresent" &&
    !raw.trim()
  ) throw new TypeError(`请填写${FIELD_LABEL[field] ?? field}的值`);
  if (operator === "in" || operator === "notIn") {
    return {
      kind: "in",
      field,
      values: parseValues(owner, field, raw),
      ...(operator === "notIn" ? { negated: true } : {}),
    };
  }
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
  return {
    kind: "compare",
    field,
    operator: operator === "notContains" ? "contains" : operator as
      "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains",
    value: parseValue(owner, field, raw),
    ...(operator === "notContains" ? { negated: true } : {}),
  };
}

export function lowerQueryEditorDocument(
  doc: ProseMirrorNode,
): LoweredQueryEditorDocument {
  const diagnostics: QueryEditorDiagnostic[] = [];
  const owner = String(doc.firstChild?.attrs.owner ?? "") as Owner;
  if (!(owner in OWNER_LABEL)) {
    return {
      draft: null,
      diagnostics: [{ clause: 0, message: "请选择要查找的实体类型" }],
    };
  }
  const draft: ExplorerQuery = { owner };
  const conditions: ExplorerCondition[] = [];
  const relations: NonNullable<ExplorerQuery["relations"]> = [];
  const orderBy: NonNullable<ExplorerQuery["orderBy"]> = [];

  for (let index = 1; index < doc.childCount; index++) {
    const node = doc.child(index);
    try {
      switch (node.type.name) {
        case "search": {
          if (draft.text) throw new TypeError("一个查询只能有一个搜索条件");
          const raw = String(node.attrs.raw ?? "").trim();
          if (!raw) throw new TypeError("请输入要搜索的文字");
          const scope = String(node.attrs.scope ?? "");
          draft.text = scope === "lookup"
            ? { value: raw, capability: "lookup" }
            : scope.startsWith("fullText:") && scope.slice(9)
              ? {
                  value: raw,
                  capability: "fullText",
                  field: scope.slice(9) as "summary" | "description",
                }
              : (() => { throw new TypeError("请选择搜索范围"); })();
          break;
        }
        case "condition":
          conditions.push(conditionFromAttrs(owner, node.attrs));
          break;
        case "relation": {
          const [factKind, candidateRole, relatedRole] = String(
            node.attrs.selection ?? "",
          ).split("|");
          const related = String(node.attrs.related ?? "");
          if (!factKind || !candidateRole || !relatedRole)
            throw new TypeError("请选择关联类型");
          if (!related) throw new TypeError("请选择关联实体");
          relations.push({
            factKind: factKind as QueryFactKind,
            candidateRole,
            relatedRole,
            related: related as `${Owner}:${number}`,
            exists: Boolean(node.attrs.exists),
          });
          break;
        }
        case "projection": {
          if (draft.columns) throw new TypeError("一个查询只能有一个返回设置");
          const columns = node.attrs.columns;
          if (!Array.isArray(columns) || !columns.length)
            throw new TypeError("请至少返回一项信息");
          draft.columns = columns.map(String);
          break;
        }
        case "sort": {
          const field = String(node.attrs.field ?? "");
          const direction = String(node.attrs.direction ?? "");
          if (!field || (direction !== "asc" && direction !== "desc"))
            throw new TypeError("请完成排序设置");
          orderBy.push({ column: field, direction, nulls: "last" });
          break;
        }
        case "limit":
          if (draft.limit !== undefined)
            throw new TypeError("一个查询只能有一个结果上限");
          draft.limit = parseExplorerLimit(String(node.attrs.raw ?? ""));
          break;
      }
    } catch (error) {
      diagnostics.push({
        clause: index,
        message: error instanceof Error ? error.message : "当前语句不完整",
      });
    }
  }
  if (conditions.length)
    draft.condition = conditions.length === 1
      ? conditions[0]
      : { kind: "all", terms: conditions };
  if (relations.length) draft.relations = relations;
  if (orderBy.length) draft.orderBy = orderBy;
  return { draft: diagnostics.length ? null : draft, diagnostics };
}

function displayValue(owner: Owner, field: string, raw: string): string {
  const labels = enumValuesFor(owner, field);
  if (labels && raw in labels) return labels[raw] ?? raw;
  return raw;
}

export function readableQueryEditorDocument(
  doc: ProseMirrorNode,
  entityLabel: (ref: string) => string = (ref) => ref,
): string {
  const owner = String(doc.firstChild?.attrs.owner ?? "subject") as Owner;
  const lines = [`查找${OWNER_LABEL[owner] ?? "条目"}`];
  for (let index = 1; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (node.type.name === "search") {
      const scope = String(node.attrs.scope ?? "lookup");
      lines.push(`${scope === "lookup" ? "名称" : scope.endsWith("description") ? "分集介绍" : "简介"} 包含 ${String(node.attrs.raw ?? "")}`);
    } else if (node.type.name === "condition") {
      const expression = node.attrs.expression as ExplorerCondition | null;
      if (expression) {
        lines.push("其中包含一组复合条件");
      } else {
        const field = String(node.attrs.field ?? "");
        const operator = String(node.attrs.operator ?? "");
        const raw = String(node.attrs.raw ?? "");
        lines.push(`${FIELD_LABEL[field] ?? field} ${OPERATOR_LABEL[operator] ?? operator}${raw ? ` ${displayValue(owner, field, raw)}` : ""}`);
      }
    } else if (node.type.name === "relation") {
      const selection = String(node.attrs.selection ?? "");
      const relation = queryRelationOptions(owner).find((item) =>
        item.value === selection
      )?.label ?? "关联";
      lines.push(`${Boolean(node.attrs.exists) ? "关联" : "不关联"} ${relation} ${entityLabel(String(node.attrs.related ?? ""))}`);
    } else if (node.type.name === "projection") {
      lines.push(`返回 ${(node.attrs.columns as string[]).map((field) => FIELD_LABEL[field] ?? field).join("、")}`);
    } else if (node.type.name === "sort") {
      const field = String(node.attrs.field ?? "");
      lines.push(`按 ${FIELD_LABEL[field] ?? field} ${node.attrs.direction === "desc" ? "从高到低" : "从低到高"}`);
    } else if (node.type.name === "limit") {
      lines.push(`限制 ${String(node.attrs.raw ?? "")} 条`);
    }
  }
  return lines.join("\n");
}
