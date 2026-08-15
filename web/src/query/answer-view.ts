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
import { decodeDisplayText } from "../html";
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
  enumValuesFor,
  factEnumValues,
} from "./workbench-model";
import {
  projectedEntityRef,
  queryRowPrimaryEntityRef,
} from "./result-entities";
import {
  defaultResultColumnSelection,
  normalizeResultColumnSelection,
  resultColumnChoices,
} from "./result-columns";
export { queryResultEntityRefs } from "./result-entities";

export interface AnswerViewOptions {
  onEntity?(ref: string): void;
  onMore?(): void;
  onColumnsChange?(columns: readonly string[]): void;
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
  date: "首发日期",
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

function rowOwner(row: Record<string, RuntimeValue>): Owner | null {
  const ref = row.ref;
  if (typeof ref !== "string") return null;
  const separator = ref.indexOf(":");
  if (separator <= 0) return null;
  const owner = ref.slice(0, separator) as Owner;
  return Object.hasOwn(QUERY_CONTRACT.owners, owner) ? owner : null;
}

function valueSemantic(context: ValueContext): string | undefined {
  if (context.semantic) return context.semantic;
  const owner = rowOwner(context.row);
  return owner && Object.hasOwn(QUERY_CONTRACT.owners[owner].fields, context.column)
    ? `${owner}.${context.column}`
    : undefined;
}

function entityFieldUnavailable(context: ValueContext): boolean {
  const owner = rowOwner(context.row);
  if (!owner) return false;
  const knownEntityField = Object.values(QUERY_CONTRACT.owners).some(({ fields }) =>
    Object.hasOwn(fields, context.column)
  );
  return knownEntityField &&
    !Object.hasOwn(QUERY_CONTRACT.owners[owner].fields, context.column);
}

function mappedEnumValue(
  value: string | number,
  context: ValueContext,
): string | null {
  const semantic = valueSemantic(context);
  if (!semantic) return null;
  const separator = semantic.indexOf(".");
  if (separator <= 0) return null;
  const scope = semantic.slice(0, separator);
  const field = semantic.slice(separator + 1);
  const values = Object.hasOwn(QUERY_CONTRACT.owners, scope)
    ? enumValuesFor(scope as Owner, field, context.mappings)
    : Object.hasOwn(QUERY_CONTRACT.facts, scope)
      ? factEnumValues(scope as QueryFactKind, field, context.mappings)
      : null;
  const mapped = values?.[String(value)];
  return mapped === undefined ? null : decodeDisplayText(mapped);
}

function enumLabel(context: ValueContext): string | null {
  const semantic = valueSemantic(context);
  if (!semantic) return null;
  const separator = semantic.indexOf(".");
  if (separator <= 0) return null;
  const scope = semantic.slice(0, separator);
  const field = semantic.slice(separator + 1);
  if (Object.hasOwn(QUERY_CONTRACT.owners, scope)) {
    const owner = scope as Owner;
    if (!QUERY_CONTRACT.owners[owner].fields[field]?.enum) return null;
    return field === "type"
      ? `${OWNER_LABEL[owner]}类型`
      : FIELD_LABEL[field] ?? field;
  }
  if (!Object.hasOwn(QUERY_CONTRACT.facts, scope)) return null;
  return factFieldDefinition(scope as QueryFactKind, field).enum
    ? FACT_FIELD_LABEL[field] ?? field
    : null;
}

function entityEnumText(value: number, context: ValueContext): string | null {
  const owner = rowOwner(context.row);
  if (context.column === "type" && owner === "subject")
    return MEDIA_NAMES[value] ?? `未知作品类型（${value}）`;
  if (context.column === "type" && owner === "person")
    return PERSON_TYPE_NAMES[value] ?? `未知人物类型（${value}）`;
  if (context.column === "role" && owner === "character")
    return CHARACTER_ROLE_NAMES[value] ?? `未知角色定位（${value}）`;
  return null;
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
  if (value === null && context && entityFieldUnavailable(context))
    return "不适用";
  if (value === null) return "未记录";
  if (value === "" || Array.isArray(value) && !value.length) return "暂无内容";
  if (Array.isArray(value))
    return value.map((item) => queryValueText(item, context)).join("、");
  if (isTagValue(value))
    return `${value.name}（${value.count.toLocaleString("zh-CN")}）`;
  if (entity(value))
    return entityNames(value.fields.name, value.fields.nameCn)?.primary ??
      readableRef(value.ref);
  if (fact(value)) return FACT_LABEL[value.factKind] ?? value.factKind;
  if (path(value)) return `${value.cost} 跳路径`;
  if (typeof value === "boolean") return value ? "是" : "否";
  if ((typeof value === "string" || typeof value === "number") && context) {
    const mapped = mappedEnumValue(value, context);
    if (mapped !== null) return mapped;
  }
  if (
    typeof value === "string" && context?.column === "entityType" &&
    Object.hasOwn(OWNER_LABEL, value)
  ) return OWNER_LABEL[value as Owner];
  if (typeof value === "string") return readableRef(value);
  if (typeof value === "number" && context) {
    const entityValue = entityEnumText(value, context);
    if (entityValue) return entityValue;
    const label = enumLabel(context);
    if (label) return `未知${label}（${value}）`;
  }
  return String(value);
}

function entityNames(
  originalValue: unknown,
  chineseValue: unknown,
): { primary: string; secondary?: string } | null {
  // SiteQueryDataSource owns display_text projection. Names reaching the
  // answer view are already visible query values and must pass through once.
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

interface TableLayout {
  columns: string[];
  displayColumns: string[];
  hasEntityColumn: boolean;
}

interface RenderedTable {
  element: HTMLElement;
  body: HTMLTableSectionElement;
  layout: TableLayout;
}

const ENTITY_RESULT_COLUMN = Symbol("entity-result-column");
const DEFAULT_COLUMN_WIDTH = 112;
const DEFAULT_ENTITY_COLUMN_WIDTH = 224;
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 1_600;
const COLUMN_WIDTH_STEP = 8;

type ResultColumnKey = string | typeof ENTITY_RESULT_COLUMN;

interface ResultColumnHeader {
  key: ResultColumnKey;
  defaultWidth: number;
  cell: HTMLTableCellElement;
  resizer: HTMLSpanElement;
}

function clampColumnWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

function resultColumnHeader(
  key: ResultColumnKey,
  label: string,
  widths: Map<ResultColumnKey, number>,
  onResize: (key: ResultColumnKey, width: number) => void,
): ResultColumnHeader {
  const cell = document.createElement("th");
  cell.scope = "col";
  cell.textContent = label;
  const defaultWidth = key === ENTITY_RESULT_COLUMN
    ? DEFAULT_ENTITY_COLUMN_WIDTH
    : DEFAULT_COLUMN_WIDTH;
  const savedWidth = widths.get(key);
  if (savedWidth !== undefined) cell.style.width = `${savedWidth}px`;

  const resizer = document.createElement("span");
  resizer.className = "query-column-resizer";
  resizer.tabIndex = 0;
  resizer.title = "拖动调整列宽";
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-label", `${label}列宽`);
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.setAttribute("aria-valuemin", String(MIN_COLUMN_WIDTH));
  resizer.setAttribute("aria-valuemax", String(MAX_COLUMN_WIDTH));
  resizer.setAttribute("aria-valuenow", String(savedWidth ?? defaultWidth));

  const currentWidth = (): number => {
    const renderedWidth = cell.getBoundingClientRect().width;
    return widths.get(key) ?? (renderedWidth > 0 ? renderedWidth : defaultWidth);
  };
  const setWidth = (width: number): void => {
    onResize(key, clampColumnWidth(width));
  };

  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    resizer.focus({ preventScroll: true });
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: currentWidth(),
    };
    resizer.setPointerCapture(event.pointerId);
  });
  resizer.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setWidth(drag.startWidth + event.clientX - drag.startX);
  });
  const stopDragging = (event: PointerEvent): void => {
    if (event.pointerId === drag?.pointerId) drag = null;
  };
  resizer.addEventListener("pointerup", stopDragging);
  resizer.addEventListener("pointercancel", stopDragging);
  resizer.addEventListener("lostpointercapture", stopDragging);
  resizer.addEventListener("keydown", (event) => {
    const direction = event.key === "ArrowLeft"
      ? -1
      : event.key === "ArrowRight"
      ? 1
      : 0;
    if (!direction) return;
    event.preventDefault();
    setWidth(
      currentWidth() + direction * COLUMN_WIDTH_STEP * (event.shiftKey ? 4 : 1),
    );
  });
  resizer.addEventListener("focus", () => {
    resizer.setAttribute("aria-valuenow", String(clampColumnWidth(currentWidth())));
  });
  cell.append(resizer);
  return { key, defaultWidth, cell, resizer };
}

