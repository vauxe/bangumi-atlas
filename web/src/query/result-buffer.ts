import type { QueryResult } from "./engine";

export async function commitRenderedResults<T>(
  signal: AbortSignal,
  pending: readonly Promise<T>[],
  commit: (results: readonly T[]) => void,
): Promise<readonly T[] | null> {
  const results = await Promise.all(pending);
  if (signal.aborted) return null;
  commit(results);
  return results;
}

function assertAligned(result: QueryResult): void {
  if (result.rows.length !== result.evidence.length)
    throw new TypeError("查询结果与证据行数不一致");
}

export function revealQueryResult(
  result: QueryResult,
  count: number,
): QueryResult {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new TypeError("显示条数无效");
  assertAligned(result);
  const end = Math.min(count, result.rows.length);
  return {
    ...result,
    rows: result.rows.slice(0, end),
    evidence: result.evidence.slice(0, end),
    hasMore: end < result.rows.length || result.hasMore,
  };
}

export function appendQueryResultPage(
  accumulated: QueryResult,
  page: QueryResult,
): QueryResult {
  assertAligned(accumulated);
  assertAligned(page);
  if (accumulated.releaseId !== page.releaseId)
    throw new TypeError("分页结果来自不同的数据版本");
  if (
    accumulated.queryDigest !== page.queryDigest ||
    accumulated.coverage.digest !== page.coverage.digest ||
    accumulated.totalMatches !== page.totalMatches ||
    accumulated.visibleMatches !== page.visibleMatches
  )
    throw new TypeError("分页结果与当前查询不一致");
  return {
    ...page,
    rows: [...accumulated.rows, ...page.rows],
    evidence: [...accumulated.evidence, ...page.evidence],
  };
}
