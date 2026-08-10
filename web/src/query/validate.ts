import {
  QUERY_CONTRACT,
  assertFactFieldCapability,
  assertFieldCapability,
  fieldsWithCapability,
  factFieldDefinition,
  fieldDefinition,
  parseEntityRef,
  parseFactRef,
  type FieldCapability,
  type Owner,
  type QueryFactKind,
} from "./contract";
import type {
  Expression,
  LiteralValue,
  QueryDocument,
  QueryOperator,
} from "./document";

type ValueType =
  | "boolean"
  | "integer"
  | "number"
  | "string"
  | "number[]"
  | "string[]"
  | "tag[]"
  | "fact-ref"
  | `entity:${Owner}`
  | "entity-ref"
  | `entity-ref:${Owner}`
  | `fact:${QueryFactKind}`
  | "path"
  | "null"
  | "unknown";

interface TypeInfo {
  type: ValueType;
  semantic?: string;
  /** Internal execution column excluded from QueryResult rows. */
  hidden?: boolean;
  /** Capabilities inherited from a projected source field. */
  capabilities?: ReadonlySet<FieldCapability>;
  operators?: ReadonlySet<string>;
  literal?: LiteralValue;
  /** Long-text fields physically present on every entity carried by this binding. */
  sidecars?: ReadonlySet<string>;
}

type RowSchema = Record<string, TypeInfo>;

function literalType(value: LiteralValue): ValueType {
  if (value === null) return "null";
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  throw new TypeError("literal is not a query scalar");
}

function fieldValueType(type: string): ValueType {
  if (type.startsWith("entity:"))
    return `entity-ref:${type.slice(7) as Owner}`;
  return type as ValueType;
}

function compatible(left: ValueType, right: ValueType): boolean {
  if (left === "unknown" || right === "unknown" || left === "null" || right === "null")
    return true;
  if (
    (left === "integer" || left === "number") &&
    (right === "integer" || right === "number")
  )
    return true;
  if (
    (left === "entity-ref" && right.startsWith("entity-ref:")) ||
    (right === "entity-ref" && left.startsWith("entity-ref:"))
  )
    return true;
  return left === right;
}

function requireOperator(info: TypeInfo, operator: string): void {
  if (info.operators && !info.operators.has(operator))
    throw new TypeError(`${operator} is not supported for ${info.type}`);
}

function requireCapability(info: TypeInfo, capability: FieldCapability): void {
  if (
    info.semantic && info.capabilities &&
    !info.capabilities.has(capability)
  )
    throw new TypeError(`${info.semantic} does not support ${capability}`);
}

