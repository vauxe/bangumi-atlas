import {
  QUERY_CONTRACT,
  parseEntityRef,
  type Owner,
  type QueryFactKind,
} from "./contract";
import type {
  AggregateFunction,
  Expression,
  ParameterType,
  QueryDocument,
  QueryOperator,
} from "./document";
import type { CompareOperator } from "./value";

const MAX_SOURCE_LENGTH = 16_384;
const MAX_TOKENS = 4_096;

type TokenKind = "word" | "number" | "string" | "parameter" | "symbol" | "eof";
interface Token {
  kind: TokenKind;
  text: string;
  value?: string | number;
  start: number;
  end: number;
}

export class AtlasCypherError extends TypeError {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
    this.name = "AtlasCypherError";
  }
}

export class AtlasQueryError extends TypeError {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
    this.name = "AtlasQueryError";
  }
}

function tokenize(source: string, dialect: "cypher" | "query" = "cypher"): Token[] {
  const fail = (message: string, start: number, end: number): never => {
    throw dialect === "query"
      ? new AtlasQueryError(message, start, end)
      : new AtlasCypherError(message, start, end);
  };
  if (source.length > MAX_SOURCE_LENGTH)
    fail(`${dialect === "query" ? "Atlas Query" : "Atlas Cypher"} 输入过长`, 0, source.length);
  const tokens: Token[] = [];
  let at = 0;
  const push = (token: Token): void => {
    tokens.push(token);
    if (tokens.length > MAX_TOKENS)
      fail(`${dialect === "query" ? "Atlas Query" : "Atlas Cypher"} token 过多`, token.start, token.end);
  };
  while (at < source.length) {
    const char = source[at] as string;
    if (/\s/u.test(char)) {
      at++;
      continue;
    }
    const start = at;
    if (/[A-Za-z_]/.test(char)) {
      at++;
      while (at < source.length && /[A-Za-z0-9_]/.test(source[at] as string)) at++;
      const text = source.slice(start, at);
      push({ kind: "word", text, value: text, start, end: at });
      continue;
    }
    if (char === "$" && /[A-Za-z_]/.test(source[at + 1] ?? "")) {
      at += 2;
      while (at < source.length && /[A-Za-z0-9_]/.test(source[at] as string)) at++;
      const text = source.slice(start + 1, at);
      push({ kind: "parameter", text, value: text, start, end: at });
      continue;
    }
    if (/\d/.test(char)) {
      at++;
      while (at < source.length && /\d/.test(source[at] as string)) at++;
      if (source[at] === "." && /\d/.test(source[at + 1] ?? "")) {
        at++;
        while (at < source.length && /\d/.test(source[at] as string)) at++;
      }
      const text = source.slice(start, at);
      const value = Number(text);
      if (!Number.isFinite(value))
        fail("数字必须是有限值", start, at);
      push({ kind: "number", text, value, start, end: at });
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      at++;
      let value = "";
      let closed = false;
      while (at < source.length) {
        const next = source[at] as string;
        if (next === quote) {
          at++;
          closed = true;
          break;
        }
        if (next === "\\") {
          const escaped = source[++at];
          if (escaped === undefined) break;
          const replacements: Record<string, string> = {
            n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"',
          };
          value += replacements[escaped] ?? escaped;
          at++;
        } else {
          value += next;
          at++;
        }
      }
      if (!closed) fail("字符串没有结束引号", start, at);
      push({ kind: "string", text: source.slice(start, at), value, start, end: at });
      continue;
    }
    const two = source.slice(at, at + 2);
    if (["->", "<-", ">=", "<=", "<>", "!="].includes(two)) {
      at += 2;
      push({ kind: "symbol", text: two, start, end: at });
      continue;
    }
    if ("()[]{},:.*-=<>;".includes(char)) {
      at++;
      push({ kind: "symbol", text: char, start, end: at });
      continue;
    }
    fail(`不支持的字符 ${char}`, start, start + 1);
  }
  tokens.push({ kind: "eof", text: "", start: at, end: at });
  return tokens;
}

interface NodePattern { kind: "node"; variable: string; owner: Owner }
interface EdgePattern {
  kind: "edge";
  left: NodePattern;
  variable: string;
  factKind: QueryFactKind;
  right: NodePattern;
}
interface FactPattern {
  kind: "fact";
  variable: string;
  factKind: QueryFactKind;
  roles: Record<string, string>;
}
type Pattern = NodePattern | EdgePattern | FactPattern;

type AstValue =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "parameter"; name: string }
  | { kind: "variable"; name: string }
  | { kind: "field"; variable: string; field: string };
type AstPredicate =
  | AstValue
  | { kind: "compare"; operator: CompareOperator; left: AstValue; right: AstValue }
  | { kind: "in"; value: AstValue; values: AstValue[] }
  | { kind: "and" | "or"; terms: AstPredicate[] }
  | { kind: "not"; term: AstPredicate }
  | { kind: "isNull" | "isMissing"; term: AstValue }
  | {
      kind: "exists";
      negated: boolean;
      patterns: Pattern[];
      where?: AstPredicate;
    };
