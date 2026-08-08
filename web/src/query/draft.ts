import { canonicalJson } from "./canonical";
import {
  normalizeBundle,
  type QueryBundle,
  type QuerySection,
} from "./bundle";
import { QUERY_CONTRACT, type Owner } from "./contract";
import type {
  ParameterType,
  ParameterValues,
  QueryDocument,
  QueryOperator,
  SetBranch,
} from "./document";
import {
  compileExplorerQuery,
  decompileExplorerQuery,
  type ExplorerAggregate,
  type ExplorerCondition,
  type ExplorerQuery,
  type ExplorerRelation,
} from "./explorer";
import {
  comparisonRecipe,
  decompileQueryRecipe,
  fullTextRecipe,
  pathRecipe,
} from "./recipes";
import { FIELD_LABEL } from "./workbench-model";
import { OWNER_LABEL } from "./vocabulary";

export type EntityRef = `${Owner}:${number}`;

export const ENTITY_SCOPE_ORDER = [
  "subject",
  "person",
  "character",
  "episode",
] as const satisfies readonly Owner[];

export type EntityScope = readonly [Owner, ...Owner[]];

export const DEFAULT_ENTITY_SCOPE: EntityScope = Object.freeze([
  "subject",
  "person",
  "character",
]);

export function normalizeEntityScope(owners: Iterable<Owner>): EntityScope {
  const selected = new Set(owners);
  for (const owner of selected) {
    if (!ENTITY_SCOPE_ORDER.includes(owner))
      throw new TypeError(`未知实体类型：${String(owner)}`);
  }
  const scope = ENTITY_SCOPE_ORDER.filter((owner) => selected.has(owner));
  if (!scope.length) throw new TypeError("至少选择一种实体");
  return scope as unknown as EntityScope;
}

export type ListQuery = Omit<ExplorerQuery, "owner" | "aggregate"> & {
  scope: EntityScope;
  aggregate?: undefined;
};

export type AggregateQuery = Omit<ExplorerQuery, "aggregate"> & {
  aggregate: ExplorerAggregate;
};

export type QueryDraft =
  | { kind: "list"; query: ListQuery; allText?: never }
  | { kind: "list"; allText: string; query?: never }
  | { kind: "aggregate"; query: AggregateQuery }
  | { kind: "comparison"; from: EntityRef; to: EntityRef }
  | {
      kind: "path";
      from: EntityRef;
      to: EntityRef;
      maxHops: number;
      maxPaths: number;
    };

type OwnerTarget = { owner?: Owner };

export type QueryAction =
  | { type: "replace"; draft: QueryDraft }
  | { type: "setScope"; scope: Iterable<Owner> }
  | { type: "setOwner"; owner: Owner }
  | { type: "setAllText"; text: string }
  | ({ type: "setText"; text: ExplorerQuery["text"] | undefined } & OwnerTarget)
  | ({ type: "setCondition"; condition: ExplorerCondition | undefined } & OwnerTarget)
  | ({ type: "addCondition"; condition: ExplorerCondition } & OwnerTarget)
  | { type: "replaceCondition"; index: number; condition: ExplorerCondition }
  | { type: "removeCondition"; index: number }
  | ({ type: "setRelations"; relations: ExplorerRelation[] } & OwnerTarget)
  | ({ type: "addRelation"; relation: ExplorerRelation } & OwnerTarget)
  | { type: "replaceRelation"; index: number; relation: ExplorerRelation }
  | { type: "removeRelation"; index: number }
  | ({ type: "setColumns"; columns: string[] | undefined } & OwnerTarget)
  | ({ type: "setOrder"; orderBy: ExplorerQuery["orderBy"] } & OwnerTarget)
  | { type: "setLimit"; limit: number | undefined }
  | ({ type: "setAggregate"; aggregate: ExplorerAggregate } & OwnerTarget)
  | { type: "setList"; owner?: Owner }
  | { type: "setComparison"; from: EntityRef; to: EntityRef }
  | {
      type: "setPath";
      from: EntityRef;
      to: EntityRef;
      maxHops: number;
      maxPaths: number;
    };

export interface QueryHistory {
  current: QueryDraft;
  past: QueryDraft[];
  future: QueryDraft[];
  mergeKey: string | null;
}

