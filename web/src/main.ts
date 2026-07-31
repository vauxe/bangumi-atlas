/** 启动序列与交互接线(EXPLORER.md §3-§5)。
 * 关键次序:场景先于几何流建立 → 首块即渲;名字表并行流式;
 * 边/标签/热分片后台补齐。历史栈:离散导航 pushState,相机/过滤
 * replaceState;popstate 完整还原(每个操作可逆)。 */

import { Drawer } from "./drawer";
import { findCommon, findPath } from "./graph";
import { esc } from "./html";
import { Results } from "./results";
import {
  loadAdj,
  loadCharmap,
  loadEdges,
  loadManifest,
  loadNames,
  openGeometry,
  pointByRank,
  prefetch,
  prefetchHotShards,
} from "./loader";
import { loadLabels } from "./labels";
import { prefersReducedMotion } from "./camera";
import { Scene } from "./scene";
import { Search } from "./search";
import { notify, state, subscribe } from "./store";
import type { LinkState } from "./store";
import { MEDIA_NAMES, TYPE_NAMES, etype } from "./types";
import { decode, encode } from "./url";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

async function boot(): Promise<void> {
  const hud = $("#hud");
  const reportError = (context: string, error: unknown): void => {
    console.error(context, error);
    hud.textContent = `${context}失败,请检查网络后重试`;
  };
  const runTask = (task: Promise<unknown>, context: string): void => {
    void task.catch((error: unknown) => reportError(context, error));
  };
  hud.textContent = "加载清单…";
  const manifest = await loadManifest();

  // ---- 数据流:先分配缓冲拿到 geo,流在场景建成后才启动 ----
  const gstream = openGeometry(manifest);
  const geo = gstream.geo;
  const { names, done: namesDone } = loadNames(manifest.n_nodes);
  namesDone.catch(() => {
    hud.textContent = "名字表加载失败,刷新重试"; // 失败显式报出
  });

  const drawer = new Drawer($("#drawer"), {
    geo,
    names: () => names,
    manifest,
    walk: (rank) => runTask(select(rank, "fly"), "节点加载"),
    arm: (kind, fromRank, fromKey) => {
      pendingLink = { kind, fromRank, fromKey };
      hud.textContent =
        kind === "common"
          ? "已锁定起点——点击或搜索另一个节点,查看共同关联"
          : "已锁定起点——点击或搜索另一个节点,查找最短路径";
    },
  });

  const tooltip = $("#tooltip");
  const showTooltip = (text: string, sub: string, x: number, y: number): void => {
    tooltip.style.display = "block";
    tooltip.style.left = `${x + 12}px`;
    tooltip.style.top = `${y + 12}px`;
    tooltip.innerHTML = `${esc(text)} <span class="tt">${esc(sub)}</span>`;
  };

  // ---- 冷启动自转状态(先声明:onViewChange 据此跳过 URL 回写)----
  let rotating = !prefersReducedMotion() && location.hash.length <= 1;
  const stopAutoRotate = (): void => {
    rotating = false;
  };

  // ---- URL 历史:离散导航入栈,相机/过滤原地替换 ----
  let historyApplications = 0;
  let replaceTimer = 0;
  const currentUrl = (): string => {
    return encode(
      scene.getViewState(),
      state.selectionKey,
      state.selection,
      scene.camera.ortho,
      state.link,
    );
  };
  const replaceUrl = (): void => {
    if (historyApplications > 0) return;
    if (replaceTimer) return;
    replaceTimer = window.setTimeout(() => {
      replaceTimer = 0;
      history.replaceState(null, "", currentUrl());
    }, 200);
  };
  const pushUrl = (): void => {
    if (historyApplications > 0) return;
    history.pushState(null, "", currentUrl());
  };

  // ---- 场景:先建,首块到达即渲(§2/§9-1)----
  const [blo, bhi] = manifest.bbox;
  const worldSize = Math.max(
    ...[0, 1, 2].map((i) => (bhi[i] ?? 1) - (blo[i] ?? 0)),
  );
  const scene: Scene = new Scene($<HTMLDivElement>("#map"), geo, worldSize, {
    onPick: (rank) => {
      if (rank === null) {
        if (state.selection !== null) deselect(true);
      } else runTask(select(rank, "center"), "节点加载");
    },
    onHover: (rank, x, y) => {
      if (rank === null || rank >= geo.loaded) {
        tooltip.style.display = "none";
        return;
      }
      stopAutoRotate();
      prefetch(geo.key[rank] ?? 0, manifest.buckets);
      const name = names.c[rank] ?? names.n[rank];
      showTooltip(
        name ?? "…",
        TYPE_NAMES[etype(geo.key[rank] ?? 0)] ?? "",
        x,
        y,
      );
    },
    onHoverEdge: (labelId, x, y) => {
      if (labelId === null) {
        tooltip.style.display = "none";
        return;
      }
      showTooltip(manifest.labels[labelId] ?? "关联", "关系", x, y);
    },
    // 自转的相机帧不写 URL(不是可分享状态);过滤器变更不受此限
    onViewChange: () => {
      if (!rotating) replaceUrl();
    },
  });
  // ---- 几何流:场景已就绪,首块回调即渲(§2/§9-1)----
  const geoDone = gstream.start((loaded) => {
    hud.textContent =
      loaded === manifest.n_nodes
        ? ""
        : `渲染 ${loaded.toLocaleString()} / ${manifest.n_nodes.toLocaleString()} 节点`;
    scene.geometryGrew();
  });

  // ---- 后台补齐(不阻塞首帧;标签延迟到空闲,SDF 图集不占首屏)----
  runTask(loadCharmap(), "搜索字表加载");
  prefetchHotShards(manifest);
  runTask(loadEdges().then((e) => scene.setEdges(e)), "骨架边加载");
  const idle =
    "requestIdleCallback" in window
      ? (fn: () => void) => requestIdleCallback(fn, { timeout: 4000 })
      : (fn: () => void) => setTimeout(fn, 1500);
  idle(() => {
    runTask(loadLabels().then((l) => scene.setLabels(l)), "标签加载");
  });
  runTask(
    geoDone.then(() => {
      hud.textContent = "";
      scene.geometryGrew();
      // 仅带 n= 的深链在流式未覆盖时挂起:全量就绪后重试落点
      if (pendingKey !== null && state.selection === null) {
        const r = rankOfKey(pendingKey);
        pendingKey = null;
        if (r !== null) runTask(select(r, "fly", false), "深链恢复");
      }
    }),
    "几何数据加载",
  );

  const rankOfKey = (key: number): number | null => {
    const sparse = sparseRankByKey.get(key);
    if (sparse !== undefined) return sparse;
    for (let i = 0; i < geo.loaded; i++)
      if (geo.key[i] === key) return i;
    return null;
  };
  const sparseRankByKey = new Map<number, number>();
  let pendingKey: number | null = null; // 深链 n= 未覆盖时的挂起落点
  let pendingLink: LinkState | null = null;
  let navigationEpoch = 0;

  /** 连接查询:第二个节点选定后计算并呈现(§4 扩展)。 */
  async function handleLink(
    link: LinkState,
    bRank: number,
    push = true,
    cam: "fly" | "none" = "fly",
  ): Promise<void> {
    const epoch = ++navigationEpoch;
    const bKey = geo.key[bRank] ?? 0;
    if (!bKey || geo.key[link.fromRank] !== link.fromKey) {
      hud.textContent = "节点身份解析失败,请刷新重试";
      return;
    }
    hud.textContent =
      link.kind === "common" ? "计算共同关联…" : "搜索路径…";
    if (link.kind === "common") {
      const { items, direct } = await findCommon(
        link.fromRank,
        bRank,
        geo,
        manifest.buckets,
      );
      if (epoch !== navigationEpoch) return;
      state.selection = bRank;
      state.selectionKey = bKey;
      state.link = link;
      state.compareWith = link.fromRank;
      state.path = [];
      state.pathLabels = [];
      const top = items.slice(0, 49);
      state.neighbors = [link.fromRank, ...top.map((i) => i.rank)];
      state.neighborLabels = [-1, ...top.map((i) => i.lb)];
      drawer.showCompare(link.fromRank, bRank, items, direct);
    } else {
      const res = await findPath(
        link.fromRank,
        bRank,
        geo,
        manifest.buckets,
      );
      if (epoch !== navigationEpoch) return;
      if (!res) {
        hud.textContent = "6 跳内未找到路径(受热度宽度上限约束)";
        await select(bRank, cam, push, bKey);
        return;
      }
      state.selection = bRank;
      state.selectionKey = bKey;
      state.link = link;
      state.compareWith = null;
      state.path = res.ranks;
      state.pathLabels = res.labels;
      state.neighbors = res.ranks.filter((r) => r !== bRank);
      state.neighborLabels = state.neighbors.map(() => -1);
      drawer.showPath(res);
      if (cam === "fly") scene.flyTo(bRank);
    }
    notify();
    if (push) pushUrl();
    hud.textContent = "";
  }

  /** 相机语义:fly = 飞行聚焦(搜索/骰子/行走);center = 枢轴
   * 滑移到节点、保持缩放(单击选中——此后滚轮推向它、右键绕它转);
   * none = 不动相机(URL 还原,尊重链接机位)。 */
  async function select(
    rank: number,
    cam: "fly" | "center" | "none",
    push = true,
    keyHint: number | null = null,
  ): Promise<void> {
    const epoch = ++navigationEpoch;
    stopAutoRotate();
    const link = pendingLink;
    pendingLink = null;
    // 普通选中即退出对比/路径视图
    state.compareWith = null;
    state.path = [];
    state.pathLabels = [];
    state.link = null;
    state.selection = rank;
    state.selectionKey = keyHint;
    // 落点未流式覆盖:一次 Range 点查同时解析坐标与 key(§6)
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
    if (link && link.fromRank !== rank) {
      await handleLink(
        link,
        rank,
        push,
        cam === "none" ? "none" : "fly",
      );
      return;
    }
    if (cam === "fly") scene.flyTo(rank);
    else if (cam === "center")
      scene.flyTo(rank, scene.getViewState().zoom);
    const adj = await loadAdj(key, manifest.buckets);
    if (epoch !== navigationEpoch || state.selection !== rank) return;
    const nb = drawer.neighborsOf(adj, 50);
    state.neighbors = nb.ranks;
    state.neighborLabels = nb.labels;
    runTask(drawer.show(rank, key), "详情加载");
    notify();
    if (push) pushUrl();
  }

  function deselect(push: boolean): void {
    navigationEpoch++;
    state.selection = null;
    state.selectionKey = null;
    state.neighbors = [];
    state.neighborLabels = [];
    state.compareWith = null;
    state.path = [];
    state.pathLabels = [];
    state.link = null;
    pendingLink = null;
    drawer.hide();
    notify();
    if (push) pushUrl();
  }

  subscribe(() => scene.recolor());

  // ---- 结果面板:过滤谓词 + 枚举 = 完整查询 ----
  const results = new Results($("#results"), {
    geo,
    names: () => names,
    visible: (r) => scene.isVisible(r),
    pick: (rank) => void select(rank, "fly"),
  });
  subscribe(() => results.refresh());
  void namesDone.then(() => results.refresh()).catch(() => {});
  runTask(geoDone.then(() => results.refresh()), "结果索引刷新");

  // ---- URL 恢复(深链)与 popstate(浏览器后退 = 回上一视图)----
  const applyUrl = async (initial: boolean): Promise<void> => {
    const epoch = ++navigationEpoch;
    historyApplications++;
    try {
      const st = decode(location.hash);
      scene.setOrtho(st.ortho);
      if (st.view) scene.setView(st.view);
      if (st.key === null && st.rank === null) {
        if (state.selection !== null || initial) deselect(false);
      } else {
        let r = st.key !== null ? rankOfKey(st.key) : null;
        let resolvedKey = st.key;
        if (r === null && st.rank !== null) {
          // 深链落点未覆盖:用 r= 提示的 rank Range 点查(有 n= 则核对)
          const pt = await pointByRank(manifest, st.rank);
          if (epoch !== navigationEpoch) return;
          if (pt && (st.key === null || pt.key === st.key)) {
            geo.sparse.set(st.rank, pt.pos);
            geo.key[st.rank] = pt.key;
            sparseRankByKey.set(pt.key, st.rank);
            r = st.rank;
            resolvedKey = pt.key;
          }
        }
        if (r !== null && resolvedKey !== null) {
          if (st.link) {
            let fromRank = rankOfKey(st.link.fromKey);
            if (fromRank === null) {
              const pt = await pointByRank(manifest, st.link.fromRank);
              if (epoch !== navigationEpoch) return;
              if (pt?.key === st.link.fromKey) {
                geo.sparse.set(st.link.fromRank, pt.pos);
                geo.key[st.link.fromRank] = pt.key;
                sparseRankByKey.set(pt.key, st.link.fromRank);
                fromRank = st.link.fromRank;
              }
            }
            if (fromRank !== null) {
              await handleLink(
                { ...st.link, fromRank },
                r,
                false,
                st.view ? "none" : "fly",
              );
            } else {
              await select(r, st.view ? "none" : "fly", false, resolvedKey);
            }
          } else {
            await select(r, st.view ? "none" : "fly", false, resolvedKey);
          }
        }
        else if (st.key !== null) pendingKey = st.key; // 全量就绪后重试
      }
      notify();
      syncControls(); // 工具栏随 store 还原(操作可逆性)
    } finally {
      historyApplications--;
    }
  };

  // ---- 搜索(命中 → flyTo + 选中 + 亮邻居)----
  new Search($("#search"), $("#hits"), (rank) =>
    runTask(select(rank, "fly"), "搜索结果加载"),
  );

  // ---- 骰子:随机传送(跳过隐藏节点;冷启动屏同款)----
  const rollDice = (): void => {
    const cap = Math.min(50_000, geo.loaded);
    if (!cap) return;
    for (let tries = 0; tries < 64; tries++) {
      const rank = Math.floor(Math.random() * cap);
      if (scene.isVisible(rank)) {
        runTask(select(rank, "fly"), "随机节点加载");
        return;
      }
    }
  };
  $("#dice").addEventListener("click", rollDice);

  // ---- 键盘(§5 输入语法表)----
  document.addEventListener("keydown", (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    const k = ev.key.toLowerCase();
    if (k === "t") scene.topView(); // Top
    if (k === "r") scene.home(); // Reset
    if (ev.key === "Escape" && state.selection !== null) deselect(true);
  });

  // ---- 媒介 chips:即时调暗 ----
  // ---- 标签过滤 chips(AND 语义)+ 评分下限滑块 ----
  const tagBox = $("#tag-chips");
  tagBox.innerHTML = manifest.tags
    .map(
      (name, bit) =>
        `<button class="chip" data-tag="${bit}" aria-pressed="false">${esc(name)}</button>`,
    )
    .join("");
  tagBox.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("[data-tag]");
    if (!b) return;
    const bit = Number(b.getAttribute("data-tag"));
    if (state.filters.tags.has(bit)) state.filters.tags.delete(bit);
    else state.filters.tags.add(bit);
    b.classList.toggle("on");
    b.setAttribute("aria-pressed", String(state.filters.tags.has(bit)));
    notify();
    replaceUrl();
  });

  const sMin = $("#score-min") as HTMLInputElement;
  const scoreLabel = $("#score-label");
  const applyScore = (): void => {
    const v = Number(sMin.value);
    state.filters.scoreMin = v;
    scoreLabel.textContent = v > 0 ? `≥ ${(v / 10).toFixed(1)}` : "不限";
    notify();
    replaceUrl();
  };
  sMin.addEventListener("input", applyScore);

  // 筛选面板折叠 + 激活计数徽标
  const filtersPanel = $("#filters");
  const filtersChev = $("#filters-head .rchev");
  $("#filters-head").addEventListener("click", () => {
    const closed = filtersPanel.classList.toggle("closed");
    filtersChev.textContent = closed ? "▸" : "▾";
    $("#filters-head").setAttribute("aria-expanded", String(!closed));
  });
  const filterBadge = $("#filters-count");
  const updateFilterBadge = (): void => {
    const f = state.filters;
    const n =
      f.tags.size +
      f.media.size +
      (f.scoreMin > 0 ? 1 : 0) +
      (f.yearMin > 0 || f.yearMax < 9999 ? 1 : 0);
    filterBadge.textContent = n > 0 ? String(n) : "";
  };
  subscribe(updateFilterBadge);

  const mediaBox = $("#media-chips");
  mediaBox.innerHTML = Object.entries(MEDIA_NAMES)
    .map(
      ([code, label]) =>
        `<button class="chip" data-media="${code}" aria-pressed="false">${label}</button>`,
    )
    .join("");
  mediaBox.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("[data-media]");
    if (!b) return;
    const code = Number(b.getAttribute("data-media"));
    if (state.filters.media.has(code)) state.filters.media.delete(code);
    else state.filters.media.add(code);
    b.classList.toggle("on");
    b.setAttribute("aria-pressed", String(state.filters.media.has(code)));
    notify();
    replaceUrl();
  });

  // ---- 时间机器:双拇指年代滑块(选中状态保留在 URL)----
  const yMin = $("#year-min") as HTMLInputElement;
  const yMax = $("#year-max") as HTMLInputElement;
  const yearLabel = $("#year-label");
  const [y0, y1] = manifest.year_range;
  yMin.min = yMax.min = String(y0 || 1900);
  yMin.max = yMax.max = String(y1 || 2030);
  yMin.value = yMin.min;
  yMax.value = yMax.max;
  const applyYears = (): void => {
    let a = Number(yMin.value);
    let b = Number(yMax.value);
    if (a > b) [a, b] = [b, a];
    const full = a <= Number(yMin.min) && b >= Number(yMax.max);
    state.filters.yearMin = full ? 0 : a;
    state.filters.yearMax = full ? 9999 : b;
    yearLabel.textContent = full ? "全部" : `${a} – ${b}`;
    notify();
    replaceUrl();
  };
  yMin.addEventListener("input", applyYears);
  yMax.addEventListener("input", applyYears);

  /** 工具栏 UI ← store:深链与 popstate 后控件不脱钩。 */
  function syncControls(): void {
    const f = state.filters;
    for (const b of mediaBox.querySelectorAll("[data-media]"))
      {
        const active = f.media.has(Number(b.getAttribute("data-media")));
        b.classList.toggle("on", active);
        b.setAttribute("aria-pressed", String(active));
      }
    for (const b of tagBox.querySelectorAll("[data-tag]"))
      {
        const active = f.tags.has(Number(b.getAttribute("data-tag")));
        b.classList.toggle("on", active);
        b.setAttribute("aria-pressed", String(active));
      }
    sMin.value = String(f.scoreMin);
    scoreLabel.textContent =
      f.scoreMin > 0 ? `≥ ${(f.scoreMin / 10).toFixed(1)}` : "不限";
    const full = f.yearMin <= 0 && f.yearMax >= 9999;
    yMin.value = full
      ? yMin.min
      : String(Math.max(f.yearMin, Number(yMin.min)));
    yMax.value = full
      ? yMax.max
      : String(Math.min(f.yearMax, Number(yMax.max)));
    yearLabel.textContent = full
      ? "全部"
      : `${yMin.value} – ${yMax.value}`;
  }

  // ---- URL 恢复(深链)与 popstate:控件已就绪后再接线 ----
  if (location.hash.length > 1) runTask(applyUrl(true), "链接恢复");
  window.addEventListener("popstate", () =>
    runTask(applyUrl(false), "历史状态恢复"),
  );

  // ---- 冷启动背景自转(状态声明在前;首次交互即停)----
  const spin = (): void => {
    if (!rotating) return;
    scene.orbitStep(0.02);
    requestAnimationFrame(spin);
  };
  requestAnimationFrame(spin);
  $("#map").addEventListener("pointerdown", stopAutoRotate, { once: true });
}

void boot().catch((error: unknown) => {
  console.error("应用启动失败", error);
  const hud = document.querySelector<HTMLElement>("#hud");
  if (hud) hud.textContent = "应用启动失败,请刷新重试";
});
