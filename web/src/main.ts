/** 启动序列与交互接线(EXPLORER.md §3-§5)。
 * 关键次序:场景先于几何流建立 → 首块即渲;名字表并行流式;
 * 边/标签/热分片后台补齐。历史栈:离散导航 pushState,相机/过滤
 * replaceState;popstate 完整还原(每个操作可逆)。 */

import { Drawer } from "./drawer";
import { esc } from "./html";
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
import { MEDIA_NAMES, TYPE_NAMES, etype } from "./types";
import { decode, encode } from "./url";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

async function boot(): Promise<void> {
  const hud = $("#hud");
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
    walk: (rank) => void select(rank, "fly"),
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
  let applyingHistory = false;
  let replaceTimer = 0;
  const currentUrl = (): string => {
    // 选中节点未流式覆盖时 key 尚为 0:URL 只携带 r=,恢复时点查核对
    const k =
      state.selection !== null ? (geo.key[state.selection] ?? 0) : 0;
    return encode(
      scene.getViewState(),
      k || null,
      state.selection,
      scene.camera.ortho,
    );
  };
  const replaceUrl = (): void => {
    if (applyingHistory || rotating) return; // 自转不是可分享状态
    if (replaceTimer) return;
    replaceTimer = window.setTimeout(() => {
      replaceTimer = 0;
      history.replaceState(null, "", currentUrl());
    }, 200);
  };
  const pushUrl = (): void => {
    if (applyingHistory) return;
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
      } else void select(rank, "center");
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
    onViewChange: () => replaceUrl(),
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
  void loadCharmap();
  prefetchHotShards(manifest);
  void loadEdges().then((e) => scene.setEdges(e));
  const idle =
    "requestIdleCallback" in window
      ? (fn: () => void) => requestIdleCallback(fn, { timeout: 4000 })
      : (fn: () => void) => setTimeout(fn, 1500);
  idle(() => {
    void loadLabels(manifest.version).then((l) => scene.setLabels(l));
  });
  void geoDone.then(() => {
    hud.textContent = "";
    scene.geometryGrew();
    // 仅带 n= 的深链在流式未覆盖时挂起:全量就绪后重试落点
    if (pendingKey !== null && state.selection === null) {
      const r = rankOfKey(pendingKey);
      pendingKey = null;
      if (r !== null) void select(r, "fly", false);
    }
  });

  const rankOfKey = (key: number): number | null => {
    for (let i = 0; i < geo.loaded; i++)
      if (geo.key[i] === key) return i;
    return null;
  };
  let pendingKey: number | null = null; // 深链 n= 未覆盖时的挂起落点

  /** 相机语义:fly = 飞行聚焦(搜索/骰子/行走);center = 枢轴
   * 滑移到节点、保持缩放(单击选中——此后滚轮推向它、右键绕它转);
   * none = 不动相机(URL 还原,尊重链接机位)。 */
  async function select(
    rank: number,
    cam: "fly" | "center" | "none",
    push = true,
  ): Promise<void> {
    stopAutoRotate();
    state.selection = rank;
    // 落点未流式覆盖:一次 Range 点查同时解析坐标与 key(§6)
    let key = geo.key[rank] ?? 0;
    if (rank >= geo.loaded && (!geo.sparse.has(rank) || !key)) {
      const pt = await pointByRank(manifest, rank);
      if (state.selection !== rank) return;
      if (pt) {
        geo.sparse.set(rank, pt.pos);
        key = pt.key;
      }
    }
    if (cam === "fly") scene.flyTo(rank);
    else if (cam === "center")
      scene.flyTo(rank, scene.getViewState().zoom);
    const adj = await loadAdj(key, manifest.buckets);
    if (state.selection !== rank) return;
    const nb = drawer.neighborsOf(adj, 50);
    state.neighbors = nb.ranks;
    state.neighborLabels = nb.labels;
    void drawer.show(rank, key);
    notify();
    if (push) pushUrl();
  }

  function deselect(push: boolean): void {
    state.selection = null;
    state.neighbors = [];
    state.neighborLabels = [];
    drawer.hide();
    notify();
    if (push) pushUrl();
  }

  subscribe(() => scene.recolor());

  // ---- URL 恢复(深链)与 popstate(浏览器后退 = 回上一视图)----
  const applyUrl = async (initial: boolean): Promise<void> => {
    applyingHistory = true;
    try {
      const st = decode(location.hash);
      scene.setOrtho(st.ortho);
      if (st.view) scene.setView(st.view);
      if (st.key === null && st.rank === null) {
        if (state.selection !== null || initial) deselect(false);
      } else {
        let r = st.key !== null ? rankOfKey(st.key) : null;
        if (r === null && st.rank !== null) {
          // 深链落点未覆盖:用 r= 提示的 rank Range 点查(有 n= 则核对)
          const pt = await pointByRank(manifest, st.rank);
          if (pt && (st.key === null || pt.key === st.key)) {
            geo.sparse.set(st.rank, pt.pos);
            r = st.rank;
          }
        }
        if (r !== null)
          await select(r, st.view ? "none" : "fly", false);
        else if (st.key !== null) pendingKey = st.key; // 全量就绪后重试
      }
      notify();
      syncControls(); // 工具栏随 store 还原(操作可逆性)
    } finally {
      applyingHistory = false;
    }
  };

  // ---- 搜索(命中 → flyTo + 选中 + 亮邻居)----
  new Search($("#search"), $("#hits"), (rank) => void select(rank, "fly"));

  // ---- 骰子:随机传送(跳过隐藏节点;冷启动屏同款)----
  const rollDice = (): void => {
    const cap = Math.min(50_000, geo.loaded);
    if (!cap) return;
    for (let tries = 0; tries < 64; tries++) {
      const rank = Math.floor(Math.random() * cap);
      if (scene.isVisible(rank)) {
        void select(rank, "fly");
        return;
      }
    }
  };
  $("#dice").addEventListener("click", rollDice);

  // ---- 键盘(§5 输入语法表)----
  document.addEventListener("keydown", (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    if (ev.key === "2") scene.topView();
    if (ev.key.toLowerCase() === "h") scene.home();
    if (ev.key === "Escape" && state.selection !== null) deselect(true);
  });
  $("#top-toggle").addEventListener("click", () => scene.topView());

  // ---- 媒介 chips:即时调暗 ----
  const mediaBox = $("#media-chips");
  mediaBox.innerHTML = Object.entries(MEDIA_NAMES)
    .map(
      ([code, label]) =>
        `<button class="chip" data-media="${code}">${label}</button>`,
    )
    .join("");
  mediaBox.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("[data-media]");
    if (!b) return;
    const code = Number(b.getAttribute("data-media"));
    if (state.filters.media.has(code)) state.filters.media.delete(code);
    else state.filters.media.add(code);
    b.classList.toggle("on");
    notify();
    replaceUrl();
  });

  $("#layer-toggle").addEventListener("click", (ev) => {
    state.filters.colorBy =
      state.filters.colorBy === "type" ? "community" : "type";
    (ev.target as HTMLElement).textContent =
      state.filters.colorBy === "type" ? "社区着色" : "类型着色";
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
    yearLabel.textContent = full ? "全部年代" : `${a} – ${b}`;
    notify();
    replaceUrl();
  };
  yMin.addEventListener("input", applyYears);
  yMax.addEventListener("input", applyYears);

  /** 工具栏 UI ← store:深链与 popstate 后控件不脱钩。 */
  function syncControls(): void {
    const f = state.filters;
    for (const b of mediaBox.querySelectorAll("[data-media]"))
      b.classList.toggle(
        "on",
        f.media.has(Number(b.getAttribute("data-media"))),
      );
    $("#layer-toggle").textContent =
      f.colorBy === "type" ? "社区着色" : "类型着色";
    const full = f.yearMin <= 0 && f.yearMax >= 9999;
    yMin.value = full
      ? yMin.min
      : String(Math.max(f.yearMin, Number(yMin.min)));
    yMax.value = full
      ? yMax.max
      : String(Math.min(f.yearMax, Number(yMax.max)));
    yearLabel.textContent = full
      ? "全部年代"
      : `${yMin.value} – ${yMax.value}`;
  }

  // ---- URL 恢复(深链)与 popstate:控件已就绪后再接线 ----
  if (location.hash.length > 1) void applyUrl(true);
  window.addEventListener("popstate", () => void applyUrl(false));

  // ---- 冷启动背景自转(状态声明在前;首次交互即停)----
  const spin = (): void => {
    if (!rotating) return;
    scene.orbitStep(0.02);
    requestAnimationFrame(spin);
  };
  requestAnimationFrame(spin);
  $("#map").addEventListener("pointerdown", stopAutoRotate, { once: true });
}

void boot();