export function defaultQueryDraft(
  scope: Owner | Iterable<Owner> = DEFAULT_ENTITY_SCOPE,
): QueryDraft {
  return {
    kind: "list",
    query: {
      scope: normalizeEntityScope(typeof scope === "string" ? [scope] : scope),
    },
  };
}

export function draftQuery(
  draft: QueryDraft,
): ListQuery | AggregateQuery | null {
  return (draft.kind === "list" || draft.kind === "aggregate") && draft.query
    ? draft.query
    : null;
}

export function draftScope(draft: QueryDraft): EntityScope | null {
  if (draft.kind === "list" && draft.query) return draft.query.scope;
  if (draft.kind === "aggregate") return [draft.query.owner];
  return null;
}

export function draftOwner(draft: QueryDraft): Owner | null {
  if (draft.kind === "aggregate") return draft.query.owner;
  if (draft.kind !== "list" || !draft.query || draft.query.scope.length !== 1)
    return null;
  return draft.query.scope[0] ?? null;
}

export function topLevelConditions(
  condition: ExplorerCondition | undefined,
): ExplorerCondition[] {
  return condition?.kind === "all"
    ? condition.terms
    : condition
      ? [condition]
      : [];
}

export function combineConditions(
  terms: ExplorerCondition[],
): ExplorerCondition | undefined {
  return terms.length === 0
    ? undefined
    : terms.length === 1
      ? terms[0]
      : { kind: "all", terms };
}

function withCondition<T extends ListQuery | AggregateQuery>(
  query: T,
  condition: ExplorerCondition | undefined,
): T {
  const { condition: _previous, ...rest } = query;
  return {
    ...rest,
    ...(condition ? { condition } : {}),
  } as T;
}

function withRelations<T extends ListQuery | AggregateQuery>(
  query: T,
  relations: ExplorerRelation[],
): T {
  const { relations: _previous, ...rest } = query;
  return {
    ...rest,
    ...(relations.length ? { relations } : {}),
  } as T;
}

function listLike(
  draft: QueryDraft,
): { kind: "list"; query: ListQuery } | { kind: "aggregate"; query: AggregateQuery } {
  if ((draft.kind !== "list" && draft.kind !== "aggregate") || !draft.query)
    throw new TypeError("当前查询不是列表或统计查询");
  return draft;
}

function replaceListQuery(
  draft: { kind: "list"; query: ListQuery } | { kind: "aggregate"; query: AggregateQuery },
  query: ListQuery | AggregateQuery,
): QueryDraft {
  return draft.kind === "aggregate"
    ? { kind: "aggregate", query: query as AggregateQuery }
    : { kind: "list", query: query as ListQuery };
}

function replaceAt<T>(items: readonly T[], index: number, value?: T): T[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= items.length)
    throw new RangeError("查询片段位置无效");
  return value === undefined
    ? items.filter((_, itemIndex) => itemIndex !== index)
    : items.map((item, itemIndex) => itemIndex === index ? value : item);
}

function conditionFields(condition: ExplorerCondition | undefined): string[] {
  if (!condition) return [];
  if (condition.kind === "all" || condition.kind === "any")
    return condition.terms.flatMap(conditionFields);
  if (condition.kind === "not") return conditionFields(condition.term);
  return "field" in condition ? [condition.field] : [];
}

function queryFragmentLabels(query: ListQuery): string[] {
  const fields = [
    ...conditionFields(query.condition),
    ...(query.columns ?? []),
    ...(query.orderBy ?? []).map((item) => item.column),
  ];
  const labels = fields.map((field) => FIELD_LABEL[field] ?? field);
  if (query.relations?.length) labels.push("关联条件");
  if (query.text?.capability === "fullText") labels.push("正文范围");
  return [...new Set(labels)];
}

function explorerOf(query: ListQuery, owner: Owner): ExplorerQuery {
  const { scope: _scope, aggregate: _aggregate, ...rest } = query;
  return { owner, ...rest };
}

function assertScopeCompatible(query: ListQuery): void {
  for (const owner of query.scope) {
    try {
      compileExplorerQuery(explorerOf(query, owner));
    } catch (error) {
      const fragments = queryFragmentLabels(query);
      const suffix = fragments.length ? `：${fragments.join("、")}` : "";
      throw new TypeError(`${OWNER_LABEL[owner]}不支持当前查询片段${suffix}`, {
        cause: error,
      });
    }
  }
}

