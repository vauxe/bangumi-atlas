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
  openGeometry,
  pointByRank,
  rankOfKey,
  watchReleaseChange,
  SiteDataContractError,
} from "./loader";
import {
  relationNeighbors,
  resolveLoadedNeighborRanks,
} from "./neighbors";
import { interactionHint, Scene } from "./scene";
import { notify, state, subscribe } from "./store";
import { TYPE_NAMES, etype } from "./types";
import { decode, encode } from "./url";
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
  const data = new Data(manifest);

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
      // 稳定 key 未解析时挂起整个 URL；全量就绪后从原 URL 重试。
      const hash = pendingUrlHash;
      pendingUrlHash = null;
      if (hash !== null && location.hash === hash)
        runTask(applyUrl(false), "深链恢复");
    }),
    "几何数据加载",
  );

  const sparseRankByKey = new Map<number, number>();
  const knownRankOfKey = (key: number): number | null => {
    const sparse = sparseRankByKey.get(key);
    if (sparse !== undefined) return sparse;
    return rankOfKey(key);
  };
  const rankOfKeyLocal = (key: number): number | null => {
    const known = knownRankOfKey(key);
    if (known !== null) return known;
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
    const neighborRanks = resolveLoadedNeighborRanks(
      factsPage.items,
      key,
      geo.key,
      geo.loaded,
      knownRankOfKey,
    );
    const nb = relationNeighbors(
      factsPage.items,
      key,
      mappings,
      (k) => neighborRanks.get(k) ?? null,
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

  // ---- 画布操作提示 ----
  const hint = $("#hint");
  let hintSelected = state.selection !== null;
  hint.textContent = interactionHint(hintSelected);
  subscribe(() => {
    const selected = state.selection !== null;
    if (selected === hintSelected) return;
    hintSelected = selected;
    hint.textContent = interactionHint(selected);
  });

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
  // 几何流已启动后再解析查询工作区；Canvas 首包不携带编辑器与答案 DOM。
  const { installQueryRuntime } = await import("./query/runtime");
  const queryWorkbench = installQueryRuntime({
    host: $("#query-dock"),
    manifest,
    data,
    geo,
    names,
    rankOfKey: rankOfKeyLocal,
    select,
    replaceUrl,
    pushUrl,
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
