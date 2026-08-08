import { normalizeBundle, type QueryBundle, type QuerySection } from "./bundle";
import { canonicalJson } from "./canonical";
import {
  QUERY_CONTRACT,
  fieldsWithCapability,
  parseEntityRef,
  type Owner,
  type QueryFactKind,
} from "./contract";
import type { QueryOperator } from "./document";
import { QUERY_SECURITY_PROFILE } from "./security";

const OWNER_LABEL: Record<Owner, string> = {
  subject: "作品",
  person: "人物",
  character: "角色",
  episode: "分集",
};

export type QueryRecipe =
  | { kind: "fullText"; text: string }
  | { kind: "common"; from: string; to: string }
  | {
      kind: "path";
      from: string;
      to: string;
      maxHops: number;
      maxPaths: number;
    };

function sameBundle(left: QueryBundle, right: QueryBundle): boolean {
  return canonicalJson(normalizeBundle(left)) === canonicalJson(normalizeBundle(right));
}

/** Recover a built-in semantic recipe only when it reproduces the bundle exactly. */
export function decompileQueryRecipe(bundle: QueryBundle): QueryRecipe | null {
  const normalized = normalizeBundle(bundle);
  const entityRefs = new Set<string>();
  let text: string | null = null;
  let path: Extract<QueryOperator, { kind: "path" }> | null = null;
  let pathInput: Extract<QueryOperator, { kind: "values" }> | null = null;

  for (const section of Object.values(normalized.sections)) {
    for (const operator of Object.values(section.query.operators)) {
      if (
        operator.kind === "fullText" && operator.text.kind === "literal" &&
        typeof operator.text.value === "string"
      ) text ??= operator.text.value;
      if (operator.kind === "values") {
        for (const row of operator.rows)
          for (const value of row)
            if (typeof value === "string" && /^(?:subject|person|character|episode):(?:0|[1-9][0-9]*)$/.test(value))
              entityRefs.add(value);
      }
      if (operator.kind === "path") {
        path = operator;
        const input = section.query.operators[operator.input];
        if (input?.kind === "values") pathInput = input;
      }
    }
  }

  if (path && pathInput && path.start.kind === "column" && path.target.kind === "column") {
    const startIndex = pathInput.columns.indexOf(path.start.name);
    const targetIndex = pathInput.columns.indexOf(path.target.name);
    const from = pathInput.rows[0]?.[startIndex];
    const to = pathInput.rows[0]?.[targetIndex];
    if (typeof from === "string" && typeof to === "string") {
      try {
        const candidate = pathRecipe(
          from as `${Owner}:${number}`,
          to as `${Owner}:${number}`,
          { maxHops: path.maxHops, maxPaths: path.maxPaths },
        );
        if (sameBundle(candidate, normalized)) return {
          kind: "path",
          from,
          to,
          maxHops: path.maxHops,
          maxPaths: path.maxPaths,
        };
      } catch {
        // A non-recipe plan remains available through the structural bundle view.
      }
    }
  }

  if (text !== null) {
    try {
      if (sameBundle(fullTextRecipe(text), normalized))
        return { kind: "fullText", text };
    } catch {
      // A partial or customized full-text bundle is not the built-in recipe.
    }
  }

  if (entityRefs.size === 2) {
    const [from, to] = [...entityRefs];
    for (const [left, right] of from && to ? [[from, to], [to, from]] as const : []) {
      try {
        if (sameBundle(
          comparisonRecipe(left as `${Owner}:${number}`, right as `${Owner}:${number}`),
          normalized,
        )) return { kind: "common", from: left, to: right };
      } catch {
        // Invalid references cannot form a comparison recipe.
      }
    }
  }
  return null;
}

