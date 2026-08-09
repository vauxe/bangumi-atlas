import {
  applyQueryAction,
  combineConditions,
  compileQueryDraft,
  createQueryHistory,
  DEFAULT_ENTITY_SCOPE,
  draftOwner,
  draftQuery,
  draftScope,
  redoQueryHistory,
  type EntityRef,
  type QueryAction,
  type QueryDraft,
  type QueryHistory,
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
  completionActions,
  queryInputValue,
  queryTokens,
  type CompletionAction,
  type CompletionActionId,
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
  DEFAULT_RESULT_FIELDS,
  defaultSortDirection,
  enumValuesFor,
  FACT_FIELD_LABEL,
  factEnumValues,
  FIELD_LABEL,
  INTERNAL_FIELDS,
  OPERATOR_LABEL,
  OWNER_LABEL,
  queryAggregateFields,
  queryConditionOperators,
  queryFactConditionOperators,
  queryFactFields,
  queryFieldsFor,
  queryGroupFields,
  queryProjectFields,
  queryRelationOptions,
  queryRelationTargetOwner,
  querySortFields,
  queryStatisticColumns,
  queryTextScopes,
} from "./workbench-model";
import type { AggregateFunction, OrderTerm } from "./document";
import type { Mappings } from "../types";

let queryBarSequence = 0;

export interface SelectedQueryEntity {
  ref: EntityRef;
  label: string;
}

