/** 详情抽屉:属性 + summary + 关系分组列表(组头 = 解码关系名,
 * 组内 chips 点击即行走)+ "展开全部 N 个"分页 + 分集分页 + 外链。 */

import { esc, html, raw } from "./html";
import { loadAdj, loadDetail, loadPage } from "./loader";
import { state } from "./store";
import { bgmUrl, coverUrl, MEDIA_NAMES, TYPE_NAMES, etype } from "./types";
import type {
  AdjEntry,
  AdjPage,
  Detail,
  EpisodeRow,
  Geometry,
  Manifest,
  Names,
} from "./types";

export interface DrawerDeps {
  geo: Geometry;
  names: () => Names | null;
  manifest: Manifest;
  walk: (rank: number) => void;
}

const GROUP_CHIPS = 12; // 每组初始 chips 数,展开后放开

interface Current {
  rank: number;
  key: number;
  det: Detail | null;
  adj: AdjEntry | null;
  expanded: boolean;
  extra: [number, number][]; // 溢出页累计 [labelId, rank]
  pagesLoaded: number;
  loading: boolean; // 分页在途锁,防双击重复加载
  epsExtra: EpisodeRow[];
  epsPagesLoaded: number;
  epsExpanded: boolean;
}

export class Drawer {
  private el: HTMLElement;
  private deps: DrawerDeps;
  private cur: Current | null = null;

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
      if (t.id === "expand-rel" || t.classList.contains("more"))
        void this.expandRelations();
      if (t.id === "expand-eps") void this.expandEpisodes();
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
    return names?.c[rank] ?? names?.n[rank] ?? `#${rank}`;
  }

  /** key 由调用方解析传入:深链/行走落点未流式覆盖时
   * geo.key[rank] 还是 0,直接读会查错分片(main 已 Range 点查)。 */
  async show(rank: number, key: number): Promise<void> {
    this.el.classList.add("open");
    this.el.innerHTML = html`<div class="loading">加载中…</div>`;
    const [det, adj] = await Promise.all([
      loadDetail(key, this.deps.manifest.buckets),
      loadAdj(key, this.deps.manifest.buckets),
    ]);
    if (state.selection !== rank) return; // 已经走到别处
    this.cur = {
      rank,
      key,
      det,
      adj,
      expanded: false,
      extra: [],
      pagesLoaded: 0,
      loading: false,
      epsExtra: [],
      epsPagesLoaded: 0,
      epsExpanded: false,
    };
    this.rerender();
  }


  /** 工作集邻居 = 全局收藏度 top-N。rank 即全库收藏度序,inline
   * 各组组内已按 rank 升序,扁平后取最小的 N 个即全局 top-N(§4)。 */
  neighborsOf(
    adj: AdjEntry | null,
    cap = 50,
  ): { ranks: number[]; labels: number[] } {
    if (!adj) return { ranks: [], labels: [] };
    const flat: [number, number][] = [];
    for (const [lid, , ranks] of adj.g)
      for (const r of ranks) flat.push([r, lid]);
    flat.sort((a, b) => a[0] - b[0]);
    const top = flat.slice(0, cap);
    return {
      ranks: top.map((e) => e[0]),
      labels: top.map((e) => e[1]),
    };
  }

  /** 展开全部:先放开各组 inline 上限,再按页拉取溢出条目(§6)。
   * 页偏移内嵌在条目里(pages.pack 的 [offset, len]);
   * 在途锁 + 页号先占位:双击不会重复加载或跳页。 */
  private async expandRelations(): Promise<void> {
    const cur = this.cur;
    if (!cur || !cur.adj || cur.loading) return;
    cur.expanded = true;
    const loc = (cur.adj.op ?? [])[cur.pagesLoaded];
    if (loc) {
      cur.loading = true;
      const pageIdx = cur.pagesLoaded;
      try {
        const page = await loadPage<AdjPage>(loc[0], loc[1]);
        if (this.cur !== cur) return;
        cur.extra.push(...page);
        cur.pagesLoaded = pageIdx + 1;
      } finally {
        cur.loading = false;
      }
    }
    this.rerender();
  }

  private async expandEpisodes(): Promise<void> {
    const cur = this.cur;
    if (!cur || !cur.det || cur.loading) return;
    cur.epsExpanded = true;
    const loc = (cur.det.eo ?? [])[cur.epsPagesLoaded];
    if (loc) {
      cur.loading = true;
      const pageIdx = cur.epsPagesLoaded;
      try {
        const page = await loadPage<EpisodeRow[]>(loc[0], loc[1]);
        if (this.cur !== cur) return;
        cur.epsExtra.push(...page);
        cur.epsPagesLoaded = pageIdx + 1;
      } finally {
        cur.loading = false;
      }
    }
    this.rerender();
  }

  /** 过滤条件变化后按当前 store 重绘。 */
  refresh(): void {
    this.rerender();
  }

  private rerender(): void {
    const cur = this.cur;
    if (!cur) return;
    const scroll = this.el.scrollTop;
    this.el.innerHTML = this.render(cur);
    this.el.scrollTop = scroll;
  }

  private render(cur: Current): string {
    const { rank, key, det, adj } = cur;
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

    // 组内条目 = inline + 已加载的溢出页(按 labelId 归组)
    const extraByLid = new Map<number, number[]>();
    for (const [lid, r] of cur.extra) {
      const lst = extraByLid.get(lid) ?? [];
      lst.push(r);
      extraByLid.set(lid, lst);
    }
    // 溢出页全部加载后不再出"还有 N 个"提示(已无可加载项)
    const allLoaded = cur.pagesLoaded >= (adj?.op?.length ?? 0);
    const groups = (adj?.g ?? [])
      .map(([lid, total, ranks]) => {
        const label = this.deps.manifest.labels[lid] ?? "关联";
        const members = [...ranks, ...(extraByLid.get(lid) ?? [])];
        const shown = cur.expanded
          ? members
          : members.slice(0, GROUP_CHIPS);
        const more =
          total > shown.length && !(cur.expanded && allLoaded)
            ? html`<button class="more">
                …还有 ${total - shown.length} 个
              </button>`
            : "";
        const chips = shown
          .map((r) => {
            const k = this.deps.geo.key[r] ?? 0;
            // 方形裁剪的 grid 尺寸作 chip 头像;失败即自移除,
            // 未流式覆盖(key 未知)时不出图
            const av = k
              ? html`<img
                  class="chip-av"
                  loading="lazy"
                  src="${coverUrl(k, "grid")}"
                  alt=""
                  onerror="this.remove()"
                >`
              : "";
            return html`<button class="chip" data-rank="${r}">
              ${raw(av)}${this.nameOf(r)}
            </button>`;
          })
          .join("");
        return html`<div class="group">
          <div class="group-label">${label}(${total})</div>
          <div class="chips">${raw(chips)}${raw(more)}</div>
        </div>`;
      })
      .join("");
    const shownCount = (adj?.g ?? []).reduce((s, [lid, , ranks]) => {
      const members =
        ranks.length + (extraByLid.get(lid)?.length ?? 0);
      return s + (cur.expanded ? members : Math.min(members, GROUP_CHIPS));
    }, 0);
    const expandBtn =
      adj && adj.n > shownCount && !(cur.expanded && allLoaded)
        ? html`<button id="expand-rel" class="chip expand">
            ${cur.expanded
              ? `继续加载(已示 ${shownCount} / 共 ${adj.n})`
              : `展开全部 ${adj.n} 个`}
          </button>`
        : "";

    const epsAll = [...(det?.eps ?? []), ...cur.epsExtra];
    const epsShown = cur.epsExpanded ? epsAll : epsAll.slice(0, 25);
    const ne = det?.ne ?? epsAll.length;
    const eps = epsAll.length
      ? html`<div class="group">
          <div class="group-label">分集(${ne})</div>
          <div class="eps">
            ${raw(
              epsShown
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
              ne > epsShown.length
                ? html`<button id="expand-eps" class="chip expand">
                    ${cur.epsExpanded
                      ? `继续加载(已示 ${epsShown.length} / 共 ${ne})`
                      : `展开全部 ${ne} 集`}
                  </button>`
                : "",
            )}
          </div>
        </div>`
      : "";

    return html`
      <button id="drawer-close" aria-label="关闭">×</button>
      <img
        class="cover"
        src="${coverUrl(key, "medium")}"
        alt=""
        onerror="this.remove()"
      >
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
      ${raw(groups)} ${raw(expandBtn)} ${raw(eps)}
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
