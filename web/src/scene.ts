/** deck.gl 场景:语境层(点)、工作集聚光/X-ray、GPU 拾取。
 * 默认不显示任何边与名字;选中节点后由工作集显示相连关系边、
 * 节点名与关系名(方向 = 文案箭头 + 边亮度梯度,亮端为目标端)。
 *
 * 性能架构:节点颜色与聚光在 shader 里由静态 style、查询结果掩码和
 * 一个 uniform 推导。查询提交时只更新一字节/节点的成员掩码，不重算
 * 全图样式；几何与静态样式不重传。
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
import {
  NEARBY_LABEL_ZOOM,
  nearbyLabelLayers as makeNearbyLabelLayers,
  nearbyLabelRanks,
  visibleLabelPoint,
  workingLabelLayers,
} from "./labels";
import { state } from "./store";
import { TYPE_COLORS, etype } from "./types";
import type { Bounds3D, Geometry } from "./types";

export type { OrbitState } from "./camera";

export function interactionHint(selected: boolean, pinnedCount = 0): string {
  const base =
    "拖动平移 · 右键拖动旋转 · 滚轮缩放 · 单击查看 · S 搜索 · T 俯视 · R 复位";
  const status: string[] = [];
  if (selected) {
    if (pinnedCount === 0) status.push("图钉逐步保留节点和边");
    status.push("Esc 关闭当前查看");
  }
  if (pinnedCount > 0)
    status.push(`已保留 ${pinnedCount} 个节点及其关系`);
  return status.length ? `${base} · ${status.join(" · ")}` : base;
}

function hasWorkingSet(): boolean {
  return state.selection !== null || state.pinnedSelections.size > 0;
}

const EDGE_WIDTH = 1;
const WORKING_DECORATION_LIMIT = 50;
const CASCADE_STEP_MS = 30;
const CASCADE_FADE_MS = 200;
const CASCADE_STEPS = 50;
const PULSE_MS = 500;
const ANCHOR_FLASH_MS = 500;
const NEARBY_LABEL_SETTLE_MS = 140;
// 持久节点使用世界尺寸：在标准聚焦层级保持原有屏幕观感，继续靠近时
// 则遵循 3D 投影自然放大。只保留远景最小像素尺寸，不设近景上限。
const FOCUS_SCALE = 2 ** FOCUS_ZOOM;
const WORKING_NODE_RADIUS = 9 / FOCUS_SCALE;
const WORKING_COVER_SIZE = 16.5 / FOCUS_SCALE;
const WORKING_GLOW_RADIUS = 36 / FOCUS_SCALE;

function cascadeProgress(
  elapsed: number,
  index: number,
  reduced: boolean,
): number {
  if (reduced) return 1;
  const step = Math.min(index, CASCADE_STEPS - 1);
  return Math.max(
    0,
    Math.min(1, (elapsed - step * CASCADE_STEP_MS) / CASCADE_FADE_MS),
  );
}

const circleCropShaderModule = {
  name: "circleCrop",
  vs: "vec2 circle_crop_frame_size;",
} as const;

export class CircleCropExtension extends LayerExtension {
  static override extensionName = "CircleCropExtension";

  override getShaders(): Record<string, unknown> {
    return {
      modules: [circleCropShaderModule],
      inject: {
        "vs:#main-start": `
  circle_crop_frame_size = instanceIconFrames.zw;`,
        "vs:DECKGL_FILTER_SIZE": `
  vec2 coverFrameSize = max(circle_crop_frame_size, vec2(1.0));
  float coverConstraint = icon.sizeBasis == 0.0 ? coverFrameSize.x : coverFrameSize.y;
  size.xy *= coverConstraint / coverFrameSize;`,
        "vs:#main-end": `
  vec2 coverFrameSize = max(instanceIconFrames.zw, vec2(1.0));
  float coverSide = min(coverFrameSize.x, coverFrameSize.y);
  vec2 coverOrigin =
    instanceIconFrames.xy + (coverFrameSize - vec2(coverSide)) * 0.5;
  vTextureCoords = mix(
    coverOrigin,
    coverOrigin + vec2(coverSide),
    (geometry.uv + 1.0) / 2.0
  ) / icon.iconsTextureDim;`,
        "fs:DECKGL_FILTER_COLOR": `
  float cover_r = length(geometry.uv);
  if (cover_r > 1.0) discard;
  color.a *= smoothstep(1.0, 0.94, cover_r);`,
      },
    };
  }
}

// ---- 节点样式扩展:着色与聚光都在 GPU ----
// 静态实例属性 instanceStyle = [flags, etype, sizeLog, 0](u8×4)；
// 动态 instanceQueryResult 是查询结果成员掩码，其余全是 uniform。
// 注意:luma 的 uniform block 解析按行取首个声明,必须一行一字段;
// 全用 float——int 成员的默认精度 vs(highp)/fs(mediump)不一致,
// 会在链接期报 precision mismatch；u8 离散值以 float 表达无损
const ATLAS_UNIFORM_BLOCK = `uniform atlasUniforms {
  float spotlight;
} atlas;`;

const atlasShaderModule = {
  name: "atlas",
  vs: ATLAS_UNIFORM_BLOCK,
  fs: ATLAS_UNIFORM_BLOCK,
  uniformTypes: {
    spotlight: "f32",
  },
} as const;

export interface AtlasUniforms {
  spotlight: number;
}

export function updateQueryResultMask(
  mask: Uint8Array,
  previous: Uint32Array,
  next: Uint32Array,
): void {
  for (const rank of previous)
    if (rank < mask.length) mask[rank] = 0;
  for (const rank of next)
    if (rank < mask.length) mask[rank] = 255;
}

/** 查询高亮 rank 由 Worker 合并为严格升序；首项即可判定是否进入
 * 当前已完成样式同步的前缀，避免每帧重扫大结果集。 */
