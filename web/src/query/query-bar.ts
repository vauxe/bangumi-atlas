import {
  applyQueryAction,
  combineConditions,
  compileQueryDraft,
  createQueryHistory,
  draftOwner,
  draftQuery,
  draftScope,
  ENTITY_SCOPE_ORDER,
  normalizeFullTextValue,
  normalizeEntityScope,
  redoQueryHistory,
  type EntityRef,
  type EntityScope,
  type QueryAction,
  type QueryDraft,
  type QueryHistory,
  type ScopedOrderTerm,
  undoQueryHistory,
  updateQueryHistory,
} from "./draft";
import {
  conditionEditValue,
  createEntityCondition,
  createFactCondition,
  createStatisticCondition,
  statisticConditionOperators,
} from "./edit";
import type {
  ExplorerAggregate,
  ExplorerCondition,
  ExplorerRelation,
} from "./explorer";
import {
  describeFactCondition,
  queryInputValue,
  queryTokens,
  type QueryToken,
} from "./presenter";
import {
  parseEntityRef,
  QUERY_CONTRACT,
  type Owner,
  type QueryFactKind,
} from "./contract";
import {
  AGGREGATE_FUNCTION_LABEL,
  COMMON_FIELDS,
  defaultSortDirection,
  enumValuesFor,
  FACT_FIELD_LABEL,
  FACT_LABEL,
  factEnumValues,
  FIELD_LABEL,
  OPERATOR_LABEL,
  OWNER_LABEL,
  parseExplorerLimit,
  queryAddFilterFields,
  queryAggregateFields,
  queryConditionOperatorLabel,
  queryConditionOperators,
  queryFactDiscriminatorField,
  queryFactFields,
  queryFilterFields,
  queryFieldsFor,
  queryGroupFields,
  queryReferenceOwner,
  queryRelationOptions,
  queryRelationContextRoles,
  queryRelationTargetOwner,
  queryScalarInputType,
  querySortFields,
  queryStatisticColumns,
  type QueryScalarInputType,
  sameFilterFieldSemantics,
  sameSortFieldSemantics,
  splitFactDiscriminatorCondition,
} from "./workbench-model";
import {
  defaultResultColumnSelection,
  normalizeResultColumnSelection,
  resultColumnChoices,
} from "./result-columns";
import type { AggregateFunction } from "./document";
import {
  attachValueAutocomplete,
  type ValueSuggester,
} from "./value-autocomplete";
import {
  setQueryIconButton,
  type QueryIconName,
} from "./icons";
import type { Mappings, TagVocabularyField } from "../types";

let queryBarSequence = 0;
let queryControlSequence = 0;
const ENTITY_SUGGESTION_RENDER_BATCH = 80;

export interface SelectedQueryEntity {
  ref: EntityRef;
  /** 提供方已经完成显示文本投影，消费者不得再次投影。 */
  label: string;
}

export interface EntitySuggestion extends SelectedQueryEntity {
  owner: Owner;
  /** 与 label 相同，均为已经准备好的显示文本。 */
  detail?: string;
  match?: string;
}

export interface EntitySuggestionBatch {
  items: readonly EntitySuggestion[];
  complete: boolean;
}

export interface NameSuggestion {
  key: string;
  owner: Owner;
  label: string;
  detail?: string;
  match?: string;
  rank?: number;
  ref?: EntityRef;
}

export function queryNameSuggestionOwners(draft: QueryDraft): Owner[] {
  const query = draftQuery(draft);
  if (!query) return [];
  return [...(draftScope(draft) ?? [])];
}

export function isActionShortcut(value: string, committed: string): boolean {
  return value === "/" && committed.length === 0;
}

