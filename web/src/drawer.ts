/** 详情抽屉:结构结果先显示——属性、事实分组(组头 = 解码关系名,
 * 组内 chips 点击即行走)、分页;简介、infobox 源码、分集介绍等
 * 长文本只在用户展开时读取,并按纯文本分段渲染。 */

import type { CommonItem, PathResult } from "./graph";
import type { Data } from "./data";
import { chipCover, drawerCover } from "./covers";
import {
  collectionBreakdown,
  parseInfobox,
  relationshipSection,
  scoreBreakdown,
  tagGroups,
} from "./entity-presentation";
import type {
  ParsedInfoboxField,
  RelationshipSection,
} from "./entity-presentation";
import { esc, html, raw } from "./html";
import { factLabel, factPrimaryOther } from "./neighbors";
import { state } from "./store";
import { bgmUrl, TYPE_NAMES, eid, etype } from "./types";
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

const GROUP_CHIPS = 8; // 每组初始 chips 数,展开后放开
const EPS_SHOWN = 25; // 分集列表初始行数
const TEXT_SEGMENT = 10_000; // 超长文本分段渲染的每段字符数
const SUMMARY_PREVIEW = 640;

type DrawerTab = "overview" | "relations" | "episodes" | "reference";

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
  tab: DrawerTab;
  relationsLoading: boolean;
  relationsLoaded: boolean;
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

interface FactGroup {
  section: RelationshipSection;
  label: string;
  members: number[];
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

function infoboxFieldMarkup(field: ParsedInfoboxField): string {
  if (field.kind === "text") return html`${field.value || "—"}`;
  if (field.items.length === 0) return html`—`;

  const items = field.items.map((item) => html`<li>
    ${raw(
      item.label
        ? html`<span class="reference-item-label">${item.label}</span>`
        : "",
    )}<span>${item.value || "—"}</span>
  </li>`).join("");
  return html`<ul class="reference-values">${raw(items)}</ul>`;
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
      const tab = t.closest("[data-tab]")?.getAttribute("data-tab");
      if (
        tab === "overview" ||
        tab === "relations" ||
        tab === "episodes" ||
        tab === "reference"
      ) {
        this.activateTab(tab);
        return;
      }
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
      tab: "overview",
      relationsLoading: false,
      relationsLoaded: false,
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
    this.rerender();
    if (cur.entity?.hasSummary)
      this.run(this.loadSummary(), "简介加载");
  }

  private activateTab(tab: DrawerTab): void {
    const cur = this.cur;
    if (!cur) return;
    if (tab === "episodes" && cur.entity?.kind !== "subject") return;
    if (tab === "reference" && !cur.entity?.hasInfobox) return;
    cur.tab = tab;
    this.rerender();
    if (tab === "relations" && !cur.relationsLoaded)
      this.run(this.prepareRelations(cur), "关系名称加载");
    if (tab === "episodes" && cur.eps === null)
      this.run(this.loadEpisodes(), "分集加载");
    if (tab === "reference" && cur.infobox.s === "idle")
      this.run(this.loadInfobox(), "infobox 加载");
  }

  private async prepareRelations(cur: Current): Promise<void> {
    if (cur.relationsLoading || cur.relationsLoaded) return;
    cur.relationsLoading = true;
    this.rerender();
    try {
      await this.loadChipNames(cur);
      if (this.cur !== cur) return;
      cur.relationsLoaded = true;
    } finally {
      cur.relationsLoading = false;
    }
    this.rerender();
  }

  private async loadChipNames(cur: Current): Promise<void> {
    const ranks = [cur.rank];
    for (const group of this.groupFacts(cur))
      for (const rank of group.members.slice(0, GROUP_CHIPS))
        ranks.push(rank);
    await this.deps.names.load(ranks);
  }