interface ReturnItem {
  alias: string;
  value?: AstValue;
  aggregate?: { function: AggregateFunction; value?: AstValue };
}
interface ParsedQuery {
  patterns: Pattern[];
  searches?: { text: AstValue; field?: string }[];
  where?: AstPredicate;
  distinct: boolean;
  returns: ReturnItem[];
  groupBy?: AstValue[];
  having?: AstPredicate;
  orderBy: { column: string; direction: "asc" | "desc"; nulls: "first" | "last" }[];
  limit: number | null;
  parameters: Set<string>;
}

const OWNER_BY_NAME: Record<string, Owner> = {
  subject: "subject", person: "person", character: "character", episode: "episode",
};
const FACT_KINDS = new Set(Object.keys(QUERY_CONTRACT.facts));
const BINARY_ROLES: Partial<Record<QueryFactKind, [string, string]>> = {
  RELATES_TO: ["source", "target"],
  WORKED_ON: ["person", "subject"],
  APPEARS_IN: ["character", "subject"],
  PERSON_REL: ["source", "target"],
  CHARACTER_REL: ["source", "target"],
};

class Parser {
  private index = 0;
  private readonly parameters = new Set<string>();
  private readonly bindings = new Set<string>();
  private rootVariable = "";
  private valueScope: "query" | "result" = "query";
  private generatedFacts = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly dialect: "cypher" | "query" = "cypher",
  ) {}

  parse(): ParsedQuery {
    return this.dialect === "query" ? this.parseAtlasQuery() : this.parseCypher();
  }

  private parseCypher(): ParsedQuery {
    this.expectWord("MATCH");
    const patterns = [this.pattern()];
    while (this.accept(",")) patterns.push(this.pattern());
    const where = this.acceptWord("WHERE") ? this.or() : undefined;
    this.expectWord("RETURN");
    const distinct = this.acceptWord("DISTINCT");
    const returns = [this.returnItem()];
    while (this.accept(",")) returns.push(this.returnItem());
    const { orderBy, limit } = this.tail();
    this.finish();
    return { patterns, ...(where ? { where } : {}), distinct, returns, orderBy, limit, parameters: this.parameters };
  }

  private parseAtlasQuery(): ParsedQuery {
    this.expectWord("FIND");
    const type = this.identifier().toLowerCase();
    const owner = OWNER_BY_NAME[type];
    if (!owner) this.fail(`未知实体类型 ${type}`, this.previous());
    this.rootVariable = this.acceptWord("AS") ? this.identifier() : "item";
    this.bindings.add(this.rootVariable);
    const patterns: Pattern[] = [{ kind: "node", variable: this.rootVariable, owner }];

    const searches: NonNullable<ParsedQuery["searches"]> = [];
    while (this.acceptWord("SEARCH")) {
      const text = this.value();
      if (text.kind !== "literal" && text.kind !== "parameter")
        this.fail("SEARCH 需要字符串或参数", this.previous());
      const field = this.acceptWord("IN") ? this.identifier() : undefined;
      searches.push({ text, ...(field ? { field } : {}) });
    }
    while (this.acceptWord("MATCH")) patterns.push(this.queryFactPattern());
    const where = this.acceptWord("WHERE") ? this.or() : undefined;
    this.expectWord("RETURN");
    const distinct = this.acceptWord("DISTINCT");
    const returns = [this.returnItem(false)];
    while (this.accept(",")) returns.push(this.returnItem(false));

    let groupBy: AstValue[] | undefined;
    if (this.acceptWord("GROUP")) {
      this.expectWord("BY");
      groupBy = [this.value()];
      while (this.accept(",")) groupBy.push(this.value());
    }
    let having: AstPredicate | undefined;
    if (this.acceptWord("HAVING")) {
      this.valueScope = "result";
      having = this.or();
      this.valueScope = "query";
    }
    const { orderBy, limit } = this.tail();
    this.finish();
    return {
      patterns,
      ...(searches.length ? { searches } : {}),
      ...(where ? { where } : {}),
      distinct,
      returns,
      ...(groupBy ? { groupBy } : {}),
      ...(having ? { having } : {}),
      orderBy,
      limit,
      parameters: this.parameters,
    };
  }

  private tail(): Pick<ParsedQuery, "orderBy" | "limit"> {
    const orderBy: ParsedQuery["orderBy"] = [];
    if (this.acceptWord("ORDER")) {
      this.expectWord("BY");
      do {
        const column = this.identifier();
        const direction = this.acceptWord("DESC") ? "desc" : (this.acceptWord("ASC"), "asc");
        let nulls: "first" | "last" = "last";
        if (this.acceptWord("NULLS")) {
          if (this.acceptWord("FIRST")) nulls = "first";
          else {
            this.expectWord("LAST");
            nulls = "last";
          }
        }
        orderBy.push({ column, direction, nulls });
      } while (this.accept(","));
    }
    let limit: number | null = null;
    if (this.acceptWord("LIMIT")) {
      const token = this.current();
      if (token.kind !== "number" || !Number.isSafeInteger(token.value) || (token.value as number) < 0)
        this.fail("LIMIT 需要非负整数", token);
      limit = token.value as number;
      this.index++;
    }
    return { orderBy, limit };
  }

  private finish(): void {
    this.accept(";");
    if (this.current().kind !== "eof") this.fail("语句末尾有多余内容", this.current());
  }

  private pattern(): Pattern {
    if (this.acceptWord("FACT")) return this.factPattern();
    const left = this.nodePattern();
    if (!this.accept("-")) return left;
    this.expect("[");
    const variable = this.identifier();
    this.expect(":");
    const factKind = this.factKind();
    this.expect("]");
    this.expect("->");
    const right = this.nodePattern();
    if (factKind === "VOICE_CREDIT")
      this.fail("VOICE_CREDIT 必须使用完整三角色 FACT 模式", this.previous());
    return { kind: "edge", left, variable, factKind, right };
  }

  private nodePattern(): NodePattern {
    this.expect("(");
    const variable = this.identifier();
    this.expect(":");
    const type = this.identifier().toLowerCase();
    const owner = OWNER_BY_NAME[type];
    if (!owner) this.fail(`未知节点类型 ${type}`, this.previous());
    this.expect(")");
    return { kind: "node", variable, owner };
  }

  private factPattern(): FactPattern {
    const variable = this.identifier();
    this.expect(":");
    const factKind = this.factKind();
    this.expect("(");
    const roles: Record<string, string> = {};
    do {
      const role = this.identifier();
      this.expect(":");
      if (Object.hasOwn(roles, role)) this.fail(`重复事实角色 ${role}`, this.previous());
      roles[role] = this.identifier();
    } while (this.accept(","));
    this.expect(")");
    return { kind: "fact", variable, factKind, roles };
  }

  private queryFactPattern(): FactPattern {
    const factKind = this.factKind();
    this.expect("(");
    const roles: Record<string, string> = {};
    do {
      const role = this.identifier();
      this.expect(":");
      if (Object.hasOwn(roles, role)) this.fail(`重复事实角色 ${role}`, this.previous());
      const variable = this.identifier();
      roles[role] = variable;
      this.bindings.add(variable);
    } while (this.accept(","));
    this.expect(")");
    const variable = this.acceptWord("AS")
      ? this.identifier()
      : `fact${this.generatedFacts++}`;
    this.bindings.add(variable);
    return { kind: "fact", variable, factKind, roles };
  }

  private returnItem(requireAlias = true): ReturnItem {
    let value: AstValue | undefined;
    let aggregate: ReturnItem["aggregate"];
    const word = this.current().kind === "word" ? this.current().text.toLowerCase() : "";
    if (["count", "sum", "min", "max", "avg"].includes(word) && this.tokens[this.index + 1]?.text === "(") {
      this.index += 2;
      const distinct = this.acceptWord("DISTINCT");
      let argument: AstValue | undefined;
      if (!this.accept("*")) argument = this.value();
      this.expect(")");
      if (word !== "count" && !argument) this.fail(`${word.toUpperCase()} 不支持 *`, this.previous());
      aggregate = {
        function: distinct ? "countDistinct" : word as AggregateFunction,
        ...(argument ? { value: argument } : {}),
      };
    } else value = this.value();
    let alias: string;
    if (this.acceptWord("AS")) alias = this.identifier();
    else if (requireAlias) {
      this.expectWord("AS");
      alias = this.identifier();
    } else if (aggregate) {
      this.fail("聚合结果需要 AS 别名", this.previous());
    } else if (value?.kind === "field") alias = value.field;
    else if (value?.kind === "variable") alias = value.name;
    else this.fail("RETURN 表达式需要 AS 别名", this.previous());
    return { alias, ...(value ? { value } : {}), ...(aggregate ? { aggregate } : {}) };
  }

  private or(): AstPredicate {
    const terms = [this.and()];
    while (this.acceptWord("OR")) terms.push(this.and());
    return terms.length === 1 ? terms[0] as AstPredicate : { kind: "or", terms };
  }

  private and(): AstPredicate {
    const terms = [this.not()];
    while (this.acceptWord("AND")) terms.push(this.not());
    return terms.length === 1 ? terms[0] as AstPredicate : { kind: "and", terms };
  }

  private not(): AstPredicate {
    if (this.acceptWord("NOT")) {
      if (this.acceptWord("EXISTS")) return this.exists(true);
      return { kind: "not", term: this.not() };
    }
    if (this.acceptWord("EXISTS")) return this.exists(false);
    if (this.accept("(")) {
      const expression = this.or();
      this.expect(")");
      return expression;
    }
    const left = this.value();
    if (this.acceptWord("IS")) {
      if (this.acceptWord("NULL")) return { kind: "isNull", term: left };
      this.expectWord("MISSING");
      return { kind: "isMissing", term: left };
    }
    if (this.acceptWord("IN")) {
      this.expect("[");
      const values: AstValue[] = [];
      if (!this.accept("]")) {
        do values.push(this.value()); while (this.accept(","));
        this.expect("]");
      }
      return { kind: "in", value: left, values };
    }
    const operator = this.comparisonOperator();
    if (!operator) return left;
    return { kind: "compare", operator, left, right: this.value() };
  }

  private exists(negated: boolean): AstPredicate {
    this.expect("{");
    this.expectWord("MATCH");
    const patterns = [this.dialect === "query" ? this.queryFactPattern() : this.pattern()];
    while (this.accept(","))
      patterns.push(this.dialect === "query" ? this.queryFactPattern() : this.pattern());
    const where = this.acceptWord("WHERE") ? this.or() : undefined;
    this.expect("}");
    return { kind: "exists", negated, patterns, ...(where ? { where } : {}) };
  }

  private comparisonOperator(): CompareOperator | null {
    const token = this.current();
    const symbols: Record<string, CompareOperator> = {
      "=": "eq", "!=": "ne", "<>": "ne", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte",
    };
    if (symbols[token.text]) {
      this.index++;
      return symbols[token.text] as CompareOperator;
    }
    if (this.acceptWord("CONTAINS")) return "contains";
    return null;
  }

  private value(): AstValue {
    const token = this.current();
    if (this.accept("-")) {
      const number = this.current();
      if (number.kind !== "number")
        this.fail("负号后需要数字", number);
      this.index++;
      return { kind: "literal", value: -(number.value as number) };
    }
    if (token.kind === "number" || token.kind === "string") {
      this.index++;
      return { kind: "literal", value: token.value as string | number };
    }
    if (token.kind === "parameter") {
      this.index++;
      const name = token.value as string;
      this.parameters.add(name);
      return { kind: "parameter", name };
    }
    if (token.kind === "word") {
      if (this.acceptWord("TRUE")) return { kind: "literal", value: true };
      if (this.acceptWord("FALSE")) return { kind: "literal", value: false };
      if (this.acceptWord("NULL")) return { kind: "literal", value: null };
      const variable = this.identifier();
      if (this.accept(".")) return { kind: "field", variable, field: this.identifier() };
      if (this.dialect === "query" && this.valueScope === "query" && !this.bindings.has(variable))
        return { kind: "field", variable: this.rootVariable, field: variable };
      return { kind: "variable", name: variable };
    }
    this.fail("需要变量、字段、参数或 literal", token);
  }

  private factKind(): QueryFactKind {
    const name = this.identifier().toUpperCase();
    if (!FACT_KINDS.has(name)) this.fail(`未知事实类型 ${name}`, this.previous());
    return name as QueryFactKind;
  }

  private identifier(): string {
    const token = this.current();
    if (token.kind !== "word") this.fail("需要标识符", token);
    this.index++;
    return token.text;
  }

  private current(): Token { return this.tokens[this.index] as Token; }
  private previous(): Token { return this.tokens[Math.max(0, this.index - 1)] as Token; }
  private accept(text: string): boolean {
    if (this.current().text !== text) return false;
    this.index++;
    return true;
  }
  private acceptWord(word: string): boolean {
    const token = this.current();
    if (token.kind !== "word" || token.text.toUpperCase() !== word) return false;
    this.index++;
    return true;
  }
  private expect(text: string): void {
    if (!this.accept(text)) this.fail(`需要 ${text}`, this.current());
  }
  private expectWord(word: string): void {
    if (!this.acceptWord(word)) this.fail(`需要 ${word}`, this.current());
  }
  private fail(message: string, token: Token): never {
    throw this.dialect === "query"
      ? new AtlasQueryError(message, token.start, token.end)
      : new AtlasCypherError(message, token.start, token.end);
  }
}

