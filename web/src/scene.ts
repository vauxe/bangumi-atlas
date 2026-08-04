/** deck.gl 场景:语境层(点)、工作集聚光/X-ray、GPU 拾取。
 * 默认不显示任何边与名字;选中节点后由工作集显示相连关系边、
 * 节点名与关系名(方向 = 文案箭头 + 边亮度梯度,亮端为目标端)。
 *
 * 性能架构:节点的颜色/亮度/可见性全部在 shader 里由静态实例属性
 * (style、year)+ 少量 uniform 推导——年份滑块、媒介 chips、
 * 聚光都只改 uniform,零 CPU 循环、零属性重传
 * (实测 CPU 路径 985k 节点 recolor 循环 61ms/次 + ~21MB 重传,已移除)。
 * 可见性用 fs discard 表达，被滤除节点连拾取和高亮一起消失。
 * 几何流式期间属性写入 GPU Buffer 增量区间,不整块重传。 */

import { Deck, LayerExtension, OrbitView } from "@deck.gl/core";
import type {
  DeckProps,
  OrbitViewState,
  ViewStateChangeParameters,
} from "@deck.gl/core";
import { Buffer as LumaBuffer } from "@luma.gl/core";
import type { Device } from "@luma.gl/core";
import { IconLayer, LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { cursorRay, nearestAlongRay } from "./anchor";
import {
  AtlasOrbitController,
  Camera,
  FOCUS_ZOOM,
  prefersReducedMotion,
} from "./camera";
import type { OrbitState } from "./camera";
import { COVER_SIZES, coverItems, coverUrl } from "./covers";
import type { CoverItem } from "./covers";
import { workingLabelLayers } from "./labels";
import { state } from "./store";
import { TYPE_COLORS, etype } from "./types";
import type { Bounds3D, Geometry } from "./types";

export type { OrbitState } from "./camera";

export const EDGE_WIDTHS = {
  context: 0.5, // 语境骨架边已默认停用,保留宽度契约供将来开关
  relation: 1,
  path: 1.5,
} as const;
const CASCADE_STEP_MS = 30;
const CASCADE_FADE_MS = 200;
const PULSE_MS = 500;
const ANCHOR_FLASH_MS = 500;
// 持久节点使用世界尺寸：在标准聚焦层级保持原有屏幕观感，继续靠近时
// 则遵循 3D 投影自然放大。只保留远景最小像素尺寸，不设近景上限。
const FOCUS_SCALE = 2 ** FOCUS_ZOOM;
const WORKING_NODE_RADIUS = 9 / FOCUS_SCALE;
const WORKING_COVER_SIZE = 16.5 / FOCUS_SCALE;
const WORKING_GLOW_RADIUS = 36 / FOCUS_SCALE;

/** Crop dynamically packed cover textures to the circular node silhouette. */
class CircleCropExtension extends LayerExtension {
  static override extensionName = "CircleCropExtension";

  override getShaders(): Record<string, unknown> {
    return {
      inject: {
        "fs:DECKGL_FILTER_COLOR": `
  float cover_r = length(geometry.uv);
  if (cover_r > 1.0) discard;
  color.a *= smoothstep(1.0, 0.94, cover_r);`,
      },
    };
  }
}

// ---- 节点样式扩展:着色/过滤/雾一体,全在 GPU ----
// 实例属性:instanceStyle = [flags, etype, sizeLog, 0](u8×4)、
// instanceYear = year(u16);其余全是 uniform。
// 注意:luma 的 uniform block 解析按行取首个声明,必须一行一字段;
// 全用 float——int 成员的默认精度 vs(highp)/fs(mediump)不一致,
// 会在链接期报 precision mismatch,掩码值 ≤126 用 float 无损
const ATLAS_UNIFORM_BLOCK = `uniform atlasUniforms {
  float yearMin;
  float yearMax;
  float mediaMask;
  float scoreMin;
  float tagLo;
  float tagHi;
  float spotlight;
} atlas;`;

const atlasShaderModule = {
  name: "atlas",
  vs: ATLAS_UNIFORM_BLOCK,
  fs: ATLAS_UNIFORM_BLOCK,
  uniformTypes: {
    yearMin: "f32",
    yearMax: "f32",
    mediaMask: "f32",
    scoreMin: "f32",
    tagLo: "f32",
    tagHi: "f32",
    spotlight: "f32",
  },
} as const;

export interface AtlasUniforms {
  yearMin: number;
  yearMax: number;
  mediaMask: number;
  scoreMin: number;
  tagLo: number;
  tagHi: number;
  spotlight: number;
}

export class NodeStyleExtension extends LayerExtension {
  static override extensionName = "NodeStyleExtension";

  override getShaders(): Record<string, unknown> {
    return {
      modules: [atlasShaderModule],
      inject: {
        "vs:#decl": `
in vec4 instanceStyle;
in float instanceYear;
in vec2 instanceTags;
out vec4 atlas_style;
out float atlas_year;
out vec2 atlas_tags;`,
        "vs:#main-end": `
atlas_style = instanceStyle;
atlas_year = instanceYear;
atlas_tags = instanceTags;`,
        // deck 先钳制再做透视；这里在最终屏幕空间补上同一上下限。
        "vs:DECKGL_FILTER_SIZE": `
if (gl_Position.w > 0.0) {
  float radius = abs(size.x) -
    (scatterplot.antialiasing ? SMOOTH_EDGE_RADIUS : 0.0);
  float screenRadius = radius * project.focalDistance / gl_Position.w;
  size.xy *= clamp(screenRadius, scatterplot.radiusMinPixels,
    scatterplot.radiusMaxPixels) / screenRadius;
}`,
        "fs:#decl": `
in vec4 atlas_style;
in float atlas_year;
in vec2 atlas_tags;`,
        // 颜色、亮度和可见性统一在 shader 中推导；
        // discard 使被滤除节点同时移出拾取与 autoHighlight。
        "fs:DECKGL_FILTER_COLOR": `
{
  float f_flags = atlas_style.x;
  float f_etype = atlas_style.y;
  float f_year = atlas_year;
  bool a_iso = mod(floor(f_flags / 2.0), 2.0) >= 1.0;
  int a_media = int(floor(f_flags / 4.0));
  bool isSubject = f_etype < 1.5; // 档位比较,规避浮点等值
  bool yearOn = atlas.yearMin > 0.5 || atlas.yearMax < 9998.5;
  bool scoreOn = atlas.scoreMin > 0.5;
  bool tagsOn = atlas.tagLo > 0.5 || atlas.tagHi > 0.5;
  if (isSubject) {
    if (yearOn && (f_year < 0.5 ||
        f_year < atlas.yearMin || f_year > atlas.yearMax)) discard;
    // 评分过滤:无评分(0)在过滤激活时一并隐藏
    if (scoreOn && atlas_style.w < atlas.scoreMin) discard;
    if (tagsOn) { // AND 语义:须含全部所选标签(u32 拆两半 u16)
      int tlo = int(atlas_tags.x + 0.5);
      int thi = int(atlas_tags.y + 0.5);
      int slo = int(atlas.tagLo + 0.5);
      int shi = int(atlas.tagHi + 0.5);
      if ((tlo & slo) != slo || (thi & shi) != shi) discard;
    }
  }
  vec3 rgb = isSubject ? vec3(61.0, 142.0, 222.0)
           : f_etype < 2.5 ? vec3(229.0, 106.0, 64.0)
           : vec3(39.0, 171.0, 124.0);
  // 节点重要度已由半径表达，普通节点保持完整实体色，避免重复编码把
  // 中低热度节点系统性压暗。Alpha 只保留 SDF 圆边，不参与亮度。
  float visibility = a_iso ? 150.0 / 255.0 : 1.0;
  // 作品属性过滤激活时,人物/角色降暗但不隐藏。
  bool subjFilterOn = yearOn || scoreOn || tagsOn;
  if (subjFilterOn && !isSubject)
    visibility = min(visibility, 90.0 / 255.0);
  int mediaMask = int(atlas.mediaMask + 0.5);
  if (mediaMask != 0 && a_media > 0 &&
      (mediaMask & (1 << a_media)) == 0) visibility = 40.0 / 255.0;
  if (atlas.spotlight > 0.5)
    visibility = min(visibility, 80.0 / 255.0);
  vec3 stableRgb = mix(vec3(15.0, 26.0, 28.0), rgb, visibility);
  // 入参 color.a 只携带圆边平滑因子(SDF AA)，中心像素固定为不透明。
  color = vec4(stableRgb / 255.0, color.a);
}`,
      },
    };
  }

  override initializeState(this: unknown): void {
    const layer = this as {
      getAttributeManager(): {
        addInstanced(defs: Record<string, unknown>): void;
      } | null;
    };
    layer.getAttributeManager()?.addInstanced({
      instanceStyle: { size: 4, type: "uint8", accessor: "getStyle" },
      instanceYear: { size: 1, type: "uint16", accessor: "getYear" },
      // u32 标签位图按两半 u16 直灌(f32 顶点属性 >2^24 会丢位)
      instanceTags: { size: 2, type: "uint16", accessor: "getTags" },
    });
  }

  override updateState(params: unknown): void {
    const props = (params as { props: { atlas?: AtlasUniforms } }).props;
    if (!props.atlas) return;
    const models = (
      this as unknown as { getModels(): unknown[] }
    ).getModels();
    for (const model of models) {
      const m = model as {
        shaderInputs?: {
          setProps?: (p: Record<string, unknown>) => void;
        };
      };
      m.shaderInputs?.setProps?.({ atlas: props.atlas });
    }
  }
}

/** 大缓冲的 GPU 常驻镜像:流式期间只写增量区间,不整块重传。 */
class GrowingBuffer {
  private buf: LumaBuffer | null = null;
  private written = 0;

  constructor(
    private device: Device,
    private source: Uint8Array,
  ) {}

  /** 同步 CPU 源数组的 [written, upTo) 字节到 GPU。 */
  sync(upTo: number): void {
    this.buf ??= this.device.createBuffer({
      byteLength: this.source.byteLength,
      usage: LumaBuffer.VERTEX | LumaBuffer.COPY_DST,
    });
    if (upTo > this.written) {
      this.buf.write(
        this.source.subarray(this.written, upTo),
        this.written,
      );
      this.written = upTo;
    }
  }

  get handle(): LumaBuffer | null {
    return this.buf;
  }
}

interface ContextData {
  length: number;
  attributes: Record<string, unknown>;
}

export interface SceneCallbacks {
  onPick: (rank: number | null) => void;
  onHover: (rank: number | null, x: number, y: number) => void;
  /** 工作集边悬停:解码后的关系显示文本(语境骨架边不出 tooltip)。 */
  onHoverEdge: (label: string | null, x: number, y: number) => void;
  onViewChange: (vs: OrbitState) => void;
  /** 近场动态标签:同步读已载名字 / 批量补载缺失名字。 */
  nameOf?: (rank: number) => string | null;
  loadNames?: (ranks: number[]) => Promise<void>;
}

export class Scene {
  readonly camera: Camera;
  private deck: Deck<OrbitView>;
  private geo: Geometry;
  // 静态实例属性(随几何流一次性填充,之后永不重算)
  private styleBuf: Uint8Array; // [flags, etype, sizeLog, 0] × n
  private yearBuf: Uint16Array; // year × n
  private styled = 0; // 已填充的节点数

  // GPU 常驻缓冲(设备就绪后接管;之前 render 退回 CPU 数组直灌)
  private gpu: {
    positions: GrowingBuffer;
    radius: GrowingBuffer;
    style: GrowingBuffer;
    year: GrowingBuffer;
    tags: GrowingBuffer;
  } | null = null;

  private contextData: ContextData | null = null;
  private contextLength = -1;

  private wsAnimStart = 0;
  private wsRaf = 0;
  private lastSelection: number | null = null;
  private lastPickCycle: { x: number; y: number; depth: number } | null =
    null;
  private anchorCache: { x: number; y: number; rank: number; at: number } | null =
    null;
  private anchorFlash: {
    pos: [number, number, number];
    at: number;
  } | null = null;
  private anchorFlashRaf = 0;

  constructor(
    parent: HTMLDivElement,
    geo: Geometry,
    bounds: Bounds3D,
    private cb: SceneCallbacks,
  ) {
    this.geo = geo;
    this.camera = new Camera(bounds);
    const n = geo.key.length;
    this.styleBuf = new Uint8Array(n * 4);
    this.yearBuf = new Uint16Array(n);
    this.deck = new Deck({
      parent,
      views: this.camera.view(),
      useDevicePixels: Math.min(devicePixelRatio, 1.5),
      // 交互约定与 deck 默认相反：左键平移，右键轨道旋转。
      controller: {
        type: AtlasOrbitController,
        inertia: 300,
        scrollZoom: { speed: 0.01, smooth: false },
        doubleClickZoom: false,
        dragMode: "pan",
        // 巡航上限:滚轮把 zoom 提到此层级后,多余滚动量转为
        // 等速前进(见 AtlasOrbitController)——放大倍率有顶,
        // 前进没有顶。无上限的 zoom 会让交互步长 ∝ 每像素世界
        // 距离,画面如同冻结
        minZoom: -2,
        maxZoom: 10,
        // 自定义选项经 view 的 controllerProps 原样透传给控制器,
        // deck 的 ControllerOptions 类型未涵盖
        zoomAnchor: (px: number, py: number) => this.rayAnchor(px, py),
        // 飞行目标反馈:手势锁定锚点时在其上闪一个淡出环
        onWheelAnchor: (pos: [number, number, number] | null) =>
          this.flashAnchor(pos),
      } as DeckProps["controller"],
      initialViewState: this.camera.viewState,
      pickingRadius: 5,
      onResize: ({ height }) => {
        this.camera.resize(height);
        this.deck.setProps({ views: this.camera.view() });
      },
      onDeviceInitialized: (device: Device) => {
        this.gpu = {
          positions: new GrowingBuffer(
            device,
            new Uint8Array(this.geo.positions.buffer),
          ),
          radius: new GrowingBuffer(device, this.geo.size),
          style: new GrowingBuffer(device, this.styleBuf),
          year: new GrowingBuffer(
            device,
            new Uint8Array(this.yearBuf.buffer),
          ),
          tags: new GrowingBuffer(
            device,
            new Uint8Array(this.geo.tags.buffer),
          ),
        };
        this.contextLength = -1; // 重建 contextData,切换到 GPU 缓冲
        this.syncGpu();
        this.render();
      },
      onViewStateChange: (change) => this.handleViewStateChange(change),
      onClick: (info: { layer: unknown }) => {
        if (!info.layer) {
          this.lastPickCycle = null; // 循环拾取状态随空白点击复位
          this.cb.onPick(null); // 单击空白 = 取消选中
        }
      },
      getCursor: ({ isHovering }) => (isHovering ? "pointer" : "grab"),
      layers: [],
    });
    const canvas = parent.querySelector("canvas");
    canvas?.setAttribute("role", "application");
    canvas?.setAttribute("aria-label", "Bangumi 关系星图");
    // 右键负责轨道旋转；拦掉浏览器菜单，避免松手时打断操作。
    parent.addEventListener("contextmenu", (ev) => ev.preventDefault());
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
    this.render();
  }

  /** Deck 在回调返回后才提交内部 viewState；递归 setProps 会中断过渡。 */
  private handleViewStateChange<ViewStateT extends OrbitViewState>({
    viewState,
    interactionState,
  }: ViewStateChangeParameters<ViewStateT>): ViewStateT {
    const refreshView =
      viewState.zoom !== this.camera.viewState.zoom ||
      interactionState.isDragging === false;
    this.camera.absorb(viewState as Record<string, unknown>);
    this.cb.onViewChange(this.camera.viewState);
    queueMicrotask(() => {
      if (refreshView) this.deck.setProps({ views: this.camera.view() });
      this.render();
    });
    return { ...viewState, ...this.camera.viewState } as ViewStateT;
  }

  private labelNamesPending = false;

  /** 工作集名字补载:同一时刻只跑一批;完成后重绘。 */
  private requestLabelNames(ranks: number[]): void {
    const load = this.cb.loadNames;
    if (!load || this.labelNamesPending) return;
    this.labelNamesPending = true;
    load(ranks)
      .then(() => this.render())
      .catch(() => undefined)
      .finally(() => {
        this.labelNamesPending = false;
      });
  }

  /** 飞行目标反馈:滚轮手势锁定新锚点时,在锚点上闪一个淡出环,
   * 让"正朝这里飞"可见;真空手势(无锚)清除反馈。 */
  private flashAnchor(pos: [number, number, number] | null): void {
    if (!pos || prefersReducedMotion()) {
      this.anchorFlash = null;
      return;
    }
    this.anchorFlash = { pos, at: performance.now() };
    cancelAnimationFrame(this.anchorFlashRaf);
    const tick = (): void => {
      this.render();
      if (
        this.anchorFlash &&
        performance.now() - this.anchorFlash.at < ANCHOR_FLASH_MS
      )
        this.anchorFlashRaf = requestAnimationFrame(tick);
    };
    this.anchorFlashRaf = requestAnimationFrame(tick);
  }

  /** 滚轮放大的视线锚点：光标射线附近（60px 视锥角内）最近的可见
   * 节点。手势期间按光标位置缓存（含脱靶结果），高频 wheel 事件
   * 不重复全量扫描；俯视正交下角度度量退化，交给原地缩放。 */
  private rayAnchor(px: number, py: number): [number, number, number] | null {
    const now = performance.now();
    const c = this.anchorCache;
    if (
      c &&
      Math.abs(px - c.x) <= 8 &&
      Math.abs(py - c.y) <= 8 &&
      now - c.at < 400
    ) {
      c.at = now;
      return c.rank >= 0 ? this.posOf(c.rank) : null;
    }
    if (this.camera.ortho || !this.geo.loaded) return null;
    const viewport = this.deck.getViewports()[0];
    if (!viewport) return null;
    const ray = cursorRay(viewport, px, py);
    if (!ray) return null;
    // OrbitViewport 的 focalDistance 以视口高度为单位（0.5/tan(fovy/2))
    const focalPx =
      ((viewport as { focalDistance?: number }).focalDistance ?? 1) *
      viewport.height;
    const rank = nearestAlongRay(
      this.geo.positions,
      this.geo.loaded,
      ray.origin,
      ray.dir,
      60 / Math.max(focalPx, 1),
      (r) => this.isVisible(r),
    );
    this.anchorCache = { x: px, y: py, rank, at: now };
    return rank >= 0 ? this.posOf(rank) : null;
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

  /** 可见性(与 shader 判定逐条对齐):纯函数,无缓存数组。 */
  isVisible(rank: number): boolean {
    const f = state.filters;
    if (etype(this.geo.key[rank] ?? 0) !== 1) return true;
    const yearOn = f.yearMin > 0 || f.yearMax < 9999;
    if (yearOn) {
      const y = this.geo.year[rank] ?? 0;
      if (y === 0 || y < f.yearMin || y > f.yearMax) return false;
    }
    if (f.scoreMin > 0 && (this.geo.score[rank] ?? 0) < f.scoreMin)
      return false;
    if (f.tags.size) {
      let sel = 0;
      for (const b of f.tags) sel = (sel | (1 << b)) >>> 0;
      if (((this.geo.tags[rank] ?? 0) & sel) >>> 0 !== sel) return false;
    }
    return true;
  }

  /** 过滤/聚光/图层变化:现在只是 uniform 更新。 */
  recolor(): void {
    if (state.selection !== this.lastSelection) {
      this.lastSelection = state.selection;
      this.startWorkingSetAnim();
    }
    this.render();
  }

  geometryGrew(): void {
    // 增量填充静态样式属性(每节点一生只算一次)
    const { geo, styleBuf, yearBuf } = this;
    for (let i = this.styled; i < geo.loaded; i++) {
      styleBuf[i * 4] = geo.flags[i] ?? 0;
      styleBuf[i * 4 + 1] = etype(geo.key[i] ?? 0);
      styleBuf[i * 4 + 2] = geo.size[i] ?? 0;
      styleBuf[i * 4 + 3] = geo.score[i] ?? 0; // 评分×10,属性过滤用
      yearBuf[i] = geo.year[i] ?? 0;
    }
    this.styled = geo.loaded;
    this.syncGpu();
    this.render();
  }

  private syncGpu(): void {
    if (!this.gpu) return;
    const m = this.styled;
    this.gpu.positions.sync(m * 12);
    this.gpu.radius.sync(m);
    this.gpu.style.sync(m * 4);
    this.gpu.year.sync(m * 2);
    this.gpu.tags.sync(m * 4);
  }

  flyTo(rank: number, zoom?: number): void {
    const pos = this.posOf(rank);
    if (!pos) return;
    const next = this.camera.flyTo(pos, zoom);
    this.deck.setProps({
      views: this.camera.view(),
      initialViewState: next,
    });
    this.cb.onViewChange(this.camera.viewState);
    this.render();
  }

  setView(vs: Partial<OrbitState>): void {
    this.camera.absorb({ ...this.camera.viewState, ...vs });
    this.applyCamera(true);
  }

  /** 正交开关(URL 还原用;`T` 键走 topView)。 */
  setOrtho(v: boolean): void {
    if (this.camera.ortho === v) return;
    this.camera.ortho = v;
    this.applyCamera(true);
  }

  topView(): void {
    this.camera.toggleTop();
    this.applyCamera(true);
  }

  home(): void {
    this.camera.home();
    this.applyCamera(true);
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
    this.render();
  }

  // ---- 工作集动效：级联淡入 + 光环单脉冲 ----
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
    // 未流式覆盖且无 sparse 坐标的邻居先不画(位置未知,不能画到原点)
    const shown: {
      rank: number;
      label: string;
      pos: [number, number, number];
    }[] = [];
    state.neighbors.forEach((rk, i) => {
      const p = this.posOf(rk);
      if (p)
        shown.push({
          rank: rk,
          label: state.neighborLabels[i] ?? "",
          pos: p,
        });
    });
    const ranks = [sel, ...shown.map((s) => s.rank)];
    const pos = new Float32Array(ranks.length * 3);
    const col = new Uint8Array(ranks.length * 4);
    pos.set(selPos, 0);
    col.set([255, 255, 255, 255], 0);
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
    });
    // 三种连线形态:路径链(抑制扇形)/ 默认扇形 / 对比第二扇形
    const chain = state.path.length >= 2 ? state.path : null;
    const edgeSegs: {
      a: [number, number, number];
      b: [number, number, number];
      label: string;
      alpha: number;
    }[] = [];
    if (chain) {
      for (let i = 0; i + 1 < chain.length; i++) {
        const pa = this.posOf(chain[i] ?? 0);
        const pb = this.posOf(chain[i + 1] ?? 0);
        if (pa && pb)
          edgeSegs.push({
            a: pa,
            b: pb,
            label: state.pathLabels[i] ?? "",
            alpha: 200,
          });
      }
    } else {
      shown.forEach((s, i) => {
        const k = reduced
          ? 1
          : Math.max(
              0,
              Math.min(1, (t - i * CASCADE_STEP_MS) / CASCADE_FADE_MS),
            );
        edgeSegs.push({
          a: selPos,
          b: s.pos,
          label: s.label,
          alpha: Math.round(160 * k),
        });
      });
      // 共同关联:从对比端再画一扇(标签属 A 侧,tooltip 不重复报)
      const cw = state.compareWith;
      const cwPos = cw !== null ? this.posOf(cw) : null;
      if (cwPos) {
        for (const s of shown)
          if (s.rank !== cw)
            edgeSegs.push({ a: cwPos, b: s.pos, label: "", alpha: 70 });
      }
    }
    // 方向梯度:每条边拆成两个半段,亮端 = 关系的目标端。
    // "← " 前缀表示选中侧是目标(指向选中节点);无标签的
    // 对比扇没有方向语义,两端等亮。
    const linePos = new Float32Array(edgeSegs.length * 12);
    const lineAlpha = new Uint8Array(edgeSegs.length * 8);
    edgeSegs.forEach((sg, i) => {
      const mid: [number, number, number] = [
        (sg.a[0] + sg.b[0]) / 2,
        (sg.a[1] + sg.b[1]) / 2,
        (sg.a[2] + sg.b[2]) / 2,
      ];
      const hasDirection = sg.label !== "";
      const towardSelf = sg.label.startsWith("← ");
      const aBright = !hasDirection || towardSelf;
      const bBright = !hasDirection || !towardSelf;
      const o = i * 12;
      linePos.set(sg.a, o);
      linePos.set(mid, o + 3);
      linePos.set(mid, o + 6);
      linePos.set(sg.b, o + 9);
      const dim = Math.round(sg.alpha * 0.2);
      lineAlpha.set([255, 255, 255, aBright ? sg.alpha : dim], i * 8);
      lineAlpha.set([255, 255, 255, bBright ? sg.alpha : dim], i * 8 + 4);
    });
    const layers: unknown[] = [
      new LineLayer({
        id: "ws-edges",
        data: {
          length: edgeSegs.length * 2,
          attributes: {
            getSourcePosition: { value: linePos, size: 3, stride: 24 },
            getTargetPosition: {
              value: linePos,
              size: 3,
              stride: 24,
              offset: 12,
            },
            getColor: { value: lineAlpha, size: 4, normalized: true },
          },
        },
        getWidth: chain ? EDGE_WIDTHS.path : EDGE_WIDTHS.relation,
        widthUnits: "pixels",
        pickable: true, // 悬停工作集边时显示解码后的关系名
        onHover: (info: { index: number; x: number; y: number }) => {
          const seg =
            info.index >= 0 ? edgeSegs[info.index >> 1] : undefined;
          this.cb.onHoverEdge(seg?.label || null, info.x, info.y);
        },
        parameters: { depthCompare: "always", depthWriteEnabled: false },
      }),
      // 选中节点脚下使用柔和粉色辉光，与类别色分离。
      new ScatterplotLayer({
        id: "ws-glow",
        data: { length: 1, attributes: { getPosition: { value: pos, size: 3 } } },
        getFillColor: [242, 91, 166, 60], // Miku 品红光晕
        radiusUnits: "common",
        getRadius: WORKING_GLOW_RADIUS,
        radiusMinPixels: 12,
        billboard: true,
        parameters: { depthCompare: "always", depthWriteEnabled: false },
      }),
      // X-ray 通道：深度失败表示被遮挡，此时绘制低亮描边剪影。
      new ScatterplotLayer({
        id: "ws-xray",
        data: {
          length: ranks.length,
          attributes: {
            getPosition: { value: pos, size: 3 },
            getLineColor: { value: col, size: 4, normalized: true },
          },
        },
        radiusUnits: "common",
        getRadius: WORKING_NODE_RADIUS,
        radiusMinPixels: 3,
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
            getFillColor: { value: col, size: 4, normalized: true },
          },
        },
        radiusUnits: "common",
        getRadius: WORKING_NODE_RADIUS,
        radiusMinPixels: 3,
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
    const covers = coverItems(ranks, this.geo.key);
    if (covers.length) {
      // IconLayer auto-packing and onIconError are documented for deck.gl 9.x:
      // https://deck.gl/docs/api-reference/layers/icon-layer#oniconerror-function
      // A failed optional image is handled here; ws-lit remains the fallback.
      layers.push(
        new IconLayer<CoverItem>({
          id: "ws-covers",
          data: covers,
          getIcon: (d) => ({
            url: coverUrl(d.key, COVER_SIZES.map) ?? "",
            id: String(d.key),
            width: 100,
            height: 100,
          }),
          getPosition: (d) => this.posOf(d.rank) ?? [0, 0, 0],
          getSize: WORKING_COVER_SIZE,
          getColor: (d) => {
            const k =
              reduced || d.index === 0
                ? 1
                : Math.max(
                    0,
                    Math.min(
                      1,
                      (t - (d.index - 1) * CASCADE_STEP_MS) /
                        CASCADE_FADE_MS,
                    ),
                  );
            return [255, 255, 255, Math.round(255 * k)];
          },
          updateTriggers: { getColor: t },
          sizeUnits: "common",
          sizeMinPixels: 5.5,
          billboard: true,
          extensions: [new CircleCropExtension()],
          onIconError: () => undefined,
        }),
      );
    }
    // 名字最后绘制,浮于光晕/封面之上;任何距离都显示(像素字号)。
    // 缺失的名字批量补载后重绘。
    const { nameOf } = this.cb;
    if (nameOf) {
      const viewport = this.deck.getViewports()[0];
      const { layers: nameLayers, missing } = workingLabelLayers(
        [
          { rank: sel, pos: selPos },
          ...shown.map((s) => ({ rank: s.rank, pos: s.pos })),
        ],
        edgeSegs,
        nameOf,
        (p) => {
          if (!viewport) return null;
          const s = viewport.project(p) as number[];
          return [s[0] ?? 0, s[1] ?? 0];
        },
        this.camera.viewState.zoom,
      );
      if (missing.length) this.requestLabelNames(missing);
      layers.push(...nameLayers);
    }
    // 选中后只播放一次 500ms 扩散，避免持续动画干扰浏览。
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
          getLineColor: [242, 91, 166, Math.round(200 * (1 - k))],
          getLineWidth: 1.5,
          lineWidthUnits: "pixels",
          // 脉冲是屏幕反馈，不是节点几何；用像素单位避免相机缩放
          // 改变一次性动效的起止尺寸。
          radiusUnits: "pixels",
          getRadius: 9 + 40 * k,
          billboard: true,
          parameters: { depthCompare: "always", depthWriteEnabled: false },
        }),
      );
    }
    return layers;
  }

  /** 语境层数据:属性引用恒定(GPU Buffer 或 CPU 数组),
   * 对象只在填充进度变化时更换 → deck 不做无谓重传。
   * 长度用 styled 而非 geo.loaded:loaded 在流回调里实时推进,
   * 而样式属性/GPU 同步以 250ms 节流跟进,超前的区间会以
   * 原点零样式"幻影点"闪现。 */
  private buildContextData(): ContextData {
    if (this.contextLength !== this.styled || !this.contextData) {
      const g = this.gpu;
      this.contextData = {
        length: this.styled,
        attributes:
          g?.positions.handle && g.radius.handle && g.style.handle &&
          g.year.handle
            ? {
                // 外部 buffer 必须显式 stride:deck 只在 {value}
                // 分支按数组重算布局,{buffer} 分支沿用属性默认类型
                // (instancePositions 默认 float64 → 步距 24 会错读)
                getPosition: {
                  buffer: g.positions.handle,
                  size: 3,
                  type: "float32",
                  stride: 12,
                },
                getRadius: {
                  buffer: g.radius.handle,
                  size: 1,
                  type: "uint8",
                  stride: 1,
                },
                getStyle: {
                  buffer: g.style.handle,
                  size: 4,
                  type: "uint8",
                  stride: 4,
                },
                getYear: {
                  buffer: g.year.handle,
                  size: 1,
                  type: "uint16",
                  stride: 2,
                },
                getTags: {
                  buffer: g.tags.handle,
                  size: 2,
                  type: "uint16",
                  stride: 4,
                },
              }
            : {
                getPosition: { value: this.geo.positions, size: 3 },
                getRadius: {
                  value: this.geo.size,
                  size: 1,
                  type: "uint8",
                },
                getStyle: {
                  value: this.styleBuf,
                  size: 4,
                  type: "uint8",
                },
                getYear: {
                  value: this.yearBuf,
                  size: 1,
                  type: "uint16",
                },
                getTags: {
                  value: new Uint16Array(this.geo.tags.buffer),
                  size: 2,
                  type: "uint16",
                },
              },
      };
      this.contextLength = this.styled;
    }
    return this.contextData;
  }

  private atlasUniforms(): AtlasUniforms {
    const f = state.filters;
    let mask = 0;
    for (const m of f.media) mask |= 1 << m;
    let sel = 0;
    for (const b of f.tags) sel |= 1 << b;
    return {
      yearMin: f.yearMin,
      yearMax: f.yearMax,
      mediaMask: mask,
      scoreMin: f.scoreMin,
      tagLo: sel & 0xffff,
      tagHi: sel >>> 16,
      spotlight: state.selection !== null ? 1 : 0,
    };
  }

  render(): void {
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
        highlightColor: [242, 91, 166, 150], // 悬停高亮 = 发饰粉
        getFillColor: [255, 255, 255, 255], // 实际颜色由 atlas 扩展推导
        extensions: [new NodeStyleExtension()],
        atlas: this.atlasUniforms(),
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
    layers.push(...this.workingSetLayers());
    const flash = this.anchorFlash;
    if (flash) {
      const k = (performance.now() - flash.at) / ANCHOR_FLASH_MS;
      if (k < 1) {
        layers.push(
          new ScatterplotLayer({
            id: "anchor-flash",
            data: [flash],
            getPosition: (d: { pos: [number, number, number] }) => d.pos,
            filled: false,
            stroked: true,
            getLineColor: [170, 214, 255, Math.round(200 * (1 - k))],
            getLineWidth: 1.5,
            lineWidthUnits: "pixels",
            radiusUnits: "pixels",
            getRadius: 10 + 14 * k,
            billboard: true,
            parameters: { depthCompare: "always", depthWriteEnabled: false },
          }),
        );
      } else {
        this.anchorFlash = null;
      }
    }
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
}
