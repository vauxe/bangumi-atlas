/** 工作集标签:默认无任何标签;选中节点后为工作集(选中节点 +
 * 相连节点)显示节点名与关系名,不设 zoom 门槛——远距离也可读
 * (像素字号)。节点名亮白、悬于节点上方;关系名品红、位于边中点。
 * 定向关系的文案带 "← " 前缀(指向选中节点),与边的亮度梯度
 * (亮端 = 目标端)互证。
 * 去重叠在 CPU 端按优先级贪心完成(选中名 > 邻居名 > 关系名);
 * GPU CollisionFilterExtension 对"数据后到"的图层会拿旧碰撞图
 * 整批误剔(实测多种失效形态),工作集标签量级小,不需要它。
 * SDF 字符集由当前显示的字符串即时生成;缺失的节点名由调用方
 * 批量补载后重绘。 */

import { TextLayer } from "@deck.gl/layers";
import { FOCUS_ZOOM } from "./camera";

// 圆体优先(macOS 圆体 / Windows 幼圆);canvas font 字符串不能含
// ui-rounded 这类新 CSS 泛型,否则整串被忽略
const LABEL_FONT = '"Yuanti SC", "YouYuan", "PingFang SC", sans-serif';
const LABEL_DEPTH = {
  depthWriteEnabled: false,
  depthCompare: "always",
} as const;
// 基准字号(聚焦层级下的屏显像素);字号随 zoom 缩放:
// 远处钳制在基准值保持可读,拉近时随节点一起放大,封顶 2 倍——
// 固定像素字号会在节点放大时显得"越缩放字越小"。
// 注意必须用像素单位 + CPU 逐帧补偿 clip.w:deck 的文字偏移
// 仍发生在透视除法之前；朝其他节点缩放时，工作集会落到新枢轴
// 平面之后，不补偿会随自身深度变小。
const NODE_NAME_SIZE = 14;
const EDGE_NAME_SIZE = 12;

export interface WorkingMember {
  rank: number;
  pos: [number, number, number];
}

export interface WorkingEdge {
  a: [number, number, number];
  b: [number, number, number];
  label: string;
}

/** 世界坐标 → 屏幕像素;视口未就绪时返回 null。 */
export type ScreenProjector = (
  pos: [number, number, number],
) => [number, number] | null;

export interface PerspectiveViewport {
  focalDistance: number;
  viewProjectionMatrix: readonly number[];
}

const clipW = (
  pos: readonly [number, number, number],
  viewport: PerspectiveViewport,
): number => {
  const m = viewport.viewProjectionMatrix;
  return (
    (m[3] ?? 0) * pos[0] +
    (m[7] ?? 0) * pos[1] +
    (m[11] ?? 0) * pos[2] +
    (m[15] ?? 0)
  );
};

/** TextLayer 的像素偏移最终会除以 clip.w；按同一投影矩阵反向补偿，
 * 使标签移到枢轴平面前后时仍保持目标 CSS 像素字号。 */
export function perspectiveTextSize(
  pos: readonly [number, number, number],
  screenPixels: number,
  viewport: PerspectiveViewport,
): number {
  const w = clipW(pos, viewport);
  const focal = viewport.focalDistance;
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(focal) || focal <= 0)
    return screenPixels;
  return (screenPixels * w) / focal;
}

interface LabelItem {
  position: [number, number, number];
  text: string;
  /** 去重叠顺位:选中节点名 > 邻居名 > 关系名。 */
  priority: number;
}

export interface WorkingLabelData {
  nodes: LabelItem[];
  edges: LabelItem[];
  charset: string;
  /** 名字未就绪的 rank,调用方补载后重绘。 */
  missing: number[];
}