function expression(value: AstValue): Expression {
  switch (value.kind) {
    case "literal": return { kind: "literal", value: value.value };
    case "parameter": return { kind: "parameter", name: value.name };
    case "variable": return { kind: "column", name: value.name };
    case "field": return { kind: "field", binding: value.variable, field: value.field };
  }
}

function predicate(value: AstPredicate): Expression {
  switch (value.kind) {
    case "literal":
    case "parameter":
    case "variable":
    case "field":
      return expression(value);
    case "compare":
      return { kind: "compare", operator: value.operator, left: expression(value.left), right: expression(value.right) };
    case "in":
      if (!value.values.length) return { kind: "literal", value: false };
      return {
        kind: "or",
        terms: value.values.map((item) => ({
          kind: "compare",
          operator: "eq",
          left: expression(value.value),
          right: expression(item),
        })),
      };
    case "and":
    case "or":
      return { kind: value.kind, terms: value.terms.map(predicate) };
    case "not":
      return { kind: "not", term: predicate(value.term) };
    case "isNull":
    case "isMissing":
      return { kind: value.kind, term: expression(value.term) };
    case "exists":
      throw new TypeError("EXISTS must be lowered as a correlated operator");
  }
}

/** A positive conjunct is a sound candidate source: the folded posting search is
 * a superset, and the original case-sensitive predicate still verifies each hit. */
