export const QUERY_SECURITY_PROFILE = {
  id: "atlas-query-security-v1",
  document: {
    maxOperators: 128,
    maxValuesCells: 10_000,
    maxBundleSections: 8,
  },
  execution: {
    maxPageSize: 500,
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