/** Search every published long-text family without merging unlike result rows. */
export function fullTextRecipe(text: string): QueryBundle {
  const needle = text.trim();
  if (!needle) throw new TypeError("请输入要搜索的正文");
  const sections: Record<string, QuerySection> = {};
  for (const owner of Object.keys(QUERY_CONTRACT.owners) as Owner[]) {
    for (const field of fieldsWithCapability(owner, "fullText")) {
      const binding = "entity";
      sections[`${owner}-${field}`] = {
        query: {
          schema: "atlas-query-document-v2",
          root: "project",
          parameters: {},
          operators: {
            source: {
              kind: "fullText",
              target: "entity",
              owner,
              binding,
              field: field as "summary" | "description",
              text: { kind: "literal", value: needle },
            },
            project: {
              kind: "project",
              input: "source",
              columns: [
                { name: "ref", value: { kind: "field", binding, field: "ref" } },
                { name: "name", value: { kind: "field", binding, field: "name" } },
                ...(QUERY_CONTRACT.owners[owner].fields.nameCn
                  ? [{
                      name: "nameCn",
                      value: { kind: "field" as const, binding, field: "nameCn" },
                    }]
                  : []),
              ],
            },
          },
          limit: 200,
        },
        answer: {
          shape: "entity-list",
          title: `${OWNER_LABEL[owner]}${field === "description" ? "介绍" : "简介"}`,
        },
      };
    }
  }
  for (const [factKind, fact] of Object.entries(QUERY_CONTRACT.facts) as [
    QueryFactKind,
    (typeof QUERY_CONTRACT.facts)[QueryFactKind],
  ][]) {
    for (const [field, definition] of Object.entries(fact.fields)) {
      if (!definition.capabilities.includes("fullText")) continue;
      const roles = Object.fromEntries(
        Object.keys(fact.roles).map((role) => [role, role]),
      );
      const operators: Record<string, QueryOperator> = {
        source: {
          kind: "fullText",
          target: "fact",
          factKind,
          factBinding: "fact",
          roles,
          field: field as "summary",
          text: { kind: "literal", value: needle },
        },
        project: {
          kind: "project",
          input: "source",
          columns: [
            { name: "fact", value: { kind: "column", name: "fact" } },
            ...Object.values(roles).map((binding) => ({
              name: binding,
              value: { kind: "column" as const, name: binding },
            })),
          ],
        },
      };
      sections[`${factKind}-${field}`] = {
        query: {
          schema: "atlas-query-document-v2",
          root: "project",
          parameters: {},
          operators,
          limit: 200,
        },
        answer: { shape: "fact-list", title: `${factKind} 备注` },
      };
    }
  }
  return normalizeBundle({
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections,
  });
}

export function comparisonRecipe(
  left: `${Owner}:${number}`,
  right: `${Owner}:${number}`,
): QueryBundle {
  parseEntityRef(left);
  parseEntityRef(right);
  return normalizeBundle({
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: {
      all: comparisonSection("全部关联", "union", left, right),
      common: comparisonSection("共同关联", "intersect", left, right),
      leftOnly: comparisonSection("仅左侧关联", "except", left, right),
      rightOnly: comparisonSection("仅右侧关联", "except", right, left),
    },
  });
}

export function pathRecipe(
  start: `${Owner}:${number}`,
  target: `${Owner}:${number}`,
  options: { maxHops?: number; maxPaths?: number } = {},
): QueryBundle {
  const startOwner = parseEntityRef(start).owner;
  const targetOwner = parseEntityRef(target).owner;
  if (startOwner === "episode" || targetOwner === "episode")
    throw new TypeError("episode cannot be a path endpoint");
  const maxHops = options.maxHops ?? 6;
  const maxPaths = options.maxPaths ?? 10;
  if (
    !Number.isSafeInteger(maxHops) ||
    maxHops < 1 ||
    maxHops > QUERY_SECURITY_PROFILE.path.maxHops ||
    !Number.isSafeInteger(maxPaths) ||
    maxPaths < 1 ||
    maxPaths > QUERY_SECURITY_PROFILE.path.maxPaths
  )
    throw new TypeError("path query exceeds the security profile");
  return normalizeBundle({
    schema: "atlas-query-bundle-v2",
    release: { policy: "latest" },
    sections: {
      paths: {
        query: {
          schema: "atlas-query-document-v2",
          root: "path",
          parameters: {},
          operators: {
            endpoints: {
              kind: "values",
              columns: ["start", "target"],
              types: {
                start: `entity:${startOwner}`,
                target: `entity:${targetOwner}`,
              },
              rows: [[start, target]],
            },
            path: {
              kind: "path",
              input: "endpoints",
              start: { kind: "column", name: "start" },
              target: { kind: "column", name: "target" },
              binding: "path",
              policy: "fewest-hops",
              maxHops,
              maxPaths,
              traversals: pathTraversals(),
            },
          },
          limit: maxPaths,
        },
        answer: { shape: "path-list", title: "关系路径" },
      },
    },
  });
}