function inferExpression(
  expression: Expression,
  schema: RowSchema,
  capability?: FieldCapability,
): TypeInfo {
  switch (expression.kind) {
    case "literal":
      return { type: literalType(expression.value), literal: expression.value };
    case "parameter":
      throw new TypeError("normalized query contains a parameter");
    case "column": {
      const info = schema[expression.name];
      if (!info) throw new TypeError(`unknown query column ${expression.name}`);
      if (capability) requireCapability(info, capability);
      return info;
    }
    case "field": {
      const binding = schema[expression.binding];
      if (binding?.type.startsWith("entity:")) {
        const owner = binding.type.slice(7) as Owner;
        const field = capability
          ? assertFieldCapability(owner, expression.field, capability)
          : fieldDefinition(owner, expression.field);
        if (
          field.source !== "core" &&
          field.source !== "name" &&
          !field.source?.startsWith("derived:") &&
          !binding.sidecars?.has(expression.field)
        )
          throw new TypeError(
            `${owner}.${expression.field} 必须由单字段全文检索锚定`,
          );
        const operators = field.operators
          ? QUERY_CONTRACT.operatorSets[field.operators]
          : [];
        if (!operators)
          throw new TypeError(`${owner}.${expression.field} has no operator set`);
        return {
          type: fieldValueType(field.type),
          semantic: `${owner}.${expression.field}`,
          capabilities: new Set(field.capabilities),
          operators: new Set(operators),
        };
      }
      if (binding?.type.startsWith("fact:")) {
        const kind = binding.type.slice(5) as QueryFactKind;
        const definition = capability
          ? assertFactFieldCapability(kind, expression.field, capability)
          : factFieldDefinition(kind, expression.field);
        const fieldType = fieldValueType(definition.type);
        const operatorSet = definition.operators;
        return {
          type: fieldType as ValueType,
          semantic: `${kind}.${expression.field}`,
          capabilities: new Set(definition.capabilities),
          operators: new Set(
            operatorSet ? QUERY_CONTRACT.operatorSets[operatorSet] ?? [] : [],
          ),
        };
      }
      throw new TypeError(`${expression.binding} is not a field binding`);
    }
    case "compare": {
      const left = inferExpression(expression.left, schema, capability);
      const right = inferExpression(expression.right, schema, capability);
      requireOperator(left, expression.operator);
      requireOperator(right, expression.operator);
      if (expression.operator === "contains") {
        if (
          !(
            (left.type === "string" && right.type === "string") ||
            (left.type === "string[]" && right.type === "string") ||
            (left.type === "number[]" &&
              (right.type === "integer" || right.type === "number")) ||
            (left.type === "tag[]" && right.type === "string") ||
            left.type === "unknown" ||
            left.type === "null" ||
            right.type === "unknown" ||
            right.type === "null"
          )
        )
          throw new TypeError("contains operand type mismatch");
      } else if (
        left.type.startsWith("entity-ref:") &&
        right.type === "string" &&
        typeof right.literal === "string"
      ) {
        const parsed = parseEntityRef(right.literal);
        if (`entity-ref:${parsed.owner}` !== left.type)
          throw new TypeError("entity reference type mismatch");
      } else if (
        right.type.startsWith("entity-ref:") &&
        left.type === "string" &&
        typeof left.literal === "string"
      ) {
        const parsed = parseEntityRef(left.literal);
        if (`entity-ref:${parsed.owner}` !== right.type)
          throw new TypeError("entity reference type mismatch");
      } else if (!compatible(left.type, right.type)) {
        throw new TypeError(
          `${expression.operator} operand type mismatch: ${left.type} and ${right.type}`,
        );
      }
      return { type: "boolean" };
    }
    case "and":
    case "or":
      for (const term of expression.terms) {
        const type = inferExpression(term, schema, capability).type;
        if (type !== "boolean" && type !== "null" && type !== "unknown")
          throw new TypeError(`${expression.kind} term must have boolean type`);
      }
      return { type: "boolean" };
    case "not": {
      const type = inferExpression(expression.term, schema, capability).type;
      if (type !== "boolean" && type !== "null" && type !== "unknown")
        throw new TypeError("not term must have boolean type");
      return { type: "boolean" };
    }
    case "isNull":
    case "isMissing":
      requireOperator(
        inferExpression(expression.term, schema, capability),
        expression.kind,
      );
      return { type: "boolean" };
  }
}

function mergeValueTypes(left: ValueType, right: ValueType): ValueType {
  if (left === "unknown" || left === "null") return right;
  if (right === "unknown" || right === "null") return left;
  if (
    (left === "entity-ref" || left.startsWith("entity-ref:")) &&
    (right === "entity-ref" || right.startsWith("entity-ref:"))
  )
    return left === right ? left : "entity-ref";
  if (compatible(left, right))
    return left === "number" || right === "number" ? "number" : left;
  throw new TypeError(`values column mixes ${left} and ${right}`);
}

function requireNumericAggregate(functionName: string, info: TypeInfo): void {
  if (
    info.type !== "integer" &&
    info.type !== "number" &&
    info.type !== "null" &&
    info.type !== "unknown"
  )
    throw new TypeError(`${functionName} requires a numeric value`);
}

