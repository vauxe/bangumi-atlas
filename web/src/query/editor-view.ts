import {
  Slice,
  type Node as ProseMirrorNode,
} from "prosemirror-model";
import { redo, undo } from "prosemirror-history";
import { NodeSelection, type Transaction } from "prosemirror-state";
import type { NodeView } from "prosemirror-view";
import { EditorView } from "prosemirror-view";

import {
  ClauseView,
  ControlSlot,
  ParameterSlot,
  literalInput,
  option,
  queryWord,
  removeButton,
  selectControl,
  stopControlEvent,
} from "./editor-controls";
import {
  AdvancedBundleView,
  AdvancedOperatorView,
  AdvancedSectionView,
} from "./editor-advanced-view";
import { AggregateView } from "./editor-aggregate-view";
import { RecipeView } from "./editor-recipe-view";
import type { Owner, QueryFactKind } from "./contract";
import type { ExplorerAggregate, ExplorerAggregateMetric } from "./explorer";
import {
  createQueryEditorState,
  queryClauseInsertionPosition,
  lowerQueryEditorDocument,
  QUERY_OPERATOR_NODE,
  queryEditorSchema,
  readableQueryEditorDocument,
  type EditableFactCondition,
  type LoweredQueryEditorDocument,
} from "./editor";
import {
  FACT_FIELD_LABEL,
  FIELD_LABEL,
  COMMON_FIELDS,
  INTERNAL_FIELDS,
  OPERATOR_LABEL,
  OWNER_LABEL,
  defaultSortDirection,
  enumValuesFor,
  factEnumValues,
  queryFactConditionOperators,
  queryFactFields,
  queryConditionOperators,
  queryFieldsFor,
  queryGroupFields,
  queryProjectFields,
  queryRelationOptions,
  queryRelationTargetOwner,
  querySortFields,
  queryStatisticColumns,
  queryTextScopes,
} from "./workbench-model";
import type { Mappings } from "../types";

export interface SelectedQueryEntity {
  ref: string;
  label: string;
}

export interface QueryEditorViewOptions {
  doc: ProseMirrorNode;
  onChange(result: LoweredQueryEditorDocument): void;
  selectedEntity?(): Promise<SelectedQueryEntity | null>;
  resolveEntityLabel?(ref: string): Promise<string>;
  mappings?(): Promise<Mappings>;
  reportError(error: unknown): void;
}

type ClauseName = "search" | "condition" | "condition_group" | "relation" |
  "projection" | "aggregate" | "sort" | "limit";

const MAX_STRUCTURED_CLIPBOARD_BYTES = 65_536;

function defaultConditionAttrs(owner: Owner): Record<string, unknown> {
  const available = new Set(queryFieldsFor(owner, "filter"));
  const field = [...COMMON_FIELDS[owner]].find((item) => available.has(item)) ??
    [...available].find((item) => !INTERNAL_FIELDS.has(item)) ?? "";
  return {
    field,
    operator: queryConditionOperators(owner, field)[0] ?? "",
    raw: "",
  };
}

class FindView extends ClauseView {
  private readonly owner = selectControl("查找对象");
  private readonly ownerSlot = new ControlSlot(this.owner, "查找对象");

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    super("find", node, view, getPos);
    for (const [value, label] of Object.entries(OWNER_LABEL))
      this.owner.append(option(value, label));
    this.owner.value = String(node.attrs.owner);
    this.ownerSlot.sync();
    this.owner.addEventListener("change", () =>
      this.updateAttrs({ owner: this.owner.value })
    );
    this.dom.append(queryWord("查找"), this.ownerSlot.dom);
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.owner.value = String(node.attrs.owner);
    this.ownerSlot.sync();
    return true;
  }
}

class SearchView extends ClauseView {
  private readonly scope = selectControl("搜索范围");
  private readonly value = literalInput("搜索文字");
  private readonly scopeSlot = new ControlSlot(this.scope, "搜索范围");
  private readonly valueSlot = new ControlSlot(this.value, "搜索文字", {
    placeholder: "输入关键词",
    quote: true,
    closeOnChange: false,
  });
  private readonly parameter: ParameterSlot;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    owner: Owner,
  ) {
    super("search", node, view, getPos);
    for (const item of queryTextScopes(owner))
      this.scope.append(option(item.value, item.label));
    this.scope.value = String(node.attrs.scope);
    this.value.value = String(node.attrs.raw);
    this.value.placeholder = "输入关键词";
    this.scopeSlot.sync();
    this.valueSlot.sync();
    this.parameter = new ParameterSlot(
      String(node.attrs.parameter ?? ""),
      () => "keyword",
      (parameter) => this.updateAttrs({ parameter }),
    );
    this.scope.addEventListener("change", () =>
      this.updateAttrs({ scope: this.scope.value })
    );
    this.value.addEventListener("input", () =>
      this.updateAttrs({ raw: this.value.value })
    );
    this.valueSlot.panel.append(this.parameter.dom);
    this.dom.append(
      queryWord("搜索"),
      this.scopeSlot.dom,
      this.valueSlot.dom,
      removeButton(() => this.remove(), "移除搜索"),
    );
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.scope.value = String(node.attrs.scope);
    if (this.value.value !== node.attrs.raw) this.value.value = String(node.attrs.raw);
    this.parameter.sync(String(node.attrs.parameter ?? ""));
    this.scopeSlot.sync();
    this.valueSlot.sync();
    return true;
  }
}

