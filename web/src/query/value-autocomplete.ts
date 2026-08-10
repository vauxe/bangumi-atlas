export function moveValueSuggestionIndex(
  index: number,
  count: number,
  key: "ArrowDown" | "ArrowUp",
): number {
  if (count <= 0) return -1;
  const start = index < 0 ? (key === "ArrowDown" ? -1 : 0) : index;
  return (start + (key === "ArrowDown" ? 1 : -1) + count) % count;
}

interface FloatingRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface FloatingViewport {
  width: number;
  height: number;
}

export interface ValueSuggestionPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  side: "above" | "below";
}

export function valueSuggestionPlacement(
  anchor: FloatingRect,
  popup: Pick<FloatingRect, "width" | "height">,
  viewport: FloatingViewport,
  margin = 12,
  gap = 4,
): ValueSuggestionPlacement {
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const width = Math.min(Math.max(anchor.width, popup.width), availableWidth);
  const left = Math.min(
    Math.max(anchor.left, margin),
    Math.max(margin, viewport.width - margin - width),
  );
  const below = Math.max(0, viewport.height - margin - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - margin - gap);
  const side = below < Math.min(popup.height, 160) && above > below
    ? "above"
    : "below";
  const maxHeight = Math.min(popup.height, side === "above" ? above : below);
  const top = side === "above"
    ? Math.max(margin, anchor.top - gap - maxHeight)
    : anchor.bottom + gap;
  return { left, top, width, maxHeight, side };
}

export interface ValueSuggestion {
  value: string;
  label: string;
  detail?: string;
}

export type ValueSuggestionItem = string | ValueSuggestion;

export type ValueSuggester = (
  text: string,
  signal: AbortSignal,
) => Promise<readonly ValueSuggestionItem[]>;

const VALUE_SUGGESTION_RENDER_BATCH = 80;

export interface ValueAutocompleteOptions {
  host: HTMLElement;
  input: HTMLInputElement;
  label: string;
  featuredValues?: readonly ValueSuggestionItem[];
  openFeaturedOnFocus?: boolean;
  noResultsMessage?: string;
  suggest: ValueSuggester;
  onValue(value: string): void;
  onChoose?(value: string): void;
  delay?: number;
}

let valueAutocompleteSequence = 0;

function normalizeSuggestion(value: ValueSuggestionItem): ValueSuggestion {
  return typeof value === "string" ? { value, label: value } : value;
}

function suggestionButton(suggestion: ValueSuggestion): HTMLButtonElement {
  const result = document.createElement("button");
  result.type = "button";
  result.tabIndex = -1;
  result.className = "query-value-suggestion";
  if (suggestion.detail) {
    const label = document.createElement("span");
    const detail = document.createElement("span");
    label.className = "query-value-suggestion-label";
    label.textContent = suggestion.label;
    detail.className = "query-value-suggestion-detail";
    detail.textContent = suggestion.detail;
    result.append(label, detail);
    result.setAttribute(
      "aria-label",
      `${suggestion.label}，${suggestion.detail}`,
    );
  } else {
    result.textContent = suggestion.label;
  }
  result.setAttribute("role", "option");
  result.setAttribute("aria-selected", "false");
  return result;
}

