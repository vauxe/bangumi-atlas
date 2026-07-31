/** Promise-aware memoization: concurrent callers share work; failures retry. */
export class AsyncMemo<K, V> {
  private entries = new Map<K, Promise<V>>();

  get(key: K, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit) return hit;

    let request: Promise<V>;
    try {
      request = load();
    } catch (error) {
      request = Promise.reject(error);
    }
    const retained = request.catch((error: unknown) => {
      if (this.entries.get(key) === retained) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, retained);
    return retained;
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
