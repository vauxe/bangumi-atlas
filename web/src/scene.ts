/** deck.gl 场景:语境层(点+近景视锥内骨架边)、工作集聚光/X-ray、
 * GPU 拾取、雾。可见性(NSFW/年份)走 GPU filter,被滤除节点连拾取
 * 一起消失;人物/角色在时间过滤下只降暗不隐藏(§4)。 */

import { Deck, LayerExtension, OrbitView } from "@deck.gl/core";
import { DataFilterExtension } from "@deck.gl/extensions";
import { LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Camera, prefersReducedMotion } from "./camera";
import type { OrbitState } from "./camera";
import { labelLayers } from "./labels";
import type { LabelData } from "./labels";
import { state } from "./store";
import { TYPE_COLORS, etype } from "./types";
import type { Geometry } from "./types";

export type { OrbitState } from "./camera";

const DIM_ALPHA = 38; // 聚光时语境层 ~15% 亮度
const PERSON_DIM = 90; // 时间过滤:人物/角色降暗(不隐藏,§4)
const EDGE_ZOOM = 2.5; // fitZoom + 2.5 起近景淡入骨架边
const EDGE_CAP = 120_000; // 可见边上限(spike:边是填充率杀手)
const EDGE_FADE_MS = 250;
const CASCADE_STEP_MS = 30; // §5:邻居 30ms 级联淡入
const CASCADE_FADE_MS = 200;
const PULSE_MS = 500; // §5:选中光环单脉冲

// ---- 雾扩展:只挂语境层,按到相机距离衰减 alpha(§4 深度线索)----
const fogShaderModule = {
  name: "fog",
  vs: `uniform fogUniforms { vec3 cameraPos; float start; float falloff; } fog;
out float fog_depth;`,
  fs: `uniform fogUniforms { vec3 cameraPos; float start; float falloff; } fog;
in float fog_depth;`,
  uniformTypes: {
    cameraPos: "vec3<f32>",
    start: "f32",
    falloff: "f32",
  },
} as const;

interface FogProps {
  fogCamera: [number, number, number];
  fogStart: number;
  fogFalloff: number;
}

class FogExtension extends LayerExtension {
  static override extensionName = "FogExtension";

  override getShaders(): Record<string, unknown> {
    return {
      modules: [fogShaderModule],
      inject: {
        "vs:#main-end":
          "fog_depth = distance(geometry.worldPosition.xyz, fog.cameraPos);",
        "fs:DECKGL_FILTER_COLOR": `
          color.a *= mix(0.25, 1.0,
            exp(-max(fog_depth - fog.start, 0.0) * fog.falloff));`,
      },
    };
  }

  override updateState(params: unknown): void {
    const props = (params as { props: Partial<FogProps> }).props;
    if (!props.fogCamera) return;
    const models = (
      this as unknown as { getModels(): unknown[] }
    ).getModels();
    for (const model of models) {
      const m = model as {
        shaderInputs?: {
          setProps?: (p: Record<string, unknown>) => void;
        };
      };
      m.shaderInputs?.setProps?.({
        fog: {
          cameraPos: props.fogCamera,
          start: props.fogStart ?? 0,
          falloff: props.fogFalloff ?? 0,
        },
      });
    }
  }
}

interface ContextData {
  length: number;
  attributes: Record<
    string,
    {
      value: Float32Array | Uint8Array;
      size: number;
      stride?: number;
      offset?: number;
    }
  >;
}

export interface SceneCallbacks {
  onPick: (rank: number | null) => void;
  onHover: (rank: number | null, x: number, y: number) => void;
  /** 工作集边悬停:解码关系 labelId(语境骨架边不出 tooltip)。 */
  onHoverEdge: (labelId: number | null, x: number, y: number) => void;
  onViewChange: (vs: OrbitState) => void;
}

export class Scene {
  readonly camera: Camera;
  private deck: Deck<OrbitView>;
  private geo: Geometry;
  private worldSize: number;
  private colors: Uint8Array;
  private visible: Float32Array;
  private labels: LabelData | null = null;
  private labelVersion = 0;

