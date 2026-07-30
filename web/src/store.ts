/** 微型状态 store:单一事实来源 + 订阅。 */

export interface Filters {
  yearMin: number;
  yearMax: number;
  /** 空 = 不过滤;否则仅高亮所选媒介。 */
  media: Set<number>;
  nsfw: boolean;
  colorBy: "type" | "community";
}

export interface State {
  selection: number | null; // rank
  neighbors: number[]; // 工作集邻居 ranks(top-50 已亮)
  filters: Filters;
}

export const state: State = {
  selection: null,
  neighbors: [],
  filters: {
    yearMin: 0,
    yearMax: 9999,
    media: new Set(),
    nsfw: false,
    colorBy: "type",
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
