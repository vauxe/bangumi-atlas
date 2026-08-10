import assert from "node:assert/strict";
import { test } from "node:test";

import { QUERY_CONTRACT, type Owner, type QueryFactKind } from "../src/query/contract";
import { createEntityCondition, createFactCondition } from "../src/query/edit";
import {
  compileExplorerQuery,
  decompileExplorerQuery,
  type ExplorerCondition,
  type ExplorerRelation,
} from "../src/query/explorer";
import { conditionEditorOperatorChoices } from "../src/query/query-bar";
import { validateQuery } from "../src/query/validate";
import {
  enumValuesFor,
  factEnumValues,
  queryConditionOperators,
  queryFactConditionOperators,
  queryFactDiscriminatorField,
  queryFactFields,
  queryFilterFields,
  queryRelationOptions,
  queryScalarInputType,
} from "../src/query/workbench-model";

const OWNERS = Object.keys(QUERY_CONTRACT.owners) as Owner[];
const FACT_KINDS = Object.keys(QUERY_CONTRACT.facts) as QueryFactKind[];
const VALUELESS = new Set(["isNull", "isNotNull", "isMissing", "isPresent"]);
const MULTI_VALUE = new Set(["in", "notIn"]);

function rawValue(type: string, operator: string): string {
  if (VALUELESS.has(operator)) return "";
  const owner = type.startsWith("entity:") ? type.slice("entity:".length) : null;
  const values = owner
    ? [`${owner}:1`, `${owner}:2`]
    : type === "boolean"
      ? ["true", "false"]
      : type === "integer"
        ? ["1", "2"]
        : type === "number"
          ? ["1.5", "2.5"]
          : ["测试", "示例"];
  return MULTI_VALUE.has(operator) ? values.join("、") : values[0]!;
}

function assertExecutableCondition(
  owner: Owner,
  condition: ExplorerCondition,
  label: string,
): void {
  const bundle = compileExplorerQuery({ owner, condition, columns: ["ref"] });
  const section = bundle.sections.results;
  assert.ok(section, `${label} did not produce a result section`);
  assert.doesNotThrow(() => validateQuery(section.query), label);
  assert.deepEqual(decompileExplorerQuery(bundle)?.condition, condition, label);
}

function completeRelation(
  kind: QueryFactKind,
  candidateRole: string,
  relatedRole: string,
  exists: boolean,
  condition?: ExplorerCondition,
): { owner: Owner; relation: ExplorerRelation } {
  const roles = QUERY_CONTRACT.facts[kind].roles;
  const owner = roles[candidateRole]!;
  const relatedOwner = roles[relatedRole];
  if (!relatedOwner) throw new TypeError(`${kind}.${relatedRole} is not a fact role`);
  const additionalEndpoints = Object.entries(roles)
    .filter(([role]) => role !== candidateRole && role !== relatedRole)
    .map(([role, contextOwner], index) => ({
      role,
      related: `${contextOwner}:${index + 2}` as const,
    }));
  return {
    owner,
    relation: {
      factKind: kind,
      candidateRole,
      relatedRole,
      related: `${relatedOwner}:1`,
      ...(additionalEndpoints.length ? { additionalEndpoints } : {}),
      exists,
      ...(condition ? { condition } : {}),
    },
  };
}

test("every editable entity field and operator compiles and round-trips", () => {
  for (const owner of OWNERS) {
    for (const field of queryFilterFields(owner)) {
      const definition = QUERY_CONTRACT.owners[owner].fields[field]!;
      const operators = queryConditionOperators(owner, field);
      assert.ok(operators.length, `${owner}.${field} has no editable operators`);

      for (const operator of operators) {
        const label = `${owner}.${field} ${operator}`;
        const condition = createEntityCondition(
          owner,
          field,
          operator,
          rawValue(definition.type, operator),
        );
        assertExecutableCondition(owner, condition, label);

        const values = enumValuesFor(owner, field);
        const visible = conditionEditorOperatorChoices(
          operators,
          queryScalarInputType(owner, field),
          operator,
          values ? Object.keys(values).length : 0,
        );
        assert.ok(visible.includes(operator), `${label} cannot be restored in the editor`);
      }
    }
  }
});

test("every relationship field operator compiles and round-trips on a complete fact", () => {
  for (const kind of FACT_KINDS) {
    const roles = Object.entries(QUERY_CONTRACT.facts[kind].roles);
    const [candidate, related] = roles;
    assert.ok(candidate && related, `${kind} needs at least two roles`);

    for (const field of queryFactFields(kind, "filter")) {
      const definition = QUERY_CONTRACT.facts[kind].fields[field]!;
      const operators = queryFactConditionOperators(kind, field);
      assert.ok(operators.length, `${kind}.${field} has no editable operators`);

      for (const operator of operators) {
        const label = `${kind}.${field} ${operator}`;
        const condition = createFactCondition(
          kind,
          field,
          operator,
          rawValue(definition.type, operator),
        );
        const { owner, relation } = completeRelation(
          kind,
          candidate[0],
          related[0],
          true,
          condition,
        );
        const bundle = compileExplorerQuery({
          owner,
          relations: [relation],
          columns: ["ref"],
        });
        const section = bundle.sections.results;
        assert.ok(section, `${label} did not produce a result section`);
        assert.doesNotThrow(() => validateQuery(section.query), label);
        assert.deepEqual(
          decompileExplorerQuery(bundle)?.relations?.[0]?.condition,
          condition,
          label,
        );
      }
    }
  }
});

test("every relationship direction supports both inclusion and exclusion", () => {
  for (const owner of OWNERS) {
    for (const option of queryRelationOptions(owner)) {
      for (const exists of [true, false]) {
        const label = `${option.value} exists=${exists}`;
        const complete = completeRelation(
          option.factKind,
          option.candidateRole,
          option.relatedRole,
          exists,
        );
        assert.equal(complete.owner, owner, label);
        const bundle = compileExplorerQuery({
          owner,
          relations: [complete.relation],
          columns: ["ref"],
        });
        const section = bundle.sections.results;
        assert.ok(section, `${label} did not produce a result section`);
        assert.doesNotThrow(() => validateQuery(section.query), label);
        assert.deepEqual(
          decompileExplorerQuery(bundle)?.relations?.[0],
          complete.relation,
          label,
        );
      }
    }
  }
});

test("every non-name relationship attribute has a direct readable value control", () => {
  for (const kind of FACT_KINDS) {
    const discriminator = queryFactDiscriminatorField(kind);
    for (const field of queryFactFields(kind, "filter")) {
      if (field === discriminator) continue;
      assert.ok(
        factEnumValues(kind, field),
        `${kind}.${field} would disappear from the simplified relationship editor`,
      );
    }
  }
});