function textContainsAnchors(value: AstPredicate): {
  variable: string;
  field: string;
  text: AstValue;
}[] {
  if (value.kind === "and")
    return value.terms.flatMap(textContainsAnchors);
  if (
    value.kind === "compare" &&
    value.operator === "contains" &&
    value.left.kind === "field" &&
    (value.right.kind === "literal" || value.right.kind === "parameter")
  )
    return [{
      variable: value.left.variable,
      field: value.left.field,
      text: value.right,
    }];
  return [];
}

function identityAnchors(value: AstPredicate): {
  variable: string;
  field: "ref" | "id";
  value: string | number;
}[] {
  if (value.kind === "and") return value.terms.flatMap(identityAnchors);
  if (
    value.kind === "compare" &&
    value.operator === "eq" &&
    value.left.kind === "field" &&
    (value.left.field === "ref" || value.left.field === "id") &&
    value.right.kind === "literal" &&
    (typeof value.right.value === "string" ||
      typeof value.right.value === "number")
  )
    return [{
      variable: value.left.variable,
      field: value.left.field,
      value: value.right.value,
    }];
  return [];
}

function declareNode(
  pattern: NodePattern,
  owners: Map<string, Owner>,
): void {
  const previous = owners.get(pattern.variable);
  if (previous && previous !== pattern.owner)
    throw new TypeError(`${pattern.variable} 同时声明为 ${previous} 和 ${pattern.owner}`);
  owners.set(pattern.variable, pattern.owner);
}