function comparableSuggestionText(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

export function rankEntitySuggestions(
  text: string,
  items: readonly EntitySuggestion[],
): EntitySuggestion[] {
  const query = comparableSuggestionText(text);
  const rank = (item: EntitySuggestion): number => {
    const candidate = comparableSuggestionText(item.match ?? item.label);
    if (candidate === query) return 0;
    if (candidate.startsWith(query)) return 1;
    if (candidate.includes(query)) return 2;
    return 3;
  };
  return items.map((item, index) => ({ item, index }))
    .sort((left, right) => rank(left.item) - rank(right.item) || left.index - right.index)
    .map(({ item }) => item);
}

export function createScopedFullTextAction(value: string): QueryAction {
  return {
    type: "setFullText",
    fullText: { value: normalizeFullTextValue(value) },
  };
}

export function moveSuggestionIndex(
  index: number,
  count: number,
  key: "ArrowDown" | "ArrowUp",
): number {
  if (count <= 0) return -1;
  const start = index < 0 ? (key === "ArrowDown" ? -1 : 0) : index;
  const delta = key === "ArrowDown" ? 1 : -1;
  return (start + delta + count) % count;
}

export function tagVocabularyField(
  owner: Owner,
  field: string,
): TagVocabularyField | null {
  if (owner === "subject" && (field === "tags" || field === "metaTags"))
    return field;
  return null;
}

export function featuredMetaTagValuesFor(
  field: TagVocabularyField | null,
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  return field === "metaTags" ? values : undefined;
}

export function conditionEditorOperatorChoices(
  allowed: readonly string[],
  inputType: QueryScalarInputType,
  current: string,
  valueCount = 0,
): string[] {
  const scalar = new Set([
    "eq", "ne", "lt", "lte", "gt", "gte",
    "isNull", "isNotNull", "isMissing", "isPresent",
  ]);
  const closedChoice = new Set([
    "eq", "ne", "contains", "notContains", "in", "notIn",
    "isNull", "isNotNull", "isMissing", "isPresent",
  ]);
  const binaryChoice = new Set([
    "eq", "contains", "notContains",
    "isNull", "isNotNull", "isMissing", "isPresent",
  ]);
  const visible = valueCount
    ? allowed.filter((operator) =>
        (valueCount <= 2 ? binaryChoice : closedChoice).has(operator)
      )
    : inputType === "number" || inputType === "date"
      ? allowed.filter((operator) => scalar.has(operator))
      : [...allowed];
  if (allowed.includes(current) && !visible.includes(current))
    visible.push(current);
  return visible;
}

export interface QueryBarOptions {
  draft: QueryDraft;
  onChange(draft: QueryDraft): void;
  onSubmit(): void;
  onCancel(): void;
  reportError(error: unknown): void;
  selectedEntity?(): Promise<SelectedQueryEntity | null>;
  resolveEntityLabel?(ref: string): Promise<string>;
  suggestEntities?(
    text: string,
    owners: readonly Owner[],
    signal: AbortSignal,
  ): AsyncIterable<EntitySuggestionBatch>;
  suggestNames?(
    text: string,
    owners: readonly Owner[],
    signal: AbortSignal,
  ): Promise<NameSuggestion[]>;
  suggestTagValues?(
    field: TagVocabularyField,
    text: string,
    signal: AbortSignal,
  ): Promise<readonly string[]>;
  featuredMetaTagValues?: readonly string[];
  onNameSuggestion?(suggestion: NameSuggestion): void;
  mappings?(): Promise<Mappings>;
}

export interface QueryRunState {
  running: boolean;
  runnable: boolean;
}

export interface QueryRunPresentation {
  icon: QueryIconName;
  ariaLabel: string;
  disabled: boolean;
  busy: boolean;
}

export function queryRunPresentation(
  state: QueryRunState,
): QueryRunPresentation {
  if (state.running) return {
    icon: "stop",
    ariaLabel: "正在查询，点击停止",
    disabled: false,
    busy: true,
  };
  if (!state.runnable) return {
    icon: "search",
    ariaLabel: "当前查询不可执行",
    disabled: true,
    busy: false,
  };
  return {
    icon: "search",
    ariaLabel: "执行查询",
    disabled: false,
    busy: false,
  };
}

interface QueryAddChoiceBase {
  id: string;
  label: string;
  detail: string;
}

export type QueryAddChoice =
  | QueryAddChoiceBase & {
      kind: "condition";
      owners: Owner[];
      field: string;
    }
  | QueryAddChoiceBase & { kind: "relation"; owner?: Owner }
  | QueryAddChoiceBase & { kind: "fullText" }
  | QueryAddChoiceBase & { kind: "columns" }
  | QueryAddChoiceBase & { kind: "sort" };

function orderedFields(owner: Owner, fields: string[]): string[] {
  return [
    ...[...COMMON_FIELDS[owner]].filter((field) => fields.includes(field)),
    ...fields.filter((field) => !COMMON_FIELDS[owner].has(field)),
  ];
}

function orderedFilterFields(owner: Owner): string[] {
  return orderedFields(owner, queryAddFilterFields(owner));
}

function ownerListLabel(owners: readonly Owner[]): string {
  return owners.map((owner) => OWNER_LABEL[owner]).join("、");
}

function sameOwnerScope(left: readonly Owner[], right: readonly Owner[]): boolean {
  return left.length === right.length &&
    left.every((owner, index) => owner === right[index]);
}

export function toggleEntityScope(
  scope: readonly Owner[],
  owner: Owner,
): EntityScope {
  const selected = new Set(scope);
  if (selected.has(owner)) selected.delete(owner);
  else selected.add(owner);
  return normalizeEntityScope(selected);
}

export function queryEditorFilterFields(
  owners: readonly Owner[],
  restoredFields: readonly string[] = [],
): string[] {
  const [first, ...rest] = owners;
  if (!first) return [];
  const available = queryFilterFields(first);
  const fields = [
    ...queryAddFilterFields(first),
    ...restoredFields.filter((field) => available.includes(field)),
  ];
  return orderedFields(first, [...new Set(fields)]).filter((field) =>
    rest.every((owner) => sameFilterFieldSemantics(first, owner, field))
  );
}

export interface QuerySortChoice {
  id: string;
  field: string;
  owners: Owner[];
  label: string;
}

export function querySortChoicesForScope(
  scope: readonly Owner[],
): QuerySortChoice[] {
  const choices: Array<Omit<QuerySortChoice, "id" | "label">> = [];
  for (const owner of scope) {
    for (const field of querySortFields(owner)) {
      const existing = choices.find((choice) =>
        choice.field === field &&
        sameSortFieldSemantics(choice.owners[0]!, owner, field)
      );
      if (existing) existing.owners.push(owner);
      else choices.push({ field, owners: [owner] });
    }
  }
  return choices.map(({ field, owners }) => ({
    id: `${owners.join("+")}:${field}`,
    field,
    owners,
    label: sameOwnerScope(owners, scope)
      ? FIELD_LABEL[field] ?? field
      : `${ownerListLabel(owners)} · ${FIELD_LABEL[field] ?? field}`,
  }));
}

function fieldNeedsOwnerLabel(field: string): boolean {
  const owners = ENTITY_SCOPE_ORDER.filter((owner) =>
    queryFilterFields(owner).includes(field)
  );
  const [first, ...rest] = owners;
  return Boolean(first && rest.some((owner) =>
    !sameFilterFieldSemantics(first, owner, field)
  ));
}

export interface ScopedRelationChoice {
  owner: Owner;
  value: string;
  topology: string;
  label: string;
  displayLabel: string;
  detailLabel: string;
  factKind: QueryFactKind;
  candidateRole: string;
  relatedRole: string;
  discriminatorField?: string;
  discriminatorLabel?: string;
  discriminatorValues?: string[];
}

function relationChoiceDetail(
  owner: Owner,
  factKind: QueryFactKind,
  candidateRole: string,
  relatedRole: string,
): string {
  const relatedOwner = QUERY_CONTRACT.facts[factKind].roles[relatedRole]!;
  const arrow = candidateRole === "target" && relatedRole === "source"
    ? "←"
    : "→";
  return `${OWNER_LABEL[owner]} ${arrow} ${OWNER_LABEL[relatedOwner]}`;
}

export function relationChoicesForScope(
  scope: readonly Owner[],
  mappings?: Mappings,
): ScopedRelationChoice[] {
  const choices = scope.flatMap((owner) =>
    queryRelationOptions(owner).flatMap((relation) => {
      const generic: ScopedRelationChoice = {
        owner,
        ...relation,
        topology: relation.value,
        displayLabel: `任意${FACT_LABEL[relation.factKind]}`,
        detailLabel: relationChoiceDetail(
          owner,
          relation.factKind,
          relation.candidateRole,
          relation.relatedRole,
        ),
      };
      const field = queryFactDiscriminatorField(relation.factKind);
      const values = field ? factEnumValues(relation.factKind, field, mappings) : null;
      if (!field || !values) return [generic];
      const grouped = new Map<string, string[]>();
      for (const [value, label] of Object.entries(values)) {
        const codes = grouped.get(label) ?? [];
        codes.push(value);
        grouped.set(label, codes);
      }
      return [
        generic,
        ...[...grouped].map(([label, codes]): ScopedRelationChoice => ({
          owner,
          value: JSON.stringify([relation.value, field, codes]),
          topology: relation.value,
          label,
          displayLabel: label,
          detailLabel: relationChoiceDetail(
            owner,
            relation.factKind,
            relation.candidateRole,
            relation.relatedRole,
          ),
          factKind: relation.factKind,
          candidateRole: relation.candidateRole,
          relatedRole: relation.relatedRole,
          discriminatorField: field,
          discriminatorLabel: label,
          discriminatorValues: codes,
        })),
      ];
    })
  );
  const duplicateLabels = new Map<string, number>();
  for (const choice of choices)
    duplicateLabels.set(
      `${choice.displayLabel}|${choice.detailLabel}`,
      (duplicateLabels.get(`${choice.displayLabel}|${choice.detailLabel}`) ?? 0) + 1,
    );
  return choices.map((choice) =>
    duplicateLabels.get(`${choice.displayLabel}|${choice.detailLabel}`)! > 1
      ? {
          ...choice,
          detailLabel: `${choice.detailLabel} · ${FACT_LABEL[choice.factKind]}`,
        }
      : choice
  );
}

function comparableRelationText(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}

export function filterRelationChoices(
  choices: readonly ScopedRelationChoice[],
  input: string,
): ScopedRelationChoice[] {
  const needle = comparableRelationText(input);
  if (!needle) return [...choices];
  const terms = needle.split(/\s+/).filter(Boolean);
  return choices
    .map((choice, index) => ({ choice, index }))
    .filter(({ choice }) => {
      const text = comparableRelationText(
        `${choice.displayLabel} ${choice.detailLabel} ${FACT_LABEL[choice.factKind]}`,
      );
      return terms.every((term) => text.includes(term));
    })
    .sort((left, right) => {
      const leftLabel = comparableRelationText(
        left.choice.discriminatorLabel ?? left.choice.label,
      );
      const rightLabel = comparableRelationText(
        right.choice.discriminatorLabel ?? right.choice.label,
      );
      const rank = (label: string): number =>
        label === needle ? 0 : label.startsWith(needle) ? 1 : 2;
      return rank(leftLabel) - rank(rightLabel) || left.index - right.index;
    })
    .map(({ choice }) => choice);
}

export function relationChoiceCondition(
  choice: ScopedRelationChoice,
): ExplorerCondition | undefined {
  const field = choice.discriminatorField;
  const values = choice.discriminatorValues;
  if (!field || !values?.length) return undefined;
  return createFactCondition(
    choice.factKind,
    field,
    values.length === 1 ? "eq" : "in",
    values.join("、"),
  );
}

export interface ResolvedRelationChoice {
  choice: ScopedRelationChoice;
  discriminator?: ExplorerCondition;
  remainder?: ExplorerCondition;
}

export function resolveRelationChoice(
  choices: readonly ScopedRelationChoice[],
  relation?: ExplorerRelation,
): ResolvedRelationChoice {
  if (!choices.length) throw new TypeError("当前实体类型没有可用关系");
  if (!relation) return { choice: choices[0]! };
  const topology =
    `${relation.factKind}|${relation.candidateRole}|${relation.relatedRole}`;
  const generic = choices.find((choice) => choice.value === topology);
  if (!generic) throw new TypeError("关联类型无效");
  const split = splitFactDiscriminatorCondition(
    relation.factKind,
    relation.condition,
  );
  const selected = split.discriminator
    ? choices.find((choice) =>
        choice.topology === topology &&
        choice.discriminatorValues &&
        split.values.every((value) =>
          choice.discriminatorValues!.includes(String(value))
        )
      )
    : undefined;
  if (!selected) {
    return {
      choice: generic,
      ...(relation.condition ? { remainder: relation.condition } : {}),
    };
  }
  return {
    choice: selected,
    discriminator: split.discriminator,
    remainder: split.remainder,
  };
}

export function factConditionSelections(
  condition?: ExplorerCondition,
  fields: readonly string[] = [],
): Record<string, string> | null {
  if (!condition) return {};
  const terms = condition.kind === "all" ? condition.terms : [condition];
  const selections: Record<string, string> = {};
  for (const term of terms) {
    if (
      term.kind !== "compare" || term.operator !== "eq" || term.negated ||
      term.parameter || !fields.includes(term.field) ||
      Object.hasOwn(selections, term.field) || term.value === null
    ) return null;
    selections[term.field] = String(term.value);
  }
  return selections;
}

export function updateFactConditionSelection(
  kind: QueryFactKind,
  condition: ExplorerCondition | undefined,
  fields: readonly string[],
  field: string,
  raw: string,
): ExplorerCondition | undefined {
  if (!fields.includes(field)) throw new TypeError("关系属性不在可选范围内");
  const selections = factConditionSelections(condition, fields);
  if (!selections) throw new TypeError("旧关系条件不能用简化选项修改");
  if (raw) selections[field] = raw;
  else delete selections[field];
  return combineConditions(fields.flatMap((candidate) => {
    const value = selections[candidate];
    return value === undefined
      ? []
      : [createFactCondition(kind, candidate, "eq", value)];
  }));
}

export function queryAddChoices(draft: QueryDraft): QueryAddChoice[] {
  if (draft.kind !== "list" || !draft.query) return [];
  const query = draft.query;

  const conditionSeeds: Array<{
    field: string;
    label: string;
    owners: Owner[];
  }> = [];
  for (const owner of query.scope) {
    for (const field of orderedFilterFields(owner)) {
      const existing = conditionSeeds.find((choice) =>
        choice.field === field &&
        sameFilterFieldSemantics(choice.owners[0]!, owner, field)
      );
      if (existing) existing.owners.push(owner);
      else conditionSeeds.push({
        field,
        label: FIELD_LABEL[field] ?? field,
        owners: [owner],
      });
    }
  }

  const labelCounts = new Map<string, number>();
  for (const choice of conditionSeeds)
    labelCounts.set(choice.label, (labelCounts.get(choice.label) ?? 0) + 1);
  const choices: QueryAddChoice[] = conditionSeeds.map((choice) => ({
    id: `condition:${choice.owners.join("+")}:${choice.field}`,
    kind: "condition",
    label: (labelCounts.get(choice.label) ?? 0) > 1 ||
        fieldNeedsOwnerLabel(choice.field)
      ? `${ownerListLabel(choice.owners)}${choice.label}`
      : choice.label,
    detail: !sameOwnerScope(choice.owners, query.scope)
      ? `仅${ownerListLabel(choice.owners)}`
      : "",
    owners: choice.owners,
    field: choice.field,
  }));

  if (
    !query.fullText &&
    query.scope.every((owner) => queryFieldsFor(owner, "fullText").length === 1)
  ) choices.push({
    id: "fullText",
    kind: "fullText",
    label: scopedFullTextLabel(query.scope),
    detail: "内容包含关键词",
  });

  if (relationChoicesForScope(query.scope).length) choices.push({
    id: "relation",
    kind: "relation",
    label: "按关联筛选",
    detail: "作品、人物或角色",
  });

  if (query.columns === undefined) choices.push({
    id: "columns",
    kind: "columns",
    label: "显示列",
    detail: "",
  });

  if (!query.orderBy?.length && querySortChoicesForScope(query.scope).length)
    choices.push({
      id: "sort",
      kind: "sort",
      label: "排序",
      detail: "选择排序字段",
    });
  return choices;
}

export function scopedFullTextLabel(scope: readonly Owner[]): string {
  const fields = new Set(scope.flatMap((owner) =>
    queryFieldsFor(owner, "fullText")
  ));
  if (fields.size > 1) return "简介与分集介绍";
  return fields.has("description") ? "分集介绍" : "简介";
}

export function addConditionForOwners(
  draft: QueryDraft,
  owners: readonly Owner[],
  condition: ExplorerCondition,
): QueryDraft {
  const currentScope = draftScope(draft);
  if (!currentScope) throw new TypeError("当前查询不能添加筛选条件");
  if (
    !owners.length ||
    owners.some((owner) => !currentScope.includes(owner))
  ) throw new TypeError("条件适用的实体不在当前范围内");
  const nextScope = currentScope.filter((owner) => owners.includes(owner));
  const scoped = sameOwnerScope(nextScope, currentScope)
    ? draft
    : applyQueryAction(draft, { type: "setScope", scope: nextScope });
  return applyQueryAction(scoped, { type: "addCondition", condition });
}

interface LeafEditorConfig {
  fields(): string[];
  fieldLabel(field: string): string;
  operators(field: string): string[];
  operatorLabel?(field: string, operator: string): string;
  values(field: string): Record<string, string> | null;
  suggestions?(field: string): ValueSuggester | null;
  featuredValues?(field: string): readonly string[] | undefined;
  inputType(field: string): QueryScalarInputType;
  referenceOwner?(field: string): Owner | null;
}

interface LeafConfig extends LeafEditorConfig {
  create(field: string, operator: string, raw: string): ExplorerCondition;
}

export type EditCondition =
  | { kind: "leaf"; field: string; operator: string; raw: string }
  | { kind: "all" | "any"; terms: EditCondition[] }
  | { kind: "not"; terms: EditCondition[] };

function editConditionFields(node: EditCondition): string[] {
  return node.kind === "leaf"
    ? [node.field]
    : node.terms.flatMap(editConditionFields);
}

export function conditionGroupControlsVisible(root: EditCondition): boolean {
  return root.kind !== "leaf" && (root.kind !== "all" || root.terms.length > 1);
}

type PanelRenderer = (body: HTMLElement) => void;

interface ConditionEditorOptions {
  compact?: boolean;
  submitLabel?: string;
  focusNode?: EditCondition;
}

export interface ControlFocus {
  key: string;
  index: number;
}

function controlFocusKey(control: HTMLElement): string | null {
  return control.getAttribute("aria-label")?.trim() || control.textContent?.trim() || null;
}

export function captureControlFocus(
  active: Element | null,
  controls: readonly HTMLElement[],
): ControlFocus | null {
  const control = controls.find((candidate) => candidate === active);
  if (!control) return null;
  const key = controlFocusKey(control);
  if (!key) return null;
  return {
    key,
    index: controls.filter((candidate) => controlFocusKey(candidate) === key).indexOf(control),
  };
}

export function restoreControlFocus(
  focus: ControlFocus | null,
  controls: readonly HTMLElement[],
): HTMLElement | null {
  if (!focus) return null;
  const matches = controls.filter((control) => controlFocusKey(control) === focus.key);
  return matches[focus.index] ?? matches.at(-1) ?? null;
}

export function findPrimaryEditorControl(
  controls: readonly HTMLElement[],
): HTMLElement | null {
  return controls.find((control) => control.dataset.queryFocus === "true") ??
    controls.find((control) => control.dataset.queryPrimary === "true") ??
    controls.find((control) => control.getAttribute("aria-label") === "字段") ??
    controls[0] ?? null;
}

function button(label: string, className = ""): HTMLButtonElement {
  const result = document.createElement("button");
  result.type = "button";
  result.className = className;
  result.textContent = label;
  return result;
}

function scopeChoiceButton(owner: Owner): HTMLButtonElement {
  const result = button("", "query-choice-chip query-scope-choice");
  result.dataset.owner = owner;
  const check = document.createElement("span");
  check.className = "query-scope-check";
  check.textContent = "✓";
  check.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = OWNER_LABEL[owner];
  result.append(check, label);
  return result;
}

/** 建议行标题:类型色点 + 名称,色点与星图节点用同一套类型色。 */
function suggestionTitle(owner: Owner, label: string): HTMLDivElement {
  const result = document.createElement("div");
  result.className = "query-suggestion-title";
  result.dataset.owner = owner;
  const mark = document.createElement("i");
  mark.className = "query-owner-mark";
  mark.setAttribute("aria-hidden", "true");
  const name = document.createElement("strong");
  name.textContent = label;
  result.append(mark, name);
  return result;
}

function iconButton(
  icon: QueryIconName,
  label: string,
  className = "",
  title = label,
): HTMLButtonElement {
  const result = button("", className);
  setQueryIconButton(result, icon, label, title);
  return result;
}

function option(value: string, label: string): HTMLOptionElement {
  const result = document.createElement("option");
  result.value = value;
  result.textContent = label;
  return result;
}

function select(label: string): HTMLSelectElement {
  const result = document.createElement("select");
  result.id = `query-popover-control-${++queryControlSequence}`;
  result.className = "query-popover-control";
  result.setAttribute("aria-label", label);
  return result;
}

function input(label: string, type = "text"): HTMLInputElement {
  const result = document.createElement("input");
  result.id = `query-popover-control-${++queryControlSequence}`;
  result.className = "query-popover-control";
  result.type = type;
  result.autocomplete = "off";
  result.setAttribute("aria-label", label);
  return result;
}

export function createQueryNameInput(): HTMLInputElement {
  const result = input("按名称、中文名或别名查找");
  result.className = "query-name-input";
  return result;
}

function labeled(label: string, control: HTMLElement): HTMLLabelElement {
  const wrapper = document.createElement("label");
  wrapper.className = "query-popover-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  wrapper.append(caption, control);
  return wrapper;
}

function cloneCondition(condition: ExplorerCondition): ExplorerCondition {
  return JSON.parse(JSON.stringify(condition)) as ExplorerCondition;
}

function positiveCondition(condition: Extract<ExplorerCondition, { kind: "compare" }>): ExplorerCondition {
  const { negated: _negated, ...positive } = condition;
  return positive;
}

function editCondition(condition: ExplorerCondition): EditCondition {
  if (condition.kind === "all" || condition.kind === "any")
    return { kind: condition.kind, terms: condition.terms.map(editCondition) };
  if (condition.kind === "not")
    return { kind: "not", terms: [editCondition(condition.term)] };
  const editable = conditionEditValue(condition);
  if (editable) return { kind: "leaf", ...editable };
  if (condition.kind === "compare" && condition.negated)
    return { kind: "not", terms: [editCondition(positiveCondition(condition))] };
  throw new TypeError("这个条件无法在当前界面中编辑");
}

function conditionFromEdit(node: EditCondition, config: LeafConfig): ExplorerCondition {
  if (node.kind === "leaf")
    return config.create(node.field, node.operator, node.raw);
  if (!node.terms.length) throw new TypeError("条件组不能为空");
  const terms = node.terms.map((term) => conditionFromEdit(term, config));
  if (node.kind === "not") {
    if (terms.length !== 1) throw new TypeError("排除条件只能包含一个条件");
    return { kind: "not", term: terms[0]! };
  }
  return { kind: node.kind, terms };
}

export function createConditionEditRoot(
  condition: ExplorerCondition | undefined,
): EditCondition {
  if (!condition) return { kind: "all", terms: [] };
  const edit = editCondition(condition);
  return edit.kind === "leaf" ? { kind: "all", terms: [edit] } : edit;
}

export function conditionEditFocusTerm(
  root: EditCondition,
  index: number,
): EditCondition | undefined {
  if (index < 0) return undefined;
  if (root.kind === "all" || root.kind === "any") return root.terms[index];
  return index === 0 ? root : undefined;
}

export function finishConditionEdit(
  root: EditCondition,
  config: LeafConfig,
): ExplorerCondition | undefined {
  if (root.kind === "all" && !root.terms.length) return undefined;
  const condition = conditionFromEdit(root, config);
  return condition.kind === "all" ? combineConditions(condition.terms) : condition;
}

export function createDefaultConditionEdit(config: {
  fields(): string[];
  operators(field: string): string[];
  values(field: string): Record<string, string> | null;
}, preferredField?: string): Extract<EditCondition, { kind: "leaf" }> {
  const fields = config.fields();
  const field = preferredField && fields.includes(preferredField)
    ? preferredField
    : fields[0] ?? "";
  const operator = config.operators(field)[0] ?? "";
  const values = isNoValueOperator(operator) ? null : config.values(field);
  return {
    kind: "leaf",
    field,
    operator,
    raw: values ? resolveSingleChoiceValue("", values) : "",
  };
}

export function resolveSingleChoiceValue(
  value: string,
  choices: Record<string, string>,
): string {
  return Object.prototype.hasOwnProperty.call(choices, value)
    ? value
    : Object.keys(choices)[0] ?? "";
}

function literalCount(text: string): number {
  return [...text.trim()].length;
}

function isNoValueOperator(operator: string): boolean {
  return operator === "isNull" || operator === "isNotNull" ||
    operator === "isMissing" || operator === "isPresent";
}

function isMultiValueOperator(operator: string): boolean {
  return operator === "in" || operator === "notIn";
}

export function conditionValueInputType(
  inputType: QueryScalarInputType,
  operator: string,
): QueryScalarInputType {
  return isMultiValueOperator(operator) ? "text" : inputType;
}

export function conditionValueInputStep(
  inputType: QueryScalarInputType,
  operator: string,
): string | null {
  return conditionValueInputType(inputType, operator) === "number" ? "any" : null;
}

function refOwner(ref: EntityRef): Owner {
  return parseEntityRef(ref).owner;
}

export function conditionEntityRefs(
  owner: Owner,
  condition: ExplorerCondition | undefined,
): EntityRef[] {
  if (!condition) return [];
  if ("terms" in condition)
    return condition.terms.flatMap((term) => conditionEntityRefs(owner, term));
  if (condition.kind === "not") return conditionEntityRefs(owner, condition.term);
  const field = condition.field;
  const referenceOwner = queryReferenceOwner(owner, field);
  if (!referenceOwner) return [];
  const values = condition.kind === "compare"
    ? [condition.value]
    : condition.kind === "in" ? condition.values : [];
  return values.flatMap((value) => {
    if (typeof value !== "string") return [];
    try {
      return parseEntityRef(value).owner === referenceOwner
        ? [value as EntityRef]
        : [];
    } catch {
      return [];
    }
  });
}

export function createQueryTokenControl(
  item: QueryToken,
  actions: { edit(): void; remove(): void },
): HTMLElement {
  if (!item.editable) {
    const result = document.createElement("span");
    result.className = `query-token query-token-${item.kind}`;
    result.textContent = item.label;
    return result;
  }

  const token = button(
    item.label,
    `query-token query-token-${item.kind}${item.removable ? " query-token-removable" : ""}`,
  );
  token.dataset.token = item.id;
  token.setAttribute(
    "aria-label",
    `${item.label}，按回车编辑${item.removable ? "，按删除键移除" : ""}`,
  );
  token.addEventListener("click", actions.edit);
  token.addEventListener("keydown", (event) => {
    if ((event.key === "Backspace" || event.key === "Delete") && item.removable) {
      event.preventDefault();
      actions.remove();
    }
  });
  if (!item.removable) return token;

  const shell = document.createElement("span");
  shell.className = "query-token-shell";
  const remove = iconButton(
    "close",
    `删除：${item.label}`,
    "query-token-remove",
    "删除",
  );
  remove.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    actions.remove();
  });
  shell.append(token, remove);
  return shell;
}

