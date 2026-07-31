/** 标签层:节点标签(碰撞剔除)+ 社区标签(远景),分级淡入。
 * 节点标签随可见性过滤(年份过滤时不显示被滤节点的名字);
 * SDF 图集由 deck.gl 运行时生成,标签层整体延迟到首帧之后挂载,
 * 不占首屏(§6 取舍,字符集仍由烘焙期离线给定)。
 * data 数组按 (zoom 档位, 过滤版本) 缓存:相机连续移动时不重建、
 * 不触发碰撞检测重算。 */

import { CollisionFilterExtension } from "@deck.gl/extensions";
import { TextLayer } from "@deck.gl/layers";
import { loadPublishedJson } from "./loader";
import type { Geometry } from "./types";

export interface LabelData {
  nodes: [number, string][];
  comm: Record<string, [string, number[]]>;
  charset: string;
}

// 圆体优先(macOS 圆体 / Windows 幼圆);canvas font 字符串不能含
// ui-rounded 这类新 CSS 泛型,否则整串被忽略
const LABEL_FONT = '"Yuanti SC", "YouYuan", "PingFang SC", sans-serif';

/** 由 Scene 持有的缓存槽。 */
export interface LabelCache {
  capBucket?: number;
  version?: number;
  loaded?: number;
  nodesData?: [number, string][];
  commData?: [string, number[]][];
  chars?: string;
}

export function loadLabels(): Promise<LabelData> {
  return loadPublishedJson<LabelData>("labels.json");
}

export function labelLayers(
  labels: LabelData,
  geo: Geometry,
  zoom: number,
  isVisible: (rank: number) => boolean,
  version: number,
  cache: LabelCache,
): unknown[] {
  cache.chars ??= [...new Set(labels.charset + "0123456789…")].join("");
  cache.commData ??= Object.values(labels.comm);
  const out: unknown[] = [];
  if (zoom < 3.2) {
    out.push(
      new TextLayer({
        id: "labels-comm",
        data: cache.commData,
        characterSet: cache.chars,
        getPosition: (d: [string, number[]]) => [
          d[1][0] ?? 0,
          d[1][1] ?? 0,
          d[1][2] ?? 0,
        ],
        getText: (d: [string, number[]]) => d[0],
        getSize: 15,
        fontFamily: LABEL_FONT,
        sizeUnits: "pixels",
        getColor: [200, 205, 220, 190],
        outlineWidth: 2,
        outlineColor: [11, 14, 26, 220],
        // 32px 源字号:4.7k 字的图集控制在 GPU 纹理上限内
        // (64px 默认值实测超 max texture size,字形全变实心块),
        // 屏显 12-15px 的 SDF 质量不受影响
        fontSettings: { sdf: true, fontSize: 32, buffer: 4 },
        billboard: true,
        extensions: [new CollisionFilterExtension()],
        collisionTestProps: { sizeScale: 2 },
      }),
    );
  }
  if (zoom >= 1.2) {
    // 节点标签:zoom 越深显示越多;cap 量化到 2 的幂档位,
    // 同档 + 同过滤版本 + 同加载进度时复用 data 引用
    const rawCap = Math.floor(60 * Math.pow(4, Math.max(0, zoom - 1)));
    const capBucket = Math.min(
      labels.nodes.length,
      Math.pow(2, Math.ceil(Math.log2(Math.max(rawCap, 60)))),
    );
    if (
      cache.capBucket !== capBucket ||
      cache.version !== version ||
      cache.loaded !== geo.loaded ||
      !cache.nodesData
    ) {
      cache.capBucket = capBucket;
      cache.version = version;
      cache.loaded = geo.loaded;
      cache.nodesData = labels.nodes
        .slice(0, capBucket)
        .filter((d) => d[0] < geo.loaded && isVisible(d[0]));
    }
    out.push(
      new TextLayer({
        id: "labels-nodes",
        data: cache.nodesData,
        characterSet: cache.chars,
        getPosition: (d: [number, string]) => [
          geo.positions[d[0] * 3] ?? 0,
          geo.positions[d[0] * 3 + 1] ?? 0,
          geo.positions[d[0] * 3 + 2] ?? 0,
        ],
        getText: (d: [number, string]) => d[1],
        getSize: 12,
        fontFamily: LABEL_FONT,
        sizeUnits: "pixels",
        getPixelOffset: [0, -12],
        getColor: [232, 233, 236, 210],
        outlineWidth: 2,
        outlineColor: [11, 14, 26, 200],
        // 32px 源字号:4.7k 字的图集控制在 GPU 纹理上限内
        // (64px 默认值实测超 max texture size,字形全变实心块),
        // 屏显 12-15px 的 SDF 质量不受影响
        fontSettings: { sdf: true, fontSize: 32, buffer: 4 },
        billboard: true,
        extensions: [new CollisionFilterExtension()],
        collisionTestProps: { sizeScale: 1.6 },
        getCollisionPriority: (d: [number, string]) => -d[0],
      }),
    );
  }
  return out;
}