class ConditionView extends ClauseView {
  private readonly field = selectControl("条件字段");
  private readonly operator = selectControl("比较方式");
  private readonly fieldSlot = new ControlSlot(this.field, "条件字段");
  private readonly operatorSlot = new ControlSlot(this.operator, "比较方式");
  private value: HTMLInputElement | HTMLSelectElement | null = null;
  private valueSlot: ControlSlot<HTMLInputElement | HTMLSelectElement> | null = null;
  private readonly valueHost = document.createElement("span");
  private readonly parameter: ParameterSlot;
  private mappings: Mappings | undefined;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    private readonly owner: Owner,
    options: QueryEditorViewOptions,
  ) {
    super("condition", node, view, getPos);
    const common = document.createElement("optgroup");
    common.label = "常用";
    const more = document.createElement("optgroup");
    more.label = "更多";
    const commonFields = new Set(["type", "year", "score", "tags", "career", "role", "collects", "descriptionState", "summaryState"]);
    for (const name of queryFieldsFor(owner, "filter").filter((item) =>
      !INTERNAL_FIELDS.has(item)
    ))
      (commonFields.has(name) ? common : more)
        .append(option(name, FIELD_LABEL[name] ?? name));
    if (common.childElementCount) this.field.append(common);
    if (more.childElementCount) this.field.append(more);
    this.field.value = String(node.attrs.field);
    this.fieldSlot.sync();
    this.parameter = new ParameterSlot(
      String(node.attrs.parameter ?? ""),
      () => `${this.field.value || "value"}Value${getPos() ?? ""}`,
      (parameter) => this.updateAttrs({ parameter }),
    );
    this.field.addEventListener("change", () => {
      this.fillOperators();
      this.fillValue("");
      this.updateAttrs({
        field: this.field.value,
        operator: this.operator.value,
        raw: "",
        parameter: "",
      });
    });
    this.operator.addEventListener("change", () => {
      this.fillValue("");
      this.updateAttrs({ operator: this.operator.value, raw: "", parameter: "" });
    });
    this.fillOperators(String(node.attrs.operator));
    this.fillValue(String(node.attrs.raw));
    this.dom.append(
      queryWord("其中"),
      this.fieldSlot.dom,
      this.operatorSlot.dom,
      this.valueHost,
      removeButton(() => this.remove(), "移除条件"),
    );
    void options.mappings?.().then((mappings) => {
      this.mappings = mappings;
      this.fillValue(String(this.node.attrs.raw));
    }).catch((error: unknown) => options.reportError(error));
  }

  private fillOperators(selected = ""): void {
    this.operator.replaceChildren();
    for (const name of queryConditionOperators(this.owner, this.field.value))
      this.operator.append(option(name, OPERATOR_LABEL[name] ?? name));
    this.operator.value = selected;
    if (!this.operator.value) this.operator.selectedIndex = 0;
    this.operatorSlot.sync();
  }

  private fillValue(raw: string): void {
    const operator = this.operator.value;
    const parameterAvailable = ![
      "in", "notIn", "isNull", "isNotNull", "isMissing", "isPresent",
    ].includes(operator);
    this.parameter.setAvailable(parameterAvailable);
    if (!parameterAvailable) this.parameter.sync("");
    if (["isNull", "isNotNull", "isMissing", "isPresent"].includes(operator)) {
      this.value = null;
      this.valueSlot = null;
      this.valueHost.replaceChildren();
      return;
    }
    const enums = enumValuesFor(this.owner, this.field.value, this.mappings);
    if (enums && operator !== "in" && operator !== "notIn") {
      const select = selectControl(`${FIELD_LABEL[this.field.value] ?? this.field.value}的值`);
      select.append(option("", "选择…"));
      for (const [value, label] of Object.entries(enums))
        select.append(option(value, label));
      select.value = raw;
      select.addEventListener("change", () =>
        this.updateAttrs({ raw: select.value })
      );
      this.value = select;
      this.valueSlot = new ControlSlot(select, `${FIELD_LABEL[this.field.value] ?? this.field.value}的值`);
    } else {
      const input = literalInput(`${FIELD_LABEL[this.field.value] ?? this.field.value}的值`);
      input.value = raw;
      input.placeholder = operator === "in" || operator === "notIn"
        ? "多个值用顿号分隔"
        : "输入值";
      const definition = queryFieldsFor(this.owner, "filter").includes(this.field.value)
        ? this.field.value
        : "";
      if (definition && ["year", "score", "rank", "comments", "collects", "sort", "disc"].includes(definition))
        input.type = "number";
      input.addEventListener("input", () =>
        this.updateAttrs({ raw: input.value })
      );
      this.value = input;
      this.valueSlot = new ControlSlot(
        input,
        `${FIELD_LABEL[this.field.value] ?? this.field.value}的值`,
        {
          placeholder: input.placeholder,
          quote: input.type !== "number" && operator !== "in" && operator !== "notIn",
          closeOnChange: false,
        },
      );
    }
    this.valueSlot.panel.append(this.parameter.dom);
    this.valueHost.replaceChildren(this.valueSlot.dom);
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    if (this.value && this.value.value !== node.attrs.raw)
      this.value.value = String(node.attrs.raw);
    this.parameter.sync(String(node.attrs.parameter ?? ""));
    this.fieldSlot.sync();
    this.operatorSlot.sync();
    this.valueSlot?.sync();
    return true;
  }
}