export function hasVisibleSortedRank(
  ranks: Uint32Array,
  upperBound: number,
): boolean {
  return ranks.length > 0 && (ranks[0] ?? upperBound) < upperBound;
}

export class NodeStyleExtension extends LayerExtension {
  static override extensionName = "NodeStyleExtension";

  override getShaders(): Record<string, unknown> {
    return {
      modules: [atlasShaderModule],
      inject: {
        "vs:#decl": `
in vec4 instanceStyle;
in float instanceQueryResult;
// 节点元数据是离散值；flat 防止 billboard 内插值篡改 flags 等字段。
flat out vec4 atlas_style;
flat out float atlas_query_result;`,
        "vs:#main-end": `
atlas_style = instanceStyle;
atlas_query_result = instanceQueryResult;`,
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
flat in vec4 atlas_style;
flat in float atlas_query_result;`,
        // 颜色与亮度统一在 shader 中推导。
        "fs:DECKGL_FILTER_COLOR": `
{
  float f_flags = atlas_style.x;
  float f_etype = atlas_style.y;
  bool a_iso = mod(floor(f_flags / 2.0), 2.0) >= 1.0;
  bool isSubject = f_etype < 1.5; // 档位比较,规避浮点等值
  vec3 rgb = isSubject ? vec3(61.0, 142.0, 222.0)
           : f_etype < 2.5 ? vec3(229.0, 106.0, 64.0)
           : vec3(39.0, 171.0, 124.0);
  // 节点重要度已由半径表达，普通节点保持完整实体色，避免重复编码把
  // 中低热度节点系统性压暗。Alpha 只保留 SDF 圆边，不参与亮度。
  float visibility = a_iso ? 150.0 / 255.0 : 1.0;
  if (atlas.spotlight > 0.5 && atlas_query_result < 0.5)
    visibility = min(visibility, 64.0 / 255.0);
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
      instanceQueryResult: {
        size: 1,
        type: "unorm8",
        accessor: "getQueryResult",
      },
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

/** CPU 数组的 GPU 常驻镜像：流式数据增量写，动态掩码按需刷新。 */
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

  /** 源数组已有区间发生原地变化时刷新该前缀。 */
  refresh(upTo: number): void {
    this.sync(0);
    if (upTo > 0) this.buf?.write(this.source.subarray(0, upTo), 0);
    this.written = Math.max(this.written, upTo);
  }

  get handle(): LumaBuffer | null {
    return this.buf;
  }
}

interface ContextData {
  length: number;
  attributes: Record<string, unknown>;
}

type WorkingPosition = [number, number, number];

interface WorkingShown {
  rank: number;
  label: string;
  pos: WorkingPosition;
}

interface WorkingEdge {
  a: WorkingPosition;
  b: WorkingPosition;
  label: string;
  alpha: number;
  retained: boolean;
}

interface WorkingNode {
  pos: WorkingPosition;
  active: boolean;
  pinned: boolean;
  retained: boolean;
  neighborIndex: number | null;
}

interface WorkingSetCore {
  selectedRank: number | null;
  selectedPos: WorkingPosition | null;
  pinned: { rank: number; pos: WorkingPosition }[];
  shown: WorkingShown[];
  edgeSegs: WorkingEdge[];
  nodes: Map<number, WorkingNode>;
  layers: unknown[];
}

interface WorkingGeometryLayers {
  edgeLayer: unknown | null;
  nodeLayers: unknown[];
}

interface RetainedWorkingSetCore {
  edgeSegs: WorkingEdge[];
  nodes: Map<number, WorkingNode>;
  geometry: WorkingGeometryLayers;
}

interface WorkingSetCoreCache {
  selection: number | null;
  neighbors: readonly number[];
  neighborLabels: readonly string[];
  pinnedSelections: object;
  pinnedWorkingSets: object;
  geometryLoaded: number;
  sparseCount: number;
  reduced: boolean;
  core: WorkingSetCore;
}

interface RetainedWorkingSetCoreCache {
  selection: number | null;
  neighbors: readonly number[];
  pinnedSelections: object;
  pinnedWorkingSets: object;
  geometryLoaded: number;
  sparseCount: number;
  core: RetainedWorkingSetCore;
}

export interface SceneCallbacks {
  onPick: (rank: number | null) => void;
  onHover: (rank: number | null, x: number, y: number) => void;
  /** 工作集边悬停时提供解码后的关系显示文本。 */
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
  private queryResultMask: Uint8Array;
  private queryResultMaskSource: Uint32Array = new Uint32Array();
  private styled = 0; // 已填充的节点数

  // GPU 常驻缓冲(设备就绪后接管;之前 render 退回 CPU 数组直灌)
  private gpu: {
    positions: GrowingBuffer;
    radius: GrowingBuffer;
    style: GrowingBuffer;
    queryResult: GrowingBuffer;
  } | null = null;

  private contextData: ContextData | null = null;
  private contextLength = -1;

  private wsAnimStart = 0;
  private wsRaf = 0;
  private lastSelection: number | null = null;
  private lastWorkingNeighbors: readonly number[] = state.neighbors;
  private workingSetCoreCache: WorkingSetCoreCache | null = null;
  private retainedWorkingSetCoreCache: RetainedWorkingSetCoreCache | null = null;
  private lastPickCycle: { x: number; y: number; depth: number } | null =
    null;
  private anchorCache: { x: number; y: number; rank: number; at: number } | null =
    null;
  private anchorFlash: {
    pos: [number, number, number];
    at: number;
  } | null = null;
  private anchorFlashRaf = 0;
  private nearbyRanks: number[] = [];
  private nearbyTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.queryResultMask = new Uint8Array(n);
    this.deck = new Deck({
      parent,
      views: this.camera.view(),
      useDevicePixels: Math.min(devicePixelRatio, 1.5),
      // 交互约定与 deck 默认相反：左键平移，右键轨道旋转。
      controller: {
        type: AtlasOrbitController,
        inertia: 300,
        scrollZoom: { speed: 0.01, smooth: false },
        // 节点交互统一为单击；不保留控制器自己的双击缩放手势。
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
        onWheelAnchor: (pos: [number, number, number] | null) =>
          this.flashAnchor(pos),
      } as DeckProps["controller"],
      initialViewState: this.camera.viewState,
      pickingRadius: 5,
      onResize: ({ height }) => {
        this.camera.resize(height);
        this.deck.setProps({ views: this.camera.view() });
        this.scheduleNearbyLabels();
      },
      onDeviceInitialized: (device: Device) => {
        this.gpu = {
          positions: new GrowingBuffer(
            device,
            new Uint8Array(this.geo.positions.buffer),
          ),
          radius: new GrowingBuffer(device, this.geo.size),
          style: new GrowingBuffer(device, this.styleBuf),
          queryResult: new GrowingBuffer(device, this.queryResultMask),
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
    this.scheduleNearbyLabels();
    queueMicrotask(() => {
      if (refreshView) this.deck.setProps({ views: this.camera.view() });
      this.render();
    });
    return { ...viewState, ...this.camera.viewState } as ViewStateT;
  }

  private labelNamesPending = false;
  /** 名字块只串行读取；相机移动期间只保留最后一次缺失集合。 */
  private queuedLabelRanks: number[] | null = null;

  private requestLabelNames(ranks: number[]): void {
    const load = this.cb.loadNames;
    if (!load || !ranks.length) return;
    if (this.labelNamesPending) {
      this.queuedLabelRanks = [...ranks];
      return;
    }
    this.labelNamesPending = true;
    load(ranks).then(
      () => this.finishLabelNameRequest(true),
      () => this.finishLabelNameRequest(false),
    ).catch(() => undefined);
  }

  private finishLabelNameRequest(loaded: boolean): void {
    this.labelNamesPending = false;
    const queued = this.queuedLabelRanks;
    this.queuedLabelRanks = null;
    if (queued?.length) this.requestLabelNames(queued);
    else if (loaded) this.render();
  }

  /** 相机连续运动时只重置一个定时器；稳定后才扫描坐标，避免把
   * 99 万节点的近邻选择放进逐帧渲染。 */
  private scheduleNearbyLabels(): void {
    if (this.nearbyTimer !== null) clearTimeout(this.nearbyTimer);
    this.nearbyTimer = null;
    if (
      hasWorkingSet() ||
      !this.cb.nameOf ||
      this.camera.viewState.zoom < NEARBY_LABEL_ZOOM
    ) {
      this.nearbyRanks = [];
      return;
    }
    this.nearbyTimer = setTimeout(() => {
      this.nearbyTimer = null;
      this.refreshNearbyLabels();
    }, NEARBY_LABEL_SETTLE_MS);
  }

  private refreshNearbyLabels(): void {
    const viewport = this.deck.getViewports()[0];
    const project = (position: [number, number, number]): [number, number] => {
      const projected = viewport?.project(position) as number[] | undefined;
      return [projected?.[0] ?? NaN, projected?.[1] ?? NaN];
    };
    const next =
      !hasWorkingSet() && viewport
        ? nearbyLabelRanks(
            this.geo.positions,
            this.geo.loaded,
            this.camera.viewState.target,
            this.camera.viewState.zoom,
            viewport.width,
            viewport.height,
            {
              visible: (position) =>
                visibleLabelPoint(position, project, viewport) !== null,
            },
          )
        : [];
    // 排名相同不代表布局相同：像素偏移、可见性与碰撞选择都依赖
    // 当前视口投影。稳定扫描也承担 resize 后的布局失效通知。
    this.nearbyRanks = next;
    this.render();
  }

  private nearbyLabelLayers(): unknown[] {
    const { nameOf } = this.cb;
    if (hasWorkingSet() || !nameOf || !this.nearbyRanks.length)
      return [];
    const viewport = this.deck.getViewports()[0];
    if (!viewport) return [];
    const members = this.nearbyRanks.flatMap((rank) => {
      const pos = this.posOf(rank);
      return pos ? [{ rank, pos }] : [];
    });
    const { layers, missing } = makeNearbyLabelLayers(
      members,
      nameOf,
      (position): [number, number] => {
        const projected = viewport.project(position) as number[];
        return [projected[0] ?? NaN, projected[1] ?? NaN];
      },
      viewport,
    );
    if (missing.length) this.requestLabelNames(missing);
    return layers;
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

  /** 选择只更新 uniform；查询变化另刷新结果成员掩码。 */
  recolor(): void {
    const selectionChanged = state.selection !== this.lastSelection;
    const neighborsChanged = state.neighbors !== this.lastWorkingNeighbors;
    this.lastWorkingNeighbors = state.neighbors;
    if (
      selectionChanged ||
      (
        neighborsChanged &&
        state.selection !== null &&
        !state.pinnedWorkingSets.has(state.selection)
      )
    ) {
      this.lastSelection = state.selection;
      this.startWorkingSetAnim();
    }
    this.scheduleNearbyLabels();
    this.render();
  }

  geometryGrew(): void {
    // 增量填充静态样式属性(每节点一生只算一次)
    const { geo, styleBuf } = this;
    for (let i = this.styled; i < geo.loaded; i++) {
      styleBuf[i * 4] = geo.flags[i] ?? 0;
      styleBuf[i * 4 + 1] = etype(geo.key[i] ?? 0);
      styleBuf[i * 4 + 2] = geo.size[i] ?? 0;
    }
    this.styled = geo.loaded;
    this.syncGpu();
    this.scheduleNearbyLabels();
    this.render();
  }

  private syncGpu(): void {
    if (!this.gpu) return;
    const m = this.styled;
    this.gpu.positions.sync(m * 12);
    this.gpu.radius.sync(m);
    this.gpu.style.sync(m * 4);
    this.gpu.queryResult.sync(m);
  }

  flyTo(rank: number, zoom?: number): void {
    const pos = this.posOf(rank);
    if (!pos) return;
    const next = this.camera.flyTo(pos, zoom);
    this.applyTransition(next);
  }

  centerSelection(rank: number): void {
    const pos = this.posOf(rank);
    if (!pos) return;
    const next = this.camera.centerSelection(pos);
    if (!next) {
      this.render();
      return;
    }
    this.applyTransition(next);
  }

  private applyTransition(next: OrbitState & Record<string, unknown>): void {
    this.deck.setProps({
      views: this.camera.view(),
      initialViewState: next,
    });
    this.cb.onViewChange(this.camera.viewState);
    this.scheduleNearbyLabels();
    this.render();
  }

  setView(vs: Partial<OrbitState>): void {
    this.camera.absorb({ ...this.camera.viewState, ...vs });
    this.applyCamera(true);
  }

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
    this.scheduleNearbyLabels();
    this.render();
  }

  // ---- 工作集动效：级联淡入 + 光环单脉冲 ----
  private startWorkingSetAnim(): void {
    this.wsAnimStart = performance.now();
    cancelAnimationFrame(this.wsRaf);
    if (prefersReducedMotion() || state.selection === null) return;
    const total =
      Math.min(state.neighbors.length, CASCADE_STEPS) * CASCADE_STEP_MS +
      CASCADE_FADE_MS +
      PULSE_MS;
    const tick = (): void => {
      this.render();
      if (performance.now() - this.wsAnimStart < total)
        this.wsRaf = requestAnimationFrame(tick);
    };
    this.wsRaf = requestAnimationFrame(tick);
  }

  private buildWorkingGeometryLayers(
    prefix: "" | "retained",
    edgeSegs: WorkingEdge[],
    nodes: Map<number, WorkingNode>,
    reduced: boolean,
    t: number,
  ): WorkingGeometryLayers {
    const layerId = (part: string): string =>
      prefix ? `ws-${prefix}-${part}` : `ws-${part}`;
    const linePos = new Float32Array(edgeSegs.length * 12);
    const lineColor = new Uint8Array(edgeSegs.length * 8);
    edgeSegs.forEach((sg, index) => {
      const mid: WorkingPosition = [
        (sg.a[0] + sg.b[0]) / 2,
        (sg.a[1] + sg.b[1]) / 2,
        (sg.a[2] + sg.b[2]) / 2,
      ];
      const hasDirection = sg.label !== "";
      const towardSelf = sg.label.startsWith("← ");
      const aBright = !hasDirection || towardSelf;
      const bBright = !hasDirection || !towardSelf;
      const offset = index * 12;
      linePos.set(sg.a, offset);
      linePos.set(mid, offset + 3);
      linePos.set(mid, offset + 6);
      linePos.set(sg.b, offset + 9);
      const dim = Math.round(sg.alpha * 0.2);
      const color = sg.retained ? [242, 91, 166] : [255, 255, 255];
      lineColor.set([...color, aBright ? sg.alpha : dim], index * 8);
      lineColor.set([...color, bBright ? sg.alpha : dim], index * 8 + 4);
    });
    const edgeLayer = edgeSegs.length
      ? new LineLayer({
          id: layerId("edges"),
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
              getColor: { value: lineColor, size: 4, normalized: true },
            },
          },
          getWidth: EDGE_WIDTH,
          widthUnits: "pixels",
          pickable: true,
          onHover: (info: { index: number; x: number; y: number }) => {
            const seg =
              info.index >= 0 ? edgeSegs[info.index >> 1] : undefined;
            this.cb.onHoverEdge(seg?.label || null, info.x, info.y);
          },
          parameters: { depthCompare: "always", depthWriteEnabled: false },
        })
      : null;
    const ranks = [...nodes.keys()];
    if (!ranks.length) return { edgeLayer, nodeLayers: [] };
    const pos = new Float32Array(ranks.length * 3);
    const col = new Uint8Array(ranks.length * 4);
    ranks.forEach((rank, index) => {
      const node = nodes.get(rank)!;
      pos.set(node.pos, index * 3);
      if (node.active || node.pinned) {
        col.set([255, 255, 255, 255], index * 4);
        return;
      }
      const [r, g, b] = TYPE_COLORS[etype(this.geo.key[rank] ?? 0)] ?? [
        255, 255, 255,
      ];
      if (node.retained) {
        col.set([r, g, b, 210], index * 4);
        return;
      }
      const k = cascadeProgress(t, node.neighborIndex ?? 0, reduced);
      col.set([r, g, b, Math.round(255 * k)], index * 4);
    });
    return {
      edgeLayer,
      nodeLayers: [
        new ScatterplotLayer({
          id: layerId("xray"),
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
        new ScatterplotLayer({
          id: layerId("lit"),
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
            const rank = info.index >= 0 ? ranks[info.index] : undefined;
            this.cb.onHover(rank ?? null, info.x, info.y);
          },
          onClick: (info: { index: number }) => {
            const rank = ranks[info.index];
            if (rank !== undefined) this.cb.onPick(rank);
            return true;
          },
        }),
      ],
    };
  }

  private buildWorkingSetCore(
    reduced: boolean,
    t: number,
  ): WorkingSetCore | null {
    const selectedRank = state.selection;
    const selectedPos = selectedRank === null ? null : this.posOf(selectedRank);
    const pinned = [...state.pinnedSelections].flatMap((rank) => {
      const pos = this.posOf(rank);
      return pos ? [{ rank, pos }] : [];
    });
    if (!selectedPos && pinned.length === 0) return null;
    // 未流式覆盖且无 sparse 坐标的邻居先不画(位置未知,不能画到原点)
    const shown: WorkingShown[] = [];
    const retainedSelected = selectedRank === null
      ? undefined
      : state.pinnedWorkingSets.get(selectedRank);
    const selectedRanks = state.neighbors.length
      ? state.neighbors
      : retainedSelected?.ranks ?? state.neighbors;
    const selectedLabels = state.neighbors.length
      ? state.neighborLabels
      : retainedSelected?.labels ?? state.neighborLabels;
    if (selectedPos)
      selectedRanks.forEach((rank, index) => {
        const pos = this.posOf(rank);
        if (pos)
          shown.push({
            rank,
            label: selectedLabels[index] ?? "",
            pos,
          });
      });
    const edgeSegs: WorkingEdge[] = [];
    shown.forEach((s, i) => {
      const k = retainedSelected && state.neighbors.length === 0
        ? 1
        : cascadeProgress(t, i, reduced);
      edgeSegs.push({
        a: selectedPos!,
        b: s.pos,
        label: s.label,
        alpha: Math.round(160 * k),
        retained: false,
      });
    });
    // 多条事实可以连到同一对端:边全部保留,节点实例按 rank 去重。
    const nodes = new Map<number, WorkingNode>();
    if (selectedRank !== null && selectedPos)
      nodes.set(selectedRank, {
        pos: selectedPos,
        active: true,
        pinned: state.pinnedSelections.has(selectedRank),
        retained: state.pinnedSelections.has(selectedRank),
        neighborIndex: null,
      });
    shown.forEach((node, neighborIndex) => {
      if (!nodes.has(node.rank))
        nodes.set(node.rank, {
          pos: node.pos,
          active: false,
          pinned: false,
          retained: false,
          neighborIndex,
        });
    });
    for (const node of pinned) {
      const existing = nodes.get(node.rank);
      if (existing) {
        existing.pinned = true;
        existing.retained = true;
      }
      else
        nodes.set(node.rank, {
          pos: node.pos,
          active: false,
          pinned: true,
          retained: true,
          neighborIndex: null,
        });
    }
    const geometry = this.buildWorkingGeometryLayers(
      "",
      edgeSegs,
      nodes,
      reduced,
      t,
    );
    const layers: unknown[] = [];
    if (geometry.edgeLayer) layers.push(geometry.edgeLayer);
    if (selectedPos)
      layers.push(new ScatterplotLayer({
        id: "ws-glow",
        data: {
          length: 1,
          attributes: {
            getPosition: {
              value: new Float32Array(selectedPos),
              size: 3,
            },
          },
        },
        getFillColor: [242, 91, 166, 60],
        radiusUnits: "common",
        getRadius: WORKING_GLOW_RADIUS,
        radiusMinPixels: 12,
        billboard: true,
        parameters: { depthCompare: "always", depthWriteEnabled: false },
      }));
    layers.push(...geometry.nodeLayers);
    if (pinned.length) {
      const pinPos = new Float32Array(pinned.length * 3);
      pinned.forEach((node, index) => pinPos.set(node.pos, index * 3));
      layers.push(new ScatterplotLayer({
        id: "ws-pins",
        data: {
          length: pinned.length,
          attributes: { getPosition: { value: pinPos, size: 3 } },
        },
        radiusUnits: "common",
        getRadius: WORKING_NODE_RADIUS * 1.65,
        radiusMinPixels: 8,
        filled: false,
        stroked: true,
        getLineColor: [242, 91, 166, 235],
        getLineWidth: 2,
        lineWidthUnits: "pixels",
        billboard: true,
        parameters: { depthCompare: "always", depthWriteEnabled: false },
      }));
    }
    return {
      selectedRank,
      selectedPos,
      pinned,
      shown,
      edgeSegs,
      nodes,
      layers,
    };
  }

  private buildRetainedWorkingSetCore(
    excludedRanks: ReadonlySet<number>,
  ): RetainedWorkingSetCore {
    const edgeSegs: WorkingEdge[] = [];
    const nodes = new Map<number, WorkingNode>();
    const addNode = (rank: number, pos: WorkingPosition): void => {
      if (excludedRanks.has(rank) || nodes.has(rank)) return;
      nodes.set(rank, {
        pos,
        active: false,
        pinned: false,
        retained: true,
        neighborIndex: null,
      });
    };
    for (const [rootRank, workingSet] of state.pinnedWorkingSets) {
      if (
        rootRank === state.selection ||
        !state.pinnedSelections.has(rootRank)
      ) continue;
      const rootPos = this.posOf(rootRank);
      if (!rootPos) continue;
      addNode(rootRank, rootPos);
      workingSet.ranks.forEach((rank, index) => {
        const pos = this.posOf(rank);
        if (!pos) return;
        addNode(rank, pos);
        edgeSegs.push({
          a: rootPos,
          b: pos,
          label: workingSet.labels[index] ?? "",
          alpha: 105,
          retained: true,
        });
      });
    }
    return {
      edgeSegs,
      nodes,
      geometry: this.buildWorkingGeometryLayers(
        "retained",
        edgeSegs,
        nodes,
        true,
        0,
      ),
    };
  }

  /** 相机变化不改变工作集几何；动效结束后复用已构造的二进制图层。 */
  private workingSetLayers(): unknown[] {
    const reduced = prefersReducedMotion();
    const t = performance.now() - this.wsAnimStart;
    const stableAfter =
      Math.min(state.neighbors.length, CASCADE_STEPS) * CASCADE_STEP_MS +
      CASCADE_FADE_MS;
    const stable =
      reduced ||
      state.selection === null ||
      state.neighbors.length === 0 ||
      t >= stableAfter;
    const geometryLoaded = this.geo.loaded ?? -1;
    const sparseCount = this.geo.sparse?.size ?? 0;
    const cached = this.workingSetCoreCache ?? null;
    const cacheHit = stable &&
      cached !== null &&
      cached.selection === state.selection &&
      cached.neighbors === state.neighbors &&
      cached.neighborLabels === state.neighborLabels &&
      cached.pinnedSelections === state.pinnedSelections &&
      cached.pinnedWorkingSets === state.pinnedWorkingSets &&
      cached.geometryLoaded === geometryLoaded &&
      cached.sparseCount === sparseCount &&
      cached.reduced === reduced;
    const core = cacheHit
      ? cached.core
      : this.buildWorkingSetCore(reduced, t);
    if (!core) {
      this.workingSetCoreCache = null;
      return [];
    }
    if (stable && !cacheHit) {
      this.workingSetCoreCache = {
        selection: state.selection,
        neighbors: state.neighbors,
        neighborLabels: state.neighborLabels,
        pinnedSelections: state.pinnedSelections,
        pinnedWorkingSets: state.pinnedWorkingSets,
        geometryLoaded,
        sparseCount,
        reduced,
        core,
      };
    } else if (!stable) {
      this.workingSetCoreCache = null;
    }
    const retainedCached = this.retainedWorkingSetCoreCache ?? null;
    const retainedCacheHit =
      retainedCached !== null &&
      retainedCached.selection === state.selection &&
      retainedCached.neighbors === state.neighbors &&
      retainedCached.pinnedSelections === state.pinnedSelections &&
      retainedCached.pinnedWorkingSets === state.pinnedWorkingSets &&
      retainedCached.geometryLoaded === geometryLoaded &&
      retainedCached.sparseCount === sparseCount;
    const retained = retainedCacheHit
      ? retainedCached.core
      : this.buildRetainedWorkingSetCore(new Set(core.nodes.keys()));
    if (!retainedCacheHit) {
      this.retainedWorkingSetCoreCache = {
        selection: state.selection,
        neighbors: state.neighbors,
        pinnedSelections: state.pinnedSelections,
        pinnedWorkingSets: state.pinnedWorkingSets,
        geometryLoaded,
        sparseCount,
        core: retained,
      };
    }
    const {
      selectedRank,
      selectedPos,
      pinned,
      shown,
      edgeSegs,
      nodes,
    } = core;
    const layerId = (layer: unknown): string | undefined =>
      (layer as { id?: string }).id;
    const activeEdge = core.layers.find((layer) => layerId(layer) === "ws-edges");
    const glow = core.layers.find((layer) => layerId(layer) === "ws-glow");
    const layers: unknown[] = [];
    if (retained.geometry.edgeLayer) layers.push(retained.geometry.edgeLayer);
    if (activeEdge) layers.push(activeEdge);
    if (glow) layers.push(glow);
    layers.push(...retained.geometry.nodeLayers);
    layers.push(...core.layers.filter((layer) => {
      const id = layerId(layer);
      return id !== "ws-edges" && id !== "ws-glow";
    }));
    // 全量边不应触发无界封面与名字请求。常驻装饰只取热度最高的
    // 前 50 条关系;用户显式保留的根节点始终加入该集合。
    const decorationRanks = new Set<number>();
    if (selectedRank !== null && selectedPos) decorationRanks.add(selectedRank);
    for (const node of shown.slice(0, WORKING_DECORATION_LIMIT))
      decorationRanks.add(node.rank);
    for (const node of pinned) decorationRanks.add(node.rank);
    const decoratedRanks = [...decorationRanks];
    const neighborIndexByRank = new Map<number, number>();
    shown.forEach((node, index) => {
      if (!neighborIndexByRank.has(node.rank))
        neighborIndexByRank.set(node.rank, index);
    });
    const covers = coverItems(decoratedRanks, this.geo.key);
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
            const neighborIndex = neighborIndexByRank.get(d.rank);
            const k =
              d.rank === selectedRank || state.pinnedSelections.has(d.rank)
                ? 1
                : cascadeProgress(t, neighborIndex ?? 0, reduced);
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
      if (viewport) {
        const { layers: nameLayers, missing } = workingLabelLayers(
          decoratedRanks.flatMap((rank) => {
            const node = nodes.get(rank) ?? retained.nodes.get(rank);
            return node ? [{ rank, pos: node.pos }] : [];
          }),
          [
            ...edgeSegs.slice(0, WORKING_DECORATION_LIMIT),
            ...retained.edgeSegs.slice(
              0,
              Math.max(0, WORKING_DECORATION_LIMIT - edgeSegs.length),
            ),
          ],
          nameOf,
          (p) => {
            const s = viewport.project(p) as number[];
            return [s[0] ?? 0, s[1] ?? 0];
          },
          viewport,
          this.camera.viewState.zoom,
        );
        if (missing.length) this.requestLabelNames(missing);
        layers.push(...nameLayers);
      }
    }
    // 选中后只播放一次 500ms 扩散，避免持续动画干扰浏览。
    if (selectedPos && !reduced && t < PULSE_MS) {
      const k = t / PULSE_MS;
      layers.push(
        new ScatterplotLayer({
          id: "ws-pulse",
          data: {
            length: 1,
            attributes: {
              getPosition: {
                value: new Float32Array(selectedPos),
                size: 3,
              },
            },
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

  private syncQueryResultMask(): void {
    const next = state.queryResultRanks;
    if (next === this.queryResultMaskSource) return;
    updateQueryResultMask(
      this.queryResultMask,
      this.queryResultMaskSource,
      next,
    );
    this.queryResultMaskSource = next;
    if (this.gpu) this.gpu.queryResult.refresh(this.styled);
    else {
      // CPU 回退路径的二进制属性由对象身份触发重传。
      this.contextData = null;
      this.contextLength = -1;
    }
  }

  private hasVisibleQueryResult(): boolean {
    return hasVisibleSortedRank(state.queryResultRanks, this.styled);
  }

  /** 语境层数据:属性引用恒定(GPU Buffer 或 CPU 数组),
   * 对象只在填充进度或 CPU 回退掩码变化时更换。
   * 长度用 styled 而非 geo.loaded:loaded 在流回调里实时推进,
   * 而样式属性/GPU 同步以 250ms 节流跟进,超前的区间会以
   * 原点零样式"幻影点"闪现。 */
  private buildContextData(): ContextData {
    if (this.contextLength !== this.styled || !this.contextData) {
      const g = this.gpu;
      this.contextData = {
        length: this.styled,
        attributes:
          g?.positions.handle &&
          g.radius.handle &&
          g.style.handle &&
          g.queryResult.handle
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
                getQueryResult: {
                  buffer: g.queryResult.handle,
                  size: 1,
                  type: "unorm8",
                  stride: 1,
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
                getQueryResult: {
                  value: this.queryResultMask,
                  size: 1,
                  type: "unorm8",
                },
              },
      };
      this.contextLength = this.styled;
    }
    return this.contextData;
  }

  private atlasUniforms(): AtlasUniforms {
    return {
      spotlight: hasWorkingSet() || this.hasVisibleQueryResult()
        ? 1
        : 0,
    };
  }

  render(): void {
    this.syncQueryResultMask();
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
    layers.push(...this.nearbyLabelLayers());
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