interface RelationTraversal {
  factKind: QueryFactKind;
  anchorRole: string;
  otherRoles: string[];
}

function relationsFor(owner: Owner): RelationTraversal[] {
  const result: RelationTraversal[] = [];
  for (const [factKind, fact] of Object.entries(QUERY_CONTRACT.facts) as [
    QueryFactKind,
    (typeof QUERY_CONTRACT.facts)[QueryFactKind],
  ][])
    for (const [anchorRole, roleOwner] of Object.entries(fact.roles))
      if (roleOwner === owner)
        result.push({
          factKind,
          anchorRole,
          otherRoles: Object.keys(fact.roles).filter((role) => role !== anchorRole),
        });
  return result;
}

function anchorOperator(ref: `${Owner}:${number}`): QueryOperator {
  const owner = parseEntityRef(ref).owner;
  return {
    kind: "values",
    columns: ["anchor"],
    types: { anchor: `entity:${owner}` },
    rows: [[ref]],
  };
}

function neighborSet(
  prefix: string,
  anchor: `${Owner}:${number}`,
  operators: Record<string, QueryOperator>,
): string {
  const branches: { input: string; columns: { output: string; input: string }[] }[] = [];
  let index = 0;
  for (const relation of relationsFor(parseEntityRef(anchor).owner))
    for (const otherRole of relation.otherRoles) {
      const sourceId = `${prefix}-anchor-${index}`;
      const expandId = `${prefix}-expand-${index}`;
      const projectId = `${prefix}-project-${index}`;
      const neighborBinding = `${prefix}-neighbor-${index}`;
      operators[sourceId] = anchorOperator(anchor);
      operators[expandId] = {
        kind: "matchFact",
        input: sourceId,
        factKind: relation.factKind,
        factBinding: `${prefix}-fact-${index}`,
        roles: {
          [relation.anchorRole]: "anchor",
          [otherRole]: neighborBinding,
        },
      };
      operators[projectId] = {
        kind: "project",
        input: expandId,
        columns: [
          {
            name: "ref",
            value: { kind: "field", binding: neighborBinding, field: "ref" },
          },
          {
            name: "name",
            value: { kind: "field", binding: neighborBinding, field: "name" },
          },
        ],
      };
      branches.push({
        input: projectId,
        columns: [
          { output: "ref", input: "ref" },
          { output: "name", input: "name" },
        ],
      });
      index++;
    }
  const root = `${prefix}-relations`;
  operators[root] = { kind: "union", branches };
  return root;
}

function comparisonSection(
  title: string,
  kind: "union" | "intersect" | "except",
  left: `${Owner}:${number}`,
  right: `${Owner}:${number}`,
): QuerySection {
  const operators: Record<string, QueryOperator> = {};
  const leftRoot = neighborSet("left", left, operators);
  const rightRoot = neighborSet("right", right, operators);
  operators.result = {
    kind,
    branches: [leftRoot, rightRoot].map((input) => ({
      input,
      columns: [
        { output: "ref", input: "ref" },
        { output: "name", input: "name" },
      ],
    })),
  };
  return {
    query: {
      schema: "atlas-query-document-v2",
      root: "result",
      parameters: {},
      operators,
      limit: 500,
    },
    answer: { shape: "field-comparison", title },
  };
}

function pathTraversals(): Extract<QueryOperator, { kind: "path" }>["traversals"] {
  return (Object.entries(QUERY_CONTRACT.facts) as [
    QueryFactKind,
    (typeof QUERY_CONTRACT.facts)[QueryFactKind],
  ][]).map(([factKind, fact]) => {
    const roles = Object.keys(fact.roles);
    return {
      factKind,
      rolePairs: roles.flatMap((from) =>
        roles.filter((to) => to !== from).map((to) => ({ from, to })),
      ),
    };
  });
}