class ConditionGroupView implements NodeView {
  readonly dom = document.createElement("div");
  readonly contentDOM = document.createElement("div");
  private readonly mode = selectControl("条件组匹配方式");
  private readonly modeSlot = new ControlSlot(this.mode, "条件组匹配方式");
  private readonly addCondition = document.createElement("button");
  private readonly addGroup = document.createElement("button");
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly owner: Owner,
  ) {
    this.node = node;
    this.dom.className = "query-condition-group";
    this.contentDOM.className = "query-condition-terms";
    this.mode.append(
      option("all", "全部满足"),
      option("any", "任一满足"),
      option("not", "排除"),
    );
    this.addCondition.type = "button";
    this.addCondition.textContent = "＋ 条件";
    this.addCondition.className = "query-inline-action";
    this.addGroup.type = "button";
    this.addGroup.textContent = "＋ 条件组";
    this.addGroup.className = "query-inline-action";
    this.mode.addEventListener("change", () => {
      if (this.mode.value === "not" && this.node.childCount !== 1) {
        this.mode.value = String(this.node.attrs.mode);
        return;
      }
      this.updateAttrs({ mode: this.mode.value });
    });
    this.addCondition.addEventListener("click", () => this.insert(false));
    this.addGroup.addEventListener("click", () => this.insert(true));
    const header = document.createElement("div");
    header.className = "query-condition-group-head";
    header.append(
      queryWord("其中"),
      this.modeSlot.dom,
      this.addCondition,
      this.addGroup,
      removeButton(() => this.remove(), "移除条件组"),
    );
    this.dom.append(header, this.contentDOM);
    this.sync(node);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== "condition_group") return false;
    this.node = node;
    this.sync(node);
    return true;
  }

  stopEvent(event: Event): boolean {
    return stopControlEvent(event);
  }

  ignoreMutation(mutation: { target: Node }): boolean {
    return !this.contentDOM.contains(mutation.target);
  }

  private sync(node: ProseMirrorNode): void {
    this.mode.value = String(node.attrs.mode);
    this.modeSlot.sync();
    const locked = this.mode.value === "not";
    this.addCondition.disabled = locked;
    this.addGroup.disabled = locked;
  }

  private updateAttrs(patch: Record<string, unknown>): void {
    const position = this.getPos();
    if (position === undefined) return;
    const current = this.view.state.doc.nodeAt(position);
    if (current)
      this.view.dispatch(this.view.state.tr.setNodeMarkup(
        position,
        undefined,
        { ...current.attrs, ...patch },
      ));
  }

  private insert(group: boolean): void {
    const position = this.getPos();
    if (position === undefined || this.node.attrs.mode === "not") return;
    const condition = queryEditorSchema.node("condition", defaultConditionAttrs(this.owner));
    const child = group
      ? queryEditorSchema.node("condition_group", { mode: "all" }, [condition])
      : condition;
    this.view.dispatch(this.view.state.tr.insert(
      position + this.node.nodeSize - 1,
      child,
    ).scrollIntoView());
  }

  private remove(): void {
    const position = this.getPos();
    if (position === undefined) return;
    this.view.dispatch(this.view.state.tr.delete(position, position + this.node.nodeSize));
  }
}

