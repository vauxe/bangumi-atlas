import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Node as ProseMirrorNode, Schema, type NodeSpec } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

import type { ExplorerCondition, ExplorerQuery } from "./explorer";
import type { QueryBundle } from "./bundle";
import type { Owner, QueryFactKind } from "./contract";
import type { QueryDocument, QueryOperator } from "./document";
import {
  FACT_FIELD_LABEL,
  FIELD_LABEL,
  OPERATOR_LABEL,
  OWNER_LABEL,
  conditionEditorOperator,
  enumValuesFor,
  parseExplorerLimit,
  parseFactValue,
  parseFactValues,
  parseValue,
  parseValues,
  queryConditionOperators,
  queryFactConditionOperators,
  queryRelationOptions,
} from "./workbench-model";

const clause = (name: string, attrs: NodeSpec["attrs"]): NodeSpec => ({
  group: "query_clause",
  atom: true,
  selectable: true,
  attrs,
  toDOM: () => ["div", { "data-query-clause": name }],
});

export const QUERY_OPERATOR_NODE: Record<QueryOperator["kind"], string> = {
  scan: "op_scan",
  lookup: "op_lookup",
  fullText: "op_full_text",
  factLookup: "op_fact_lookup",
  values: "op_values",
  filter: "op_filter",
  project: "op_project",
  matchFact: "op_match_fact",
  followRef: "op_follow_ref",
  aggregate: "op_aggregate",
  path: "op_path",
  union: "op_union",
  intersect: "op_intersect",
  except: "op_except",
  exists: "op_exists",
  notExists: "op_not_exists",
};

const queryOperatorNodes = Object.fromEntries(
  Object.values(QUERY_OPERATOR_NODE).map((name) => [name, {
    group: "query_operator",
    atom: true,
    selectable: true,
    attrs: { id: { default: "" }, value: { default: null } },
    toDOM: () => ["div", { "data-query-operator": name }],
  } satisfies NodeSpec]),
);

/** The editor schema stores query meaning, never source text or form state. */
export const queryEditorSchema = new Schema({
  nodes: {
    doc: { content: "(find query_clause*) | recipe | query_bundle" },
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
    condition: {
      ...clause("condition", {
        field: { default: "" },
        operator: { default: "" },
        raw: { default: "" },
      }),
      group: "query_clause condition_term",
    },
    condition_group: {
      group: "query_clause condition_term",
      content: "condition_term+",
      selectable: true,
      attrs: { mode: { default: "all" } },
      toDOM: () => ["div", { "data-query-clause": "condition-group" }, 0],
    },
    relation: clause("relation", {
      selection: { default: "" },
      exists: { default: true },
      related: { default: "" },
      factConditions: { default: [] },
    }),
    projection: clause("projection", {
      columns: { default: [] },
    }),
    sort: clause("sort", {
      field: { default: "" },
      direction: { default: "asc" },
      nulls: { default: "last" },
    }),
    limit: clause("limit", {
      raw: { default: "200" },
    }),
    recipe: {
      atom: true,
      selectable: true,
      attrs: {
        kind: { default: "fullText" },
        text: { default: "" },
        from: { default: "" },
        to: { default: "" },
      },
      toDOM: () => ["div", { "data-query-clause": "recipe" }],
    },
    query_bundle: {
      content: "query_section+",
      selectable: true,
      attrs: { release: { default: { policy: "latest" } } },
      toDOM: () => ["div", { "data-query-bundle": "" }, 0],
    },
    query_section: {
      content: "query_operator+",
      selectable: true,
      attrs: {
        name: { default: "results" },
        query: { default: null },
        parameterValues: { default: null },
        answer: { default: null },
      },
      toDOM: () => ["section", { "data-query-section": "" }, 0],
    },
    ...queryOperatorNodes,
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
  recipe?: QueryEditorRecipe;
  bundle?: QueryBundle;
  diagnostics: QueryEditorDiagnostic[];
}

export type QueryEditorRecipe =
  | { kind: "fullText"; text: string }
  | { kind: "common" | "path"; from: string; to: string };

function editableCondition(
  condition: ExplorerCondition,
): { field: string; operator: string; raw: string } | null {
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
  return { field: condition.field, operator, raw };
}

function conditionEditorNode(condition: ExplorerCondition): ProseMirrorNode {
  if (condition.kind === "all" || condition.kind === "any") {
    return queryEditorSchema.node(
      "condition_group",
      { mode: condition.kind },
      condition.terms.map(conditionEditorNode),
    );
  }
  if (condition.kind === "not") {
    return queryEditorSchema.node(
      "condition_group",
      { mode: "not" },
      [conditionEditorNode(condition.term)],
    );
  }
  const editable = editableCondition(condition);
  if (editable) return queryEditorSchema.node("condition", editable);
  if (condition.kind === "compare" && condition.negated) {
    const positive: ExplorerCondition = {
      kind: "compare",
      field: condition.field,
      operator: condition.operator,
      value: condition.value,
    };
    return queryEditorSchema.node(
      "condition_group",
      { mode: "not" },
      [conditionEditorNode(positive)],
    );
  }
  throw new TypeError("当前条件无法转换为结构化编辑节点");
}

export interface EditableFactCondition {
  field: string;
  operator: string;
  raw: string;
}

function editableFactConditions(
  condition: ExplorerCondition | undefined,
): EditableFactCondition[] {
  if (!condition) return [];
  const terms = condition.kind === "all" ? condition.terms : [condition];
  const editable = terms.map(editableCondition);
  if (editable.some((item) => item === null))
    throw new TypeError("当前关系条件需要高级查询编辑器");
  return editable as EditableFactCondition[];
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
    children.push(conditionEditorNode(draft.condition));
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
      factConditions: editableFactConditions(relation.condition),
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
      nulls: order.nulls,
    }));
  }
  if (draft.limit !== undefined && draft.limit !== null) {
    children.push(queryEditorSchema.node("limit", {
      raw: String(draft.limit ?? 200),
    }));
  }
  return queryEditorSchema.node("doc", null, children);
}

