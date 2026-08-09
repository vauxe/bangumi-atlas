import type {
  EntityValue,
  Evidence,
  FactValue,
  PathValue,
  QueryResult,
  RowEvidence,
  RuntimeValue,
} from "./engine";
import type { AnswerSpec } from "./bundle";
import { isMissing, isTagValue } from "./value";
import { MEDIA_NAMES } from "../types";
import type { Mappings } from "../types";
import {
  QUERY_CONTRACT,
  factFieldDefinition,
  type Owner,
  type QueryFactKind,
} from "./contract";
import {
  AGGREGATE_FUNCTION_LABEL,
  FACT_FIELD_LABEL,
  FACT_LABEL,
  FIELD_LABEL,
  OWNER_LABEL,
  factEnumValues,
} from "./workbench-model";

export interface AnswerViewOptions {
  onEntity?(ref: string): void;
  onMore?(): void;
  onSort?(semantic: string, direction: "asc" | "desc"): void;
  onGroup?(semantic: string): void;
  onFilter?(semantic: string, value: RuntimeValue, exclude: boolean): void;
  canSort?(semantic: string): boolean;
  canGroup?(semantic: string): boolean;
  canFilter?(semantic: string): boolean;
  mappings?: Mappings;
}

const COLUMN_LABEL: Record<string, string> = {
  ref: "条目",
  entity: "条目",
  fact: "关系事实",
  name: "原名",
  nameCn: "中文名",
  type: "类型",
  platform: "平台",
  date: "日期",
  year: "年份",
  score: "评分",
  rank: "Bangumi 排名",
  role: "角色定位",
  airdate: "播出日期",
  duration: "时长",
  person: "人物",
  character: "角色",
  subject: "作品",
  subjectContext: "作品",
  neighbor: "关联条目",
  entityType: "实体类型",
  count: "条数",
};

function columnLabel(column: string): string {
  const exact = COLUMN_LABEL[column] ?? FIELD_LABEL[column];
  if (exact) return exact;
  const separator = column.indexOf("_");
  if (separator > 0) {
    const operation = column.slice(0, separator);
    const field = column.slice(separator + 1);
    const prefix = AGGREGATE_FUNCTION_LABEL[
      operation as keyof typeof AGGREGATE_FUNCTION_LABEL
    ];
    if (prefix) return `${prefix}${COLUMN_LABEL[field] ?? FIELD_LABEL[field] ?? field}`;
  }
  return column;
}

const PERSON_TYPE_NAMES: Record<number, string> = {
  1: "个人",
  2: "公司",
  3: "组合",
};

const CHARACTER_ROLE_NAMES: Record<number, string> = {
  1: "角色",
  2: "机体",
  3: "舰船",
  4: "组织",
};

interface ValueContext {
  column: string;
  row: Record<string, RuntimeValue>;
  semantic?: string;
  mappings?: Mappings;
}

function mappedNumber(value: number, context: ValueContext): string | null {
  const { mappings, semantic } = context;
  if (!mappings || !semantic) return null;
  const separator = semantic.indexOf(".");
  if (separator <= 0) return null;
  const scope = semantic.slice(0, separator);
  const field = semantic.slice(separator + 1);
  let namespace: string | undefined;
  if (Object.hasOwn(QUERY_CONTRACT.owners, scope))
    namespace = QUERY_CONTRACT.owners[scope as Owner].fields[field]?.enum;
  else if (Object.hasOwn(QUERY_CONTRACT.facts, scope))
    namespace = factFieldDefinition(scope as QueryFactKind, field).enum;
  if (!namespace) return null;
  const code = String(value);
  const mapped = namespace.startsWith("fact_labels.")
    ? mappings.fact_labels[namespace.slice("fact_labels.".length)]?.[code]
    : mappings[namespace as Exclude<keyof Mappings, "fact_labels" | "platform">]?.[code];
  return mapped ?? `未知枚举值（${code}）`;
}

function entity(value: RuntimeValue): value is EntityValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "kind" in value && value.kind === "entity";
}

function fact(value: RuntimeValue): value is FactValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "kind" in value && value.kind === "fact";
}

function path(value: RuntimeValue): value is PathValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "kind" in value && value.kind === "path";
}

const ENTITY_REF = /^(subject|person|character|episode):(0|[1-9][0-9]*)$/;

function readableRef(ref: string): string {
  const entityRef = ENTITY_REF.exec(ref);
  if (entityRef)
    return `${OWNER_LABEL[entityRef[1] as Owner]} #${entityRef[2]}`;
  const factRef = /^fact:(0|[1-9][0-9]*)$/.exec(ref);
  return factRef ? `关系事实 #${factRef[1]}` : ref;
}