function lowerParsedQuery(
  ast: ParsedQuery,
  parameterTypes: Record<string, ParameterType>,
  requireExplicitGrouping: boolean,
): QueryDocument {
  for (const name of ast.parameters)
    if (!parameterTypes[name]) throw new TypeError(`参数 $${name} 没有类型声明`);
  for (const name of Object.keys(parameterTypes))
    if (!ast.parameters.has(name)) throw new TypeError(`参数 $${name} 未被语句使用`);

  const operators: Record<string, QueryOperator> = {};
  let next = 0;
  const id = (kind: string): string => `${kind}${next++}`;
  const buildPatterns = (patterns: Pattern[]): {
    root: string;
    source: string;
    owners: Map<string, Owner>;
  } => {
    const owners = new Map<string, Owner>();
    const bound = new Set<string>();
    const factVariables = new Set<string>();
    let patternRoot: string | null = null;
    let patternSource: string | null = null;
    const scan = (node: NodePattern): void => {
      const operatorId = id("scan");
      operators[operatorId] = {
        kind: "scan",
        owner: node.owner,
        binding: node.variable,
      };
      patternRoot = operatorId;
      patternSource = operatorId;
      bound.add(node.variable);
    };
    for (const pattern of patterns) {
      if (pattern.kind === "node") {
        declareNode(pattern, owners);
        if (!patternRoot) scan(pattern);
        else if (!bound.has(pattern.variable))
          throw new TypeError(`模式 ${pattern.variable} 与已有 MATCH 不连通`);
        continue;
      }
      if (pattern.kind === "edge") {
        declareNode(pattern.left, owners);
        declareNode(pattern.right, owners);
        if (factVariables.has(pattern.variable))
          throw new TypeError(`事实变量 ${pattern.variable} 重复`);
        factVariables.add(pattern.variable);
        const roles = BINARY_ROLES[pattern.factKind];
        if (!roles) throw new TypeError(`${pattern.factKind} 不是二元事实`);
        const definition = QUERY_CONTRACT.facts[pattern.factKind];
        if (
          definition.roles[roles[0]] !== pattern.left.owner ||
          definition.roles[roles[1]] !== pattern.right.owner
        )
          throw new TypeError(`${pattern.factKind} 的节点类型或方向不匹配`);
        if (!patternRoot) scan(pattern.left);
        else if (!bound.has(pattern.left.variable) && !bound.has(pattern.right.variable))
          throw new TypeError(`事实 ${pattern.variable} 与已有 MATCH 不连通`);
        const operatorId = id("matchFact");
        operators[operatorId] = {
          kind: "matchFact",
          input: patternRoot as string,
          factKind: pattern.factKind,
          factBinding: pattern.variable,
          roles: {
            [roles[0]]: pattern.left.variable,
            [roles[1]]: pattern.right.variable,
          },
        };
        patternRoot = operatorId;
        bound.add(pattern.left.variable);
        bound.add(pattern.right.variable);
        continue;
      }
      if (factVariables.has(pattern.variable))
        throw new TypeError(`事实变量 ${pattern.variable} 重复`);
      factVariables.add(pattern.variable);
      const definition = QUERY_CONTRACT.facts[pattern.factKind];
      const expectedRoles = Object.keys(definition.roles).sort();
      if (canonicalRoles(pattern.roles) !== expectedRoles.join("\u0000"))
        throw new TypeError(`${pattern.factKind} 必须声明全部且仅声明合法角色`);
      for (const [role, variable] of Object.entries(pattern.roles))
        declareNode(
          { kind: "node", variable, owner: definition.roles[role] as Owner },
          owners,
        );
      if (!patternRoot) {
        const [role, variable] = Object.entries(pattern.roles)[0] as [string, string];
        scan({ kind: "node", variable, owner: definition.roles[role] as Owner });
      } else if (!Object.values(pattern.roles).some((variable) => bound.has(variable)))
        throw new TypeError(`事实 ${pattern.variable} 与已有 MATCH 不连通`);
      const operatorId = id("matchFact");
      operators[operatorId] = {
        kind: "matchFact",
        input: patternRoot as string,
        factKind: pattern.factKind,
        factBinding: pattern.variable,
        roles: { ...pattern.roles },
      };
      patternRoot = operatorId;
      for (const variable of Object.values(pattern.roles)) bound.add(variable);
    }
    if (!patternRoot || !patternSource) throw new TypeError("MATCH 不能为空");
    return { root: patternRoot, source: patternSource, owners };
  };

  const containsExists = (value: AstPredicate): boolean =>
    value.kind === "exists" ||
    ((value.kind === "and" || value.kind === "or") && value.terms.some(containsExists)) ||
    (value.kind === "not" && containsExists(value.term));

  const applyIdentityAnchor = (source: string, value: AstPredicate): void => {
    for (const anchor of identityAnchors(value)) {
      const sourceOperator = operators[source];
      if (
        sourceOperator?.kind !== "scan" ||
        sourceOperator.binding !== anchor.variable
      ) continue;
      let ref: string;
      if (anchor.field === "ref") {
        if (typeof anchor.value !== "string") continue;
        const parsed = parseEntityRef(anchor.value);
        if (parsed.owner !== sourceOperator.owner) continue;
        ref = anchor.value;
      } else {
        if (!Number.isSafeInteger(anchor.value) || (anchor.value as number) < 0)
          continue;
        ref = `${sourceOperator.owner}:${anchor.value}`;
      }
      operators[source] = {
        kind: "values",
        columns: [sourceOperator.binding],
        types: {
          [sourceOperator.binding]: `entity:${sourceOperator.owner}`,
        },
        rows: [[ref]],
      };
      return;
    }
  };

  const applyWhere = (
    input: string,
    owners: Map<string, Owner>,
    value: AstPredicate,
    source: string,
  ): string => {
    if (value.kind === "and" && containsExists(value)) {
      let current = input;
      const scalar = value.terms.filter((term) => !containsExists(term));
      if (scalar.length)
        current = applyWhere(
          current,
          owners,
          scalar.length === 1 ? scalar[0] as AstPredicate : { kind: "and", terms: scalar },
          source,
        );
      for (const term of value.terms)
        if (containsExists(term)) current = applyWhere(current, owners, term, source);
      return current;
    }
    if (value.kind === "or" && containsExists(value))
      throw new TypeError("EXISTS 暂不支持放在 OR 中");
    if (value.kind === "not" && containsExists(value))
      throw new TypeError("请使用 NOT EXISTS，而不是对 EXISTS 结果再次取反");
    if (value.kind === "exists") {
      const inner = buildPatterns(value.patterns);
      let match = inner.root;
      if (value.where) match = applyWhere(match, inner.owners, value.where, inner.source);
      const columns = [...owners.entries()]
        .filter(([variable, owner]) => inner.owners.get(variable) === owner)
        .map(([variable]) => ({ outer: variable, inner: variable }));
      if (!columns.length)
        throw new TypeError("EXISTS 子查询必须通过同名类型化节点与外层相关");
      const operatorId = id(value.negated ? "notExists" : "exists");
      operators[operatorId] = {
        kind: value.negated ? "notExists" : "exists",
        input,
        match,
        columns,
      };
      return operatorId;
    }
    applyIdentityAnchor(source, value);
    const filter = id("filter");
    operators[filter] = { kind: "filter", input, predicate: predicate(value) };
    return filter;
  };

  const main = buildPatterns(ast.patterns);
  const sourceOperator = operators[main.source];
  if (sourceOperator?.kind !== "scan")
    throw new TypeError("FIND 必须从一个根实体开始");
  const searchOperator = (
    search: NonNullable<ParsedQuery["searches"]>[number],
    binding: string,
  ): QueryOperator => {
    if (!search.field) {
      return {
        kind: "lookup",
        owner: sourceOperator.owner,
        binding,
        text: expression(search.text),
      };
    }
    const definition = QUERY_CONTRACT.owners[sourceOperator.owner]
      .fields[search.field];
    if (definition?.capabilities.includes("fullText")) return {
      kind: "fullText",
      target: "entity",
      owner: sourceOperator.owner,
      binding,
      text: expression(search.text),
      field: search.field as "summary" | "description",
    };
    if (definition?.capabilities.includes("lookup")) return {
      kind: "lookup",
      owner: sourceOperator.owner,
      binding,
      text: expression(search.text),
      fields: [search.field as "name" | "nameCn" | "nameVariant"],
    };
    throw new TypeError(`${sourceOperator.owner}.${search.field} 不支持 SEARCH`);
  };
  let searchRoot = main.root;
  for (const [index, search] of (ast.searches ?? []).entries()) {
    if (index === 0) {
      operators[main.source] = searchOperator(search, sourceOperator.binding);
      continue;
    }
    const match = id("search");
    const binding = `${sourceOperator.binding}Search${index}`;
    operators[match] = searchOperator(search, binding);
    const exists = id("exists");
    operators[exists] = {
      kind: "exists",
      input: searchRoot,
      match,
      columns: [{ outer: sourceOperator.binding, inner: binding }],
    };
    searchRoot = exists;
  }
  for (const anchor of ast.where ? textContainsAnchors(ast.where) : []) {
    const sourceOperator = operators[main.source];
    if (
      sourceOperator?.kind !== "scan" ||
      sourceOperator.binding !== anchor.variable
    )
      continue;
    const field = QUERY_CONTRACT.owners[sourceOperator.owner].fields[anchor.field];
    if (!field?.capabilities.includes("fullText"))
      continue;
    operators[main.source] = {
      kind: "fullText",
      target: "entity",
      owner: sourceOperator.owner,
      binding: sourceOperator.binding,
      text: expression(anchor.text),
      field: anchor.field as "summary" | "description",
    };
    break;
  }
  let root = ast.where
    ? applyWhere(searchRoot, main.owners, ast.where, main.source)
    : searchRoot;
  const aliases = ast.returns.map((item) => item.alias);
  if (new Set(aliases).size !== aliases.length)
    throw new TypeError("RETURN 别名必须唯一");
  const hasAggregate = ast.returns.some((item) => item.aggregate);
  if (hasAggregate) {
    const grouped = ast.returns.filter((item) => item.value);
    if (requireExplicitGrouping && grouped.length && !ast.groupBy)
      throw new TypeError("聚合查询必须用 GROUP BY 声明非聚合返回字段");
    if (ast.groupBy) {
      const declared = ast.groupBy.map((value) => JSON.stringify(expression(value)));
      const returned = grouped.map((item) => JSON.stringify(expression(item.value as AstValue)));
      if (
        declared.length !== returned.length ||
        declared.some((value, index) => value !== returned[index])
      )
        throw new TypeError("GROUP BY 必须与非聚合 RETURN 字段一致且顺序相同");
    }
    const aggregate = id("aggregate");
    operators[aggregate] = {
      kind: "aggregate",
      input: root,
      groupBy: grouped.map((item) => ({
        name: item.alias,
        value: expression(item.value as AstValue),
      })),
      metrics: ast.returns.filter((item) => item.aggregate).map((item) => ({
        name: item.alias,
        function: item.aggregate!.function,
        ...(item.aggregate?.value ? { value: expression(item.aggregate.value) } : {}),
      })),
    };
    root = aggregate;
    if (ast.having) {
      const having = id("filter");
      operators[having] = {
        kind: "filter",
        input: root,
        predicate: predicate(ast.having),
      };
      root = having;
    }
  } else {
    if (ast.groupBy || ast.having)
      throw new TypeError("GROUP BY 和 HAVING 需要聚合结果");
    const project = id("project");
    operators[project] = {
      kind: "project",
      input: root,
      columns: ast.returns.map((item) => ({
        name: item.alias,
        value: expression(item.value as AstValue),
      })),
    };
    root = project;
  }
  return {
    schema: "atlas-query-document-v2",
    root,
    parameters: { ...parameterTypes },
    operators,
    distinct: ast.distinct,
    orderBy: ast.orderBy,
    limit: ast.limit,
  };
}

