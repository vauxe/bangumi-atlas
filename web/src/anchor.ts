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
 * 无候选返回 -1。
 *
 * 两段式选择:先取锥内沿射线最近的命中深度 t_min,再在近深度组
 * (t ≤ 2·t_min)内按夹角选最优。纯夹角度量不看远近——正对射线
 * 但位于眼前目标身后很远的节点会胜出,把缩放枢轴拽穿目标飞向
 * 深处("瞬移到节点背后")。accept 按夹角升序惰性调用,通常
 * 只判定一两个候选。 */
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
  const cut2 = tanCutoff * tanCutoff;

  // 滚轮换锚不带 accept。先求最终最近深度，再在该深度组内直接取
  // 最小夹角，避免为宽视锥内数十万候选分配元组并 O(k log k) 排序。
  // 第二次线性扫描读取同一紧凑 TypedArray，峰值额外内存保持 O(1)。
  if (!accept) {
    let tMin = Infinity;
    for (let i = 0; i < count; i++) {
      const vx = (positions[i * 3] ?? 0) - ox;
      const vy = (positions[i * 3 + 1] ?? 0) - oy;
      const vz = (positions[i * 3 + 2] ?? 0) - oz;
      const t = vx * ux + vy * uy + vz * uz;
      if (t <= 1e-9) continue;
      const score = (vx * vx + vy * vy + vz * vz - t * t) / (t * t);
      if (score < cut2 && t < tMin) tMin = t;
    }
    const tCap = tMin * 2;
    let bestScore = Infinity;
    let bestRank = -1;
    for (let i = 0; i < count; i++) {
      const vx = (positions[i * 3] ?? 0) - ox;
      const vy = (positions[i * 3 + 1] ?? 0) - oy;
      const vz = (positions[i * 3 + 2] ?? 0) - oz;
      const t = vx * ux + vy * uy + vz * uz;
      if (t <= 1e-9 || t > tCap) continue;
      const score = (vx * vx + vy * vy + vz * vz - t * t) / (t * t);
      // 严格小于同时保留原稳定排序在等分候选上的低 rank 语义。
      if (score < cut2 && score < bestScore) {
        bestScore = score;
        bestRank = i;
      }
    }
    return bestRank;
  }

  // [t, 夹角平方, rank]
  const candidates: [number, number, number][] = [];
  let tMin = Infinity;
  for (let i = 0; i < count; i++) {
    const vx = (positions[i * 3] ?? 0) - ox;
    const vy = (positions[i * 3 + 1] ?? 0) - oy;
    const vz = (positions[i * 3 + 2] ?? 0) - oz;
    const t = vx * ux + vy * uy + vz * uz;
    if (t <= 1e-9) continue; // 相机侧后方
    const score = (vx * vx + vy * vy + vz * vz - t * t) / (t * t);
    if (score >= cut2) continue;
    candidates.push([t, score, i]);
    if (t < tMin) tMin = t;
  }
  const tCap = tMin * 2;
  candidates.sort((a, b) => a[1] - b[1]);
  for (const [t, , rank] of candidates) {
    if (t > tCap) continue;
    if (accept && !accept(rank)) continue;
    return rank;
  }
  return -1;
}