export function findQueryTokenButton(element: Element | null): HTMLElement | null {
  if (!element) return null;
  if (element.matches(".query-token")) return element as HTMLElement;
  return element.querySelector<HTMLElement>(".query-token");
}

export function tokenFocusIndexAfterRemoval(
  removedIndex: number,
  remainingCount: number,
): number {
  if (remainingCount <= 0) return -1;
  return Math.min(Math.max(0, removedIndex), remainingCount - 1);
}

export function shouldSyncQueryInput(
  isFocused: boolean,
  value: string,
  force = false,
): boolean {
  return force || !isFocused || value.startsWith("/");
}

export function visibleNameAction(
  draft: QueryDraft,
  value: string,
): QueryAction | null {
  if (draft.kind !== "list" && draft.kind !== "aggregate") return null;
  const query = draftQuery(draft);
  if (!query) return null;
  if (queryInputValue(draft) === value) return null;
  return {
    type: "setText",
    text: value.trim() ? { value, capability: "lookup" } : undefined,
  };
}

export function createSortTerm(
  column: string,
  owners?: readonly Owner[],
): ScopedOrderTerm {
  const direction = defaultSortDirection(column);
  return {
    column,
    ...(owners?.length ? { owners: [...owners] } : {}),
    direction,
    nulls: owners?.length ? "last" : direction === "asc" ? "first" : "last",
  };
}

export function sortTermWithDirection(
  order: ScopedOrderTerm,
  direction: "asc" | "desc",
): ScopedOrderTerm {
  return {
    ...order,
    direction,
    nulls: order.owners?.length ? "last" : direction === "asc" ? "first" : "last",
  };
}

export function createSortTermForChoice(
  choice: QuerySortChoice,
  scope: readonly Owner[],
): ScopedOrderTerm {
  return createSortTerm(
    choice.field,
    sameOwnerScope(choice.owners, scope) ? undefined : choice.owners,
  );
}

function scopedSortTermId(
  order: ScopedOrderTerm,
  scope: readonly Owner[],
): string {
  return `${(order.owners ?? scope).join("+")}:${order.column}`;
}

export function applyOrderAndLimit(
  draft: QueryDraft,
  orderBy: ScopedOrderTerm[] | undefined,
  limit: number | undefined,
): QueryDraft {
  return applyQueryAction(
    applyQueryAction(draft, { type: "setOrder", orderBy }),
    { type: "setLimit", limit },
  );
}

export function queryPanelMaxHeight(
  panelTop: number,
  viewportHeight: number,
  cssMaxHeight: number,
  margin: number,
): number {
  return Math.max(
    0,
    Math.min(cssMaxHeight, viewportHeight - panelTop - margin),
  );
}

export class QueryBar {
  readonly dom = document.createElement("div");
  private readonly line = document.createElement("div");
  private readonly tokens = document.createElement("span");
  private readonly commandGroup = document.createElement("span");
  private readonly inputGroup = document.createElement("span");
  private readonly text = createQueryNameInput();
  private readonly add = iconButton("plus", "添加查询内容", "query-add");
  private readonly submit = iconButton("search", "执行查询", "query-submit");
  private readonly panel = document.createElement("section");
  private readonly panelTitle = document.createElement("h2");
  private readonly panelBody = document.createElement("div");
  private readonly panelBack = iconButton("back", "返回上一页", "query-popover-back");
  private readonly panelClose = iconButton("close", "关闭查询面板", "query-popover-close");
  private history: QueryHistory;
  private mappings: Mappings | undefined;
  private composing = false;
  private nameIndex = -1;
  private suggestionController: AbortController | null = null;
  private suggestionTimer: ReturnType<typeof setTimeout> | null = null;
  private suggestionListSerial = 0;
  private panelReturnFocus: HTMLElement | null = null;
  private panelBackAction: (() => void) | null = null;
  private readonly labels = new Map<string, string>();
  private readonly valueAutocompleteCleanups = new Set<() => void>();
  private runState: QueryRunState = {
    running: false,
    runnable: true,
  };
  private readonly fitPanelToViewport = (): void => {
    if (this.panel.hidden) return;
    const view = this.panel.ownerDocument.defaultView;
    if (!view) return;
    this.panel.style.maxHeight = "";
    const panelStyle = view.getComputedStyle(this.panel);
    const pageInset = Number.parseFloat(
      view.getComputedStyle(this.dom).getPropertyValue("--page-inset"),
    ) || 0;
    const maxHeight = queryPanelMaxHeight(
      this.panel.getBoundingClientRect().top,
      view.innerHeight,
      Number.parseFloat(panelStyle.maxHeight),
      pageInset,
    );
    this.panel.style.maxHeight = `${maxHeight}px`;
  };

  constructor(private readonly options: QueryBarOptions) {
    this.history = createQueryHistory(options.draft);
    this.dom.className = "query-bar";
    this.line.className = "query-bar-line";
    this.tokens.className = "query-token-run";
    this.commandGroup.className = "query-command-group";
    this.inputGroup.className = "query-input-group";
    this.text.name = "query-command";
    this.text.setAttribute("role", "combobox");
    this.text.setAttribute("aria-autocomplete", "list");
    this.text.setAttribute("aria-haspopup", "listbox");
    this.text.setAttribute("aria-expanded", "false");
    this.add.setAttribute("aria-haspopup", "dialog");
    this.add.setAttribute("aria-expanded", "false");

    this.panel.className = "query-popover";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "查询面板");
    const panelHeader = document.createElement("header");
    this.panelBack.hidden = true;
    panelHeader.append(this.panelBack, this.panelTitle, this.panelClose);
    this.panel.append(panelHeader, this.panelBody);
    this.inputGroup.append(this.text, this.add);
    this.commandGroup.append(this.inputGroup, this.submit);
    this.line.append(this.tokens, this.commandGroup);
    this.dom.append(this.line, this.panel);

    this.text.addEventListener("compositionstart", () => this.composing = true);
    this.text.addEventListener("compositionend", () => {
      this.composing = false;
      this.textChanged();
    });
    this.text.addEventListener("input", () => {
      if (!this.composing) this.textChanged();
    });
    this.text.addEventListener("keydown", (event) => this.inputKeydown(event));
    this.add.addEventListener("click", () => {
      this.closePanel();
      this.openAddPicker();
    });
    this.submit.addEventListener("click", () => {
      this.closePanel();
      this.activateSubmit();
    });
    this.panelClose.addEventListener("click", () => {
      this.closePanel(true);
    });
    this.panelBack.addEventListener("click", () => {
      this.panelBackAction?.();
    });
    this.line.addEventListener("pointerdown", (event) => {
      if (
        event.target !== this.line && event.target !== this.tokens &&
        event.target !== this.inputGroup
      ) return;
      event.preventDefault();
      this.focus();
    });
    this.dom.addEventListener("keydown", (event) => this.keydown(event));
    document.addEventListener("pointerdown", (event) => {
      if (!this.panel.hidden && !this.dom.contains(event.target as Node))
        this.closePanel();
    });
    document.defaultView?.addEventListener("resize", this.fitPanelToViewport);