export function lowerAtlasCypher(
  source: string,
  parameterTypes: Record<string, ParameterType> = {},
): QueryDocument {
  return lowerParsedQuery(
    new Parser(tokenize(source)).parse(),
    parameterTypes,
    false,
  );
}

export function lowerAtlasQuery(
  source: string,
  parameterTypes: Record<string, ParameterType> = {},
): QueryDocument {
  if (source.length > MAX_SOURCE_LENGTH)
    throw new AtlasQueryError("Atlas Query 输入过长", 0, source.length);
  if (/^\s*FIND\s+PATH\b/iu.test(source))
    return lowerAtlasPath(source, parameterTypes);
  const program = splitSetProgram(source);
  const queries = program.sources.map((branch) =>
    new Parser(tokenize(branch, "query"), "query").parse()
  );
  const used = new Set(queries.flatMap((query) => [...query.parameters]));
  for (const name of used)
    if (!parameterTypes[name]) throw new TypeError(`参数 $${name} 没有类型声明`);
  for (const name of Object.keys(parameterTypes))
    if (!used.has(name)) throw new TypeError(`参数 $${name} 未被语句使用`);
  const documents = queries.map((query) => lowerParsedQuery(
    query,
    Object.fromEntries(
      [...query.parameters].map((name) => [name, parameterTypes[name] as ParameterType]),
    ),
    true,
  ));
  if (!program.operators.length) return documents[0] as QueryDocument;
  for (const query of queries.slice(0, -1))
    if (query.orderBy.length || query.limit !== null)
      throw new TypeError("集合查询只能在最后声明 ORDER BY 和 LIMIT");
  const aliases = queries[0]!.returns.map((item) => item.alias);
  for (const query of queries.slice(1))
    if (
      query.returns.length !== aliases.length ||
      query.returns.some((item, index) => item.alias !== aliases[index])
    )
      throw new TypeError("集合分支必须返回相同名称和顺序的列");

  const operators: Record<string, QueryOperator> = {};
  const roots = documents.map((document, index) => {
    const prefix = `branch${index}_`;
    const names = new Map(
      Object.keys(document.operators).map((name) => [name, `${prefix}${name}`]),
    );
    for (const [name, operator] of Object.entries(document.operators))
      operators[names.get(name) as string] = remapOperator(operator, names);
    return names.get(document.root) as string;
  });
  let root = roots[0] as string;
  for (let index = 0; index < program.operators.length; index++) {
    const next = roots[index + 1] as string;
    const setRoot = `set${index}`;
    operators[setRoot] = {
      kind: program.operators[index] as "union" | "intersect" | "except",
      branches: [root, next].map((input) => ({
        input,
        columns: aliases.map((name) => ({ output: name, input: name })),
      })),
    };
    root = setRoot;
  }
  const tail = queries.at(-1) as ParsedQuery;
  return {
    schema: "atlas-query-document-v2",
    root,
    parameters: { ...parameterTypes },
    operators,
    orderBy: tail.orderBy,
    limit: tail.limit,
  };
}

