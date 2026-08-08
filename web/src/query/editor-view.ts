import type { Node as ProseMirrorNode } from "prosemirror-model";
import { redo, undo } from "prosemirror-history";
import type { NodeView } from "prosemirror-view";
import { EditorView } from "prosemirror-view";

import type { Owner } from "./contract";
import {
  createQueryEditorState,
  lowerQueryEditorDocument,
  queryEditorSchema,
  type LoweredQueryEditorDocument,
} from "./editor";
import {
  FIELD_LABEL,
  COMMON_FIELDS,
  INTERNAL_FIELDS,
  OPERATOR_LABEL,
  OWNER_LABEL,
  defaultSortDirection,
  enumValuesFor,
  queryConditionOperators,
  queryFieldsFor,
  queryProjectFields,
  queryRelationOptions,
  queryRelationTargetOwner,
  querySortFields,
  queryTextScopes,
} from "./workbench-model";

export interface SelectedQueryEntity {
  ref: string;
  label: string;
}

export interface QueryEditorViewOptions {
  doc: ProseMirrorNode;
  onChange(result: LoweredQueryEditorDocument): void;
  selectedEntity?(): Promise<SelectedQueryEntity | null>;
  resolveEntityLabel?(ref: string): Promise<string>;
  reportError(error: unknown): void;
}

type ClauseName = "search" | "condition" | "relation" | "projection" |
  "sort" | "limit";

function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function selectControl(label: string): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "query-slot";
  select.name = label;
  select.setAttribute("aria-label", label);
  return select;
}

function removeButton(remove: () => void, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "query-clause-remove";
  button.textContent = "×";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", remove);
  return button;
}

function row(name: string): HTMLDivElement {
  const dom = document.createElement("div");
  dom.className = `query-clause query-clause-${name}`;
  return dom;
}

function literalInput(label: string): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "query-slot query-value-slot";
  input.name = label;
  input.setAttribute("aria-label", label);
  input.autocomplete = "off";
  input.size = 8;
  return input;
}

function stopControlEvent(event: Event): boolean {
  return event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLButtonElement ||
    event.target instanceof HTMLDetailsElement ||
    event.target instanceof HTMLLabelElement;
}

class ClauseView implements NodeView {
  readonly dom: HTMLElement;
  protected node: ProseMirrorNode;

  constructor(
    name: string,
    node: ProseMirrorNode,
    protected readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = row(name);
    this.node = node;
  }

  protected updateAttrs(patch: Record<string, unknown>): void {
    const position = this.getPos();
    if (position === undefined) return;
    const current = this.view.state.doc.nodeAt(position);
    if (!current) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(
      position,
      undefined,
      { ...current.attrs, ...patch },
    ));
  }

  protected remove(): void {
    const position = this.getPos();
    if (position === undefined) return;
    const current = this.view.state.doc.nodeAt(position);
    if (current)
      this.view.dispatch(this.view.state.tr.delete(position, position + current.nodeSize));
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    return true;
  }

  stopEvent(event: Event): boolean {
    return stopControlEvent(event);
  }

  ignoreMutation(): boolean {
    return true;
  }
}

class FindView extends ClauseView {
  private readonly owner = selectControl("查找对象");

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    super("find", node, view, getPos);
    for (const [value, label] of Object.entries(OWNER_LABEL))
      this.owner.append(option(value, label));
    this.owner.value = String(node.attrs.owner);
    this.owner.addEventListener("change", () =>
      this.updateAttrs({ owner: this.owner.value })
    );
    this.dom.append(document.createTextNode("查找"), this.owner);
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.owner.value = String(node.attrs.owner);
    return true;
  }
}

class SearchView extends ClauseView {
  private readonly scope = selectControl("搜索范围");
  private readonly value = literalInput("搜索文字");

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
    this.scope.addEventListener("change", () =>
      this.updateAttrs({ scope: this.scope.value })
    );
    this.value.addEventListener("input", () =>
      this.updateAttrs({ raw: this.value.value })
    );
    this.dom.append(
      document.createTextNode("搜索"),
      this.scope,
      this.value,
      removeButton(() => this.remove(), "移除搜索"),
    );
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.scope.value = String(node.attrs.scope);
    if (this.value.value !== node.attrs.raw) this.value.value = String(node.attrs.raw);
    return true;
  }
}

