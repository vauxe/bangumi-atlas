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
  schema: "atlas-query-document-v2",
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

test("sends Atlas Query source to the same cancellable worker boundary", async () => {
  const sent: unknown[] = [];
  const port = {
    postMessage(message: unknown) { sent.push(message); },
    addEventListener() {},
    removeEventListener() {},
  };
  const client = new QueryWorkerClient(port);
  const pending = client.executeSource(
    "FIND subject WHERE score >= $min RETURN item AS subject",
    { min: "number" },
    { min: 8 },
    { pageSize: 25 },
  );

  assert.deepEqual(sent[0], {
    schema: "atlas-query-wire-v1",
    type: "execute-source",
    requestId: "q1",
    source: "FIND subject WHERE score >= $min RETURN item AS subject",
    parameterTypes: { min: "number" },
    parameters: { min: 8 },
    pageSize: 25,
    offset: 0,
  });
  client.dispose();
  await assert.rejects(pending, /disposed/);
});
