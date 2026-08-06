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

  clear(): void {
    this.entries.clear();
  }
}

interface SharedEntry<V> {
  promise: Promise<V>;
  controller: AbortController;
  subscribers: number;
  keepAlive: boolean;
}

/** Share in-flight work while it has users; abort it once nobody needs it. */
export class SharedAbortableMemo<K, V> {
  private entries = new Map<K, SharedEntry<V>>();

  get(
    key: K,
    load: (signal: AbortSignal) => Promise<V>,
    signal?: AbortSignal,
  ): Promise<V> {
    signal?.throwIfAborted();
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = {
        promise: Promise.resolve(undefined as V),
        controller,
        subscribers: 0,
        keepAlive: false,
      };
      const current = entry;
      let request: Promise<V>;
      try {
        request = load(controller.signal);
      } catch (error) {
        request = Promise.reject(error);
      }
      current.promise = request.finally(() => {
        if (this.entries.get(key) === current) this.entries.delete(key);
      });
      this.entries.set(key, current);
    }

    if (!signal) {
      entry.keepAlive = true;
      return entry.promise;
    }
    entry.subscribers++;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        signal.removeEventListener("abort", abort);
        entry.subscribers--;
        if (
          entry.subscribers === 0 &&
          !entry.keepAlive &&
          this.entries.get(key) === entry
        ) {
          this.entries.delete(key);
          entry.controller.abort();
        }
      };
      const abort = (): void => {
        release();
        reject(
          signal.reason ??
            new DOMException("The operation was aborted", "AbortError"),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      void entry.promise.then(
        (value) => {
          release();
          resolve(value);
        },
        (error: unknown) => {
          release();
          reject(error);
        },
      );
    });
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.controller.abort();
    this.entries.clear();
  }
}