class ConditionView extends ClauseView {
  private readonly field = selectControl("条件字段");
  private readonly operator = selectControl("比较方式");
  private value: HTMLInputElement | HTMLSelectElement | null = null;
  private readonly valueHost = document.createElement("span");

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    private readonly owner: Owner,
  ) {
    super("condition", node, view, getPos);
    if (node.attrs.expression) {
      const summary = document.createElement("span");
      summary.className = "query-clause-summary";
      summary.textContent = "复合条件";
      this.dom.append(
        document.createTextNode("其中"),
        summary,
        removeButton(() => this.remove(), "移除复合条件"),
      );
      return;
    }
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
    this.field.addEventListener("change", () => {
      this.fillOperators();
      this.fillValue("");
      this.updateAttrs({
        field: this.field.value,
        operator: this.operator.value,
        raw: "",
      });
    });
    this.operator.addEventListener("change", () => {
      this.fillValue("");
      this.updateAttrs({ operator: this.operator.value, raw: "" });
    });
    this.fillOperators(String(node.attrs.operator));
    this.fillValue(String(node.attrs.raw));
    this.dom.append(
      document.createTextNode("其中"),
      this.field,
      this.operator,
      this.valueHost,
      removeButton(() => this.remove(), "移除条件"),
    );
  }

  private fillOperators(selected = ""): void {
    this.operator.replaceChildren();
    for (const name of queryConditionOperators(this.owner, this.field.value))
      this.operator.append(option(name, OPERATOR_LABEL[name] ?? name));
    this.operator.value = selected;
    if (!this.operator.value) this.operator.selectedIndex = 0;
  }

  private fillValue(raw: string): void {
    const operator = this.operator.value;
    if (["isNull", "isNotNull", "isMissing", "isPresent"].includes(operator)) {
      this.value = null;
      this.valueHost.replaceChildren();
      return;
    }
    const enums = enumValuesFor(this.owner, this.field.value);
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
    }
    this.valueHost.replaceChildren(this.value);
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    if (!node.attrs.expression && this.value && this.value.value !== node.attrs.raw)
      this.value.value = String(node.attrs.raw);
    return true;
  }
}

class RelationView extends ClauseView {
  private readonly relation = selectControl("关联类型");
  private readonly exists = selectControl("是否存在关联");
  private readonly entity = document.createElement("button");

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
    this.entity.type = "button";
    this.entity.className = "query-slot query-entity-slot";
    this.entity.addEventListener("click", () => void this.pickSelected());
    this.relation.addEventListener("change", () =>
      this.updateAttrs({ selection: this.relation.value, related: "" })
    );
    this.exists.addEventListener("change", () =>
      this.updateAttrs({ exists: this.exists.value === "true" })
    );
    this.syncEntity(String(node.attrs.related));
    this.dom.append(
      document.createTextNode("关联"),
      this.relation,
      this.exists,
      this.entity,
      removeButton(() => this.remove(), "移除关联"),
    );
  }

  private syncEntity(ref: string): void {
    this.entity.textContent = ref ? "读取名称…" : "选择当前实体";
    this.entity.setAttribute("aria-label", ref ? "更换关联实体" : "选择关联实体");
    if (!ref) return;
    void this.options.resolveEntityLabel?.(ref).then((label) => {
      if (String(this.node.attrs.related) === ref) this.entity.textContent = label;
    }).catch((error: unknown) => this.options.reportError(error));
  }

  private async pickSelected(): Promise<void> {
    try {
      const selected = await this.options.selectedEntity?.();
      if (!selected) throw new TypeError("请先在星图或搜索结果中选择一个实体");
      const expected = queryRelationTargetOwner(this.relation.value);
      const owner = selected.ref.split(":", 1)[0];
      if (owner !== expected)
        throw new TypeError(`请选择一个${OWNER_LABEL[expected]}`);
      this.entity.textContent = selected.label;
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
    if (previous !== node.attrs.related) this.syncEntity(String(node.attrs.related));
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
    details.className = "query-slot-menu";
    this.summary.className = "query-slot";
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
      document.createTextNode("返回"),
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

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    owner: Owner,
  ) {
    super("sort", node, view, getPos);
    for (const field of querySortFields(owner))
      this.field.append(option(field, FIELD_LABEL[field] ?? field));
    this.direction.append(option("desc", "从高到低"), option("asc", "从低到高"));
    this.field.value = String(node.attrs.field);
    if (!this.field.value) this.field.selectedIndex = 0;
    this.direction.value = String(node.attrs.direction);
    this.field.addEventListener("change", () => {
      const direction = defaultSortDirection(this.field.value);
      this.direction.value = direction;
      this.updateAttrs({ field: this.field.value, direction });
    });
    this.direction.addEventListener("change", () =>
      this.updateAttrs({ direction: this.direction.value })
    );
    this.dom.append(
      document.createTextNode("按"),
      this.field,
      this.direction,
      removeButton(() => this.remove(), "移除排序"),
    );
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.field.value = String(node.attrs.field);
    this.direction.value = String(node.attrs.direction);
    return true;
  }
}