function splitSetProgram(source: string): {
  sources: string[];
  operators: ("union" | "intersect" | "except")[];
} {
  const tokens = tokenize(source, "query");
  const sources: string[] = [];
  const operators: ("union" | "intersect" | "except")[] = [];
  let depth = 0;
  let start = 0;
  for (const token of tokens) {
    if (["(", "[", "{"].includes(token.text)) depth++;
    else if ([")", "]", "}"].includes(token.text)) depth--;
    else if (
      depth === 0 &&
      token.kind === "word" &&
      ["UNION", "INTERSECT", "EXCEPT"].includes(token.text.toUpperCase())
    ) {
      const branch = source.slice(start, token.start).trim();
      if (!branch) throw new AtlasQueryError("集合运算缺少左侧查询", token.start, token.end);
      sources.push(branch);
      operators.push(token.text.toLowerCase() as "union" | "intersect" | "except");
      start = token.end;
    }
  }
  const branch = source.slice(start).trim();
  if (!branch) throw new AtlasQueryError("集合运算缺少右侧查询", start, source.length);
  sources.push(branch);
  return { sources, operators };
}

function remapOperator(
  operator: QueryOperator,
  names: Map<string, string>,
): QueryOperator {
  const input = (name: string): string => {
    const mapped = names.get(name);
    if (!mapped) throw new TypeError(`集合分支引用未知算子 ${name}`);
    return mapped;
  };
  switch (operator.kind) {
    case "filter":
    case "project":
    case "matchFact":
    case "followRef":
    case "aggregate":
    case "path":
      return { ...operator, input: input(operator.input) };
    case "exists":
    case "notExists":
      return {
        ...operator,
        input: input(operator.input),
        match: input(operator.match),
      };
    case "union":
    case "intersect":
    case "except":
      return {
        ...operator,
        branches: operator.branches.map((branch) => ({
          ...branch,
          input: input(branch.input),
        })),
      };
    default:
      return { ...operator };
  }
}

