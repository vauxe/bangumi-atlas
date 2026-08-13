import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLazyDrawerRuntime,
  type DrawerRuntime,
} from "../src/lazy-drawer";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeDrawer(events: string[]): DrawerRuntime {
  return {
    show: async (rank, key, episodeId) => {
      events.push(`show:${rank}:${key}:${episodeId ?? ""}`);
    },
    hide: () => events.push("hide"),
  };
}

test("coalesces drawer preparation and only shows the latest selection", async () => {
  const loaded = deferred<DrawerRuntime>();
  const events: string[] = [];
  let loadCount = 0;
  const drawer = createLazyDrawerRuntime(() => {
    loadCount++;
    return loaded.promise;
  });

  const first = drawer.show(1, 101);
  const second = drawer.show(2, 202, 9);
  assert.equal(loadCount, 1);

  loaded.resolve(fakeDrawer(events));
  await Promise.all([first, second]);

  assert.deepEqual(events, ["show:2:202:9"]);
});

test("does not open a drawer after the selection was hidden during loading", async () => {
  const loaded = deferred<DrawerRuntime>();
  const events: string[] = [];
  const drawer = createLazyDrawerRuntime(() => loaded.promise);

  const showing = drawer.show(3, 303);
  drawer.hide();
  loaded.resolve(fakeDrawer(events));
  await showing;

  assert.deepEqual(events, []);
});

test("retries a failed drawer module load", async () => {
  const events: string[] = [];
  let attempt = 0;
  const drawer = createLazyDrawerRuntime(async () => {
    attempt++;
    if (attempt === 1) throw new Error("chunk unavailable");
    return fakeDrawer(events);
  });

  await assert.rejects(drawer.show(4, 404), /chunk unavailable/);
  await drawer.show(5, 505);
  drawer.hide();

  assert.equal(attempt, 2);
  assert.deepEqual(events, ["show:5:505:", "hide"]);
});