class LimitView extends ClauseView {
  private readonly value = literalInput("结果条数");

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    super("limit", node, view, getPos);
    this.value.type = "number";
    this.value.min = "1";
    this.value.max = "10000";
    this.value.step = "1";
    this.value.size = 5;
    this.value.value = String(node.attrs.raw);
    this.value.addEventListener("input", () =>
      this.updateAttrs({ raw: this.value.value })
    );
    this.dom.append(
      document.createTextNode("限制"),
      this.value,
      document.createTextNode("条"),
      removeButton(() => this.remove(), "移除结果上限"),
    );
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    if (this.value.value !== node.attrs.raw) this.value.value = String(node.attrs.raw);
    return true;
  }
}

class RecipeView extends ClauseView {
  private readonly text: HTMLInputElement | null;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    private readonly options: QueryEditorViewOptions,
  ) {
    super("recipe", node, view, getPos);
    const kind = String(node.attrs.kind);
    if (kind === "fullText") {
      this.text = literalInput("正文关键词");
      this.text.value = String(node.attrs.text);
      this.text.placeholder = "输入关键词";
      this.text.addEventListener("input", () =>
        this.updateAttrs({ text: this.text?.value ?? "" })
      );
      this.dom.append(
        document.createTextNode("搜索"),
        this.slot("所有正文"),
        document.createTextNode("包含"),
        this.text,
      );
      return;
    }
    this.text = null;
    const from = this.slot("读取名称…");
    const to = this.slot("读取名称…");
    const fromRef = String(node.attrs.from);
    const toRef = String(node.attrs.to);
    void Promise.all([
      options.resolveEntityLabel?.(fromRef) ?? Promise.resolve(fromRef),
      options.resolveEntityLabel?.(toRef) ?? Promise.resolve(toRef),
    ]).then(([fromLabel, toLabel]) => {
      if (String(this.node.attrs.from) === fromRef) from.textContent = fromLabel;
      if (String(this.node.attrs.to) === toRef) to.textContent = toLabel;
    }).catch((error: unknown) => options.reportError(error));
    this.dom.append(
      document.createTextNode("查找"),
      from,
      document.createTextNode(kind === "common" ? "与" : "到"),
      to,
      document.createTextNode(kind === "common" ? "的共同关联" : "的关系路径"),
    );
  }

  private slot(label: string): HTMLSpanElement {
    const slot = document.createElement("span");
    slot.className = "query-slot query-readonly-slot";
    slot.textContent = label;
    return slot;
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    if (this.text && this.text.value !== node.attrs.text)
      this.text.value = String(node.attrs.text);
    return true;
  }
}

class BundleView extends ClauseView {
  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    super("bundle", node, view, getPos);
    const titles = node.attrs.titles as string[];
    const label = document.createElement("span");
    label.className = "query-slot query-readonly-slot";
    label.textContent = titles.join("、") || "查询结果";
    this.dom.append(document.createTextNode("已保存查询"), label);
  }
}