export interface EntitySuggestion extends SelectedQueryEntity {
  owner: Owner;
  detail?: string;
  match?: string;
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
  if (!query || query.text?.capability === "fullText") return [];
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

export function fullTextScopeOptions(owner?: Owner): Array<{
  value: string;
  label: string;
}> {
  return [
    ...(owner
      ? queryTextScopes(owner).filter((scope) => scope.value !== "lookup")
      : []),
    { value: "all", label: "所有正文与关系备注" },
  ];
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

export interface QueryBarOptions {
  draft: QueryDraft;
  onChange(draft: QueryDraft): void;
  onSubmit(): void;
  reportError(error: unknown): void;
  selectedEntity?(): Promise<SelectedQueryEntity | null>;
  resolveEntityLabel?(ref: string): Promise<string>;
  suggestEntities?(
    text: string,
    owners: readonly Owner[],
    signal: AbortSignal,
  ): Promise<EntitySuggestion[]>;
  suggestNames?(
    text: string,
    owners: readonly Owner[],
    signal: AbortSignal,
  ): Promise<NameSuggestion[]>;
  onNameSuggestion?(suggestion: NameSuggestion): void;
  mappings?(): Promise<Mappings>;
}

interface LeafConfig {
  fields(): string[];
  fieldLabel(field: string): string;
  operators(field: string): string[];
  values(field: string): Record<string, string> | null;
  inputType(field: string): "text" | "number";
  create(field: string, operator: string, raw: string): ExplorerCondition;
}

export type EditCondition =
  | { kind: "leaf"; field: string; operator: string; raw: string }
  | { kind: "all" | "any" | "not"; terms: EditCondition[] };

type PanelRenderer = (body: HTMLElement) => void;

interface ActionMenuItem {
  label: string;
  description: string;
  choose(): void;
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

function button(label: string, className = ""): HTMLButtonElement {
  const result = document.createElement("button");
  result.type = "button";
  result.className = className;
  result.textContent = label;
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
  result.className = "query-popover-control";
  result.setAttribute("aria-label", label);
  return result;
}

function input(label: string, type = "text"): HTMLInputElement {
  const result = document.createElement("input");
  result.className = "query-popover-control";
  result.type = type;
  result.autocomplete = "off";
  result.setAttribute("aria-label", label);
  return result;
}

export function createQueryNameInput(): HTMLInputElement {
  const result = input("名称关键词");
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
}): Extract<EditCondition, { kind: "leaf" }> {
  const fields = config.fields();
  const field = fields[0] ?? "";
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

function refOwner(ref: EntityRef): Owner {
  return parseEntityRef(ref).owner;
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
  const remove = button("×", "query-token-remove");
  remove.title = "删除";
  remove.setAttribute("aria-label", `删除：${item.label}`);
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
  if (!query || query.text?.capability === "fullText") return null;
  if (queryInputValue(draft) === value) return null;
  return {
    type: "setText",
    text: value.trim() ? { value, capability: "lookup" } : undefined,
  };
}

export function createSortTerm(column: string): OrderTerm {
  const direction = defaultSortDirection(column);
  return {
    column,
    direction,
    nulls: direction === "asc" ? "first" : "last",
  };
}

export class QueryBar {
  readonly dom = document.createElement("div");
  private readonly line = document.createElement("div");
  private readonly tokens = document.createElement("span");
  private readonly inputGroup = document.createElement("span");
  private readonly text = createQueryNameInput();
  private readonly add = button("＋", "query-add");
  private readonly panel = document.createElement("section");
  private readonly panelTitle = document.createElement("h2");
  private readonly panelBody = document.createElement("div");
  private readonly panelClose = button("×", "query-popover-close");
  private history: QueryHistory;
  private mappings: Mappings | undefined;
  private composing = false;
  private actionIndex = 0;
  private nameIndex = -1;
  private suggestionController: AbortController | null = null;
  private suggestionTimer: ReturnType<typeof setTimeout> | null = null;
  private suggestionListSerial = 0;
  private panelReturnFocus: HTMLElement | null = null;
  private readonly labels = new Map<string, string>();

  constructor(private readonly options: QueryBarOptions) {
    this.history = createQueryHistory(options.draft);
    this.dom.className = "query-bar";
    this.line.className = "query-bar-line";
    this.tokens.className = "query-token-run";
    this.inputGroup.className = "query-input-group";
    this.text.name = "query-command";
    this.text.placeholder = "输入名称，或按 / 添加条件";
    this.text.setAttribute("role", "combobox");
    this.text.setAttribute("aria-autocomplete", "list");
    this.text.setAttribute("aria-haspopup", "listbox");
    this.text.setAttribute("aria-expanded", "false");
    this.add.setAttribute("aria-label", "添加查询条件或切换答案");
    this.add.title = "添加查询条件或切换答案";
    this.add.setAttribute("aria-haspopup", "listbox");
    this.add.setAttribute("aria-expanded", "false");

    this.panel.className = "query-popover";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "查询补全");
    const panelHeader = document.createElement("header");
    this.panelClose.setAttribute("aria-label", "关闭查询补全");
    panelHeader.append(this.panelTitle, this.panelClose);
    this.panel.append(panelHeader, this.panelBody);
    this.inputGroup.append(this.text, this.add);
    this.line.append(this.tokens, this.inputGroup);
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
      this.openActions("");
    });
    this.panelClose.addEventListener("click", () => {
      this.closePanel(true);
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

    this.render();
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
    (this.text.hidden ? this.add : this.text).focus();
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
    const hasNameInput = query !== null && query.text?.capability !== "fullText";
    if (!hasNameInput || shouldSyncQueryInput(
      document.activeElement === this.text,
      this.text.value,
      forceInput,
    )) this.text.value = expected;
    this.text.hidden = !hasNameInput;
    this.inputGroup.classList.toggle("query-input-group-action-only", !hasNameInput);
    this.text.placeholder = hasNameInput
      ? "输入名称"
      : "";
    this.text.setAttribute(
      "aria-label",
      hasNameInput ? "名称关键词" : "当前查询不接受名称关键词",
    );
  }

  private renderTokens(): void {
    const tokens = queryTokens(this.history.current, {
      mappings: this.mappings,
      entityLabel: (ref) => this.labels.get(ref),
    });
    this.tokens.replaceChildren(...tokens.map((item) => this.tokenButton(item)));
    this.resolveTokenEntities();
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
    const refs: EntityRef[] = draft.kind === "comparison" || draft.kind === "path"
      ? [draft.from, draft.to]
      : draftQuery(draft)?.relations?.map((relation) => relation.related) ?? [];
    for (const ref of refs) {
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
      this.openActions("");
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
    if (!this.panel.hidden && (panelKind === "actions" || panelKind === "names")) {
      const choices = [...this.panelBody.querySelectorAll<HTMLButtonElement>("[role=option]")];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (panelKind === "names") {
          this.nameIndex = moveSuggestionIndex(this.nameIndex, choices.length, event.key);
          this.syncActiveName(choices, true);
        } else {
          const delta = event.key === "ArrowDown" ? 1 : -1;
          this.actionIndex = choices.length
            ? (this.actionIndex + delta + choices.length) % choices.length
            : 0;
          this.syncActiveAction(choices);
        }
        return;
      }
      const active = panelKind === "names" ? this.nameIndex : this.actionIndex;
      if (event.key === "Enter" && choices[active]) {
        event.preventDefault();
        choices[active]!.click();
        return;
      }
      if (
        event.key === "Enter" && panelKind === "names" && active < 0 &&
        literalCount(this.text.value) < QUERY_CONTRACT.search.lookup.minNormalizedCharacters
      ) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Escape" && !this.panel.hidden) {
      event.preventDefault();
      this.text.value = queryInputValue(this.history.current);
      this.closePanel(true);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.closePanel();
      this.options.onSubmit();
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
    const token = event.target instanceof HTMLElement && event.target.matches(".query-token")
      ? event.target
      : null;
    if (token && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const tokens = [...this.tokens.querySelectorAll<HTMLElement>(".query-token")];
      const index = tokens.indexOf(token);
      const target = event.key === "ArrowLeft"
        ? tokens[index - 1]
        : tokens[index + 1] ?? (this.text.hidden ? this.add : this.text);
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
    } else if (modified && event.key === "Enter") {
      event.preventDefault();
      this.options.onSubmit();
    }
  }

  private openPanel(title: string, renderer: PanelRenderer, kind = "editor"): void {
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
    this.cancelSuggestions();
    this.panelTitle.textContent = title;
    this.panelBody.dataset.kind = kind;
    this.panelBody.id ||= `query-bar-options-${++queryBarSequence}`;
    this.text.setAttribute("aria-controls", this.panelBody.id);
    this.add.setAttribute("aria-controls", this.panelBody.id);
    const listboxOpen = kind === "actions" || kind === "names";
    this.text.setAttribute("aria-expanded", String(listboxOpen));
    this.add.setAttribute("aria-expanded", String(kind === "actions"));
    if (!listboxOpen) this.text.removeAttribute("aria-activedescendant");
    this.panelBody.className = "";
    this.panelBody.removeAttribute("role");
    this.panelBody.replaceChildren();
    renderer(this.panelBody);
    this.panel.hidden = false;
    if (kind === "editor") queueMicrotask(() => {
      if (this.panel.hidden || this.panel.contains(document.activeElement)) return;
      const controls = [...this.panelBody.querySelectorAll<HTMLElement>(controlSelector)];
      const preferred = restoreControlFocus(previousFocus, controls);
      const primary = controls.find((control) => control.getAttribute("aria-label") === "字段");
      (preferred ?? primary ?? controls[0])?.focus();
    });
  }

  private closePanel(restoreFocus = false): void {
    const returnFocus = this.panelReturnFocus;
    this.panelReturnFocus = null;
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

  private openActions(filter: string): void {
    const actions = completionActions(this.history.current, filter);
    const groups = new Map<Owner, CompletionAction[]>();
    for (const item of actions) {
      if (!item.owner) continue;
      const group = groups.get(item.owner) ?? [];
      group.push(item);
      groups.set(item.owner, group);
    }
    const added = new Set<Owner>();
    const menu: ActionMenuItem[] = [];
    for (const item of actions) {
      if (!item.owner) {
        menu.push({
          label: item.label,
          description: item.description,
          choose: () => this.chooseAction(item),
        });
        continue;
      }
      if (added.has(item.owner)) continue;
      added.add(item.owner);
      const owner = item.owner;
      const children = groups.get(owner) ?? [];
      menu.push({
        label: `${OWNER_LABEL[owner]}查询`,
        description: children.map((child) =>
          child.label.replace(`${OWNER_LABEL[owner]} · `, "")
        ).join("、"),
        choose: () => this.openScopedActions(owner, children),
      });
    }
    this.openActionMenu("添加到查询", menu);
  }

  private openScopedActions(owner: Owner, actions: CompletionAction[]): void {
    this.openActionMenu(`${OWNER_LABEL[owner]}查询`, [
      {
        label: "返回全部操作",
        description: "选择其他实体或答案",
        choose: () => this.openActions(""),
      },
      ...actions.map((item) => ({
        label: item.label.replace(`${OWNER_LABEL[owner]} · `, ""),
        description: item.description,
        choose: () => this.chooseAction(item),
      })),
    ]);
  }

  private openActionMenu(title: string, actions: readonly ActionMenuItem[]): void {
    this.actionIndex = 0;
    this.openPanel(title, (body) => {
      body.className = "query-action-list";
      body.setAttribute("role", "listbox");
      for (const [index, item] of actions.entries()) {
        const choice = button("", "query-action");
        choice.setAttribute("role", "option");
        choice.dataset.index = String(index);
        choice.id = `${body.id}-option-${index}`;
        const label = document.createElement("strong");
        label.textContent = item.label;
        const description = document.createElement("span");
        description.textContent = item.description;
        choice.append(label, description);
        choice.addEventListener("pointermove", () => {
          this.actionIndex = index;
          this.syncActiveAction([...body.querySelectorAll<HTMLButtonElement>("[role=option]")]);
        });
        choice.addEventListener("click", () => {
          this.synchronizeNameInput();
          this.text.value = queryInputValue(this.history.current);
          item.choose();
        });
        body.append(choice);
      }
      if (!actions.length) {
        const empty = document.createElement("p");
        empty.className = "query-popover-empty";
        empty.textContent = "没有匹配的操作";
        body.append(empty);
      }
      this.syncActiveAction([...body.querySelectorAll<HTMLButtonElement>("[role=option]")]);
    }, "actions");
    queueMicrotask(() => {
      if (!this.panel.hidden && this.panelBody.dataset.kind === "actions")
        (this.text.hidden ? this.add : this.text).focus();
    });
  }

  private syncActiveAction(choices: HTMLButtonElement[]): void {
    choices.forEach((choice, index) => {
      const active = index === this.actionIndex;
      choice.classList.toggle("active", active);
      choice.setAttribute("aria-selected", String(active));
    });
    const active = choices[this.actionIndex];
    if (active) this.text.setAttribute("aria-activedescendant", active.id);
    else this.text.removeAttribute("aria-activedescendant");
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
      const label = document.createElement("strong");
      label.textContent = item.label;
      const detail = document.createElement("span");
      detail.textContent = item.match && item.match !== item.label
        ? `${item.detail ?? OWNER_LABEL[item.owner]} · 匹配：${item.match}`
        : item.detail ?? OWNER_LABEL[item.owner];
      choice.append(label, detail);
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
      empty.textContent = `没有名称建议；仍可查看“${text}”的完整匹配`;
      body.append(empty);
    }
    if (literalCount(text) >= QUERY_CONTRACT.search.lookup.minNormalizedCharacters) {
      const all = button("查看全部匹配", "query-view-all");
      all.setAttribute("role", "option");
      all.setAttribute("aria-selected", "false");
      all.id = `${body.id}-name-all`;
      all.addEventListener("pointermove", () => {
        this.nameIndex = items.length;
        this.syncActiveName(
          [...body.querySelectorAll<HTMLButtonElement>("[role=option]")],
        );
      });
      all.addEventListener("pointerdown", (event) => event.preventDefault());
      all.addEventListener("click", () => {
        this.closePanel();
        this.options.onSubmit();
      });
      body.append(all);
    } else {
      const hint = document.createElement("p");
      hint.className = "query-popover-hint";
      hint.textContent = "再输入一个字即可查看全部匹配";
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

  private chooseAction(action: CompletionAction | CompletionActionId): void {
    this.synchronizeNameInput();
    const id = typeof action === "string" ? action : action.id;
    const owner = typeof action === "string" ? undefined : action.owner;
    switch (id) {
      case "fullText":
        this.openTextEditor();
        break;
      case "condition":
        this.openEntityConditions(owner);
        break;
      case "relation":
        this.openRelationEditor(undefined, undefined, owner);
        break;
      case "columns":
        this.openColumnsEditor(owner);
        break;
      case "sort":
        this.openSortEditor(owner);
        break;
      case "limit":
        this.openLimitEditor();
        break;
      case "aggregate":
        this.openAggregateEditor(owner);
        break;
      case "list": {
        const draft = this.history.current;
        const owner = draft.kind === "comparison" || draft.kind === "path"
          ? refOwner(draft.from)
          : undefined;
        this.commitPanelAction({ type: "setList", ...(owner ? { owner } : {}) });
        break;
      }
      case "comparison":
        this.openPairEditor("comparison");
        break;
      case "path":
        this.openPairEditor("path");
        break;
    }
  }

  private editToken(item: QueryToken): void {
    switch (item.target.type) {
      case "head":
      case "intent":
        this.openShapeEditor();
        break;
      case "owner":
        this.openOwnerEditor();
        break;
      case "text":
        this.openTextEditor();
        break;
      case "condition":
        this.openEntityConditions();
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
      case "maxHops":
      case "maxPaths":
        this.openLimitEditor();
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
        else this.dispatch({ type: "setText", text: undefined });
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
        this.dispatch({ type: "setOrder", orderBy: undefined });
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

  private openShapeEditor(): void {
    this.openPanel("选择答案", (body) => {
      body.className = "query-choice-list";
      const choices: Array<[CompletionActionId, string, string]> = [
        ["list", "查找条目", "得到可以继续筛选和排序的列表"],
        ["aggregate", "统计", "分组并计算条数、合计或平均值"],
        ["comparison", "比较", "查看两个条目的共同关联与差异"],
        ["path", "路径", "寻找两个条目之间的最短关联"],
      ];
      for (const [id, label, description] of choices) {
        const choice = button("", "query-choice");
        const strong = document.createElement("strong");
        strong.textContent = label;
        const note = document.createElement("span");
        note.textContent = description;
        choice.append(strong, note);
        choice.addEventListener("click", () => this.chooseAction(id));
        body.append(choice);
      }
      if ((this.history.current.kind === "list" && this.history.current.query) ||
          this.history.current.kind === "aggregate") {
        const heading = document.createElement("h4");
        heading.textContent = "查询范围";
        const scopes = document.createElement("div");
        scopes.className = "query-choice-row";
        this.appendScopeChoices(scopes);
        body.append(heading, scopes);
      }
    });
  }

  private openOwnerEditor(): void {
    this.openPanel("查找什么", (body) => {
      body.className = "query-choice-row";
      this.appendScopeChoices(body);
    });
  }

  private appendScopeChoices(body: HTMLElement): void {
    const draft = this.history.current;
    const current = draftScope(draft);
    const choices: Array<{ label: string; owners: readonly Owner[] }> = draft.kind === "aggregate"
      ? (Object.entries(OWNER_LABEL) as [Owner, string][]).map(([owner, label]) => ({
          label,
          owners: [owner],
        }))
      : [
          { label: "全部", owners: DEFAULT_ENTITY_SCOPE },
          ...(Object.entries(OWNER_LABEL) as [Owner, string][]).map(([owner, label]) => ({
            label,
            owners: [owner],
          })),
        ];
    for (const item of choices) {
      const choice = button(item.label, "query-choice-chip");
      const action: QueryAction = draft.kind === "aggregate"
        ? { type: "setOwner", owner: item.owners[0]! }
        : { type: "setScope", scope: item.owners };
      const selected = Boolean(
        current && current.length === item.owners.length &&
        current.every((owner, index) => owner === item.owners[index]),
      );
      choice.setAttribute("aria-pressed", String(selected));
      try {
        applyQueryAction(draft, action);
      } catch (error) {
        choice.disabled = true;
        choice.title = error instanceof Error ? error.message : "与当前查询不兼容";
      }
      choice.addEventListener("click", () => this.commitPanelAction(action));
      body.append(choice);
    }
  }

  private openTextEditor(): void {
    const draft = this.history.current;
    const query = draftQuery(draft);
    const allText = draft.kind === "list" && !draft.query ? draft.allText : undefined;
    if (!query && allText === undefined) return;
    const scopes = fullTextScopeOptions(draftOwner(draft) ?? undefined);
    const current = query?.text?.capability === "fullText" ? query.text : undefined;
    this.openPanel("检索正文", (body) => {
      const form = document.createElement("form");
      form.className = "query-inline-form";
      const scope = select("正文范围");
      for (const item of scopes) scope.append(option(item.value, item.label));
      scope.value = allText !== undefined
        ? "all"
        : current?.field ? `fullText:${current.field}` : scopes[0]?.value ?? "all";
      const value = input("正文关键词");
      value.placeholder = "至少两个字";
      value.value = allText ?? current?.value ?? "";
      const error = document.createElement("p");
      error.className = "query-popover-error";
      const save = button("应用", "query-primary");
      save.type = "submit";
      form.append(labeled("范围", scope), labeled("包含", value), save, error);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
          if (literalCount(value.value) < 2) throw new TypeError("正文关键词至少需要两个字");
          if (scope.value === "all") {
            this.commitPanelAction({ type: "setAllText", text: value.value });
            return;
          }
          const field = scope.value.replace(/^fullText:/, "") as "summary" | "description";
          this.commitPanelAction({
            type: "setText",
            text: { value: value.value.trim(), capability: "fullText", field },
          });
        } catch (reason) {
          error.textContent = reason instanceof Error ? reason.message : "正文条件无效";
        }
      });
      body.append(form);
      queueMicrotask(() => value.focus());
    });
  }

  private entityLeafConfig(owner: Owner): LeafConfig {
    return {
      fields: () => {
        const available = queryFieldsFor(owner, "filter")
          .filter((field) => !INTERNAL_FIELDS.has(field));
        return [
          ...[...COMMON_FIELDS[owner]].filter((field) => available.includes(field)),
          ...available.filter((field) => !COMMON_FIELDS[owner].has(field)),
        ];
      },
      fieldLabel: (field) => FIELD_LABEL[field] ?? field,
      operators: (field) => queryConditionOperators(owner, field),
      values: (field) => enumValuesFor(owner, field, this.mappings),
      inputType: (field) => {
        const values = enumValuesFor(owner, field, this.mappings);
        return values ? "text" : [
          "score", "rank", "year", "wish", "done", "doing", "onHold",
          "dropped", "comments", "collects", "disc", "duration", "sort",
        ].includes(field) ? "number" : "text";
      },
      create: (field, operator, raw) =>
        createEntityCondition(owner, field, operator, raw),
    };
  }

  private factLeafConfig(kind: QueryFactKind): LeafConfig {
    return {
      fields: () => queryFactFields(kind, "filter"),
      fieldLabel: (field) => FACT_FIELD_LABEL[field] ?? field,
      operators: (field) => queryFactConditionOperators(kind, field),
      values: (field) => factEnumValues(kind, field, this.mappings),
      inputType: (field) => factEnumValues(kind, field, this.mappings)
        ? "text"
        : "number",
      create: (field, operator, raw) => createFactCondition(kind, field, operator, raw),
    };
  }

  private statisticLeafConfig(
    owner: Owner,
    aggregate: ExplorerAggregate,
  ): LeafConfig {
    const entity = this.entityLeafConfig(owner);
    return {
      fields: () => queryStatisticColumns(aggregate).map((column) => column.value),
      fieldLabel: (field) =>
        queryStatisticColumns(aggregate).find((column) => column.value === field)?.label ?? field,
      operators: (field) => statisticConditionOperators(owner, aggregate, field),
      values: (field) => aggregate.groupBy.includes(field)
        ? enumValuesFor(owner, field, this.mappings)
        : null,
      inputType: (field) => aggregate.groupBy.includes(field)
        ? entity.inputType(field)
        : "number",
      create: (field, operator, raw) =>
        createStatisticCondition(owner, aggregate, field, operator, raw),
    };
  }

  private openEntityConditions(targetOwner?: Owner): void {
    const query = draftQuery(this.history.current);
    if (!query) return;
    const owner = targetOwner ?? draftOwner(this.history.current);
    if (!owner) {
      this.options.reportError(new TypeError("请先选择条件适用的实体类型"));
      return;
    }
    const config = this.entityLeafConfig(owner);
    const root = createConditionEditRoot(query.condition);
    this.openConditionEditor(
      "筛选条件",
      root,
      config,
      (condition) => {
        this.commitPanelAction({ type: "setCondition", condition, owner });
      },
    );
  }

  private openConditionEditor(
    title: string,
    root: EditCondition,
    config: LeafConfig,
    commit: (condition: ExplorerCondition | undefined) => void,
    back?: () => void,
  ): void {
    if (root.kind === "all" && !root.terms.length)
      root.terms.push(createDefaultConditionEdit(config));
    const render = (): void => this.openPanel(title, (body) => {
      body.className = "query-condition-editor";
      const tree = document.createElement("div");
      tree.className = "query-condition-tree";
      const error = document.createElement("p");
      error.className = "query-popover-error";

      const renderNode = (
        node: EditCondition,
        parent: Extract<EditCondition, { kind: "all" | "any" | "not" }> | null,
        index: number,
      ): HTMLElement => {
        if (node.kind === "leaf") {
          const row = document.createElement("div");
          row.className = "query-condition-row";
          const field = select("字段");
          for (const name of config.fields())
            field.append(option(name, config.fieldLabel(name)));
          field.value = node.field;
          const operator = select("比较方式");
          const syncOperators = (): void => {
            operator.replaceChildren(...config.operators(node.field).map((name) =>
              option(name, OPERATOR_LABEL[name] ?? name)
            ));
            if (!config.operators(node.field).includes(node.operator))
              node.operator = operator.value;
            else operator.value = node.operator;
          };
          syncOperators();
          const valueHost = document.createElement("span");
          valueHost.className = "query-condition-value";
          const renderValue = (): void => {
            valueHost.replaceChildren();
            if (isNoValueOperator(node.operator)) return;
            const values = config.values(node.field);
            if (values) {
              const control = select(config.fieldLabel(node.field));
              const multiple = isMultiValueOperator(node.operator);
              control.multiple = multiple;
              if (multiple) control.size = Math.min(5, Math.max(2, Object.keys(values).length));
              for (const [value, label] of Object.entries(values))
                control.append(option(value, label));
              if (!multiple) node.raw = resolveSingleChoiceValue(node.raw, values);
              const selected = new Set(node.raw.split(/[、,，]+/).filter(Boolean));
              for (const item of control.options) item.selected = selected.has(item.value);
              control.addEventListener("change", () => {
                node.raw = [...control.selectedOptions].map((item) => item.value).join("、");
              });
              valueHost.append(control);
            } else {
              const control = input(config.fieldLabel(node.field), config.inputType(node.field));
              control.value = node.raw;
              control.placeholder = isMultiValueOperator(node.operator) ? "多个值用、分隔" : "值";
              control.addEventListener("input", () => node.raw = control.value);
              valueHost.append(control);
            }
          };
          renderValue();
          field.addEventListener("change", () => {
            node.field = field.value;
            node.operator = config.operators(node.field)[0] ?? "";
            node.raw = "";
            render();
          });
          operator.addEventListener("change", () => {
            node.operator = operator.value;
            if (isNoValueOperator(node.operator)) node.raw = "";
            renderValue();
          });
          row.append(field, operator, valueHost);
          if (parent) {
            const remove = button("×", "query-row-remove");
            remove.setAttribute("aria-label", "删除条件");
            remove.addEventListener("click", () => {
              parent.terms.splice(index, 1);
              render();
            });
            row.append(remove);
          }
          return row;
        }

        const group = document.createElement("fieldset");
        group.className = "query-condition-group-editor";
        const head = document.createElement("legend");
        const mode = select("条件组逻辑");
        mode.append(
          option("all", "全部满足"),
          option("any", "任一满足"),
          option("not", "排除"),
        );
        mode.value = node.kind;
        mode.addEventListener("change", () => {
          const next = mode.value as "all" | "any" | "not";
          node.kind = next;
          if (next === "not" && node.terms.length > 1) node.terms.splice(1);
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
        const addRow = document.createElement("div");
        addRow.className = "query-condition-add";
        const addCondition = button("＋ 条件", "query-inline-link");
        addCondition.addEventListener("click", () => {
          if (node.kind === "not" && node.terms.length) return;
          node.terms.push(createDefaultConditionEdit(config));
          render();
        });
        const addGroup = button("＋ 条件组", "query-inline-link");
        addGroup.hidden = node.kind === "not";
        addGroup.addEventListener("click", () => {
          node.terms.push({ kind: "any", terms: [createDefaultConditionEdit(config)] });
          render();
        });
        addRow.append(addCondition, addGroup);
        children.append(addRow);
        group.append(children);
        return group;
      };

      tree.append(renderNode(root, null, 0));
      const actions = document.createElement("footer");
      if (back) {
        const backButton = button("返回", "query-secondary");
        backButton.addEventListener("click", back);
        actions.append(backButton);
      }
      const save = button("应用", "query-primary");
      save.addEventListener("click", () => {
        try {
          commit(finishConditionEdit(root, config));
        } catch (reason) {
          error.textContent = reason instanceof Error ? reason.message : "条件无效";
        }
      });
      actions.append(save);
      body.append(tree, actions, error);
    });
    render();
  }

  private openRelationEditor(
    index?: number,
    session?: ExplorerRelation,
    targetOwner?: Owner,
  ): void {
    const query = draftQuery(this.history.current);
    if (!query) return;
    const owner = targetOwner ?? draftOwner(this.history.current);
    if (!owner) {
      this.options.reportError(new TypeError("请先选择关联适用的实体类型"));
      return;
    }
    const current = session ?? (index === undefined ? undefined : query.relations?.[index]);
    const choices = queryRelationOptions(owner);
    const selectionValue = current
      ? `${current.factKind}|${current.candidateRole}|${current.relatedRole}`
      : choices[0]?.value ?? "";
    const state = {
      selection: selectionValue,
      exists: current?.exists ?? true,
      related: current?.related,
      condition: current?.condition ? cloneCondition(current.condition) : undefined,
    };
    const render = (): void => this.openPanel(index === undefined ? "添加关联" : "修改关联", (body) => {
      const form = document.createElement("div");
      form.className = "query-relation-editor";
      const relation = select("关联类型");
      for (const choice of choices) relation.append(option(choice.value, choice.label));
      relation.value = state.selection;
      const existence = select("是否存在");
      existence.append(option("true", "存在"), option("false", "不存在"));
      existence.value = String(state.exists);
      const target = button(
        state.related ? this.labels.get(state.related) ?? "读取名称…" : "选择关联条目",
        "query-entity-picker-button",
      );
      target.addEventListener("click", () => {
        const owner = queryRelationTargetOwner(state.selection);
        this.openEntityPicker("选择关联条目", [owner], (entity) => {
          state.related = entity.ref;
          this.labels.set(entity.ref, entity.label);
          render();
        }, render);
      });
      relation.addEventListener("change", () => {
        const previousOwner = state.related ? refOwner(state.related) : null;
        state.selection = relation.value;
        if (previousOwner !== queryRelationTargetOwner(state.selection)) {
          state.related = undefined;
          state.condition = undefined;
        }
        render();
      });
      existence.addEventListener("change", () => state.exists = existence.value === "true");
      form.append(
        labeled("关系", relation),
        labeled("条目", target),
        labeled("要求", existence),
      );
      const [kind] = state.selection.split("|") as [QueryFactKind];
      if (kind && queryFactFields(kind, "filter").length) {
        const attributes = button(
          state.condition ? "修改关系属性条件" : "添加关系属性条件",
          "query-secondary",
        );
        attributes.addEventListener("click", () => {
          this.openConditionEditor(
            "关系属性条件",
            createConditionEditRoot(state.condition),
            this.factLeafConfig(kind),
            (condition) => {
              state.condition = condition;
              render();
            },
            render,
          );
        });
        form.append(attributes);
      }
      const error = document.createElement("p");
      error.className = "query-popover-error";
      const save = button("应用", "query-primary");
      save.addEventListener("click", () => {
        try {
          if (!state.related) throw new TypeError("请选择关联条目");
          const [factKind, candidateRole, relatedRole] = state.selection.split("|");
          if (!factKind || !candidateRole || !relatedRole)
            throw new TypeError("请选择有效的关联类型");
          const next: ExplorerRelation = {
            factKind: factKind as QueryFactKind,
            candidateRole,
            relatedRole,
            related: state.related,
            exists: state.exists,
            ...(state.condition ? { condition: state.condition } : {}),
          };
          this.commitPanelAction(index === undefined
            ? { type: "addRelation", relation: next, owner }
            : { type: "replaceRelation", index, relation: next });
        } catch (reason) {
          error.textContent = reason instanceof Error ? reason.message : "关联条件无效";
        }
      });
      body.append(form, save, error);
    });
    render();
  }

  private openColumnsEditor(targetOwner?: Owner): void {
    const query = draftQuery(this.history.current);
    if (!query || this.history.current.kind !== "list") return;
    const owner = targetOwner ?? draftOwner(this.history.current);
    if (!owner) {
      this.options.reportError(new TypeError("请先选择显示列适用的实体类型"));
      return;
    }
    const fields = queryProjectFields(owner);
    const defaults = DEFAULT_RESULT_FIELDS[owner].filter((field) => fields.includes(field));
    const chosen = new Set(query.columns ?? defaults);
    this.openPanel("显示哪些信息", (body) => {
      const grid = document.createElement("div");
      grid.className = "query-checkbox-grid";
      for (const field of fields) {
        const control = input(FIELD_LABEL[field] ?? field, "checkbox");
        control.checked = chosen.has(field);
        control.addEventListener("change", () => {
          if (control.checked) chosen.add(field);
          else chosen.delete(field);
        });
        grid.append(labeled(FIELD_LABEL[field] ?? field, control));
      }
      const actions = document.createElement("footer");
      const reset = button("使用默认", "query-secondary");
      reset.addEventListener("click", () => {
        this.commitPanelAction({ type: "setColumns", columns: undefined, owner });
      });
      const save = button("应用", "query-primary");
      save.addEventListener("click", () => {
        if (!chosen.size) {
          this.options.reportError(new TypeError("至少选择一项显示信息"));
          return;
        }
        this.commitPanelAction({
          type: "setColumns",
          columns: fields.filter((field) => chosen.has(field)),
          owner,
        });
      });
      actions.append(reset, save);
      body.append(grid, actions);
    });
  }

  private openSortEditor(targetOwner?: Owner): void {
    const draft = this.history.current;
    const query = draftQuery(draft);
    if (!query) return;
    const owner = targetOwner ?? draftOwner(draft);
    if (!owner) {
      this.options.reportError(new TypeError("请先选择排序适用的实体类型"));
      return;
    }
    const available = draft.kind === "aggregate"
      ? queryStatisticColumns(draft.query.aggregate)
      : querySortFields(owner).map((field) => ({
          value: field,
          label: FIELD_LABEL[field] ?? field,
        }));
    const rows: OrderTerm[] = (query.orderBy ?? []).map((item) => ({ ...item }));
    if (!rows.length && available[0])
      rows.push(createSortTerm(available[0].value));
    const render = (): void => this.openPanel("排序", (body) => {
      const list = document.createElement("div");
      list.className = "query-sort-list";
      rows.forEach((row, index) => {
        const line = document.createElement("div");
        line.className = "query-sort-row";
        const field = select("排序字段");
        for (const item of available) field.append(option(item.value, item.label));
        field.value = row.column;
        const direction = select("排序方向");
        direction.append(option("asc", "升序"), option("desc", "降序"));
        direction.value = row.direction;
        field.addEventListener("change", () => {
          Object.assign(row, createSortTerm(field.value));
          direction.value = row.direction;
        });
        direction.addEventListener("change", () => {
          row.direction = direction.value as "asc" | "desc";
          row.nulls = row.direction === "asc" ? "first" : "last";
        });
        const remove = button("×", "query-row-remove");
        remove.setAttribute("aria-label", "删除排序");
        remove.addEventListener("click", () => {
          rows.splice(index, 1);
          render();
        });
        line.append(field, direction, remove);
        list.append(line);
      });
      const add = button("＋ 排序字段", "query-inline-link");
      add.disabled = rows.length >= available.length;
      add.addEventListener("click", () => {
        const next = available.find((field) => !rows.some((row) => row.column === field.value));
        if (next) rows.push(createSortTerm(next.value));
        render();
      });
      const actions = document.createElement("footer");
      const clear = button("不排序", "query-secondary");
      clear.addEventListener("click", () => {
        this.commitPanelAction({ type: "setOrder", orderBy: undefined, owner });
      });
      const save = button("应用", "query-primary");
      save.addEventListener("click", () => {
        if (new Set(rows.map((row) => row.column)).size !== rows.length) {
          this.options.reportError(new TypeError("排序字段不能重复"));
          return;
        }
        this.commitPanelAction({ type: "setOrder", orderBy: rows, owner });
      });
      actions.append(clear, save);
      body.append(list, add, actions);
    });
    render();
  }

  private openLimitEditor(): void {
    const draft = this.history.current;
    if (draft.kind === "path") {
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
      return;
    }
    const query = draftQuery(draft);
    if (!query) return;
    this.openPanel("结果条数", (body) => {
      const form = document.createElement("form");
      form.className = "query-inline-form";
      const value = input("最多结果数", "number");
      value.min = "1";
      value.value = query.limit === undefined || query.limit === null ? "" : String(query.limit);
      value.placeholder = "不限制";
      const error = document.createElement("p");
      error.className = "query-popover-error";
      const clear = button("不限制", "query-secondary");
      clear.addEventListener("click", () => {
        this.commitPanelAction({ type: "setLimit", limit: undefined });
      });
      const save = button("应用", "query-primary");
      save.type = "submit";
      form.append(labeled("最多显示", value), clear, save, error);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const limit = Number(value.value);
        if (!Number.isSafeInteger(limit) || limit < 1) {
          error.textContent = "结果条数必须是正整数";
          return;
        }
        this.commitPanelAction({ type: "setLimit", limit });
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
    const render = (): void => this.openPanel("统计", (body) => {
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
        const remove = button("×", "query-row-remove");
        remove.setAttribute("aria-label", "删除统计指标");
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
        this.openConditionEditor(
          "统计结果条件",
          createConditionEditRoot(aggregate.having),
          this.statisticLeafConfig(owner, aggregate),
          (condition) => {
            aggregate.having = condition;
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

  private openPairEditor(kind: "comparison" | "path", state?: {
    from?: SelectedQueryEntity;
    to?: SelectedQueryEntity;
    maxHops: number;
    maxPaths: number;
  }): void {
    const draft = this.history.current;
    const session = state ?? {
      ...(draft.kind === "comparison" || draft.kind === "path"
        ? {
            from: { ref: draft.from, label: this.labels.get(draft.from) ?? "读取名称…" },
            to: { ref: draft.to, label: this.labels.get(draft.to) ?? "读取名称…" },
          }
        : {}),
      maxHops: draft.kind === "path" ? draft.maxHops : 6,
      maxPaths: draft.kind === "path" ? draft.maxPaths : 10,
    };
    const render = (): void => this.openPanel(kind === "comparison" ? "比较两个条目" : "查找关系路径", (body) => {
      const pair = document.createElement("div");
      pair.className = "query-pair-editor";
      const from = button(session.from?.label ?? "选择第一个条目", "query-entity-picker-button");
      const to = button(session.to?.label ?? "选择第二个条目", "query-entity-picker-button");
      const between = document.createElement("span");
      between.textContent = kind === "comparison" ? "和" : "到";
      from.addEventListener("click", () => this.openEntityPicker(
        "选择第一个条目",
        ["subject", "person", "character"],
        (entity) => {
          session.from = entity;
          this.labels.set(entity.ref, entity.label);
          render();
        },
        render,
      ));
      to.addEventListener("click", () => this.openEntityPicker(
        "选择第二个条目",
        ["subject", "person", "character"],
        (entity) => {
          session.to = entity;
          this.labels.set(entity.ref, entity.label);
          render();
        },
        render,
      ));
      pair.append(from, between, to);
      const useSelected = button("使用星图中已选条目", "query-inline-link");
      useSelected.hidden = !this.options.selectedEntity;
      useSelected.addEventListener("click", () => void this.options.selectedEntity?.().then((entity) => {
        if (!entity) throw new TypeError("星图中还没有选中条目");
        if (refOwner(entity.ref) === "episode") throw new TypeError("分集不能用于关联比较或路径");
        if (!session.from) session.from = entity;
        else session.to = entity;
        this.labels.set(entity.ref, entity.label);
        render();
      }).catch(this.options.reportError));
      const error = document.createElement("p");
      error.className = "query-popover-error";
      const save = button(kind === "comparison" ? "比较" : "查找路径", "query-primary");
      save.addEventListener("click", () => {
        if (!session.from || !session.to) {
          error.textContent = "请选择两个条目";
          return;
        }
        this.commitPanelAction(kind === "comparison"
          ? { type: "setComparison", from: session.from.ref, to: session.to.ref }
          : {
              type: "setPath", from: session.from.ref, to: session.to.ref,
              maxHops: session.maxHops, maxPaths: session.maxPaths,
            });
      });
      body.append(pair, useSelected, save, error);
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
      if (back) {
        const backButton = button("← 返回", "query-inline-link");
        backButton.addEventListener("click", back);
        body.append(backButton);
      }
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
      const syncActive = (scroll = false): void => {
        choices.forEach((choice, index) => {
          const active = index === activeIndex;
          choice.setAttribute("aria-selected", String(active));
          if (active && scroll) choice.scrollIntoView({ block: "nearest" });
        });
        const active = choices[activeIndex];
        if (active) search.setAttribute("aria-activedescendant", active.id);
        else search.removeAttribute("aria-activedescendant");
        search.setAttribute("aria-expanded", String(choices.length > 0));
      };
      search.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          activeIndex = moveSuggestionIndex(activeIndex, choices.length, event.key);
          syncActive(true);
          return;
        }
        if (event.key === "Enter" && choices[activeIndex]) {
          event.preventDefault();
          choices[activeIndex]!.click();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (back) back();
          else {
            this.closePanel();
            this.focus();
          }
        }
      });
      const update = (): void => {
        this.cancelSuggestions();
        results.replaceChildren();
        choices = [];
        activeIndex = -1;
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
        this.suggestionTimer = setTimeout(() => {
          this.suggestionTimer = null;
          void this.options.suggestEntities!(text, owners, controller.signal).then((items) => {
            if (controller.signal.aborted) return;
            hint.textContent = items.length ? "" : "没有找到条目";
            for (const [index, item] of items.entries()) {
              const choice = button("", "query-entity-suggestion");
              choice.setAttribute("role", "option");
              choice.id = `${results.id}-option-${index}`;
              const name = document.createElement("strong");
              name.textContent = item.label;
              const detail = document.createElement("span");
              detail.textContent = item.detail || OWNER_LABEL[item.owner];
              choice.append(name, detail);
              choice.addEventListener("pointermove", () => {
                activeIndex = index;
                syncActive();
              });
              choice.addEventListener("focus", () => {
                activeIndex = index;
                syncActive();
              });
              choice.addEventListener("click", () => pick(item));
              results.append(choice);
            }
            choices = [...results.querySelectorAll<HTMLButtonElement>("[role=option]")];
            activeIndex = choices.length ? 0 : -1;
            syncActive();
          }).catch((error) => {
            if (!controller.signal.aborted) {
              hint.textContent = error instanceof Error ? error.message : "条目搜索失败";
            }
          });
        }, 120);
      };
      search.addEventListener("input", update);
      body.prepend(search, hint, results);
      queueMicrotask(() => search.focus());
    });
  }

  private cancelSuggestions(): void {
    if (this.suggestionTimer !== null) clearTimeout(this.suggestionTimer);
    this.suggestionTimer = null;
    this.suggestionController?.abort(new DOMException("suggestion replaced", "AbortError"));
    this.suggestionController = null;
  }
}
