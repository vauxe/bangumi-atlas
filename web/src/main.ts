/** 启动序列与交互接线;整体契约见 docs/STRUCTURAL_SITE_DATA_DESIGN.md。
 * 加载优先级:manifest 后立即启动几何流,首块即渲;反向索引低优先级
 * 补齐;搜索目录在聚焦时读取;text.idx 在首次结构画面后空闲读取;
 * 悬停名字按需、稳定 150ms 才预取结构,不预取 Episode 或任何文本。 */

import { Drawer } from "./drawer";
import { Data } from "./data";
import { esc } from "./html";
import {
  ensureRankIndex,
  loadGzJson,
  loadManifest,
  openNames,
  openSearchAliases,
  openGeometry,
  pointByRank,
  rankOfKey,
  watchReleaseChange,
  SiteDataContractError,
} from "./loader";
import { relationNeighbors } from "./neighbors";
import { parseEntityRef, QUERY_CONTRACT, type Owner } from "./query/contract";
import { compileExplorerQuery } from "./query/explorer";
import { queryResultGraphRanks } from "./query/graph-results";
import { rankEntitySuggestions } from "./query/query-bar";
import { OWNER_LABEL } from "./query/workbench-model";
import { QueryWorkbench } from "./query/workbench";
import { QueryWorkerClient } from "./query/worker-client";
import { Scene } from "./scene";
import { searchNameSuggestions } from "./search";
import { notify, state, subscribe } from "./store";
import { TYPE_NAMES, etype, type EntityKind } from "./types";
import { decode, encode, type LinkState } from "./url";
import { locateStableTarget, resolveUrlSelection } from "./url-restore";

const HOVER_PREFETCH_MS = 150;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

/** 节省流量模式下跳过所有推测预取(不支持该能力则按需读取)。 */
function saveData(): boolean {
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean };
  };
  return nav.connection?.saveData === true;
}