function tableLayout(
  result: QueryResult,
  selectedColumns?: readonly string[],
): TableLayout {
  const columns = [...new Set([
    ...Object.keys(result.columns),
    ...result.rows.flatMap((row) => Object.keys(row)),
  ])];
  const hasEntityColumn = result.rows.some((row, index) =>
    queryRowPrimaryEntityRef(row, result.evidence[index]) !== null
  );
  return {
    columns,
    hasEntityColumn,
    displayColumns: selectedColumns ? [...selectedColumns] : (hasEntityColumn
      ? columns.filter((column) =>
        column !== "ref" && column !== "name" && column !== "nameCn"
      )
      : columns),
  };
}

function appendTableRows(
  body: HTMLTableSectionElement,
  result: QueryResult,
  options: AnswerViewOptions,
  layout: TableLayout,
  start: number,
): void {
  for (let rowIndex = start; rowIndex < result.rows.length; rowIndex++) {
    const row = result.rows[rowIndex];
    if (!row) continue;
    const tr = body.insertRow();
    if (layout.hasEntityColumn) {
      const cell = tr.insertCell();
      const ref = queryRowPrimaryEntityRef(row, result.evidence[rowIndex]);
      const names = entityNames(row.name, row.nameCn);
      const value = ref ?? null;
      cell.append(valueNode(
        value,
        options,
        names?.primary ?? (ref ? readableRef(ref) : "未提供"),
        names?.secondary,
      ));
    }
    for (const column of layout.displayColumns) {
      const cell = tr.insertCell();
      const value = row[column];
      const rendered = value === undefined ? null : value;
      const semantic = result.columns[column]?.semantic;
      const label = queryValueText(rendered, {
        column,
        row,
        semantic,
        mappings: options.mappings,
      });
      cell.append(valueNode(rendered, options, label));
    }
    const snippet = queryRowMatchSnippet(row, result.evidence[rowIndex]);
    if (snippet) {
      const matchRow = body.insertRow();
      matchRow.className = "query-match-row";
      const cell = matchRow.insertCell();
      cell.colSpan = Math.max(
        1,
        layout.displayColumns.length + Number(layout.hasEntityColumn),
      );
      cell.textContent = snippet;
    }
  }
}

