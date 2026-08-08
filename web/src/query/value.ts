/** Query runtime values. `null` is explicit source null; `MISSING` means the
 * field is not present for this owner or source row. */
export const MISSING: unique symbol = Symbol("atlas.query.missing");

export type Missing = typeof MISSING;
export type QueryScalar = string | number | boolean | null | Missing;
export interface TagValue {
  name: string;
  count: number;
}
export type QueryListValue = QueryScalar | TagValue;
export type Truth = boolean | null;

export type CompareOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains";

export function isMissing(value: unknown): value is Missing {
  return value === MISSING;
}

export function isNull(value: unknown): value is null {
  return value === null;
}

function requireFinite(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("query numbers must be finite");
}

function equalValues(left: QueryScalar, right: QueryScalar): boolean {
  return typeof left === typeof right && Object.is(left, right);
}

function isScalarList(
  value: QueryScalar | readonly QueryListValue[],
): value is readonly QueryListValue[] {
  return Array.isArray(value);
}

function isTag(value: QueryListValue): value is TagValue {
  return typeof value === "object" && value !== null && "name" in value;
}

export function compareValues(
  operator: CompareOperator,
  left: QueryScalar | readonly QueryListValue[],
  right: QueryScalar | readonly QueryListValue[],
): Truth {
  if (isMissing(left) || isMissing(right) || left === null || right === null)
    return null;
  requireFinite(left);
  requireFinite(right);

  if (operator === "eq" || operator === "ne") {
    const equal =
      isScalarList(left) && isScalarList(right)
        ? left.length === right.length &&
          left.every((value, index) => {
            const other = right[index] as QueryListValue;
            return isTag(value) && isTag(other)
              ? value.name === other.name && value.count === other.count
              : !isTag(value) && !isTag(other) && equalValues(value, other);
          })
        : !isScalarList(left) &&
          !isScalarList(right) &&
          equalValues(left, right);
    return operator === "eq" ? equal : !equal;
  }

  if (operator === "contains") {
    if (typeof left === "string" && typeof right === "string")
      return left.includes(right);
    if (isScalarList(left) && !isScalarList(right))
      return left.some((value) =>
        isTag(value)
          ? typeof right === "string" && value.name === right
          : equalValues(value, right)
      );
    throw new TypeError("contains requires a string or list with a scalar value");
  }

  if (
    isScalarList(left) ||
    isScalarList(right) ||
    typeof left !== typeof right ||
    (typeof left !== "number" && typeof left !== "string")
  )
    throw new TypeError(`${operator} requires operands of the same ordered type`);

  const order = left < right ? -1 : left > right ? 1 : 0;
  switch (operator) {
    case "lt":
      return order < 0;
    case "lte":
      return order <= 0;
    case "gt":
      return order > 0;
    case "gte":
      return order >= 0;
  }
}

export function andTruth(left: Truth, right: Truth): Truth {
  if (left === false || right === false) return false;
  if (left === null || right === null) return null;
  return true;
}

export function orTruth(left: Truth, right: Truth): Truth {
  if (left === true || right === true) return true;
  if (left === null || right === null) return null;
  return false;
}

export function notTruth(value: Truth): Truth {
  return value === null ? null : !value;
}