function targetedQuery(
  current: { kind: "list"; query: ListQuery } | { kind: "aggregate"; query: AggregateQuery },
  owner: Owner | undefined,
): ListQuery | AggregateQuery {
  if (!owner) return current.query;
  return current.kind === "aggregate"
    ? { ...current.query, owner }
    : { ...current.query, scope: [owner] };
}

function checked(result: QueryDraft): QueryDraft {
  if (result.kind === "list" && result.query) assertScopeCompatible(result.query);
  else if (result.kind === "aggregate") compileExplorerQuery(result.query);
  return result;
}

export function applyQueryAction(
  draft: QueryDraft,
  action: QueryAction,
): QueryDraft {
  if (action.type === "replace") return checked(action.draft);
  if (action.type === "setAllText") {
    const text = action.text.trim();
    if (!text) throw new TypeError("请输入要搜索的正文");
    if ([...text].length < QUERY_CONTRACT.search.fullText.minNormalizedCharacters)
      throw new TypeError("正文关键词至少需要两个字");
    return { kind: "list", allText: text };
  }
  if (action.type === "setComparison")
    return { kind: "comparison", from: action.from, to: action.to };
  if (action.type === "setPath")
    return {
      kind: "path",
      from: action.from,
      to: action.to,
      maxHops: action.maxHops,
      maxPaths: action.maxPaths,
    };
  if (action.type === "setScope") {
    if (draft.kind !== "list" || !draft.query)
      throw new TypeError("只有实体列表可以选择多个实体类型");
    return checked({
      kind: "list",
      query: { ...draft.query, scope: normalizeEntityScope(action.scope) },
    });
  }
  if (action.type === "setOwner") {
    if (draft.kind === "aggregate")
      return checked({ kind: "aggregate", query: { ...draft.query, owner: action.owner } });
    if (draft.kind === "list" && draft.query)
      return checked({ kind: "list", query: { ...draft.query, scope: [action.owner] } });
    return defaultQueryDraft(action.owner);
  }
  if (action.type === "setList") {
    const current = draftQuery(draft);
    if (!current) return defaultQueryDraft(action.owner ?? DEFAULT_ENTITY_SCOPE);
    if (draft.kind === "aggregate") {
      const { aggregate: _aggregate, orderBy: _orderBy, ...query } = draft.query;
      return checked({
        kind: "list",
        query: { ...query, scope: [action.owner ?? draft.query.owner] },
      });
    }
    if (draft.kind === "list" && draft.query)
      return checked({
        kind: "list",
        query: {
          ...draft.query,
          ...(action.owner ? { scope: [action.owner] as EntityScope } : {}),
        },
      });
    return defaultQueryDraft(action.owner ?? DEFAULT_ENTITY_SCOPE);
  }

  const current = listLike(draft);
  const query = targetedQuery(current, "owner" in action ? action.owner : undefined);
  let result: QueryDraft;
  switch (action.type) {
    case "setText": {
      const { text: _previous, ...rest } = query;
      result = replaceListQuery(current, {
        ...rest,
        ...(action.text ? { text: action.text } : {}),
      });
      break;
    }
    case "setCondition":
      result = replaceListQuery(current, withCondition(query, action.condition));
      break;
    case "addCondition":
      result = replaceListQuery(current, withCondition(
        query,
        combineConditions([...topLevelConditions(query.condition), action.condition]),
      ));
      break;
    case "replaceCondition":
      result = replaceListQuery(current, withCondition(
        query,
        combineConditions(replaceAt(
          topLevelConditions(query.condition),
          action.index,
          action.condition,
        )),
      ));
      break;
    case "removeCondition":
      result = replaceListQuery(current, withCondition(
        query,
        combineConditions(replaceAt(topLevelConditions(query.condition), action.index)),
      ));
      break;
    case "setRelations":
      result = replaceListQuery(current, withRelations(query, action.relations));
      break;
    case "addRelation":
      result = replaceListQuery(current, withRelations(
        query,
        [...(query.relations ?? []), action.relation],
      ));
      break;
    case "replaceRelation":
      result = replaceListQuery(current, withRelations(
        query,
        replaceAt(query.relations ?? [], action.index, action.relation),
      ));
      break;
    case "removeRelation":
      result = replaceListQuery(current, withRelations(
        query,
        replaceAt(query.relations ?? [], action.index),
      ));
      break;
    case "setColumns": {
      const { columns: _previous, ...rest } = query;
      result = replaceListQuery(current, {
        ...rest,
        ...(action.columns?.length ? { columns: [...action.columns] } : {}),
      });
      break;
    }
    case "setOrder": {
      const { orderBy: _previous, ...rest } = query;
      result = replaceListQuery(current, {
        ...rest,
        ...(action.orderBy?.length ? { orderBy: [...action.orderBy] } : {}),
      });
      break;
    }
    case "setLimit": {
      const { limit: _previous, ...rest } = query;
      result = replaceListQuery(current, {
        ...rest,
        ...(action.limit === undefined ? {} : { limit: action.limit }),
      });
      break;
    }
    case "setAggregate": {
      const owner = action.owner ?? (current.kind === "aggregate"
        ? current.query.owner
        : current.query.scope.length === 1 ? current.query.scope[0] : undefined);
      if (!owner) throw new TypeError("请先选择要统计的实体类型");
      const {
        columns: _columns,
        aggregate: _aggregate,
        orderBy: _orderBy,
        ...rest
      } = query;
      const { scope: _scope, ...selection } = rest as ListQuery;
      result = {
        kind: "aggregate",
        query: { ...selection, owner, aggregate: action.aggregate },
      };
      break;
    }
  }
  return checked(result);
}