  private contextData: ContextData | null = null;
  private contextVersion = 0;
  private builtVersion = -1;

  private edges: Uint32Array | null = null;
  private edgePos: Float32Array | null = null; // 预分配 EDGE_CAP*6
  private edgeData: ContextData | null = null;
  private edgeCount = 0;
  private edgeOpacity = 0;
  private edgeFadeRaf = 0;
  private edgeRebuildTimer = 0;

  private wsAnimStart = 0;
  private wsRaf = 0;
  private lastSelection: number | null = null;
  private lastPickCycle: { x: number; y: number; depth: number } | null =
    null;

  constructor(
    parent: HTMLDivElement,
    geo: Geometry,
    worldSize: number,
    private cb: SceneCallbacks,
  ) {
    this.geo = geo;
    this.worldSize = worldSize;
    this.camera = new Camera(worldSize);
    this.colors = new Uint8Array(geo.key.length * 4);
    this.visible = new Float32Array(geo.key.length);
    this.deck = new Deck({
      parent,
      views: this.camera.view(),
      useDevicePixels: Math.min(devicePixelRatio, 1.5),
      // §5:左键拖 = 平移,右键拖 = 轨道旋转(deck 默认相反)
      controller: { inertia: 300, doubleClickZoom: false, dragMode: "pan" },
      initialViewState: this.camera.viewState,
      pickingRadius: 5,
      onViewStateChange: ({ viewState }) => {
        this.camera.absorb(viewState as Record<string, unknown>);
        this.cb.onViewChange(this.camera.viewState);
        this.scheduleEdgeRebuild();
        this.render();
        return viewState;
      },
      onClick: (info: { layer: unknown }) => {
        if (!info.layer) {
          this.lastPickCycle = null; // 循环拾取状态随空白点击复位
          this.cb.onPick(null); // 单击空白 = 取消选中
        }
      },
      getCursor: ({ isHovering }) => (isHovering ? "pointer" : "grab"),
      layers: [],
    });
    // 双击 = 聚焦飞行(controller 的 doubleClickZoom 已让位)
    parent.addEventListener("dblclick", (ev) => {
      const picks = this.deck.pickMultipleObjects({
        x: ev.clientX,
        y: ev.clientY,
        radius: 5,
        depth: 1,
        layerIds: ["context"], // index 即 rank(工作集层下标语义不同)
      });
      const rank = picks[0]?.index;
      if (typeof rank === "number" && rank >= 0) this.flyTo(rank);
    });
    this.recolor();
  }

  posOf(rank: number): [number, number, number] | null {
    if (rank < this.geo.loaded) {
      const p = this.geo.positions;
      return [
        p[rank * 3] ?? 0,
        p[rank * 3 + 1] ?? 0,
        p[rank * 3 + 2] ?? 0,
      ];
    }
    return this.geo.sparse.get(rank) ?? null;
  }

  isVisible(rank: number): boolean {
    return (this.visible[rank] ?? 0) > 0;
  }

