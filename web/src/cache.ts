/** 按解码负载计权的 LRU。并发合并由 AsyncMemo 负责;请求完成后
 * 条目只居于此,未用额度不跨族借用(每族一个实例)。 */
export class WeightedLru<K, V> {
  private entries = new Map<K, { value: V; weight: number }>();
  private used = 0;

  constructor(private budget: number) {}

  setBudget(budget: number): void {
    this.budget = budget;
    this.evict();
  }

  get(key: K): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    // Map 迭代序即插入序;删后重插实现 LRU 提升
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V, weight: number): void {
    const prev = this.entries.get(key);
    if (prev) {
      this.used -= prev.weight;
      this.entries.delete(key);
    }
    this.entries.set(key, { value, weight });
    this.used += weight;
    this.evict();
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.used -= entry.weight;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.used <= this.budget) break;
      // 至少保留最新条目,否则超预算的单个成员会被立即丢弃
      if (this.entries.size === 1) break;
      this.entries.delete(key);
      this.used -= entry.weight;
    }
  }
}
