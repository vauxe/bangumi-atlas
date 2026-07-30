/** 详情抽屉:属性 + summary + 关系分组列表(点击即行走)+ 分集。 */

import { esc, html, raw } from "./html";
import { loadAdj, loadDetail } from "./loader";
import { state } from "./store";
import { bgmUrl, MEDIA_NAMES, TYPE_NAMES, etype } from "./types";
import type { AdjEntry, Detail, Geometry, Manifest, Names } from "./types";

export interface DrawerDeps {
  geo: Geometry;
  names: () => Names | null;
  manifest: Manifest;
  walk: (rank: number) => void;
}

export class Drawer {
  private el: HTMLElement;
  private deps: DrawerDeps;

  constructor(el: HTMLElement, deps: DrawerDeps) {
    this.el = el;
    this.deps = deps;
    el.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement;
      const rankAttr = t.closest("[data-rank]")?.getAttribute("data-rank");
      if (rankAttr) {
        this.deps.walk(Number(rankAttr));
        return;
      }
      if (t.id === "drawer-close") this.hide();
      if (t.classList.contains("sum-toggle")) {
        this.el.querySelector(".sum")?.classList.toggle("expanded");
      }
    });
  }

  hide(): void {
    this.el.classList.remove("open");
  }

  nameOf(rank: number): string {
    const names = this.deps.names();
    return (
      names?.c[rank] ?? names?.n[rank] ?? `#${rank}`
    );
  }

  async show(rank: number): Promise<void> {
    const key = this.deps.geo.key[rank] ?? 0;
    this.el.classList.add("open");
    this.el.innerHTML = html`<div class="loading">加载中…</div>`;
    const [det, adj] = await Promise.all([
      loadDetail(key, this.deps.manifest.buckets),
      loadAdj(key, this.deps.manifest.buckets),
    ]);
    if (state.selection !== rank) return; // 已经走到别处
    this.el.innerHTML = this.render(rank, key, det, adj);
  }

  neighborsOf(adj: AdjEntry | null, cap = 50): number[] {
    if (!adj) return [];
    const out: number[] = [];
    for (const [, ranks] of adj.g) {
      for (const r of ranks) {
        out.push(r);
        if (out.length >= cap) return out;
      }
    }
    return out;
  }

  private render(
    rank: number,
    key: number,
    det: Detail | null,
    adj: AdjEntry | null,
  ): string {
    const title = det ? det.cn || det.name : this.nameOf(rank);
    const sub = det?.cn ? det.name : "";
    const badge = det?.st ?? TYPE_NAMES[etype(key)] ?? "";
    const statsBits: string[] = [];
    if (det?.score) statsBits.push(`评分 ${det.score}`);
    if (det?.bgm_rank) statsBits.push(`Rank #${det.bgm_rank}`);
    if (det?.fav)
      statsBits.push(`收藏 ${det.fav.reduce((a, b) => a + b, 0)}`);
    if (det?.collects) statsBits.push(`收藏 ${det.collects}`);
    if (det?.date) statsBits.push(det.date);

    const groups = (adj?.g ?? [])
      .map(([lid, ranks]) => {
        const label = this.deps.manifest.labels[lid] ?? "关联";
        const chips = ranks
          .slice(0, 12)
          .map(
            (r) =>
              html`<button class="chip" data-rank="${r}">
                ${this.nameOf(r)}
              </button>`,
          )
          .join("");
        const more =
          ranks.length > 12
            ? html`<span class="more">…共 ${ranks.length} 个</span>`
            : "";
        return html`<div class="group">
          <div class="group-label">${label}</div>
          <div class="chips">${raw(chips)}${raw(more)}</div>
        </div>`;
      })
      .join("");
    const totalNote =
      adj && adj.n > this.deps.manifest.adj_inline
        ? html`<div class="note">
            关系过多,已显示按收藏度排序的前
            ${this.deps.manifest.adj_inline} 条(共 ${adj.n} 条)
          </div>`
        : "";

    const eps = det?.eps?.length
      ? html`<div class="group">
          <div class="group-label">分集(${det.ne ?? det.eps.length})</div>
          <div class="eps">
            ${raw(
              det.eps
                .slice(0, 25)
                .map(
                  (e) =>
                    html`<div class="ep">
                      ${e[1]}. ${e[3] || e[2]}
                      <span class="ep-date">${e[4]}</span>
                    </div>`,
                )
                .join(""),
            )}
            ${raw(
              (det.ne ?? 0) > 25
                ? html`<div class="note">…共 ${det.ne} 集</div>`
                : "",
            )}
          </div>
        </div>`
      : "";

    return html`
      <button id="drawer-close" aria-label="关闭">×</button>
      <h2>${title}</h2>
      ${raw(sub ? html`<div class="subtitle">${sub}</div>` : "")}
      <div class="badges">
        <span class="badge">${badge}</span>
        ${raw(
          det?.tags
            ?.map((t) => html`<span class="tag">${t}</span>`)
            .join("") ?? "",
        )}
      </div>
      <div class="stats">${statsBits.join(" · ")}</div>
      ${raw(
        det?.sum
          ? html`<div class="sum">
              ${det.sum}
              <button class="sum-toggle">展开/收起</button>
            </div>`
          : "",
      )}
      ${raw(groups)} ${raw(totalNote)} ${raw(eps)}
      <a
        class="ext"
        href="${bgmUrl(key)}"
        target="_blank"
        rel="noopener"
        >在 bgm.tv 查看 →</a
      >
    `;
  }
}

export { MEDIA_NAMES };