class RelationView extends ClauseView {
  private readonly relation = selectControl("关联类型");
  private readonly exists = selectControl("是否存在关联");
  private readonly relationSlot = new ControlSlot(this.relation, "关联类型");
  private readonly existsSlot = new ControlSlot(this.exists, "是否存在关联");
  private readonly entity = document.createElement("button");
  private readonly factDetails = document.createElement("details");
  private readonly factList = document.createElement("div");
  private readonly factAdd = document.createElement("button");
  private mappings: Mappings | undefined;
  private renderedFactConditions = "";

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    private readonly owner: Owner,
    private readonly options: QueryEditorViewOptions,
  ) {
    super("relation", node, view, getPos);
    for (const item of queryRelationOptions(owner))
      this.relation.append(option(item.value, item.label));
    this.relation.value = String(node.attrs.selection);
    if (!this.relation.value) this.relation.selectedIndex = 0;
    this.exists.append(option("true", "存在"), option("false", "不存在"));
    this.exists.value = String(Boolean(node.attrs.exists));
    this.relationSlot.sync();
    this.existsSlot.sync();
    this.entity.type = "button";
    this.entity.className = "query-slot query-entity-slot";
    this.entity.addEventListener("click", () => void this.pickSelected());
    this.factDetails.className = "query-relation-details";
    const factSummary = document.createElement("summary");
    factSummary.className = "query-slot";
    factSummary.textContent = "关系属性";
    this.factList.className = "query-fact-conditions";
    this.factAdd.type = "button";
    this.factAdd.className = "query-fact-add";
    this.factAdd.textContent = "＋ 属性条件";
    this.factAdd.addEventListener("click", () => this.addFactCondition());
    this.factDetails.append(factSummary, this.factList, this.factAdd);
    this.relation.addEventListener("change", () => {
      this.updateAttrs({
        selection: this.relation.value,
        related: "",
        factConditions: [],
      });
    });
    this.exists.addEventListener("change", () =>
      this.updateAttrs({ exists: this.exists.value === "true" })
    );
    this.syncEntity(String(node.attrs.related));
    this.dom.append(
      queryWord("关联"),
      this.relationSlot.dom,
      this.existsSlot.dom,
      this.entity,
      this.factDetails,
      removeButton(() => this.remove(), "移除关联"),
    );
    this.renderFactConditions();
    void options.mappings?.().then((mappings) => {
      this.mappings = mappings;
      this.renderedFactConditions = "";
      this.renderFactConditions();
    }).catch((error: unknown) => options.reportError(error));
  }

  private factKind(): QueryFactKind {
    return this.relation.value.split("|", 1)[0] as QueryFactKind;
  }

  private factConditions(): EditableFactCondition[] {
    return Array.isArray(this.node.attrs.factConditions)
      ? (this.node.attrs.factConditions as EditableFactCondition[])
      : [];
  }

  private addFactCondition(): void {
    const kind = this.factKind();
    const field = queryFactFields(kind, "filter")[0] ?? "";
    if (!field) return;
    const next = [
      ...this.factConditions(),
      {
        field,
        operator: queryFactConditionOperators(kind, field)[0] ?? "",
        raw: "",
        parameter: "",
      },
    ];
    this.updateAttrs({ factConditions: next });
  }

  private updateFactCondition(
    index: number,
    patch: Partial<EditableFactCondition>,
    rerender: boolean,
  ): void {
    const next = this.factConditions().map((condition, current) =>
      current === index ? { ...condition, ...patch } : condition
    );
    if (!rerender) {
      this.renderedFactConditions = `${this.factKind()}:${JSON.stringify(next)}:${Boolean(this.mappings)}`;
    }
    this.updateAttrs({ factConditions: next });
  }

  private removeFactCondition(index: number): void {
    this.updateAttrs({
      factConditions: this.factConditions().filter((_, current) => current !== index),
    });
  }

  private renderFactConditions(): void {
    const kind = this.factKind();
    const fields = queryFactFields(kind, "filter");
    const conditions = this.factConditions();
    const signature = `${kind}:${JSON.stringify(conditions)}:${Boolean(this.mappings)}`;
    if (signature === this.renderedFactConditions) return;
    this.renderedFactConditions = signature;
    this.factDetails.hidden = !fields.length;
    this.factAdd.disabled = !fields.length;
    const rows = conditions.map((condition, index) => {
      const host = document.createElement("div");
      host.className = "query-fact-condition";
      const field = selectControl("关系属性");
      for (const name of fields)
        field.append(option(name, FACT_FIELD_LABEL[name] ?? name));
      field.value = condition.field;
      if (!field.value) field.selectedIndex = 0;
      const operator = selectControl("关系属性比较方式");
      const fillOperators = (): void => {
        operator.replaceChildren();
        for (const name of queryFactConditionOperators(kind, field.value))
          operator.append(option(name, OPERATOR_LABEL[name] ?? name));
        operator.value = condition.operator;
        if (!operator.value) operator.selectedIndex = 0;
      };
      fillOperators();
      const valueHost = document.createElement("span");
      const parameter = new ParameterSlot(
        condition.parameter ?? "",
        () => `${field.value || "relation"}Value${index + 1}`,
        (name) => this.updateFactCondition(index, { parameter: name }, false),
      );
      const fillValue = (): void => {
        valueHost.replaceChildren();
        const parameterAvailable = ![
          "in", "notIn", "isNull", "isNotNull", "isMissing", "isPresent",
        ].includes(operator.value);
        parameter.setAvailable(parameterAvailable);
        if (!parameterAvailable) parameter.sync("");
        if (["isNull", "isNotNull", "isMissing", "isPresent"].includes(operator.value))
          return;
        const labels = factEnumValues(kind, field.value, this.mappings);
        if (labels) {
          const input = selectControl(`${FACT_FIELD_LABEL[field.value] ?? field.value}的值`);
          const multiple = operator.value === "in" || operator.value === "notIn";
          input.multiple = multiple;
          if (multiple) input.size = Math.min(4, Math.max(2, Object.keys(labels).length));
          else input.append(option("", "选择…"));
          for (const [value, label] of Object.entries(labels))
            input.append(option(value, label));
          const selected = new Set(condition.raw.split("、").filter(Boolean));
          for (const item of input.options)
            item.selected = selected.has(item.value) || (!multiple && item.value === condition.raw);
          input.addEventListener("change", () => {
            const raw = multiple
              ? [...input.selectedOptions].map((item) => item.value).join("、")
              : input.value;
            this.updateFactCondition(index, { raw }, false);
          });
          valueHost.append(input);
          return;
        }
        const input = literalInput(`${FACT_FIELD_LABEL[field.value] ?? field.value}的值`);
        input.value = condition.raw;
        input.placeholder = operator.value === "in" || operator.value === "notIn"
          ? "多个值用顿号分隔"
          : "输入值";
        input.addEventListener("input", () =>
          this.updateFactCondition(index, { raw: input.value }, false)
        );
        valueHost.append(input);
      };
      fillValue();
      field.addEventListener("change", () => {
        const nextOperator = queryFactConditionOperators(kind, field.value)[0] ?? "";
        this.updateFactCondition(index, {
          field: field.value,
          operator: nextOperator,
          raw: "",
          parameter: "",
        }, true);
      });
      operator.addEventListener("change", () =>
        this.updateFactCondition(index, {
          operator: operator.value,
          raw: "",
          parameter: "",
        }, true)
      );
      host.append(
        field,
        operator,
        parameter.dom,
        valueHost,
        removeButton(() => this.removeFactCondition(index), "移除关系属性条件"),
      );
      return host;
    });
    this.factList.replaceChildren(...rows);
  }

  private syncEntity(ref: string): void {
    this.setEntityLabel(ref ? "读取名称…" : "选择当前实体", Boolean(ref));
    if (!ref) return;
    void this.options.resolveEntityLabel?.(ref).then((label) => {
      if (String(this.node.attrs.related) === ref) this.setEntityLabel(label, true);
    }).catch((error: unknown) => this.options.reportError(error));
  }

  private setEntityLabel(label: string, selected: boolean): void {
    this.entity.textContent = label;
    this.entity.setAttribute(
      "aria-label",
      `${label}（${selected ? "更换关联实体" : "选择关联实体"}）`,
    );
  }

  private async pickSelected(): Promise<void> {
    try {
      const selected = await this.options.selectedEntity?.();
      if (!selected) throw new TypeError("请先在星图或搜索结果中选择一个实体");
      const expected = queryRelationTargetOwner(this.relation.value);
      const owner = selected.ref.split(":", 1)[0];
      if (owner !== expected)
        throw new TypeError(`请选择一个${OWNER_LABEL[expected]}`);
      this.setEntityLabel(selected.label, true);
      this.updateAttrs({ related: selected.ref });
    } catch (error) {
      this.options.reportError(error);
    }
  }

  override update(node: ProseMirrorNode): boolean {
    const previous = String(this.node.attrs.related);
    if (!super.update(node)) return false;
    this.relation.value = String(node.attrs.selection);
    this.exists.value = String(Boolean(node.attrs.exists));
    this.relationSlot.sync();
    this.existsSlot.sync();
    if (previous !== node.attrs.related) this.syncEntity(String(node.attrs.related));
    this.renderFactConditions();
    return true;
  }
}

