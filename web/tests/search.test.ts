import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { Search } from "../src/search";

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  value = "";
  innerHTML = "";
  textContent = "";
  blurCount = 0;
  private attributes = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  blur(): void {
    this.blurCount++;
  }

  focus(): void {}
}

const originalDocument = globalThis.document;

beforeEach(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { addEventListener: () => undefined, activeElement: null },
  });
});

afterEach(() => {
  if (originalDocument === undefined)
    Reflect.deleteProperty(globalThis, "document");
  else
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
});

test("closes stale suggestions when search loses focus", () => {
  const box = new FakeElement();
  const list = new FakeElement();
  new Search(box as unknown as HTMLInputElement, list as unknown as HTMLElement, () => {});
  list.innerHTML = "<div>旧结果</div>";
  box.setAttribute("aria-expanded", "true");
  box.setAttribute("aria-activedescendant", "search-hit-0");

  box.emit("blur");

  assert.equal(list.innerHTML, "");
  assert.equal(box.getAttribute("aria-expanded"), "false");
  assert.equal(box.getAttribute("aria-activedescendant"), null);
});

test("does not invent an active option when the result list is empty", () => {
  const box = new FakeElement();
  const list = new FakeElement();
  new Search(box as unknown as HTMLInputElement, list as unknown as HTMLElement, () => {});

  box.emit("keydown", {
    key: "ArrowDown",
    preventDefault: () => undefined,
  });

  assert.equal(box.getAttribute("aria-activedescendant"), null);
});
