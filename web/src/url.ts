/** URL 只写视图状态与一个规范 QueryBundle。
 * n = 全局键(稳定身份),r = rank(深链未流式覆盖时 Range 点查落点)。 */

import type { OrbitState } from "./camera";
import { decodeBundle, encodeShareableBundle } from "./query/bundle-url";
import { state } from "./store";
import {
  decodeViewUrl,
  encodeViewUrl,
  type UrlState,
} from "./view-url";

export type { UrlState } from "./view-url";

export function encode(
  vs: OrbitState,
  key: number | null,
  rank: number | null,
  ortho = false,
): string {
  const query = state.queryBundle
    ? encodeShareableBundle(state.queryBundle)
    : null;
  return encodeViewUrl(vs, key, rank, ortho, query);
}

/** 解码当前状态；未知字段不会进入应用状态。 */
export function decode(hash: string): UrlState {
  const { query, ...view } = decodeViewUrl(hash);
  state.queryBundle = decodeBundle(query ?? "");
  return view;
}