class ProjectionView extends ClauseView {
  private readonly summary = document.createElement("summary");
  private readonly list = document.createElement("span");

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    owner: Owner,
  ) {
    super("projection", node, view, getPos);
    const details = document.createElement("details");
    details.className = "query-slot-editor query-multi-slot";
    this.summary.className = "query-slot";
    this.list.className = "query-slot-popover query-choice-grid";
    const fields = ["ref", ...queryProjectFields(owner)];
    for (const field of fields) {
      const item = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "返回信息";
      input.value = field;
      input.checked = (node.attrs.columns as string[]).includes(field);
      input.disabled = field === "ref";
      input.addEventListener("change", () => {
        const columns = [...this.list.querySelectorAll<HTMLInputElement>("input:checked")]
          .map((control) => control.value);
        this.updateAttrs({ columns });
        this.syncSummary(columns);
      });
      item.append(input, document.createTextNode(
        field === "ref" ? "条目" : FIELD_LABEL[field] ?? field,
      ));
      this.list.append(item);
    }
    this.syncSummary(node.attrs.columns as string[]);
    details.append(this.summary, this.list);
    this.dom.append(
      queryWord("返回"),
      details,
      removeButton(() => this.remove(), "移除返回设置"),
    );
  }

  private syncSummary(columns: string[]): void {
    this.summary.textContent = columns
      .map((field) => field === "ref" ? "条目" : FIELD_LABEL[field] ?? field)
      .join("、") || "选择信息";
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    const columns = node.attrs.columns as string[];
    for (const input of this.list.querySelectorAll<HTMLInputElement>("input"))
      input.checked = columns.includes(input.value);
    this.syncSummary(columns);
    return true;
  }
}

