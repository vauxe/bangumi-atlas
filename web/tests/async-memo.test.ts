import assert from "node:assert/strict";
import { test } from "node:test";

import { AsyncMemo } from "../src/async-memo";

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