    this.render();
    this.setExecutionState(this.runState);
    void options.mappings?.().then((mappings) => {
      this.mappings = mappings;
      this.renderTokens();
    }).catch(options.reportError);
  }

  current(): QueryDraft {
    return this.history.current;
  }

  replace(draft: QueryDraft): void {
    this.history = createQueryHistory(draft);
    this.closePanel();
    this.render(true);
  }

  focus(): void {
    this.trailingFocusTarget().focus();
  }

  private trailingFocusTarget(): HTMLElement {
    if (!this.text.hidden) return this.text;
    if (!this.add.hidden) return this.add;
    return this.submit;
  }

  setExecutionState(state: QueryRunState): void {
    this.runState = { ...state };
    const presentation = queryRunPresentation(state);
    setQueryIconButton(this.submit, presentation.icon, presentation.ariaLabel);
    this.submit.setAttribute("aria-busy", String(presentation.busy));
    this.submit.disabled = presentation.disabled;
  }

  dismissCompletion(): boolean {
    if (this.panel.hidden) return false;
    this.text.value = queryInputValue(this.history.current);
    this.closePanel(true);
    return true;
  }

  dispatch(action: QueryAction, mergeKey: string | null = null): void {
    try {
      compileQueryDraft(applyQueryAction(this.history.current, action));
      const next = updateQueryHistory(this.history, action, mergeKey);
      if (next === this.history) return;
      this.history = next;
      this.render();
      this.options.onChange(this.history.current);
    } catch (error) {
      this.options.reportError(error);
    }
  }

  private commitPanelAction(action: QueryAction): void {
    this.synchronizeNameInput();
    this.closePanel();
    this.dispatch(action);
    this.focus();
  }

  private commitPanelDraft(update: (draft: QueryDraft) => QueryDraft): void {
    try {
      this.synchronizeNameInput();
      const draft = update(this.history.current);
      this.closePanel();
      this.dispatch({ type: "replace", draft });
      this.focus();
    } catch (error) {
      this.options.reportError(error);
    }
  }

  private synchronizeNameInput(): void {
    const action = visibleNameAction(this.history.current, this.text.value);
    if (action) this.dispatch(action, "name");
  }

  undo(): boolean {
    const next = undoQueryHistory(this.history);
    if (next === this.history) return false;
    this.history = next;
    this.closePanel();
    this.render(true);
    this.options.onChange(this.history.current);
    return true;
  }

  redo(): boolean {
    const next = redoQueryHistory(this.history);
    if (next === this.history) return false;
    this.history = next;
    this.closePanel();
    this.render(true);
    this.options.onChange(this.history.current);
    return true;
  }

  private render(forceInput = false): void {
    this.renderTokens();
    const expected = queryInputValue(this.history.current);
    const query = draftQuery(this.history.current);
    const hasNameInput = query !== null;
    if (!hasNameInput || shouldSyncQueryInput(
      document.activeElement === this.text,
      this.text.value,
      forceInput,
    )) this.text.value = expected;
    this.text.hidden = !hasNameInput;
    const hasAddableFragments = queryAddChoices(this.history.current).length > 0;
    this.add.hidden = !hasAddableFragments;
    this.inputGroup.hidden = !hasNameInput && !hasAddableFragments;
    this.commandGroup.classList.toggle(
      "query-command-group-action-only",
      this.inputGroup.hidden,
    );
    this.inputGroup.classList.toggle("query-input-group-action-only", !hasNameInput);
    this.text.placeholder = hasNameInput
      ? "按名称查找"
      : "";
    this.text.setAttribute(
      "aria-label",
      hasNameInput ? "按名称、中文名或别名查找" : "当前查询不接受名称查找",
    );
  }

  private renderTokens(): void {
    const tokens = queryTokens(this.history.current, {
      mappings: this.mappings,
      entityLabel: (ref) => this.labels.get(ref),
    });
    this.tokens.replaceChildren(...tokens.map((item) => this.tokenButton(item)));
    this.resolveTokenEntities();
    this.fitPanelToViewport();
  }

  private tokenButton(item: QueryToken): HTMLElement {
    return createQueryTokenControl(item, {
      edit: () => {
        this.closePanel();
        this.editToken(item);
      },
      remove: () => {
        const before = [...this.tokens.querySelectorAll<HTMLElement>(".query-token")];
        const removedIndex = before.findIndex((token) => token.dataset.token === item.id);
        this.closePanel();
        this.removeToken(item);
        const remaining = [...this.tokens.querySelectorAll<HTMLElement>(".query-token")];
        const focusIndex = tokenFocusIndexAfterRemoval(removedIndex, remaining.length);
        if (focusIndex >= 0) remaining[focusIndex]?.focus();
        else this.focus();
      },
    });
  }

  private resolveTokenEntities(): void {
    if (!this.options.resolveEntityLabel) return;
    const draft = this.history.current;
    const query = draftQuery(draft);
    const owner = draftOwner(draft);
    const refs: EntityRef[] = draft.kind === "comparison" || draft.kind === "path"
      ? [draft.from, draft.to]
      : [
          ...(owner ? conditionEntityRefs(owner, query?.condition) : []),
          ...(query?.relations ?? []).flatMap((relation) => [
            relation.related,
            ...(relation.additionalEndpoints ?? []).map((endpoint) => endpoint.related),
          ]),
        ];
    for (const ref of new Set(refs)) {
      if (this.labels.has(ref)) continue;
      this.labels.set(ref, "读取名称…");
      void this.options.resolveEntityLabel(ref).then((label) => {
        this.labels.set(ref, label);
        this.renderTokens();
      }).catch((error) => {
        this.labels.delete(ref);
        this.options.reportError(error);
      });
    }
  }

  private textChanged(): void {
    const committed = queryInputValue(this.history.current);
    if (isActionShortcut(this.text.value, committed)) {
      this.text.value = committed;
      this.openAddPicker();
      return;
    }
    this.closePanel();
    const draft = this.history.current;
    if (draft.kind !== "list" && draft.kind !== "aggregate") return;
    const value = this.text.value;
    this.dispatch({
      type: "setText",
      text: value.trim() ? { value, capability: "lookup" } : undefined,
    }, "name");
    this.requestNameSuggestions(value);
  }

  private inputKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const panelKind = this.panelBody.dataset.kind;
    if (!this.panel.hidden && panelKind === "names") {
      const choices = [...this.panelBody.querySelectorAll<HTMLButtonElement>("[role=option]")];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.nameIndex = moveSuggestionIndex(this.nameIndex, choices.length, event.key);
        this.syncActiveName(choices, true);
        return;
      }
      if (event.key === "Enter" && choices[this.nameIndex]) {
        event.preventDefault();
        choices[this.nameIndex]!.click();
        return;
      }
      if (
        event.key === "Enter" && this.nameIndex < 0 &&
        literalCount(this.text.value) < QUERY_CONTRACT.search.lookup.minNormalizedCharacters
      ) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.closePanel();
      this.activateSubmit();
      return;
    }
    if (
      (event.key === "Backspace" || event.key === "ArrowLeft") &&
      this.text.selectionStart === 0 &&
      this.text.selectionEnd === 0 && !this.text.value
    ) {
      const previous = findQueryTokenButton(this.tokens.lastElementChild);
      if (previous) {
        event.preventDefault();
        previous.focus();
      }
    }
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing || event.defaultPrevented) return;
    if (event.key === "Escape" && !this.panel.hidden) {
      event.preventDefault();
      this.text.value = queryInputValue(this.history.current);
      if (this.panelBackAction) this.panelBackAction();
      else this.closePanel(true);
      return;
    }
    const token = event.target instanceof HTMLElement && event.target.matches(".query-token")
      ? event.target
      : null;
    if (token && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const tokens = [...this.tokens.querySelectorAll<HTMLElement>(".query-token")];
      const index = tokens.indexOf(token);
      const target = event.key === "ArrowLeft"
        ? tokens[index - 1]
        : tokens[index + 1] ?? this.trailingFocusTarget();
      if (target) {
        event.preventDefault();
        target.focus();
      }
      return;
    }
    const modified = event.metaKey || event.ctrlKey;
    if (modified && event.key.toLowerCase() === "z") {
      if (event.shiftKey ? this.redo() : this.undo()) event.preventDefault();
    } else if (modified && event.key.toLowerCase() === "y") {
      if (this.redo()) event.preventDefault();
    }
  }

  private activateSubmit(): void {
    if (this.runState.running) this.options.onCancel();
    else if (this.runState.runnable) this.options.onSubmit();
  }

  private openPanel(
    title: string,
    renderer: PanelRenderer,
    kind = "editor",
    back?: () => void,
  ): void {
    const controlSelector =
      "input:not([hidden]):not([disabled]), select:not([hidden]):not([disabled]), " +
      "button:not([hidden]):not([disabled])";
    const active = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (this.panel.hidden) this.panelReturnFocus = active;
    const previousFocus = captureControlFocus(
      document.activeElement,
      [...this.panelBody.querySelectorAll<HTMLElement>(controlSelector)],
    );
    this.clearValueAutocompletes();
    this.cancelSuggestions();
    this.panelBackAction = back ?? null;
    this.panelBack.hidden = !back;
    this.panelTitle.textContent = title;
    this.panelBody.dataset.kind = kind;
    this.panelBody.id ||= `query-bar-options-${++queryBarSequence}`;
    this.panel.id ||= `${this.panelBody.id}-panel`;
    this.panelTitle.id ||= `${this.panelBody.id}-title`;
    this.text.setAttribute("aria-controls", this.panelBody.id);
    const listboxOpen = kind === "names";
    this.add.setAttribute("aria-controls", listboxOpen ? this.panelBody.id : this.panel.id);
    if (kind === "editor") {
      this.panel.setAttribute("role", "dialog");
      this.panel.setAttribute("aria-labelledby", this.panelTitle.id);
    } else {
      this.panel.removeAttribute("role");
      this.panel.removeAttribute("aria-labelledby");
    }
    this.text.setAttribute("aria-expanded", String(listboxOpen));
    this.add.setAttribute("aria-expanded", String(this.panelReturnFocus === this.add));
    if (!listboxOpen) this.text.removeAttribute("aria-activedescendant");
    this.panelBody.className = "";
    this.panelBody.removeAttribute("role");
    this.panelBody.replaceChildren();
    renderer(this.panelBody);
    this.panel.hidden = false;
    this.fitPanelToViewport();
    if (kind === "editor") queueMicrotask(() => {
      if (this.panel.hidden || this.panel.contains(document.activeElement)) return;
      const controls = [...this.panelBody.querySelectorAll<HTMLElement>(controlSelector)];
      const preferred = restoreControlFocus(previousFocus, controls);
      (preferred ?? findPrimaryEditorControl(controls))?.focus();
    });
  }

  private closePanel(restoreFocus = false): void {
    const returnFocus = this.panelReturnFocus;
    this.panelReturnFocus = null;
    this.panelBackAction = null;
    this.panelBack.hidden = true;
    this.clearValueAutocompletes();
    this.cancelSuggestions();
    this.panel.hidden = true;
    this.panelBody.replaceChildren();
    delete this.panelBody.dataset.kind;
    this.text.setAttribute("aria-expanded", "false");
    this.add.setAttribute("aria-expanded", "false");
    this.text.removeAttribute("aria-activedescendant");
    if (restoreFocus && returnFocus?.isConnected && !returnFocus.hidden)
      returnFocus.focus();
  }

  private openAddPicker(): void {
    const choices = queryAddChoices(this.history.current);
    if (!choices.length) {
      this.options.reportError(new TypeError("当前查询没有可添加的条件"));
      return;
    }
    this.openPanel("添加", (body) => {
      const list = document.createElement("div");
      list.className = "query-add-list";
      list.id = `${this.panelBody.id}-add-list`;
      list.append(...choices.map((choice) => {
        const control = button(
          "",
          choice.kind === "condition"
            ? "query-add-choice query-add-choice-condition"
            : "query-add-choice",
        );
        const label = document.createElement("strong");
        label.textContent = choice.label;
        control.append(label);
        if (choice.detail) {
          const detail = document.createElement("span");
          if (choice.kind === "condition") detail.className = "query-choice-scope";
          detail.textContent = choice.detail;
          control.append(detail);
        }
        control.addEventListener("click", () => this.activateAddChoice(choice));
        return control;
      }));
      list.addEventListener("keydown", (event) => {
        if (!(event.target instanceof HTMLButtonElement)) return;
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const controls = [...list.querySelectorAll<HTMLButtonElement>("button")];
        const index = controls.indexOf(event.target);
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const next = controls[index + offset];
        if (!next) return;
        event.preventDefault();
        next.focus();
      });
      body.append(list);
    });
  }

  private activateAddChoice(choice: QueryAddChoice): void {
    const backToAdd = () => this.openAddPicker();
    if (choice.kind === "condition") {
      this.openNewEntityCondition(choice.owners, choice.field, backToAdd);
    } else if (choice.kind === "relation") {
      this.openRelationEditor(undefined, undefined, choice.owner, backToAdd);
    } else if (choice.kind === "fullText") {
      this.openBodyTextEditor(backToAdd);
    } else if (choice.kind === "columns") {
      this.openColumnsEditor(backToAdd);
    } else if (choice.kind === "sort") {
      this.openSortEditor(backToAdd);
    }
  }

  private requestNameSuggestions(value: string): void {
    const text = value.trim();
    const owners = queryNameSuggestionOwners(this.history.current);
    if (!text || !owners.length || !this.options.suggestNames || !this.options.onNameSuggestion) {
      this.closePanel();
      return;
    }
    this.nameIndex = -1;
    this.openPanel("名称建议", (body) => {
      body.className = "query-name-suggestions";
      body.setAttribute("role", "listbox");
      const loading = document.createElement("p");
      loading.className = "query-popover-hint";
      loading.setAttribute("role", "status");
      loading.textContent = "正在查找名称…";
      body.append(loading);
    }, "names");
    const controller = new AbortController();
    this.suggestionController = controller;
    this.suggestionTimer = setTimeout(() => {
      this.suggestionTimer = null;
      void this.options.suggestNames!(text, owners, controller.signal).then((items) => {
        if (
          controller.signal.aborted || this.suggestionController !== controller ||
          this.text.value.trim() !== text
        ) return;
        this.renderNameSuggestions(items, text);
      }).catch((error) => {
        if (controller.signal.aborted || this.suggestionController !== controller) return;
        this.renderNameSuggestionError(text, error);
      });
    }, 90);
  }

  private renderNameSuggestions(items: readonly NameSuggestion[], text: string): void {
    const body = this.panelBody;
    body.className = "query-name-suggestions";
    body.setAttribute("role", "listbox");
    body.replaceChildren();
    this.nameIndex = -1;
    items.forEach((item, index) => {
      const choice = button("", "query-name-suggestion");
      choice.setAttribute("role", "option");
      choice.setAttribute("aria-selected", "false");
      choice.id = `${body.id}-name-${index}`;
      const detail = document.createElement("span");
      detail.textContent = item.match && item.match !== item.label
        ? `${item.detail ?? OWNER_LABEL[item.owner]} · 匹配：${item.match}`
        : item.detail ?? OWNER_LABEL[item.owner];
      choice.append(suggestionTitle(item.owner, item.label), detail);
      choice.addEventListener("pointermove", () => {
        this.nameIndex = index;
        this.syncActiveName(
          [...body.querySelectorAll<HTMLButtonElement>("[role=option]")],
        );
      });
      choice.addEventListener("pointerdown", (event) => event.preventDefault());
      choice.addEventListener("click", () => {
        this.closePanel();
        this.options.onNameSuggestion?.(item);
      });
      body.append(choice);
    });
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "query-popover-empty";
      empty.textContent = "没有名称建议";
      body.append(empty);
    }
    if (literalCount(text) < QUERY_CONTRACT.search.lookup.minNormalizedCharacters) {
      const hint = document.createElement("p");
      hint.className = "query-popover-hint";
      hint.textContent = "名称至少需要两个字";
      body.append(hint);
    }
    this.syncActiveName(
      [...body.querySelectorAll<HTMLButtonElement>("[role=option]")],
    );
  }

  private renderNameSuggestionError(text: string, _error: unknown): void {
    this.panelBody.replaceChildren();
    this.panelBody.className = "query-name-suggestions";
    this.panelBody.setAttribute("role", "listbox");
    const message = document.createElement("p");
    message.className = "query-popover-error";
    message.setAttribute("role", "status");
    message.textContent = "名称建议暂时不可用，请检查网络后重试";
    const retry = button("重试", "query-secondary");
    retry.addEventListener("click", () => {
      this.requestNameSuggestions(text);
      this.text.focus();
    });
    this.panelBody.append(message, retry);
  }

  private syncActiveName(choices: HTMLButtonElement[], scroll = false): void {
    choices.forEach((choice, index) => {
      const active = index === this.nameIndex;
      choice.classList.toggle("active", active);
      choice.setAttribute("aria-selected", String(active));
      if (active && scroll) choice.scrollIntoView({ block: "nearest" });
    });
    const active = choices[this.nameIndex];
    if (active) this.text.setAttribute("aria-activedescendant", active.id);
    else this.text.removeAttribute("aria-activedescendant");
  }

  private editToken(item: QueryToken): void {
    switch (item.target.type) {
      case "owner":
        this.openOwnerEditor();
        break;
      case "text":
        if (this.history.current.kind === "list" && !this.history.current.query)
          this.openAllTextEditor();
        else this.openBodyTextEditor();
        break;
      case "condition":
        this.openEntityConditions(undefined, item.target.index);
        break;
      case "relation":
        this.openRelationEditor(item.target.index);
        break;
      case "columns":
        this.openColumnsEditor();
        break;
      case "aggregate":
      case "having":
        this.openAggregateEditor();
        break;
      case "order":
        this.openSortEditor();
        break;
      case "limit":
        this.openSortEditor();
        break;
      case "maxHops":
      case "maxPaths":
        this.openPathLimitEditor();
        break;
      case "endpoint": {
        const draft = this.history.current;
        if (draft.kind !== "comparison" && draft.kind !== "path") return;
        const endpoint = item.target.endpoint;
        this.openEntityPicker(
          endpoint === "from" ? "选择第一个条目" : "选择第二个条目",
          ["subject", "person", "character"],
          (entity) => {
            this.labels.set(entity.ref, entity.label);
            const from = endpoint === "from" ? entity.ref : draft.from;
            const to = endpoint === "to" ? entity.ref : draft.to;
            this.commitPanelAction(draft.kind === "path"
              ? {
                  type: "setPath", from, to,
                  maxHops: draft.maxHops, maxPaths: draft.maxPaths,
                }
              : { type: "setComparison", from, to });
          },
        );
        break;
      }
      case "comparisonMode":
        break;
    }
  }

  private removeToken(item: QueryToken): void {
    switch (item.target.type) {
      case "text":
        if (this.history.current.kind === "list" && !this.history.current.query)
          this.dispatch({ type: "setList" });
        else this.dispatch({ type: "setFullText", fullText: undefined });
        break;
      case "condition":
        this.dispatch({ type: "removeCondition", index: item.target.index });
        break;
      case "relation":
        this.dispatch({ type: "removeRelation", index: item.target.index });
        break;
      case "columns":
        this.dispatch({ type: "setColumns", columns: undefined });
        break;
      case "order":
        this.dispatch({
          type: "replace",
          draft: applyOrderAndLimit(this.history.current, undefined, undefined),
        });
        break;
      case "limit":
        this.dispatch({ type: "setLimit", limit: undefined });
        break;
      case "having": {
        const draft = this.history.current;
        if (draft.kind === "aggregate")
          this.dispatch({
            type: "setAggregate",
            aggregate: { ...draft.query.aggregate, having: undefined },
          });
        break;
      }
      default:
        break;
    }
  }

  private openOwnerEditor(): void {
    this.openPanel("查找范围", (body) => {
      body.className = "query-choice-row";
      this.appendScopeChoices(body);
    });
  }

  private appendScopeChoices(body: HTMLElement): void {
    const draft = this.history.current;
    if (draft.kind === "aggregate") {
      for (const owner of ENTITY_SCOPE_ORDER) {
        const choice = scopeChoiceButton(owner);
        choice.setAttribute("aria-pressed", String(draft.query.owner === owner));
        const action: QueryAction = { type: "setOwner", owner };
        try {
          applyQueryAction(draft, action);
        } catch (error) {
          choice.disabled = true;
          choice.title = error instanceof Error ? error.message : "与当前查询不兼容";
        }
        choice.addEventListener("click", () => this.commitPanelAction(action));
        body.append(choice);
      }
      return;
    }

    if (draft.kind !== "list" || !draft.query) return;
    const controls = ENTITY_SCOPE_ORDER.map((owner) => {
      const choice = scopeChoiceButton(owner);
      body.append(choice);
      return { owner, choice };
    });
    const refresh = (): void => {
      const currentDraft = this.history.current;
      const current = draftScope(currentDraft);
      if (!current) return;
      for (const { owner, choice } of controls) {
        const selected = current.includes(owner);
        choice.setAttribute("aria-pressed", String(selected));
        choice.disabled = false;
        choice.title = "";
        if (selected && current.length === 1) {
          choice.disabled = true;
          choice.title = "至少选择一种实体";
          continue;
        }
        try {
          const scope = toggleEntityScope(current, owner);
          applyQueryAction(currentDraft, { type: "setScope", scope });
        } catch (error) {
          choice.disabled = true;
          choice.title = error instanceof Error ? error.message : "与当前查询不兼容";
        }
      }
    };
    for (const { owner, choice } of controls) {
      choice.addEventListener("click", () => {
        this.synchronizeNameInput();
        const current = draftScope(this.history.current);
        if (!current) return;
        try {
          this.dispatch({ type: "setScope", scope: toggleEntityScope(current, owner) });
        } catch (error) {
          this.options.reportError(error);
        } finally {
          refresh();
        }
      });
    }
    refresh();
  }

  private openBodyTextEditor(back?: () => void): void {
    const query = draftQuery(this.history.current);
    const scope = draftScope(this.history.current);
    if (!query || !scope) return;
    const label = scopedFullTextLabel(scope);
    const leaf: Extract<EditCondition, { kind: "leaf" }> = {
      kind: "leaf",
      field: "body",
      operator: "contains",
      raw: query.fullText?.value ?? "",
    };
    this.openConditionEditor(
      label,
      leaf,
      this.textLeafConfig("body", label),
      () => this.commitPanelAction(createScopedFullTextAction(leaf.raw)),
      back,
      {
        compact: true,
        submitLabel: "应用",
      },
    );
  }

  private openAllTextEditor(): void {
    const draft = this.history.current;
    if (draft.kind !== "list" || draft.query) return;
    const leaf: Extract<EditCondition, { kind: "leaf" }> = {
      kind: "leaf",
      field: "allText",
      operator: "contains",
      raw: draft.allText,
    };
    this.openConditionEditor(
      "搜索所有正文",
      leaf,
      this.textLeafConfig("allText", "所有正文与关系备注"),
      () => this.commitPanelAction({
        type: "setAllText",
        text: normalizeFullTextValue(leaf.raw),
      }),
      undefined,
      { compact: true, submitLabel: "应用" },
    );
  }

  private textLeafConfig(field: string, label: string): LeafEditorConfig {
    return {
      fields: () => [field],
      fieldLabel: () => label,
      operators: () => ["contains"],
      operatorLabel: () => "包含",
      values: () => null,
      inputType: () => "text",
    };
  }

  private entityLeafConfig(
    owners: readonly Owner[],
    restoredFields: readonly string[] = [],
  ): LeafConfig {
    const owner = owners[0];
    if (!owner) throw new TypeError("至少选择一种实体");
    return {
      fields: () => queryEditorFilterFields(owners, restoredFields),
      fieldLabel: (field) => FIELD_LABEL[field] ?? field,
      operators: (field) => queryConditionOperators(owner, field),
      operatorLabel: (field, operator) =>
        queryConditionOperatorLabel(owner, field, operator),
      values: (field) => enumValuesFor(owner, field, this.mappings),
      suggestions: (field) => {
        const vocabularyField = tagVocabularyField(owner, field);
        return vocabularyField && this.options.suggestTagValues
          ? (text, signal) =>
              this.options.suggestTagValues!(vocabularyField, text, signal)
          : null;
      },
      featuredValues: (field) =>
        featuredMetaTagValuesFor(
          tagVocabularyField(owner, field),
          this.options.featuredMetaTagValues,
        ),
      inputType: (field) => {
        const values = enumValuesFor(owner, field, this.mappings);
        return values ? "text" : queryScalarInputType(owner, field);
      },
      referenceOwner: (field) => queryReferenceOwner(owner, field),
      create: (field, operator, raw) =>
        createEntityCondition(owner, field, operator, raw),
    };
  }

  private statisticLeafConfig(
    owner: Owner,
    aggregate: ExplorerAggregate,
  ): LeafConfig {
    const entity = this.entityLeafConfig([owner]);
    return {
      fields: () => queryStatisticColumns(aggregate).map((column) => column.value),
      fieldLabel: (field) =>
        queryStatisticColumns(aggregate).find((column) => column.value === field)?.label ?? field,
      operators: (field) => statisticConditionOperators(owner, aggregate, field),
      operatorLabel: (field, operator) => aggregate.groupBy.includes(field)
        ? queryConditionOperatorLabel(owner, field, operator)
        : OPERATOR_LABEL[operator] ?? operator,
      values: (field) => aggregate.groupBy.includes(field)
        ? enumValuesFor(owner, field, this.mappings)
        : null,
      suggestions: () => null,
      inputType: (field) => aggregate.groupBy.includes(field)
        ? entity.inputType(field)
        : "number",
      create: (field, operator, raw) =>
        createStatisticCondition(owner, aggregate, field, operator, raw),
    };
  }

  private openNewEntityCondition(
    owners: readonly Owner[],
    field?: string,
    back?: () => void,
  ): void {
    if (!draftQuery(this.history.current)) {
      this.options.reportError(new TypeError("当前查询不能添加筛选条件"));
      return;
    }
    const config = this.entityLeafConfig(owners);
    this.openConditionEditor(
      "添加条件",
      createDefaultConditionEdit(config, field),
      config,
      (root) => {
        const condition = finishConditionEdit(root, config);
        if (condition) this.commitPanelDraft((draft) =>
          addConditionForOwners(draft, owners, condition)
        );
      },
      back,
      {
        compact: true,
        submitLabel: "添加条件",
      },
    );
  }

  private openEntityConditions(targetOwner?: Owner, focusIndex?: number): void {
    const query = draftQuery(this.history.current);
    if (!query) return;
    const owners = targetOwner
      ? [targetOwner]
      : draftScope(this.history.current);
    if (!owners) {
      this.options.reportError(new TypeError("请先选择条件适用的实体类型"));
      return;
    }
    const root = createConditionEditRoot(query.condition);
    const focusNode = focusIndex === undefined
      ? undefined
      : conditionEditFocusTerm(root, focusIndex);
    const config = this.entityLeafConfig(owners, editConditionFields(root));
    this.openConditionEditor(
      "筛选条件",
      root,
      config,
      (edited) => {
        const condition = finishConditionEdit(edited, config);
        this.commitPanelAction({
          type: "setCondition",
          condition,
          ...(targetOwner ? { owner: targetOwner } : {}),
        });
      },
      undefined,
      { focusNode },
    );
  }

  private openConditionEditor(
    title: string,
    root: EditCondition,
    config: LeafEditorConfig,
    saveEdit: (root: EditCondition) => void,
    back?: () => void,
    options: ConditionEditorOptions = {},
  ): void {
    if (root.kind === "all" && !root.terms.length)
      root.terms.push(createDefaultConditionEdit(config));
    const render = (): void => this.openPanel(title, (body) => {
      body.className = options.compact
        ? "query-condition-editor query-condition-editor-compact"
        : "query-condition-editor";
      const tree = document.createElement("div");
      tree.className = "query-condition-tree";
      const error = document.createElement("p");
      error.className = "query-popover-error";

      const renderAddRow = (
        node: Extract<EditCondition, { kind: "all" | "any" }>,
      ): HTMLElement => {
        const addRow = document.createElement("div");
        addRow.className = "query-condition-add";
        const addCondition = button("＋ 条件", "query-inline-link");
        addCondition.addEventListener("click", () => {
          node.terms.push(createDefaultConditionEdit(config));
          render();
        });
        addRow.append(addCondition);
        return addRow;
      };

      const renderNode = (
        node: EditCondition,
        parent: Extract<EditCondition, { kind: "all" | "any" | "not" }> | null,
        index: number,
      ): HTMLElement => {
        if (node.kind === "leaf") {
          const row = document.createElement("div");
          row.className = "query-condition-row";
          let fieldSelect: HTMLSelectElement | null = null;
          let fieldControl: HTMLElement;
          if (options.compact) {
            const field = document.createElement("span");
            field.className = "query-condition-field-token";
            field.textContent = config.fieldLabel(node.field);
            fieldControl = field;
          } else {
            const field = select("字段");
            for (const name of config.fields())
              field.append(option(name, config.fieldLabel(name)));
            field.value = node.field;
            fieldSelect = field;
            fieldControl = field;
          }
          const allowed = config.operators(node.field);
          if (!allowed.includes(node.operator)) node.operator = allowed[0] ?? "";
          const values = config.values(node.field);
          const visible = conditionEditorOperatorChoices(
            allowed,
            config.inputType(node.field),
            node.operator,
            values ? Object.keys(values).length : 0,
          );
          const operatorText = (name: string): string =>
            config.operatorLabel?.(node.field, name) ?? OPERATOR_LABEL[name] ?? name;
          let operatorSelect: HTMLSelectElement | null = null;
          let operatorControl: HTMLElement;
          if (visible.length === 1) {
            const label = document.createElement("span");
            label.className = "query-condition-operator-label";
            label.textContent = operatorText(visible[0]!);
            operatorControl = label;
          } else {
            const operator = select("比较方式");
            operator.append(...visible.map((name) => option(name, operatorText(name))));
            operator.value = node.operator;
            operatorSelect = operator;
            operatorControl = operator;
          }
          const valueHost = document.createElement("span");
          valueHost.className = "query-condition-value";
          let releaseAutocomplete: (() => void) | null = null;
          const renderValue = (): void => {
            releaseAutocomplete?.();
            releaseAutocomplete = null;
            valueHost.replaceChildren();
            if (isNoValueOperator(node.operator)) return;
            const referenceOwner = config.referenceOwner?.(node.field) ?? null;
            if (referenceOwner) {
              const multiple = isMultiValueOperator(node.operator);
              const refs = node.raw.split(/[、,，\n]+/).filter(Boolean);
              if (!multiple && refs.length > 1) {
                refs.splice(1);
                node.raw = refs[0] ?? "";
              }
              const labels = refs.map((ref) => {
                const known = this.labels.get(ref);
                if (known) return known;
                try {
                  const parsed = parseEntityRef(ref);
                  return `${OWNER_LABEL[parsed.owner]} #${parsed.archiveId}`;
                } catch {
                  return "未知条目";
                }
              });
              const control = button(
                labels.length > 1
                  ? `已选 ${labels.length} 个${OWNER_LABEL[referenceOwner]}`
                  : labels[0] ?? `选择${OWNER_LABEL[referenceOwner]}`,
                "query-entity-picker-button query-reference-value",
              );
              control.dataset.queryPrimary = "true";
              control.title = labels.join("、") || `选择${OWNER_LABEL[referenceOwner]}`;
              control.setAttribute("aria-label", control.title);
              control.addEventListener("click", () => {
                this.openEntityPicker(
                  `选择${OWNER_LABEL[referenceOwner]}`,
                  [referenceOwner],
                  (entity) => {
                    this.labels.set(entity.ref, entity.label);
                    node.raw = multiple
                      ? [...new Set([...refs, entity.ref])].join("、")
                      : entity.ref;
                    render();
                  },
                  render,
                );
              });
              valueHost.append(control);
              if (refs.length) {
                const clear = iconButton(
                  "close",
                  `清除${config.fieldLabel(node.field)}`,
                  "query-reference-clear",
                );
                clear.addEventListener("click", () => {
                  node.raw = "";
                  render();
                });
                valueHost.append(clear);
              }
              return;
            }
            const values = config.values(node.field);
            if (values) {
              const multiple = isMultiValueOperator(node.operator);
              if (multiple) {
                const choices = document.createElement("div");
                choices.className = "query-multi-choice";
                choices.setAttribute("role", "group");
                choices.setAttribute("aria-label", config.fieldLabel(node.field));
                const selected = new Set(node.raw.split(/[、,，]+/).filter(Boolean));
                const controls: HTMLInputElement[] = [];
                for (const [value, label] of Object.entries(values)) {
                  const choice = document.createElement("label");
                  choice.className = "query-multi-choice-item";
                  const control = input(label, "checkbox");
                  control.className = "query-multi-choice-input";
                  control.dataset.queryPrimary = "true";
                  control.value = value;
                  control.checked = selected.has(value);
                  controls.push(control);
                  choice.append(control, document.createTextNode(label));
                  choices.append(choice);
                }
                for (const control of controls) {
                  control.addEventListener("change", () => {
                    node.raw = controls
                      .filter((candidate) => candidate.checked)
                      .map((candidate) => candidate.value)
                      .join("、");
                  });
                }
                valueHost.append(choices);
              } else {
                const control = select(config.fieldLabel(node.field));
                control.dataset.queryPrimary = "true";
                node.raw = resolveSingleChoiceValue(node.raw, values);
                for (const [value, label] of Object.entries(values))
                  control.append(option(value, label));
                control.value = node.raw;
                control.addEventListener("change", () => node.raw = control.value);
                valueHost.append(control);
              }
            } else {
              const inputType = config.inputType(node.field);
              const control = input(
                config.fieldLabel(node.field),
                conditionValueInputType(inputType, node.operator),
              );
              const step = conditionValueInputStep(inputType, node.operator);
              if (step) control.step = step;
              control.dataset.queryPrimary = "true";
              control.value = node.raw;
              valueHost.append(control);
              const suggest = config.suggestions?.(node.field) ?? null;
              if (suggest) {
                control.placeholder = `输入${config.fieldLabel(node.field)}`;
                releaseAutocomplete = this.trackValueAutocomplete(
                  attachValueAutocomplete({
                    host: valueHost,
                    input: control,
                    label: config.fieldLabel(node.field),
                    featuredValues: config.featuredValues?.(node.field),
                    suggest,
                    onValue: (value) => node.raw = value,
                  }),
                );
              } else {
                control.placeholder = isMultiValueOperator(node.operator)
                  ? "多个值用、分隔"
                  : "值";
                control.addEventListener("input", () => node.raw = control.value);
              }
            }
          };
          renderValue();
          if (fieldSelect) fieldSelect.addEventListener("change", () => {
            node.field = fieldSelect.value;
            node.operator = config.operators(node.field)[0] ?? "";
            node.raw = "";
            render();
          });
          if (operatorSelect) {
            operatorSelect.addEventListener("change", () => {
              node.operator = operatorSelect.value;
              if (isNoValueOperator(node.operator)) node.raw = "";
              renderValue();
            });
          }
          if (node === options.focusNode) {
            const focus = valueHost.querySelector<HTMLElement>(
              "[data-query-primary=true]",
            ) ?? operatorSelect ?? fieldSelect;
            if (focus) focus.dataset.queryFocus = "true";
          }
          row.append(fieldControl, operatorControl, valueHost);
          if (parent) {
            const remove = iconButton("close", "删除条件", "query-row-remove");
            remove.addEventListener("click", () => {
              parent.terms.splice(index, 1);
              render();
            });
            row.append(remove);
          }
          return row;
        }

        if (node.kind === "not") {
          const group = document.createElement("fieldset");
          group.className = "query-condition-group-editor query-condition-not-editor";
          const head = document.createElement("legend");
          head.textContent = "排除以下条件";
          if (parent) {
            const remove = button("删除组", "query-inline-link");
            remove.addEventListener("click", () => {
              parent.terms.splice(index, 1);
              render();
            });
            head.append(remove);
          }
          group.append(head);
          const children = document.createElement("div");
          children.className = "query-condition-children";
          const term = node.terms[0];
          if (term) children.append(renderNode(term, node, 0));
          group.append(children);
          return group;
        }

        if (!parent && !conditionGroupControlsVisible(node)) {
          const flat = document.createElement("div");
          flat.className = "query-condition-flat";
          node.terms.forEach((term, termIndex) =>
            flat.append(renderNode(term, null, termIndex))
          );
          flat.append(renderAddRow(node));
          return flat;
        }

        const group = document.createElement("fieldset");
        group.className = "query-condition-group-editor";
        const head = document.createElement("legend");
        const mode = select("条件组逻辑");
        mode.append(
          option("all", "全部满足"),
          option("any", "任一满足"),
        );
        mode.value = node.kind;
        mode.addEventListener("change", () => {
          const next = mode.value as "all" | "any";
          node.kind = next;
          render();
        });
        head.append(mode);
        if (parent) {
          const remove = button("删除组", "query-inline-link");
          remove.addEventListener("click", () => {
            parent.terms.splice(index, 1);
            render();
          });
          head.append(remove);
        }
        group.append(head);
        const children = document.createElement("div");
        children.className = "query-condition-children";
        node.terms.forEach((term, termIndex) =>
          children.append(renderNode(term, node, termIndex))
        );
        children.append(renderAddRow(node));
        group.append(children);
        return group;
      };

      tree.append(renderNode(root, null, 0));
      const actions = document.createElement("footer");
      const save = options.compact
        ? iconButton(
            "check",
            options.submitLabel ?? "应用",
            "query-primary query-condition-submit",
          )
        : button(options.submitLabel ?? "应用", "query-primary");
      save.addEventListener("click", () => {
        try {
          saveEdit(root);
        } catch (reason) {
          error.textContent = reason instanceof Error ? reason.message : "条件无效";
        }
      });
      body.addEventListener("keydown", (event) => {
        if (
          !options.compact || event.key !== "Enter" || event.isComposing ||
          event.defaultPrevented || !(event.target instanceof HTMLElement) ||
          event.target.dataset.queryPrimary !== "true" ||
          event.target.getAttribute("aria-expanded") === "true"
        ) return;
        event.preventDefault();
        save.click();
      }, true);
      actions.append(save);
      body.append(tree, actions, error);
    }, "editor", back);
    render();
  }

  private openRelationEditor(
    index?: number,
    session?: ExplorerRelation,
    targetOwner?: Owner,
    back?: () => void,
  ): void {
    const query = draftQuery(this.history.current);
    if (!query) return;
    const scope = targetOwner ? [targetOwner] : draftScope(this.history.current);
    if (!scope) {
      this.options.reportError(new TypeError("请先选择关联适用的实体类型"));
      return;
    }
    const current = session ?? (index === undefined ? undefined : query.relations?.[index]);
    const choices = relationChoicesForScope(scope, this.mappings);
    if (!choices.length) {
      this.options.reportError(new TypeError("当前实体类型没有可用关系"));
      return;
    }
    const resolved = resolveRelationChoice(choices, current);
    const state = {
      selection: (current ? resolved.choice.value : undefined) as string | undefined,
      focusAfterRender: null as "target" | "save" | "exclude" | null,
      exists: current?.exists ?? true,
      related: current?.related,
      additionalEndpoints: current?.additionalEndpoints?.map((endpoint) => ({
        ...endpoint,
      })) ?? [],
      discriminator: resolved.discriminator
        ? cloneCondition(resolved.discriminator)
        : undefined,
      condition: resolved.remainder
        ? cloneCondition(resolved.remainder)
        : undefined,
    };
    const chooseRelation = (next: ScopedRelationChoice): void => {
      const selected = choices.find(({ value }) => value === state.selection)
        ?? choices[0]!;
      const previousOwner = state.related ? refOwner(state.related) : null;
      state.selection = next.value;
      state.focusAfterRender = "target";
      state.discriminator = relationChoiceCondition(next);
      if (selected.topology !== next.topology) state.additionalEndpoints = [];
      if (previousOwner !== queryRelationTargetOwner(next.topology)) {
        state.related = undefined;
        state.condition = undefined;
      } else if (selected.factKind !== next.factKind) {
        state.condition = undefined;
      }
    };
    let render: () => void;
    const openRelationPicker = (pickerBack?: () => void): void => {
      this.openPanel(
        "选择关系",
        (body) => {
          body.className = "query-relation-picker";
          const search = input("搜索关系");
          search.classList.add("query-relation-search");
          search.placeholder = "搜索关系名或两端类型";
          const status = document.createElement("p");
          status.className = "query-relation-picker-status";
          status.setAttribute("role", "status");
          status.setAttribute("aria-live", "polite");
          const list = document.createElement("div");
          list.className = "query-relation-picker-list";
          list.setAttribute("role", "listbox");
          list.setAttribute("aria-label", "关系");
          const empty = document.createElement("p");
          empty.className = "query-popover-empty";
          empty.textContent = "没有匹配的关系";

          const renderChoices = (): void => {
            const filtered = filterRelationChoices(choices, search.value);
            status.textContent = `${filtered.length} 个关系`;
            empty.hidden = filtered.length > 0;
            const controls = filtered.map((next, index) => {
              const choice = button("", "query-relation-picker-choice");
              const label = document.createElement("span");
              const detail = document.createElement("span");
              label.className = "query-relation-picker-label";
              label.textContent = next.displayLabel;
              detail.className = "query-relation-picker-detail";
              detail.textContent = next.detailLabel;
              choice.append(label, detail);
              choice.setAttribute("role", "option");
              choice.setAttribute(
                "aria-selected",
                String(next.value === state.selection),
              );
              choice.setAttribute(
                "aria-label",
                `${next.displayLabel}，${next.detailLabel}`,
              );
              choice.tabIndex = index === 0 ? 0 : -1;
              choice.addEventListener("click", () => {
                chooseRelation(next);
                render();
              });
              choice.addEventListener("keydown", (event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const target = moveSuggestionIndex(
                  controls.indexOf(choice),
                  controls.length,
                  event.key,
                );
                controls[target]?.focus();
              });
              return choice;
            });
            list.replaceChildren(...controls);
            list.hidden = controls.length === 0;
          };

          search.addEventListener("input", renderChoices);
          search.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const controls = [
              ...list.querySelectorAll<HTMLButtonElement>("[role=option]"),
            ];
            const target = event.key === "ArrowDown" ? controls[0] : controls.at(-1);
            if (!target) return;
            event.preventDefault();
            target.focus();
          });
          body.append(search, status, list, empty);
          renderChoices();
        },
        "editor",
        pickerBack,
      );
    };
    render = (): void => this.openPanel(
      index === undefined ? "按关联筛选" : "修改关联筛选",
      (body) => {
        const form = document.createElement("form");
        form.className = "query-relation-editor";
        const selected = choices.find(({ value }) => value === state.selection)
          ?? choices[0]!;
        const relation = button("", "query-relation-selected");
        const relationLabel = document.createElement("span");
        const relationDetail = document.createElement("span");
        relationLabel.className = "query-relation-selected-label";
        relationLabel.textContent = selected.displayLabel;
        relationDetail.className = "query-relation-selected-detail";
        relationDetail.textContent = selected.detailLabel;
        relation.append(relationLabel, relationDetail);
        relation.setAttribute(
          "aria-label",
          `更换关系：${selected.displayLabel}，${selected.detailLabel}`,
        );
        relation.title = "更换关系";
        relation.addEventListener("click", () => openRelationPicker(render));
        const targetOwner = queryRelationTargetOwner(selected.topology);
        const targetText = state.related
          ? this.labels.get(state.related) ?? "读取名称…"
          : `选择${OWNER_LABEL[targetOwner]}`;
        const target = button(targetText, "query-entity-picker-button");
        const targetLabel = state.related
          ? `关联${OWNER_LABEL[targetOwner]}：${targetText}`
          : `${targetText}（关联对象）`;
        target.setAttribute("aria-label", targetLabel);
        target.title = targetLabel;
        target.addEventListener("click", () => {
          this.openEntityPicker(`选择${OWNER_LABEL[targetOwner]}`, [targetOwner], (entity) => {
            state.related = entity.ref;
            this.labels.set(entity.ref, entity.label);
            state.focusAfterRender = "save";
            render();
          }, render);
        });
        const error = document.createElement("p");
        error.className = "query-popover-error";
        const save = button("应用", "query-primary");
        save.type = "submit";
        form.append(relation, target);
        const contexts = queryRelationContextRoles(
          selected.factKind,
          selected.candidateRole,
          selected.relatedRole,
        );
        state.additionalEndpoints = state.additionalEndpoints.filter((endpoint) =>
          contexts.some((context) =>
            context.role === endpoint.role &&
            refOwner(endpoint.related) === context.owner
          )
        );
        for (const context of contexts) {
          const endpoint = state.additionalEndpoints.find(({ role }) =>
            role === context.role
          );
          const contextHost = document.createElement("span");
          contextHost.className = "query-relation-context";
          const contextText = endpoint
            ? this.labels.get(endpoint.related) ?? "读取名称…"
            : `限定${context.label}`;
          const contextTarget = button(
            contextText,
            "query-entity-picker-button query-relation-context-target",
          );
          const contextLabel = endpoint
            ? `${context.label}限定：${contextText}`
            : `限定${context.label}（可选）`;
          contextTarget.setAttribute("aria-label", contextLabel);
          contextTarget.title = contextLabel;
          contextTarget.addEventListener("click", () => {
            this.openEntityPicker(`限定${context.label}`, [context.owner], (entity) => {
              this.labels.set(entity.ref, entity.label);
              state.additionalEndpoints = [
                ...state.additionalEndpoints.filter(({ role }) => role !== context.role),
                { role: context.role, related: entity.ref },
              ];
              state.focusAfterRender = "save";
              render();
            }, render);
          });
          contextHost.append(contextTarget);
          if (endpoint) {
            const clearContext = iconButton(
              "close",
              `取消${context.label}限定`,
              "query-relation-context-clear",
            );
            clearContext.addEventListener("click", () => {
              state.additionalEndpoints = state.additionalEndpoints
                .filter(({ role }) => role !== context.role);
              state.focusAfterRender = "save";
              render();
            });
            contextHost.append(clearContext);
          }
          form.append(contextHost);
        }
        const exclude = button(
          "没有此关联",
          "query-secondary query-relation-exclude",
        );
        exclude.type = "button";
        exclude.setAttribute("aria-pressed", String(!state.exists));
        const excludeLabel = state.exists
          ? "只保留没有此关联的条目"
          : "恢复为只保留有此关联的条目";
        exclude.setAttribute("aria-label", excludeLabel);
        exclude.title = excludeLabel;
        exclude.addEventListener("click", () => {
          state.exists = !state.exists;
          state.focusAfterRender = "exclude";
          render();
        });
        const kind = selected.factKind;
        const discriminatorField = queryFactDiscriminatorField(kind);
        const attributeFields = queryFactFields(kind, "filter")
          .filter((field) => field !== discriminatorField);
        const selections = factConditionSelections(state.condition, attributeFields);
        const attributeValues = attributeFields.map((field) => ({
          field,
          values: factEnumValues(kind, field, this.mappings),
        }));
        if (selections && attributeValues.every(({ values }) => values !== null)) {
          for (const { field, values } of attributeValues) {
            const control = select(FACT_FIELD_LABEL[field] ?? field);
            control.append(option("", "不限"));
            for (const [value, label] of Object.entries(values!))
              control.append(option(value, label));
            control.value = selections[field] ?? "";
            control.addEventListener("change", () => {
              state.condition = updateFactConditionSelection(
                kind,
                state.condition,
                attributeFields,
                field,
                control.value,
              );
              state.focusAfterRender = "save";
              render();
            });
            form.append(labeled(FACT_FIELD_LABEL[field] ?? field, control));
          }
        } else if (state.condition) {
          const legacy = button(
            `移除旧关系条件 · ${describeFactCondition(kind, state.condition, this.mappings)}`,
            "query-secondary query-relation-more-conditions",
          );
          legacy.addEventListener("click", () => {
            state.condition = undefined;
            state.focusAfterRender = "save";
            render();
          });
          form.append(legacy);
        }
        form.append(exclude, save);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          try {
            if (!state.related) throw new TypeError("请选择关联对象");
            const submitted = choices.find(({ value }) => value === state.selection);
            if (!submitted) throw new TypeError("请选择有效的关联类型");
            const condition = combineConditions([
              ...(state.discriminator ? [state.discriminator] : []),
              ...(state.condition ? [state.condition] : []),
            ]);
            const next: ExplorerRelation = {
              factKind: submitted.factKind,
              candidateRole: submitted.candidateRole,
              relatedRole: submitted.relatedRole,
              related: state.related,
              ...(state.additionalEndpoints.length
                ? { additionalEndpoints: state.additionalEndpoints }
                : {}),
              exists: state.exists,
              ...(condition ? { condition } : {}),
            };
            this.commitPanelAction(index === undefined
              ? { type: "addRelation", relation: next, owner: submitted.owner }
              : { type: "replaceRelation", index, relation: next });
          } catch (reason) {
            error.textContent = reason instanceof Error ? reason.message : "关联条件无效";
          }
        });
        body.append(form, error);
        if (state.focusAfterRender) {
          const focus = state.focusAfterRender === "target"
            ? target
            : state.focusAfterRender === "exclude" ? exclude : save;
          state.focusAfterRender = null;
          queueMicrotask(() => focus.focus());
        }
      },
      "editor",
      back,
    );
    if (current) render();
    else openRelationPicker(back);
  }

  private openColumnsEditor(back?: () => void): void {
    const query = draftQuery(this.history.current);
    if (!query || this.history.current.kind !== "list") return;
    const scope = draftScope(this.history.current);
    if (!scope) return;
    const choices = resultColumnChoices(scope);
    const chosen = new Set(normalizeResultColumnSelection(
      scope,
      query.columns ?? defaultResultColumnSelection(scope),
    ));
    this.openPanel("显示列", (body) => {
      const hint = document.createElement("p");
      hint.className = "query-popover-hint";
      hint.textContent = "条目固定显示";
      const grid = document.createElement("div");
      grid.className = "query-checkbox-grid";
      for (const choice of choices) {
        const { field } = choice;
        const baseLabel = FIELD_LABEL[field] ?? field;
        const label = sameOwnerScope(choice.owners, scope)
          ? baseLabel
          : `${baseLabel}（仅${ownerListLabel(choice.owners)}）`;
        const control = input(FIELD_LABEL[field] ?? field, "checkbox");
        control.checked = chosen.has(field);
        control.addEventListener("change", () => {
          if (control.checked) chosen.add(field);
          else chosen.delete(field);
        });
        grid.append(labeled(label, control));
      }
      const actions = document.createElement("footer");
      const reset = button("恢复默认", "query-secondary");
      reset.addEventListener("click", () => {
        this.commitPanelAction({ type: "setColumns", columns: undefined });
      });
      const save = button("应用", "query-primary");
      save.addEventListener("click", () => {
        this.commitPanelAction({
          type: "setColumns",
          columns: choices
            .map(({ field }) => field)
            .filter((field) => chosen.has(field)),
        });
      });
      actions.append(reset, save);
      body.append(hint, grid, actions);
    }, "editor", back);
  }

  private trackValueAutocomplete(cleanup: () => void): () => void {
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      cleanup();
      this.valueAutocompleteCleanups.delete(release);
    };
    this.valueAutocompleteCleanups.add(release);
    return release;
  }

  private clearValueAutocompletes(): void {
    for (const cleanup of [...this.valueAutocompleteCleanups]) cleanup();
  }

  private openSortEditor(back?: () => void): void {
    const draft = this.history.current;
    const query = draftQuery(draft);
    if (!query) return;
    const scope = draftScope(draft);
    if (!scope) {
      this.options.reportError(new TypeError("当前查询不能排序"));
      return;
    }
    const aggregate = draft.kind === "aggregate";
    const available: QuerySortChoice[] = aggregate
      ? queryStatisticColumns(draft.query.aggregate).map((item) => ({
          id: item.value,
          field: item.value,
          owners: [...scope],
          label: item.label,
        }))
      : querySortChoicesForScope(scope);
    if (!available.length) {
      this.options.reportError(new TypeError("当前查询没有可用的排序字段"));
      return;
    }
    const rows: ScopedOrderTerm[] = (query.orderBy ?? []).map((item) => ({ ...item }));
    let limit = query.limit === undefined || query.limit === null ? "" : String(query.limit);
    const canRemove = Boolean(query.orderBy?.length || query.limit !== undefined);
    if (!rows.length && available[0])
      rows.push(aggregate
        ? createSortTerm(available[0].field)
        : createSortTermForChoice(available[0], scope));
    const render = (): void => this.openPanel("排序", (body) => {
      const list = document.createElement("div");
      list.className = "query-sort-list";
      rows.forEach((row, index) => {
        const line = document.createElement("div");
        line.className = "query-sort-row";
        const priority = document.createElement("span");
        priority.className = "query-sort-priority";
        priority.textContent = index === 0 ? "先按" : "再按";
        const field = select(`第 ${index + 1} 排序字段`);
        for (const item of available) field.append(option(item.id, item.label));
        field.value = aggregate ? row.column : scopedSortTermId(row, scope);
        const direction = select(`第 ${index + 1} 排序方向`);
        direction.append(option("asc", "升序"), option("desc", "降序"));
        direction.value = row.direction;
        field.addEventListener("change", () => {
          const choice = available.find((item) => item.id === field.value);
          if (!choice) return;
          delete row.owners;
          Object.assign(
            row,
            aggregate
              ? createSortTerm(choice.field)
              : createSortTermForChoice(choice, scope),
          );
          direction.value = row.direction;
        });
        direction.addEventListener("change", () => {
          Object.assign(
            row,
            sortTermWithDirection(row, direction.value as "asc" | "desc"),
          );
        });
        const remove = iconButton("close", `删除第 ${index + 1} 项排序`, "query-row-remove");
        remove.addEventListener("click", () => {
          rows.splice(index, 1);
          render();
        });
        line.append(priority, field, direction, remove);
        list.append(line);
      });
      const add = button(
        rows.length ? "＋ 添加次要排序" : "＋ 添加排序规则",
        "query-inline-link",
      );
      add.disabled = rows.length >= available.length;
      add.addEventListener("click", () => {
        const used = new Set(rows.map((row) =>
          aggregate ? row.column : scopedSortTermId(row, scope)
        ));
        const next = available.find((choice) => !used.has(choice.id));
        if (next) rows.push(aggregate
          ? createSortTerm(next.field)
          : createSortTermForChoice(next, scope));
        render();
      });
      const top = input("前 N 条", "number");
      top.min = "1";
      top.placeholder = "全部";
      top.value = limit;
      top.addEventListener("input", () => limit = top.value);
      const error = document.createElement("p");
      error.className = "query-popover-error";
      const actions = document.createElement("footer");
      const clear = button("移除排序", "query-secondary");
      clear.addEventListener("click", () => {
        this.commitPanelDraft((draft) =>
          applyOrderAndLimit(draft, undefined, undefined)
        );
      });
      const save = button("应用", "query-primary");
      save.addEventListener("click", () => {
        try {
          const keys = rows.map((row) =>
            aggregate ? row.column : scopedSortTermId(row, scope)
          );
          if (new Set(keys).size !== rows.length)
            throw new TypeError("排序字段不能重复");
          const parsedLimit = limit.trim() ? parseExplorerLimit(limit) : undefined;
          if (parsedLimit !== undefined && !rows.length)
            throw new TypeError("前 N 条需要至少一个排序字段");
          this.commitPanelDraft((draft) =>
            applyOrderAndLimit(draft, rows, parsedLimit)
          );
        } catch (reason) {
          error.textContent = reason instanceof Error ? reason.message : "排序无效";
        }
      });
      if (canRemove) actions.append(clear);
      actions.append(save);
      body.append(list, add, labeled("只看前 N 条（可选）", top), actions, error);
    }, "editor", back);
    render();
  }

  private openPathLimitEditor(): void {
    const draft = this.history.current;
    if (draft.kind !== "path") return;
    this.openPanel("路径范围", (body) => {
      const form = document.createElement("form");
      form.className = "query-inline-form";
      const hops = input("最大跳数", "number");
      hops.min = "1";
      hops.value = String(draft.maxHops);
      const paths = input("最多路径数", "number");
      paths.min = "1";
      paths.value = String(draft.maxPaths);
      const error = document.createElement("p");
      error.className = "query-popover-error";
      const save = button("应用", "query-primary");
      save.type = "submit";
      form.append(labeled("最多跳数", hops), labeled("最多路径", paths), save, error);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const maxHops = Number(hops.value);
        const maxPaths = Number(paths.value);
        if (!Number.isSafeInteger(maxHops) || maxHops < 1 ||
            !Number.isSafeInteger(maxPaths) || maxPaths < 1) {
          error.textContent = "跳数和路径数必须是正整数";
          return;
        }
        this.commitPanelAction({
          type: "setPath", from: draft.from, to: draft.to, maxHops, maxPaths,
        });
      });
      body.append(form);
    });
  }

  private openAggregateEditor(targetOwner?: Owner): void {
    const draft = this.history.current;
    const query = draftQuery(draft);
    if (!query) return;
    const owner = targetOwner ?? draftOwner(draft);
    if (!owner) {
      this.options.reportError(new TypeError("请先选择要统计的实体类型"));
      return;
    }
    const aggregate: ExplorerAggregate = draft.kind === "aggregate"
      ? JSON.parse(JSON.stringify(draft.query.aggregate)) as ExplorerAggregate
      : { groupBy: [], metrics: [{ function: "count" }] };
    const groupFields = queryGroupFields(owner);
    const metricFields = queryAggregateFields(owner);
    const render = (): void => this.openPanel("设置统计结果", (body) => {
      const groups = document.createElement("div");
      groups.className = "query-checkbox-grid";
      for (const field of groupFields) {
        const control = input(FIELD_LABEL[field] ?? field, "checkbox");
        control.checked = aggregate.groupBy.includes(field);
        control.addEventListener("change", () => {
          aggregate.groupBy = control.checked
            ? [...aggregate.groupBy, field]
            : aggregate.groupBy.filter((item) => item !== field);
        });
        groups.append(labeled(FIELD_LABEL[field] ?? field, control));
      }
      const metricList = document.createElement("div");
      metricList.className = "query-metric-list";
      aggregate.metrics.forEach((metric, index) => {
        const row = document.createElement("div");
        row.className = "query-metric-row";
        const fn = select("统计方式");
        for (const [value, label] of Object.entries(AGGREGATE_FUNCTION_LABEL))
          fn.append(option(value, label));
        fn.value = metric.function;
        const field = select("统计字段");
        field.append(option("", "全部条目"));
        for (const name of metricFields) field.append(option(name, FIELD_LABEL[name] ?? name));
        field.value = metric.field ?? "";
        field.hidden = metric.function === "count";
        fn.addEventListener("change", () => {
          metric.function = fn.value as AggregateFunction;
          if (metric.function === "count") delete metric.field;
          else metric.field ??= metricFields[0];
          render();
        });
        field.addEventListener("change", () => {
          if (field.value) metric.field = field.value;
        });
        const remove = iconButton("close", "删除统计指标", "query-row-remove");
        remove.disabled = aggregate.metrics.length === 1;
        remove.addEventListener("click", () => {
          aggregate.metrics.splice(index, 1);
          render();
        });
        row.append(fn, field, remove);
        metricList.append(row);
      });
      const addMetric = button("＋ 指标", "query-inline-link");
      addMetric.addEventListener("click", () => {
        aggregate.metrics.push({ function: "count" });
        render();
      });
      const having = button(
        aggregate.having ? "修改统计结果条件" : "添加统计结果条件",
        "query-secondary",
      );
      having.addEventListener("click", () => {
        const config = this.statisticLeafConfig(owner, aggregate);
        this.openConditionEditor(
          "统计结果条件",
          createConditionEditRoot(aggregate.having),
          config,
          (root) => {
            aggregate.having = finishConditionEdit(root, config);
            render();
          },
          render,
        );
      });
      const actions = document.createElement("footer");
      if (draft.kind === "aggregate") {
        const list = button("改为列表", "query-secondary");
        list.addEventListener("click", () => {
          this.commitPanelAction({ type: "setList" });
        });
        actions.append(list);
      }
      const save = button("应用", "query-primary");
      save.addEventListener("click", () => {
        try {
          if (!aggregate.metrics.length) throw new TypeError("至少选择一个统计指标");
          for (const metric of aggregate.metrics)
            if (metric.function !== "count" && !metric.field)
              throw new TypeError(`${AGGREGATE_FUNCTION_LABEL[metric.function]}需要选择字段`);
          const names = aggregate.metrics.map((metric) => `${metric.function}:${metric.field ?? "*"}`);
          if (new Set(names).size !== names.length) throw new TypeError("统计指标不能重复");
          this.commitPanelAction({ type: "setAggregate", aggregate, owner });
        } catch (reason) {
          this.options.reportError(reason);
        }
      });
      actions.append(save);
      const groupHeading = document.createElement("h4");
      groupHeading.textContent = "分组（可选）";
      const metricHeading = document.createElement("h4");
      metricHeading.textContent = "计算";
      body.append(groupHeading, groups, metricHeading, metricList, addMetric, having, actions);
    });
    render();
  }

  private openEntityPicker(
    title: string,
    owners: readonly Owner[],
    pick: (entity: SelectedQueryEntity) => void,
    back?: () => void,
  ): void {
    this.openPanel(title, (body) => {
      body.className = "query-entity-picker";
      const search = input("搜索条目名称");
      search.placeholder = "输入至少两个字";
      const results = document.createElement("div");
      results.className = "query-entity-suggestions";
      results.setAttribute("role", "listbox");
      results.id = `query-entity-suggestions-${++this.suggestionListSerial}`;
      search.setAttribute("role", "combobox");
      search.setAttribute("aria-autocomplete", "list");
      search.setAttribute("aria-haspopup", "listbox");
      search.setAttribute("aria-controls", results.id);
      search.setAttribute("aria-expanded", "false");
      const hint = document.createElement("p");
      hint.className = "query-popover-hint";
      hint.textContent = `搜索${owners.map((owner) => OWNER_LABEL[owner]).join("、")}名称`;
      if (this.options.selectedEntity) {
        const selected = button("使用星图中已选条目", "query-secondary");
        selected.addEventListener("click", () => void this.options.selectedEntity?.().then((entity) => {
          if (!entity) throw new TypeError("星图中还没有选中条目");
          if (!owners.includes(refOwner(entity.ref))) throw new TypeError("已选条目类型不适用于这里");
          pick(entity);
        }).catch(this.options.reportError));
        body.append(selected);
      }
      let choices: HTMLButtonElement[] = [];
      let activeIndex = -1;
      let paintedActiveIndex = -1;
      let buffered: EntitySuggestion[] = [];
      let iterator: AsyncIterator<EntitySuggestionBatch> | null = null;
      let streamController: AbortController | null = null;
      let streamComplete = true;
      let loading = false;
      let failure = "";
      const syncActive = (scroll = false): void => {
        if (paintedActiveIndex !== activeIndex)
          choices[paintedActiveIndex]?.setAttribute("aria-selected", "false");
        const active = choices[activeIndex];
        if (active) {
          active.setAttribute("aria-selected", "true");
          search.setAttribute("aria-activedescendant", active.id);
          if (scroll) active.scrollIntoView({ block: "nearest" });
        } else search.removeAttribute("aria-activedescendant");
        paintedActiveIndex = activeIndex;
        search.setAttribute("aria-expanded", String(choices.length > 0));
      };
      const syncHint = (): void => {
        const found = choices.length + buffered.length;
        if (failure) hint.textContent = failure;
        else if (loading) hint.textContent = found
          ? `已找到 ${found} 个，正在继续查找…`
          : "正在查找…";
        else if (streamComplete) hint.textContent = found
          ? `共 ${found} 个结果`
          : "没有找到条目";
        else hint.textContent = `已找到 ${found} 个，继续滚动查看`;
      };
      const appendBuffered = (): void => {
        const items = buffered.splice(0, ENTITY_SUGGESTION_RENDER_BATCH);
        for (const item of items) {
          const index = choices.length;
          const choice = button("", "query-entity-suggestion");
          choice.setAttribute("role", "option");
          choice.id = `${results.id}-option-${index}`;
          const detail = document.createElement("span");
          detail.textContent = item.detail || OWNER_LABEL[item.owner];
          choice.append(suggestionTitle(item.owner, item.label), detail);
          choice.addEventListener("pointermove", () => {
            activeIndex = index;
            syncActive();
          });
          choice.addEventListener("focus", () => {
            activeIndex = index;
            syncActive();
          });
          choice.addEventListener("click", () => pick(item));
          choices.push(choice);
          results.append(choice);
        }
        if (activeIndex < 0 && choices.length) activeIndex = 0;
        syncActive();
        syncHint();
      };
      const loadNext = async (): Promise<void> => {
        const controller = streamController;
        const source = iterator;
        if (
          loading || streamComplete || !controller || !source ||
          controller.signal.aborted
        ) return;
        loading = true;
        syncHint();
        try {
          const next = await source.next();
          if (
            controller.signal.aborted ||
            this.suggestionController !== controller ||
            streamController !== controller
          ) return;
          if (next.done) streamComplete = true;
          else {
            buffered.push(...next.value.items);
            streamComplete = next.value.complete;
          }
          appendBuffered();
        } catch (error) {
          if (!controller.signal.aborted) {
            failure = error instanceof Error ? error.message : "条目搜索失败";
            streamComplete = true;
          }
        } finally {
          if (streamController === controller) {
            loading = false;
            syncHint();
          }
        }
      };
      const revealMore = (): void => {
        if (buffered.length) appendBuffered();
        else void loadNext();
      };
      search.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (
            event.key === "ArrowDown" &&
            activeIndex === choices.length - 1 &&
            (buffered.length || !streamComplete)
          ) {
            const before = choices.length;
            revealMore();
            if (choices.length === before) return;
          }
          activeIndex = moveSuggestionIndex(activeIndex, choices.length, event.key);
          syncActive(true);
          return;
        }
        if (event.key === "Enter" && choices[activeIndex]) {
          event.preventDefault();
          choices[activeIndex]!.click();
          return;
        }
      });
      results.addEventListener("scroll", () => {
        if (
          results.scrollTop + results.clientHeight >= results.scrollHeight - 48
        ) revealMore();
      });
      const update = (): void => {
        this.cancelSuggestions();
        results.replaceChildren();
        choices = [];
        activeIndex = -1;
        paintedActiveIndex = -1;
        buffered = [];
        iterator = null;
        streamController = null;
        streamComplete = true;
        loading = false;
        failure = "";
        syncActive();
        const text = search.value.trim();
        if (literalCount(text) < 2) {
          hint.textContent = `至少输入两个字，搜索${owners.map((owner) => OWNER_LABEL[owner]).join("、")}`;
          return;
        }
        if (!this.options.suggestEntities) {
          hint.textContent = "当前只能使用星图中已选条目";
          return;
        }
        hint.textContent = "正在查找…";
        const controller = new AbortController();
        this.suggestionController = controller;
        streamController = controller;
        this.suggestionTimer = setTimeout(() => {
          this.suggestionTimer = null;
          try {
            iterator = this.options.suggestEntities!(
              text,
              owners,
              controller.signal,
            )[Symbol.asyncIterator]();
            streamComplete = false;
            void loadNext();
          } catch (error) {
            failure = error instanceof Error ? error.message : "条目搜索失败";
            streamComplete = true;
            syncHint();
          }
        }, 120);
      };
      search.addEventListener("input", update);
      body.prepend(search, hint, results);
      queueMicrotask(() => search.focus());
    }, "editor", back);
  }

  private cancelSuggestions(): void {
    if (this.suggestionTimer !== null) clearTimeout(this.suggestionTimer);
    this.suggestionTimer = null;
    this.suggestionController?.abort(new DOMException("suggestion replaced", "AbortError"));
    this.suggestionController = null;
  }
}