async function boot(): Promise<void> {
  const hud = $("#hud");
  const reportError = (context: string, error: unknown): void => {
    console.error(context, error);
    hud.textContent = `${context}失败,请检查网络后重试`;
  };
  const runTask = (task: Promise<unknown>, context: string): void => {
    void task.catch((error: unknown) => reportError(context, error));
  };
  watchReleaseChange(() => {
    hud.textContent = "站点数据已更新,请刷新页面继续浏览";
  });
  hud.textContent = "加载清单…";
  const manifest = await loadManifest();

  // ---- 数据流:先分配缓冲拿到 geo,流在场景建成后才启动 ----
  const gstream = openGeometry(manifest);
  const geo = gstream.geo;
  const names = openNames(manifest);
  const searchAliases = openSearchAliases(manifest);
  const data = new Data();

  const drawer = new Drawer(
    $("#drawer"),
    $<HTMLButtonElement>("#drawer-reopen"),
    {
      geo,
      names,
      manifest,
      data,
      reportError,
      walk: (rank) => runTask(select(rank, "fly"), "节点加载"),
    },
  );

  const tooltip = $("#tooltip");
  let hoveredNode: { rank: number; x: number; y: number } | null = null;
  let hoverTimer = 0;
  const showTooltip = (
    text: string,
    sub: string,
    x: number,
    y: number,
  ): void => {
    tooltip.style.display = "block";
    tooltip.style.left = `${x + 12}px`;
    tooltip.style.top = `${y + 12}px`;
    tooltip.innerHTML = `${esc(text)} <span class="tt">${esc(sub)}</span>`;
  };

  // ---- URL 历史:离散导航入栈,相机/查询表单原地替换 ----
  let historyApplications = 0;
  let replaceTimer = 0;
  const currentUrl = (): string | null => {
    try {
      return encode(
        scene.getViewState(),
        state.selectionKey,
        state.selection,
        scene.camera.ortho,
      );
    } catch (error) {
      console.error("分享链接生成失败", error);
      hud.textContent = error instanceof Error
        ? error.message
        : "当前查询无法写入分享链接";
      return null;
    }
  };
  const replaceUrl = (): void => {
    if (historyApplications > 0) return;
    if (replaceTimer) return;
    replaceTimer = window.setTimeout(() => {
      replaceTimer = 0;
      const next = currentUrl();
      if (next !== null) history.replaceState(null, "", next);
    }, 200);
  };
  const pushUrl = (): void => {
    const next = currentUrl();
    if (next !== null) history.pushState(null, "", next);
  };

  // ---- 场景先建,确保首块几何到达即可渲染 ----
  const scene: Scene = new Scene($<HTMLDivElement>("#map"), geo, manifest.bbox, {
    onPick: (rank) => {
      if (rank === null) {
        if (state.selection !== null) deselect(true);
      } else runTask(select(rank, "center"), "节点加载");
    },
    onHover: (rank, x, y) => {
      clearTimeout(hoverTimer);
      if (rank === null || rank >= geo.loaded) {
        hoveredNode = null;
        tooltip.style.display = "none";
        return;
      }
      hoveredNode = { rank, x, y };
      // 名称立即按需;结构预取要求指针在同一节点稳定 150ms,
      // 离开即取消;悬停不读取 Episode 或任何文本。
      if (!saveData()) {
        const key = geo.key[rank] ?? 0;
        hoverTimer = window.setTimeout(() => {
          if (hoveredNode?.rank === rank && key)
            data.prefetchStructure(key);
        }, HOVER_PREFETCH_MS);
      }
      const name = names.get(rank);
      showTooltip(
        name ?? "…",
        TYPE_NAMES[etype(geo.key[rank] ?? 0)] ?? "",
        x,
        y,
      );
      if (name === null)
        runTask(
          names.load([rank]).then(() => {
            const hovered = hoveredNode;
            if (!hovered || hovered.rank !== rank) return;
            showTooltip(
              names.get(rank) ?? `#${rank}`,
              TYPE_NAMES[etype(geo.key[rank] ?? 0)] ?? "",
              hovered.x,
              hovered.y,
            );
          }),
          "名字加载",
        );
    },
    onHoverEdge: (label, x, y) => {
      hoveredNode = null;
      if (label === null) {
        tooltip.style.display = "none";
        return;
      }
      showTooltip(label, "关系", x, y);
    },
    onViewChange: replaceUrl,
    // 近场动态标签:冷区(如孤立外环)凑近时按需补载名字
    nameOf: (rank) => names.get(rank),
    loadNames: (ranks) => names.load(ranks),
  });
  // ---- 几何流:场景已就绪,首块回调即可渲染 ----
  let geometryComplete = false;
  let pendingUrlHash: string | null = null;
  let backgroundStarted = false;
  const idle =
    "requestIdleCallback" in window
      ? (fn: () => void) => requestIdleCallback(fn, { timeout: 4000 })
      : (fn: () => void) => setTimeout(fn, 1500);
  const geoDone = gstream.start((loaded) => {
    hud.textContent =
      loaded === manifest.n_nodes
        ? ""
        : `渲染 ${loaded.toLocaleString()} / ${manifest.n_nodes.toLocaleString()} 节点`;
    scene.geometryGrew();
    // 第一批节点绘制后,低优先级补齐反向索引
    // (骨架边与标签表不再预载:边和名字都只在选中态由工作集呈现)
    if (!backgroundStarted && loaded > 0) {
      backgroundStarted = true;
      runTask(ensureRankIndex(), "反向索引加载");
    }
  });

  runTask(
    geoDone.then(() => {
      geometryComplete = true;
      hud.textContent = "";
      scene.geometryGrew();
      // 稳定 key 未解析时挂起整个 URL。全量就绪后从原 URL
      // 重新解析两端与相机,避免把 common/path 悄悄降级成普通选中。
      const hash = pendingUrlHash;
      pendingUrlHash = null;
      if (hash !== null && location.hash === hash)
        runTask(applyUrl(false), "深链恢复");
    }),
    "几何数据加载",
  );

  const sparseRankByKey = new Map<number, number>();
  const queryRefFromKey = (key: number): `${"subject" | "person" | "character"}:${number}` => {
    const owner = (["", "subject", "person", "character"] as const)[key >>> 24];
    if (!owner) throw new TypeError(`无效实体键 ${key}`);
    return `${owner}:${key & 0xffffff}`;
  };
  const rankOfKeyLocal = (key: number): number | null => {
    const sparse = sparseRankByKey.get(key);
    if (sparse !== undefined) return sparse;
    const indexed = rankOfKey(key);
    if (indexed !== null) return indexed;
    for (let i = 0; i < geo.loaded; i++)
      if (geo.key[i] === key) return i;
    return null;
  };
  let navigationEpoch = 0;
  let firstStructuralPaint = false;

  /** 首次结构画面完成后空闲读取 text.idx,消除冷文本展开的
   * “先取索引、再取成员”串行瀑布(节省流量模式跳过)。 */
  const warmTextIndex = (): void => {
    if (firstStructuralPaint || saveData()) return;
    firstStructuralPaint = true;
    idle(() => {
      runTask(loadGzJson("text.idx"), "文本索引预热");
    });
  };

  const locateUrlTarget = (
    key: number | null,
    rankHint: number | null,
  ): Promise<{ key: number; rank: number } | null> =>
    locateStableTarget(key, rankHint, rankOfKeyLocal, async (rank) => {
      const point = await pointByRank(manifest, rank);
      if (point) {
        geo.sparse.set(rank, point.pos);
        geo.key[rank] = point.key;
        sparseRankByKey.set(point.key, rank);
      }
      return point;
    });

  async function handleLink(
    link: LinkState,
    bRank: number,
    push = true,
    cam: "fly" | "none" = "fly",
  ): Promise<void> {
    const bKey = geo.key[bRank] ?? 0;
    if (!bKey || geo.key[link.fromRank] !== link.fromKey) {
      hud.textContent = "节点身份解析失败,请刷新重试";
      return;
    }
    const from = queryRefFromKey(link.fromKey);
    const to = queryRefFromKey(bKey);
    await select(bRank, cam, push, bKey);
    queryWorkbench?.askRelationship(link.kind, from, to);
  }

  /** 相机语义:fly = 飞行聚焦;center = 远处才滑移枢轴并保持缩放;
   * none = 不动相机(URL 还原,尊重链接机位)。 */
  async function select(
    rank: number,
    cam: "fly" | "center" | "none",
    push = true,
    keyHint: number | null = null,
    episodeId: number | null = null,
  ): Promise<void> {
    const epoch = ++navigationEpoch;
    state.selection = rank;
    state.selectionKey = keyHint;
    // 落点未流式覆盖时,一次 Range 点查同时解析坐标与 key。
    let key = keyHint ?? geo.key[rank] ?? 0;
    if (rank >= geo.loaded && (!geo.sparse.has(rank) || !key)) {
      const pt = await pointByRank(manifest, rank);
      if (epoch !== navigationEpoch || state.selection !== rank) return;
      if (pt) {
        geo.sparse.set(rank, pt.pos);
        key = pt.key;
        geo.key[rank] = pt.key;
        sparseRankByKey.set(pt.key, rank);
      }
    }
    if (!key) {
      hud.textContent = "节点身份加载失败,请刷新重试";
      return;
    }
    state.selectionKey = key;
    if (cam === "fly") scene.flyTo(rank);
    else if (cam === "center")
      scene.centerSelection(rank);
    const [factsPage, mappings] = await Promise.all([
      data.factsFor(key),
      data.mappings(),
    ]);
    if (epoch !== navigationEpoch || state.selection !== rank) return;
    const nb = relationNeighbors(
      factsPage.items,
      key,
      mappings,
      (k) => rankOfKeyLocal(k),
      50,
    );
    state.neighbors = nb.ranks;
    state.neighborLabels = nb.labels;
    runTask(
      drawer.show(rank, key, episodeId ?? undefined).then(warmTextIndex),
      "详情加载",
    );
    notify();
    if (push) pushUrl();
  }

  function deselect(push: boolean): void {
    navigationEpoch++;
    state.selection = null;
    state.selectionKey = null;
    state.neighbors = [];
    state.neighborLabels = [];
    drawer.hide();
    notify();
    if (push) pushUrl();
  }

  subscribe(() => scene.recolor());

  // ---- 上下文提示栏:随选中状态切换操作提示 ----
  const hint = $("#hint");
  const HINT_DEFAULT =
    "拖动平移 · 滚轮缩放 · 单击查看 · 双击聚焦 · S 搜索 · R 复位";
  const HINT_SELECTED =
    "Esc 取消 · 双击聚焦 · 单击关联前往 · R 复位";
  let hintSelected = false;
  hint.textContent = HINT_DEFAULT;
  subscribe(() => {
    const sel = state.selection !== null;
    if (sel === hintSelected) return;
    hintSelected = sel;
    hint.textContent = sel ? HINT_SELECTED : HINT_DEFAULT;
  });

  let queryWorkbench: QueryWorkbench | null = null;

  // ---- URL 恢复(深链)与 popstate(浏览器后退 = 回上一视图)----
  const applyUrl = async (initial: boolean): Promise<void> => {
    const epoch = ++navigationEpoch;
    const appliedHash = location.hash;
    historyApplications++;
    try {
      const st = decode(appliedHash);
      scene.setOrtho(st.ortho);
      if (st.view) scene.setView(st.view);
      if (st.key === null && st.rank === null) {
        pendingUrlHash = null;
        if (state.selection !== null || initial) deselect(false);
      } else {
        // 稳定键优先经 rank-by-key 反向索引解析
        if (st.key !== null)
          await ensureRankIndex().catch(() => undefined);
        const resolved = await resolveUrlSelection(st, locateUrlTarget);
        if (epoch !== navigationEpoch) return;
        if (resolved) {
          pendingUrlHash = null;
          if (resolved.link)
            await handleLink(
              resolved.link,
              resolved.rank,
              false,
              resolved.camera,
            );
          else
            await select(
              resolved.rank,
              resolved.camera,
              false,
              resolved.key,
            );
        } else if (st.key !== null && !geometryComplete) {
          pendingUrlHash = appliedHash;
        } else {
          pendingUrlHash = null;
          hud.textContent = "链接中的节点已不存在或身份无法解析";
        }
      }
      notify();
    } finally {
      historyApplications--;
      if (historyApplications === 0) {
        const next = currentUrl();
        if (next !== null) history.replaceState(null, "", next);
      }
    }
  };

  // ---- 统一查询：名称定位与结构化答案共享 Worker 执行链 ----
  let queryClient: QueryWorkerClient | null = null;
  const client = (): QueryWorkerClient => {
    queryClient ??= new QueryWorkerClient(
      () => new Worker(new URL("query-worker.js", document.baseURI)),
    );
    return queryClient;
  };
  let suggestionClient: QueryWorkerClient | null = null;
  const suggestions = (): QueryWorkerClient => {
    suggestionClient ??= new QueryWorkerClient(
      new Worker(new URL("query-worker.js", document.baseURI)),
    );
    return suggestionClient;
  };

  const suggestQueryEntities = async (
    text: string,
    owners: readonly Owner[],
    signal: AbortSignal,
  ) => {
    if (
      [...text.trim()].length <
        QUERY_CONTRACT.search.lookup.minNormalizedCharacters
    ) return [];
    const pages = await Promise.all(owners.map(async (owner) => {
      const columns = [
        "ref",
        "name",
        ...(owner === "subject" || owner === "episode" ? ["nameCn"] : []),
        ...(owner === "episode" ? ["subjectRef"] : []),
      ];
      const section = compileExplorerQuery({
        owner,
        text: { value: text, capability: "lookup" },
        columns,
        limit: 12,
      }).sections.results!;
      const result = await suggestions().execute(
        section.query,
        section.parameterValues ?? {},
        { offset: 0, pageSize: 12, signal },
      );
      const items = await Promise.all(result.rows.map(async (row, index) => {
        const ref = row.ref;
        const name = typeof row.nameCn === "string" && row.nameCn
          ? row.nameCn
          : row.name;
        if (typeof ref !== "string" || typeof name !== "string") return null;
        const match = Object.values(result.evidence[index] ?? {}).flat()
          .find((item) => item.kind === "text-range")?.snippet;
        let detail = OWNER_LABEL[owner];
        if (owner === "episode" && typeof row.subjectRef === "string") {
          const subjectRef = parseEntityRef(row.subjectRef);
          if (subjectRef.owner === "subject" && subjectRef.archiveId <= 0xffffff) {
            const subject = await data.entity((1 << 24) | subjectRef.archiveId, signal);
            if (subject?.kind === "subject")
              detail = `${detail} · ${subject.nameCn || subject.name}`;
          }
        }
        return {
          ref: ref as `${Owner}:${number}`,
          owner,
          label: name,
          detail,
          ...(match ? { match } : {}),
        };
      }));
      return items.filter((item) => item !== null);
    }));
    return rankEntitySuggestions(text, pages.flat()).slice(0, 18);
  };

  const navigateEntity = async (ref: string): Promise<void> => {
    const parsed = parseEntityRef(ref);
    if (parsed.owner === "episode") {
      const episode = await data.episode(parsed.archiveId);
      if (!episode) throw new TypeError(`${ref} 不在当前数据版本中`);
      await ensureRankIndex();
      const rank = rankOfKeyLocal(episode.subject);
      if (rank === null) throw new TypeError(`${ref} 所属作品不在当前星图中`);
      await select(rank, "fly", true, episode.subject, episode.id);
      return;
    }
    const kind = parsed.owner === "subject"
      ? 1
      : parsed.owner === "person"
        ? 2
        : 3;
    if (parsed.archiveId > 0xffffff)
      throw new TypeError(`${ref} 不能在当前星图中定位`);
    const key = (kind << 24) | parsed.archiveId;
    await ensureRankIndex();
    const rank = rankOfKeyLocal(key);
    if (rank === null) throw new TypeError(`${ref} 不在当前数据版本中`);
    await select(rank, "fly", true, key);
  };

  let queryHighlightEpoch = 0;
  const highlightQueryResultEntities = async (
    refs: readonly string[],
  ): Promise<number> => {
    const epoch = ++queryHighlightEpoch;
    if (!refs.length) {
      state.queryResultRanks = [];
      notify();
      return 0;
    }
    await ensureRankIndex();
    const ranks = await queryResultGraphRanks(refs, {
      episodeSubjectKey: async (id) => (await data.episode(id))?.subject ?? null,
      rankOfKey: rankOfKeyLocal,
    });
    if (epoch !== queryHighlightEpoch) return 0;
    state.queryResultRanks = ranks;
    notify();
    return ranks.length;
  };

  queryWorkbench = new QueryWorkbench({
    host: $("#query-dock"),
    execute: (section, options) =>
      client().execute(section.query, section.parameterValues ?? {}, options),
    selectedEntity: async () => {
      const key = state.selectionKey;
      const rank = state.selection;
      if (!key || rank === null) return null;
      const owner = (["", "subject", "person", "character"] as const)[key >>> 24];
      if (!owner) return null;
      await names.load([rank]);
      return {
        ref: `${owner}:${key & 0xffffff}`,
        label: names.get(rank) ?? `${owner} #${key & 0xffffff}`,
      };
    },
    resolveEntityLabel: async (ref) => {
      const parsed = parseEntityRef(ref);
      if (parsed.owner === "episode") {
        const episode = await data.episode(parsed.archiveId);
        return episode?.name || `分集 #${parsed.archiveId}`;
      }
      const kind = parsed.owner === "subject"
        ? 1
        : parsed.owner === "person"
          ? 2
          : 3;
      if (parsed.archiveId > 0xffffff)
        throw new TypeError("实体不在当前数据版本中");
      const entity = await data.entity((kind << 24) | parsed.archiveId);
      if (!entity) throw new TypeError("实体不在当前数据版本中");
      return entity.kind === "subject" ? entity.nameCn || entity.name : entity.name;
    },
    suggestEntities: suggestQueryEntities,
    suggestNames: async (text, owners, signal) => {
      const canvasKinds = owners.flatMap((owner): EntityKind[] =>
        owner === "subject" ? [1]
          : owner === "person" ? [2]
            : owner === "character" ? [3]
              : []
      );
      const [canvas, episodes] = await Promise.all([
        canvasKinds.length
          ? searchNameSuggestions(text, searchAliases, {
              limit: 18,
              entityKinds: canvasKinds,
              signal,
            })
          : [],
        owners.includes("episode")
          ? suggestQueryEntities(text, ["episode"], signal)
          : [],
      ]);
      const ownerOfKind = (["", "subject", "person", "character"] as const);
      return [
        ...canvas.map((item) => {
          const owner = ownerOfKind[item.entityKind] as Owner;
          return {
            key: `rank:${item.rank}`,
            rank: item.rank,
            owner,
            label: item.display,
            detail: OWNER_LABEL[owner],
            ...(item.matched !== item.display ? { match: item.matched } : {}),
          };
        }),
        ...episodes.map((item) => ({
          key: item.ref,
          ref: item.ref,
          owner: item.owner,
          label: item.label,
          detail: item.detail,
          ...(item.match ? { match: item.match } : {}),
        })),
      ].slice(0, 18);
    },
    onNameSuggestion: async (suggestion) => {
      if (suggestion.rank !== undefined) {
        await select(suggestion.rank, "fly");
        return;
      }
      if (suggestion.ref) {
        await navigateEntity(suggestion.ref);
        return;
      }
      throw new TypeError("无法定位这个名称建议");
    },
    releaseId: () => manifest.version,
    mappings: () => data.mappings(),
    onEntity: navigateEntity,
    onResultEntities: highlightQueryResultEntities,
    updateUrl: replaceUrl,
    pushUrl,
  });
  subscribe(() => {
    queryWorkbench?.sync(state.queryBundle);
  });

  // ---- 骰子:在当前已加载的 Canvas 节点中随机传送 ----
  const rollDice = (): void => {
    const count = geo.loaded;
    if (!count) return;
    runTask(select(Math.floor(Math.random() * count), "fly"), "随机节点加载");
  };
  $("#dice").addEventListener("click", rollDice);

  // ---- 键盘快捷键 ----
  document.addEventListener("keydown", (ev) => {
    const target = ev.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) return;
    const k = ev.key.toLowerCase();
    if (k === "t") {
      scene.topView();
    }
    if (k === "r") {
      scene.home();
    }
    if (k === "s") {
      ev.preventDefault();
      queryWorkbench?.focus();
    }
    if (ev.key === "Escape" && state.selection !== null) deselect(true);
  });

  // ---- URL 恢复(深链)与 popstate:控件已就绪后再接线 ----
  if (location.hash.length > 1) runTask(applyUrl(true), "链接恢复");
  window.addEventListener("popstate", () =>
    runTask(applyUrl(false), "历史状态恢复"),
  );
}

void boot().catch((error: unknown) => {
  console.error("应用启动失败", error);
  const hud = document.querySelector<HTMLElement>("#hud");
  if (hud)
    hud.textContent =
      error instanceof SiteDataContractError
        ? error.message
        : "应用启动失败,请刷新重试";
});