export function createQueryRecipeDocument(
  recipe: QueryEditorRecipe,
): ProseMirrorNode {
  return queryEditorSchema.node("doc", null, [
    queryEditorSchema.node("recipe", {
      kind: recipe.kind,
      text: recipe.kind === "fullText" ? recipe.text : "",
      from: recipe.kind === "fullText" ? "" : recipe.from,
      to: recipe.kind === "fullText" ? "" : recipe.to,
    }),
  ]);
}

export function createQueryBundleDocument(bundle: QueryBundle): ProseMirrorNode {
  const sections = Object.entries(bundle.sections).map(([name, section]) => {
    const { operators, ...query } = section.query;
    const operatorNodes = Object.entries(operators).map(([id, value]) =>
      queryEditorSchema.node(QUERY_OPERATOR_NODE[value.kind], { id, value })
    );
    return queryEditorSchema.node("query_section", {
      name,
      query,
      parameterValues: section.parameterValues ?? null,
      answer: section.answer,
    }, operatorNodes);
  });
  return queryEditorSchema.node("doc", null, [
    queryEditorSchema.node("query_bundle", { release: bundle.release }, sections),
  ]);
}

function bundleFromEditorNode(node: ProseMirrorNode): QueryBundle | null {
  const sections: QueryBundle["sections"] = {};
  for (let index = 0; index < node.childCount; index++) {
    const section = node.child(index);
    const query = section.attrs.query as Omit<QueryDocument, "operators"> | null;
    const answer = section.attrs.answer as QueryBundle["sections"][string]["answer"] | null;
    if (!query || !answer) return null;
    const operators: Record<string, QueryOperator> = {};
    for (let operatorIndex = 0; operatorIndex < section.childCount; operatorIndex++) {
      const operator = section.child(operatorIndex);
      const id = String(operator.attrs.id ?? "");
      const value = operator.attrs.value as QueryOperator | null;
      if (!id || !value || QUERY_OPERATOR_NODE[value.kind] !== operator.type.name)
        return null;
      operators[id] = value;
    }
    const parameterValues = section.attrs.parameterValues as QueryBundle["sections"][string]["parameterValues"] | null;
    sections[String(section.attrs.name)] = {
      query: { ...query, operators },
      ...(parameterValues ? { parameterValues } : {}),
      answer,
    };
  }
  return Object.keys(sections).length
    ? {
        schema: "atlas-query-bundle-v2",
        release: node.attrs.release as QueryBundle["release"],
        sections,
      }
    : null;
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

function conditionFromNode(owner: Owner, node: ProseMirrorNode): ExplorerCondition {
  if (node.type.name === "condition") return conditionFromAttrs(owner, node.attrs);
  if (node.type.name !== "condition_group")
    throw new TypeError("条件节点无效");
  const mode = String(node.attrs.mode);
  const terms: ExplorerCondition[] = [];
  node.forEach((child) => terms.push(conditionFromNode(owner, child)));
  if (!terms.length) throw new TypeError("条件组不能为空");
  if (mode === "not") {
    if (terms.length !== 1) throw new TypeError("排除条件只能包含一个条件");
    return { kind: "not", term: terms[0]! };
  }
  if (mode !== "all" && mode !== "any")
    throw new TypeError("请选择条件组的匹配方式");
  return { kind: mode, terms };
}

function factConditionFromAttrs(
  kind: QueryFactKind,
  attrs: EditableFactCondition,
): ExplorerCondition {
  const field = String(attrs.field ?? "");
  const operator = String(attrs.operator ?? "");
  const raw = String(attrs.raw ?? "");
  if (!field || !queryFactConditionOperators(kind, field).includes(operator))
    throw new TypeError("请选择有效的关系属性和比较方式");
  if (
    operator !== "isNull" && operator !== "isNotNull" &&
    operator !== "isMissing" && operator !== "isPresent" &&
    !raw.trim()
  ) throw new TypeError("请填写关系属性的值");
  if (operator === "in" || operator === "notIn") {
    return {
      kind: "in",
      field,
      values: parseFactValues(kind, field, raw),
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
    value: parseFactValue(kind, field, raw),
    ...(operator === "notContains" ? { negated: true } : {}),
  };
}

export function lowerQueryEditorDocument(
  doc: ProseMirrorNode,
): LoweredQueryEditorDocument {
  const diagnostics: QueryEditorDiagnostic[] = [];
  if (doc.firstChild?.type.name === "query_bundle") {
    const bundle = bundleFromEditorNode(doc.firstChild);
    return bundle
      ? { draft: null, bundle, diagnostics }
      : {
          draft: null,
          diagnostics: [{ clause: 0, message: "查询内容不完整" }],
        };
  }
  if (doc.firstChild?.type.name === "recipe") {
    const kind = String(doc.firstChild.attrs.kind);
    if (kind === "fullText") {
      const text = String(doc.firstChild.attrs.text).trim();
      return text
        ? { draft: null, recipe: { kind, text }, diagnostics }
        : {
            draft: null,
            diagnostics: [{ clause: 0, message: "请输入要搜索的正文" }],
          };
    }
    const from = String(doc.firstChild.attrs.from);
    const to = String(doc.firstChild.attrs.to);
    if ((kind === "common" || kind === "path") && from && to)
      return { draft: null, recipe: { kind, from, to }, diagnostics };
    return {
      draft: null,
      diagnostics: [{ clause: 0, message: "请选择两个实体" }],
    };
  }
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
        case "condition_group":
          conditions.push(conditionFromNode(owner, node));
          break;
        case "relation": {
          const [factKind, candidateRole, relatedRole] = String(
            node.attrs.selection ?? "",
          ).split("|");
          const related = String(node.attrs.related ?? "");
          if (!factKind || !candidateRole || !relatedRole)
            throw new TypeError("请选择关联类型");
          if (!related) throw new TypeError("请选择关联实体");
          const rawFactConditions = node.attrs.factConditions;
          if (!Array.isArray(rawFactConditions))
            throw new TypeError("关系属性条件无效");
          const factConditions = rawFactConditions.map((item) =>
            factConditionFromAttrs(
              factKind as QueryFactKind,
              item as EditableFactCondition,
            )
          );
          relations.push({
            factKind: factKind as QueryFactKind,
            candidateRole,
            relatedRole,
            related: related as `${Owner}:${number}`,
            exists: Boolean(node.attrs.exists),
            ...(factConditions.length
              ? {
                  condition: factConditions.length === 1
                    ? factConditions[0]
                    : { kind: "all" as const, terms: factConditions },
                }
              : {}),
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
          const nulls = String(node.attrs.nulls ?? "");
          if (
            !field || (direction !== "asc" && direction !== "desc") ||
            (nulls !== "first" && nulls !== "last")
          )
            throw new TypeError("请完成排序设置");
          orderBy.push({ column: field, direction, nulls });
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

function readableConditionNode(owner: Owner, node: ProseMirrorNode): string {
  if (node.type.name === "condition") {
    const field = String(node.attrs.field ?? "");
    const operator = String(node.attrs.operator ?? "");
    const raw = String(node.attrs.raw ?? "");
    return `${FIELD_LABEL[field] ?? field} ${OPERATOR_LABEL[operator] ?? operator}${raw ? ` ${displayValue(owner, field, raw)}` : ""}`;
  }
  const terms: string[] = [];
  node.forEach((child) => terms.push(readableConditionNode(owner, child)));
  const mode = String(node.attrs.mode);
  const label = mode === "all" ? "全部满足" : mode === "any" ? "任一满足" : "排除";
  return `${label}（${terms.join("、")}）`;
}

export function readableQueryEditorDocument(
  doc: ProseMirrorNode,
  entityLabel: (ref: string) => string = (ref) => ref,
): string {
  if (doc.firstChild?.type.name === "query_bundle") {
    const lines: string[] = [];
    doc.firstChild.forEach((section) => {
      const title = String(section.attrs.answer?.title ?? "查询结果");
      lines.push(`${title}：${section.childCount} 个查询步骤`);
    });
    return lines.join("\n");
  }
  if (doc.firstChild?.type.name === "recipe") {
    const kind = String(doc.firstChild.attrs.kind);
    if (kind === "fullText")
      return `搜索所有正文 包含 ${String(doc.firstChild.attrs.text)}`;
    const from = entityLabel(String(doc.firstChild.attrs.from));
    const to = entityLabel(String(doc.firstChild.attrs.to));
    return kind === "common"
      ? `查找 ${from} 与 ${to} 的共同关联`
      : `查找 ${from} 到 ${to} 的关系路径`;
  }
  const owner = String(doc.firstChild?.attrs.owner ?? "subject") as Owner;
  const lines = [`查找${OWNER_LABEL[owner] ?? "条目"}`];
  for (let index = 1; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (node.type.name === "search") {
      const scope = String(node.attrs.scope ?? "lookup");
      lines.push(`${scope === "lookup" ? "名称" : scope.endsWith("description") ? "分集介绍" : "简介"} 包含 ${String(node.attrs.raw ?? "")}`);
    } else if (node.type.name === "condition" || node.type.name === "condition_group") {
      lines.push(readableConditionNode(owner, node));
    } else if (node.type.name === "relation") {
      const selection = String(node.attrs.selection ?? "");
      const relation = queryRelationOptions(owner).find((item) =>
        item.value === selection
      )?.label ?? "关联";
      const facts = Array.isArray(node.attrs.factConditions)
        ? (node.attrs.factConditions as EditableFactCondition[]).map((condition) =>
            `${FACT_FIELD_LABEL[condition.field] ?? condition.field} ${OPERATOR_LABEL[condition.operator] ?? condition.operator}${condition.raw ? ` ${condition.raw}` : ""}`
          )
        : [];
      lines.push(
        `${Boolean(node.attrs.exists) ? "关联" : "不关联"} ${relation} ${entityLabel(String(node.attrs.related ?? ""))}${facts.length ? `，且${facts.join("、")}` : ""}`,
      );
    } else if (node.type.name === "projection") {
      lines.push(`返回 ${(node.attrs.columns as string[]).map((field) => FIELD_LABEL[field] ?? field).join("、")}`);
    } else if (node.type.name === "sort") {
      const field = String(node.attrs.field ?? "");
      lines.push(`按 ${FIELD_LABEL[field] ?? field} ${node.attrs.direction === "desc" ? "从高到低" : "从低到高"}，空值${node.attrs.nulls === "first" ? "最前" : "最后"}`);
    } else if (node.type.name === "limit") {
      lines.push(`限制 ${String(node.attrs.raw ?? "")} 条`);
    }
  }
  return lines.join("\n");
}
