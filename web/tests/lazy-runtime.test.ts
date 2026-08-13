import assert from "node:assert/strict";
import { test } from "node:test";

import { createLazyRuntime } from "../src/lazy-runtime";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("prepares a lazy runtime without installing it", async () => {
  const prepared = deferred<string>();
  let prepareCount = 0;
  let installCount = 0;
  const lazy = createLazyRuntime({
    prepare: () => {
      prepareCount++;
      return prepared.promise;
    },
    install: (value) => {
      installCount++;
      return { value, focus() {} };
    },
  });

  const first = lazy.prepare();
  const second = lazy.prepare();
  assert.equal(prepareCount, 1);
  assert.equal(installCount, 0);

  prepared.resolve("runtime module");
  assert.equal(await first, "runtime module");
  assert.equal(await second, "runtime module");
  assert.equal(installCount, 0);
});

test("coalesces activation and replays a pending focus request", async () => {
  const prepared = deferred<string>();
  let installCount = 0;
  let focusCount = 0;
  const events: string[] = [];
  const lazy = createLazyRuntime({
    prepare: () => prepared.promise,
    install: async (value) => {
      installCount++;
      return {
        value,
        focus: () => focusCount++,
      };
    },
    onActivating: () => events.push("activating"),
    onReady: () => events.push("ready"),
  });

  const first = lazy.activate();
  const second = lazy.activate({ focus: true });
  prepared.resolve("runtime module");

  assert.strictEqual(await first, await second);
  assert.equal(installCount, 1);
  assert.equal(focusCount, 1);
  assert.deepEqual(events, ["activating", "ready"]);

  await lazy.activate({ focus: true });
  assert.equal(installCount, 1);
  assert.equal(focusCount, 2);
});

test("allows activation to retry after preparation fails", async () => {
  let attempt = 0;
  let errorCount = 0;
  const lazy = createLazyRuntime({
    prepare: async () => {
      attempt++;
      if (attempt === 1) throw new Error("network unavailable");
      return "runtime module";
    },
    install: (value) => ({ value, focus() {} }),
    onError: () => errorCount++,
  });

  await assert.rejects(lazy.activate(), /network unavailable/);
  assert.equal(errorCount, 1);
  assert.equal((await lazy.activate()).value, "runtime module");
  assert.equal(attempt, 2);
});
