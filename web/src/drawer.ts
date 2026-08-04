/** 详情抽屉:结构结果先显示——属性、事实分组(组头 = 解码关系名,
 * 组内 chips 点击即行走)、分页;简介、infobox 源码、分集介绍等
 * 长文本只在用户展开时读取,并按纯文本分段渲染。 */

import type { CommonItem, PathResult } from "./graph";
import type { Data } from "./data";
import { chipCover, drawerCover } from "./covers";
import { esc, html, raw } from "./html";
import { factLabel, factPrimaryOther } from "./neighbors";
import { state } from "./store";
import { bgmUrl, TYPE_NAMES, etype } from "./types";
import type {
  EpisodeRecord,
  Fact,
  Geometry,
  Manifest,
  Mappings,
  Names,
  StructuralEntity,
} from "./types";

export interface DrawerDeps {
  geo: Geometry;
  names: Names;
  manifest: Manifest;
  data: Data;
  walk: (rank: number) => void;
  /** 连接查询:锁定起点,等待用户选第二个节点。 */
  arm: (kind: "common" | "path", from: number, fromKey: number) => void;
  reportError: (context: string, error: unknown) => void;
}

const GROUP_CHIPS = 12; // 每组初始 chips 数,展开后放开
const EPS_SHOWN = 25; // 分集列表初始行数
const TEXT_SEGMENT = 10_000; // 超长文本分段渲染的每段字符数

type TextState =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "empty" }
  | { s: "ready"; text: string; shown: number };

interface Current {
  rank: number;
  key: number;
  entity: StructuralEntity | null;
  mappings: Mappings;
  facts: Fact[];
  factsTotal: number;
  factsNext: string | null;
  expanded: boolean;
  loading: boolean; // 分页在途锁,防双击重复加载
  eps: EpisodeRecord[] | null; // null = 分集尚未打开
  epsTotal: number;
  epsNext: string | null;
  epsExpanded: boolean;
  summary: TextState;
  summaryOpen: boolean;
  infobox: TextState;
  descs: Map<number, TextState>;
}

export function drawerTopActions(key?: number): string {
  const external =
    key === undefined
      ? ""
      : html`<a
          class="drawer-action drawer-external"
          href="${bgmUrl(key)}"
          target="_blank"
          rel="noopener"
          title="在 bgm.tv 查看"
          aria-label="在 bgm.tv 查看"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14 5h5v5"></path>
            <path d="M10 14 19 5"></path>
            <path d="M19 13v6H5V5h6"></path>
          </svg>
        </a>`;
  return html`<div class="drawer-actions">
    ${raw(external)}
    <button
      id="drawer-close"
      class="drawer-action"
      type="button"
      aria-label="关闭"
    >
      ×
    </button>
  </div>`;
}

export function pathArrow(label: string, direction: 1 | -1): string {
  return `${direction === 1 ? "↓" : "↑"} ${label}`;
}

/** 超长文本分段:先渲染前 shown 字,避免一次生成巨型 DOM。 */
export function segmented(
  text: string,
  shown: number,
  moreId: string,
): string {
  const clipped = text.slice(0, shown);
  const rest = text.length - clipped.length;
  return html`${clipped}${raw(
    rest > 0
      ? html`<button id="${moreId}" class="chip expand">
          继续显示(剩余 ${rest} 字)
        </button>`
      : "",
  )}`;
}

export class Drawer {
  private el: HTMLElement;
  private deps: DrawerDeps;
  private cur: Current | null = null;
  private viewEpoch = 0;

