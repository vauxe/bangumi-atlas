/** deck.gl 场景:语境层(点+近景视锥内骨架边)、工作集聚光/X-ray、
 * GPU 拾取、雾。
 *
 * 性能架构:节点的颜色/亮度/可见性全部在 shader 里由静态实例属性
 * (style、yearComm)+ 少量 uniform 推导——年份滑块、媒介 chips、
 * 聚光、图层切换都只改 uniform,零 CPU 循环、零属性重传
 * (实测 CPU 路径 985k 节点 recolor 循环 61ms/次 + ~21MB 重传,已移除)。
 * 可见性用 fs discard 表达,被滤除节点连拾取/高亮一起消失(§4)。
 * 几何流式期间属性写入 GPU Buffer 增量区间,不整块重传。 */

import { Deck, LayerExtension, OrbitView } from "@deck.gl/core";
import { Buffer as LumaBuffer } from "@luma.gl/core";
import type { Device } from "@luma.gl/core";
import { IconLayer, LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Camera, prefersReducedMotion } from "./camera";
import type { OrbitState } from "./camera";
import { labelLayers } from "./labels";
import type { LabelCache, LabelData } from "./labels";
import { state } from "./store";
import { coverUrl, TYPE_COLORS, etype } from "./types";
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

// ---- 节点样式扩展:着色/过滤/雾一体,全在 GPU ----
// 实例属性:instanceStyle = [flags, etype, sizeLog, 0](u8×4)、
// instanceYearComm = [year, community](u16×2);其余全是 uniform。
// 注意:luma 的 uniform block 解析按行取首个声明,必须一行一字段;
// 全用 float——int 成员的默认精度 vs(highp)/fs(mediump)不一致,
// 会在链接期报 precision mismatch,掩码值 ≤126 用 float 无损
const ATLAS_UNIFORM_BLOCK = `uniform atlasUniforms {
  vec3 cameraPos;
  float fogStart;
  float fogFalloff;
  float yearMin;
  float yearMax;
  float mediaMask;
  float scoreMin;
  float tagLo;
  float tagHi;
  float spotlight;
  float colorBy;
  float zoomRel;
} atlas;`;

const atlasShaderModule = {
  name: "atlas",
  vs: ATLAS_UNIFORM_BLOCK,
  fs: ATLAS_UNIFORM_BLOCK,
  uniformTypes: {
    cameraPos: "vec3<f32>",
    fogStart: "f32",
    fogFalloff: "f32",
    yearMin: "f32",
    yearMax: "f32",
    mediaMask: "f32",
    scoreMin: "f32",
    tagLo: "f32",
    tagHi: "f32",
    spotlight: "f32",
    colorBy: "f32",
    zoomRel: "f32",
  },
} as const;

export interface AtlasUniforms {
  cameraPos: [number, number, number];
  fogStart: number;
  fogFalloff: number;
  yearMin: number;
  yearMax: number;
  mediaMask: number;
  scoreMin: number;
  tagLo: number;
  tagHi: number;
  spotlight: number;
  colorBy: number;
  zoomRel: number;
}

class NodeStyleExtension extends LayerExtension {
  static override extensionName = "NodeStyleExtension";