  /** 事实先按稳定语义分区,再按显示标签分组;组内成员是主要对端
   * rank(热度序,去重)。未知枚举仍由 factLabel 以数值显示。 */
  private groupFacts(cur: Current): FactGroup[] {
    const groups = new Map<string, FactGroup>();
    const seen = new Map<string, Set<number>>();
    for (const fact of cur.facts) {
      const section = relationshipSection(fact);
      const label = factLabel(fact, cur.key, cur.mappings);
      const groupKey = `${section.id}\0${label}`;
      const other = factPrimaryOther(fact, cur.key);
      const rank = this.deps.data.rankOf(other);
      if (rank === null) continue; // 未解析引用不产生可行走 chip
      const inGroup = seen.get(groupKey) ?? new Set<number>();
      if (inGroup.has(rank)) continue;
      inGroup.add(rank);
      seen.set(groupKey, inGroup);
      const group = groups.get(groupKey) ?? { section, label, members: [] };
      group.members.push(rank);
      groups.set(groupKey, group);
    }
    for (const group of groups.values())
      group.members.sort((a, b) => a - b);
    return [...groups.values()];
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
    this.rerender();
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
    cur.summaryOpen = false;
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
    for (const group of this.groupFacts(cur)) ranks.push(...group.members);
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

  private renderTabs(cur: Current): string {
    const tabs: [DrawerTab, string][] = [
      ["overview", "概览"],
      ["relations", `关联 ${cur.factsTotal.toLocaleString()}`],
    ];
    if (cur.entity?.kind === "subject")
      tabs.push([
        "episodes",
        cur.eps === null ? "分集" : `分集 ${cur.epsTotal.toLocaleString()}`,
      ]);
    if (cur.entity?.hasInfobox) tabs.push(["reference", "资料"]);
    return html`<div class="dossier-tabs" role="tablist" aria-label="详情视图">
      ${raw(
        tabs
          .map(([id, label]) => {
            const selected = id === cur.tab;
            return html`<button
              id="dossier-tab-${id}"
              class="dossier-tab"
              data-tab="${id}"
              role="tab"
              aria-selected="${selected}"
              aria-controls="dossier-panel"
            >${label}</button>`;
          })
          .join(""),
      )}
    </div>`;
  }

  private renderSummary(cur: Current): string {
    if (!cur.entity?.hasSummary) return "";
    if (cur.summary.s === "loading" || cur.summary.s === "idle")
      return html`<section class="dossier-section" aria-busy="true">
        <h3>简介</h3><div class="note">正在加载简介…</div>
      </section>`;
    if (cur.summary.s === "empty")
      return html`<section class="dossier-section"><h3>简介</h3>
        <div class="note">暂无简介</div></section>`;

    const hasMore = cur.summary.text.length > SUMMARY_PREVIEW;
    const body = cur.summaryOpen
      ? segmented(cur.summary.text, cur.summary.shown, "summary-more")
      : html`${cur.summary.text.slice(0, SUMMARY_PREVIEW)}`;
    const toggle = hasMore
      ? html`<button id="sum-toggle" class="text-action">
          ${cur.summaryOpen ? "收起简介" : "继续阅读"}
        </button>`
      : "";
    return html`<section class="dossier-section">
      <h3>简介</h3>
      <div class="sum expanded">${raw(body)}${raw(toggle)}</div>
    </section>`;
  }

  private distribution(
    title: string,
    items: { label: string; count: number }[],
  ): string {
    const max = Math.max(1, ...items.map((item) => item.count));
    const rows = items
      .map(
        (item) => html`<div class="distribution-row">
          <span>${item.label}</span>
          <meter min="0" max="${max}" value="${item.count}"
            aria-label="${item.label} ${item.count.toLocaleString()} 人"></meter>
          <span>${item.count.toLocaleString()}</span>
        </div>`,
      )
      .join("");
    return html`<section class="dossier-section distribution">
      <h3>${title}</h3>${raw(rows)}
    </section>`;
  }

  private renderSubjectOverview(cur: Current): string {
    const entity = cur.entity;
    if (!entity || entity.kind !== "subject") return "";
    const platform =
      entity.platformCode === null
        ? "未记录"
        : cur.mappings.platform[`${entity.type}:${entity.platformCode}`] ??
          `平台 ${entity.platformCode}`;
    const tags = tagGroups(entity);
    const meta = tags.meta
      .map((tag) => html`<span class="tag-pill">${tag}</span>`)
      .join("");
    const tagPreview = tags.community.slice(0, 12)
      .map((tag) => html`<span class="tag-pill counted">${tag.label}
        <small>${tag.count.toLocaleString()}</small></span>`)
      .join("");
    const tagRest = tags.community.slice(12)
      .map((tag) => html`<span class="tag-pill counted">${tag.label}
        <small>${tag.count.toLocaleString()}</small></span>`)
      .join("");
    const details = html`<dl class="dossier-facts">
      <div><dt>条目</dt><dd>#${eid(entity.key)}</dd></div>
      <div><dt>首发</dt><dd>${entity.date || "未记录"}</dd></div>
      <div><dt>平台</dt><dd>${platform}</dd></div>
      <div><dt>系列</dt><dd>${entity.series ? "系列作品" : "单独条目"}</dd></div>
      <div><dt>内容分级</dt><dd>${entity.nsfw ? "成人内容" : "常规"}</dd></div>
    </dl>`;
    const scores = scoreBreakdown(entity.scoreDetails).map((item) => ({
      label: `${item.score} 分`,
      count: item.count,
    }));
    const ratingCount = scores.reduce((sum, item) => sum + item.count, 0);
    return html`
      ${raw(this.renderSummary(cur))}
      <section class="dossier-section"><h3>基本资料</h3>${raw(details)}</section>
      ${raw(this.distribution("收藏状态", collectionBreakdown(entity)))}
      ${raw(
        ratingCount
          ? this.distribution("评分分布", scores)
          : html`<section class="dossier-section"><h3>评分分布</h3>
              <div class="note">暂无评分记录</div></section>`,
      )}
      ${raw(
        meta
          ? html`<section class="dossier-section"><h3>内容标签</h3>
              <div class="tag-cloud">${raw(meta)}</div></section>`
          : "",
      )}
      ${raw(
        tagPreview
          ? html`<section class="dossier-section"><h3>用户标签</h3>
              <div class="tag-cloud">${raw(tagPreview)}</div>
              ${raw(
                tagRest
                  ? html`<details class="more-data"><summary>
                      查看其余 ${tags.community.length - 12} 个标签
                    </summary><div class="tag-cloud">${raw(tagRest)}</div></details>`
                  : "",
              )}</section>`
          : "",
      )}
    `;
  }

  private renderOverview(cur: Current): string {
    const entity = cur.entity;
    const subject = this.renderSubjectOverview(cur);
    const generic = entity?.kind === "subject"
      ? ""
      : html`${raw(this.renderSummary(cur))}
          <section class="dossier-section"><h3>基本资料</h3>
            <dl class="dossier-facts">
              <div><dt>条目</dt><dd>#${eid(cur.key)}</dd></div>
              <div><dt>类型</dt><dd>${this.badge(cur)}</dd></div>
              <div><dt>收藏</dt><dd>${entity?.collects.toLocaleString() ?? "未记录"}</dd></div>
              <div><dt>评论</dt><dd>${entity?.comments.toLocaleString() ?? "未记录"}</dd></div>
              ${raw(
                entity?.kind === "person" && entity.career.length
                  ? html`<div class="fact-wide"><dt>职业</dt>
                      <dd>${entity.career.join(" / ")}</dd></div>`
                  : "",
              )}
            </dl>
          </section>`;
    return html`
      <div class="overview-actions">
        <button class="primary-action" data-tab="relations">
          探索 ${cur.factsTotal.toLocaleString()} 条关联
        </button>
        <button class="secondary-action" data-arm="common">共同关联</button>
        <button class="secondary-action" data-arm="path">查找路径</button>
      </div>
      ${raw(subject || generic)}
    `;
  }

  private renderRelations(cur: Current): string {
    if (cur.relationsLoading)
      return html`<div class="loading" aria-busy="true">正在准备关系名称…</div>`;
    const groups = this.groupFacts(cur);
    const sections = new Map<string, { section: RelationshipSection; groups: FactGroup[] }>();
    for (const group of groups) {
      const bucket = sections.get(group.section.id) ?? {
        section: group.section,
        groups: [],
      };
      bucket.groups.push(group);
      sections.set(group.section.id, bucket);
    }
    let shownCount = 0;
    const sectionHtml = [...sections.values()]
      .map(({ section, groups: sectionGroups }, index) => {
        const total = sectionGroups.reduce(
          (sum, group) => sum + group.members.length,
          0,
        );
        const groupHtml = sectionGroups
          .map((group) => {
            const shown = cur.expanded
              ? group.members
              : group.members.slice(0, GROUP_CHIPS);
            shownCount += shown.length;
            const chips = shown.map((rank) => this.chipOf(rank)).join("");
            const more = group.members.length > shown.length
              ? html`<button class="more">
                  …还有 ${group.members.length - shown.length} 个
                </button>`
              : "";
            return html`<div class="group">
              <div class="group-label">${group.label} · ${group.members.length}</div>
              <div class="chips">${raw(chips)}${raw(more)}</div>
            </div>`;
          })
          .join("");
        return html`<details class="relation-section" ${index === 0 ? "open" : ""}>
          <summary><span>${section.label}</span><small>${total}</small></summary>
          ${raw(groupHtml)}
        </details>`;
      })
      .join("");
    const expand =
      cur.factsNext !== null || (!cur.expanded && cur.factsTotal > shownCount)
        ? html`<button id="expand-rel" class="primary-action full-width">
            ${cur.expanded
              ? `继续加载 · ${cur.facts.length} / ${cur.factsTotal}`
              : `展开全部 ${cur.factsTotal} 条关联`}
          </button>`
        : "";
    if (!sectionHtml)
      return html`<div class="empty-state"><strong>暂无可浏览关联</strong>
        <span>未解析引用不会生成错误跳转。</span></div>`;
    return html`<div class="relations-intro">按关系语义分区；选择任一条目即可沿图谱继续探索。</div>
      ${raw(sectionHtml)}${raw(expand)}`;
  }

  private renderEpisodes(cur: Current): string {
    if (cur.loading && cur.eps === null)
      return html`<div class="loading" aria-busy="true">正在加载分集…</div>`;
    if (cur.eps === null) return html`<div class="note">准备分集数据…</div>`;
    if (cur.eps.length === 0)
      return html`<div class="empty-state"><strong>没有分集记录</strong></div>`;
    const shown = cur.epsExpanded ? cur.eps : cur.eps.slice(0, EPS_SHOWN);
    const rows = shown.map((episode) => this.episodeRow(cur, episode)).join("");
    const more = cur.epsTotal > shown.length || cur.epsNext !== null
      ? html`<button id="expand-eps" class="primary-action full-width">
          ${cur.epsExpanded
            ? `继续加载 · ${shown.length} / ${cur.epsTotal}`
            : `查看全部 ${cur.epsTotal} 集`}
        </button>`
      : "";
    return html`<div class="episode-list">${raw(rows)}</div>${raw(more)}`;
  }

  private renderReference(cur: Current): string {
    if (cur.infobox.s === "idle" || cur.infobox.s === "loading")
      return html`<div class="loading" aria-busy="true">正在整理资料…</div>`;
    if (cur.infobox.s === "empty")
      return html`<div class="empty-state"><strong>暂无扩展资料</strong></div>`;
    const parsed = parseInfobox(cur.infobox.text);
    const rows = parsed.fields
      .map((field) => html`<div><dt>${field.label}</dt>
        <dd>${raw(infoboxFieldMarkup(field))}</dd></div>`)
      .join("");
    const issue = parsed.issue
      ? html`<div class="note" role="status">
          无法按 Bangumi Wiki 语法整理第 ${parsed.issue.line} 行，原始资料仍完整保留。
        </div>`
      : "";
    return html`
      ${raw(
        rows
          ? html`<div class="reference-heading">${parsed.template}</div>
              <dl class="reference-grid">${raw(rows)}</dl>`
          : issue || html`<div class="note">未识别结构化字段，原始资料仍完整保留。</div>`,
      )}
      <details class="source-disclosure"><summary>查看原始 Wiki 源码</summary>
        <pre class="infobox">${raw(
          segmented(cur.infobox.text, cur.infobox.shown, "infobox-more"),
        )}</pre>
      </details>`;
  }

  private renderPanel(cur: Current): string {
    switch (cur.tab) {
      case "relations":
        return this.renderRelations(cur);
      case "episodes":
        return this.renderEpisodes(cur);
      case "reference":
        return this.renderReference(cur);
      default:
        return this.renderOverview(cur);
    }
  }

  private render(cur: Current): string {
    const { rank, key, entity } = cur;
    const nameRow = this.deps.names.row(rank);
    const title =
      entity?.nameCn || entity?.name || nameRow?.[1] || nameRow?.[0] ||
      this.nameOf(rank);
    const sub = entity?.nameCn ? entity.name : "";
    const stats = this.statsOf(cur);
    const panel = this.renderPanel(cur);
    return html`
      <header class="dossier-header">
        ${raw(drawerTopActions(key))}
        ${raw(drawerCover(key))}
        <div class="eyebrow">${this.badge(cur)} · Bangumi #${eid(key)}</div>
        <h2>${title}</h2>
        ${raw(sub ? html`<div class="subtitle">${sub}</div>` : "")}
        ${raw(stats.length ? html`<div class="stats">${stats.join(" · ")}</div>` : "")}
      </header>
      ${raw(this.renderTabs(cur))}
      <div
        id="dossier-panel"
        class="dossier-panel"
        role="tabpanel"
        aria-labelledby="dossier-tab-${cur.tab}"
      >
        ${raw(panel)}
      </div>
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
