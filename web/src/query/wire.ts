import type {
  ParameterValues,
  QueryDocument,
} from "./document";
import type { QueryResult, QueryRow } from "./engine";
import type { QueryHighlights } from "./highlights";
import { MISSING, isMissing } from "./value";

export const QUERY_WIRE_SCHEMA = "atlas-query-wire-v1" as const;

export interface QueryExecutionRequest {
  schema: typeof QUERY_WIRE_SCHEMA;
  type: "execute";
  requestId: string;
  document: QueryDocument;
  parameters: ParameterValues;
  pageSize: number;
  offset: number;
  includeHighlights?: boolean;
}

export interface CancelQueryRequest {
  schema: typeof QUERY_WIRE_SCHEMA;
  type: "cancel";
  requestId: string;
}

export type QueryWorkerRequest = QueryExecutionRequest | CancelQueryRequest;

export interface WireQueryResult extends Omit<QueryResult, "rows"> {
  rows: unknown[];
}

export type QueryErrorCode =
  | "INVALID_QUERY"
  | "UNSUPPORTED_QUERY"
  | "CANCELLED"
  | "RELEASE_UNAVAILABLE"
  | "RELEASE_EVICTED"
  | "DATA_INTEGRITY"
  | "NETWORK"
  | "QUERY_FAILED";

export type QueryWorkerResponse =
  | {
      schema: typeof QUERY_WIRE_SCHEMA;
      type: "result";
      requestId: string;
      result: WireQueryResult;
      highlights?: QueryHighlights;
    }
  | {
      schema: typeof QUERY_WIRE_SCHEMA;
      type: "error";
      requestId: string;
      code: QueryErrorCode;
      message: string;
    };

function encodeStructured(value: unknown): unknown {
  if (isMissing(value)) return { $atlas: "missing" };
  if (Array.isArray(value)) return value.map(encodeStructured);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeStructured(item)]),
    );
  if (typeof value === "symbol")
    throw new TypeError("query result contains an unknown symbol");
  return value;
}

function decodeStructured(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeStructured);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length === 1 &&
      record.$atlas === "missing"
    )
      return MISSING;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, decodeStructured(item)]),
    );
  }
  return value;
}

export function encodeQueryResult(result: QueryResult): WireQueryResult {
  return { ...result, rows: result.rows.map(encodeStructured) };
}

export function decodeQueryResult(result: WireQueryResult): QueryResult {
  if (
    !Array.isArray(result.rows) ||
    !Number.isSafeInteger(result.totalMatches) ||
    result.totalMatches < 0 ||
    !Number.isSafeInteger(result.visibleMatches) ||
    result.visibleMatches < 0 ||
    result.visibleMatches > result.totalMatches ||
    typeof result.hasMore !== "boolean" ||
    result.stability !== "exact" ||
    !Array.isArray(result.evidence) ||
    result.evidence.length !== result.rows.length ||
    result.columns === null ||
    typeof result.columns !== "object" ||
    Array.isArray(result.columns) ||
    Object.values(result.columns).some((column) =>
      column === null ||
      typeof column !== "object" ||
      Array.isArray(column) ||
      typeof (column as { type?: unknown }).type !== "string" ||
      (
        (column as { semantic?: unknown }).semantic !== undefined &&
        typeof (column as { semantic?: unknown }).semantic !== "string"
      )
    ) ||
    !/^[0-9a-f]{64}$/.test(result.queryDigest) ||
    (result.releaseId !== null && typeof result.releaseId !== "string") ||
    result.coverage?.schema !== "atlas-coverage-v1" ||
    !Array.isArray(result.coverage.atoms) ||
    !/^[0-9a-f]{64}$/.test(result.coverage.digest) ||
    !Array.isArray(result.terminalEvidence)
  )
    throw new TypeError("invalid query worker result");
  return {
    ...result,
    rows: result.rows.map((row) => {
      const decoded = decodeStructured(row);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
        throw new TypeError("invalid query worker row");
      return decoded as QueryRow;
    }),
  };
}
