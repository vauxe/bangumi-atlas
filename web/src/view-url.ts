/** Lightweight camera/selection URL codec. Query payloads remain opaque here
 * so their schema and compression code stay in the lazy query runtime. */

import type { OrbitState } from "./camera";

export interface UrlState {
  view: Partial<OrbitState> | null;
  key: number | null;
  rank: number | null;
  /** 俯视正交开关是可分享相机状态的一部分。 */
  ortho: boolean;
}

export interface DecodedViewUrl extends UrlState {
  query: string | null;
}

export function encodeViewUrl(
  view: OrbitState,
  key: number | null,
  rank: number | null,
  ortho = false,
  query: string | null = null,
): string {
  const parts = [
    `c=${[...view.target, view.zoom, view.rotationX, view.rotationOrbit]
      .map((value) => Number(value).toFixed(2))
      .join(",")}`,
  ];
  if (ortho) parts.push("o=1");
  if (key !== null) parts.push(`n=${key}`);
  if (rank !== null) parts.push(`r=${rank}`);
  if (query) parts.push(`qb=${encodeURIComponent(query)}`);
  return `#${parts.join("&")}`;
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
  ) return null;
  return value;
}

/** Decode view state without importing or interpreting a QueryBundle. */
export function decodeViewUrl(hash: string): DecodedViewUrl {
  const out: DecodedViewUrl = {
    view: null,
    key: null,
    rank: null,
    ortho: false,
    query: null,
  };
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  out.query = params.get("qb") || null;
  out.ortho = params.get("o") === "1";
  const camera = params.get("c");
  if (camera) {
    const values = camera.split(",").map(Number);
    if (values.length === 6 && values.every((value) => Number.isFinite(value))) {
      out.view = {
        target: [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0],
        zoom: values[3] ?? 0,
        rotationX: values[4] ?? 25,
        rotationOrbit: values[5] ?? 0,
      };
    }
  }
  out.key = uintParam(params, "n", false);
  out.rank = uintParam(params, "r", true);
  return out;
}