const MULTI_SCOPE_FIELDS = ["ref", "name"] as const;

function prefixedOperator(operator: QueryOperator, prefix: string): QueryOperator {
  const id = (value: string): string => `${prefix}${value}`;
  switch (operator.kind) {
    case "filter":
    case "project":
    case "matchFact":
    case "followRef":
    case "aggregate":
    case "path":
      return { ...operator, input: id(operator.input) };
    case "exists":
    case "notExists":
      return { ...operator, input: id(operator.input), match: id(operator.match) };
    case "union":
    case "intersect":
    case "except":
      return {
        ...operator,
        branches: operator.branches.map((branch) => ({
          ...branch,
          input: id(branch.input),
        })),
      };
    default:
      return { ...operator };
  }
}

function mergeParameterTypes(
  target: Record<string, ParameterType>,
  source: Record<string, ParameterType>,
): void {
  for (const [name, type] of Object.entries(source)) {
    if (target[name] && target[name] !== type)
      throw new TypeError(`参数 ${name} 在多实体查询中类型不一致`);
    target[name] = type;
  }
}

function mergeParameterValues(
  target: ParameterValues,
  source: ParameterValues,
): void {
  for (const [name, value] of Object.entries(source)) {
    if (Object.hasOwn(target, name) && target[name] !== value)
      throw new TypeError(`参数 ${name} 在多实体查询中值不一致`);
    target[name] = value;
  }
}

function compileScopedList(query: ListQuery): QueryBundle {
  assertScopeCompatible(query);
  if (query.scope.length === 1)
    return compileExplorerQuery(explorerOf(query, query.scope[0]!));

  const fields = [...new Set([
    ...MULTI_SCOPE_FIELDS,
    ...(query.columns ?? []),
  ])];
  const operators: Record<string, QueryOperator> = {};
  const parameters: Record<string, ParameterType> = {};
  const parameterValues: ParameterValues = {};
  const branches: SetBranch[] = [];

  query.scope.forEach((owner, index) => {
    const prefix = `scope${index}-`;
    const branch = compileExplorerQuery({
      ...explorerOf(query, owner),
      columns: fields,
      orderBy: [],
      limit: null,
    }).sections.results!;
    mergeParameterTypes(parameters, branch.query.parameters);
    mergeParameterValues(parameterValues, branch.parameterValues ?? {});
    for (const [name, operator] of Object.entries(branch.query.operators))
      operators[`${prefix}${name}`] = prefixedOperator(operator, prefix);
    const shaped = `${prefix}shape`;
    operators[shaped] = {
      kind: "project",
      input: `${prefix}${branch.query.root}`,
      columns: [
        ...fields.map((field) => ({
          name: field,
          value: { kind: "column" as const, name: field },
        })),
        {
          name: "entityType",
          value: { kind: "literal" as const, value: owner },
        },
      ],
    };
    branches.push({
      input: shaped,
      columns: [...fields, "entityType"].map((field) => ({
        output: field,
        input: field,
      })),
    });
  });
  operators.results = { kind: "union", branches };
  const section: QuerySection = {
    query: {
      schema: "atlas-query-document-v2",
      root: "results",
      parameters,
      operators,
      orderBy: query.orderBy ?? [],
      limit: query.limit ?? null,
    },
    ...(Object.keys(parameterValues).length ? { parameterValues } : {}),
    answer: { shape: "entity-list", title: "全部匹配" },
  };
  return {
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: { results: section },
  };
}