export class QueryDocumentEditor {
  private readonly view: EditorView;

  constructor(
    mount: HTMLElement,
    private readonly options: QueryEditorViewOptions,
  ) {
    this.view = new EditorView(mount, {
      state: createQueryEditorState(options.doc),
      nodeViews: this.nodeViews(),
      dispatchTransaction: (transaction) => {
        const previousOwner = this.owner();
        const state = this.view.state.apply(transaction);
        this.view.updateState(state);
        if (previousOwner !== this.owner())
          this.view.setProps({ nodeViews: this.nodeViews() });
        if (transaction.docChanged)
          this.options.onChange(lowerQueryEditorDocument(state.doc));
      },
      attributes: {
        class: "query-document",
        "aria-label": "结构化查询",
        spellcheck: "false",
      },
    });
    options.onChange(lowerQueryEditorDocument(this.view.state.doc));
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
    this.options.onChange(lowerQueryEditorDocument(doc));
  }

  has(name: ClauseName): boolean {
    let found = false;
    this.view.state.doc.forEach((node) => {
      if (node.type.name === name) found = true;
    });
    return found;
  }

  insert(name: ClauseName): boolean {
    if (["search", "projection", "limit"].includes(name) && this.has(name))
      return false;
    const owner = this.owner();
    const attrs = this.defaultAttrs(name, owner);
    const node = queryEditorSchema.node(name, attrs);
    const rank: Record<string, number> = {
      find: 0,
      search: 1,
      condition: 2,
      relation: 3,
      projection: 4,
      sort: 5,
      limit: 6,
    };
    const targetRank = rank[name] ?? 99;
    let position = this.view.state.doc.content.size;
    this.view.state.doc.forEach((child, offset) => {
      if (position === this.view.state.doc.content.size &&
        (rank[child.type.name] ?? 99) > targetRank) position = offset;
    });
    this.view.dispatch(this.view.state.tr.insert(position, node).scrollIntoView());
    return true;
  }

  destroy(): void {
    this.view.destroy();
  }

  private owner(): Owner {
    return String(this.view.state.doc.firstChild?.attrs.owner ?? "subject") as Owner;
  }

  private defaultAttrs(name: ClauseName, owner: Owner): Record<string, unknown> {
    if (name === "search") return {
      scope: queryTextScopes(owner)[0]?.value ?? "lookup",
      raw: "",
    };
    if (name === "condition") {
      const available = new Set(queryFieldsFor(owner, "filter"));
      const field = [...COMMON_FIELDS[owner]]
        .find((item) => available.has(item)) ??
        [...available].find((item) => !INTERNAL_FIELDS.has(item)) ?? "";
      return {
        field,
        operator: queryConditionOperators(owner, field)[0] ?? "",
        raw: "",
        expression: null,
      };
    }
    if (name === "relation") return {
      selection: queryRelationOptions(owner)[0]?.value ?? "",
      exists: true,
      related: "",
    };
    if (name === "projection") return {
      columns: ["ref", ...queryProjectFields(owner).slice(0, 6)],
    };
    if (name === "sort") {
      const field = querySortFields(owner)[0] ?? "";
      return { field, direction: defaultSortDirection(field) };
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
    return {
      find: (node, view, getPos) => new FindView(node, view, getPos),
      search: (node, view, getPos) => new SearchView(node, view, getPos, owner),
      condition: (node, view, getPos) =>
        new ConditionView(node, view, getPos, owner),
      relation: (node, view, getPos) =>
        new RelationView(node, view, getPos, owner, this.options),
      projection: (node, view, getPos) =>
        new ProjectionView(node, view, getPos, owner),
      sort: (node, view, getPos) => new SortView(node, view, getPos, owner),
      limit: (node, view, getPos) => new LimitView(node, view, getPos),
      recipe: (node, view, getPos) =>
        new RecipeView(node, view, getPos, this.options),
      bundle: (node, view, getPos) => new BundleView(node, view, getPos),
    };
  }
}