function collectEntityRefs(value: RuntimeValue, refs: Set<string>): void {
  if (typeof value === "string" && ENTITY_REF.test(value)) {
    refs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEntityRefs(item, refs);
    return;
  }
  if (entity(value)) {
    refs.add(value.ref);
    return;
  }
  if (fact(value)) {
    for (const ref of Object.values(value.roles)) refs.add(ref);
    return;
  }
  if (path(value))
    for (const node of value.nodes) refs.add(node.ref);
}

function projectedEntityRef(
  row: Record<string, RuntimeValue>,
  evidence: RowEvidence | undefined,
): string | null {
  const refs = new Set<string>();
  for (const [column, items] of Object.entries(evidence ?? {})) {
    if (!Object.hasOwn(row, column)) continue;
    for (const item of items)
      if (item.kind === "entity-field") refs.add(item.ref);
  }
  return refs.size === 1 ? [...refs][0] as string : null;
}

function rowEntityRef(
  row: Record<string, RuntimeValue>,
  evidence: RowEvidence | undefined,
): string | null {
  if (typeof row.ref === "string" && ENTITY_REF.test(row.ref)) return row.ref;
  const visible = new Set<string>();
  for (const value of Object.values(row)) collectEntityRefs(value, visible);
  return visible.size ? null : projectedEntityRef(row, evidence);
}

/** Entity identities present in the currently rendered answer rows. */
export function queryResultEntityRefs(
  result: Pick<QueryResult, "rows"> & Partial<Pick<QueryResult, "evidence">>,
): string[] {
  const refs = new Set<string>();
  result.rows.forEach((row, index) => {
    const visible = new Set<string>();
    for (const value of Object.values(row)) collectEntityRefs(value, visible);
    if (visible.size)
      for (const ref of visible) refs.add(ref);
    else {
      const inferred = projectedEntityRef(row, result.evidence?.[index]);
      if (inferred) refs.add(inferred);
    }
  });
  return [...refs];
}

function isFullTextMatch(
  item: Evidence,
): item is Extract<Evidence, { kind: "text-range" }> {
  if (item.kind !== "text-range" || !item.snippet) return false;
  if (item.ref.startsWith("fact:")) {
    return Object.values(QUERY_CONTRACT.facts).some((fact) =>
      fact.fields[item.field]?.capabilities.includes("fullText")
    );
  }
  const owner = item.ref.slice(0, item.ref.indexOf(":")) as Owner;
  return Boolean(
    QUERY_CONTRACT.owners[owner]?.fields[item.field]?.capabilities.includes("fullText"),
  );
}

export function queryMatchSnippet(evidence: RowEvidence | undefined): string | undefined {
  return Object.values(evidence ?? {}).flat().find(isFullTextMatch)?.snippet;
}

export function queryRowMatchSnippet(
  row: Record<string, RuntimeValue>,
  evidence: RowEvidence | undefined,
): string | undefined {
  const identified = typeof row.ref === "string" || Object.values(row).some(entity) ||
    projectedEntityRef(row, evidence) !== null;
  return identified ? queryMatchSnippet(evidence) : undefined;
}

export function queryValueText(
  value: RuntimeValue,
  context?: ValueContext,
): string {
  if (isMissing(value)) return "未提供";
  if (value === null) return "空值";
  if (value === "") return "空字符串";
  if (Array.isArray(value) && !value.length) return "空列表";
  if (Array.isArray(value))
    return value.map((item) => queryValueText(item)).join("、");
  if (isTagValue(value))
    return `${value.name}（${value.count.toLocaleString("zh-CN")}）`;
  if (entity(value))
    return entityNames(value.fields.name, value.fields.nameCn)?.primary ??
      readableRef(value.ref);
  if (fact(value)) return FACT_LABEL[value.factKind] ?? value.factKind;
  if (path(value)) return `${value.cost} 跳路径`;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (
    typeof value === "string" && context?.column === "entityType" &&
    Object.hasOwn(OWNER_LABEL, value)
  ) return OWNER_LABEL[value as Owner];
  if (typeof value === "string") return readableRef(value);
  if (typeof value === "number" && context) {
    const mapped = mappedNumber(value, context);
    if (mapped) return mapped;
    const ref = context.row.ref;
    if (context.column === "type" && typeof ref === "string") {
      if (ref.startsWith("subject:")) return MEDIA_NAMES[value] ?? String(value);
      if (ref.startsWith("person:")) return PERSON_TYPE_NAMES[value] ?? String(value);
    }
    if (
      context.column === "role" &&
      typeof ref === "string" &&
      ref.startsWith("character:")
    ) return CHARACTER_ROLE_NAMES[value] ?? String(value);
  }
  return String(value);
}

