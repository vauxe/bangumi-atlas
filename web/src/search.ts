/** 搜索:归一 → 前缀优先 → 二元字符子串回退 → 联想下拉。
 * 目录在搜索框获得焦点时读取;启动不预取任何搜索成员。
 * 内部前缀节点自带有界热度投影,一字符查询不必下载完整分片。 */

import { esc, html, raw } from "./html";
import {
  fold,
  loadCharmap,
  loadSearchDir,
  searchMember,
  searchSubstringPage,
} from "./loader";
import type { SearchRankPage } from "./loader";
import type {
  EntityKind,
  SearchAliasRow,
  SearchAliases,
  SearchEntry,
  SearchNode,
} from "./types";
import { TYPE_NAMES } from "./types";

type SubstringPageLoader = (
  query: string,
  cursor: number,
  limit: number,
  signal: AbortSignal,
) => Promise<SearchRankPage>;

export interface SubstringSearchOptions {
  cursor?: number;
  loadPage?: SubstringPageLoader;
  signal?: AbortSignal;
}

export interface SearchEntryPage {
  entries: SearchEntry[];
  next: number | null;
  scannedThroughRank: number | null;
}

const SUBSTRING_SCAN_LIMIT = 64;
const SEARCH_RESULT_LIMIT = 60;

export type SearchMatchKind = "exact" | "prefix" | "substring";

export interface SearchResult {
  normalized: string;
  matched: string;
  display: string;
  rank: number;
  entityKind: EntityKind;
  match: SearchMatchKind;
}

function matchKind(query: string, normalized: string): SearchMatchKind {
  if (normalized === query) return "exact";
  return normalized.startsWith(query) ? "prefix" : "substring";
}

function compareResults(a: SearchResult, b: SearchResult): number {
  if (a.match === "exact" && b.match !== "exact") return -1;
  if (b.match === "exact" && a.match !== "exact") return 1;

  // 子串须显著更热门才越过前缀；这不是两个列表的硬拼接。
  const weightedA = resultScore(a);
  const weightedB = resultScore(b);
  return (
    weightedA - weightedB ||
    a.rank - b.rank ||
    a.normalized.length - b.normalized.length ||
    (a.matched < b.matched ? -1 : a.matched > b.matched ? 1 : 0)
  );
}

function resultScore(result: SearchResult): number {
  if (result.match === "exact") return 0;
  return (result.rank + 1) * (result.match === "substring" ? 4 : 1);
}

function resultOf(query: string, entry: SearchEntry): SearchResult {
  return {
    normalized: entry[0],
    matched: entry[1],
    rank: entry[2],
    display: entry[3],
    entityKind: entry[4],
    match: matchKind(query, entry[0]),
  };
}

/** 合并所有召回来源，按实体去重后进行一次稳定排序。 */
export function rankSearchEntries(
  query: string,
  entries: Iterable<SearchEntry>,
): SearchResult[] {
  const byRank = new Map<number, SearchResult>();
  for (const entry of entries) {
    if (!entry[0].includes(query)) continue;
    const candidate = resultOf(query, entry);
    const previous = byRank.get(candidate.rank);
    if (!previous || compareResults(candidate, previous) < 0)
      byRank.set(candidate.rank, candidate);
  }
  return [...byRank.values()].sort(compareResults);
}

/** 返回已转义的高亮片段；折叠改变码点数时宁可不高亮也不标错。 */
export function highlightMatch(text: string, query: string): string {
  const source = [...text];
  const normalized = [...fold(text)];
  const needle = [...query];
  if (source.length !== normalized.length || needle.length === 0)
    return esc(text);
  let at = -1;
  outer: for (
    let start = 0;
    start <= normalized.length - needle.length;
    start++
  ) {
    for (let i = 0; i < needle.length; i++)
      if (normalized[start + i] !== needle[i]) continue outer;
    at = start;
    break;
  }
  if (at < 0) return esc(text);
  return `${esc(source.slice(0, at).join(""))}<mark>${esc(
    source.slice(at, at + needle.length).join(""),
  )}</mark>${esc(source.slice(at + needle.length).join(""))}`;
}

