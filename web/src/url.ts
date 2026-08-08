/** URL 只写视图状态与一个规范 QueryBundle。
 * n = 全局键(稳定身份),r = rank(深链未流式覆盖时 Range 点查落点)。 */

import { state } from "./store";
import type { OrbitState } from "./camera";
import { decodeBundle, encodeBundle } from "./query/bundle-url";
import { normalizeBundle, type QueryBundle } from "./query/bundle";
import { normalizeQuery } from "./query/canonical";
import { decodeQuestion } from "./query/question-url";
import { decodeCypherState } from "./query/cypher-url";
import { compileQuestion } from "./query/question";
import { inferCypherParameters } from "./query/parameters";
import { lowerAtlasCypher } from "./query/language";

export interface LinkState {
  kind: "common" | "path";
  fromRank: number;
  fromKey: number;
}

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
): string {
  const parts = [
    `c=${[...vs.target, vs.zoom, vs.rotationX, vs.rotationOrbit]
      .map((v) => Number(v).toFixed(2))
      .join(",")}`,
  ];
  if (ortho) parts.push("o=1");
  if (key !== null) parts.push(`n=${key}`);
  if (rank !== null) parts.push(`r=${rank}`);
  if (state.queryBundle) parts.push(`qb=${encodeBundle(state.queryBundle)}`);
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

/** 解码当前状态；旧查询语法只在这一边界迁移。 */
export function decode(hash: string): UrlState {
  const out: UrlState = {
    view: null,
    key: null,
    rank: null,
    link: null,
    ortho: false,
  };
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  state.queryBundle = decodeBundle(params.get("qb") ?? "") ?? migrateLegacyQuery(params);
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
  return out;
}

function migrateLegacyQuery(params: URLSearchParams): QueryBundle | null {
  const question = decodeQuestion(params.get("aq") ?? "");
  if (question) return normalizeBundle(compileQuestion(question));
  const cypher = decodeCypherState(params.get("ac") ?? "");
  if (!cypher) return null;
  const inferred = inferCypherParameters(JSON.stringify(cypher.parameters));
  return normalizeBundle({
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: {
      results: {
        query: normalizeQuery(
          lowerAtlasCypher(cypher.source, inferred.types),
          inferred.values,
        ),
        answer: { shape: "table", title: "高级查询结果" },
      },
    },
  });
}
