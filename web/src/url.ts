/** URL 只写视图状态与一个规范 QueryBundle。
 * n = 全局键(稳定身份),r = rank(深链未流式覆盖时 Range 点查落点)。 */

import { state } from "./store";
import type { OrbitState } from "./camera";
import { decodeBundle, encodeShareableBundle } from "./query/bundle-url";

export interface UrlState {
  view: Partial<OrbitState> | null;
  key: number | null;
  rank: number | null;
  /** 俯视正交开关是可分享相机状态的一部分。 */
  ortho: boolean;
}

export function encode(
  vs: OrbitState,
  key: number | null,
  rank: number | null,
  ortho = false,
): string {
  const parts = [
    `c=${[...vs.target, vs.zoom, vs.rotationX, vs.rotationOrbit]
      .map((v) => Number(v).toFixed(2))
      .join(",")}`,
  ];
  if (ortho) parts.push("o=1");
  if (key !== null) parts.push(`n=${key}`);
  if (rank !== null) parts.push(`r=${rank}`);
  if (state.queryBundle) {
    const bundle = encodeShareableBundle(state.queryBundle);
    if (bundle) parts.push(`qb=${bundle}`);
  }
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

/** 解码当前状态；未知字段不会进入应用状态。 */
export function decode(hash: string): UrlState {
  const out: UrlState = {
    view: null,
    key: null,
    rank: null,
    ortho: false,
  };
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  state.queryBundle = decodeBundle(params.get("qb") ?? "");
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
  return out;
}
