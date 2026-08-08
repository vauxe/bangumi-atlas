import { canonicalJson } from "./canonical";
import { QUERY_CONTRACT, type Owner, type QueryFactKind } from "./contract";
import type { Expression, QueryDocument, QueryOperator } from "./document";

export interface CoverageSet {
  schema: "atlas-coverage-v1";
  atoms: string[];
  digest: string;
}

type BindingType = `entity:${Owner}` | `fact:${QueryFactKind}` | "value" | "path";
type BindingSchema = Record<string, BindingType>;

function inputs(operator: QueryOperator): string[] {
  if (
    operator.kind === "union" ||
    operator.kind === "intersect" ||
    operator.kind === "except"
  )
    return operator.branches.map((branch) => branch.input);
  if (operator.kind === "exists" || operator.kind === "notExists")
    return [operator.input, operator.match];
  if (
    operator.kind === "filter" ||
    operator.kind === "project" ||
    operator.kind === "matchFact" ||
    operator.kind === "followRef" ||
    operator.kind === "aggregate" ||
    operator.kind === "path"
  )
    return [operator.input];
  return [];
}

function addExpressionAtoms(
  expression: Expression,
  schema: BindingSchema,
  atoms: Set<string>,
): void {
  switch (expression.kind) {
    case "literal":
    case "parameter":
    case "column":
      return;
    case "field": {
      const binding = schema[expression.binding];
      if (binding?.startsWith("entity:"))
        atoms.add(`field:${binding.slice(7)}.${expression.field}`);
      else if (binding?.startsWith("fact:"))
        atoms.add(`fact-field:${binding.slice(5)}.${expression.field}`);
      return;
    }
    case "compare":
      addExpressionAtoms(expression.left, schema, atoms);
      addExpressionAtoms(expression.right, schema, atoms);
      return;
    case "and":
    case "or":
      for (const term of expression.terms)
        addExpressionAtoms(term, schema, atoms);
      return;
    case "not":
    case "isNull":
    case "isMissing":
      addExpressionAtoms(expression.term, schema, atoms);
  }
}