/** 从已发布别名中选择排名最好的真实匹配。 */
export function matchingAliasEntry(
  query: string,
  row: SearchAliasRow,
  rank: number,
): SearchEntry | null {
  const [aliases, display, entityKind] = row;
  let best: SearchEntry | null = null;
  for (const [normalized, matched] of aliases) {
    if (!normalized.includes(query)) continue;
    const candidate: SearchEntry = [
      normalized,
      matched,
      rank,
      display,
      entityKind,
    ];
    if (
      !best ||
      compareResults(
        resultOf(query, candidate),
        resultOf(query, best),
      ) < 0
    )
      best = candidate;
  }
  return best;
}

/** 每次交互只检查有界数量的散列候选；next 指向首个未检查候选。 */
export async function findSubstringEntries(
  query: string,
  aliases: SearchAliases,
  options: SubstringSearchOptions = {},
): Promise<SearchEntryPage> {
  const {
    cursor = 0,
    loadPage = searchSubstringPage,
    signal = new AbortController().signal,
  } = options;
  if (!Number.isInteger(cursor) || cursor < 0)
    throw new RangeError("substring result cursor must be non-negative");
  const entries: SearchEntry[] = [];
  let candidateCursor = cursor;
  let scanned = 0;
  let scannedThroughRank: number | null = null;
  while (scanned < SUBSTRING_SCAN_LIMIT) {
    signal.throwIfAborted();
    const requestCursor = candidateCursor;
    const requestLimit = SUBSTRING_SCAN_LIMIT - scanned;
    const page = await loadPage(
      query,
      requestCursor,
      requestLimit,
      signal,
    );
    signal.throwIfAborted();
    if (page.ranks.length > requestLimit)
      throw new Error("substring candidate page exceeded its requested size");
    const endpoint = requestCursor + page.ranks.length;
    if (
      page.next !== null &&
      (page.next <= requestCursor || page.next !== endpoint)
    )
      throw new Error("substring search cursor did not advance");
    const loadedRows = await aliases.read(page.ranks, signal);
    signal.throwIfAborted();
    for (const rank of page.ranks) {
      if (
        !Number.isInteger(rank) ||
        rank < 0 ||
        (scannedThroughRank !== null && rank <= scannedThroughRank)
      )
        throw new Error("substring candidates must be increasing ranks");
      const row = loadedRows.get(rank);
      if (!row)
        throw new Error(`search alias row ${rank} missing after load`);
      candidateCursor++;
      scanned++;
      scannedThroughRank = rank;
      const entry = matchingAliasEntry(query, row, rank);
      if (entry) entries.push(entry);
    }
    if (page.next === null)
      return { entries, next: null, scannedThroughRank };
    candidateCursor = page.next;
  }
  return { entries, next: candidateCursor, scannedThroughRank };
}

export interface SearchElements {
  box: HTMLInputElement;
  panel: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  more: HTMLButtonElement;
}

export interface SearchDependencies {
  loadCharmap: typeof loadCharmap;
  loadSearchDir: typeof loadSearchDir;
  searchMember: typeof searchMember;
  searchSubstringPage: SubstringPageLoader;
  substringDelayMs: number;
}

