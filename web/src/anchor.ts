/** 视线锚点：滚轮放大时的 CPU 后备拾取。
 * GPU 拾取只覆盖光标下几像素；指向星点之间的空隙时，以与光标
 * 射线夹角最小的可见节点为缩放锚点，让放大永远朝真实内容收敛。 */

export interface Ray {
  origin: [number, number, number];
  dir: [number, number, number];
}

/** 由屏幕像素反投影出世界空间射线（近平面原点 + 单位方向）。 */
export function cursorRay(
  viewport: { unproject(xyz: number[]): number[] },
  px: number,
  py: number,
): Ray | null {
  const near = viewport.unproject([px, py, 0]);
  const far = viewport.unproject([px, py, 1]);
  const dx = (far[0] ?? 0) - (near[0] ?? 0);
  const dy = (far[1] ?? 0) - (near[1] ?? 0);
  const dz = (far[2] ?? 0) - (near[2] ?? 0);
  const len = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(len) || len === 0) return null;
  return {
    origin: [near[0] ?? 0, near[1] ?? 0, near[2] ?? 0],
    dir: [dx / len, dy / len, dz / len],
  };
}

/** 射线前方、夹角正切小于 tanCutoff 且夹角最小的节点 rank；
 * 无候选返回 -1。accept 惰性调用：仅当候选优于当前最优时执行，
 * 过滤代价与命中数而非节点数成正比（positions 为百万级 SoA）。 */
export function nearestAlongRay(
  positions: Float32Array,
  count: number,
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  tanCutoff: number,
  accept?: (rank: number) => boolean,
): number {
  const [ox, oy, oz] = origin;
  const [ux, uy, uz] = dir;
  let best = -1;
  let bestScore = tanCutoff * tanCutoff;
  for (let i = 0; i < count; i++) {
    const vx = (positions[i * 3] ?? 0) - ox;
    const vy = (positions[i * 3 + 1] ?? 0) - oy;
    const vz = (positions[i * 3 + 2] ?? 0) - oz;
    const t = vx * ux + vy * uy + vz * uz;
    if (t <= 1e-9) continue; // 相机侧后方
    const score = (vx * vx + vy * vy + vz * vz - t * t) / (t * t);
    if (score >= bestScore) continue;
    if (accept && !accept(i)) continue;
    best = i;
    bestScore = score;
  }
  return best;
}