  /** 全量重着色 + 可见性掩码:模式/过滤/聚光一次遍历完成。 */
  recolor(): void {
    const { geo, colors, visible } = this;
    const f = state.filters;
    const inWorkingSet = new Set<number>(state.neighbors);
    if (state.selection !== null) inWorkingSet.add(state.selection);
    const spotlight = state.selection !== null;
    const yearFiltered = f.yearMin > 0 || f.yearMax < 9999;
    if (state.selection !== this.lastSelection) {
      this.lastSelection = state.selection;
      this.startWorkingSetAnim();
    }
    for (let i = 0; i < geo.loaded; i++) {
      const flags = geo.flags[i] ?? 0;
      const media = (flags >> 2) & 7;
      const isolated = (flags & 2) !== 0;
      const nsfw = (flags & 1) !== 0;
      const t = etype(geo.key[i] ?? 0);
      const year = geo.year[i] ?? 0;
      // 可见性:NSFW 关则彻底消失(不可拾取);年份过滤只滤作品
      let vis = 1;
      if (nsfw && !f.nsfw) vis = 0;
      else if (
        yearFiltered &&
        t === 1 &&
        year > 0 &&
        (year < f.yearMin || year > f.yearMax)
      )
        vis = 0;
      visible[i] = vis;
      let [r, g, b] = TYPE_COLORS[t] ?? [128, 128, 128];
      if (f.colorBy === "community") {
        // 社区色内联计算:流式期间 community 逐块就绪,缓存表会算死
        const c = geo.community[i] ?? 0;
        if (c !== 0xffff) {
          const h = ((c * 137.508) % 360) / 60; // 黄金角散列,低饱和
          const x = 1 - Math.abs((h % 2) - 1);
          const rgb =
            h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x]
            : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
          r = 90 + (rgb[0] ?? 0) * 140;
          g = 90 + (rgb[1] ?? 0) * 140;
          b = 90 + (rgb[2] ?? 0) * 140;
        }
      }
      // 收藏度编码于钳制带内的尺寸序与亮度(§4):160–210 亮度带
      let a = isolated
        ? 110
        : 160 + Math.min(50, (geo.size[i] ?? 0) >> 2);
      // 人物/角色(以及无年份作品)随时间过滤降暗,不隐藏(§4)
      if (yearFiltered && (t !== 1 || year === 0)) a = Math.min(a, PERSON_DIM);
      if (f.media.size && media > 0 && !f.media.has(media)) a = 40;
      if (spotlight && !inWorkingSet.has(i)) a = Math.min(a, DIM_ALPHA);
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
    }
    this.contextVersion++;
    this.rebuildEdgeSet();
    this.render();
  }

  /** 正交开关(URL 还原用;`2` 键走 topView)。 */
  setOrtho(v: boolean): void {
    if (this.camera.ortho === v) return;
    this.camera.ortho = v;
    this.applyCamera(true);
  }

  /** 骨架边(权重降序,客户端前缀优先)。 */
  setEdges(edges: Uint32Array): void {
    this.edges = edges;
    this.edgePos = new Float32Array(EDGE_CAP * 6);
    this.rebuildEdgeSet();
    this.render();
  }

  setLabels(l: LabelData): void {
    this.labels = l;
    this.labelVersion++;
    this.render();
  }

  geometryGrew(): void {
    this.recolor();
    this.scheduleEdgeRebuild();
  }

  flyTo(rank: number, zoom?: number): void {
    const pos = this.posOf(rank);
    if (!pos) return;
    this.deck.setProps({
      initialViewState: this.camera.flyTo(pos, zoom),
    });
    this.cb.onViewChange(this.camera.viewState);
    this.scheduleEdgeRebuild();
    this.render();
  }

  setView(vs: Partial<OrbitState>): void {
    this.camera.viewState = { ...this.camera.viewState, ...vs };
    this.applyCamera();
  }

  topView(): void {
    this.camera.toggleTop();
    this.applyCamera(true);
  }

  home(): void {
    this.camera.home();
    this.applyCamera(true);
  }

  orbitStep(deg: number): void {
    this.camera.orbitStep(deg);
    this.applyCamera();
  }

  getViewState(): OrbitState {
    return this.camera.viewState;
  }

  private applyCamera(viewMayChange = false): void {
    this.deck.setProps({
      ...(viewMayChange ? { views: this.camera.view() } : {}),
      initialViewState: { ...this.camera.viewState },
    });
    this.cb.onViewChange(this.camera.viewState);
    this.scheduleEdgeRebuild();
    this.render();
  }

  // ---- 骨架边可见集:CPU 毫秒级重建(§4;含单端被滤除的边)----
  private scheduleEdgeRebuild(): void {
    if (this.edgeRebuildTimer) return;
    this.edgeRebuildTimer = window.setTimeout(() => {
      this.edgeRebuildTimer = 0;
      this.rebuildEdgeSet();
      this.render();
    }, 120);
  }

  private rebuildEdgeSet(): void {
    const { edges, edgePos, geo, visible } = this;
    if (!edges || !edgePos) return;
    const zoomRel = this.camera.viewState.zoom - this.camera.fitZoom;
    const wasOn = this.edgeCount > 0;
    if (zoomRel < EDGE_ZOOM) {
      this.edgeCount = 0;
      this.edgeData = null;
      return;
    }
    // 视锥近似:相机目标周围一个随 zoom 收缩的球;端点任一入球即取
    const [tx, ty, tz] = this.camera.viewState.target;
    const radius = (this.worldSize / Math.pow(2, zoomRel)) * 1.5;
    const r2 = radius * radius;
    const pos = geo.positions;
    let cnt = 0;
    const n = edges.length / 2;
    for (let e = 0; e < n && cnt < EDGE_CAP; e++) {
      const a = edges[e * 2] ?? 0;
      const b = edges[e * 2 + 1] ?? 0;
      if (a >= geo.loaded || b >= geo.loaded) continue;
      if (!visible[a] || !visible[b]) continue;
      const ax = pos[a * 3] ?? 0;
      const ay = pos[a * 3 + 1] ?? 0;
      const az = pos[a * 3 + 2] ?? 0;
      const bx = pos[b * 3] ?? 0;
      const by = pos[b * 3 + 1] ?? 0;
      const bz = pos[b * 3 + 2] ?? 0;
      const da =
        (ax - tx) * (ax - tx) + (ay - ty) * (ay - ty) + (az - tz) * (az - tz);
      const db =
        (bx - tx) * (bx - tx) + (by - ty) * (by - ty) + (bz - tz) * (bz - tz);
      if (Math.min(da, db) > r2) continue;
      const o = cnt * 6;
      edgePos[o] = ax;
      edgePos[o + 1] = ay;
      edgePos[o + 2] = az;
      edgePos[o + 3] = bx;
      edgePos[o + 4] = by;
      edgePos[o + 5] = bz;
      cnt++;
    }
    this.edgeCount = cnt;
    // data 对象只在重建时更换:render 每帧复用同一引用,防重复上传
    this.edgeData = {
      length: cnt,
      attributes: {
        getSourcePosition: { value: edgePos, size: 3, stride: 24 },
        getTargetPosition: { value: edgePos, size: 3, stride: 24, offset: 12 },
      },
    };
    if (!wasOn && cnt > 0) this.startEdgeFade();
  }

  /** 骨架边淡入(§2/§4;prefers-reduced-motion 直接到位)。 */
  private startEdgeFade(): void {
    if (prefersReducedMotion()) {
      this.edgeOpacity = 1;
      return;
    }
    this.edgeOpacity = 0;
    const t0 = performance.now();
    cancelAnimationFrame(this.edgeFadeRaf);
    const tick = (): void => {
      this.edgeOpacity = Math.min(
        1,
        (performance.now() - t0) / EDGE_FADE_MS,
      );
      this.render();
      if (this.edgeOpacity < 1)
        this.edgeFadeRaf = requestAnimationFrame(tick);
    };
    this.edgeFadeRaf = requestAnimationFrame(tick);
  }

  // ---- 工作集动效:级联淡入 + 光环单脉冲(动效仅三,§5)----
  private startWorkingSetAnim(): void {
    this.wsAnimStart = performance.now();
    cancelAnimationFrame(this.wsRaf);
    if (prefersReducedMotion() || state.selection === null) return;
    const total =
      Math.min(state.neighbors.length, 50) * CASCADE_STEP_MS +
      CASCADE_FADE_MS +
      PULSE_MS;
    const tick = (): void => {
      this.render();
      if (performance.now() - this.wsAnimStart < total)
        this.wsRaf = requestAnimationFrame(tick);
    };
    this.wsRaf = requestAnimationFrame(tick);
  }

  private workingSetLayers(): unknown[] {
    if (state.selection === null) return [];
    const sel = state.selection;
    const selPos = this.posOf(sel);
    if (!selPos) return [];
    const reduced = prefersReducedMotion();
    const t = performance.now() - this.wsAnimStart;
    // 未流式覆盖且无 sparse 坐标的邻居先不画(位置未知,不能画到原点);
    // NSFW 关时 NSFW 邻居不进工作集(§4 反模式:任何路径不复亮)
    const shown: { rank: number; label: number; pos: [number, number, number] }[] = [];
    state.neighbors.forEach((rk, i) => {
      if (
        !state.filters.nsfw &&
        rk < this.geo.loaded &&
        ((this.geo.flags[rk] ?? 0) & 1) !== 0
      )
        return;
      const p = this.posOf(rk);
      if (p) shown.push({ rank: rk, label: state.neighborLabels[i] ?? -1, pos: p });
    });
    const ranks = [sel, ...shown.map((s) => s.rank)];
    const pos = new Float32Array(ranks.length * 3);
    const col = new Uint8Array(ranks.length * 4);
    const lineCol = new Uint8Array(ranks.length * 4);
    pos.set(selPos, 0);
    col.set([255, 255, 255, 255], 0);
    lineCol.set([255, 255, 255, 255], 0);
    shown.forEach((s, i) => {
      pos.set(s.pos, (i + 1) * 3);
      const [r, g, b] = TYPE_COLORS[etype(this.geo.key[s.rank] ?? 0)] ?? [
        255, 255, 255,
      ];
      // 级联淡入:第 i 个邻居延迟 i*30ms,各自 200ms 到位
      const k = reduced
        ? 1
        : Math.max(
            0,
            Math.min(1, (t - i * CASCADE_STEP_MS) / CASCADE_FADE_MS),
          );
      col.set([r, g, b, Math.round(255 * k)], (i + 1) * 4);
      lineCol.set([r, g, b, Math.round(255 * k)], (i + 1) * 4);
    });
    const linePos = new Float32Array(shown.length * 6);
    const lineAlpha = new Uint8Array(shown.length * 4);
    shown.forEach((s, i) => {
      linePos.set(selPos, i * 6);
      linePos.set(s.pos, i * 6 + 3);
      const k = reduced
        ? 1
        : Math.max(
            0,
            Math.min(1, (t - i * CASCADE_STEP_MS) / CASCADE_FADE_MS),
          );
      lineAlpha.set([255, 255, 255, Math.round(90 * k)], i * 4);
    });
    const layers: unknown[] = [
      new LineLayer({
        id: "ws-edges",
        data: {
          length: shown.length,
          attributes: {
            getSourcePosition: { value: linePos, size: 3, stride: 24 },
            getTargetPosition: {
              value: linePos,
              size: 3,
              stride: 24,
              offset: 12,
            },
            getColor: { value: lineAlpha, size: 4 },
          },
        },
        getWidth: 1.6,
        widthUnits: "pixels",
        pickable: true, // §5:悬停工作集边 → 解码关系名 tooltip
        onHover: (info: { index: number; x: number; y: number }) => {
          const lbl =
            info.index >= 0 ? (shown[info.index]?.label ?? null) : null;
          this.cb.onHoverEdge(
            lbl !== null && lbl >= 0 ? lbl : null,
            info.x,
            info.y,
          );
        },
        parameters: { depthCompare: "always", depthWriteEnabled: false },
      }),
      // 辉光:选中点脚下的柔和光晕(§9-8 打磨)
      new ScatterplotLayer({
        id: "ws-glow",
        data: { length: 1, attributes: { getPosition: { value: pos, size: 3 } } },
        getFillColor: [255, 255, 255, 40],
        radiusUnits: "common",
        getRadius: 7,
        radiusMinPixels: 12,
        radiusMaxPixels: 36,
        billboard: true,
        parameters: { depthCompare: "always", depthWriteEnabled: false },
      }),
      // X-ray 通道:深度失败 = 被挡,画低亮描边剪影(§4)
      new ScatterplotLayer({
        id: "ws-xray",
        data: {
          length: ranks.length,
          attributes: {
            getPosition: { value: pos, size: 3 },
            getLineColor: { value: col, size: 4 },
          },
        },
        radiusUnits: "common",
        getRadius: 2.2,
        radiusMinPixels: 3,
        radiusMaxPixels: 9,
        filled: false,
        stroked: true,
        getLineWidth: 1,
        lineWidthUnits: "pixels",
        opacity: 0.45,
        billboard: true,
        parameters: {
          depthCompare: "greater",
          depthWriteEnabled: false,
        },
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
        onHover: (info: { index: number; x: number; y: number }) => {
          const rk = info.index >= 0 ? ranks[info.index] : undefined;
          this.cb.onHover(rk ?? null, info.x, info.y);
        },
        onClick: (info: { index: number }) => {
          const rk = ranks[info.index];
          if (rk !== undefined) this.cb.onPick(rk);
          return true;
        },
      }),
    ];
    // 光环单脉冲:选中后 500ms 一次扩散(§5)
    if (!reduced && t < PULSE_MS) {
      const k = t / PULSE_MS;
      layers.push(
        new ScatterplotLayer({
          id: "ws-pulse",
          data: {
            length: 1,
            attributes: { getPosition: { value: pos, size: 3 } },
          },
          filled: false,
          stroked: true,
          getLineColor: [255, 255, 255, Math.round(180 * (1 - k))],
          getLineWidth: 1.5,
          lineWidthUnits: "pixels",
          radiusUnits: "common",
          getRadius: 2.2 + 6 * k,
          radiusMinPixels: 4 + 26 * k,
          radiusMaxPixels: 9 + 40 * k,
          billboard: true,
          parameters: { depthCompare: "always", depthWriteEnabled: false },
        }),
      );
    }
    return layers;
  }

  private buildContextData(): ContextData {
    if (this.builtVersion !== this.contextVersion || !this.contextData) {
      this.contextData = {
        length: this.geo.loaded,
        attributes: {
          getPosition: { value: this.geo.positions, size: 3 },
          getFillColor: { value: this.colors, size: 4 },
          getRadius: { value: this.geo.size, size: 1 },
          getFilterValue: { value: this.visible, size: 1 },
        },
      };
      this.builtVersion = this.contextVersion;
    }
    return this.contextData;
  }

  render(): void {
    const cameraPos = this.cameraPosition();
    const layers: unknown[] = [
      new ScatterplotLayer({
        id: "context",
        data: this.buildContextData() as never,
        radiusUnits: "common",
        radiusScale: 0.02,
        radiusMinPixels: 1.5,
        radiusMaxPixels: 6,
        billboard: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 120],
        extensions: [
          new DataFilterExtension({ filterSize: 1 }),
          new FogExtension(),
        ],
        filterRange: [0.5, 2],
        // 雾参数(仅语境层):起点 = 目标后方,衰减随世界尺度标定
        fogCamera: cameraPos,
        fogStart: this.cameraDistance() * 1.05,
        fogFalloff: 1.6 / Math.max(this.worldSize, 1),
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
      } as never),
    ];
    if (this.edgeCount > 0 && this.edgeData) {
      layers.push(
        new LineLayer({
          id: "context-edges",
          data: this.edgeData as never,
          getColor: [255, 255, 255, 16],
          opacity: this.edgeOpacity,
          getWidth: 1,
          widthUnits: "pixels",
        }),
      );
    }
    if (this.labels)
      layers.push(
        ...labelLayers(
          this.labels,
          this.geo,
          this.camera.viewState.zoom - this.camera.fitZoom,
          this.visible,
          this.labelVersion + this.contextVersion,
        ),
      );
    layers.push(...this.workingSetLayers());
    this.deck.setProps({ layers: layers as never[] });
  }

  /** OrbitView 相机世界坐标(雾用):目标点 + 距离沿视线反推。 */
  private cameraPosition(): [number, number, number] {
    const { target, rotationX, rotationOrbit } = this.camera.viewState;
    const d = this.cameraDistance();
    const rx = (rotationX * Math.PI) / 180;
    const ro = (rotationOrbit * Math.PI) / 180;
    return [
      target[0] + d * Math.cos(rx) * Math.sin(ro),
      target[1] + d * Math.sin(rx),
      target[2] + d * Math.cos(rx) * Math.cos(ro),
    ];
  }

  private cameraDistance(): number {
    // OrbitView 默认 fovy 50°:dist = (h/2) / tan(fov/2) / 2^zoom
    const h = Math.max(innerHeight, 1);
    return (
      h / 2 / Math.tan((50 / 2) * (Math.PI / 180)) /
      Math.pow(2, this.camera.viewState.zoom)
    );
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
}