const DEFAULT_DEPENDENCIES: SearchDependencies = {
  loadCharmap,
  loadSearchDir,
  searchMember,
  searchSubstringPage,
  substringDelayMs: 100,
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class Search {
  private box: HTMLInputElement;
  private panel: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;
  private more: HTMLButtonElement;
  private aliases: SearchAliases;
  private pageSize: number;
  private onPick: (rank: number) => void;
  private dependencies: SearchDependencies;
  private entries: SearchEntry[] = [];
  private items: SearchResult[] = [];
  private query = "";
  private visibleLimit: number;
  private substringCursor: number | null = null;
  private scannedThroughRank: number | null = null;
  private active = -1;
  private queryController: AbortController | null = null;
  private loadingMore = false;
  private userNavigated = false;

  constructor(
    elements: SearchElements,
    aliases: SearchAliases,
    pageSize: number,
    onPick: (rank: number) => void,
    dependencies: SearchDependencies = DEFAULT_DEPENDENCIES,
  ) {
    if (!Number.isInteger(pageSize) || pageSize <= 0)
      throw new RangeError("search page size must be positive");
    this.box = elements.box;
    this.panel = elements.panel;
    this.list = elements.list;
    this.status = elements.status;
    this.more = elements.more;
    this.aliases = aliases;
    this.pageSize = pageSize;
    this.visibleLimit = pageSize;
    this.onPick = onPick;
    this.dependencies = dependencies;
    this.box.addEventListener("focus", () => {
      if (this.box.value.trim() && this.panel.hidden) {
        this.runUpdate();
        return;
      }
      // 目录与折叠表在聚焦时就绪,首次输入即可解析前缀
      void Promise.all([
        this.dependencies.loadCharmap(),
        this.dependencies.loadSearchDir(),
      ]).catch(() => undefined);
    });
    this.box.addEventListener("input", () => this.runUpdate());
    this.box.addEventListener("keydown", (ev) => this.onKey(ev));
    this.box.addEventListener("blur", (event) => {
      if (event.relatedTarget !== this.more) this.close();
    });
    this.more.addEventListener("mousedown", (event) =>
      event.preventDefault(),
    );
    this.more.addEventListener("click", () => this.runMore());
    this.more.addEventListener("blur", (event) => {
      if (event.relatedTarget !== this.box) this.close();
    });
    this.list.addEventListener("mousedown", (ev) => {
      const target = (ev.target as HTMLElement).closest("[data-rank]");
      const rank = target?.getAttribute("data-rank");
      if (rank !== null && rank !== undefined) {
        ev.preventDefault();
        this.pick(Number(rank));
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (
        ev.key.toLowerCase() === "s" && // Search
        document.activeElement !== this.box &&
        !(document.activeElement instanceof HTMLInputElement)
      ) {
        ev.preventDefault();
        this.box.focus();
      }
    });
  }

  private runUpdate(): void {
    this.cancelPendingWork();
    if (this.box.value.trim().length === 0) {
      this.reset();
      return;
    }
    this.entries = [];
    this.items = [];
    this.active = -1;
    this.userNavigated = false;
    this.query = "";
    this.visibleLimit = this.pageSize;
    this.substringCursor = null;
    this.scannedThroughRank = null;
    this.more.hidden = true;
    this.setMoreLoading(false);
    this.renderList();
    this.showStatus("正在加载搜索索引…", true);
    const controller = new AbortController();
    this.queryController = controller;
    void this.update(controller.signal).catch((error: unknown) =>
      this.handleFailure(controller.signal, error),
    );
  }

  /** 命中节点:叶取全部条目过滤;内部前缀恰等于查询时直接取
   * manifest 声明的首批投影,不下载子树。 */
  private async update(signal: AbortSignal): Promise<void> {
    await this.dependencies.loadCharmap();
    signal.throwIfAborted();
    const query = fold(this.box.value);
    if (query.length === 0) {
      this.reset();
      return;
    }
    const directory = await this.dependencies.loadSearchDir();
    signal.throwIfAborted();
    let node: SearchNode | undefined;
    let prefix = "";
    let candidate = "";
    const codePoints = [...query];
    for (const char of codePoints) {
      candidate += char;
      if (!Object.hasOwn(directory, candidate)) continue;
      const hit = directory[candidate];
      if (!hit) throw new Error(`search node ${candidate} is missing`);
      node = hit;
      prefix = candidate;
      if ("l" in hit) break;
    }
    let prefixEntries: SearchEntry[] = [];
    if (node && "l" in node) {
      const entries = await this.dependencies.searchMember(node.l, signal);
      signal.throwIfAborted();
      prefixEntries = entries.filter((entry) => entry[0].startsWith(query));
    } else if (node && prefix === query) {
      prefixEntries = await this.dependencies.searchMember(node.t, signal);
      signal.throwIfAborted();
    }

    this.entries = prefixEntries;
    const prefixResults = rankSearchEntries(query, this.entries).slice(
      0,
      this.pageSize,
    );
    this.setResults(prefixResults, query);
    if (codePoints.length < 2) {
      this.setMoreAvailable(
        rankSearchEntries(query, this.entries).length > prefixResults.length,
      );
      this.showPrefixStatus(prefixResults.length);
      return;
    }

    this.showStatus("正在搜索名称中间…", true);
    await delay(this.dependencies.substringDelayMs, signal);
    this.substringCursor = 0;
    const contains = await this.loadSubstringPage(query, 0, signal);
    signal.throwIfAborted();
    this.appendSubstringPage(contains);
    this.renderSearchResults();
  }

  private loadSubstringPage(
    query: string,
    cursor: number,
    signal: AbortSignal,
  ): Promise<SearchEntryPage> {
    return findSubstringEntries(query, this.aliases, {
      cursor,
      loadPage: this.dependencies.searchSubstringPage,
      signal,
    });
  }

  private appendSubstringPage(page: SearchEntryPage): void {
    if (
      page.scannedThroughRank !== null &&
      this.scannedThroughRank !== null &&
      page.scannedThroughRank <= this.scannedThroughRank
    )
      throw new Error("substring candidate rank did not advance");
    this.entries.push(...page.entries);
    this.substringCursor = page.next;
    if (page.scannedThroughRank !== null)
      this.scannedThroughRank = page.scannedThroughRank;
  }

  /** Posting candidates are globally rank-sorted. Exact aliases are already
   * present in the prefix projection, so an unseen result's optimistic score
   * is the next rank as a prefix match. */
  private canImproveTopResults(ranked: SearchResult[]): boolean {
    if (this.substringCursor === null) return false;
    if (ranked.length < SEARCH_RESULT_LIMIT) return true;
    if (this.scannedThroughRank === null) return true;
    const cutoff = ranked[SEARCH_RESULT_LIMIT - 1];
    return cutoff !== undefined &&
      this.scannedThroughRank + 2 <= resultScore(cutoff);
  }

  private runMore(): void {
    if (this.more.hidden || this.loadingMore) return;
    if (!this.query) {
      this.runUpdate();
      return;
    }
    const query = this.query;
    const signal = this.queryController?.signal;
    if (!signal) return;
    this.setMoreLoading(true);
    this.showStatus("正在加载更多…", true);
    void this.loadMore(query, signal).catch((error: unknown) =>
      this.handleFailure(signal, error),
    );
  }

  private async loadMore(
    query: string,
    signal: AbortSignal,
  ): Promise<void> {
    const loaded = rankSearchEntries(query, this.entries);
    const canReveal =
      this.visibleLimit < SEARCH_RESULT_LIMIT &&
      loaded.length > this.visibleLimit;
    if (
      !canReveal &&
      this.substringCursor !== null &&
      this.canImproveTopResults(loaded)
    ) {
      const page = await this.loadSubstringPage(
        query,
        this.substringCursor,
        signal,
      );
      signal.throwIfAborted();
      this.appendSubstringPage(page);
    }
    this.visibleLimit = Math.min(
      SEARCH_RESULT_LIMIT,
      this.visibleLimit + this.pageSize,
    );
    this.renderSearchResults();
  }

  private renderSearchResults(): void {
    const ranked = rankSearchEntries(this.query, this.entries);
    const shown = ranked.slice(0, this.visibleLimit);
    this.setResults(shown, this.query);
    const capped = shown.length >= SEARCH_RESULT_LIMIT;
    const canReveal = !capped && ranked.length > shown.length;
    const canScan = this.canImproveTopResults(ranked);
    const hasMore = canReveal || canScan;
    this.setMoreAvailable(hasMore);
    if (hasMore && capped) this.more.textContent = "继续查找";
    if ([...this.query].length < 2) {
      this.showPrefixStatus(shown.length);
      return;
    }
    this.showStatus(
      shown.length === 0
        ? hasMore
          ? `已扫描一批候选，暂未找到“${this.query}”`
          : `未找到“${this.query}”`
        : hasMore
          ? capped
            ? `显示当前找到的 ${shown.length} 个结果；可继续查找`
            : `显示最相关的 ${shown.length} 个结果`
          : capped
            ? `显示最相关的 ${shown.length} 个结果；继续输入可缩小范围`
          : `共 ${shown.length} 个结果`,
      false,
    );
  }

  private setMoreAvailable(available: boolean): void {
    if (!available && document.activeElement === this.more) this.box.focus();
    this.more.hidden = !available;
    this.setMoreLoading(false);
  }

  private setMoreLoading(loading: boolean): void {
    this.loadingMore = loading;
    this.more.setAttribute("aria-disabled", String(loading));
    this.more.setAttribute("aria-busy", String(loading));
    this.more.textContent = loading ? "正在加载…" : "查看更多结果";
  }

  private handleFailure(signal: AbortSignal, error: unknown): void {
    if (signal.aborted || isAbortError(error)) return;
    console.error("search update failed", error);
    const retrySearch = !this.query;
    this.setMoreLoading(false);
    this.more.hidden = false;
    this.more.textContent = retrySearch
      ? "重试搜索"
      : "重试加载更多";
    this.showStatus(
      this.items.length > 0
        ? "更多结果加载失败，可继续使用现有结果"
        : retrySearch
          ? "搜索索引加载失败，请重试"
          : "名称中间搜索失败，可重试",
      false,
    );
  }

  private cancelPendingWork(): void {
    this.queryController?.abort();
    this.queryController = null;
  }

  private setResults(items: SearchResult[], query: string): void {
    const activeItem = this.items[this.active];
    const activeRank = activeItem?.rank;
    if (
      this.userNavigated &&
      activeItem &&
      !items.some((item) => item.rank === activeRank)
    )
      items = [...items.slice(0, -1), activeItem].sort(compareResults);
    this.items = items;
    this.query = query;
    const retained =
      activeRank === undefined
        ? -1
        : this.items.findIndex((item) => item.rank === activeRank);
    this.active = retained >= 0 ? retained : this.items.length ? 0 : -1;
    this.renderList();
  }

  private renderList(): void {
    this.list.innerHTML = this.items
      .map((item, index) => {
        const alias =
          item.matched === item.display
            ? ""
            : html`<div class="hit-alias">匹配：${raw(
                highlightMatch(item.matched, this.query),
              )}</div>`;
        return html`<div
          id="search-hit-${index}"
          class="hit ${index === this.active ? "active" : ""}"
          data-rank="${item.rank}"
          role="option"
          aria-selected="${index === this.active ? "true" : "false"}"
        >
          <div class="hit-main">
            <span class="hit-name">${raw(
              highlightMatch(item.display, this.query),
            )}</span>
            <span class="hit-type type-${item.entityKind}">${
              TYPE_NAMES[item.entityKind]
            }</span>
          </div>
          ${raw(alias)}
        </div>`;
      })
      .join("");
    if (this.active >= 0)
      this.box.setAttribute(
        "aria-activedescendant",
        `search-hit-${this.active}`,
      );
    else this.box.removeAttribute("aria-activedescendant");
  }

  private showStatus(message: string, busy: boolean): void {
    this.status.textContent = message;
    this.status.setAttribute("aria-busy", String(busy));
    this.panel.hidden = false;
    this.box.setAttribute("aria-expanded", "true");
  }

  private showPrefixStatus(count: number): void {
    const lead = count === 0
      ? "未找到开头匹配"
      : `显示最相关的 ${count} 个开头建议`;
    this.showStatus(`${lead}；再输入一个字可搜索名称中间`, false);
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (!this.items.length) return;
      ev.preventDefault();
      const direction = ev.key === "ArrowDown" ? 1 : -1;
      this.active = Math.max(
        0,
        Math.min(this.items.length - 1, this.active + direction),
      );
      this.userNavigated = true;
      this.renderList();
      this.list
        .querySelector<HTMLElement>(`#search-hit-${this.active}`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      const hit = this.items[this.active];
      if (hit) this.pick(hit.rank);
    } else if (ev.key === "Escape") {
      this.close(true);
    }
  }

  private pick(rank: number): void {
    this.close(true);
    this.onPick(rank);
  }

  private reset(): void {
    this.entries = [];
    this.items = [];
    this.active = -1;
    this.query = "";
    this.visibleLimit = this.pageSize;
    this.substringCursor = null;
    this.scannedThroughRank = null;
    this.loadingMore = false;
    this.userNavigated = false;
    this.list.innerHTML = "";
    this.status.textContent = "";
    this.status.setAttribute("aria-busy", "false");
    this.more.hidden = true;
    this.setMoreLoading(false);
    this.panel.hidden = true;
    this.box.setAttribute("aria-expanded", "false");
    this.box.removeAttribute("aria-activedescendant");
  }

  private close(blur = false): void {
    this.cancelPendingWork();
    this.reset();
    if (blur) this.box.blur();
  }
}
