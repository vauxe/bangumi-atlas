import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { EditorView } from "prosemirror-view";

import {
  ClauseView,
  ControlSlot,
  literalInput,
  option,
  queryWord,
  selectControl,
  stopControlEvent,
} from "./editor-controls";
import type {
  LiteralValue,
  ParameterType,
  ParameterValues,
  QueryDocument,
  QueryOperator,
} from "./document";
import { OWNER_LABEL } from "./workbench-model";

function operatorText(operator: QueryOperator): string {
  switch (operator.kind) {
    case "scan": return `查找 ${OWNER_LABEL[operator.owner]}`;
    case "lookup": return `按名称定位 ${OWNER_LABEL[operator.owner]}`;
    case "fullText": return operator.target === "entity"
      ? `搜索 ${OWNER_LABEL[operator.owner]}正文`
      : "搜索关系说明";
    case "factLookup": return "读取完整关系";
    case "values": return `使用 ${operator.rows.length} 组指定值`;
    case "filter": return "其中满足条件";
    case "project": return `返回 ${operator.columns.length} 项信息`;
    case "matchFact": return "关联完整事实";
    case "followRef":
      return `沿${operator.direction === "forward" ? "正向" : "反向"}引用关联`;
    case "aggregate": return `统计 ${operator.metrics.length} 项指标`;
    case "path": return `查找不超过 ${operator.maxHops} 跳的路径`;
    case "union": return "合并查询结果";
    case "intersect": return "只保留共同结果";
    case "except": return "从前者排除后者";
    case "exists": return "保留存在关联的结果";
    case "notExists": return "排除存在关联的结果";
  }
}

export class AdvancedBundleView implements NodeView {
  readonly dom = document.createElement("div");
  readonly contentDOM = document.createElement("div");

  constructor() {
    this.dom.className = "query-advanced-bundle";
    this.contentDOM.className = "query-advanced-sections";
    this.dom.append(this.contentDOM);
  }
}

export class AdvancedSectionView implements NodeView {
  readonly dom = document.createElement("section");
  readonly contentDOM = document.createElement("div");
  private readonly heading = document.createElement("h3");
  private readonly parameters = document.createElement("div");
  private signature = "";

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom.className = "query-advanced-section";
    this.contentDOM.className = "query-advanced-operators";
    this.parameters.className = "query-advanced-parameters";
    this.sync(node);
    this.dom.append(this.heading, this.parameters, this.contentDOM);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== "query_section") return false;
    this.sync(node);
    return true;
  }

  stopEvent(event: Event): boolean {
    return stopControlEvent(event);
  }

  ignoreMutation(mutation: { target: Node }): boolean {
    return !this.contentDOM.contains(mutation.target);
  }

  private updateParameter(name: string, value: LiteralValue): void {
    const position = this.getPos();
    if (position === undefined) return;
    const current = this.view.state.doc.nodeAt(position);
    if (!current) return;
    const parameterValues = {
      ...((current.attrs.parameterValues ?? {}) as ParameterValues),
      [name]: value,
    };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(
      position,
      undefined,
      { ...current.attrs, parameterValues },
    ));
  }

  private parameterControl(
    name: string,
    type: ParameterType,
    value: LiteralValue | undefined,
  ): HTMLElement {
    const host = document.createElement("span");
    host.className = "query-advanced-parameter";
    const caption = queryWord(`参数 ${name}`);
    const typeLabel: Record<string, string> = {
      string: "文字",
      number: "数字",
      integer: "整数",
      boolean: "是 / 否",
      "fact-ref": "关系",
    };
    caption.title = typeLabel[type] ?? (type.startsWith("entity:") ? "实体" : type);
    if (type === "boolean") {
      const select = selectControl(`参数 ${name}`);
      select.append(option("true", "是"), option("false", "否"));
      select.value = value === true ? "true" : "false";
      select.addEventListener("change", () =>
        this.updateParameter(name, select.value === "true")
      );
      const slot = new ControlSlot(select, `参数 ${name}`);
      host.append(caption, slot.dom);
      return host;
    }
    const input = literalInput(`参数 ${name}`);
    input.value = value === undefined || value === null ? "" : String(value);
    input.placeholder = type.startsWith("entity:") ? "选择或输入实体" : "输入值";
    if (type === "number" || type === "integer") {
      input.type = "number";
      if (type === "integer") input.step = "1";
    }
    input.addEventListener("input", () => {
      const raw = input.value;
      const parsed = type === "number" || type === "integer"
        ? raw && Number.isFinite(Number(raw))
          ? Number(raw)
          : raw
        : raw;
      this.updateParameter(name, parsed);
    });
    const slot = new ControlSlot(input, `参数 ${name}`, {
      placeholder: input.placeholder,
      quote: type === "string",
      closeOnChange: false,
    });
    host.append(caption, slot.dom);
    return host;
  }

  private sync(node: ProseMirrorNode): void {
    this.heading.textContent = String(node.attrs.answer?.title ?? "查询结果");
    const query = node.attrs.query as Omit<QueryDocument, "operators"> | null;
    const values = (node.attrs.parameterValues ?? {}) as ParameterValues;
    const signature = JSON.stringify({ parameters: query?.parameters, values });
    if (signature === this.signature) return;
    this.signature = signature;
    this.parameters.replaceChildren(...Object.entries(query?.parameters ?? {}).map(
      ([name, type]) => this.parameterControl(name, type, values[name]),
    ));
    this.parameters.hidden = this.parameters.childElementCount === 0;
  }
}

export class AdvancedOperatorView extends ClauseView {
  private readonly summary = document.createElement("span");

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
  ) {
    super("advanced", node, view, getPos);
    this.summary.className = "query-clause-summary";
    this.sync(node);
    this.dom.append(this.summary);
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.sync(node);
    return true;
  }

  private sync(node: ProseMirrorNode): void {
    this.summary.textContent = operatorText(node.attrs.value as QueryOperator);
  }
}
