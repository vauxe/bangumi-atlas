/** 结果面板:把过滤谓词补成完整查询——任一作品过滤激活时,
 * 枚举满足条件的作品(节点本身按热度排序,顺序扫描即 top-N),
 * 点击行即飞往。全列(score/tags/year/flags)在内存,全扫毫秒级。 */

import { esc, html, raw } from "./html";
import { state } from "./store";
import type { Geometry, Names } from "./types";

export interface ResultsDeps {
  geo: Geometry;
  names: Names;
  /** 年份/评分/标签谓词(与 shader 判定一致,scene.isVisible)。 */
  visible: (rank: number) => boolean;
  pick: (rank: number) => void;
  reportError: (error: unknown) => void;
}

const PAGE = 50;
const COUNT_CAP = 5000; // 计数扫到这么多就停("5000+")

export class Results {
  private shown = PAGE;
  private filterKey = "";
  private collapsed = false; // 折叠态跨条件变化保持
  private nameLoading = false;

  constructor(
    private el: HTMLElement,
    private deps: ResultsDeps,
  ) {
    el.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement;
      const r = t.closest("[data-rank]")?.getAttribute("data-rank");
      if (r) {
        this.deps.pick(Number(r));
        return;
      }
      if (t.id === "results-more") {
        this.shown += PAGE;
        this.refresh();
        return;
      }
      if (t.closest(".rhead")) {
        this.collapsed = !this.collapsed;
        this.refresh();
      }
    });
  }

  private active(): boolean {
    const f = state.filters;
    return (
      f.yearMin > 0 ||
      f.yearMax < 9999 ||
      f.scoreMin > 0 ||
      f.tags.size > 0 ||
      f.media.size > 0
    );
  }

  refresh(): void {
    if (!this.active()) {
      this.el.classList.remove("open");
      return;
    }
    const f = state.filters;
    const key = `${f.yearMin}|${f.yearMax}|${f.scoreMin}|${[...f.tags].join()}|${[...f.media].join()}`;
    if (key !== this.filterKey) {
      this.filterKey = key;
      this.shown = PAGE; // 条件变了,分页归零
    }
    const { geo } = this.deps;
    // 谓词 = isVisible(年份/评分/标签)+ 媒介作为查询条件
    // (视图里媒介只调暗,但"查询"的语义是筛选)
    const hits: number[] = [];
    let total = 0;
    for (let i = 0; i < geo.loaded && total < COUNT_CAP; i++) {
      if ((geo.key[i] ?? 0) >>> 24 !== 1) continue;
      if (
        f.media.size &&
        !f.media.has(((geo.flags[i] ?? 0) >> 2) & 7)
      )
        continue;
      if (!this.deps.visible(i)) continue;
      total++;
      if (hits.length < this.shown) hits.push(i);
    }
    const names = this.deps.names;
    const missing = hits.filter((rank) => names.get(rank) === null);
    if (missing.length > 0 && !this.nameLoading) {
      this.nameLoading = true;
      void names.load(missing).then(
        () => {
          this.nameLoading = false;
          this.refresh();
        },
        (error: unknown) => {
          this.nameLoading = false;
          this.deps.reportError(error);
        },
      );
    }
    const rows = hits
      .map((rank, i) => {
        const name = names.get(rank) ?? "…";
        const y = this.deps.geo.year[rank] ?? 0;
        const s = this.deps.geo.score[rank] ?? 0;
        const meta = [
          y > 0 ? String(y) : "",
          s > 0 ? (s / 10).toFixed(1) : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return html`<button type="button" class="rrow" data-rank="${rank}">
          <span class="rn">${i + 1}.</span> ${name}
          <span class="rmeta">${meta}</span>
        </button>`;
      })
      .join("");
    const more =
      total > hits.length
        ? html`<button id="results-more" class="chip expand">
            显示更多(${hits.length} /
            ${total >= COUNT_CAP ? `${COUNT_CAP}+` : total})
          </button>`
        : "";
    const head = html`
      <button
        type="button"
        class="rhead"
        title="点击折叠/展开"
        aria-expanded="${!this.collapsed}"
        aria-controls="results-list"
      >
        结果 ${total >= COUNT_CAP ? `${COUNT_CAP}+` : total}
        <span class="rmeta">按热度排序</span>
        <span class="rchev">${this.collapsed ? "▸" : "▾"}</span>
      </button>
    `;
    this.el.innerHTML = this.collapsed
      ? head
      : html`${raw(head)}<div id="results-list">${raw(rows)} ${raw(more)}</div>`;
    this.el.classList.add("open");
  }
}

export { esc };