function renderTable(
  result: QueryResult,
  options: AnswerViewOptions,
  widths: Map<ResultColumnKey, number>,
  selectedColumns?: readonly string[],
): RenderedTable {
  const wrapper = document.createElement("div");
  wrapper.className = "query-table-wrap";
  const table = document.createElement("table");
  const layout = tableLayout(result, selectedColumns);
  table.className = layout.hasEntityColumn
    ? "query-table query-entity-table"
    : "query-table";
  const head = table.createTHead().insertRow();
  const headers: ResultColumnHeader[] = [];
  const applyWidth = (header: ResultColumnHeader, width: number): void => {
    widths.set(header.key, width);
    header.cell.style.width = `${width}px`;
    header.resizer.setAttribute("aria-valuenow", String(width));
  };
  const fitTableToColumns = (): void => {
    table.style.minWidth = "0";
    table.style.width = `${headers.reduce((total, header) =>
      total + (widths.get(header.key) ?? header.defaultWidth), 0)}px`;
  };
  const resizeColumn = (key: ResultColumnKey, width: number): void => {
    if (!table.style.width) {
      const renderedWidths = headers.map((header) => {
        const rendered = header.cell.getBoundingClientRect().width;
        return clampColumnWidth(rendered > 0 ? rendered : header.defaultWidth);
      });
      headers.forEach((header, index) => {
        applyWidth(
          header,
          renderedWidths[index] ?? header.defaultWidth,
        );
      });
    }
    const header = headers.find((candidate) => candidate.key === key);
    if (!header) return;
    applyWidth(header, width);
    fitTableToColumns();
  };
  const appendHeader = (key: ResultColumnKey, label: string): void => {
    const header = resultColumnHeader(key, label, widths, resizeColumn);
    headers.push(header);
    head.append(header.cell);
  };
  if (layout.hasEntityColumn) appendHeader(ENTITY_RESULT_COLUMN, "条目");
  for (const column of layout.displayColumns)
    appendHeader(column, columnLabel(column));
  if (widths.size) {
    for (const header of headers)
      applyWidth(header, widths.get(header.key) ?? header.defaultWidth);
    fitTableToColumns();
  }
  const body = table.createTBody();
  appendTableRows(body, result, options, layout, 0);
  wrapper.append(table);
  return { element: wrapper, body, layout };
}