  override getShaders(): Record<string, unknown> {
    return {
      modules: [atlasShaderModule],
      inject: {
        "vs:#decl": `
in vec4 instanceStyle;
in vec2 instanceYearComm;
in vec2 instanceTags;
out vec4 atlas_style;
out vec2 atlas_yc;
out vec2 atlas_tags;
out float atlas_fogDepth;`,
        "vs:#main-end": `
atlas_style = instanceStyle;
atlas_yc = instanceYearComm;
atlas_tags = instanceTags;
atlas_fogDepth = distance(geometry.worldPosition.xyz, atlas.cameraPos);`,
        // 孤立外壳的缩小随缩放消退:远景压到亚像素防糊住本体(§7),
        // 近景恢复原尺寸——固定 0.35× 曾让贴近的节点时隐时现
        // (该钩子作用于像素钳制之后,能真正压到亚像素)
        "vs:DECKGL_FILTER_SIZE": `
if (mod(floor(instanceStyle.x / 2.0), 2.0) >= 1.0)
  size *= mix(0.35, 1.0, smoothstep(1.5, 3.5, atlas.zoomRel));`,
        "fs:#decl": `
in vec4 atlas_style;
in vec2 atlas_yc;
in vec2 atlas_tags;
in float atlas_fogDepth;`,
        // 颜色/亮度/可见性推导(与设计 §4/§5 一一对应;
        // discard 使被滤除节点同时移出拾取与 autoHighlight)
        "fs:DECKGL_FILTER_COLOR": `
{
  float f_flags = atlas_style.x;
  float f_etype = atlas_style.y;
  float f_size = atlas_style.z;
  float f_year = atlas_yc.x;
  float f_comm = atlas_yc.y;
  bool a_iso = mod(floor(f_flags / 2.0), 2.0) >= 1.0;
  int a_media = int(floor(f_flags / 4.0));
  bool isSubject = f_etype < 1.5; // 档位比较,规避浮点等值
  bool yearOn = atlas.yearMin > 0.5 || atlas.yearMax < 9998.5;
  bool scoreOn = atlas.scoreMin > 0.5;
  bool tagsOn = atlas.tagLo > 0.5 || atlas.tagHi > 0.5;
  if (isSubject) {
    if (yearOn && f_year > 0.5 &&
        (f_year < atlas.yearMin || f_year > atlas.yearMax)) discard;
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
  if (atlas.colorBy > 0.5 && f_comm < 65534.5) {
    float h = mod(f_comm * 137.508, 360.0) / 60.0;
    float x = 1.0 - abs(mod(h, 2.0) - 1.0);
    vec3 c = h < 1.0 ? vec3(1.0, x, 0.0)
           : h < 2.0 ? vec3(x, 1.0, 0.0)
           : h < 3.0 ? vec3(0.0, 1.0, x)
           : h < 4.0 ? vec3(0.0, x, 1.0)
           : h < 5.0 ? vec3(x, 0.0, 1.0)
           : vec3(1.0, 0.0, x);
    rgb = 118.0 + c * 112.0; // 提底降幅:社区色更粉彩(§5 低饱和)
  }
  // 孤立外壳 9.2 万点包裹星系,远景亮度稍高即叠成实心球(实测
  // 压到 ~14% 才不糊本体,§7);近景密度自然稀疏,压制随缩放
  // 消退,凑近的孤立节点恢复接近普通节点的亮度
  float isoT = smoothstep(1.5, 3.5, atlas.zoomRel);
  float a = a_iso
    ? mix(36.0, 150.0, isoT)
    : 160.0 + min(50.0, floor(f_size / 4.0));
  // 作品属性过滤激活时,人物/角色(与无年份作品)随之降暗不隐藏
  bool subjFilterOn = yearOn || scoreOn || tagsOn;
  if ((subjFilterOn && !isSubject) ||
      (yearOn && isSubject && f_year < 0.5)) a = min(a, 90.0);
  int mediaMask = int(atlas.mediaMask + 0.5);
  if (mediaMask != 0 && a_media > 0 &&
      (mediaMask & (1 << a_media)) == 0) a = 40.0;
  if (atlas.spotlight > 0.5) a = min(a, 38.0);
  a *= mix(0.25, 1.0,
    exp(-max(atlas_fogDepth - atlas.fogStart, 0.0) * atlas.fogFalloff));
  // 入参 color.a 携带圆边平滑因子(SDF AA),必须保留
  color = vec4(rgb / 255.0, (a / 255.0) * color.a);
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
      instanceYearComm: {
        size: 2,
        type: "uint16",
        accessor: "getYearComm",
      },
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

/** 封面圆形裁剪:icon 层的 geometry.uv 即四角 [-1,1] 局部坐标,
 * 裁成内切圆 + 边缘 6% 平滑,封面就是节点本体的视觉替换。 */
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
  /** 工作集边悬停:解码关系 labelId(语境骨架边不出 tooltip)。 */
  onHoverEdge: (labelId: number | null, x: number, y: number) => void;
  onViewChange: (vs: OrbitState) => void;
}

export class Scene {
  readonly camera: Camera;
  private deck: Deck<OrbitView>;
  private geo: Geometry;
  private worldSize: number;
  private labels: LabelData | null = null;
  private labelCache: LabelCache = {};
  private styleVersion = 0; // 标签可见性相关过滤的变化计数(缓存键)
  private labelFilterKey = "";

  // 静态实例属性(随几何流一次性填充,之后永不重算)
  private styleBuf: Uint8Array; // [flags, etype, sizeLog, 0] × n
  private yearCommBuf: Uint16Array; // [year, community] × n
  private styled = 0; // 已填充的节点数

  // GPU 常驻缓冲(设备就绪后接管;之前 render 退回 CPU 数组直灌)
  private gpu: {
    positions: GrowingBuffer;
    radius: GrowingBuffer;
    style: GrowingBuffer;
    yearComm: GrowingBuffer;
    tags: GrowingBuffer;
  } | null = null;

  private contextData: ContextData | null = null;
  private contextLength = -1;

  private edges: Uint32Array | null = null;
  private edgePos: Float32Array | null = null; // 预分配 EDGE_CAP*6
  private edgeData: ContextData | null = null;
  private edgeCount = 0;
  private edgeOpacity = 0;
  private edgeFadeRaf = 0;
  private edgeRebuildTimer = 0;
  private edgeRebuildForce = false;
  private edgeCamKey = ""; // 相机静止时跳过重建

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
    const n = geo.key.length;
    this.styleBuf = new Uint8Array(n * 4);
    this.yearCommBuf = new Uint16Array(n * 2);
    this.deck = new Deck({
      parent,
      views: this.camera.view(),
      useDevicePixels: Math.min(devicePixelRatio, 1.5),
      // §5:左键拖 = 平移,右键拖 = 轨道旋转(deck 默认相反)
      controller: { inertia: 300, doubleClickZoom: false, dragMode: "pan" },
      initialViewState: this.camera.viewState,
      pickingRadius: 5,
      onDeviceInitialized: (device: Device) => {
        this.gpu = {
          positions: new GrowingBuffer(
            device,
            new Uint8Array(this.geo.positions.buffer),
          ),
          radius: new GrowingBuffer(device, this.geo.size),
          style: new GrowingBuffer(device, this.styleBuf),
          yearComm: new GrowingBuffer(
            device,
            new Uint8Array(this.yearCommBuf.buffer),
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
    // 右键负责轨道旋转(§5):拦掉浏览器右键菜单,否则每次
    // 旋转松手都会弹菜单打断操作
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
      if (y > 0 && (y < f.yearMin || y > f.yearMax)) return false;
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

  /** 过滤/聚光/图层变化:现在只是 uniform 更新 + 边可见集重建。 */
  recolor(): void {
    if (state.selection !== this.lastSelection) {
      this.lastSelection = state.selection;
      this.startWorkingSetAnim();
    }
    // 标签 data 只在影响其可见性的过滤变化时重建;
    // 纯选中/图层切换不触发碰撞检测重算
    const f = state.filters;
    const k = `${f.yearMin}|${f.yearMax}|${f.scoreMin}|${[...f.tags].join()}`;
    if (k !== this.labelFilterKey) {
      this.labelFilterKey = k;
      this.styleVersion++;
    }
    this.rebuildEdgeSet(true);
    this.render();
  }

  /** 骨架边(权重降序,客户端前缀优先)。 */
  setEdges(edges: Uint32Array): void {
    this.edges = edges;
    this.edgePos = new Float32Array(EDGE_CAP * 6);
    this.rebuildEdgeSet(true);
    this.render();
  }

  setLabels(l: LabelData): void {
    this.labels = l;
    this.labelCache = {};
    this.render();
  }

  geometryGrew(): void {
    // 增量填充静态样式属性(每节点一生只算一次)
    const { geo, styleBuf, yearCommBuf } = this;
    for (let i = this.styled; i < geo.loaded; i++) {
      styleBuf[i * 4] = geo.flags[i] ?? 0;
      styleBuf[i * 4 + 1] = etype(geo.key[i] ?? 0);
      styleBuf[i * 4 + 2] = geo.size[i] ?? 0;
      styleBuf[i * 4 + 3] = geo.score[i] ?? 0; // 评分×10,属性过滤用
      yearCommBuf[i * 2] = geo.year[i] ?? 0;
      yearCommBuf[i * 2 + 1] = geo.community[i] ?? 0;
    }
    this.styled = geo.loaded;
    this.syncGpu();
    this.scheduleEdgeRebuild(true); // 新到几何可能解锁新边,不依赖相机动
    this.render();
  }

  private syncGpu(): void {
    if (!this.gpu) return;
    const m = this.styled;
    this.gpu.positions.sync(m * 12);
    this.gpu.radius.sync(m);
    this.gpu.style.sync(m * 4);
    this.gpu.yearComm.sync(m * 4);
    this.gpu.tags.sync(m * 4);
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

  /** 正交开关(URL 还原用;`2` 键走 topView)。 */
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

  // ---- 骨架边可见集:CPU 毫秒级重建(实测 824k 边 3.5ms)----
  private scheduleEdgeRebuild(force = false): void {
    this.edgeRebuildForce ||= force;
    if (this.edgeRebuildTimer) return;
    this.edgeRebuildTimer = window.setTimeout(() => {
      this.edgeRebuildTimer = 0;
      const f = this.edgeRebuildForce;
      this.edgeRebuildForce = false;
      this.rebuildEdgeSet(f);
      this.render();
    }, 120);
  }

  private rebuildEdgeSet(force: boolean): void {
    const { edges, edgePos, geo } = this;
    if (!edges || !edgePos) return;
    const vs = this.camera.viewState;
    const zoomRel = vs.zoom - this.camera.fitZoom;
    const wasOn = this.edgeCount > 0;
    if (zoomRel < EDGE_ZOOM) {
      this.edgeCount = 0;
      this.edgeData = null;
      this.edgeCamKey = "";
      return;
    }
    // 相机静止(量化位姿相同)且非强制时跳过:悬停等高频 render 不重扫
    const camKey = `${vs.target.map((v) => v.toFixed(1)).join()},${vs.zoom.toFixed(2)}`;
    if (!force && camKey === this.edgeCamKey) return;
    this.edgeCamKey = camKey;
    const f = state.filters;
    const yMin = f.yearMin;
    const yMax = f.yearMax;
    const sMin = f.scoreMin;
    let sel = 0;
    for (const bIdx of f.tags) sel = (sel | (1 << bIdx)) >>> 0;
    const yearOn = yMin > 0 || yMax < 9999;
    const subjFilterOn = yearOn || sMin > 0 || sel !== 0;
    const { year, key, score, tags } = geo;
    // 与 isVisible 同判定,掩码预计算后内联(164 万次调用的热路径)
    const passes = (i: number): boolean => {
      if ((key[i] ?? 0) >>> 24 !== 1) return true;
      if (yearOn) {
        const y = year[i] ?? 0;
        if (y > 0 && (y < yMin || y > yMax)) return false;
      }
      if (sMin > 0 && (score[i] ?? 0) < sMin) return false;
      if (sel !== 0 && (((tags[i] ?? 0) & sel) >>> 0) !== sel)
        return false;
      return true;
    };
    const [tx, ty, tz] = vs.target;
    const radius = (this.worldSize / Math.pow(2, zoomRel)) * 1.5;
    const r2 = radius * radius;
    const pos = geo.positions;
    let cnt = 0;
    const n = edges.length / 2;
    for (let e = 0; e < n && cnt < EDGE_CAP; e++) {
      const a = edges[e * 2] ?? 0;
      const b = edges[e * 2 + 1] ?? 0;
      if (a >= geo.loaded || b >= geo.loaded) continue;
      // 单端被滤除的边不进可见集
      if (subjFilterOn && (!passes(a) || !passes(b))) continue;
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
    // 上传量 ∝ 可见数(subarray),data 引用只在重建时更换
    const view = edgePos.subarray(0, cnt * 6);
    this.edgeData = {
      length: cnt,
      attributes: {
        getSourcePosition: { value: view, size: 3, stride: 24 },
        getTargetPosition: { value: view, size: 3, stride: 24, offset: 12 },
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
    // 未流式覆盖且无 sparse 坐标的邻居先不画(位置未知,不能画到原点)
    const shown: { rank: number; label: number; pos: [number, number, number] }[] = [];
    state.neighbors.forEach((rk, i) => {
      const p = this.posOf(rk);
      if (p) shown.push({ rank: rk, label: state.neighborLabels[i] ?? -1, pos: p });
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
      // 辉光:选中点脚下的柔和粉色光晕(§9-8 打磨,萌系点缀)
      new ScatterplotLayer({
        id: "ws-glow",
        data: { length: 1, attributes: { getPosition: { value: pos, size: 3 } } },
        getFillColor: [242, 91, 166, 46], // Miku 品红光晕
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
    // 封面 = 节点的视觉替换:圆形裁剪,几何严格对齐下层圆点
    // (略小 8%,圆点描边露出一圈作头像环;拾取/悬停仍走圆点层,
    // 图片加载失败时圆点自然兜底)
    layers.push(
      new IconLayer({
        id: "ws-covers",
        data: ranks.map((rk, i) => ({
          rank: rk,
          key: this.geo.key[rk] ?? 0,
          i,
        })),
        getIcon: (d: { key: number }) => ({
          url: coverUrl(d.key, "small"), // WebGL 纹理只能用 small(CORS)
          id: String(d.key),
          // 声明为正方形配合内切圆裁剪;非方图的轻微挤压在
          // 节点尺寸(≤18px)下不可辨
          width: 100,
          height: 100,
        }),
        getPosition: (d: { rank: number }) =>
          this.posOf(d.rank) ?? [0, 0, 0],
        getSize: 4.05, // 圆点直径 4.4 的 92%
        getColor: (d: { i: number }) => {
          // 级联淡入与圆点同步(mask=false 时 alpha 即不透明度)
          const k =
            reduced || d.i === 0
              ? 1
              : Math.max(
                  0,
                  Math.min(
                    1,
                    (t - (d.i - 1) * CASCADE_STEP_MS) / CASCADE_FADE_MS,
                  ),
                );
          return [255, 255, 255, Math.round(255 * k)];
        },
        updateTriggers: { getColor: t },
        sizeUnits: "common",
        sizeMinPixels: 5.5,
        sizeMaxPixels: 16.5,
        billboard: true,
        extensions: [new CircleCropExtension()],
        loadOptions: { image: { crossOrigin: "anonymous" } },
      }),
    );
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
          getLineColor: [242, 91, 166, Math.round(200 * (1 - k))],
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
          g.yearComm.handle
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
                getYearComm: {
                  buffer: g.yearComm.handle,
                  size: 2,
                  type: "uint16",
                  stride: 4,
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
                getYearComm: {
                  value: this.yearCommBuf,
                  size: 2,
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
      cameraPos: this.cameraPosition(),
      fogStart: this.cameraDistance() * 1.05,
      fogFalloff: 1.6 / Math.max(this.worldSize, 1),
      yearMin: f.yearMin,
      yearMax: f.yearMax,
      mediaMask: mask,
      scoreMin: f.scoreMin,
      tagLo: sel & 0xffff,
      tagHi: sel >>> 16,
      spotlight: state.selection !== null ? 1 : 0,
      colorBy: f.colorBy === "community" ? 1 : 0,
      zoomRel: this.camera.viewState.zoom - this.camera.fitZoom,
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
          (rank) => this.isVisible(rank),
          this.styleVersion,
          this.labelCache,
        ),
      );
    layers.push(...this.workingSetLayers());
    this.deck.setProps({ layers: layers as never[] });
  }

  /** 相机世界坐标(雾用):优先取 deck 视口的真实值——手推公式
   * 曾把轨道角 X 分量符号写反,旋转后雾压暗的是朝向观者的半边。 */
  private cameraPosition(): [number, number, number] {
    try {
      // deck 初始化完成前 getViewports 会断言失败(构造期首帧)
      const vp = this.deck.getViewports()[0] as
        | { cameraPosition?: number[] }
        | undefined;
      const cp = vp?.cameraPosition;
      if (cp && cp.length === 3)
        return [cp[0] ?? 0, cp[1] ?? 0, cp[2] ?? 0];
    } catch {
      // 落入后备公式
    }
    // 首帧视口未就绪时的后备(已对 deck OrbitViewport 逐例核准)
    const { target, rotationX, rotationOrbit } = this.camera.viewState;
    const d = this.cameraDistance();
    const rx = (rotationX * Math.PI) / 180;
    const ro = (rotationOrbit * Math.PI) / 180;
    return [
      target[0] - d * Math.cos(rx) * Math.sin(ro),
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