class SortView extends ClauseView {
  private readonly field = selectControl("排序字段");
  private readonly direction = selectControl("排序方向");
  private readonly nulls = selectControl("空值位置");
  private readonly fieldSlot = new ControlSlot(this.field, "排序字段");
  private readonly directionSlot = new ControlSlot(this.direction, "排序方向");
  private readonly nullsSlot = new ControlSlot(this.nulls, "空值位置");

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    fields: Array<{ value: string; label: string }>,
  ) {
    super("sort", node, view, getPos);
    for (const field of fields)
      this.field.append(option(field.value, field.label));
    this.direction.append(option("desc", "从高到低"), option("asc", "从低到高"));
    this.nulls.append(option("last", "空值最后"), option("first", "空值最前"));
    this.field.value = String(node.attrs.field);
    if (!this.field.value) this.field.selectedIndex = 0;
    this.direction.value = String(node.attrs.direction);
    this.nulls.value = String(node.attrs.nulls);
    this.fieldSlot.sync();
    this.directionSlot.sync();
    this.nullsSlot.sync();
    this.field.addEventListener("change", () => {
      const direction = defaultSortDirection(this.field.value);
      this.direction.value = direction;
      this.updateAttrs({ field: this.field.value, direction });
    });
    this.direction.addEventListener("change", () =>
      this.updateAttrs({ direction: this.direction.value })
    );
    this.nulls.addEventListener("change", () =>
      this.updateAttrs({ nulls: this.nulls.value })
    );
    this.dom.append(
      queryWord("按"),
      this.fieldSlot.dom,
      this.directionSlot.dom,
      this.nullsSlot.dom,
      removeButton(() => this.remove(), "移除排序"),
    );
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.field.value = String(node.attrs.field);
    this.direction.value = String(node.attrs.direction);
    this.nulls.value = String(node.attrs.nulls);
    this.fieldSlot.sync();
    this.directionSlot.sync();
    this.nullsSlot.sync();
    return true;
  }
}

class LimitView extends ClauseView {
  private readonly value = literalInput("结果条数");
  private readonly valueSlot = new ControlSlot(this.value, "结果条数", {
    placeholder: "输入条数",
    closeOnChange: false,
  });

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    super("limit", node, view, getPos);
    this.value.type = "number";
    this.value.min = "1";
    this.value.step = "1";
    this.value.size = 5;
    this.value.value = String(node.attrs.raw);
    this.valueSlot.sync();
    this.value.addEventListener("input", () =>
      this.updateAttrs({ raw: this.value.value })
    );
    this.dom.append(
      queryWord("限制"),
      this.valueSlot.dom,
      queryWord("条"),
      removeButton(() => this.remove(), "移除结果上限"),
    );
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    if (this.value.value !== node.attrs.raw) this.value.value = String(node.attrs.raw);
    this.valueSlot.sync();
    return true;
  }
}

export class QueryDocumentEditor {
  private readonly view: EditorView;
  private readonly entityLabels = new Map<string, string>();

  constructor(
    mount: HTMLElement,
    private readonly options: QueryEditorViewOptions,
  ) {
    this.view = new EditorView(mount, {
      state: createQueryEditorState(options.doc),
      nodeViews: this.nodeViews(),
      dispatchTransaction: (transaction) => {
        const previousOwner = this.owner();
        const previousSortFields = this.sortFieldsSignature(this.view.state.doc);
        const state = this.view.state.apply(transaction);
        this.view.updateState(state);
        if (
          previousOwner !== this.owner() ||
          previousSortFields !== this.sortFieldsSignature(state.doc)
        )
          this.view.setProps({ nodeViews: this.nodeViews() });
        if (transaction.docChanged) {
          const result = lowerQueryEditorDocument(state.doc);
          this.showDiagnostics(result.diagnostics);
          this.options.onChange(result);
        }
      },
      clipboardTextSerializer: (slice) => this.readableSlice(slice),
      handleDOMEvents: {
        copy: (view, event) => this.copy(view, event as ClipboardEvent),
        paste: (view, event) => this.paste(view, event as ClipboardEvent),
      },
      attributes: {
        class: "query-document",
        "aria-label": "结构化查询",
        spellcheck: "false",
      },
    });
    const initial = lowerQueryEditorDocument(this.view.state.doc);
    this.showDiagnostics(initial.diagnostics);
    options.onChange(initial);
  }

  get doc(): ProseMirrorNode {
    return this.view.state.doc;
  }

  focus(): void {
    this.view.focus();
  }

  undo(): boolean {
    return undo(this.view.state, this.view.dispatch);
  }

  redo(): boolean {
    return redo(this.view.state, this.view.dispatch);
  }

  replace(doc: ProseMirrorNode): void {
    this.view.updateState(createQueryEditorState(doc));
    this.view.setProps({ nodeViews: this.nodeViews() });
    const result = lowerQueryEditorDocument(doc);
    this.showDiagnostics(result.diagnostics);
    this.options.onChange(result);
  }

  replaceTransaction(doc: ProseMirrorNode): void {
    this.view.dispatch(
      this.view.state.tr.replaceWith(
        0,
        this.view.state.doc.content.size,
        doc.content,
      ).scrollIntoView(),
    );
  }

  has(name: ClauseName): boolean {
    let found = false;
    this.view.state.doc.forEach((node) => {
      if (node.type.name === name) found = true;
    });
    return found;
  }

  insert(name: ClauseName): boolean {
    if (["search", "projection", "aggregate", "limit"].includes(name) && this.has(name))
      return false;
    if (name === "projection" && this.has("aggregate")) return false;
    const owner = this.owner();
    const attrs = this.defaultAttrs(name, owner);
    const node = name === "condition_group"
      ? queryEditorSchema.node("condition_group", { mode: "all" }, [
          queryEditorSchema.node("condition", defaultConditionAttrs(owner)),
        ])
      : queryEditorSchema.node(name, attrs);
    const transaction = this.view.state.tr;
    if (name === "aggregate") {
      this.deleteClauses(transaction, new Set(["projection", "sort"]));
    }
    this.insertNode(name, node, transaction);
    return true;
  }

