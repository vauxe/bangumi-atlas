/** 启动序列与交互接线(EXPLORER.md §3-§5)。 */

import { Drawer } from "./drawer";
import { esc } from "./html";
import {
  loadAdj,
  loadCharmap,
  loadEdges,
  loadGeometry,
  loadManifest,
  loadNames,
  prefetch,
} from "./loader";
import { loadLabels } from "./labels";
import { Scene } from "./scene";
import { Search } from "./search";
import { notify, state, subscribe } from "./store";
import { MEDIA_NAMES, TYPE_NAMES, etype } from "./types";
import type { Names } from "./types";
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
  void loadCharmap();

  let names: Names | null = null;
  let scene: Scene | null = null;
  const drawer = new Drawer($("#drawer"), {
    geo: undefined as never, // 赋值于几何就绪后
    names: () => names,
    manifest,
    walk: (rank) => select(rank, true),
  });

  const tooltip = $("#tooltip");
  const geo = await loadGeometry(manifest, (loaded) => {
    hud.textContent = `渲染 ${loaded.toLocaleString()} / ${manifest.n_nodes.toLocaleString()} 节点`;
    if (scene) {
      scene.geometryGrew();
    }
  });
  (drawer as unknown as { deps: { geo: typeof geo } }).deps.geo = geo;

  const [blo, bhi] = manifest.bbox;
  const worldSize = Math.max(
    ...[0, 1, 2].map((i) => (bhi[i] ?? 1) - (blo[i] ?? 0)),
  );
  scene = new Scene($<HTMLDivElement>("#map"), geo, worldSize, {
    onPick: (rank) => {
      if (rank === null) deselect();
      else select(rank, false);
    },
    onHover: (rank, x, y) => {
      if (rank === null || rank >= geo.loaded) {
        tooltip.style.display = "none";
        return;
      }
      prefetch(geo.key[rank] ?? 0, manifest.buckets);
      const name = names?.c[rank] ?? names?.n[rank];
      tooltip.style.display = "block";
      tooltip.style.left = `${x + 12}px`;
      tooltip.style.top = `${y + 12}px`;
      tooltip.innerHTML = `${esc(name ?? "…")} <span class="tt">${esc(
        TYPE_NAMES[etype(geo.key[rank] ?? 0)] ?? "",
      )}</span>`;
    },
    onViewChange: (vs) => {
      history.replaceState(
        null,
        "",
        encode(vs, state.selection !== null
          ? geo.key[state.selection] ?? null : null),
      );
    },
  });
  hud.textContent = "";
  $("#cold").classList.add("ready");

  // 名字与边:后台补齐
  void loadNames().then((n) => {
    names = n;
  });
  void loadEdges(manifest).then((e) => scene?.setEdges(e));
  void loadLabels().then((l) => scene?.setLabels(l));
  scene.setCommunityColors();

  const rankOfKey = (key: number): number | null => {
    for (let i = 0; i < geo.loaded; i++)
      if (geo.key[i] === key) return i;
    return null;
  };

  async function select(rank: number, fly: boolean): Promise<void> {
    dockSearch();
    state.selection = rank;
    const adj = await loadAdj(geo.key[rank] ?? 0, manifest.buckets);
    if (state.selection !== rank) return;
    state.neighbors = drawer.neighborsOf(adj, 50);
    if (fly) scene?.flyTo(rank);
    void drawer.show(rank);
    notify();
  }

  function deselect(): void {
    state.selection = null;
    state.neighbors = [];
    drawer.hide();
    notify();
  }

  subscribe(() => scene?.recolor());

  // ---- URL 恢复(深链)----
  const initial = decode(location.hash);
  if (initial.view) scene.setView(initial.view);
  if (initial.key !== null) {
    const r = rankOfKey(initial.key);
    if (r !== null) void select(r, !initial.view);
  }
  window.addEventListener("popstate", () => {
    const st = decode(location.hash);
    if (st.view) scene?.setView(st.view);
    if (st.key === null) deselect();
    else {
      const r = rankOfKey(st.key);
      if (r !== null) void select(r, false);
    }
    notify();
  });

  // ---- 工具接线 ----
  new Search($("#search"), $("#hits"), (rank) => void select(rank, true));

  $("#dice").addEventListener("click", () => {
    const rank = Math.floor(Math.random() * Math.min(50_000, geo.loaded));
    void select(rank, true);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    if (ev.key === "2") scene?.topView();
    if (ev.key.toLowerCase() === "h") scene?.home();
    if (ev.key === "Escape") deselect();
  });

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
  });

  $("#layer-toggle").addEventListener("click", (ev) => {
    state.filters.colorBy =
      state.filters.colorBy === "type" ? "community" : "type";
    (ev.target as HTMLElement).textContent =
      state.filters.colorBy === "type" ? "社区着色" : "类型着色";
    notify();
  });

  $("#nsfw-toggle").addEventListener("change", (ev) => {
    state.filters.nsfw = (ev.target as HTMLInputElement).checked;
    notify();
  });

  const yMin = $("#year-min") as HTMLInputElement;
  const yMax = $("#year-max") as HTMLInputElement;
  const applyYears = (): void => {
    state.filters.yearMin = Number(yMin.value) || 0;
    state.filters.yearMax = Number(yMax.value) || 9999;
    scene?.render();
    history.replaceState(
      null,
      "",
      encode(scene?.getViewState() ?? ({} as never), null),
    );
  };
  yMin.addEventListener("input", applyYears);
  yMax.addEventListener("input", applyYears);
}

let docked = false;
function dockSearch(): void {
  if (docked) return;
  docked = true;
  const wrap = document.querySelector("#searchwrap");
  const dock = document.querySelector("#searchwrap-dock");
  if (wrap && dock) dock.appendChild(wrap);
  document.body.classList.add("docked");
  document.querySelector("#cold")?.classList.add("away");
}

void boot();
