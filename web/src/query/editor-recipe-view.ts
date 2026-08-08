import type { Node as ProseMirrorNode } from "prosemirror-model";
import { EditorView } from "prosemirror-view";

import { ClauseView, literalInput } from "./editor-controls";
import type { QueryEditorViewOptions } from "./editor-view";

export class RecipeView extends ClauseView {
  private readonly text: HTMLInputElement | null;
  private readonly from: HTMLButtonElement | null;
  private readonly to: HTMLButtonElement | null;
  private readonly maxHops: HTMLInputElement | null;
  private readonly maxPaths: HTMLInputElement | null;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    private readonly options: QueryEditorViewOptions,
  ) {
    super("recipe", node, view, getPos);
    const kind = String(node.attrs.kind);
    if (kind === "fullText") {
      this.from = null;
      this.to = null;
      this.maxHops = null;
      this.maxPaths = null;
      this.text = literalInput("正文关键词");
      this.text.value = String(node.attrs.text);
      this.text.placeholder = "输入关键词";
      this.text.addEventListener("input", () =>
        this.updateAttrs({ text: this.text?.value ?? "" })
      );
      this.dom.append(this.line(
        this.word("搜索"),
        this.slot("所有正文"),
        this.word("包含"),
        this.text,
      ));
      return;
    }
    this.text = null;
    this.from = this.entitySlot("起点实体", "选择起点");
    this.to = this.entitySlot("终点实体", "选择终点");
    this.from.addEventListener("click", () => void this.pickEntity("from"));
    this.to.addEventListener("click", () => void this.pickEntity("to"));
    this.syncEntity("from", String(node.attrs.from));
    this.syncEntity("to", String(node.attrs.to));
    this.dom.append(this.line(
      this.word("查找"),
      this.from,
      this.word(kind === "common" ? "与" : "到"),
      this.to,
      this.word(kind === "common" ? "的关联比较" : "的关系路径"),
    ));
    if (kind === "path") {
      this.maxHops = literalInput("最大路径跳数");
      this.maxHops.type = "number";
      this.maxHops.min = "1";
      this.maxHops.value = String(node.attrs.maxHops);
      this.maxPaths = literalInput("最多路径数");
      this.maxPaths.type = "number";
      this.maxPaths.min = "1";
      this.maxPaths.value = String(node.attrs.maxPaths);
      this.maxHops.addEventListener("input", () =>
        this.updateAttrs({ maxHops: Number(this.maxHops?.value) })
      );
      this.maxPaths.addEventListener("input", () =>
        this.updateAttrs({ maxPaths: Number(this.maxPaths?.value) })
      );
      this.dom.append(this.line(
        this.word("最多"),
        this.maxHops,
        this.word("跳，显示"),
        this.maxPaths,
        this.word("条"),
      ));
    } else {
      this.maxHops = null;
      this.maxPaths = null;
    }
  }

  private slot(label: string): HTMLSpanElement {
    const slot = document.createElement("span");
    slot.className = "query-slot query-readonly-slot";
    slot.textContent = label;
    return slot;
  }

  private line(...children: HTMLElement[]): HTMLSpanElement {
    const line = document.createElement("span");
    line.className = "query-recipe-line";
    line.append(...children);
    return line;
  }

  private word(text: string): HTMLSpanElement {
    const word = document.createElement("span");
    word.className = "query-word";
    word.textContent = text;
    return word;
  }

  private entitySlot(label: string, placeholder: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "query-slot query-entity-slot";
    button.textContent = placeholder;
    button.setAttribute("aria-label", `${placeholder}（${label}）`);
    return button;
  }

  private syncEntity(slot: "from" | "to", ref: string): void {
    const button = slot === "from" ? this.from : this.to;
    if (!button) return;
    this.setEntityLabel(
      button,
      slot,
      ref ? "读取名称…" : slot === "from" ? "选择起点" : "选择终点",
    );
    if (!ref) return;
    void this.options.resolveEntityLabel?.(ref).then((label) => {
      if (String(this.node.attrs[slot]) === ref)
        this.setEntityLabel(button, slot, label);
    }).catch((error: unknown) => this.options.reportError(error));
  }

  private setEntityLabel(
    button: HTMLButtonElement,
    slot: "from" | "to",
    label: string,
  ): void {
    button.textContent = label;
    button.setAttribute(
      "aria-label",
      `${label}（${slot === "from" ? "起点实体" : "终点实体"}）`,
    );
  }

  private async pickEntity(slot: "from" | "to"): Promise<void> {
    try {
      const selected = await this.options.selectedEntity?.();
      if (!selected) throw new TypeError("请先在星图或搜索结果中选择一个实体");
      if (this.node.attrs.kind === "path" && selected.ref.startsWith("episode:"))
        throw new TypeError("分集不能作为关系路径的端点");
      this.setEntityLabel(
        (slot === "from" ? this.from : this.to)!,
        slot,
        selected.label,
      );
      this.updateAttrs({ [slot]: selected.ref });
    } catch (error) {
      this.options.reportError(error);
    }
  }

  override update(node: ProseMirrorNode): boolean {
    if (node.attrs.kind !== this.node.attrs.kind) return false;
    const previousFrom = String(this.node.attrs.from);
    const previousTo = String(this.node.attrs.to);
    if (!super.update(node)) return false;
    if (this.text && this.text.value !== node.attrs.text)
      this.text.value = String(node.attrs.text);
    if (this.from && this.to) {
      if (previousFrom !== String(node.attrs.from))
        this.syncEntity("from", String(node.attrs.from));
      if (previousTo !== String(node.attrs.to))
        this.syncEntity("to", String(node.attrs.to));
    }
    if (this.maxHops && this.maxHops.value !== String(node.attrs.maxHops))
      this.maxHops.value = String(node.attrs.maxHops);
    if (this.maxPaths && this.maxPaths.value !== String(node.attrs.maxPaths))
      this.maxPaths.value = String(node.attrs.maxPaths);
    return true;
  }
}
