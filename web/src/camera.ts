/** 相机模块：turntable 轨道、聚焦飞行、复位、俯视正交保底、
 * 冷启动自转。视图状态是唯一事实,过渡参数不污染状态本身。 */

import {
  LinearInterpolator,
  OrbitController,
  OrbitView,
} from "@deck.gl/core";
import type { MjolnirWheelEvent } from "mjolnir.js";
import type { Bounds3D } from "./types";

export interface OrbitState {
  target: [number, number, number];
  zoom: number;
  rotationX: number;
  rotationOrbit: number;
  [k: string]: unknown;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const FLY_MS = 400;
// OrbitView 在 zoom=0 时以一世界单位对应一像素；聚焦采用稳定的局部
// 空间尺度。zoom=6.2 时 0.28 世界尺度略大于高亮节点的 18 px 直径。
const FOCUS_ZOOM = 6.2;
const FAR_MARGIN = 1.1;

/** deck 的滚轮曲线，但不把鼠标所在的空平面误当成新的关注点。 */
export function zoomWithoutRetarget<T extends OrbitState>(
  state: T,
  delta: number,
  speed = 0.01,
): T {
  let scale = 2 / (1 + Math.exp(-Math.abs(delta * speed)));
  if (delta < 0 && scale !== 0) scale = 1 / scale;
  return {
    ...state,
    target: [...state.target],
    zoom: state.zoom + Math.log2(scale),
  };
}

/** 有真实几何时沿用 deck 的光标锚定；空白处只改变缩放，关注点不漂移。 */
export class AtlasOrbitController extends OrbitController {
  protected override _onWheel(event: MjolnirWheelEvent): boolean {
    if (!this.scrollZoom) return false;
    const pos = this.getCenter(event);
    if (!this.isPointInBounds(pos, event)) return false;

    const { x = 0, y = 0 } = this.props as { x?: number; y?: number };
    const picked = this.pickPosition?.(x + pos[0], y + pos[1]);
    event.srcEvent.preventDefault();
    const { speed = 0.01 } =
      this.scrollZoom === true ? {} : this.scrollZoom;
    const next = zoomWithoutRetarget(
      this.controllerState.getViewportProps() as unknown as OrbitState,
      event.delta,
      speed,
    );
    let nextState = this.controllerState._getUpdatedState({ zoom: next.zoom });
    if (picked?.coordinate) {
      const viewport = nextState.makeViewport(nextState.getViewportProps());
      nextState = nextState._getUpdatedState(
        viewport.panByPosition(picked.coordinate, pos),
      );
    }
    this.updateViewport(
      nextState,
      null,
      { isZooming: false, isPanning: false },
    );
    return true;
  }
}

export class Camera {
  viewState: OrbitState;
  readonly bounds: Bounds3D;
  /** 正交模式属于相机状态；启用时切换投影而不改变轨道位姿。 */
  ortho = false;
  private homeState: OrbitState;
  private viewportHeight = Math.max(innerHeight, 1);

  constructor(bounds: Bounds3D) {
    this.bounds = [
      [...bounds[0]],
      [...bounds[1]],
    ];
    const [lo, hi] = this.bounds;
    const spans: [number, number, number] = [
      hi[0] - lo[0],
      hi[1] - lo[1],
      hi[2] - lo[2],
    ];
    const worldSize = Math.max(...spans);
    // 仅用 bbox 标定全图 home；交互与局部渲染使用绝对 zoom。
    const fitZoom = Math.log2(
      Math.min(innerWidth, innerHeight) / Math.max(worldSize, 1),
    );
    this.homeState = {
      target: [
        (lo[0] + hi[0]) / 2,
        (lo[1] + hi[1]) / 2,
        (lo[2] + hi[2]) / 2,
      ],
      zoom: fitZoom - 0.2,
      rotationX: 25,
      rotationOrbit: 0,
    };
    this.viewState = {
      ...this.homeState,
      target: [...this.homeState.target],
    };
  }

  /** 跟随画布高度更新投影深度的世界单位换算。 */
  resize(height: number): void {
    if (Number.isFinite(height) && height > 0) this.viewportHeight = height;
  }

  /** turntable:orbitAxis Y 即禁 roll;远裁剪面覆盖当前枢轴到整个 bbox。 */
  view(): OrbitView {
    const [lo, hi] = this.bounds;
    const [tx, ty, tz] = this.viewState.target;
    const graphDepth = Math.hypot(
      Math.max(Math.abs(tx - lo[0]), Math.abs(tx - hi[0])),
      Math.max(Math.abs(ty - lo[1]), Math.abs(ty - hi[1])),
      Math.max(Math.abs(tz - lo[2]), Math.abs(tz - hi[2])),
    );
    const scale = 2 ** this.viewState.zoom / this.viewportHeight;
    const far = Math.max(
      10,
      (2 + graphDepth * scale) * FAR_MARGIN,
    );
    return new OrbitView({
      id: "orbit",
      orbitAxis: "Y",
      orthographic: this.ortho,
      near: 0.1,
      far,
    });
  }

  /** 相机状态只保存位姿；控制器元数据与过渡参数不会成为共享状态。 */
  absorb(vs: Record<string, unknown>): void {
    const current = this.viewState;
    const target = (vs.target ?? current.target) as OrbitState["target"];
    this.viewState = {
      target: [...target],
      zoom: (vs.zoom ?? current.zoom) as number,
      rotationX: (vs.rotationX ?? current.rotationX) as number,
      rotationOrbit: (vs.rotationOrbit ?? current.rotationOrbit) as number,
    };
  }

  /** 聚焦飞行:返回带一次性过渡参数的状态供 deck 消费,
   * 自身只保留干净状态。缺省缩放只进不退——已比默认聚焦层级
   * 更近时保持当前缩放,双击/行走不会把相机拽回远处。 */
  flyTo(
    pos: [number, number, number],
    zoom?: number,
  ): OrbitState & Record<string, unknown> {
    this.viewState = {
      ...this.viewState,
      target: this.clampTarget(pos),
      zoom: zoom ?? Math.max(this.viewState.zoom, FOCUS_ZOOM),
    };
    return {
      ...this.viewState,
      transitionDuration: prefersReducedMotion() ? 0 : FLY_MS,
      transitionInterpolator: new LinearInterpolator([
        "target",
        "zoom",
        "rotationX",
        "rotationOrbit",
      ]),
    };
  }

  /** `T`:俯视 + 正交投影(2D 保底);再按恢复透视轨道。 */
  toggleTop(): OrbitState {
    this.ortho = !this.ortho;
    this.viewState = {
      ...this.viewState,
      rotationX: this.ortho ? 89.9 : this.homeState.rotationX,
      rotationOrbit: 0,
    };
    return this.viewState;
  }

  /** `R`:相机复位(恢复透视)。 */
  home(): OrbitState {
    this.ortho = false;
    this.viewState = {
      ...this.homeState,
      target: [...this.homeState.target],
    };
    return this.viewState;
  }

  /** 冷启动背景自转一步；reduced-motion 时由调用方跳过。 */
  orbitStep(deg: number): OrbitState {
    this.viewState = {
      ...this.viewState,
      rotationOrbit: ((this.viewState.rotationOrbit + deg) % 360 + 360) % 360,
    };
    return this.viewState;
  }

  private clampTarget(target: OrbitState["target"]): OrbitState["target"] {
    const [lo, hi] = this.bounds;
    return [
      Math.min(Math.max(target[0], lo[0]), hi[0]),
      Math.min(Math.max(target[1], lo[1]), hi[1]),
      Math.min(Math.max(target[2], lo[2]), hi[2]),
    ];
  }
}