  addFilter(field: string, operator: string, raw = ""): boolean {
    if (this.view.state.doc.firstChild?.type.name !== "find") return false;
    const owner = this.owner();
    if (!queryConditionOperators(owner, field).includes(operator)) return false;
    this.insertNode("condition", queryEditorSchema.node("condition", {
      field,
      operator,
      raw,
      parameter: "",
    }), this.view.state.tr);
    return true;
  }

  setSort(field: string, direction: "asc" | "desc"): boolean {
    if (this.view.state.doc.firstChild?.type.name !== "find") return false;
    const choices = new Set(this.sortFields(this.owner()).map((item) => item.value));
    if (!choices.has(field)) return false;
    let position: number | null = null;
    this.view.state.doc.forEach((node, offset) => {
      if (position === null && node.type.name === "sort" && node.attrs.field === field)
        position = offset;
    });
    if (position !== null) {
      const current = this.view.state.doc.nodeAt(position);
      if (!current) return false;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(position, undefined, {
        ...current.attrs,
        direction,
      }).scrollIntoView());
      return true;
    }
    this.insertNode("sort", queryEditorSchema.node("sort", {
      field,
      direction,
      nulls: "last",
    }), this.view.state.tr);
    return true;
  }

  addGroup(field: string): boolean {
    if (
      this.view.state.doc.firstChild?.type.name !== "find" ||
      !queryGroupFields(this.owner()).includes(field)
    ) return false;
    let aggregatePosition: number | null = null;
    this.view.state.doc.forEach((node, offset) => {
      if (node.type.name === "aggregate") aggregatePosition = offset;
    });
    if (aggregatePosition !== null) {
      const current = this.view.state.doc.nodeAt(aggregatePosition);
      if (!current) return false;
      const groupBy = Array.isArray(current.attrs.groupBy)
        ? (current.attrs.groupBy as string[])
        : [];
      if (groupBy.includes(field)) return true;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(
        aggregatePosition,
        undefined,
        { ...current.attrs, groupBy: [...groupBy, field] },
      ).scrollIntoView());
      return true;
    }
    const transaction = this.view.state.tr;
    this.deleteClauses(transaction, new Set(["projection", "sort"]));
    this.insertNode("aggregate", queryEditorSchema.node("aggregate", {
      groupBy: [field],
      metrics: [{ function: "count" }],
      having: [],
    }), transaction);
    this.setSort("count", "desc");
    return true;
  }

  destroy(): void {
    this.view.destroy();
  }

  private insertNode(
    name: ClauseName,
    node: ProseMirrorNode,
    transaction: Transaction,
  ): void {
    const position = queryClauseInsertionPosition(
      transaction.doc,
      name,
      transaction.selection.from,
    );
    transaction.insert(position, node);
    transaction.setSelection(NodeSelection.create(transaction.doc, position));
    this.view.dispatch(transaction.scrollIntoView());
    this.view.focus();
  }

  private deleteClauses(
    transaction: Transaction,
    names: ReadonlySet<string>,
  ): void {
    const ranges: Array<{ from: number; to: number }> = [];
    transaction.doc.forEach((node, offset) => {
      if (names.has(node.type.name))
        ranges.push({ from: offset, to: offset + node.nodeSize });
    });
    for (const range of ranges.reverse())
      transaction.delete(range.from, range.to);
  }

  private owner(): Owner {
    return String(this.view.state.doc.firstChild?.attrs.owner ?? "subject") as Owner;
  }

  private async resolveEntityLabel(ref: string): Promise<string> {
    const previous = this.entityLabels.get(ref);
    if (previous) return previous;
    const label = await this.options.resolveEntityLabel?.(ref) ?? ref;
    this.entityLabels.set(ref, label);
    return label;
  }

  private readableSlice(slice: Slice): string {
    const children: ProseMirrorNode[] = [];
    slice.content.forEach((node) => children.push(node));
    try {
      const first = children[0]?.type.name;
      const content = first === "find" || first === "recipe" || first === "query_bundle"
        ? children
        : this.view.state.doc.firstChild?.type.name === "find"
          ? [this.view.state.doc.firstChild, ...children]
          : children;
      const doc = queryEditorSchema.node("doc", null, content);
      return readableQueryEditorDocument(
        doc,
        (ref) => this.entityLabels.get(ref) ?? "已选实体",
      );
    } catch {
      return readableQueryEditorDocument(
        this.view.state.doc,
        (ref) => this.entityLabels.get(ref) ?? "已选实体",
      );
    }
  }

  private copy(view: EditorView, event: ClipboardEvent): boolean {
    if (!event.clipboardData || stopControlEvent(event)) return false;
    const slice = view.state.selection.content();
    if (!slice.size) return false;
    event.clipboardData.setData(
      "application/x-bangumi-atlas-query+json",
      JSON.stringify(slice.toJSON()),
    );
    event.clipboardData.setData("text/plain", this.readableSlice(slice));
    event.preventDefault();
    return true;
  }

  private paste(view: EditorView, event: ClipboardEvent): boolean {
    if (!event.clipboardData || stopControlEvent(event)) return false;
    const source = event.clipboardData.getData(
      "application/x-bangumi-atlas-query+json",
    );
    if (!source) return false;
    event.preventDefault();
    if (source.length > MAX_STRUCTURED_CLIPBOARD_BYTES) {
      this.options.reportError(new TypeError("粘贴的查询内容过长"));
      return true;
    }
    try {
      const slice = Slice.fromJSON(queryEditorSchema, JSON.parse(source));
      view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
      return true;
    } catch {
      this.options.reportError(new TypeError("粘贴的查询结构无效"));
      return true;
    }
  }

  private showDiagnostics(
    diagnostics: LoweredQueryEditorDocument["diagnostics"],
  ): void {
    const children = [...this.view.dom.children] as HTMLElement[];
    for (const child of children) {
      child.classList.remove("query-clause-invalid");
      child.removeAttribute("aria-invalid");
      child.removeAttribute("data-query-error");
      child.removeAttribute("title");
    }
    for (const diagnostic of diagnostics) {
      const child = children[diagnostic.clause];
      if (!child) continue;
      child.classList.add("query-clause-invalid");
      child.setAttribute("aria-invalid", "true");
      child.dataset.queryError = diagnostic.message;
      child.title = diagnostic.message;
    }
  }

  private aggregate(doc = this.view.state.doc): ExplorerAggregate | null {
    let aggregate: ExplorerAggregate | null = null;
    doc.forEach((node) => {
      if (node.type.name === "aggregate") {
        aggregate = {
          groupBy: Array.isArray(node.attrs.groupBy)
            ? (node.attrs.groupBy as string[])
            : [],
          metrics: Array.isArray(node.attrs.metrics)
            ? (node.attrs.metrics as ExplorerAggregateMetric[])
            : [],
        };
      }
    });
    return aggregate;
  }

  private sortFields(owner: Owner): Array<{ value: string; label: string }> {
    const aggregate = this.aggregate();
    return aggregate
      ? queryStatisticColumns(aggregate)
      : querySortFields(owner).map((field) => ({
          value: field,
          label: FIELD_LABEL[field] ?? field,
        }));
  }

  private sortFieldsSignature(doc: ProseMirrorNode): string {
    const aggregate = this.aggregate(doc);
    return JSON.stringify(aggregate
      ? queryStatisticColumns(aggregate)
      : []);
  }

  private defaultAttrs(name: ClauseName, owner: Owner): Record<string, unknown> {
    if (name === "search") return {
      scope: queryTextScopes(owner)[0]?.value ?? "lookup",
      raw: "",
    };
    if (name === "condition") {
      return defaultConditionAttrs(owner);
    }
    if (name === "condition_group") return { mode: "all" };
    if (name === "relation") return {
      selection: queryRelationOptions(owner)[0]?.value ?? "",
      exists: true,
      related: "",
      factConditions: [],
    };
    if (name === "projection") return {
      columns: ["ref", ...queryProjectFields(owner).slice(0, 6)],
    };
    if (name === "aggregate") return {
      groupBy: [],
      metrics: [{ function: "count" }],
      having: [],
    };
    if (name === "sort") {
      const field = this.sortFields(owner)[0]?.value ?? "";
      return { field, direction: defaultSortDirection(field), nulls: "last" };
    }
    return { raw: "200" };
  }

  private nodeViews(): Record<string, (
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
  ) => NodeView> {
    const owner = this.view?.state
      ? this.owner()
      : String(this.options.doc.firstChild?.attrs.owner ?? "subject") as Owner;
    const nodeViews: Record<string, (
      node: ProseMirrorNode,
      view: EditorView,
      getPos: () => number | undefined,
    ) => NodeView> = {
      find: (node, view, getPos) => new FindView(node, view, getPos),
      search: (node, view, getPos) => new SearchView(node, view, getPos, owner),
      condition: (node, view, getPos) =>
        new ConditionView(node, view, getPos, owner, this.options),
      condition_group: (node, view, getPos) =>
        new ConditionGroupView(node, view, getPos, owner),
      relation: (node, view, getPos) =>
        new RelationView(node, view, getPos, owner, {
          ...this.options,
          resolveEntityLabel: (ref) => this.resolveEntityLabel(ref),
        }),
      projection: (node, view, getPos) =>
        new ProjectionView(node, view, getPos, owner),
      aggregate: (node, view, getPos) =>
        new AggregateView(node, view, getPos, owner),
      sort: (node, view, getPos) =>
        new SortView(node, view, getPos, this.sortFields(owner)),
      limit: (node, view, getPos) => new LimitView(node, view, getPos),
      recipe: (node, view, getPos) =>
        new RecipeView(node, view, getPos, {
          ...this.options,
          resolveEntityLabel: (ref) => this.resolveEntityLabel(ref),
        }),
      query_bundle: () => new AdvancedBundleView(),
      query_section: (node, view, getPos) =>
        new AdvancedSectionView(node, view, getPos),
    };
    for (const name of Object.values(QUERY_OPERATOR_NODE))
      nodeViews[name] = (node, view, getPos) =>
        new AdvancedOperatorView(node, view, getPos);
    return nodeViews;
  }
}
