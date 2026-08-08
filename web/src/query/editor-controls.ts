import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { EditorView } from "prosemirror-view";

export function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

export function selectControl(label: string): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "query-slot";
  select.name = label;
  select.setAttribute("aria-label", label);
  return select;
}

export function removeButton(
  remove: () => void,
  label: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "query-clause-remove";
  button.textContent = "×";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", remove);
  return button;
}

export function literalInput(label: string): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "query-slot query-value-slot";
  input.name = label;
  input.setAttribute("aria-label", label);
  input.autocomplete = "off";
  input.size = 8;
  return input;
}

export class ParameterSlot {
  readonly dom = document.createElement("span");
  private readonly input = literalInput("参数名");
  private readonly toggle = document.createElement("button");
  private available = true;

  constructor(
    name: string,
    private readonly suggested: () => string,
    private readonly change: (name: string) => void,
  ) {
    this.dom.className = "query-parameter-slot";
    this.input.classList.add("query-parameter-name");
    this.input.placeholder = "参数名";
    this.input.size = 8;
    this.input.addEventListener("input", () => this.change(this.input.value));
    this.toggle.type = "button";
    this.toggle.className = "query-parameter-toggle";
    this.toggle.addEventListener("click", () => {
      const next = this.input.value ? "" : this.suggested();
      this.sync(next);
      this.change(next);
      if (next) this.input.focus();
    });
    this.sync(name);
  }

  sync(name: string): void {
    if (this.input.value !== name) this.input.value = name;
    this.toggle.textContent = name ? "固定" : "复用";
    this.toggle.setAttribute(
      "aria-label",
      name ? "改为固定值" : "把这个值设为可复用参数",
    );
    this.dom.replaceChildren(
      ...(name ? [document.createTextNode("参数 $"), this.input] : []),
      this.toggle,
    );
    this.dom.hidden = !this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
    this.dom.hidden = !available;
  }
}

export function stopControlEvent(event: Event): boolean {
  return event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLButtonElement ||
    event.target instanceof HTMLDetailsElement ||
    event.target instanceof HTMLLabelElement;
}

export class ClauseView implements NodeView {
  readonly dom: HTMLElement;
  protected node: ProseMirrorNode;

  constructor(
    name: string,
    node: ProseMirrorNode,
    protected readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = `query-clause query-clause-${name}`;
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
      this.view.dispatch(
        this.view.state.tr.delete(position, position + current.nodeSize),
      );
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
