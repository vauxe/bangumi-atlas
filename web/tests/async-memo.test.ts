import assert from "node:assert/strict";
import { test } from "node:test";

import { AsyncMemo, SharedAbortableMemo } from "../src/async-memo";

test("shares an in-flight load and caches its completed value", async () => {
  const memo = new AsyncMemo<string, number>();
  let calls = 0;
  let release: ((value: number) => void) | undefined;
  const load = (): Promise<number> => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };

  const first = memo.get("bucket", load);
  const second = memo.get("bucket", load);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);

  release?.(42);
  assert.equal(await first, 42);
  assert.equal(await memo.get("bucket", load), 42);
  assert.equal(calls, 1);
});

test("evicts rejected loads so a later request can retry", async () => {
  const memo = new AsyncMemo<string, number>();
  await assert.rejects(memo.get("bucket", async () => Promise.reject("no")));

  assert.equal(await memo.get("bucket", async () => 7), 7);
});

test("aborts shared work only after its last subscriber leaves", async () => {
  const memo = new SharedAbortableMemo<string, number>();
  let calls = 0;
  let resolve: ((value: number) => void) | undefined;
  let workSignal: AbortSignal | undefined;
  const load = (signal: AbortSignal): Promise<number> => {
    calls++;
    workSignal = signal;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = memo.get("bucket", load, firstController.signal);
  const second = memo.get("bucket", load, secondController.signal);

  firstController.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(workSignal?.aborted, false);

  resolve?.(42);
  assert.equal(await second, 42);
  assert.equal(calls, 1);
});

test("shares only in-flight abortable work", async () => {
  const memo = new SharedAbortableMemo<string, number>();
  let calls = 0;
  const load = async (): Promise<number> => ++calls;

  assert.equal(await memo.get("bucket", load), 1);
  assert.equal(await memo.get("bucket", load), 2);
});

test("cancels orphaned work and retries it", async () => {
  const memo = new SharedAbortableMemo<string, number>();
  let calls = 0;
  const load = (signal: AbortSignal): Promise<number> => {
    calls++;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  const controller = new AbortController();
  const first = memo.get("bucket", load, controller.signal);
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });

  const second = memo.get("bucket", async () => 7);
  assert.equal(await second, 7);
  assert.equal(calls, 1);
});
