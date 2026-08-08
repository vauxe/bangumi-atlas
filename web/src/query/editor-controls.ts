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
  select.className = "query-slot-control";
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
  input.className = "query-slot-control query-value-control";
  input.name = label;
  input.setAttribute("aria-label", label);
  input.autocomplete = "off";
  input.size = 8;
  return input;
}

export function semanticValueLabel(
  value: string,
  placeholder: string,
  quote = false,
): string {
  const text = value.trim();
  if (!text) return placeholder;
  return quote ? `“${text}”` : text;
}

type SlotControl = HTMLInputElement | HTMLSelectElement;

export interface ControlSlotOptions {
  placeholder?: string;
  quote?: boolean;
  closeOnChange?: boolean;
}

/** A readable semantic token whose native control only appears while editing. */
export class ControlSlot<T extends SlotControl> {
  readonly dom = document.createElement("details");
  readonly summary = document.createElement("summary");
  readonly panel = document.createElement("span");

  constructor(
    readonly control: T,
    private readonly label: string,
    private readonly options: ControlSlotOptions = {},
  ) {
    this.dom.className = "query-slot-editor";
    this.summary.className = "query-slot";
    this.panel.className = "query-slot-popover";
    const caption = document.createElement("span");
    caption.className = "query-slot-caption";
    caption.textContent = label;
    this.panel.append(caption, control);
    this.dom.append(this.summary, this.panel);
    control.addEventListener("input", () => this.sync());
    control.addEventListener("change", () => {
      this.sync();
      if (
        this.options.closeOnChange !== false &&
        control instanceof HTMLSelectElement && !control.multiple
      ) this.dom.open = false;
    });
    control.addEventListener("keydown", (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if (event.isComposing) return;
      if (event.key === "Escape" || event.key === "Enter") {
        this.dom.open = false;
        this.summary.focus();
        if (event.key === "Escape") event.preventDefault();
      }
    });
    this.dom.addEventListener("toggle", () => {
      if (!this.dom.open) return;
      const root = this.dom.closest(".query-document");
      for (const peer of root?.querySelectorAll<HTMLDetailsElement>(
        ".query-slot-editor[open]",
      ) ?? []) {
        if (peer !== this.dom) peer.open = false;
      }
    });
    this.sync();
  }

  sync(): void {
    const placeholder = this.options.placeholder ?? "选择…";
    let text = placeholder;
    if (this.control instanceof HTMLSelectElement) {
      const labels = [...this.control.selectedOptions]
        .filter((item) => item.value)
        .map((item) => item.textContent?.trim() ?? "")
        .filter(Boolean);
      if (labels.length) text = labels.join("、");
    } else {
      text = semanticValueLabel(
        this.control.value,
        placeholder,
        this.options.quote,
      );
    }
    this.summary.textContent = text;
    this.summary.setAttribute("aria-label", `${this.label}：${text}`);
    this.summary.classList.toggle("query-slot-empty", text === placeholder);
  }
}

export function queryWord(text: string): HTMLSpanElement {
  const word = document.createElement("span");
  word.className = "query-word";
  word.textContent = text;
  return word;
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
    this.dom.dataset.queryClause = name;
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
