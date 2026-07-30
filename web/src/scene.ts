/** deck.gl 场景:语境层(点+近景边)、工作集聚光/X-ray、拾取、相机。 */

import { Deck, LinearInterpolator, OrbitView } from "@deck.gl/core";
import { DataFilterExtension } from "@deck.gl/extensions";
import { LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { labelLayers } from "./labels";
import type { LabelData } from "./labels";
import { state } from "./store";
import { TYPE_COLORS, etype } from "./types";
import type { Geometry } from "./types";

export interface OrbitState {
  target: [number, number, number];
  zoom: number;
  rotationX: number;
  rotationOrbit: number;
  [k: string]: unknown;
}

const DIM_ALPHA = 38; // 聚光时语境层 ~15% 亮度

export interface SceneCallbacks {
  onPick: (rank: number | null) => void;
  onHover: (rank: number | null, x: number, y: number) => void;
  onViewChange: (vs: OrbitState) => void;
}

export class Scene {
  private deck: Deck<OrbitView>;
  /** 视口恰好装下全图的 zoom(由 bbox 自适应标定)。 */
  private fitZoom: number;
  private homeState: OrbitState;
  private geo: Geometry;
  private colors: Uint8Array;
  private commColors: Uint8Array | null = null;
  private edges: Uint32Array | null = null;
  private labels: LabelData | null = null;
  private edgePositions: Float32Array | null = null;
  private viewState: OrbitState = {
    target: [0, 0, 0],
    zoom: 0,
    rotationX: 25,
    rotationOrbit: 0,
  };
  private version = 0;
  private lastPickCycle: { x: number; y: number; depth: number } | null =
    null;

  constructor(
    parent: HTMLDivElement,
    geo: Geometry,
    worldSize: number,
    private cb: SceneCallbacks,
  ) {
    this.geo = geo;
    this.fitZoom = Math.log2(
      Math.min(innerWidth, innerHeight) / Math.max(worldSize, 1),
    );
    this.homeState = {
      target: [0, 0, 0],
      zoom: this.fitZoom - 0.2,
      rotationX: 25,
      rotationOrbit: 0,
    };
    this.viewState = { ...this.homeState };
    this.colors = new Uint8Array(geo.key.length * 4);
    this.deck = new Deck({
      parent,
      views: new OrbitView({ orbitAxis: "Y" }),
      useDevicePixels: Math.min(devicePixelRatio, 1.5),
      controller: { inertia: 300 },
      initialViewState: this.viewState,
      onViewStateChange: ({ viewState }) => {
        this.viewState = viewState as unknown as OrbitState;
        this.cb.onViewChange(this.viewState);
        this.render();
        return viewState;
      },
      getCursor: ({ isHovering }) => (isHovering ? "pointer" : "grab"),
      layers: [],
    });
    this.recolor();
    this.render();
  }

  /** 全量重着色:模式/过滤/聚光一次遍历完成。 */
  recolor(): void {
    const { geo, colors } = this;
    const f = state.filters;
    const inWorkingSet = new Set<number>(state.neighbors);
    if (state.selection !== null) inWorkingSet.add(state.selection);
    const spotlight = state.selection !== null;
    for (let i = 0; i < geo.loaded; i++) {
      const flags = geo.flags[i] ?? 0;
      const media = (flags >> 2) & 7;
      const isolated = (flags & 2) !== 0;
      const nsfw = (flags & 1) !== 0;
      let [r, g, b] = TYPE_COLORS[etype(geo.key[i] ?? 0)] ?? [128, 128, 128];
      if (f.colorBy === "community" && this.commColors) {
        r = this.commColors[i * 3] ?? r;
        g = this.commColors[i * 3 + 1] ?? g;
        b = this.commColors[i * 3 + 2] ?? b;
      }
      let a = isolated ? 110 : 210;
      if (nsfw && !f.nsfw) a = 0;
      if (f.media.size && media > 0 && !f.media.has(media)) a = 40;
      if (spotlight && !inWorkingSet.has(i)) a = Math.min(a, DIM_ALPHA);
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
    }
    this.version++;
    this.render();
  }

  setCommunityColors(): void {
    const { geo } = this;
    const cc = new Uint8Array(geo.key.length * 3);
    for (let i = 0; i < geo.key.length; i++) {
      const c = geo.community[i] ?? 0;
      const h = ((c * 137.508) % 360) / 60; // 黄金角散列,低饱和
      const x = 1 - Math.abs((h % 2) - 1);
      const rgb =
        h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x]
        : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
      cc[i * 3] = 90 + (rgb[0] ?? 0) * 140;
      cc[i * 3 + 1] = 90 + (rgb[1] ?? 0) * 140;
      cc[i * 3 + 2] = 90 + (rgb[2] ?? 0) * 140;
    }
    this.commColors = cc;
  }

  setEdges(edges: Uint32Array): void {
    this.edges = edges;
    const n = edges.length / 2;
    const p = new Float32Array(n * 6);
    for (let e = 0; e < n; e++) {
      const a = edges[e * 2] ?? 0;
      const b = edges[e * 2 + 1] ?? 0;
      for (let k = 0; k < 3; k++) {
        p[e * 6 + k] = this.geo.positions[a * 3 + k] ?? 0;
        p[e * 6 + 3 + k] = this.geo.positions[b * 3 + k] ?? 0;
      }
    }
    this.edgePositions = p;
    this.render();
  }

  setLabels(l: LabelData): void {
    this.labels = l;
    this.render();
  }

  geometryGrew(): void {
    this.recolor();
  }

  flyTo(rank: number, zoom?: number): void {
    const z = zoom ?? this.fitZoom + 4.5;
    const p = this.geo.positions;
    this.viewState = {
      ...this.viewState,
      target: [p[rank * 3] ?? 0, p[rank * 3 + 1] ?? 0, p[rank * 3 + 2] ?? 0],
      zoom: z,
      transitionDuration: prefersReducedMotion() ? 0 : 400,
      transitionInterpolator: new LinearInterpolator([
        "target",
        "zoom",
        "rotationX",
        "rotationOrbit",
      ]),
    };
    this.deck.setProps({
      initialViewState: this.viewState,
    });
    this.cb.onViewChange(this.viewState);
    this.render();
  }

  setView(vs: Partial<OrbitState>): void {
    this.viewState = { ...this.viewState, ...vs };
    this.deck.setProps({ initialViewState: this.viewState });
    this.render();
  }

  topView(): void {
    this.setView({ rotationX: 89.9, rotationOrbit: 0 });
  }

  home(): void {
    this.setView({ ...this.homeState });
  }

  private workingSetLayers(): unknown[] {
    if (state.selection === null) return [];
    const ranks = [state.selection, ...state.neighbors];
    const pos = new Float32Array(ranks.length * 3);
    const col = new Uint8Array(ranks.length * 4);
    ranks.forEach((rk, i) => {
      for (let k = 0; k < 3; k++)
        pos[i * 3 + k] = this.geo.positions[rk * 3 + k] ?? 0;
      const [r, g, b] = TYPE_COLORS[etype(this.geo.key[rk] ?? 0)] ?? [
        255, 255, 255,
      ];
      col.set(i === 0 ? [255, 255, 255, 255] : [r, g, b, 255], i * 4);
    });
    const linePos = new Float32Array(state.neighbors.length * 6);
    state.neighbors.forEach((rk, i) => {
      for (let k = 0; k < 3; k++) {
        linePos[i * 6 + k] =
          this.geo.positions[(state.selection ?? 0) * 3 + k] ?? 0;
        linePos[i * 6 + 3 + k] = this.geo.positions[rk * 3 + k] ?? 0;
      }
    });
    return [
      new LineLayer({
        id: "ws-edges",
        data: {
          length: state.neighbors.length,
          attributes: {
            getSourcePosition: { value: linePos, size: 3, stride: 24 },
            getTargetPosition: {
              value: linePos,
              size: 3,
              stride: 24,
              offset: 12,
            },
          },
        },
        getColor: [255, 255, 255, 90],
        getWidth: 1.2,
        widthUnits: "pixels",
        parameters: { depthCompare: "always" },
      }),
      // X-ray 通道:深度失败也可见(低亮)
      new ScatterplotLayer({
        id: "ws-xray",
        data: {
          length: ranks.length,
          attributes: {
            getPosition: { value: pos, size: 3 },
            getFillColor: { value: col, size: 4 },
          },
        },
        radiusUnits: "common",
        getRadius: 2.2,
        radiusMinPixels: 3,
        radiusMaxPixels: 9,
        opacity: 0.35,
        parameters: { depthCompare: "always" },
        billboard: true,
      }),
      // 正常深度通道:高亮实体
      new ScatterplotLayer({
        id: "ws-lit",
        data: {
          length: ranks.length,
          attributes: {
            getPosition: { value: pos, size: 3 },
            getFillColor: { value: col, size: 4 },
          },
        },
        radiusUnits: "common",
        getRadius: 2.2,
        radiusMinPixels: 3,
        radiusMaxPixels: 9,
        stroked: true,
        getLineColor: [255, 255, 255, 200],
        getLineWidth: 1,
        lineWidthUnits: "pixels",
        billboard: true,
        pickable: true,
        onClick: (info: { index: number }) => {
          const rk = ranks[info.index];
          if (rk !== undefined) this.cb.onPick(rk);
          return true;
        },
      }),
    ];
  }

  render(): void {
    const { geo } = this;
    const f = state.filters;
    const layers: unknown[] = [
      new ScatterplotLayer({
        id: "context",
        data: {
          length: geo.loaded,
          attributes: {
            getPosition: { value: geo.positions, size: 3 },
            getFillColor: { value: this.colors, size: 4 },
            getRadius: { value: geo.size, size: 1 },
            getFilterValue: {
              value: new Float32Array(geo.year),
              size: 1,
            },
          },
        },
        updateTriggers: { getFillColor: this.version },
        radiusUnits: "common",
        radiusScale: 0.02,
        radiusMinPixels: 1.5,
        radiusMaxPixels: 6,
        billboard: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 120],
        extensions: [new DataFilterExtension({ filterSize: 1 })],
        filterRange: [
          f.yearMin === 0 ? -1 : f.yearMin,
          f.yearMax >= 9999 ? 99999 : f.yearMax,
        ],
        onHover: (info: { index: number; x: number; y: number }) => {
          this.cb.onHover(
            info.index >= 0 ? info.index : null,
            info.x,
            info.y,
          );
        },
        onClick: (info: { index: number; x: number; y: number }) => {
          this.pickWithCycle(info);
          return true;
        },
      }),
    ];
    if (
      this.edgePositions &&
      this.viewState.zoom >= this.fitZoom + 2.5 &&
      this.edges
    ) {
      layers.push(
        new LineLayer({
          id: "context-edges",
          data: {
            length: this.edges.length / 2,
            attributes: {
              getSourcePosition: {
                value: this.edgePositions,
                size: 3,
                stride: 24,
              },
              getTargetPosition: {
                value: this.edgePositions,
                size: 3,
                stride: 24,
                offset: 12,
              },
            },
          },
          getColor: [255, 255, 255, 16],
          getWidth: 1,
          widthUnits: "pixels",
        }),
      );
    }
    if (this.labels)
      layers.push(
        ...labelLayers(this.labels, geo, this.viewState.zoom - this.fitZoom),
      );
    layers.push(...this.workingSetLayers());
    this.deck.setProps({ layers: layers as never[] });
  }

  /** 重叠处连续点击循环切换:同一位置再点,拾取下一深度候选。 */
  private pickWithCycle(info: { index: number; x: number; y: number }): void {
    const prev = this.lastPickCycle;
    if (prev && Math.abs(prev.x - info.x) < 4 && Math.abs(prev.y - info.y) < 4) {
      const picks = this.deck.pickMultipleObjects({
        x: info.x,
        y: info.y,
        radius: 4,
        depth: prev.depth + 2,
        layerIds: ["context"],
      });
      const next = picks[(prev.depth + 1) % Math.max(picks.length, 1)];
      this.lastPickCycle = { x: info.x, y: info.y, depth: prev.depth + 1 };
      this.cb.onPick(next ? (next.index as number) : info.index);
      return;
    }
    this.lastPickCycle = { x: info.x, y: info.y, depth: 0 };
    this.cb.onPick(info.index >= 0 ? info.index : null);
  }

  getViewState(): OrbitState {
    return this.viewState;
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
