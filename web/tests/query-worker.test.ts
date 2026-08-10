import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueryDocument } from "../src/query/document";
import type { QueryResult } from "../src/query/engine";
import { MISSING } from "../src/query/value";
import {
  decodeQueryResult,
  encodeQueryResult,
  type QueryWorkerResponse,
} from "../src/query/wire";
import { createQueryWorkerRuntime } from "../src/query/worker-runtime";
import { QueryWorkerClient } from "../src/query/worker-client";
import { SiteRuntimeError } from "../src/site-error";

const query: QueryDocument = {
  schema: "atlas-query-document-v1",
  root: "values",
  parameters: {},
  operators: { values: { kind: "values", columns: ["n"], rows: [[1]] } },
};

const metadata = {
  evidence: [{}],
  columns: {},
  queryDigest: "0".repeat(64),
  releaseId: "test-release",
  coverage: {
    schema: "atlas-coverage-v1" as const,
    atoms: [],
    digest: "1".repeat(64),
  },
  terminalEvidence: [],
};

test("round-trips missing values through the structured-clone wire format", () => {
  const result: QueryResult = {
    ...metadata,
    rows: [{
      entity: {
        kind: "entity",
        owner: "subject",
        ref: "subject:1",
        fields: { score: MISSING, values: [1, MISSING, null] },
      },
      absent: MISSING,
    }],
    totalMatches: 1,
    visibleMatches: 1,
    hasMore: false,
    stability: "exact",
  };

  assert.deepEqual(decodeQueryResult(encodeQueryResult(result)), result);
});

test("cancels one in-flight request without affecting the worker runtime", async () => {
  const responses: QueryWorkerResponse[] = [];
  let observedAbort = false;
  const runtime = createQueryWorkerRuntime(
    async (_request, signal) =>
      await new Promise<QueryResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason);
        });
      }),
    (response) => responses.push(response),
  );

  runtime.receive({
    schema: "atlas-query-wire-v1",
    type: "execute",
    requestId: "q1",
    document: query,
    parameters: {},
    pageSize: 20,
    offset: 0,
  });
  runtime.receive({
    schema: "atlas-query-wire-v1",
    type: "cancel",
    requestId: "q1",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(observedAbort, true);
  assert.deepEqual(responses, [{
    schema: "atlas-query-wire-v1",
    type: "error",
    requestId: "q1",
    code: "CANCELLED",
    message: "查询已取消",
  }]);
});

test("preserves actionable site failure categories at the worker boundary", async () => {
  const responses: QueryWorkerResponse[] = [];
  const runtime = createQueryWorkerRuntime(
    async () => {
      throw new SiteRuntimeError("DATA_INTEGRITY", "站点数据校验失败");
    },
    (response) => responses.push(response),
  );

  runtime.receive({
    schema: "atlas-query-wire-v1",
    type: "execute",
    requestId: "q-data",
    document: query,
    parameters: {},
    pageSize: 20,
    offset: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(responses, [{
    schema: "atlas-query-wire-v1",
    type: "error",
    requestId: "q-data",
    code: "DATA_INTEGRITY",
    message: "站点数据校验失败",
  }]);
});

test("client correlates results and forwards cancellation", async () => {
  const sent: unknown[] = [];
  let listener: ((event: MessageEvent<unknown>) => void) | undefined;
  const port = {
    postMessage(message: unknown) {
      sent.push(message);
    },
    addEventListener(_type: "message", next: (event: MessageEvent<unknown>) => void) {
      listener = next;
    },
    removeEventListener() {},
  };
  const client = new QueryWorkerClient(port);
  const pending = client.execute(query, {}, { pageSize: 20 });
  listener?.({
    data: {
      schema: "atlas-query-wire-v1",
      type: "result",
      requestId: "q1",
      result: encodeQueryResult({
        ...metadata,
        rows: [{ n: 1 }],
        totalMatches: 1,
        visibleMatches: 1,
        hasMore: false,
        stability: "exact",
      }),
    },
  } as MessageEvent<unknown>);
  assert.deepEqual(await pending, {
    ...metadata,
    rows: [{ n: 1 }],
    totalMatches: 1,
    visibleMatches: 1,
    hasMore: false,
    stability: "exact",
  });

  const controller = new AbortController();
  const cancelled = client.execute(query, {}, { pageSize: 20, signal: controller.signal });
  controller.abort(new DOMException("stale", "AbortError"));
  await assert.rejects(cancelled, /stale/);
  assert.deepEqual(sent.at(-1), {
    schema: "atlas-query-wire-v1",
    type: "cancel",
    requestId: "q2",
  });
  client.dispose();
});

test("hard cancellation terminates a busy worker and recreates it", async () => {
  const ports: Array<{
    sent: unknown[];
    terminated: boolean;
    postMessage(message: unknown): void;
    addEventListener(): void;
    removeEventListener(): void;
    terminate(): void;
  }> = [];
  const client = new QueryWorkerClient(() => {
    const port = {
      sent: [] as unknown[],
      terminated: false,
      postMessage(message: unknown) { this.sent.push(message); },
      addEventListener() {},
      removeEventListener() {},
      terminate() { this.terminated = true; },
    };
    ports.push(port);
    return port;
  });
  const controller = new AbortController();
  const pending = client.execute(query, {}, { pageSize: 20, signal: controller.signal });

  controller.abort(new DOMException("stop now", "AbortError"));

  await assert.rejects(pending, /stop now/);
  assert.equal(ports[0]?.terminated, true);
  assert.equal(ports.length, 2);
  assert.equal((ports[0]?.sent.at(-1) as { type?: string })?.type, "execute");
  const replacement = client.execute(query, {}, { pageSize: 20 });
  assert.equal((ports[1]?.sent.at(-1) as { type?: string })?.type, "execute");
  client.dispose();
  await assert.rejects(replacement, /disposed/);
});
