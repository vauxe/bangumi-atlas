import type { QueryBundle } from "./query/bundle";

export interface State {
  selection: number | null; // rank
  /** 与 selection 配对的稳定全局身份;绝不从未完成的流式缓冲反推。 */
  selectionKey: number | null;
  neighbors: number[]; // 工作集邻居 ranks(top-50 已亮)
  /** 与 neighbors 对齐的解码关系显示文本(工作集边 tooltip 用);
   * 反向文案与颜色是 Scene Model 显示规则,不是数据事实。 */
  neighborLabels: string[];
  /** 页面唯一的权威查询。Canvas 相机和实体选择只是视图状态。 */
  queryBundle: QueryBundle | null;
}

export const state: State = {
  selection: null,
  selectionKey: null,
  neighbors: [],
  neighborLabels: [],
  queryBundle: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): void {
  listeners.add(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}
