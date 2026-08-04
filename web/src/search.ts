/** 搜索:归一 → 自适应前缀目录 → 命中一个成员 → 联想下拉。
 * 目录在搜索框获得焦点时读取;启动不预取任何搜索成员。
 * 内部前缀节点自带热度 top-12,一字符查询不必下载完整分片。 */

import { html } from "./html";
import {
  fold,
  loadCharmap,
  loadSearchDir,
  searchMember,
} from "./loader";
import type { SearchEntry, SearchNode } from "./types";

export class Search {
  private box: HTMLInputElement;
  private list: HTMLElement;
  private onPick: (rank: number) => void;
  private items: SearchEntry[] = [];
  private active = -1;
  private updateEpoch = 0;

  constructor(
    box: HTMLInputElement,
    list: HTMLElement,
    onPick: (rank: number) => void,
  ) {
    this.box = box;
    this.list = list;
    this.onPick = onPick;
    box.addEventListener("focus", () => {
      // 目录与折叠表在聚焦时就绪,首次输入即可解析前缀
      void Promise.all([loadCharmap(), loadSearchDir()]).catch(
        () => undefined,
      );
    });
    box.addEventListener("input", () => this.runUpdate());
    box.addEventListener("keydown", (ev) => this.onKey(ev));
    box.addEventListener("blur", () => this.close());
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
        ev.key.toLowerCase() === "s" && // Search
        document.activeElement !== box &&
        !(document.activeElement instanceof HTMLInputElement)
      ) {
        ev.preventDefault();
        box.focus();
      }
    });
  }

  private runUpdate(): void {
    const epoch = ++this.updateEpoch;
    void this.update(epoch).catch((error: unknown) => {
      if (epoch !== this.updateEpoch) return;
      console.error("search update failed", error);
      this.reset();
      this.list.textContent = "搜索索引加载失败,请重试";
    });
  }

  /** 命中节点:叶取全部条目过滤;内部前缀恰等于查询时直接取
   * top-12 成员,不下载子树。 */
  private async update(epoch: number): Promise<void> {
    await loadCharmap();
    if (epoch !== this.updateEpoch) return;
    const q = fold(this.box.value);
    if (q.length === 0) {
      this.reset();
      return;
    }
    const dir = await loadSearchDir();
    if (epoch !== this.updateEpoch || fold(this.box.value) !== q) return;
    let node: SearchNode | undefined;
    let prefix = "";
    const cps = [...q]; // 码点序,与烘焙侧前缀规则一致
    for (let len = cps.length; len >= 1; len--) {
      const p = cps.slice(0, len).join("");
      const hit = dir[p];
      if (hit) {
        node = hit;
        prefix = p;
        break;
      }
    }
    if (!node) {
      this.items = [];
      this.active = -1;
      this.renderList();
      return;
    }
    let entries: SearchEntry[];
    if ("l" in node) {
      entries = (await searchMember(node.l)).filter((e) =>
        e[0].startsWith(q),
      );
    } else if (prefix === q) {
      entries = await searchMember(node.t);
    } else {
      // 内部节点且查询更长:对应子前缀不存在 => 无结果
      entries = [];
    }
    if (epoch !== this.updateEpoch || fold(this.box.value) !== q) return;
    this.items = entries.slice(0, 12);
    this.active = this.items.length ? 0 : -1;
    this.renderList();
  }

  private renderList(): void {
    this.list.innerHTML = this.items
      .map(
        (e, i) =>
          html`<div
            id="search-hit-${i}"
            class="hit ${i === this.active ? "active" : ""}"
            data-rank="${e[2]}"
            role="option"
            aria-selected="${i === this.active ? "true" : "false"}"
          >
            ${e[1]}
          </div>`,
      )
      .join("");
    this.box.setAttribute("aria-expanded", String(this.items.length > 0));
    if (this.active >= 0)
      this.box.setAttribute(
        "aria-activedescendant",
        `search-hit-${this.active}`,
      );
    else this.box.removeAttribute("aria-activedescendant");
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (!this.items.length) return;
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
      this.close(true);
    }
  }

  private pick(rank: number): void {
    this.close(true);
    this.onPick(rank);
  }

  private reset(): void {
    this.items = [];
    this.active = -1;
    this.list.innerHTML = "";
    this.box.setAttribute("aria-expanded", "false");
    this.box.removeAttribute("aria-activedescendant");
  }

  private close(blur = false): void {
    this.updateEpoch++;
    this.reset();
    if (blur) this.box.blur();
  }
}
