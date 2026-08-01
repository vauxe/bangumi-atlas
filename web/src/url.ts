/** URL 即状态:#c=…&n=…&r=…&y=…&m=…&l=…。
 * n = 全局键(稳定身份),r = rank(深链未流式覆盖时 Range 点查落点)。 */

import { state } from "./store";
import type { LinkState } from "./store";
import type { OrbitState } from "./camera";

export interface UrlState {
  view: Partial<OrbitState> | null;
  key: number | null;
  rank: number | null;
  /** 共同关联/路径模式及其稳定起点。旧 URL 缺省为 null。 */
  link: LinkState | null;
  /** 俯视正交开关是可分享相机状态的一部分。 */
  ortho: boolean;
}

export function encode(
  vs: OrbitState,
  key: number | null,
  rank: number | null,
  ortho = false,
  link: LinkState | null = null,
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
  if (key !== null && link !== null) {
    parts.push(`q=${link.kind}`);
    parts.push(`f=${link.fromKey}`);
    parts.push(`fr=${link.fromRank}`);
  }
  if (f.yearMin > 0 || f.yearMax < 9999)
    parts.push(`y=${f.yearMin}-${f.yearMax}`);
  if (f.media.size)
    parts.push(`m=${[...f.media].sort((a, b) => a - b).join(",")}`);
  if (f.scoreMin > 0) parts.push(`s=${f.scoreMin}`);
  if (f.tags.size)
    parts.push(`t=${[...f.tags].sort((a, b) => a - b).join(",")}`);
  return "#" + parts.join("&");
}

function uintParam(
  params: URLSearchParams,
  name: string,
  allowZero: boolean,
): number | null {
  const raw = params.get(name);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value > 0xffff_ffff ||
    (allowZero ? value < 0 : value <= 0)
  )
    return null;
  return value;
}

/** 解码并把过滤器写回 store(缺省参数恢复默认值,保证后退可逆)。 */
export function decode(hash: string): UrlState {
  const out: UrlState = {
    view: null,
    key: null,
    rank: null,
    link: null,
    ortho: false,
  };
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
  out.key = uintParam(params, "n", false);
  out.rank = uintParam(params, "r", true);
  const kind = params.get("q");
  const fromKey = uintParam(params, "f", false);
  const fromRank = uintParam(params, "fr", true);
  if (
    (kind === "common" || kind === "path") &&
    fromKey !== null &&
    fromRank !== null
  )
    out.link = { kind, fromKey, fromRank };
  const y = params.get("y");
  const years = y?.match(/^(\d{1,4})-(\d{1,4})$/);
  const yearMin = Number(years?.[1]);
  const yearMax = Number(years?.[2]);
  if (
    years &&
    Number.isInteger(yearMin) &&
    Number.isInteger(yearMax) &&
    yearMin <= yearMax
  ) {
    state.filters.yearMin = yearMin;
    state.filters.yearMax = yearMax;
  } else {
    state.filters.yearMin = 0;
    state.filters.yearMax = 9999;
  }
  const m = params.get("m");
  const media = new Set([1, 2, 3, 4, 6]);
  state.filters.media = new Set(
    (m ?? "")
      .split(",")
      .map(Number)
      .filter((value) => media.has(value)),
  );
  const score = uintParam(params, "s", true);
  state.filters.scoreMin = score !== null && score <= 100 ? score : 0;
  const tg = params.get("t");
  state.filters.tags = tg
    ? new Set(
        tg
          .split(",")
          .map(Number)
          .filter((bit) => Number.isInteger(bit) && bit >= 0 && bit < 32),
      )
    : new Set();
  return out;
}