  constructor(el: HTMLElement, deps: DrawerDeps) {
    this.el = el;
    this.deps = deps;
    this.el.inert = true;
    this.el.setAttribute("aria-hidden", "true");
    el.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement;
      const rankAttr = t.closest("[data-rank]")?.getAttribute("data-rank");
      if (rankAttr) {
        this.deps.walk(Number(rankAttr));
        return;
      }
      const armKind = t
        .closest("[data-arm]")
        ?.getAttribute("data-arm") as "common" | "path" | null;
      if (armKind && this.cur) {
        this.deps.arm(armKind, this.cur.rank, this.cur.key);
        return;
      }
      const epAttr = t.closest("[data-ep]")?.getAttribute("data-ep");
      if (epAttr) {
        this.run(this.toggleDescription(Number(epAttr)), "分集介绍加载");
        return;
      }
      if (t.id === "drawer-close") this.hide();
      if (t.id === "expand-rel" || t.classList.contains("more"))
        this.run(this.expandRelations(this.anchorOf(t)), "关系分页");
      if (t.id === "load-eps") this.run(this.loadEpisodes(), "分集加载");
      if (t.id === "expand-eps")
        this.run(this.expandEpisodes(this.anchorOf(t)), "分集分页");
      if (t.id === "sum-toggle") {
        if (this.cur) {
          this.cur.summaryOpen = !this.cur.summaryOpen;
          this.rerender();
        }
      }
      if (t.id === "summary-more" && this.cur?.summary.s === "ready") {
        this.cur.summary.shown += TEXT_SEGMENT;
        this.rerender();
      }
      if (t.id === "load-infobox")
        this.run(this.loadInfobox(), "infobox 加载");
      if (t.id === "infobox-more" && this.cur?.infobox.s === "ready") {
        this.cur.infobox.shown += TEXT_SEGMENT;
        this.rerender();
      }
      const epMore = /^ep-more-(\d+)$/.exec(t.id);
      if (epMore && this.cur) {
        const text = this.cur.descs.get(Number(epMore[1]));
        if (text?.s === "ready") {
          text.shown += TEXT_SEGMENT;
          this.rerender();
        }
      }
      if (t.id === "sum-load") this.run(this.loadSummary(), "简介加载");
    });
  }

  hide(): void {
    const restoreFocus = this.el.contains(document.activeElement);
    this.viewEpoch++;
    this.el.classList.remove("open");
    if (restoreFocus)
      document.querySelector<HTMLInputElement>("#search")?.focus();
    this.el.inert = true;
    this.el.setAttribute("aria-hidden", "true");
  }

  private open(): void {
    this.el.inert = false;
    this.el.setAttribute("aria-hidden", "false");
    this.el.classList.add("open");
  }

  private run(task: Promise<void>, context: string): void {
    void task.catch((error: unknown) =>
      this.deps.reportError(context, error),
    );
  }

  nameOf(rank: number): string {
    return this.deps.names.get(rank) ?? `#${rank}`;
  }

  /** key 由调用方解析传入:深链/行走落点未流式覆盖时
   * geo.key[rank] 还是 0,直接读会查错分片(main 已 Range 点查)。 */
  async show(rank: number, key: number): Promise<void> {
    const viewEpoch = ++this.viewEpoch;
    this.open();
    this.el.innerHTML = html`<div class="loading">加载中…</div>`;
    const { data } = this.deps;
    const [entity, factsPage, mappings] = await Promise.all([
      data.entity(key),
      data.factsFor(key),
      data.mappings(),
    ]);
    if (state.selection !== rank || this.viewEpoch !== viewEpoch) return;
    const cur: Current = {
      rank,
      key,
      entity,
      mappings,
      facts: factsPage.items,
      factsTotal: factsPage.total,
      factsNext: factsPage.next,
      expanded: false,
      loading: false,
      eps: null,
      epsTotal: 0,
      epsNext: null,
      epsExpanded: false,
      summary: { s: "idle" },
      summaryOpen: false,
      infobox: { s: "idle" },
      descs: new Map(),
    };
    this.cur = cur;
    await this.loadChipNames(cur);
    if (this.viewEpoch !== viewEpoch || this.cur !== cur) return;
    this.rerender();
  }

  private async loadChipNames(cur: Current): Promise<void> {
    const ranks = [cur.rank];
    for (const [, members] of this.groupFacts(cur))
      for (const rank of members.slice(0, GROUP_CHIPS)) ranks.push(rank);
    await this.deps.names.load(ranks);
  }

  /** 事实按显示标签分组;组内成员 = 主要对端 rank(热度序,去重)。 */
  private groupFacts(cur: Current): [string, number[]][] {
    const groups = new Map<string, number[]>();
    const seen = new Map<string, Set<number>>();
    for (const fact of cur.facts) {
      const label = factLabel(fact, cur.key, cur.mappings);
      const other = factPrimaryOther(fact, cur.key);
      const rank = this.deps.data.rankOf(other);
      if (rank === null) continue; // 未解析引用不产生可行走 chip
      const inGroup = seen.get(label) ?? new Set<number>();
      if (inGroup.has(rank)) continue;
      inGroup.add(rank);
      seen.set(label, inGroup);
      const lst = groups.get(label) ?? [];
      lst.push(rank);
      groups.set(label, lst);
    }
    for (const lst of groups.values()) lst.sort((a, b) => a - b);
    return [...groups];
  }

  private async loadSummary(): Promise<void> {
    const cur = this.cur;
    if (!cur || !cur.entity?.hasSummary || cur.summary.s === "loading")
      return;
    if (cur.summary.s === "ready") {
      cur.summaryOpen = true;
      this.rerender();
      return;
    }
    cur.summary = { s: "loading" };
    const res = await this.deps.data.longText({
      kind: "entity-summary",
      entity: cur.key,
      present: cur.entity.hasSummary,
    });
    if (this.cur !== cur) return;
    cur.summary =
      res.kind === "present"
        ? { s: "ready", text: res.text, shown: TEXT_SEGMENT }
        : { s: "empty" };
    cur.summaryOpen = true;
    this.rerender();
  }

  private async loadInfobox(): Promise<void> {
    const cur = this.cur;
    if (!cur || !cur.entity?.hasInfobox || cur.infobox.s !== "idle")
      return;
    cur.infobox = { s: "loading" };
    this.rerender();
    const res = await this.deps.data.longText({
      kind: "entity-infobox",
      entity: cur.key,
      present: cur.entity.hasInfobox,
    });
    if (this.cur !== cur) return;
    cur.infobox =
      res.kind === "present"
        ? { s: "ready", text: res.text, shown: TEXT_SEGMENT }
        : { s: "empty" };
    this.rerender();
  }

  private async toggleDescription(episodeId: number): Promise<void> {
    const cur = this.cur;
    if (!cur) return;
    const prev = cur.descs.get(episodeId);
    if (prev?.s === "loading") return;
    if (prev?.s === "ready") {
      cur.descs.delete(episodeId); // 已展开 → 收起
      this.rerender();
      return;
    }
    cur.descs.set(episodeId, { s: "loading" });
    this.rerender();
    const res = await this.deps.data.longText({
      kind: "episode-description",
      subject: cur.key,
      episode: episodeId,
      present:
        cur.eps?.find((episode) => episode.id === episodeId)
          ?.hasDescription ?? false,
    });
    if (this.cur !== cur) return;
    cur.descs.set(
      episodeId,
      res.kind === "present"
        ? { s: "ready", text: res.text, shown: TEXT_SEGMENT }
        : { s: "empty" },
    );
    this.rerender();
  }

  /** 展开全部:先放开各组 inline 上限,再按页拉取溢出事实。 */
  private async expandRelations(
    anchor: { idx: number; top: number } | null,
  ): Promise<void> {
    const cur = this.cur;
    if (!cur || cur.loading) return;
    cur.expanded = true;
    if (cur.factsNext !== null) {
      cur.loading = true;
      try {
        const page = await this.deps.data.factsFor(
          cur.key,
          cur.factsNext,
        );
        if (this.cur !== cur) return;
        cur.facts.push(...page.items);
        cur.factsNext = page.next;
      } finally {
        cur.loading = false;
      }
    }
    const ranks: number[] = [];
    for (const [, members] of this.groupFacts(cur)) ranks.push(...members);
    await this.deps.names.load(ranks);
    if (this.cur !== cur) return;
    this.rerender();
    this.restoreAnchor(anchor);
  }

  /** 分集列表只在用户明确打开时读取(悬停与选中都不预取)。 */
  private async loadEpisodes(): Promise<void> {
    const cur = this.cur;
    if (!cur || cur.loading || cur.eps !== null) return;
    if ((cur.key >>> 24) !== 1) return;
    cur.loading = true;
    try {
      const page = await this.deps.data.episodesFor(cur.key);
      if (this.cur !== cur) return;
      cur.eps = page.items;
      cur.epsTotal = page.total;
      cur.epsNext = page.next;
    } finally {
      cur.loading = false;
    }
    this.rerender();
  }

  private async expandEpisodes(
    anchor: { idx: number; top: number } | null,
  ): Promise<void> {
    const cur = this.cur;
    if (!cur || cur.loading || cur.eps === null) return;
    cur.epsExpanded = true;
    if (cur.epsNext !== null) {
      cur.loading = true;
      try {
        const page = await this.deps.data.episodesFor(
          cur.key,
          cur.epsNext,
        );
        if (this.cur !== cur) return;
        cur.eps.push(...page.items);
        cur.epsNext = page.next;
      } finally {
        cur.loading = false;
      }
    }
    this.rerender();
    this.restoreAnchor(anchor);
  }

  /** 过滤条件变化后按当前 store 重绘。 */
  refresh(): void {
    this.rerender();
  }

  /** 内容锚点:展开会让上方的组全部变长,记录被点元素所在组的
   * 序号与视口位置,重绘后把该组拉回原位。 */
  private anchorOf(t: HTMLElement): { idx: number; top: number } | null {
    const groups = [...this.el.querySelectorAll(".group")];
    const el = t.closest(".group") ?? groups[groups.length - 1];
    if (!el) return null;
    return { idx: groups.indexOf(el), top: el.getBoundingClientRect().top };
  }

  private restoreAnchor(
    anchor: { idx: number; top: number } | null,
  ): void {
    if (!anchor || anchor.idx < 0) return;
    const el = this.el.querySelectorAll(".group")[anchor.idx];
    if (!el) return;
    this.el.scrollTop += el.getBoundingClientRect().top - anchor.top;
  }

  private chipOf(rank: number): string {
    const k = this.deps.geo.key[rank] ?? 0;
    return html`<button class="chip" data-rank="${rank}">
      ${raw(chipCover(k))}${this.nameOf(rank)}
    </button>`;
  }

  /** 共同关联视图:两端点 + 交集列表。 */
  async showCompare(
    aRank: number,
    bRank: number,
    items: CommonItem[],
    direct: string | null,
  ): Promise<void> {
    const viewEpoch = ++this.viewEpoch;
    this.cur = null; // 非详情视图,分页态失效
    this.open();
    this.el.innerHTML = html`<div class="loading">加载名字…</div>`;
    await this.deps.names.load([
      aRank,
      bRank,
      ...items.map((item) => item.rank),
    ]);
    if (this.viewEpoch !== viewEpoch) return;
    const rows = items
      .map(
        (it) => html`<div class="prow">
          ${raw(this.chipOf(it.rank))}
          <span class="rmeta">${it.la} ↔ ${it.lb}</span>
        </div>`,
      )
      .join("");
    this.el.innerHTML = html`
      ${raw(drawerTopActions())}
      <h2>⚭ 共同关联</h2>
      <div class="chips">
        ${raw(this.chipOf(aRank))} × ${raw(this.chipOf(bRank))}
      </div>
      ${raw(
        direct !== null
          ? html`<div class="stats">两者直接相关:${direct}</div>`
          : "",
      )}
      <div class="group-label">
        共同关联 ${items.length} 个(基于各自热度内联关系)
      </div>
      ${raw(rows)}
    `;
  }

  /** 最短路径视图:链式列表,关系名标在相邻两点之间。 */
  async showPath(res: PathResult): Promise<void> {
    const viewEpoch = ++this.viewEpoch;
    this.cur = null;
    this.open();
    this.el.innerHTML = html`<div class="loading">加载名字…</div>`;
    await this.deps.names.load(res.ranks);
    if (this.viewEpoch !== viewEpoch) return;
    const rows = res.ranks
      .map((rank, i) => {
        const arrow =
          i < res.labels.length
            ? html`<div class="parrow">
                ${pathArrow(res.labels[i] ?? "", res.directions[i] ?? 1)}
              </div>`
            : "";
        return html`<div class="prow">${raw(this.chipOf(rank))}</div>${raw(arrow)}`;
      })
      .join("");
    this.el.innerHTML = html`
      ${raw(drawerTopActions())}
      <h2>🧭 最短路径(${res.ranks.length - 1} 跳)</h2>
      ${raw(rows)}
      <div class="note">
        搜索范围:每层热度 top-48 邻居 × 6 跳内(有界双向 BFS)
      </div>
    `;
  }

  private rerender(): void {
    const cur = this.cur;
    if (!cur) return;
    const scroll = this.el.scrollTop;
    this.el.innerHTML = this.render(cur);
    this.el.scrollTop = scroll;
  }

  private badge(cur: Current): string {
    const e = cur.entity;
    const m = cur.mappings;
    if (!e) return TYPE_NAMES[etype(cur.key)] ?? "";
    if (e.kind === "subject")
      return m.subject_type[String(e.type)] ?? `作品 ${e.type}`;
    if (e.kind === "person")
      return m.person_type[String(e.type)] ?? "人物";
    return m.character_role[String(e.role)] ?? "角色";
  }

  private statsOf(cur: Current): string[] {
    const e = cur.entity;
    if (!e) return [];
    const bits: string[] = [];
    if (e.kind === "subject") {
      if (e.score) bits.push(`评分 ${e.score}`);
      if (e.bgmRank) bits.push(`Rank #${e.bgmRank}`);
      bits.push(`收藏 ${e.favorite.reduce((a, b) => a + b, 0)}`);
      if (e.date) bits.push(e.date);
      if (e.platformCode !== null) {
        const plat =
          cur.mappings.platform[`${e.type}:${e.platformCode}`];
        if (plat) bits.push(plat);
      }
    } else {
      if (e.collects) bits.push(`收藏 ${e.collects}`);
      if (e.comments) bits.push(`评论 ${e.comments}`);
      if (e.kind === "person" && e.career.length)
        bits.push(e.career.join("/"));
    }
    return bits;
  }

  private render(cur: Current): string {
    const { rank, key, entity } = cur;
    const nameRow = this.deps.names.row(rank);
    const title =
      entity?.nameCn || entity?.name || nameRow?.[1] || nameRow?.[0] ||
      this.nameOf(rank);
    const sub = entity?.nameCn ? entity.name : "";
    const statsBits = this.statsOf(cur);
    const groups = this.groupFacts(cur);
    let shownCount = 0;
    const groupHtml = groups
      .map(([label, members]) => {
        const shown = cur.expanded
          ? members
          : members.slice(0, GROUP_CHIPS);
        shownCount += shown.length;
        const more =
          members.length > shown.length
            ? html`<button class="more">
                …还有 ${members.length - shown.length} 个
              </button>`
            : "";
        const chips = shown.map((r) => this.chipOf(r)).join("");
        return html`<div class="group">
          <div class="group-label">${label}(${members.length})</div>
          <div class="chips">${raw(chips)}${raw(more)}</div>
        </div>`;
      })
      .join("");
    const expandBtn =
      cur.factsNext !== null || (!cur.expanded && cur.factsTotal > shownCount)
        ? html`<button id="expand-rel" class="chip expand">
            ${cur.expanded
              ? `继续加载(已载 ${cur.facts.length} / 共 ${cur.factsTotal} 条关系)`
              : `展开全部 ${cur.factsTotal} 条关系`}
          </button>`
        : "";

    // 标签(作品):meta_tags 前 8 个
    const tags =
      entity?.kind === "subject"
        ? entity.metaTags
            .slice(0, 8)
            .map((t) => html`<span class="tag">${t}</span>`)
            .join("")
        : "";

    // 简介:存在位为真才有区块;预取完成前显示占位
    let summary = "";
    if (entity?.hasSummary) {
      if (cur.summary.s === "ready") {
        const summaryBody = cur.summaryOpen
          ? segmented(
              cur.summary.text,
              cur.summary.shown,
              "summary-more",
            )
          : html`${cur.summary.text.slice(0, TEXT_SEGMENT)}`;
        summary = html`<div class="sum ${cur.summaryOpen ? "expanded" : ""}">
          ${raw(summaryBody)}
          <button id="sum-toggle" class="sum-toggle">展开/收起</button>
        </div>`;
      } else if (cur.summary.s === "loading") {
        summary = html`<div class="sum">简介加载中…</div>`;
      } else if (cur.summary.s === "idle") {
        summary = html`<button id="sum-load" class="chip expand">
          显示简介
        </button>`;
      }
    }

    // infobox:未解析的 Wiki 源码,只按纯文本分段显示
    let infobox = "";
    if (entity?.hasInfobox) {
      if (cur.infobox.s === "idle") {
        infobox = html`<button id="load-infobox" class="chip expand">
          查看 infobox 源码
        </button>`;
      } else if (cur.infobox.s === "loading") {
        infobox = html`<div class="note">infobox 加载中…</div>`;
      } else if (cur.infobox.s === "ready") {
        infobox = html`<div class="group">
          <div class="group-label">infobox(Wiki 源码,纯文本)</div>
          <pre class="infobox">${raw(
            segmented(cur.infobox.text, cur.infobox.shown, "infobox-more"),
          )}</pre>
        </div>`;
      }
    }

    // 分集:结构从属集合,只在打开时读取
    let eps = "";
    if ((key >>> 24) === 1) {
      if (cur.eps === null) {
        eps = html`<button id="load-eps" class="chip expand">
          查看分集列表
        </button>`;
      } else if (cur.eps.length === 0) {
        eps = html`<div class="note">没有分集记录</div>`;
      } else {
        const shown = cur.epsExpanded
          ? cur.eps
          : cur.eps.slice(0, EPS_SHOWN);
        const rows = shown
          .map((e) => this.episodeRow(cur, e))
          .join("");
        const moreBtn =
          cur.epsTotal > shown.length || cur.epsNext !== null
            ? html`<button id="expand-eps" class="chip expand">
                ${cur.epsExpanded
                  ? `继续加载(已示 ${shown.length} / 共 ${cur.epsTotal})`
                  : `展开全部 ${cur.epsTotal} 集`}
              </button>`
            : "";
        eps = html`<div class="group">
          <div class="group-label">分集(${cur.epsTotal})</div>
          <div class="eps">${raw(rows)}${raw(moreBtn)}</div>
        </div>`;
      }
    }

    return html`
      ${raw(drawerTopActions(key))}
      ${raw(drawerCover(key))}
      <h2>${title}</h2>
      ${raw(sub ? html`<div class="subtitle">${sub}</div>` : "")}
      <div class="badges">
        <span class="badge">${this.badge(cur)}</span>
        ${raw(tags)}
      </div>
      <div class="stats">${statsBits.join(" · ")}</div>
      <div class="linkops">
        <button class="chip" data-arm="common">⚭ 共同关联</button>
        <button class="chip" data-arm="path">🧭 查找路径</button>
      </div>
      ${raw(summary)} ${raw(groupHtml)} ${raw(expandBtn)} ${raw(infobox)}
      ${raw(eps)}
    `;
  }

  private episodeRow(cur: Current, e: EpisodeRecord): string {
    const desc = cur.descs.get(e.id);
    const toggle = e.hasDescription
      ? html`<button class="ep-desc" data-ep="${e.id}">
          ${desc?.s === "ready" ? "收起" : "介绍"}
        </button>`
      : "";
    const body =
      desc?.s === "ready"
        ? html`<div class="ep-body">${raw(
            segmented(desc.text, desc.shown, `ep-more-${e.id}`),
          )}</div>`
        : desc?.s === "loading"
          ? html`<div class="ep-body">介绍加载中…</div>`
          : "";
    return html`<div class="ep">
      ${e.sort ?? ""}. ${e.nameCn || e.name}
      <span class="ep-date">${e.airdate}</span>
      ${raw(toggle)} ${raw(body)}
    </div>`;
  }
}

export type { Fact };
