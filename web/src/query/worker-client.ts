import type {
  ParameterValues,
  QueryDocument,
} from "./document";
import type { QueryResult } from "./engine";
import {
  validateQueryHighlights,
  type QueryHighlights,
} from "./highlights";
import {
  QUERY_WIRE_SCHEMA,
  decodeQueryResult,
  type QueryErrorCode,
  type QueryWorkerRequest,
  type QueryWorkerResponse,
} from "./wire";

interface WorkerPort {
  postMessage(message: QueryWorkerRequest): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  terminate?(): void;
}

export interface QueryClientOptions {
  pageSize: number;
  offset?: number;
  signal?: AbortSignal;
}

export class QueryClientError extends Error {
  constructor(
    readonly code: QueryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QueryClientError";
  }
}

interface PendingRequest {
  resolve(result: QueryExecution): void;
  reject(error: unknown): void;
  includeHighlights: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface QueryExecution {
  result: QueryResult;
  highlights?: QueryHighlights;
}

export interface QueryExecutionWithHighlights {
  result: QueryResult;
  highlights: QueryHighlights;
}

export class QueryWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly factory: (() => WorkerPort) | null;
  private worker: WorkerPort;
  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const response = event.data as Partial<QueryWorkerResponse>;
    if (
      response?.schema !== QUERY_WIRE_SCHEMA ||
      typeof response.requestId !== "string"
    )
      return;
    const request = this.pending.get(response.requestId);
    if (!request) return;
    this.finish(response.requestId, request);
    if (response.type === "result" && response.result) {
      try {
        const highlights = response.highlights === undefined
          ? undefined
          : validateQueryHighlights(response.highlights);
        if (request.includeHighlights && !highlights)
          throw new TypeError("query worker omitted requested highlights");
        request.resolve({
          result: decodeQueryResult(response.result),
          ...(highlights ? { highlights } : {}),
        });
      } catch {
        request.reject(new QueryClientError("QUERY_FAILED", "查询响应无效"));
      }
    } else if (
      response.type === "error" &&
      typeof response.code === "string" &&
      typeof response.message === "string"
    )
      request.reject(new QueryClientError(response.code, response.message));
    else request.reject(new QueryClientError("QUERY_FAILED", "查询响应无效"));
  };

  constructor(worker: WorkerPort | (() => WorkerPort)) {
    if (typeof worker === "function") {
      this.factory = worker;
      this.worker = worker();
    } else {
      this.factory = null;
      this.worker = worker;
    }
    this.worker.addEventListener("message", this.onMessage);
  }

  execute(
    document: QueryDocument,
    parameters: ParameterValues,
    options: QueryClientOptions,
  ): Promise<QueryResult> {
    return this.request(document, parameters, options, false)
      .then((execution) => execution.result);
  }

  executeWithHighlights(
    document: QueryDocument,
    parameters: ParameterValues,
    options: QueryClientOptions,
  ): Promise<QueryExecutionWithHighlights> {
    return this.request(document, parameters, options, true)
      .then((execution) => ({
        result: execution.result,
        highlights: execution.highlights as QueryHighlights,
      }));
  }

  private request(
    document: QueryDocument,
    parameters: ParameterValues,
    options: QueryClientOptions,
    includeHighlights: boolean,
  ): Promise<QueryExecution> {
    if (options.signal?.aborted)
      return Promise.reject(options.signal.reason);
    const requestId = `q${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        includeHighlights,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        pending.onAbort = () => {
          if (!this.pending.has(requestId)) return;
          if (this.factory) {
            this.restart(options.signal?.reason);
            return;
          }
          this.finish(requestId, pending);
          this.worker.postMessage({
            schema: QUERY_WIRE_SCHEMA,
            type: "cancel",
            requestId,
          });
          reject(options.signal?.reason);
        };
        options.signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(requestId, pending);
      this.worker.postMessage({
        schema: QUERY_WIRE_SCHEMA,
        type: "execute",
        requestId,
        document,
        parameters,
        pageSize: options.pageSize,
        offset: options.offset ?? 0,
        ...(includeHighlights ? { includeHighlights: true } : {}),
      });
    });
  }

  dispose(): void {
    this.worker.removeEventListener("message", this.onMessage);
    for (const [requestId, request] of this.pending) {
      this.finish(requestId, request);
      request.reject(new DOMException("query client disposed", "AbortError"));
    }
    this.worker.terminate?.();
  }

  private finish(requestId: string, request: PendingRequest): void {
    this.pending.delete(requestId);
    if (request.signal && request.onAbort)
      request.signal.removeEventListener("abort", request.onAbort);
  }

  private restart(reason: unknown): void {
    const failure = reason ?? new DOMException("query cancelled", "AbortError");
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.terminate?.();
    for (const [requestId, request] of this.pending) {
      this.finish(requestId, request);
      request.reject(failure);
    }
    this.worker = this.factory!();
    this.worker.addEventListener("message", this.onMessage);
  }
}