/** 纯数据装配:节点名(可缺)、关系名(边中点)与即时字符集。 */
export function buildWorkingLabels(
  members: WorkingMember[],
  edges: WorkingEdge[],
  nameOf: (rank: number) => string | null,
): WorkingLabelData {
  const nodes: LabelItem[] = [];
  const missing: number[] = [];
  members.forEach((m, i) => {
    const text = nameOf(m.rank);
    // members[0] 是选中节点:任何拥挤程度下它的名字都保留
    if (text)
      nodes.push({ position: m.pos, text, priority: i === 0 ? 100 : 10 });
    else missing.push(m.rank);
  });
  const edgeItems: LabelItem[] = [];
  for (const e of edges) {
    if (!e.label) continue;
    edgeItems.push({
      position: [
        (e.a[0] + e.b[0]) / 2,
        (e.a[1] + e.b[1]) / 2,
        (e.a[2] + e.b[2]) / 2,
      ],
      text: e.label,
      priority: 0,
    });
  }
  const chars = new Set("←▶0123456789…");
  for (const n of nodes) for (const ch of n.text) chars.add(ch);
  for (const e of edgeItems) for (const ch of e.text) chars.add(ch);
  return {
    nodes,
    edges: edgeItems,
    charset: [...chars].join(""),
    missing,
  };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 估算文本像素宽:CJK ≈ 字号,拉丁/数字 ≈ 0.55 字号。 */
const estWidth = (text: string, size: number): number => {
  let w = 0;
  for (const ch of text)
    w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? size : size * 0.55;
  return w;
};

/** 屏幕空间贪心去重叠:按 priority 降序占格,与已占格重叠则剔除。 */
export function declutter(
  items: LabelItem[],
  project: ScreenProjector,
  size: number,
  occupied: Box[],
): LabelItem[] {
  const kept: LabelItem[] = [];
  for (const it of [...items].sort((a, b) => b.priority - a.priority)) {
    const p = project(it.position);
    if (!p) continue;
    const w = estWidth(it.text, size);
    const h = size * 1.4;
    const box = { x: p[0] - w / 2, y: p[1] - h, w, h: h * 2 };
    if (occupied.some((o) => overlaps(o, box))) continue;
    occupied.push(box);
    kept.push(it);
  }
  return kept;
}

/** 工作集的两个文本图层(节点名 / 关系名),已在 CPU 端去重叠。 */
export function workingLabelLayers(
  members: WorkingMember[],
  edges: WorkingEdge[],
  nameOf: (rank: number) => string | null,
  project: ScreenProjector,
  viewport: PerspectiveViewport,
  zoom: number,
): { layers: unknown[]; missing: number[] } {
  const data = buildWorkingLabels(members, edges, nameOf);
  // 当前实际屏显字号(去重叠的占格与名字-节点间距都按它算)
  const scale = 2 ** (zoom - FOCUS_ZOOM);
  const clampPx = (base: number): number =>
    Math.min(base * 2, Math.max(base, base * scale));
  const nodePx = clampPx(NODE_NAME_SIZE);
  const edgePx = clampPx(EDGE_NAME_SIZE);
  // 名字悬于节点光晕之上:间距随节点屏显半径自适应
  const nodeRadiusPx = Math.max(7, 9 * scale);
  const offsetY = -Math.min(48, Math.round(nodeRadiusPx) + 9);
  const occupied: Box[] = [];
  const nodes = declutter(data.nodes, project, nodePx, occupied);
  const edgeNames = declutter(data.edges, project, edgePx, occupied);
  // 方向箭头:位于边 72% 处、指向关系目标端("← " = 指向选中侧),
  // 屏幕空间角度逐帧由投影推出,随相机旋转保持朝向正确
  const arrows: { position: [number, number, number]; angle: number }[] = [];
  for (const e of edges) {
    if (!e.label) continue; // 无方向语义(对比扇)不画箭头
    const toSelf = e.label.startsWith("← ");
    const from = toSelf ? e.b : e.a;
    const to = toSelf ? e.a : e.b;
    const pf = project(from);
    const pt = project(to);
    if (!pf || !pt) continue;
    const dx = pt[0] - pf[0];
    const dy = pt[1] - pf[1];
    if (Math.hypot(dx, dy) < 36) continue; // 屏显太短,箭头徒增噪声
    // 透视线跨过相机平面时，端点投影弦与局部方向恰好相反。
    const direction = clipW(from, viewport) * clipW(to, viewport) < 0 ? -1 : 1;
    const k = 0.72;
    arrows.push({
      position: [
        from[0] + (to[0] - from[0]) * k,
        from[1] + (to[1] - from[1]) * k,
        from[2] + (to[2] - from[2]) * k,
      ],
      angle: (Math.atan2(-dy * direction, dx * direction) * 180) / Math.PI,
    });
  }
  const layers: unknown[] = [];
  const common = {
    characterSet: data.charset,
    fontFamily: LABEL_FONT,
    sizeUnits: "pixels" as const,
    // 32px 源字号 SDF:工作集字符集很小,图集远低于 GPU 纹理上限
    fontSettings: { sdf: true, fontSize: 32, buffer: 4 },
    billboard: true,
    parameters: LABEL_DEPTH,
    getPosition: (d: LabelItem) => d.position,
    getText: (d: LabelItem) => d.text,
  };
  if (nodes.length) {
    layers.push(
      new TextLayer({
        ...common,
        id: "ws-node-names",
        data: nodes,
        getSize: (d: LabelItem) =>
          perspectiveTextSize(d.position, nodePx, viewport),
        getPixelOffset: [0, offsetY],
        getColor: [240, 242, 246, 245],
        outlineWidth: 2,
        outlineColor: [11, 14, 26, 235],
      }),
    );
  }
  if (edgeNames.length) {
    layers.push(
      new TextLayer({
        ...common,
        id: "ws-edge-names",
        data: edgeNames,
        getSize: (d: LabelItem) =>
          perspectiveTextSize(d.position, edgePx, viewport),
        getPixelOffset: [0, 0],
        getColor: [242, 160, 205, 235],
        outlineWidth: 2,
        outlineColor: [11, 14, 26, 220],
      }),
    );
  }
  if (arrows.length) {
    layers.push(
      new TextLayer({
        ...common,
        id: "ws-edge-arrows",
        data: arrows,
        getPosition: (d: { position: [number, number, number] }) =>
          d.position,
        getText: () => "▶",
        getSize: (d: { position: [number, number, number] }) =>
          perspectiveTextSize(
            d.position,
            Math.min(18, Math.max(10, 10 * scale)),
            viewport,
          ),
        getAngle: (d: { angle: number }) => d.angle,
        getColor: [242, 160, 205, 230],
        outlineWidth: 1,
        outlineColor: [11, 14, 26, 200],
      }),
    );
  }
  return { layers, missing: data.missing };
}
