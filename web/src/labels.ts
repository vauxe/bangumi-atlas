/** 标签层:节点标签(碰撞剔除)+ 社区标签(远景),分级淡入。 */

import { CollisionFilterExtension } from "@deck.gl/extensions";
import { TextLayer } from "@deck.gl/layers";
import type { Geometry } from "./types";

export interface LabelData {
  nodes: [number, string][];
  comm: Record<string, [string, number[]]>;
  charset: string;
}

export async function loadLabels(): Promise<LabelData> {
  const res = await fetch("data/labels.json");
  return (await res.json()) as LabelData;
}

export function labelLayers(
  labels: LabelData,
  geo: Geometry,
  zoom: number,
): unknown[] {
  const chars = [...new Set(labels.charset + "0123456789…")].join("");
  const out: unknown[] = [];
  if (zoom < 3.2) {
    const comm = Object.values(labels.comm);
    out.push(
      new TextLayer({
        id: "labels-comm",
        data: comm,
        characterSet: chars,
        getPosition: (d: [string, number[]]) => [
          d[1][0] ?? 0,
          d[1][1] ?? 0,
          d[1][2] ?? 0,
        ],
        getText: (d: [string, number[]]) => d[0],
        getSize: 15,
        sizeUnits: "pixels",
        getColor: [200, 205, 220, 190],
        outlineWidth: 2,
        outlineColor: [11, 14, 26, 220],
        fontSettings: { sdf: true },
        billboard: true,
        extensions: [new CollisionFilterExtension()],
        collisionTestProps: { sizeScale: 2 },
      }),
    );
  }
  if (zoom >= 1.2) {
    // 节点标签:zoom 越深显示越多(按 rank 截断)
    const cap = Math.min(
      labels.nodes.length,
      Math.floor(60 * Math.pow(4, Math.max(0, zoom - 1))),
    );
    out.push(
      new TextLayer({
        id: "labels-nodes",
        data: labels.nodes.slice(0, cap),
        characterSet: chars,
        getPosition: (d: [number, string]) => [
          geo.positions[d[0] * 3] ?? 0,
          geo.positions[d[0] * 3 + 1] ?? 0,
          geo.positions[d[0] * 3 + 2] ?? 0,
        ],
        getText: (d: [number, string]) => d[1],
        getSize: 12,
        sizeUnits: "pixels",
        getPixelOffset: [0, -12],
        getColor: [232, 233, 236, 210],
        outlineWidth: 2,
        outlineColor: [11, 14, 26, 200],
        fontSettings: { sdf: true },
        billboard: true,
        extensions: [new CollisionFilterExtension()],
        collisionTestProps: { sizeScale: 1.6 },
        getCollisionPriority: (d: [number, string]) => -d[0],
      }),
    );
  }
  return out;
}
