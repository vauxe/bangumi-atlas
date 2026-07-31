/** URL 即状态:#c=…&n=…&r=…&y=…&m=…&l=…。
 * n = 全局键(稳定身份),r = rank(深链未流式覆盖时 Range 点查落点)。 */

import { state } from "./store";
import type { OrbitState } from "./camera";

export interface UrlState {
  view: Partial<OrbitState> | null;
  key: number | null;
  rank: number | null;
  /** 俯视正交开关(相机位姿的一部分,§5"每个状态可分享")。 */
  ortho: boolean;
}

export function encode(
  vs: OrbitState,
  key: number | null,
  rank: number | null,
  ortho = false,
): string {
  const f = state.filters;
  const parts = [
    `c=${[...vs.target, vs.zoom, vs.rotationX, vs.rotationOrbit]
      .map((v) => Number(v).toFixed(2))
      .join(",")}`,
  ];
  if (ortho) parts.push("o=1");
  if (key !== null) parts.push(`n=${key}`);
  if (rank !== null) parts.push(`r=${rank}`);
  if (f.yearMin > 0 || f.yearMax < 9999)
    parts.push(`y=${f.yearMin}-${f.yearMax}`);
  if (f.media.size) parts.push(`m=${[...f.media].join(",")}`);
  if (f.scoreMin > 0) parts.push(`s=${f.scoreMin}`);
  if (f.tags.size) parts.push(`t=${[...f.tags].join(",")}`);
  if (f.colorBy !== "type") parts.push(`l=${f.colorBy}`);
  return "#" + parts.join("&");
}

/** 解码并把过滤器写回 store(缺省参数恢复默认值,保证后退可逆)。 */
export function decode(hash: string): UrlState {
  const out: UrlState = { view: null, key: null, rank: null, ortho: false };
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  out.ortho = params.get("o") === "1";
  const c = params.get("c");
  if (c) {
    const v = c.split(",").map(Number);
    if (v.length === 6 && v.every((x) => Number.isFinite(x))) {
      out.view = {
        target: [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0],
        zoom: v[3] ?? 0,
        rotationX: v[4] ?? 25,
        rotationOrbit: v[5] ?? 0,
      };
    }
  }
  const n = params.get("n");
  if (n && /^\d+$/.test(n)) out.key = Number(n);
  const r = params.get("r");
  if (r && /^\d+$/.test(r)) out.rank = Number(r);
  const y = params.get("y");
  if (y) {
    const [a, b] = y.split("-").map(Number);
    state.filters.yearMin = a || 0;
    state.filters.yearMax = b || 9999;
  } else {
    state.filters.yearMin = 0;
    state.filters.yearMax = 9999;
  }
  const m = params.get("m");
  state.filters.media = m
    ? new Set(m.split(",").map(Number))
    : new Set();
  const s = params.get("s");
  state.filters.scoreMin = s && /^\d+$/.test(s) ? Number(s) : 0;
  const tg = params.get("t");
  state.filters.tags = tg
    ? new Set(tg.split(",").map(Number).filter((b) => b >= 0 && b < 32))
    : new Set();
  state.filters.colorBy =
    params.get("l") === "community" ? "community" : "type";
  return out;
}