function appendPaths(
  list: HTMLOListElement,
  result: QueryResult,
  options: AnswerViewOptions,
  start: number,
): void {
  for (const row of result.rows.slice(start)) {
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
}

function renderPaths(
  result: QueryResult,
  options: AnswerViewOptions,
): HTMLOListElement {
  const list = document.createElement("ol");
  list.className = "query-path-list";
  appendPaths(list, result, options, 0);
  return list;
}

export interface AnswerView {
  update(result: QueryResult, selectedColumns?: readonly string[]): void;
}

interface ColumnSelector {
  element: HTMLDetailsElement;
  sync(columns: readonly string[]): void;
}

function sameOwnerScope(left: readonly Owner[], right: readonly Owner[]): boolean {
  return left.length === right.length &&
    left.every((owner, index) => owner === right[index]);
}

function renderColumnSelector(
  scope: readonly Owner[],
  onChange: (columns: readonly string[]) => void,
): ColumnSelector {
  const details = document.createElement("details");
  details.className = "query-result-columns";
  const summary = document.createElement("summary");
  summary.textContent = "显示列";
  const panel = document.createElement("div");
  panel.className = "query-result-columns-panel";
  const grid = document.createElement("div");
  grid.className = "query-result-columns-grid";
  const choices = resultColumnChoices(scope);
  const controls = choices.map(({ field, owners }) => {
    const label = document.createElement("label");
    label.className = "query-result-column";
    const control = document.createElement("input");
    control.type = "checkbox";
    const baseLabel = FIELD_LABEL[field] ?? field;
    control.setAttribute("aria-label", baseLabel);
    const text = document.createElement("span");
    text.textContent = sameOwnerScope(owners, scope)
      ? baseLabel
      : `${baseLabel}（仅${owners.map((owner) => OWNER_LABEL[owner]).join("、")}）`;
    label.append(control, text);
    grid.append(label);
    return { field, control };
  });
  const actions = document.createElement("div");
  actions.className = "query-result-columns-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "恢复默认";
  reset.addEventListener("click", () => {
    const defaults = new Set(defaultResultColumnSelection(scope));
    for (const { field, control } of controls)
      control.checked = defaults.has(field);
  });
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "应用";
  apply.addEventListener("click", () => {
    onChange(controls.flatMap(({ field, control }) =>
      control.checked ? [field] : []
    ));
    details.open = false;
  });
  actions.append(reset, apply);
  panel.append(grid, actions);
  details.append(summary, panel);
  return {
    element: details,
    sync: (columns) => {
      const selected = new Set(columns);
      for (const { field, control } of controls)
        control.checked = selected.has(field);
    },
  };
}

type RenderedAnswerContent =
  | { kind: "empty"; element: HTMLElement }
  | { kind: "path"; element: HTMLOListElement }
  | { kind: "table"; table: RenderedTable };

// Buffered pagination retains row and evidence identities. If a caller replaces
// any visible item, rebuilding is safer than attempting to patch unknown edits.
function sameResultPrefix(previous: QueryResult, result: QueryResult): boolean {
  if (
    previous.queryDigest !== result.queryDigest ||
    previous.releaseId !== result.releaseId ||
    previous.coverage.digest !== result.coverage.digest ||
    previous.totalMatches !== result.totalMatches ||
    previous.visibleMatches !== result.visibleMatches ||
    previous.rows.length > result.rows.length ||
    previous.columns !== result.columns &&
      JSON.stringify(previous.columns) !== JSON.stringify(result.columns)
  ) return false;
  for (let index = 0; index < previous.rows.length; index++)
    if (
      previous.rows[index] !== result.rows[index] ||
      previous.evidence[index] !== result.evidence[index]
    ) return false;
  return true;
}

function tableCanAppend(
  rendered: RenderedTable,
  result: QueryResult,
  start: number,
): boolean {
  const columns = new Set(rendered.layout.columns);
  for (let index = start; index < result.rows.length; index++) {
    const row = result.rows[index];
    if (!row || Object.keys(row).some((column) => !columns.has(column))) return false;
    if (
      !rendered.layout.hasEntityColumn &&
      queryRowPrimaryEntityRef(row, result.evidence[index]) !== null
    ) return false;
  }
  return true;
}

export function renderAnswer(
  container: HTMLElement,
  answer: AnswerSpec,
  result: QueryResult,
  options: AnswerViewOptions = {},
): AnswerView {
  const heading = document.createElement("h2");
  heading.textContent = answer.title;
  const count = document.createElement("p");
  count.className = "query-result-count";
  const moreHost = document.createElement("div");
  moreHost.className = "query-more-host";
  const onMore = options.onMore;
  const more = onMore
    ? document.createElement("button")
    : null;
  if (more && onMore) {
    more.type = "button";
    more.className = "secondary-action query-more";
    more.addEventListener("click", onMore);
  }
  let moreVisible = false;
  let previous: QueryResult | null = null;
  let content: RenderedAnswerContent | null = null;
  const columnWidths = new Map<ResultColumnKey, number>();
  const scope = answer.entityScope;
  let visibleColumns = scope
    ? normalizeResultColumnSelection(scope, Object.keys(result.columns))
    : undefined;
  let previousColumns = visibleColumns?.join("\u0000") ?? "";
  const selector = scope && options.onColumnsChange
    ? renderColumnSelector(scope, options.onColumnsChange)
    : null;
  selector?.sync(visibleColumns ?? []);

  const updateCount = (next: QueryResult): void => {
    count.textContent = next.totalMatches === next.visibleMatches
      ? `${next.totalMatches.toLocaleString()} 条结果`
      : `${next.totalMatches.toLocaleString()} 条匹配，问题限制显示 ${next.visibleMatches.toLocaleString()} 条`;
  };
  const updateMore = (next: QueryResult): void => {
    const visible = Boolean(more && next.hasMore);
    if (more && visible) {
      more.textContent = `继续显示（已显示 ${next.rows.length} / ${next.visibleMatches}）`;
      if (!moreVisible) moreHost.append(more);
    } else if (moreVisible) moreHost.replaceChildren();
    moreVisible = visible;
  };
  const rebuild = (next: QueryResult): void => {
    if (!next.rows.length) {
      const empty = document.createElement("p");
      empty.className = "query-empty";
      empty.textContent = "没有找到符合条件的结果。";
      content = { kind: "empty", element: empty };
    } else if (answer.shape === "path-list") {
      const element = renderPaths(next, options);
      content = { kind: "path", element };
    } else {
      const table = renderTable(next, options, columnWidths, visibleColumns);
      content = { kind: "table", table };
    }
    const element = content.kind === "table"
      ? content.table.element
      : content.element;
    container.replaceChildren(
      heading,
      count,
      ...(selector ? [selector.element] : []),
      element,
      moreHost,
    );
  };
  const view: AnswerView = {
    update: (next, selectedColumns) => {
      if (scope && selectedColumns)
        visibleColumns = normalizeResultColumnSelection(scope, selectedColumns);
      const columnKey = visibleColumns?.join("\u0000") ?? "";
      const columnsChanged = columnKey !== previousColumns;
      selector?.sync(visibleColumns ?? []);
      updateCount(next);
      const prior = previous;
      const rendered = content;
      const append = prior !== null && rendered !== null &&
        !columnsChanged && sameResultPrefix(prior, next);
      let reused = false;
      if (
        append &&
        rendered.kind === "table" &&
        tableCanAppend(rendered.table, next, prior.rows.length)
      ) {
        appendTableRows(
          rendered.table.body,
          next,
          options,
          rendered.table.layout,
          prior.rows.length,
        );
        reused = true;
      } else if (append && rendered.kind === "path") {
        appendPaths(rendered.element, next, options, prior.rows.length);
        reused = true;
      } else if (append && rendered.kind === "empty" && !next.rows.length)
        reused = true;
      if (!reused) rebuild(next);
      updateMore(next);
      previous = next;
      previousColumns = columnKey;
    },
  };
  view.update(result);
  return view;
}
