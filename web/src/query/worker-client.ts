import type {
  ParameterType,
  ParameterValues,
  QueryDocument,
} from "./document";
import type { QueryResult } from "./engine";
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
  resolve(result: QueryResult): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class QueryWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
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
    if (response.type === "result" && response.result)
      request.resolve(decodeQueryResult(response.result));
    else if (
      response.type === "error" &&
      typeof response.code === "string" &&
      typeof response.message === "string"
    )
      request.reject(new QueryClientError(response.code, response.message));
    else request.reject(new QueryClientError("QUERY_FAILED", "查询响应无效"));
  };

  constructor(private readonly worker: WorkerPort) {
    worker.addEventListener("message", this.onMessage);
  }

  execute(
    document: QueryDocument,
    parameters: ParameterValues,
    options: QueryClientOptions,
  ): Promise<QueryResult> {
    return this.request({
      type: "execute",
      document,
      parameters,
    }, options);
  }

  executeSource(
    source: string,
    parameterTypes: Record<string, ParameterType>,
    parameters: ParameterValues,
    options: QueryClientOptions,
  ): Promise<QueryResult> {
    return this.request({
      type: "execute-source",
      source,
      parameterTypes,
      parameters,
    }, options);
  }

  private request(
    query: (
      | { type: "execute"; document: QueryDocument }
      | {
          type: "execute-source";
          source: string;
          parameterTypes: Record<string, ParameterType>;
        }
    ) & { parameters: ParameterValues },
    options: QueryClientOptions,
  ): Promise<QueryResult> {
    if (options.signal?.aborted)
      return Promise.reject(options.signal.reason);
    const requestId = `q${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        pending.onAbort = () => {
          if (!this.pending.has(requestId)) return;
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
        requestId,
        ...query,
        pageSize: options.pageSize,
        offset: options.offset ?? 0,
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
}