export function attachValueAutocomplete(
  options: ValueAutocompleteOptions,
): () => void {
  const { host, input } = options;
  const popover = document.createElement("div");
  const status = document.createElement("p");
  const list = document.createElement("div");
  const listId = `query-value-suggestions-${++valueAutocompleteSequence}`;
  popover.className = "query-value-suggestions";
  popover.hidden = true;
  status.className = "query-value-suggestion-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  list.className = "query-value-suggestion-list";
  list.id = listId;
  list.setAttribute("role", "listbox");
  popover.append(status, list);
  document.body.append(popover);
  popover.addEventListener("pointerdown", (event) => event.stopPropagation());

  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("aria-expanded", "false");

  let timer: ReturnType<typeof setTimeout> | null = null;
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let choices: HTMLButtonElement[] = [];
  let suggestions: ValueSuggestion[] = [];
  let active = -1;
  let paintedActive = -1;
  let composing = false;
  let destroyed = false;

  const positionPopover = (): void => {
    if (popover.hidden) return;
    const view = document.defaultView;
    if (!view) return;
    popover.style.width = "";
    popover.style.maxHeight = "";
    popover.style.visibility = "hidden";
    const placement = valueSuggestionPlacement(
      input.getBoundingClientRect(),
      popover.getBoundingClientRect(),
      { width: view.innerWidth, height: view.innerHeight },
    );
    popover.style.left = `${placement.left}px`;
    popover.style.top = `${placement.top}px`;
    popover.style.width = `${placement.width}px`;
    popover.style.maxHeight = `${placement.maxHeight}px`;
    popover.dataset.side = placement.side;
    popover.style.visibility = "";
  };

  const show = (): void => {
    popover.hidden = false;
    positionPopover();
    input.setAttribute("aria-expanded", "true");
  };

  const close = (): void => {
    active = -1;
    paintedActive = -1;
    choices = [];
    suggestions = [];
    popover.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const cancelPending = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  const openMessage = (message: string): void => {
    choices = [];
    suggestions = [];
    active = -1;
    paintedActive = -1;
    status.hidden = false;
    status.textContent = message;
    list.hidden = true;
    list.replaceChildren();
    popover.scrollTop = 0;
    show();
    input.removeAttribute("aria-activedescendant");
  };

  const syncActive = (scroll = false): void => {
    if (paintedActive !== active) {
      const previous = choices[paintedActive];
      previous?.classList.toggle("active", false);
      previous?.setAttribute("aria-selected", "false");
    }
    const selected = choices[active];
    if (selected) {
      selected.classList.toggle("active", true);
      selected.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", selected.id);
      if (scroll) selected.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
    paintedActive = active;
  };

  const choose = (suggestion: ValueSuggestion): void => {
    input.value = suggestion.label;
    options.onValue(suggestion.label);
    cancelPending();
    close();
    input.focus();
    options.onChoose?.(suggestion.value);
  };

  const appendChoiceBatch = (): void => {
    const end = Math.min(
      choices.length + VALUE_SUGGESTION_RENDER_BATCH,
      suggestions.length,
    );
    for (let index = choices.length; index < end; index++) {
      const suggestion = suggestions[index];
      if (!suggestion) continue;
      const choice = suggestionButton(suggestion);
      choice.id = `${listId}-${index}`;
      choice.addEventListener("pointermove", () => {
        active = index;
        syncActive();
      });
      choice.addEventListener("pointerdown", (event) => event.preventDefault());
      choice.addEventListener("click", () => choose(suggestion));
      list.append(choice);
      choices.push(choice);
    }
    const remaining = suggestions.length - choices.length;
    status.hidden = remaining === 0;
    status.textContent = remaining
      ? `共 ${suggestions.length} 项，继续滚动查看`
      : "";
    positionPopover();
  };

  const openChoices = (values: readonly ValueSuggestionItem[]): void => {
    list.replaceChildren();
    suggestions = values.map(normalizeSuggestion);
    choices = [];
    active = -1;
    paintedActive = -1;
    popover.scrollTop = 0;
    if (!suggestions.length) {
      openMessage(
        options.noResultsMessage ?? `没有匹配的${options.label}，仍可直接输入`,
      );
      return;
    }
    list.hidden = false;
    appendChoiceBatch();
    show();
    syncActive();
  };

  const revealMoreChoices = (): void => {
    if (choices.length >= suggestions.length) return;
    appendChoiceBatch();
  };

  const schedule = (): void => {
    cancelPending();
    close();
    const text = input.value.trim();
    if (!text) {
      if (document.activeElement === input && options.featuredValues?.length) {
        openChoices(options.featuredValues);
      }
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      const request = new AbortController();
      controller = request;
      openMessage(`正在查找${options.label}…`);
      void options.suggest(text, request.signal).then((values) => {
        if (
          destroyed || request.signal.aborted || controller !== request ||
          input.value.trim() !== text
        ) return;
        controller = null;
        openChoices(values);
      }).catch(() => {
        if (destroyed || request.signal.aborted || controller !== request) return;
        controller = null;
        openMessage(`${options.label}建议暂不可用，仍可直接输入`);
      });
    }, options.delay ?? 100);
  };

  const inputChanged = (): void => {
    options.onValue(input.value);
    if (!composing) schedule();
  };
  const compositionStarted = (): void => {
    composing = true;
    cancelPending();
    close();
  };
  const compositionEnded = (): void => {
    composing = false;
    options.onValue(input.value);
    schedule();
  };
  const focused = (): void => {
    if (options.openFeaturedOnFocus && options.featuredValues?.length) {
      cancelPending();
      openChoices(options.featuredValues);
    } else {
      schedule();
    }
  };
  const blurred = (): void => {
    blurTimer = setTimeout(() => {
      blurTimer = null;
      if (
        !host.contains(document.activeElement) &&
        !popover.contains(document.activeElement)
      ) {
        cancelPending();
        close();
      }
    });
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || popover.hidden) return;
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      choices.length
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (
        event.key === "ArrowDown" &&
        active === choices.length - 1 &&
        choices.length < suggestions.length
      ) revealMoreChoices();
      active = moveValueSuggestionIndex(active, choices.length, event.key);
      syncActive(true);
      return;
    }
    if (event.key === "Enter" && suggestions[active]) {
      event.preventDefault();
      event.stopPropagation();
      choose(suggestions[active]!);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelPending();
      close();
    }
  };

  input.addEventListener("input", inputChanged);
  input.addEventListener("compositionstart", compositionStarted);
  input.addEventListener("compositionend", compositionEnded);
  input.addEventListener("focus", focused);
  input.addEventListener("blur", blurred);
  input.addEventListener("keydown", keydown);
  popover.addEventListener("scroll", () => {
    if (
      popover.scrollTop + popover.clientHeight >= popover.scrollHeight - 48
    ) revealMoreChoices();
  });
  document.defaultView?.addEventListener("resize", positionPopover);
  document.defaultView?.addEventListener("scroll", positionPopover, true);

  return () => {
    destroyed = true;
    cancelPending();
    if (blurTimer !== null) clearTimeout(blurTimer);
    close();
    input.removeEventListener("input", inputChanged);
    input.removeEventListener("compositionstart", compositionStarted);
    input.removeEventListener("compositionend", compositionEnded);
    input.removeEventListener("focus", focused);
    input.removeEventListener("blur", blurred);
    input.removeEventListener("keydown", keydown);
    document.defaultView?.removeEventListener("resize", positionPopover);
    document.defaultView?.removeEventListener("scroll", positionPopover, true);
    popover.remove();
  };
}