export function compileQueryDraft(draft: QueryDraft): QueryBundle {
  switch (draft.kind) {
    case "list":
      return draft.query ? compileScopedList(draft.query) : fullTextRecipe(draft.allText);
    case "aggregate":
      return compileExplorerQuery(draft.query);
    case "comparison":
      return comparisonRecipe(draft.from, draft.to);
    case "path":
      return pathRecipe(draft.from, draft.to, {
        maxHops: draft.maxHops,
        maxPaths: draft.maxPaths,
      });
  }
}

function operatorInputs(operator: QueryOperator): string[] {
  if (operator.kind === "union" || operator.kind === "intersect" || operator.kind === "except")
    return operator.branches.map((branch) => branch.input);
  if (operator.kind === "exists" || operator.kind === "notExists")
    return [operator.input, operator.match];
  if (
    operator.kind === "filter" || operator.kind === "project" ||
    operator.kind === "matchFact" || operator.kind === "followRef" ||
    operator.kind === "aggregate" || operator.kind === "path"
  ) return [operator.input];
  return [];
}

function operatorSubtree(
  document: QueryDocument,
  root: string,
): Record<string, QueryOperator> | null {
  const result: Record<string, QueryOperator> = {};
  const visit = (id: string): boolean => {
    if (result[id]) return true;
    const operator = document.operators[id];
    if (!operator) return false;
    result[id] = operator;
    return operatorInputs(operator).every(visit);
  };
  return visit(root) ? result : null;
}

function sameBundle(left: QueryBundle, right: QueryBundle): boolean {
  return canonicalJson(normalizeBundle(left)) === canonicalJson(normalizeBundle(right));
}

function decompileScopedList(bundle: QueryBundle): QueryDraft | null {
  const section = Object.keys(bundle.sections).length === 1
    ? bundle.sections.results
    : undefined;
  if (!section) return null;
  const root = section.query.operators[section.query.root];
  if (root?.kind !== "union") return null;
  const owners: Owner[] = [];
  const branches: ExplorerQuery[] = [];
  let sharedFields: string[] | null = null;

  for (const branch of root.branches) {
    const outer = section.query.operators[branch.input];
    if (outer?.kind !== "project") return null;
    const ownerColumn = outer.columns.find((column) => column.name === "entityType");
    const owner = ownerColumn?.value.kind === "literal" &&
        typeof ownerColumn.value.value === "string" &&
        ENTITY_SCOPE_ORDER.includes(ownerColumn.value.value as Owner)
      ? ownerColumn.value.value as Owner
      : null;
    if (!owner || owners.includes(owner)) return null;
    const fields = outer.columns
      .filter((column) => column.name !== "entityType")
      .map((column) =>
        column.value.kind === "column" && column.value.name === column.name
          ? column.name
          : null
      );
    if (fields.some((field) => field === null)) return null;
    const branchFields = fields as string[];
    if (sharedFields && canonicalJson(sharedFields) !== canonicalJson(branchFields))
      return null;
    sharedFields = branchFields;
    const operators = operatorSubtree(section.query, outer.input);
    if (!operators) return null;
    const restored = decompileExplorerQuery({
      schema: "atlas-query-bundle-v2",
      release: bundle.release,
      sections: {
        results: {
          query: {
            schema: "atlas-query-document-v2",
            root: outer.input,
            parameters: section.query.parameters,
            operators,
            orderBy: [],
            limit: null,
          },
          ...(section.parameterValues ? { parameterValues: section.parameterValues } : {}),
          answer: { shape: "entity-list", title: "探索结果" },
        },
      },
    });
    if (!restored || restored.aggregate || restored.owner !== owner) return null;
    owners.push(owner);
    branches.push(restored);
  }
  if (owners.length < 2 || !sharedFields) return null;
  const first = branches[0];
  if (!first) return null;
  const comparable = (query: ExplorerQuery): unknown => {
    const {
      owner: _owner,
      columns: _columns,
      orderBy: _orderBy,
      limit: _limit,
      aggregate: _aggregate,
      ...selection
    } = query;
    return selection;
  };
  if (branches.some((branch) => canonicalJson(comparable(branch)) !== canonicalJson(comparable(first))))
    return null;
  const {
    owner: _owner,
    columns: _columns,
    orderBy: _orderBy,
    limit: _limit,
    aggregate: _aggregate,
    ...selection
  } = first;
  const implicitColumns = sharedFields.length === MULTI_SCOPE_FIELDS.length &&
    sharedFields.every((field, index) => field === MULTI_SCOPE_FIELDS[index]);
  const candidate: QueryDraft = {
    kind: "list",
    query: {
      scope: normalizeEntityScope(owners),
      ...selection,
      ...(implicitColumns ? {} : { columns: sharedFields }),
      ...(section.query.orderBy?.length ? { orderBy: section.query.orderBy } : {}),
      ...(section.query.limit === null || section.query.limit === undefined
        ? {}
        : { limit: section.query.limit }),
    },
  };
  return sameBundle(compileQueryDraft(candidate), bundle) ? candidate : null;
}