function requireOrderedAggregate(functionName: string, info: TypeInfo): void {
  if (
    info.type !== "integer" &&
    info.type !== "number" &&
    info.type !== "string" &&
    info.type !== "null" &&
    info.type !== "unknown"
  )
    throw new TypeError(`${functionName} requires an ordered scalar value`);
}

function requirePathEndpoint(name: string, info: TypeInfo): void {
  if (info.type === "unknown") return;
  if (info.type.startsWith("entity:")) {
    if (info.type === "entity:episode")
      throw new TypeError(`${name} cannot be an episode`);
    return;
  }
  if (info.type === "string") {
    if (typeof info.literal === "string") {
      const endpoint = parseEntityRef(info.literal);
      if (endpoint.owner === "episode")
        throw new TypeError(`${name} cannot be an episode`);
    }
    return;
  }
  throw new TypeError(`${name} must be an entity or canonical entity reference`);
}

export function validateQuery(document: QueryDocument): RowSchema {
  const cache = new Map<string, RowSchema>();
  const schemaFor = (id: string): RowSchema => {
    const previous = cache.get(id);
    if (previous) return previous;
    const operator: QueryOperator | undefined = document.operators[id];
    if (!operator) throw new TypeError(`query operator ${id} is missing`);
    let schema: RowSchema;
    switch (operator.kind) {
      case "scan":
        schema = { [operator.binding]: { type: `entity:${operator.owner}` } };
        break;
      case "lookup": {
        const text = inferExpression(operator.text, {}).type;
        if (text !== "string") throw new TypeError("lookup text must be a string");
        for (const field of operator.fields ?? fieldsWithCapability(operator.owner, "lookup"))
          assertFieldCapability(operator.owner, field, "lookup");
        schema = {
          [operator.binding]: {
            type: `entity:${operator.owner}`,
          },
        };
        break;
      }
      case "fullText": {
        const text = inferExpression(operator.text, {}).type;
        if (text !== "string")
          throw new TypeError("fullText text must be a string");
        if (operator.target === "entity") {
          assertFieldCapability(operator.owner, operator.field, "fullText");
          schema = {
            [operator.binding]: {
              type: `entity:${operator.owner}`,
              sidecars: new Set([operator.field]),
            },
          };
        } else {
          const fact = QUERY_CONTRACT.facts[operator.factKind];
          assertFactFieldCapability(operator.factKind, operator.field, "fullText");
          schema = Object.fromEntries(
            Object.entries(operator.roles).map(([role, binding]) => {
              const owner = fact.roles[role];
              if (!owner)
                throw new TypeError(`unknown ${operator.factKind} role ${role}`);
              return [binding, { type: `entity:${owner}` as const }];
            }),
          );
          if (schema[operator.factBinding])
            throw new TypeError(`fact binding ${operator.factBinding} already exists`);
          schema[operator.factBinding] = {
            type: `fact:${operator.factKind}`,
            sidecars: new Set([operator.field]),
          };
        }
        break;
      }
      case "factLookup": {
        const ref = inferExpression(operator.ref, {});
        if (ref.type !== "string" || typeof ref.literal !== "string")
          throw new TypeError("factLookup ref must be a FactRef literal");
        parseFactRef(ref.literal);
        const fact = QUERY_CONTRACT.facts[operator.factKind];
        if (!fact) throw new TypeError(`unknown fact kind ${operator.factKind}`);
        schema = {};
        const expectedRoles = Object.keys(fact.roles).sort();
        const actualRoles = Object.keys(operator.roles).sort();
        if (
          actualRoles.length !== expectedRoles.length ||
          actualRoles.some((role, index) => role !== expectedRoles[index])
        )
          throw new TypeError(`factLookup requires every ${operator.factKind} role`);
        for (const [role, binding] of Object.entries(operator.roles)) {
          const owner = fact.roles[role];
          if (!owner) throw new TypeError(`unknown ${operator.factKind} role ${role}`);
          if (schema[binding])
            throw new TypeError(`factLookup binding ${binding} is duplicated`);
          schema[binding] = { type: `entity:${owner}` };
        }
        if (schema[operator.factBinding])
          throw new TypeError(`fact binding ${operator.factBinding} already exists`);
        schema[operator.factBinding] = { type: `fact:${operator.factKind}` };
        break;
      }
      case "values":
        schema = Object.fromEntries(
          operator.columns.map((column, index) => {
            const declared = operator.types?.[column];
            if (declared) return [column, { type: declared as ValueType }];
            let type: ValueType = "unknown";
            for (const row of operator.rows)
              type = mergeValueTypes(type, literalType(row[index] as LiteralValue));
            return [column, { type }];
          }),
        );
        break;
      case "filter": {
        schema = schemaFor(operator.input);
        const predicate = inferExpression(
          operator.predicate,
          schema,
          "filter",
        ).type;
        if (predicate !== "boolean" && predicate !== "null" && predicate !== "unknown")
          throw new TypeError("filter predicate must have boolean type");
        break;
      }
      case "project": {
        const input = schemaFor(operator.input);
        schema = Object.fromEntries(
          operator.columns.map((column) => [
            column.name,
            {
              ...inferExpression(column.value, input, "project"),
              ...(column.hidden ? { hidden: true } : {}),
            },
          ]),
        );
        break;
      }
      case "matchFact": {
        const input = schemaFor(operator.input);
        const fact = QUERY_CONTRACT.facts[operator.factKind];
        if (!fact) throw new TypeError(`unknown fact kind ${operator.factKind}`);
        schema = { ...input };
        let anchored = false;
        for (const [role, bindingName] of Object.entries(operator.roles)) {
          const owner = fact.roles[role];
          if (!owner) throw new TypeError(`unknown ${operator.factKind} role ${role}`);
          const expected = `entity:${owner}` as const;
          const existing = schema[bindingName];
          if (existing) {
            anchored ||= Object.hasOwn(input, bindingName);
            if (existing.type !== expected)
              throw new TypeError(`${role} requires ${expected}, not ${existing.type}`);
          } else schema[bindingName] = { type: expected };
        }
        if (!anchored)
          throw new TypeError("matchFact requires an existing role binding");
        if (schema[operator.factBinding])
          throw new TypeError(`fact binding ${operator.factBinding} already exists`);
        schema[operator.factBinding] = { type: `fact:${operator.factKind}` };
        break;
      }
      case "followRef": {
        const input = schemaFor(operator.input);
        const definition = assertFieldCapability(
          operator.referenceOwner,
          operator.field,
          "traverse",
        );
        if (!definition.type.startsWith("entity:"))
          throw new TypeError(
            `${operator.referenceOwner}.${operator.field} is not an entity reference`,
          );
        const targetType = definition.type as `entity:${Owner}`;
        const anchorType = operator.direction === "forward"
          ? `entity:${operator.referenceOwner}` as const
          : targetType;
        const resultType = operator.direction === "forward"
          ? targetType
          : `entity:${operator.referenceOwner}` as const;
        const anchor = input[operator.anchorBinding];
        if (!anchor)
          throw new TypeError(`unknown reference anchor ${operator.anchorBinding}`);
        if (anchor.type !== anchorType)
          throw new TypeError(
            `${operator.anchorBinding} must be ${anchorType}, not ${anchor.type}`,
          );
        if (input[operator.resultBinding])
          throw new TypeError(`reference result ${operator.resultBinding} already exists`);
        schema = {
          ...input,
          [operator.resultBinding]: { type: resultType },
        };
        break;
      }
      case "aggregate": {
        const input = schemaFor(operator.input);
        schema = Object.fromEntries(
          operator.groupBy.map((group) => {
            const info = inferExpression(group.value, input, "group");
            return [group.name, { ...info, capabilities: undefined }];
          }),
        );
        for (const metric of operator.metrics) {
          const info = metric.value
            ? inferExpression(metric.value, input, "aggregate")
            : { type: "unknown" as const };
          switch (metric.function) {
            case "count":
            case "countDistinct":
              schema[metric.name] = { type: "integer" };
              break;
            case "sum":
            case "avg":
              requireNumericAggregate(metric.function, info);
              schema[metric.name] = { type: "number" };
              break;
            case "min":
            case "max":
              requireOrderedAggregate(metric.function, info);
              schema[metric.name] = { ...info, capabilities: undefined };
              break;
          }
        }
        break;
      }
      case "path": {
        const input = schemaFor(operator.input);
        requirePathEndpoint("path start", inferExpression(operator.start, input));
        requirePathEndpoint("path target", inferExpression(operator.target, input));
        if (input[operator.binding])
          throw new TypeError(`path binding ${operator.binding} already exists`);
        schema = { ...input, [operator.binding]: { type: "path" } };
        break;
      }
      case "union":
      case "intersect":
      case "except": {
        let expectedColumns: string[] | null = null;
        schema = {};
        for (const branch of operator.branches) {
          const input = schemaFor(branch.input);
          const outputs = branch.columns.map((column) => column.output);
          if (
            expectedColumns &&
            (outputs.length !== expectedColumns.length ||
              outputs.some((name, index) => name !== expectedColumns?.[index]))
          )
            throw new TypeError(`${operator.kind} branch columns do not match`);
          expectedColumns ??= outputs;
          for (const column of branch.columns) {
            const info = input[column.input];
            if (!info)
              throw new TypeError(`unknown set input column ${column.input}`);
            const previous = schema[column.output];
            if (!previous) {
              schema[column.output] = info;
              continue;
            }
            let type: ValueType;
            try {
              type = mergeValueTypes(previous.type, info.type);
            } catch {
              throw new TypeError(
                `${operator.kind} column ${column.output} type mismatch`,
              );
            }
            schema[column.output] = {
              ...previous,
              type,
              hidden: previous.hidden && info.hidden ? true : undefined,
              semantic: previous.semantic === info.semantic ? previous.semantic : undefined,
              capabilities: previous.semantic === info.semantic
                ? new Set(
                  [...(previous.capabilities ?? [])].filter((capability) =>
                    info.capabilities?.has(capability)
                  ),
                )
                : undefined,
              sidecars: new Set(
                [...(previous.sidecars ?? [])].filter((field) =>
                  info.sidecars?.has(field)
                ),
              ),
            };
          }
        }
        break;
      }
      case "exists":
      case "notExists": {
        const outer = schemaFor(operator.input);
        const inner = schemaFor(operator.match);
        for (const column of operator.columns) {
          const left = outer[column.outer];
          const right = inner[column.inner];
          if (!left) throw new TypeError(`unknown ${operator.kind} outer column ${column.outer}`);
          if (!right) throw new TypeError(`unknown ${operator.kind} inner column ${column.inner}`);
          if (!compatible(left.type, right.type))
            throw new TypeError(`${operator.kind} correlation type mismatch`);
        }
        schema = outer;
        break;
      }
    }
    cache.set(id, schema);
    return schema;
  };

  const root = schemaFor(document.root);
  for (const term of document.orderBy ?? []) {
    const info = root[term.column];
    if (!info) throw new TypeError(`unknown order column ${term.column}`);
    requireCapability(info, "sort");
    if (
      info.type.endsWith("[]") ||
      info.type.startsWith("entity:") ||
      info.type.startsWith("fact:") ||
      info.type === "path"
    )
      throw new TypeError(`order column ${term.column} is not scalar`);
  }
  return root;
}

export interface QueryResultColumn {
  type: string;
  semantic?: string;
}

export function queryResultColumns(
  document: QueryDocument,
): Record<string, QueryResultColumn> {
  return Object.fromEntries(
    Object.entries(validateQuery(document))
      .filter(([, info]) => !info.hidden)
      .map(([name, info]) => [
        name,
        {
          type: info.type,
          ...(info.semantic ? { semantic: info.semantic } : {}),
        },
      ]),
  );
}