function entityNames(
  originalValue: unknown,
  chineseValue: unknown,
): { primary: string; secondary?: string } | null {
  const original = typeof originalValue === "string" ? originalValue.trim() : "";
  const chinese = typeof chineseValue === "string" ? chineseValue.trim() : "";
  const primary = chinese || original;
  if (!primary) return null;
  return {
    primary,
    ...(chinese && original && chinese !== original
      ? { secondary: original }
      : {}),
  };
}

function valueNode(
  value: RuntimeValue,
  options: AnswerViewOptions,
  label?: string,
  secondaryLabel?: string,
): HTMLElement {
  const ref = entity(value)
    ? value.ref
    : typeof value === "string" && /^(?:subject|person|character|episode):(?:0|[1-9][0-9]*)$/.test(value)
      ? value
      : null;
  if (ref) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "query-entity-link";
    const names = entity(value)
      ? entityNames(value.fields.name, value.fields.nameCn)
      : null;
    const primary = label || names?.primary || readableRef(ref);
    const secondary = secondaryLabel ?? names?.secondary;
    if (secondary && secondary !== primary) {
      button.className += " query-entity-names";
      button.setAttribute("aria-label", `${primary}，原名：${secondary}`);
      const primaryName = document.createElement("span");
      primaryName.className = "query-entity-name-primary";
      primaryName.textContent = primary;
      const originalName = document.createElement("span");
      originalName.className = "query-entity-name-original";
      originalName.textContent = secondary;
      button.append(primaryName, originalName);
    } else button.textContent = primary;
    button.addEventListener("click", () => options.onEntity?.(ref));
    return button;
  }
  const span = document.createElement("span");
  span.textContent = label || queryValueText(value);
  if (isMissing(value)) span.className = "query-missing";
  else if (value === null) span.className = "query-null";
  return span;
}

function resultValueNode(
  value: RuntimeValue,
  options: AnswerViewOptions,
  semantic: string | undefined,
  label: string,
  secondaryLabel?: string,
): HTMLElement {
  const rendered = valueNode(value, options, label, secondaryLabel);
  const filterable = semantic && options.onFilter &&
    (options.canFilter?.(semantic) ?? true) && value !== "" && (
    isMissing(value) || value === null ||
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  );
  if (!filterable) return rendered;
  const details = document.createElement("details");
  details.className = "query-result-action";
  const summary = document.createElement("summary");
  summary.setAttribute("aria-label", `${label}：筛选操作`);
  summary.append(rendered);
  const menu = document.createElement("div");
  for (const [text, exclude] of [["只看此值", false], ["排除此值", true]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", () => {
      details.open = false;
      options.onFilter?.(semantic, value, exclude);
    });
    menu.append(button);
  }
  details.append(summary, menu);
  return details;
}

function columnHeading(
  column: string,
  semantic: string | undefined,
  options: AnswerViewOptions,
): HTMLElement {
  const label = columnLabel(column);
  const sortable = Boolean(
    semantic && options.onSort && (options.canSort?.(semantic) ?? true),
  );
  const groupable = Boolean(
    semantic && options.onGroup && (options.canGroup?.(semantic) ?? true),
  );
  if (!semantic || (!sortable && !groupable)) {
    const text = document.createElement("span");
    text.textContent = label;
    return text;
  }
  const details = document.createElement("details");
  details.className = "query-column-action";
  const summary = document.createElement("summary");
  summary.textContent = label;
  summary.setAttribute("aria-label", `${label}：列操作`);
  const menu = document.createElement("div");
  for (const [text, direction] of [["从低到高", "asc"], ["从高到低", "desc"]] as const) {
    if (!sortable) break;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", () => {
      details.open = false;
      options.onSort?.(semantic, direction);
    });
    menu.append(button);
  }
  if (groupable) {
    const group = document.createElement("button");
    group.type = "button";
    group.textContent = "按此分组";
    group.addEventListener("click", () => {
      details.open = false;
      options.onGroup?.(semantic);
    });
    menu.append(group);
  }
  details.append(summary, menu);
  return details;
}

