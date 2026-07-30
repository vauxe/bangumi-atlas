/** URL 即状态:#c=…&n=…&y=…&m=…&l=…(NSFW 刻意不入 URL)。 */

import { state } from "./store";
import type { OrbitState } from "./scene";

export interface UrlState {
  view: Partial<OrbitState> | null;
  key: number | null;
}

export function encode(vs: OrbitState, key: number | null): string {
  const f = state.filters;
  const parts = [
    `c=${[...vs.target, vs.zoom, vs.rotationX, vs.rotationOrbit]
      .map((v) => Number(v).toFixed(2))
      .join(",")}`,
  ];
  if (key !== null) parts.push(`n=${key}`);
  if (f.yearMin > 0 || f.yearMax < 9999)
    parts.push(`y=${f.yearMin}-${f.yearMax}`);
  if (f.media.size) parts.push(`m=${[...f.media].join(",")}`);
  if (f.colorBy !== "type") parts.push(`l=${f.colorBy}`);
  return "#" + parts.join("&");
}

export function decode(hash: string): UrlState {
  const out: UrlState = { view: null, key: null };
  const params = new URLSearchParams(hash.replace(/^#/, ""));
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
  const y = params.get("y");
  if (y) {
    const [a, b] = y.split("-").map(Number);
    state.filters.yearMin = a || 0;
    state.filters.yearMax = b || 9999;
  }
  const m = params.get("m");
  if (m) state.filters.media = new Set(m.split(",").map(Number));
  if (params.get("l") === "community") state.filters.colorBy = "community";
  return out;
}
