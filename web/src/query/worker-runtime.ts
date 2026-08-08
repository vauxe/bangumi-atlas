import type { QueryResult } from "./engine";
import { SiteRuntimeError } from "../site-error";
import {
  QUERY_WIRE_SCHEMA,
  encodeQueryResult,
  type QueryExecutionRequest,
  type QueryErrorCode,
  type QueryWorkerResponse,
} from "./wire";

type Execute = (
  request: QueryExecutionRequest,
  signal: AbortSignal,
) => Promise<QueryResult>;

export interface QueryWorkerRuntime {
  receive(message: unknown): void;
}

function publicError(
  error: unknown,
  aborted: boolean,
): { code: QueryErrorCode; message: string } {
  if (aborted)
    return { code: "CANCELLED", message: "查询已取消" };
  if (error instanceof SiteRuntimeError)
    return { code: error.code, message: error.message };
  if (error instanceof TypeError)
    return { code: "INVALID_QUERY", message: error.message };
  return { code: "QUERY_FAILED", message: "查询执行失败" };
}

export function createQueryWorkerRuntime(
  execute: Execute,
  post: (response: QueryWorkerResponse) => void,
): QueryWorkerRuntime {
  const active = new Map<string, AbortController>();
  return {
    receive(message: unknown): void {
      if (
        message === null ||
        typeof message !== "object" ||
        (message as { schema?: unknown }).schema !== QUERY_WIRE_SCHEMA ||
        typeof (message as { requestId?: unknown }).requestId !== "string"
      )
        return;
      const request = message as {
        type?: unknown;
        requestId: string;
      };
      if (request.type === "cancel") {
        active.get(request.requestId)?.abort(
          new DOMException("query cancelled", "AbortError"),
        );
        return;
      }
      if (request.type !== "execute" && request.type !== "execute-source") return;
      if (active.has(request.requestId)) {
        post({
          schema: QUERY_WIRE_SCHEMA,
          type: "error",
          requestId: request.requestId,
          code: "INVALID_QUERY",
          message: "查询请求标识重复",
        });
        return;
      }
      const controller = new AbortController();
      active.set(request.requestId, controller);
      void (async () => {
        try {
          const result = await execute(
            message as QueryExecutionRequest,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          post({
            schema: QUERY_WIRE_SCHEMA,
            type: "result",
            requestId: request.requestId,
            result: encodeQueryResult(result),
          });
        } catch (error) {
          const failure = publicError(error, controller.signal.aborted);
          post({
            schema: QUERY_WIRE_SCHEMA,
            type: "error",
            requestId: request.requestId,
            ...failure,
          });
        } finally {
          active.delete(request.requestId);
        }
      })();
    },
  };
}
