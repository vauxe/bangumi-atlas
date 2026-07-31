/** 相机模块(§6):turntable 轨道、聚焦飞行、复位、俯视正交保底、
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

const FLY_MS = 400; // §5:双击/行走聚焦飞行 400ms

export class Camera {
  /** 视口恰好装下全图的 zoom(由 bbox 自适应标定)。 */
  readonly fitZoom: number;
  viewState: OrbitState;
  /** 俯视正交保底(§4/§7 四件套之一):true 时投影切正交。 */
  ortho = false;
  private homeState: OrbitState;

  constructor(worldSize: number) {
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
  }

  /** turntable:orbitAxis Y 即禁 roll;正交开关在此生效。 */
  view(): OrbitView {
    return new OrbitView({
      id: "orbit",
      orbitAxis: "Y",
      orthographic: this.ortho,
    });
  }

  /** 接收 deck 回调的视图状态;剥离过渡参数,防止 400ms 过渡
   * 被后续 setView 继承(§5:复位/俯视为"即时")。 */
  absorb(vs: Record<string, unknown>): void {
    const {
      transitionDuration: _d,
      transitionInterpolator: _i,
      transitionEasing: _e,
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
      zoom: zoom ?? Math.max(this.viewState.zoom, this.fitZoom + 4.5),
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

  /** `H`:相机复位(恢复透视)。 */
  home(): OrbitState {
    this.ortho = false;
    this.viewState = { ...this.homeState };
    return this.viewState;
  }

  /** 冷启动背景自转一步(§5);reduced-motion 时由调用方跳过。 */
  orbitStep(deg: number): OrbitState {
    this.viewState = {
      ...this.viewState,
      rotationOrbit: ((this.viewState.rotationOrbit + deg) % 360 + 360) % 360,
    };
    return this.viewState;
  }
}