function lowerAtlasPath(
  source: string,
  parameterTypes: Record<string, ParameterType>,
): QueryDocument {
  const match = /^\s*FIND\s+PATH\s+FROM\s+(subject|person|character):(0|[1-9][0-9]*)\s+TO\s+(subject|person|character):(0|[1-9][0-9]*)(?:\s+MAX\s+HOPS\s+([0-9]+))?(?:\s+LIMIT\s+([0-9]+))?\s*;?\s*$/iu.exec(source);
  if (!match) throw new AtlasQueryError("FIND PATH 语法无效", 0, source.length);
  if (Object.keys(parameterTypes).length)
    throw new TypeError("FIND PATH 当前不接受参数");
  const start = `${match[1]!.toLowerCase()}:${match[2]}`;
  const target = `${match[3]!.toLowerCase()}:${match[4]}`;
  const maxHops = match[5] === undefined ? 6 : Number(match[5]);
  const maxPaths = match[6] === undefined ? 10 : Number(match[6]);
  if (
    !Number.isSafeInteger(maxHops) ||
    maxHops < 1 ||
    !Number.isSafeInteger(maxPaths) ||
    maxPaths < 1
  )
    throw new TypeError("FIND PATH 的跳数和条数必须是正整数");
  const traversals = (Object.entries(QUERY_CONTRACT.facts) as [
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
  return {
    schema: "atlas-query-document-v2",
    root: "path",
    parameters: {},
    operators: {
      seed: {
        kind: "values",
        columns: ["seed"],
        types: { seed: "integer" },
        rows: [[0]],
      },
      path: {
        kind: "path",
        input: "seed",
        start: { kind: "literal", value: start },
        target: { kind: "literal", value: target },
        binding: "path",
        policy: "fewest-hops",
        maxHops,
        maxPaths,
        traversals,
      },
    },
    limit: maxPaths,
  };
}

function canonicalRoles(roles: Record<string, string>): string {
  return Object.keys(roles).sort().join("\u0000");
}
