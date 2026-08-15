import type { QueryBundle } from "./query/bundle";

export interface PinnedWorkingSet {
  ranks: number[];
  labels: string[];
}

export interface State {
  selection: number | null; // rank
  /** 与 selection 配对的稳定全局身份;绝不从未完成的流式缓冲反推。 */
  selectionKey: number | null;
  /** 用户显式保留的根节点;与当前详情选择分离,仅在本次页面会话保留。 */
  pinnedSelections: Set<number>;
  /** 每个固定根节点提交时的完整一跳边扇；按根节点归属以支持逐个撤销。 */
  pinnedWorkingSets: Map<number, PinnedWorkingSet>;
  neighbors: number[]; // 当前选中节点的全部可解析关系对端 ranks
  /** 与 neighbors 对齐的解码关系显示文本(工作集边 tooltip 用);
   * 反向文案与颜色是 Scene Model 显示规则,不是数据事实。 */
  neighborLabels: string[];
  /** 当前完整答案中能映射到 3D Canvas 的去重实体 ranks。 */
  queryResultRanks: Uint32Array;
  /** 页面唯一的权威查询。Canvas 相机和实体选择只是视图状态。 */
  queryBundle: QueryBundle | null;
}

export const state: State = {
  selection: null,
  selectionKey: null,
  pinnedSelections: new Set(),
  pinnedWorkingSets: new Map(),
  neighbors: [],
  neighborLabels: [],
  queryResultRanks: new Uint32Array(),
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

/** 新选择与其瞬态关系扇必须原子切换，避免任何渲染读到“新根 + 旧边”。 */
export function beginSelection(rank: number, key: number | null): void {
  state.selection = rank;
  state.selectionKey = key;
  state.neighbors = [];
  state.neighborLabels = [];
  notify();
}

/** 图钉把当前完整一跳关系提交为独立的会话状态；切换后立即重绘。 */
export function togglePinnedSelection(rank: number): boolean {
  const pinned = !state.pinnedSelections.has(rank);
  const selections = new Set(state.pinnedSelections);
  const workingSets = new Map(state.pinnedWorkingSets);
  if (pinned) {
    selections.add(rank);
    workingSets.set(rank, {
      ranks: state.selection === rank ? [...state.neighbors] : [],
      labels: state.selection === rank ? [...state.neighborLabels] : [],
    });
  } else {
    selections.delete(rank);
    workingSets.delete(rank);
  }
  state.pinnedSelections = selections;
  state.pinnedWorkingSets = workingSets;
  notify();
  return pinned;
}

/** 单个撤销只移除该根节点提交的边扇，共享节点仍可由其他边扇保留。 */
export function removePinnedSelection(rank: number): boolean {
  if (!state.pinnedSelections.has(rank)) return false;
  state.pinnedSelections = new Set(state.pinnedSelections);
  state.pinnedSelections.delete(rank);
  state.pinnedWorkingSets = new Map(state.pinnedWorkingSets);
  state.pinnedWorkingSets.delete(rank);
  notify();
  return true;
}

/** 清空固定节点集合不改变当前焦点，避免用户丢失正在查看的上下文。 */
export function clearPinnedSelections(): boolean {
  if (!state.pinnedSelections.size) return false;
  state.pinnedSelections = new Set();
  state.pinnedWorkingSets = new Map();
  notify();
  return true;
}
