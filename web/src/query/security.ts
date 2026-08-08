export const QUERY_SECURITY_PROFILE = {
  id: "atlas-query-security-v1",
  document: {
    maxOperators: 128,
    maxValuesCells: 10_000,
    maxBundleSections: 8,
  },
  execution: {
    maxPageSize: 500,
    maxOffset: 200_000,
    maxDistinctRows: 200_000,
    maxSetRows: 200_000,
    maxAggregateGroups: 50_000,
    maxAggregateDistinctValues: 200_000,
    maxScanRows: 4_000_000,
    // Facts are stored once per participating entity; a full relation analysis
    // reads incidence rows, not only unique FactRefs.
    maxExpandedFacts: 10_000_000,
  },
  path: {
    maxHops: 6,
    maxPaths: 20,
    maxStates: 50_000,
    maxFactsRead: 250_000,
  },
} as const;

const UNSAFE_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Accept readable output labels while keeping untrusted JSON out of object prototypes. */
export function safeRecordKey(value: string, label = "query name"): string {
  if (
    !value ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    UNSAFE_RECORD_KEYS.has(value)
  )
    throw new TypeError(`${label} is invalid`);
  return value;
}

export class QueryBudgetError extends Error {
  readonly code = "BUDGET_REQUIRED";

  constructor(message: string) {
    super(message);
    this.name = "QueryBudgetError";
  }
}
