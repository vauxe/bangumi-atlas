import {
  QUERY_CONTRACT,
  assertFactFieldCapability,
  assertFieldCapability,
  fieldsWithCapability,
  parseEntityRef,
  parseFactRef,
  type Owner,
} from "./contract";
import type {
  AggregateOperator,
  ExistsOperator,
  EntityFullTextOperator,
  Expression,
  FollowRefOperator,
  FactFullTextOperator,
  FactLookupOperator,
  LookupField,
  MatchFactOperator,
  FilterOperator,
  LiteralValue,
  ParameterType,
  ParameterValues,
  PathOperator,
  ProjectOperator,
  QueryDocument,
  QueryOperator,
  SetOperator,
  ValuesOperator,
} from "./document";
import { QUERY_SECURITY_PROFILE, safeRecordKey } from "./security";
import { validateQuery } from "./validate";

function queryOwner(value: Owner): Owner {
  if (!Object.hasOwn(QUERY_CONTRACT.owners, value))
    throw new TypeError("query owner is invalid");
  return value;
}

function assertFiniteNumbers(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("query numbers must be finite");
  if (Array.isArray(value)) {
    for (const item of value) assertFiniteNumbers(item);
    return;
  }
  if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) assertFiniteNumbers(item);
}

/** RFC 8785-compatible for the JSON data model used by QueryDocument. */
export function canonicalJson(value: unknown): string {
  assertFiniteNumbers(value);
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value !== "object")
    throw new TypeError("canonical JSON accepts only JSON values");
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined)
        throw new TypeError("canonical JSON does not accept undefined");
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    })
    .join(",")}}`;
}

function validateParameter(
  name: string,
  type: ParameterType,
  value: LiteralValue,
): void {
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new TypeError(`parameter ${name} must be a finite number`);
    return;
  }
  if (type === "integer") {
    if (!Number.isSafeInteger(value))
      throw new TypeError(`parameter ${name} must be an integer`);
    return;
  }
  if (type.startsWith("entity:")) {
    if (typeof value !== "string")
      throw new TypeError(`parameter ${name} must be an entity reference`);
    const parsed = parseEntityRef(value);
    if (`entity:${parsed.owner}` !== type)
      throw new TypeError(`parameter ${name} must be ${type}`);
    return;
  }
  if (type === "fact-ref") {
    if (typeof value !== "string")
      throw new TypeError(`parameter ${name} must be a fact reference`);
    parseFactRef(value);
    return;
  }
  if (typeof value !== type)
    throw new TypeError(`parameter ${name} must be ${type}`);
}

function normalizeExpression(
  expression: Expression,
  declarations: Record<string, ParameterType>,
  values: ParameterValues,
): Expression {
  switch (expression.kind) {
    case "literal":
      assertFiniteNumbers(expression.value);
      return { kind: "literal", value: expression.value };
    case "parameter": {
      safeRecordKey(expression.name, "parameter name");
      const type = declarations[expression.name];
      if (!type || !Object.hasOwn(values, expression.name))
        throw new TypeError(`parameter ${expression.name} is missing`);
      const value = values[expression.name];
      if (value === undefined)
        throw new TypeError(`parameter ${expression.name} is missing`);
      validateParameter(expression.name, type, value);
      return { kind: "literal", value };
    }
    case "column":
      return { kind: "column", name: safeRecordKey(expression.name) };
    case "field":
      return {
        kind: "field",
        binding: safeRecordKey(expression.binding),
        field: expression.field,
      };
    case "compare":
      return {
        kind: "compare",
        operator: expression.operator,
        left: normalizeExpression(expression.left, declarations, values),
        right: normalizeExpression(expression.right, declarations, values),
      };
    case "and":
    case "or": {
      const terms = expression.terms.map((term) =>
        normalizeExpression(term, declarations, values),
      );
      terms.sort((left, right) => {
        const a = canonicalJson(left);
        const b = canonicalJson(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
      return { kind: expression.kind, terms };
    }
    case "not":
      return {
        kind: "not",
        term: normalizeExpression(expression.term, declarations, values),
      };
    case "isNull":
    case "isMissing":
      return {
        kind: expression.kind,
        term: normalizeExpression(expression.term, declarations, values),
      };
  }
}

function operatorInputs(operator: QueryOperator): string[] {
  if (
    operator.kind === "union" ||
    operator.kind === "intersect" ||
    operator.kind === "except"
  )
    return operator.branches.map((branch) => branch.input);
  if (operator.kind === "exists" || operator.kind === "notExists")
    return [operator.input, operator.match];
  return operator.kind === "filter" ||
    operator.kind === "project" ||
    operator.kind === "matchFact" ||
    operator.kind === "followRef" ||
    operator.kind === "aggregate" ||
    operator.kind === "path"
    ? [operator.input]
    : [];
}

interface BindingState {
  names: Map<string, string>;
  used: Set<string>;
  next: number;
}

function sourceBindingState(binding: string): BindingState {
  return {
    names: new Map([[binding, "v0"]]),
    used: new Set(["v0"]),
    next: 1,
  };
}

function outputBindingState(names: readonly string[]): BindingState {
  return {
    names: new Map(names.map((name) => [name, name])),
    used: new Set(names),
    next: 0,
  };
}

function copyBindingState(state: BindingState): BindingState {
  return {
    names: new Map(state.names),
    used: new Set(state.used),
    next: state.next,
  };
}

function allocateBinding(state: BindingState, source: string): string {
  const previous = state.names.get(source);
  if (previous) return previous;
  let binding: string;
  do binding = `v${state.next++}`;
  while (state.used.has(binding));
  state.names.set(source, binding);
  state.used.add(binding);
  return binding;
}

function renameExpressionBindings(
  expression: Expression,
  state: BindingState,
): Expression {
  switch (expression.kind) {
    case "literal":
    case "parameter":
      return expression;
    case "column":
      return {
        kind: "column",
        name: state.names.get(expression.name) ?? expression.name,
      };
    case "field":
      return {
        kind: "field",
        binding: state.names.get(expression.binding) ?? expression.binding,
        field: expression.field,
      };
    case "compare":
      return {
        kind: "compare",
        operator: expression.operator,
        left: renameExpressionBindings(expression.left, state),
        right: renameExpressionBindings(expression.right, state),
      };
    case "and":
    case "or": {
      const terms = expression.terms.map((term) =>
        renameExpressionBindings(term, state),
      );
      terms.sort((left, right) => {
        const a = canonicalJson(left);
        const b = canonicalJson(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
      return { kind: expression.kind, terms };
    }
    case "not":
      return {
        kind: "not",
        term: renameExpressionBindings(expression.term, state),
      };
    case "isNull":
    case "isMissing":
      return {
        kind: expression.kind,
        term: renameExpressionBindings(expression.term, state),
      };
  }
}

/**
 * Query variables are local implementation details. Rename them from their
 * structural origin so equivalent builder and text queries share one digest.
 * User-visible Project/Aggregate/Set output column names remain unchanged.
 */
function canonicalizeBindings(
  root: string,
  operators: Record<string, QueryOperator>,
): Record<string, QueryOperator> {
  const output: Record<string, QueryOperator> = {};
  const states = new Map<string, BindingState>();

  const visit = (id: string): BindingState => {
    const previous = states.get(id);
    if (previous) return previous;
    const operator = operators[id];
    if (!operator) throw new TypeError(`query operator ${id} is missing`);

    let normalized: QueryOperator;
    let state: BindingState;
    switch (operator.kind) {
      case "scan":
        state = sourceBindingState(operator.binding);
        normalized = { ...operator, binding: "v0" };
        break;
      case "lookup":
        state = sourceBindingState(operator.binding);
        normalized = {
          ...operator,
          binding: "v0",
          text: renameExpressionBindings(operator.text, outputBindingState([])),
        };
        break;
      case "fullText":
        if (operator.target === "entity") {
          state = sourceBindingState(operator.binding);
          normalized = {
            ...operator,
            binding: "v0",
            text: renameExpressionBindings(operator.text, outputBindingState([])),
          };
        } else {
          state = outputBindingState([]);
          const roles = Object.fromEntries(
            Object.entries(operator.roles)
              .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
              .map(([role, binding]) => [role, allocateBinding(state, binding)]),
          );
          normalized = {
            ...operator,
            roles,
            factBinding: allocateBinding(state, operator.factBinding),
            text: renameExpressionBindings(operator.text, outputBindingState([])),
          };
        }
        break;
      case "factLookup": {
        state = outputBindingState([]);
        const roles = Object.fromEntries(
          Object.entries(operator.roles)
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([role, binding]) => [role, allocateBinding(state, binding)]),
        );
        normalized = {
          ...operator,
          roles,
          factBinding: allocateBinding(state, operator.factBinding),
          ref: renameExpressionBindings(operator.ref, outputBindingState([])),
        };
        break;
      }
      case "values": {
        state = outputBindingState([]);
        const columns = operator.columns.map((column) => {
          const type = operator.types?.[column];
          if (type?.startsWith("entity:")) return allocateBinding(state, column);
          state.names.set(column, column);
          state.used.add(column);
          return column;
        });
        const types = operator.types
          ? Object.fromEntries(
              Object.entries(operator.types).map(([name, type]) => [
                state.names.get(name) ?? name,
                type,
              ]),
            )
          : undefined;
        normalized = {
          ...operator,
          columns,
          ...(types && Object.keys(types).length ? { types } : {}),
        };
        break;
      }
      case "filter": {
        state = copyBindingState(visit(operator.input));
        normalized = {
          ...operator,
          predicate: renameExpressionBindings(operator.predicate, state),
        };
        break;
      }
      case "project": {
        const input = visit(operator.input);
        normalized = {
          ...operator,
          columns: operator.columns.map((column) => ({
            name: column.name,
            value: renameExpressionBindings(column.value, input),
          })),
        };
        state = outputBindingState(operator.columns.map((column) => column.name));
        break;
      }
      case "matchFact": {
        state = copyBindingState(visit(operator.input));
        const roles = Object.fromEntries(
          Object.entries(operator.roles)
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([role, binding]) => [role, allocateBinding(state, binding)]),
        );
        normalized = {
          ...operator,
          roles,
          factBinding: allocateBinding(state, operator.factBinding),
        };
        break;
      }
      case "followRef": {
        state = copyBindingState(visit(operator.input));
        const anchorBinding = state.names.get(operator.anchorBinding);
        if (!anchorBinding)
          throw new TypeError(`unknown reference anchor ${operator.anchorBinding}`);
        normalized = {
          ...operator,
          anchorBinding,
          resultBinding: allocateBinding(state, operator.resultBinding),
        };
        break;
      }
      case "aggregate": {
        const input = visit(operator.input);
        normalized = {
          ...operator,
          groupBy: operator.groupBy.map((group) => ({
            name: group.name,
            value: renameExpressionBindings(group.value, input),
          })),
          metrics: operator.metrics.map((metric) => ({
            ...metric,
            ...(metric.value
              ? { value: renameExpressionBindings(metric.value, input) }
              : {}),
          })),
        };
        state = outputBindingState([
          ...operator.groupBy.map((group) => group.name),
          ...operator.metrics.map((metric) => metric.name),
        ]);
        break;
      }
      case "path": {
        state = copyBindingState(visit(operator.input));
        state.names.set(operator.binding, operator.binding);
        state.used.add(operator.binding);
        normalized = {
          ...operator,
          start: renameExpressionBindings(operator.start, state),
          target: renameExpressionBindings(operator.target, state),
          binding: operator.binding,
        };
        break;
      }
      case "union":
      case "intersect":
      case "except": {
        const branches = operator.branches.map((branch) => {
          const input = visit(branch.input);
          return {
            ...branch,
            columns: branch.columns.map((column) => ({
              output: column.output,
              input: input.names.get(column.input) ?? column.input,
            })),
          };
        });
        normalized = { ...operator, branches };
        state = outputBindingState(
          operator.branches[0]?.columns.map((column) => column.output) ?? [],
        );
        break;
      }
      case "exists":
      case "notExists": {
        const outer = visit(operator.input);
        const inner = visit(operator.match);
        if (!operator.columns.length)
          throw new TypeError(`${operator.kind} requires correlation columns`);
        if (
          operator.columns.some((column) => !column.outer || !column.inner) ||
          new Set(operator.columns.map((column) => column.outer)).size !==
            operator.columns.length ||
          new Set(operator.columns.map((column) => column.inner)).size !==
            operator.columns.length
        )
          throw new TypeError(`${operator.kind} correlation mapping is invalid`);
        normalized = {
          kind: operator.kind,
          input: operator.input,
          match: operator.match,
          columns: operator.columns.map((column) => ({
            outer: outer.names.get(column.outer) ?? column.outer,
            inner: inner.names.get(column.inner) ?? column.inner,
          })),
        };
        state = copyBindingState(outer);
        break;
      }
    }
    output[id] = normalized;
    states.set(id, state);
    return state;
  };

  visit(root);
  return output;
}

function canonicalizeOperatorIds(
  root: string,
  operators: Record<string, QueryOperator>,
): { root: string; operators: Record<string, QueryOperator> } {
  const signatureMemo = new Map<string, string>();
  const signature = (id: string): string => {
    const previous = signatureMemo.get(id);
    if (previous) return previous;
    const operator = operators[id];
    if (!operator) throw new TypeError(`query operator ${id} is missing`);
    let value: unknown;
    if (
      operator.kind === "union" ||
      operator.kind === "intersect" ||
      operator.kind === "except"
    ) {
      const branches = operator.branches.map((branch) => ({
        input: signature(branch.input),
        columns: branch.columns,
      }));
      if (operator.kind !== "except")
        branches.sort((left, right) => {
          const a = canonicalJson(left);
          const b = canonicalJson(right);
          return a < b ? -1 : a > b ? 1 : 0;
        });
      value = { kind: operator.kind, branches };
    } else if (operator.kind === "exists" || operator.kind === "notExists") {
      value = {
        ...operator,
        input: signature(operator.input),
        match: signature(operator.match),
      };
    } else if (
      operator.kind === "filter" ||
      operator.kind === "project" ||
      operator.kind === "matchFact" ||
      operator.kind === "followRef" ||
      operator.kind === "aggregate" ||
      operator.kind === "path"
    ) {
      value = { ...operator, input: signature(operator.input) };
    } else value = operator;
    const result = canonicalJson(value);
    signatureMemo.set(id, result);
    return result;
  };

  const renamed = new Map<string, string>();
  const output: Record<string, QueryOperator> = {};
  let nextId = 0;
  const move = (id: string): string => {
    const previous = renamed.get(id);
    if (previous) return previous;
    const operator = operators[id];
    if (!operator) throw new TypeError(`query operator ${id} is missing`);
    let normalized: QueryOperator;
    if (
      operator.kind === "union" ||
      operator.kind === "intersect" ||
      operator.kind === "except"
    ) {
      const branches = operator.branches.map((branch) => ({
        ...branch,
        signature: canonicalJson({
          input: signature(branch.input),
          columns: branch.columns,
        }),
      }));
      if (operator.kind !== "except")
        branches.sort((left, right) =>
          left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0,
        );
      normalized = {
        kind: operator.kind,
        branches: branches.map(({ signature: _signature, ...branch }) => ({
          ...branch,
          input: move(branch.input),
        })),
      };
    } else if (operator.kind === "exists" || operator.kind === "notExists") {
      normalized = {
        ...operator,
        input: move(operator.input),
        match: move(operator.match),
      };
    } else if (
      operator.kind === "filter" ||
      operator.kind === "project" ||
      operator.kind === "matchFact" ||
      operator.kind === "followRef" ||
      operator.kind === "aggregate" ||
      operator.kind === "path"
    ) normalized = { ...operator, input: move(operator.input) };
    else normalized = operator;
    const target = `op${nextId++}`;
    renamed.set(id, target);
    output[target] = normalized;
    return target;
  };
  return { root: move(root), operators: output };
}

function normalizeValues(operator: ValuesOperator): ValuesOperator {
  if (!operator.columns.length || new Set(operator.columns).size !== operator.columns.length)
    throw new TypeError("values columns must be non-empty and unique");
  for (const column of operator.columns) safeRecordKey(column);
  const types = { ...operator.types };
  if (
    operator.columns.length * operator.rows.length >
    QUERY_SECURITY_PROFILE.document.maxValuesCells
  )
    throw new TypeError("values operator exceeds its cell limit");
  for (const name of Object.keys(types))
    if (!operator.columns.includes(name))
      throw new TypeError(`values type refers to unknown column ${name}`);
  const rows = operator.rows.map((row) => {
    if (row.length !== operator.columns.length)
      throw new TypeError("values row width does not match its columns");
    assertFiniteNumbers(row);
    operator.columns.forEach((column, index) => {
      const type = types[column];
      const value = row[index];
      if (type && value !== undefined)
        validateParameter(`values.${column}`, type, value);
    });
    return [...row];
  });
  return {
    kind: "values",
    columns: [...operator.columns],
    ...(Object.keys(types).length ? { types } : {}),
    rows,
  };
}

export function normalizeQuery(
  document: QueryDocument,
  values: ParameterValues,
): QueryDocument {
  if (document.schema !== "atlas-query-document-v2")
    throw new TypeError("unsupported query document schema");
  if (
    Object.keys(document.operators).length >
    QUERY_SECURITY_PROFILE.document.maxOperators
  )
    throw new TypeError("query has too many operators");
  safeRecordKey(document.root);
  for (const name of Object.keys(document.operators)) safeRecordKey(name);
  if (
    document.limit !== undefined &&
    document.limit !== null &&
    (!Number.isSafeInteger(document.limit) || document.limit < 0)
  )
    throw new TypeError("limit must be a non-negative integer");
  const orderBy = document.orderBy?.map((term) => {
    if (
      !term.column ||
      (term.direction !== "asc" && term.direction !== "desc") ||
      (term.nulls !== "first" && term.nulls !== "last")
    )
      throw new TypeError("orderBy term is invalid");
    return { ...term, column: safeRecordKey(term.column) };
  }) ?? [];
  for (const name of Object.keys(document.parameters)) {
    safeRecordKey(name, "parameter name");
    if (!Object.hasOwn(values, name))
      throw new TypeError(`parameter ${name} is missing`);
    const value = values[name];
    if (value === undefined) throw new TypeError(`parameter ${name} is missing`);
    validateParameter(name, document.parameters[name] as ParameterType, value);
  }
  for (const name of Object.keys(values))
    if (!Object.hasOwn(document.parameters, name))
      throw new TypeError(`parameter ${name} was not declared`);

  const active = new Set<string>();
  const complete = new Map<string, string>();
  const output: Record<string, QueryOperator> = {};
  let nextId = 0;
  let valuesCells = 0;

  const visit = (sourceId: string): string => {
    const previous = complete.get(sourceId);
    if (previous) return previous;
    if (active.has(sourceId)) throw new TypeError("query operator cycle detected");
    const operator = document.operators[sourceId];
    if (!operator) throw new TypeError(`query operator ${sourceId} is missing`);
    active.add(sourceId);
    const inputs = operatorInputs(operator).map(visit);
    let normalized: QueryOperator;
    switch (operator.kind) {
      case "scan":
        normalized = {
          kind: "scan",
          owner: queryOwner(operator.owner),
          binding: safeRecordKey(operator.binding),
        };
        break;
      case "lookup": {
        if (!operator.binding)
          throw new TypeError("lookup requires one binding");
        const owner = queryOwner(operator.owner);
        const fields = [...new Set(
          operator.fields ?? fieldsWithCapability(owner, "lookup"),
        )].sort() as LookupField[];
        if (!fields.length)
          throw new TypeError("lookup requires at least one field");
        for (const field of fields)
          assertFieldCapability(owner, field, "lookup");
        normalized = {
          kind: "lookup",
          owner,
          binding: safeRecordKey(operator.binding),
          fields,
          text: normalizeExpression(
            operator.text,
            document.parameters,
            values,
          ),
        };
        break;
      }
      case "fullText":
        if (operator.target === "entity") {
          if (!operator.binding)
            throw new TypeError("fullText requires one entity binding");
          const owner = queryOwner(operator.owner);
          assertFieldCapability(owner, operator.field, "fullText");
          normalized = {
            kind: "fullText",
            target: "entity",
            owner,
            binding: safeRecordKey(operator.binding),
            field: operator.field,
            text: normalizeExpression(
              operator.text,
              document.parameters,
              values,
            ),
          } satisfies EntityFullTextOperator;
        } else {
          const definition = QUERY_CONTRACT.facts[operator.factKind];
          if (!definition)
            throw new TypeError(`unknown fact kind ${operator.factKind}`);
          if (!operator.factBinding || Object.values(operator.roles).some((value) => !value))
            throw new TypeError("fact fullText bindings must be non-empty");
          const expectedRoles = Object.keys(definition.roles).sort();
          const roles = Object.keys(operator.roles).sort();
          if (
            roles.length !== expectedRoles.length ||
            roles.some((role, index) => role !== expectedRoles[index])
          )
            throw new TypeError(`fact fullText requires every ${operator.factKind} role`);
          assertFactFieldCapability(operator.factKind, operator.field, "fullText");
          normalized = {
            kind: "fullText",
            target: "fact",
            factKind: operator.factKind,
            factBinding: safeRecordKey(operator.factBinding),
            roles: Object.fromEntries(
              Object.entries(operator.roles).map(([role, binding]) => [
                role,
                safeRecordKey(binding),
              ]),
            ),
            field: operator.field,
            text: normalizeExpression(
              operator.text,
              document.parameters,
              values,
            ),
          } satisfies FactFullTextOperator;
        }
        break;
      case "factLookup": {
        const definition = QUERY_CONTRACT.facts[operator.factKind];
        if (!definition)
          throw new TypeError(`unknown fact kind ${operator.factKind}`);
        if (!operator.factBinding || Object.values(operator.roles).some((value) => !value))
          throw new TypeError("factLookup bindings must be non-empty");
        const expectedRoles = Object.keys(definition.roles).sort();
        const roles = Object.keys(operator.roles).sort();
        if (
          roles.length !== expectedRoles.length ||
          roles.some((role, index) => role !== expectedRoles[index])
        )
          throw new TypeError(`factLookup requires every ${operator.factKind} role`);
        const ref = normalizeExpression(
          operator.ref,
          document.parameters,
          values,
        );
        if (
          ref.kind !== "literal" ||
          typeof ref.value !== "string"
        )
          throw new TypeError("factLookup ref must resolve to a FactRef");
        parseFactRef(ref.value);
        normalized = {
          kind: "factLookup",
          factKind: operator.factKind,
          factBinding: safeRecordKey(operator.factBinding),
          roles: Object.fromEntries(
            Object.entries(operator.roles).map(([role, binding]) => [
              role,
              safeRecordKey(binding),
            ]),
          ),
          ref,
        } satisfies FactLookupOperator;
        break;
      }
      case "values":
        valuesCells += operator.columns.length * operator.rows.length;
        if (valuesCells > QUERY_SECURITY_PROFILE.document.maxValuesCells)
          throw new TypeError("query exceeds its Values cell limit");
        normalized = normalizeValues(operator);
        break;
      case "filter":
        normalized = {
          kind: "filter",
          input: inputs[0] as string,
          predicate: normalizeExpression(
            operator.predicate,
            document.parameters,
            values,
          ),
        } satisfies FilterOperator;
        break;
      case "project": {
        if (
          !operator.columns.length ||
          new Set(operator.columns.map((column) => column.name)).size !==
            operator.columns.length ||
          operator.columns.some((column) => !column.name)
        )
          throw new TypeError("project columns must be non-empty and unique");
        normalized = {
          kind: "project",
          input: inputs[0] as string,
          columns: operator.columns.map((column) => ({
            name: safeRecordKey(column.name),
            value: normalizeExpression(
              column.value,
              document.parameters,
              values,
            ),
          })),
        } satisfies ProjectOperator;
        break;
      }
      case "matchFact":
        if (
          !operator.factBinding ||
          !Object.keys(operator.roles).length ||
          Object.entries(operator.roles).some(([role, binding]) => !role || !binding)
        )
          throw new TypeError("matchFact roles and fact binding must be explicit");
        normalized = {
          kind: "matchFact",
          input: inputs[0] as string,
          factKind: operator.factKind,
          factBinding: safeRecordKey(operator.factBinding),
          roles: Object.fromEntries(
            Object.entries(operator.roles).map(([role, binding]) => [
              role,
              safeRecordKey(binding),
            ]),
          ),
        } satisfies MatchFactOperator;
        break;
      case "followRef":
        if (!operator.anchorBinding || !operator.resultBinding)
          throw new TypeError("followRef bindings must be non-empty");
        if (operator.direction !== "forward" && operator.direction !== "reverse")
          throw new TypeError(`unsupported reference direction ${String(operator.direction)}`);
        queryOwner(operator.referenceOwner);
        assertFieldCapability(operator.referenceOwner, operator.field, "traverse");
        normalized = {
          kind: "followRef",
          input: inputs[0] as string,
          referenceOwner: operator.referenceOwner,
          field: operator.field,
          anchorBinding: safeRecordKey(operator.anchorBinding),
          resultBinding: safeRecordKey(operator.resultBinding),
          direction: operator.direction,
        } satisfies FollowRefOperator;
        break;
      case "aggregate": {
        if (!operator.metrics.length)
          throw new TypeError("aggregate requires at least one metric");
        const names = [
          ...operator.groupBy.map((group) => group.name),
          ...operator.metrics.map((metric) => metric.name),
        ];
        if (names.some((name) => !name) || new Set(names).size !== names.length)
          throw new TypeError("aggregate output names must be non-empty and unique");
        normalized = {
          kind: "aggregate",
          input: inputs[0] as string,
          groupBy: operator.groupBy.map((group) => ({
            name: safeRecordKey(group.name),
            value: normalizeExpression(
              group.value,
              document.parameters,
              values,
            ),
          })),
          metrics: operator.metrics.map((metric) => {
            if (
              metric.function !== "count" &&
              metric.function !== "countDistinct" &&
              metric.function !== "sum" &&
              metric.function !== "min" &&
              metric.function !== "max" &&
              metric.function !== "avg"
            )
              throw new TypeError(
                `unknown aggregate function ${String(metric.function)}`,
              );
            if (metric.function !== "count" && !metric.value)
              throw new TypeError(`${metric.function} requires a value`);
            return {
              name: safeRecordKey(metric.name),
              function: metric.function,
              ...(metric.value
                ? {
                    value: normalizeExpression(
                      metric.value,
                      document.parameters,
                      values,
                    ),
                  }
                : {}),
            };
          }),
        } satisfies AggregateOperator;
        break;
      }
      case "path": {
        if (!operator.binding)
          throw new TypeError("path binding must be non-empty");
        if (operator.policy !== "fewest-hops")
          throw new TypeError(`unsupported path policy ${String(operator.policy)}`);
        if (
          !Number.isSafeInteger(operator.maxHops) ||
          operator.maxHops < 1 ||
          operator.maxHops > QUERY_SECURITY_PROFILE.path.maxHops
        )
          throw new TypeError(
            `path maxHops must be between 1 and ${QUERY_SECURITY_PROFILE.path.maxHops}`,
          );
        if (
          !Number.isSafeInteger(operator.maxPaths) ||
          operator.maxPaths < 1 ||
          operator.maxPaths > QUERY_SECURITY_PROFILE.path.maxPaths
        )
          throw new TypeError(
            `path maxPaths must be between 1 and ${QUERY_SECURITY_PROFILE.path.maxPaths}`,
          );
        if (!operator.traversals.length)
          throw new TypeError("path requires at least one traversal");
        const seenKinds = new Set<string>();
        const traversals = operator.traversals.map((traversal) => {
          const fact = QUERY_CONTRACT.facts[traversal.factKind];
          if (!fact) throw new TypeError(`unknown fact kind ${traversal.factKind}`);
          if (seenKinds.has(traversal.factKind))
            throw new TypeError(`duplicate path traversal ${traversal.factKind}`);
          seenKinds.add(traversal.factKind);
          if (!traversal.rolePairs.length)
            throw new TypeError(`${traversal.factKind} requires a role pair`);
          const pairs = traversal.rolePairs.map((pair) => {
            if (
              pair.from === pair.to ||
              !fact.roles[pair.from] ||
              !fact.roles[pair.to]
            )
              throw new TypeError(
                `invalid ${traversal.factKind} role pair ${pair.from}->${pair.to}`,
              );
            return { ...pair };
          });
          const keys = pairs.map((pair) => `${pair.from}\u0000${pair.to}`);
          if (new Set(keys).size !== keys.length)
            throw new TypeError(`duplicate ${traversal.factKind} role pair`);
          pairs.sort((left, right) => {
            const a = `${left.from}\u0000${left.to}`;
            const b = `${right.from}\u0000${right.to}`;
            return a < b ? -1 : a > b ? 1 : 0;
          });
          return { factKind: traversal.factKind, rolePairs: pairs };
        });
        traversals.sort((left, right) =>
          left.factKind < right.factKind
            ? -1
            : left.factKind > right.factKind
              ? 1
              : 0,
        );
        normalized = {
          kind: "path",
          input: inputs[0] as string,
          start: normalizeExpression(
            operator.start,
            document.parameters,
            values,
          ),
          target: normalizeExpression(
            operator.target,
            document.parameters,
            values,
          ),
          binding: safeRecordKey(operator.binding),
          policy: "fewest-hops",
          maxHops: operator.maxHops,
          maxPaths: operator.maxPaths,
          traversals,
        } satisfies PathOperator;
        break;
      }
      case "union":
      case "intersect":
      case "except": {
        if (operator.branches.length < 2)
          throw new TypeError(`${operator.kind} requires at least two branches`);
        normalized = {
          kind: operator.kind,
          branches: operator.branches.map((branch, index) => {
            if (
              !branch.columns.length ||
              branch.columns.some((column) => !column.output || !column.input) ||
              new Set(branch.columns.map((column) => column.output)).size !==
                branch.columns.length
            )
              throw new TypeError(`${operator.kind} branch mapping is invalid`);
            return {
              input: inputs[index] as string,
              columns: branch.columns.map((column) => ({
                output: safeRecordKey(column.output),
                input: safeRecordKey(column.input),
              })),
            };
          }),
        } satisfies SetOperator;
        break;
      }
      case "exists":
      case "notExists": {
        if (
          !operator.columns.length ||
          operator.columns.some((column) => !column.outer || !column.inner) ||
          new Set(operator.columns.map((column) => column.outer)).size !==
            operator.columns.length ||
          new Set(operator.columns.map((column) => column.inner)).size !==
            operator.columns.length
        )
          throw new TypeError(`${operator.kind} correlation mapping is invalid`);
        normalized = {
          kind: operator.kind,
          input: inputs[0] as string,
          match: inputs[1] as string,
          columns: operator.columns.map((column) => ({
            outer: safeRecordKey(column.outer),
            inner: safeRecordKey(column.inner),
          })),
        } satisfies ExistsOperator;
        break;
      }
    }
    active.delete(sourceId);
    const targetId = `op${nextId++}`;
    complete.set(sourceId, targetId);
    output[targetId] = normalized;
    return targetId;
  };

  const root = visit(document.root);
  const stable = canonicalizeOperatorIds(
    root,
    canonicalizeBindings(root, output),
  );
  const normalized: QueryDocument = {
    schema: "atlas-query-document-v2",
    root: stable.root,
    parameters: {},
    operators: stable.operators,
    distinct: document.distinct === true,
    orderBy,
    limit: document.limit ?? null,
  };
  validateQuery(normalized);
  return normalized;
}

export async function queryDigest(document: QueryDocument): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(document));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