export function queryDraftFromBundle(bundle: QueryBundle): QueryDraft | null {
  const scoped = decompileScopedList(bundle);
  if (scoped) return scoped;
  const restored = decompileExplorerQuery(bundle);
  if (restored) {
    const { owner, orderBy, relations, limit, aggregate, ...base } = restored;
    const query: ExplorerQuery = {
      owner,
      ...base,
      ...(aggregate ? { aggregate } : {}),
      ...(relations?.length ? { relations } : {}),
      ...(orderBy?.length ? { orderBy } : {}),
      ...(limit === undefined || limit === null ? {} : { limit }),
    };
    return aggregate
      ? { kind: "aggregate", query: query as AggregateQuery }
      : {
          kind: "list",
          query: {
            ...base,
            scope: [owner],
            ...(relations?.length ? { relations } : {}),
            ...(orderBy?.length ? { orderBy } : {}),
            ...(limit === undefined || limit === null ? {} : { limit }),
          },
        };
  }
  const recipe = decompileQueryRecipe(bundle);
  if (recipe?.kind === "fullText") return { kind: "list", allText: recipe.text };
  if (recipe?.kind === "common")
    return {
      kind: "comparison",
      from: recipe.from as EntityRef,
      to: recipe.to as EntityRef,
    };
  if (recipe?.kind === "path")
    return {
      kind: "path",
      from: recipe.from as EntityRef,
      to: recipe.to as EntityRef,
      maxHops: recipe.maxHops,
      maxPaths: recipe.maxPaths,
    };
  return null;
}

export function createQueryHistory(current: QueryDraft): QueryHistory {
  return { current, past: [], future: [], mergeKey: null };
}

function sameDraft(left: QueryDraft, right: QueryDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function updateQueryHistory(
  history: QueryHistory,
  action: QueryAction,
  mergeKey: string | null = null,
): QueryHistory {
  const current = applyQueryAction(history.current, action);
  if (sameDraft(current, history.current)) return history;
  return {
    current,
    past: mergeKey !== null && mergeKey === history.mergeKey
      ? history.past
      : [...history.past, history.current],
    future: [],
    mergeKey,
  };
}

export function undoQueryHistory(history: QueryHistory): QueryHistory {
  const current = history.past.at(-1);
  if (!current) return history;
  return {
    current,
    past: history.past.slice(0, -1),
    future: [history.current, ...history.future],
    mergeKey: null,
  };
}

export function redoQueryHistory(history: QueryHistory): QueryHistory {
  const current = history.future[0];
  if (!current) return history;
  return {
    current,
    past: [...history.past, history.current],
    future: history.future.slice(1),
    mergeKey: null,
  };
}
