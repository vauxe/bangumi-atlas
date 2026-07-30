/** 搜索:归一 → 前缀分片 → 联想下拉;回车/点击 → 选中。 */

import { esc, html } from "./html";
import { fold, searchShard } from "./loader";
import type { SearchEntry } from "./types";

export class Search {
  private box: HTMLInputElement;
  private list: HTMLElement;
  private onPick: (rank: number) => void;
  private items: SearchEntry[] = [];
  private active = -1;

  constructor(
    box: HTMLInputElement,
    list: HTMLElement,
    onPick: (rank: number) => void,
  ) {
    this.box = box;
    this.list = list;
    this.onPick = onPick;
    box.addEventListener("input", () => void this.update());
    box.addEventListener("keydown", (ev) => this.onKey(ev));
    list.addEventListener("mousedown", (ev) => {
      const t = (ev.target as HTMLElement).closest("[data-rank]");
      const r = t?.getAttribute("data-rank");
      if (r) {
        ev.preventDefault();
        this.pick(Number(r));
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (
        ev.key === "/" &&
        document.activeElement !== box &&
        !(document.activeElement instanceof HTMLInputElement)
      ) {
        ev.preventDefault();
        box.focus();
      }
    });
  }

  private async update(): Promise<void> {
    const q = fold(this.box.value);
    if (q.length === 0) {
      this.list.innerHTML = "";
      this.items = [];
      return;
    }
    const entries = await searchShard(q[0] ?? "");
    if (fold(this.box.value) !== q) return; // 已过期
    this.items = entries.filter((e) => e[0].startsWith(q)).slice(0, 12);
    this.active = this.items.length ? 0 : -1;
    this.renderList();
  }

  private renderList(): void {
    this.list.innerHTML = this.items
      .map(
        (e, i) =>
          html`<div
            class="hit ${i === this.active ? "active" : ""}"
            data-rank="${e[2]}"
          >
            ${e[1]}
          </div>`,
      )
      .join("");
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const d = ev.key === "ArrowDown" ? 1 : -1;
      this.active = Math.max(
        0,
        Math.min(this.items.length - 1, this.active + d),
      );
      this.renderList();
    } else if (ev.key === "Enter") {
      const hit = this.items[this.active];
      if (hit) this.pick(hit[2]);
    } else if (ev.key === "Escape") {
      this.list.innerHTML = "";
      this.box.blur();
    }
  }

  private pick(rank: number): void {
    this.list.innerHTML = "";
    this.box.blur();
    this.onPick(rank);
  }
}

export { esc };
