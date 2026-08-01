/** 相机模块：turntable 轨道、聚焦飞行、复位、俯视正交保底、
 * 冷启动自转。视图状态是唯一事实,过渡参数不污染状态本身。 */

import { LinearInterpolator, OrbitView } from "@deck.gl/core";

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
// 空间尺度，不随全图 bbox 改变。
const FOCUS_ZOOM = 3.2;

export class Camera {
  viewState: OrbitState;
  /** 正交模式属于相机状态；启用时切换投影而不改变轨道位姿。 */
  ortho = false;
  private homeState: OrbitState;

  constructor(worldSize: number) {
    // 仅用 bbox 标定全图 home；交互与局部渲染使用绝对 zoom。
    const fitZoom = Math.log2(
      Math.min(innerWidth, innerHeight) / Math.max(worldSize, 1),
    );
    this.homeState = {
      target: [0, 0, 0],
      zoom: fitZoom - 0.2,
      rotationX: 25,
      rotationOrbit: 0,
    };
    this.viewState = { ...this.homeState };
  }

  /** turntable:orbitAxis Y 即禁 roll;正交开关在此生效。 */
  view(): OrbitView {
    return new OrbitView({
      id: "orbit",
      orbitAxis: "Y",
      orthographic: this.ortho,
    });
  }

  /** 接收 deck 回调的视图状态；剥离过渡参数和遗留缩放上限，避免
   * 把控制器元数据保存为共享相机状态。 */
  absorb(vs: Record<string, unknown>): void {
    const {
      transitionDuration: _d,
      transitionInterpolator: _i,
      transitionEasing: _e,
      maxZoom: _maxZoom,
      ...clean
    } = vs;
    this.viewState = clean as unknown as OrbitState;
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
      target: pos,
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

  /** `2`:俯视 + 正交投影(2D 保底);再按恢复透视轨道。 */
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
    this.viewState = { ...this.homeState };
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
}