function renderTable(
  result: QueryResult,
  options: AnswerViewOptions,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "query-table-wrap";
  const table = document.createElement("table");
  const columns = [...new Set(result.rows.flatMap((row) => Object.keys(row)))];
  const rowRefs = result.rows.map((row, index) =>
    rowEntityRef(row, result.evidence[index])
  );
  const hasEntityColumn = rowRefs.some((ref) => ref !== null);
  table.className = hasEntityColumn ? "query-table query-entity-table" : "query-table";
  const displayColumns = hasEntityColumn
    ? columns.filter((column) =>
      column !== "ref" && column !== "name" && column !== "nameCn"
    )
    : columns;
  const head = table.createTHead().insertRow();
  if (hasEntityColumn) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = "条目";
    head.append(cell);
  }
  for (const column of displayColumns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.append(columnHeading(column, result.columns[column]?.semantic, options));
    head.append(cell);
  }
  const body = table.createTBody();
  result.rows.forEach((row, rowIndex) => {
    const tr = body.insertRow();
    if (hasEntityColumn) {
      const cell = tr.insertCell();
      cell.setAttribute("data-label", "条目");
      const ref = rowRefs[rowIndex];
      const names = entityNames(row.name, row.nameCn);
      const value = ref ?? null;
      cell.append(valueNode(
        value,
        options,
        names?.primary ?? (ref ? readableRef(ref) : "未提供"),
        names?.secondary,
      ));
    }
    for (const column of displayColumns) {
      const cell = tr.insertCell();
      cell.setAttribute("data-label", columnLabel(column));
      const value = row[column];
      const rendered = value === undefined ? null : value;
      const semantic = result.columns[column]?.semantic;
      const label = queryValueText(rendered, {
        column,
        row,
        semantic,
        mappings: options.mappings,
      });
      cell.append(resultValueNode(
        rendered,
        options,
        semantic,
        label,
      ));
    }
    const snippet = queryRowMatchSnippet(row, result.evidence[rowIndex]);
    if (snippet) {
      const matchRow = body.insertRow();
      matchRow.className = "query-match-row";
      const cell = matchRow.insertCell();
      cell.colSpan = Math.max(1, displayColumns.length);
      cell.textContent = snippet;
    }
  });
  wrapper.append(table);
  return wrapper;
}

function renderPaths(
  result: QueryResult,
  options: AnswerViewOptions,
): HTMLElement {
  const list = document.createElement("ol");
  list.className = "query-path-list";
  for (const row of result.rows) {
    const value = Object.values(row).find(path);
    if (!value) continue;
    const item = document.createElement("li");
    const chain = document.createElement("div");
    chain.className = "query-path-chain";
    value.nodes.forEach((node, index) => {
      chain.append(valueNode(node, options));
      const step = value.steps[index];
      if (step) {
        const relation = document.createElement("span");
        relation.className = "query-path-step";
        const roles = QUERY_CONTRACT.facts[step.fact.factKind].roles;
        const from = roles[step.fromRole];
        const to = roles[step.toRole];
        const details = Object.entries(step.fact.fields).flatMap(([field, value]) => {
          const definition = factFieldDefinition(step.fact.factKind, field);
          if (
            definition.exposure !== "query" ||
            !definition.capabilities.includes("project") ||
            isMissing(value) || value === null || value === ""
          ) return [];
          const label = factEnumValues(
            step.fact.factKind,
            field,
            options.mappings,
          )?.[String(value)] ?? queryValueText(value, {
            column: field,
            row: {},
            semantic: `${step.fact.factKind}.${field}`,
            mappings: options.mappings,
          });
          return [`${FACT_FIELD_LABEL[field] ?? field}：${label}`];
        });
        relation.textContent = ` — ${FACT_LABEL[step.fact.factKind] ?? step.fact.factKind}${details.length ? ` · ${details.join(" · ")}` : ""} (${from ? OWNER_LABEL[from] : step.fromRole} → ${to ? OWNER_LABEL[to] : step.toRole}) → `;
        relation.title = step.fact.ref;
        chain.append(relation);
      }
    });
    item.append(chain);
    list.append(item);
  }
  return list;
}

export function renderAnswer(
  container: HTMLElement,
  answer: AnswerSpec,
  result: QueryResult,
  options: AnswerViewOptions = {},
): void {
  container.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = answer.title;
  const count = document.createElement("p");
  count.className = "query-result-count";
  count.textContent = result.totalMatches === result.visibleMatches
    ? `${result.totalMatches.toLocaleString()} 条完整结果`
    : `${result.totalMatches.toLocaleString()} 条匹配，问题限制显示 ${result.visibleMatches.toLocaleString()} 条`;
  container.append(heading, count);
  if (!result.rows.length) {
    const empty = document.createElement("p");
    empty.className = "query-empty";
    empty.textContent = "没有找到符合条件的结果。";
    container.append(empty);
  } else if (answer.shape === "path-list")
    container.append(renderPaths(result, options));
  else container.append(renderTable(result, options));
  if (result.hasMore && options.onMore) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "secondary-action query-more";
    more.textContent = `继续显示（已显示 ${result.rows.length} / ${result.visibleMatches}）`;
    more.addEventListener("click", options.onMore);
    container.append(more);
  }
}