async function digestAtoms(atoms: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(atoms));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function coverageFor(document: QueryDocument): Promise<CoverageSet> {
  const atoms = new Set<string>();
  const schemas = new Map<string, BindingSchema>();
  const visiting = new Set<string>();
  const schemaFor = (id: string): BindingSchema => {
    const previous = schemas.get(id);
    if (previous) return previous;
    if (visiting.has(id)) throw new TypeError("coverage encountered an operator cycle");
    const operator = document.operators[id];
    if (!operator) throw new TypeError(`query operator ${id} is missing`);
    visiting.add(id);
    for (const input of inputs(operator)) schemaFor(input);
    let schema: BindingSchema;
    switch (operator.kind) {
      case "scan":
        atoms.add(`entity:${operator.owner}`);
        schema = { [operator.binding]: `entity:${operator.owner}` };
        break;
      case "lookup":
        atoms.add(`entity:${operator.owner}`);
        for (const field of operator.fields ?? ["name"])
          atoms.add(`lookup:${operator.owner}.${field}`);
        addExpressionAtoms(operator.text, {}, atoms);
        schema = { [operator.binding]: `entity:${operator.owner}` };
        break;
      case "fullText":
        addExpressionAtoms(operator.text, {}, atoms);
        if (operator.target === "entity") {
          atoms.add(`entity:${operator.owner}`);
          atoms.add(`fullText:${operator.owner}.${operator.field}`);
          schema = { [operator.binding]: `entity:${operator.owner}` };
        } else {
          const fact = QUERY_CONTRACT.facts[operator.factKind];
          atoms.add(`fact:${operator.factKind}`);
          atoms.add(`fullText:${operator.factKind}.${operator.field}`);
          schema = { [operator.factBinding]: `fact:${operator.factKind}` };
          for (const [role, binding] of Object.entries(operator.roles)) {
            const owner = fact.roles[role];
            if (!owner)
              throw new TypeError(`coverage encountered an unknown ${operator.factKind} role`);
            atoms.add(`entity:${owner}`);
            schema[binding] = `entity:${owner}`;
          }
        }
        break;
      case "factLookup": {
        const fact = QUERY_CONTRACT.facts[operator.factKind];
        atoms.add(`fact:${operator.factKind}`);
        atoms.add("identity:FactRef");
        addExpressionAtoms(operator.ref, {}, atoms);
        schema = { [operator.factBinding]: `fact:${operator.factKind}` };
        for (const [role, binding] of Object.entries(operator.roles)) {
          const owner = fact.roles[role];
          if (!owner)
            throw new TypeError(`coverage encountered an unknown ${operator.factKind} role`);
          atoms.add(`entity:${owner}`);
          schema[binding] = `entity:${owner}`;
        }
        break;
      }
      case "values":
        schema = Object.fromEntries(
          operator.columns.map((column) => [
            column,
            operator.types?.[column]?.startsWith("entity:")
              ? operator.types[column] as `entity:${Owner}`
              : "value",
          ]),
        );
        break;
      case "filter":
        schema = schemas.get(operator.input) as BindingSchema;
        addExpressionAtoms(operator.predicate, schema, atoms);
        break;
      case "project": {
        const input = schemas.get(operator.input) as BindingSchema;
        for (const column of operator.columns)
          addExpressionAtoms(column.value, input, atoms);
        schema = Object.fromEntries(operator.columns.map((column) => [column.name, "value"]));
        break;
      }
      case "matchFact": {
        const input = schemas.get(operator.input) as BindingSchema;
        const fact = QUERY_CONTRACT.facts[operator.factKind];
        atoms.add(`fact:${operator.factKind}`);
        schema = { ...input, [operator.factBinding]: `fact:${operator.factKind}` };
        for (const [role, binding] of Object.entries(operator.roles)) {
          const owner = fact.roles[role];
          if (owner) {
            atoms.add(`entity:${owner}`);
            schema[binding] = `entity:${owner}`;
          }
        }
        break;
      }
      case "followRef": {
        const input = schemas.get(operator.input) as BindingSchema;
        const definition = QUERY_CONTRACT.owners[operator.referenceOwner]
          .fields[operator.field];
        if (!definition?.type.startsWith("entity:"))
          throw new TypeError("coverage encountered an invalid reference field");
        const targetOwner = definition.type.slice(7) as Owner;
        atoms.add(`field:${operator.referenceOwner}.${operator.field}`);
        atoms.add(`entity:${operator.referenceOwner}`);
        atoms.add(`entity:${targetOwner}`);
        schema = {
          ...input,
          [operator.resultBinding]: operator.direction === "forward"
            ? `entity:${targetOwner}`
            : `entity:${operator.referenceOwner}`,
        };
        break;
      }
      case "aggregate": {
        const input = schemas.get(operator.input) as BindingSchema;
        for (const group of operator.groupBy)
          addExpressionAtoms(group.value, input, atoms);
        for (const metric of operator.metrics)
          if (metric.value) addExpressionAtoms(metric.value, input, atoms);
        schema = Object.fromEntries([
          ...operator.groupBy.map((group) => [group.name, "value"] as const),
          ...operator.metrics.map((metric) => [metric.name, "value"] as const),
        ]);
        break;
      }
      case "path": {
        const input = schemas.get(operator.input) as BindingSchema;
        addExpressionAtoms(operator.start, input, atoms);
        addExpressionAtoms(operator.target, input, atoms);
        for (const traversal of operator.traversals)
          atoms.add(`fact:${traversal.factKind}`);
        schema = { ...input, [operator.binding]: "path" };
        break;
      }
      case "union":
      case "intersect":
      case "except":
        schema = Object.fromEntries(
          (operator.branches[0]?.columns ?? []).map((column) => [column.output, "value"]),
        );
        break;
      case "exists":
      case "notExists":
        schema = schemas.get(operator.input) as BindingSchema;
        break;
    }
    visiting.delete(id);
    schemas.set(id, schema);
    return schema;
  };
  schemaFor(document.root);
  for (const term of document.orderBy ?? []) atoms.add(`order:${term.column}`);
  const sorted = [...atoms].sort();
  return {
    schema: "atlas-coverage-v1",
    atoms: sorted,
    digest: await digestAtoms(sorted),
  };
}
