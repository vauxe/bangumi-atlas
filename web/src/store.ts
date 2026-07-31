/** 微型状态 store:单一事实来源 + 订阅。 */

export interface Filters {
  yearMin: number;
  yearMax: number;
  /** 空 = 不过滤;否则仅高亮所选媒介。 */
  media: Set<number>;
  /** 评分下限 ×10(0 = 不过滤);无评分作品在过滤激活时隐藏。 */
  scoreMin: number;
  /** 选中的标签 bit 下标(AND 语义:作品须含全部所选标签)。 */
  tags: Set<number>;
}

export interface State {
  selection: number | null; // rank
  neighbors: number[]; // 工作集邻居 ranks(top-50 已亮)
  /** 与 neighbors 对齐的解码关系 labelId(工作集边 tooltip 用)。 */
  neighborLabels: number[];
  /** 共同关联的另一端(场景从它向邻居画第二扇边)。 */
  compareWith: number | null;
  /** 最短路径链(场景画链式边并抑制默认扇形)。 */
  path: number[];
  /** path 相邻两点间的关系 labelId(链边 tooltip)。 */
  pathLabels: number[];
  filters: Filters;
}

export const state: State = {
  selection: null,
  neighbors: [],
  neighborLabels: [],
  compareWith: null,
  path: [],
  pathLabels: [],
  filters: {
    yearMin: 0,
    yearMax: 9999,
    media: new Set(),
    scoreMin: 0,
    tags: new Set(),
  },
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): void {
  listeners.add(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}
