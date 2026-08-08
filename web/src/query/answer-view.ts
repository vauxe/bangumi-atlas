import type {
  EntityValue,
  Evidence,
  FactValue,
  PathValue,
  QueryResult,
  RuntimeValue,
} from "./engine";
import type { AnswerSpec } from "./bundle";
import { isMissing } from "./value";
import { MEDIA_NAMES } from "../types";
import type { Mappings } from "../types";
import {
  QUERY_CONTRACT,
  factFieldDefinition,
  type Owner,
  type QueryFactKind,
} from "./contract";

export interface AnswerViewOptions {
  onEntity?(ref: string): void;
  onMore?(): void;
  mappings?: Mappings;
}

const OWNER_NAMES = {
  subject: "作品",
  person: "人物",
  character: "角色",
  episode: "分集",
} as const;

const FACT_NAMES: Record<QueryFactKind, string> = {
  RELATES_TO: "作品关系",
  WORKED_ON: "人物参与",
  APPEARS_IN: "角色登场",
  VOICE_CREDIT: "配音",
  PERSON_REL: "人物关系",
  CHARACTER_REL: "角色关系",
};

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
};

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
  if (entity(value))
    return String(value.fields.nameCn || value.fields.name || value.ref);
  if (fact(value)) return FACT_NAMES[value.factKind];
  if (path(value)) return `${value.cost} 跳路径`;
  if (typeof value === "boolean") return value ? "是" : "否";
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

function valueNode(
  value: RuntimeValue,
  options: AnswerViewOptions,
  label?: string,
): HTMLElement {
  const ref = entity(value) && value.owner !== "episode"
    ? value.ref
    : typeof value === "string" && /^(?:subject|person|character):(?:0|[1-9][0-9]*)$/.test(value)
      ? value
      : null;
  if (ref) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "query-entity-link";
    button.textContent = label || queryValueText(value);
    button.title = ref;
    button.addEventListener("click", () => options.onEntity?.(ref));
    return button;
  }
  const span = document.createElement("span");
  span.textContent = label || queryValueText(value);
  if (isMissing(value)) span.className = "query-missing";
  else if (value === null) span.className = "query-null";
  return span;
}

function renderTable(
  result: QueryResult,
  options: AnswerViewOptions,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "query-table-wrap";
  const table = document.createElement("table");
  table.className = "query-table";
  const columns = [...new Set(result.rows.flatMap((row) => Object.keys(row)))];
  const displayColumns = columns.includes("ref")
    ? columns.filter((column) => column !== "name" && column !== "nameCn")
    : columns;
  const head = table.createTHead().insertRow();
  for (const column of displayColumns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = COLUMN_LABEL[column] ?? column;
    head.append(cell);
  }
  const body = table.createTBody();
  result.rows.forEach((row, rowIndex) => {
    const tr = body.insertRow();
    for (const column of displayColumns) {
      const cell = tr.insertCell();
      const value = row[column];
      const displayName = column === "ref"
        ? (typeof row.nameCn === "string" && row.nameCn) ||
          (typeof row.name === "string" ? row.name : "")
        : undefined;
      const rendered = value === undefined ? null : value;
      const semantic = result.columns[column]?.semantic;
      cell.append(valueNode(
        rendered,
        options,
        displayName || queryValueText(rendered, {
          column,
          row,
          semantic,
          mappings: options.mappings,
        }),
      ));
    }
    const snippet = Object.values(result.evidence[rowIndex] ?? {})
      .flat()
      .find((item): item is Extract<Evidence, { kind: "text-range" }> =>
        item.kind === "text-range" && Boolean(item.snippet)
      )?.snippet;
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
        relation.textContent = ` — ${FACT_NAMES[step.fact.factKind]} (${from ? OWNER_NAMES[from] : step.fromRole} → ${to ? OWNER_NAMES[to] : step.toRole}) → `;
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
  const heading = document.createElement("h3");
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
