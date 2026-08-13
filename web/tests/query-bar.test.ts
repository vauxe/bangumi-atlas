import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  addConditionForOwners,
  applyOrderAndLimit,
  captureControlFocus,
  conditionGroupControlsVisible,
  conditionEntityRefs,
  conditionEditorOperatorChoices,
  conditionEditFocusTerm,
  conditionValueInputStep,
  conditionValueInputType,
  createScopedFullTextAction,
  createDefaultConditionEdit,
  createConditionEditRoot,
  createQueryNameInput,
  createQueryTokenControl,
  createSortTerm,
  createSortTermForChoice,
  finishConditionEdit,
  findQueryTokenButton,
  findPrimaryEditorControl,
  filterRelationChoices,
  factConditionSelections,
  featuredMetaTagValuesFor,
  isActionShortcut,
  moveSuggestionIndex,
  queryAddChoices,
  queryEditorFilterFields,
  queryNameSuggestionOwners,
  queryPanelMaxHeight,
  queryRunPresentation,
  querySortChoicesForScope,
  relationChoiceCondition,
  relationChoicesForScope,
  resolveRelationChoice,
  resolveSingleChoiceValue,
  rankEntitySuggestions,
  restoreControlFocus,
  shouldSyncQueryInput,
  sortTermWithDirection,
  tagVocabularyField,
  toggleEntityScope,
  tokenFocusIndexAfterRemoval,
  updateFactConditionSelection,
  visibleNameAction,
} from "../src/query/query-bar";
import type { EditCondition } from "../src/query/query-bar";
import { applyQueryAction, type QueryDraft } from "../src/query/draft";
import type { QueryToken } from "../src/query/presenter";
import { queryAddFilterFields } from "../src/query/workbench-model";
import type { Mappings } from "../src/types";

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(readonly key = "") {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  title = "";
  type = "";
  private readonly listeners = new Map<string, Listener[]>();

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event = new FakeEvent()): FakeEvent {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  matches(selector: string): boolean {
    return selector === ".query-token" && this.className.split(" ").includes("query-token");
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

const removableToken: QueryToken = {
  id: "condition-0",
  kind: "condition",
  label: "评分 ≥ 8",
  target: { type: "condition", index: 0 },
  editable: true,
  removable: true,
};

const queryStyles = readFileSync("src/query/workbench.css", "utf8");
const queryBarSource = readFileSync("src/query/query-bar.ts", "utf8");
const mainSource = readFileSync("src/main.ts", "utf8");
const queryRuntimeSource = readFileSync("src/query/runtime.ts", "utf8");

const relationMappings: Mappings = {
  fact_labels: {
    WORKED_ON: { "2": "导演", "20": "导演", "3": "脚本" },
    APPEARS_IN: { "1": "主角" },
    RELATES_TO: { "2": "前传", "1005": "前传" },
  },
  subject_type: {},
  platform: {},
  person_type: {},
  character_role: {},
  episode_type: {},
};

test("executes a runnable query with Enter when no name suggestion is active", () => {
  const inputKeydown = queryBarSource.match(
    /private inputKeydown\([\s\S]*?\n  }(?=\n\n  private keydown)/,
  )?.[0];
  const keydown = queryBarSource.match(
    /private keydown\([\s\S]*?\n  }(?=\n\n  private activateSubmit)/,
  )?.[0];
  assert.ok(inputKeydown);
  assert.ok(keydown);
  assert.match(inputKeydown, /if \(event\.isComposing\) return;/);
  const acceptSuggestion = inputKeydown.indexOf(
    "choices[this.nameIndex]!.click()",
  );
  const minimumLengthGuard = inputKeydown.indexOf(
    "literalCount(this.text.value)",
  );
  const submit = inputKeydown.indexOf("this.activateSubmit()");
  assert.ok(acceptSuggestion >= 0);
  assert.ok(minimumLengthGuard >= 0);
  assert.ok(submit > acceptSuggestion);
  assert.ok(submit > minimumLengthGuard);
  assert.match(
    inputKeydown,
    /if \(event\.key === "Enter"\) \{[\s\S]*event\.preventDefault\(\);[\s\S]*this\.closePanel\(\);[\s\S]*this\.activateSubmit\(\);/,
  );
  assert.doesNotMatch(keydown, /activateSubmit|onSubmit/);
});

test("lets Escape return from a nested panel or close the top level", () => {
  const keydown = queryBarSource.match(
    /private keydown\([\s\S]*?\n  }(?=\n\n  private activateSubmit)/,
  )?.[0];

  assert.ok(keydown);
  assert.match(
    keydown,
    /event\.key === "Escape"[\s\S]*if \(this\.panelBackAction\) this\.panelBackAction\(\);[\s\S]*else this\.closePanel\(true\)/,
  );
});

test("uses one persistent header control to leave every nested query panel", () => {
  const constructor = queryBarSource.match(
    /constructor\(private readonly options[\s\S]*?\n  }(?=\n\n  current\(\))/,
  )?.[0];
  const openPanel = queryBarSource.match(
    /private openPanel\([\s\S]*?\n  }(?=\n\n  private closePanel)/,
  )?.[0];
  const conditionEditor = queryBarSource.match(
    /private openConditionEditor\([\s\S]*?\n  }(?=\n\n  private openRelationEditor)/,
  )?.[0];
  const entityPicker = queryBarSource.match(
    /private openEntityPicker\([\s\S]*?\n  }(?=\n\n  private cancelSuggestions)/,
  )?.[0];

  assert.ok(constructor);
  assert.ok(openPanel);
  assert.ok(conditionEditor);
  assert.ok(entityPicker);
  assert.match(queryBarSource, /panelBack\s*=\s*iconButton\("back",\s*"返回上一页"/);
  assert.match(
    constructor,
    /panelHeader\.append\(this\.panelBack, this\.panelTitle, this\.panelClose\)/,
  );
  assert.match(openPanel, /this\.panelBack\.hidden\s*=\s*!back/);
  assert.doesNotMatch(conditionEditor, /button\("返回"/);
  assert.doesNotMatch(entityPicker, /button\("← 返回"/);
  assert.match(
    queryStyles,
    /\.query-popover-back\s*\{[^}]*flex:\s*none[^}]*border-radius:\s*50%/s,
  );
});

test("returns every editor launched from Add to the complete Add page", () => {
  const activate = queryBarSource.match(
    /private activateAddChoice\([\s\S]*?\n  }(?=\n\n  private requestNameSuggestions)/,
  )?.[0];

  assert.ok(activate);
  assert.match(activate, /const backToAdd\s*=\s*\(\)\s*=>\s*this\.openAddPicker\(\)/);
  assert.match(activate, /openNewEntityCondition\(choice\.owners, choice\.field, backToAdd\)/);
  assert.match(activate, /openRelationEditor\(undefined, undefined, choice\.owner, backToAdd\)/);
  assert.match(activate, /openBodyTextEditor\(backToAdd\)/);
  assert.match(activate, /openSortEditor\(backToAdd\)/);
});

test("keeps text focus on the shared rounded query surface", () => {
  assert.match(
    queryStyles,
    /#query-workbench\s+\.query-name-input:focus-visible\s*\{[^}]*outline:\s*0/s,
  );
  assert.match(
    queryStyles,
    /\.query-bar-line:focus-within\s*\{[^}]*box-shadow:/s,
  );
});

test("keeps every query popover aligned with the search surface", () => {
  const rules = [...queryStyles.matchAll(/\.query-popover\s*\{(?<body>[^}]*)\}/gs)]
    .map((match) => match.groups?.body ?? "");

  assert.match(rules[0] ?? "", /width:\s*100%/);
  assert.ok(rules.every((rule) => !/width:\s*(?:min\(|calc\(100vw)/.test(rule)));
});

test("uses the query theme for every nested scrollbar", () => {
  assert.match(
    queryStyles,
    /#query-workbench,\s*#query-workbench \*\s*\{[^}]*scrollbar-color:\s*var\(--query-scroll-thumb\)\s+transparent[^}]*scrollbar-width:\s*thin/s,
  );
  assert.match(
    queryStyles,
    /#query-workbench ::-webkit-scrollbar-thumb\s*\{[^}]*background:[^;]*var\(--query-scroll-thumb\)/s,
  );
});

test("offers fields and only the necessary query modifiers in one picker", () => {
  const draft: QueryDraft = {
    kind: "list",
    query: { scope: ["subject", "person", "character"] as const },
  };
  const choices = queryAddChoices(draft);

  assert.deepEqual(new Set(choices.map(({ kind }) => kind)), new Set([
    "condition", "relation", "fullText", "sort",
  ]));
  assert.ok(choices.some((choice) =>
    choice.kind === "condition" && choice.owners.includes("subject") && choice.field === "score"
  ));
  assert.ok(choices.some((choice) =>
    choice.kind === "condition" && choice.owners.includes("subject") && choice.field === "metaTags"
  ));
  assert.ok(choices.every((choice) => !("recommended" in choice)));
  assert.deepEqual(
    choices
      .flatMap((choice) =>
        choice.kind === "condition" && choice.owners.includes("subject")
          ? [choice.field]
          : []
      ),
    [
      "type", "year", "score", "ratingCount", "totalCollections",
      "tags", "nsfw", "summaryState",
      "platform", "date", "rank", "wish", "done",
      "doing", "onHold", "dropped", "series", "metaTags",
    ],
  );
  assert.deepEqual(
    choices.filter(({ kind }) => kind === "sort"),
    [{
      id: "sort",
      kind: "sort",
      label: "排序",
      detail: "选择排序字段",
    }],
  );
  assert.equal(choices.some((choice) => /统计|比较|路径/.test(choice.label)), false);
  assert.deepEqual(
    choices.filter(({ kind }) => kind === "relation"),
    [{
      id: "relation",
      kind: "relation",
      label: "按关联筛选",
      detail: "作品、人物或角色",
    }],
  );
});

test("shows one flat, semantically unique condition list", () => {
  const visible = queryAddChoices({
    kind: "list",
    query: { scope: ["subject", "person", "character"] },
  });
  const conditions = visible.filter((choice) => choice.kind === "condition");

  assert.equal(new Set(conditions.map(({ label }) => label)).size, conditions.length);
  assert.equal(conditions.some(({ field }) => field === "name"), false);
  assert.equal(conditions.some(({ field }) => field === "nameCn"), false);
  assert.deepEqual(
    conditions.find(({ field }) => field === "summaryState"),
    {
      id: "condition:subject+person+character:summaryState",
      kind: "condition",
      label: "是否有简介",
      detail: "",
      owners: ["subject", "person", "character"],
      field: "summaryState",
    },
  );
  assert.deepEqual(
    conditions.find(({ field }) => field === "comments"),
    {
      id: "condition:person+character:comments",
      kind: "condition",
      label: "评论数",
      detail: "仅人物、角色",
      owners: ["person", "character"],
      field: "comments",
    },
  );
  assert.deepEqual(
    conditions.filter(({ field }) => field === "type").map(({ label, owners }) => ({
      label,
      owners,
    })),
    [
      { label: "作品类型", owners: ["subject"] },
      { label: "人物类型", owners: ["person"] },
    ],
  );
  assert.deepEqual(
    visible.filter(({ kind }) => kind === "sort").map(({ label }) => label),
    ["排序"],
  );
  assert.equal(queryAddChoices({
    kind: "list",
    query: { scope: ["person", "character"] },
  }).find((choice) =>
    choice.kind === "condition" && choice.field === "type"
  )?.label, "人物类型");
});

test("offers one unified set of shared and entity-specific sort choices", () => {
  const choices = querySortChoicesForScope(["subject", "person", "character"]);
  assert.deepEqual(
    choices.find((choice) => choice.field === "name"),
    {
      id: "subject+person+character:name",
      field: "name",
      owners: ["subject", "person", "character"],
      label: "原名",
    },
  );
  assert.deepEqual(
    choices.find((choice) => choice.field === "score"),
    {
      id: "subject:score",
      field: "score",
      owners: ["subject"],
      label: "作品 · 评分",
    },
  );
  assert.deepEqual(
    choices.find((choice) => choice.field === "comments"),
    {
      id: "person+character:comments",
      field: "comments",
      owners: ["person", "character"],
      label: "人物、角色 · 评论数",
    },
  );
  assert.deepEqual(
    choices.filter((choice) => choice.field === "type").map(({ label, owners }) => ({
      label,
      owners,
    })),
    [
      { label: "作品 · 类型", owners: ["subject"] },
      { label: "人物 · 类型", owners: ["person"] },
    ],
  );
  assert.deepEqual(
    createSortTermForChoice(choices.find((choice) => choice.field === "name")!, [
      "subject",
      "person",
      "character",
    ]),
    { column: "name", direction: "asc", nulls: "first" },
  );
  assert.deepEqual(
    createSortTermForChoice(choices.find((choice) => choice.field === "score")!, [
      "subject",
      "person",
      "character",
    ]),
    {
      column: "score",
      owners: ["subject"],
      direction: "desc",
      nulls: "last",
    },
  );

  const scopes = [
    ["subject", "person"],
    ["subject", "character"],
    ["person", "character"],
    ["subject", "person", "character"],
    ["subject", "episode"],
  ] as const;
  for (const scope of scopes) {
    const modifiers = queryAddChoices({
      kind: "list",
      query: { scope },
    }).filter(({ kind }) => kind !== "condition");
    for (const kind of ["fullText", "relation", "sort"] as const)
      assert.ok(
        modifiers.filter((choice) => choice.kind === kind).length <= 1,
        `${scope.join("+")} exposes duplicate ${kind} actions`,
      );
  }
});

test("toggles entity types independently in canonical order", () => {
  assert.deepEqual(
    toggleEntityScope(["subject", "person", "character"], "person"),
    ["subject", "character"],
  );
  assert.deepEqual(
    toggleEntityScope(["subject", "character"], "episode"),
    ["subject", "character", "episode"],
  );
  assert.throws(
    () => toggleEntityScope(["episode"], "episode"),
    /至少选择一种实体/,
  );
});

test("keeps the scope check mark decorative for assistive technology", () => {
  const scopeChoice = queryBarSource.match(
    /function scopeChoiceButton\([\s\S]*?\n}/,
  )?.[0];

  assert.ok(scopeChoice);
  assert.match(scopeChoice, /setAttribute\("aria-hidden", "true"\)/);
  assert.doesNotMatch(queryStyles, /\.query-scope-choice::before/);
});

test("makes a field's scope effect explicit before it is selected", () => {
  const choices = queryAddChoices({
    kind: "list",
    query: { scope: ["subject", "person", "character"] },
  });

  assert.equal(
    choices.find((choice) =>
      choice.kind === "condition" && choice.field === "score"
    )?.detail,
    "仅作品",
  );
  assert.equal(
    choices.find((choice) =>
      choice.kind === "condition" && choice.field === "summaryState"
    )?.detail,
    "",
  );
});

test("adds a shared condition while narrowing to its compatible entities", () => {
  const condition = {
    kind: "compare" as const,
    field: "comments",
    operator: "gte" as const,
    value: 10,
  };

  assert.deepEqual(addConditionForOwners({
    kind: "list",
    query: { scope: ["subject", "person", "character"] },
  }, ["person", "character"], condition), {
    kind: "list",
    query: {
      scope: ["person", "character"],
      condition,
    },
  });
});

test("shows every addable choice without a search gate", () => {
  const openAddPicker = queryBarSource.match(
    /private openAddPicker\(\): void \{[\s\S]*?\n  }(?=\n\n  private activateAddChoice)/,
  )?.[0];

  assert.ok(openAddPicker);
  assert.match(openAddPicker, /list\.append\(\.\.\.choices\.map/);
  assert.doesNotMatch(openAddPicker, /query-add-group|<section>|createElement\("section"\)/);
  assert.doesNotMatch(openAddPicker, /搜索字段或功能|query-add-search|filterQueryAddChoices/);
});

test("exposes every default filter field for each entity type", () => {
  for (const owner of ["subject", "person", "character", "episode"] as const) {
    const visible = queryAddChoices({
      kind: "list",
      query: { scope: [owner] },
    }).flatMap((choice) => choice.kind === "condition" ? [choice.field] : []);

    assert.deepEqual(
      new Set(visible),
      new Set(queryAddFilterFields(owner)),
      `${owner} has a filter field missing from Add`,
    );
  }
});

test("keeps duplicate name fields out of new editors without losing restored fields", () => {
  assert.equal(queryEditorFilterFields(["subject"]).includes("name"), false);
  assert.equal(queryEditorFilterFields(["subject"]).includes("nameCn"), false);
  assert.equal(queryEditorFilterFields(["subject"], ["name"]).includes("name"), true);
  assert.equal(queryEditorFilterFields(["subject"], ["ref"]).includes("ref"), false);
});

test("keeps compact field tokens informational and uses the panel back control", () => {
  const openNewCondition = queryBarSource.match(
    /private openNewEntityCondition\([\s\S]*?\n  }(?=\n\n  private openEntityConditions)/,
  )?.[0];
  const openBodyText = queryBarSource.match(
    /private openBodyTextEditor\([\s\S]*?\n  }(?=\n\n  private openAllTextEditor)/,
  )?.[0];
  const conditionEditor = queryBarSource.match(
    /private openConditionEditor\([\s\S]*?\n  }(?=\n\n  private openRelationEditor)/,
  )?.[0];

  assert.ok(openNewCondition);
  assert.ok(openBodyText);
  assert.ok(conditionEditor);
  assert.match(openNewCondition, /"添加条件"/);
  assert.doesNotMatch(openNewCondition, /onChangeField/);
  assert.doesNotMatch(openBodyText, /onChangeField/);
  assert.match(conditionEditor, /query-condition-field-token/);
  assert.match(conditionEditor, /document\.createElement\("span"\)/);
  assert.doesNotMatch(conditionEditor, /更改字段：|onChangeField/);
  assert.match(
    conditionEditor,
    /iconButton\(\s*"check",\s*options\.submitLabel \?\? "应用",\s*"query-primary query-condition-submit"/,
  );
  assert.doesNotMatch(
    conditionEditor,
    /this\.panelTitle\.textContent\s*=\s*`添加\$\{config\.fieldLabel\(root\.field\)\}条件`/,
  );
  assert.match(
    queryStyles,
    /\.query-condition-field-token\s*\{[^}]*border-radius:/s,
  );
  assert.doesNotMatch(queryStyles, /button\.query-condition-field-token/);
});

test("finishes a compact condition with Enter after value suggestions are resolved", () => {
  const conditionEditor = queryBarSource.match(
    /private openConditionEditor\([\s\S]*?\n  }(?=\n\n  private openRelationEditor)/,
  )?.[0];

  assert.ok(conditionEditor);
  assert.match(
    conditionEditor,
    /body\.addEventListener\("keydown"[\s\S]*options\.compact[\s\S]*event\.key !== "Enter"[\s\S]*event\.defaultPrevented[\s\S]*save\.click\(\)/,
  );
  assert.match(
    conditionEditor,
    /event\.target\.getAttribute\("aria-expanded"\) === "true"/,
  );
  assert.match(conditionEditor, /}\s*,\s*true\s*\);/);
});

test("offers concrete relationships directly and merges duplicate raw codes", () => {
  const choices = relationChoicesForScope(
    ["subject", "person", "character"],
    relationMappings,
  );
  const workedOn = choices.find(({ value }) =>
    value === "WORKED_ON|subject|person"
  );
  const directed = choices.find((choice) =>
    choice.topology === "WORKED_ON|subject|person" &&
    choice.discriminatorLabel === "导演"
  );
  const appearedIn = choices.find((choice) =>
    choice.topology === "APPEARS_IN|character|subject" &&
    choice.discriminatorLabel === "主角"
  );

  assert.equal(workedOn?.owner, "subject");
  assert.equal(workedOn?.displayLabel, "任意人物参与");
  assert.equal(workedOn?.detailLabel, "作品 → 人物");
  assert.equal(directed?.displayLabel, "导演");
  assert.equal(directed?.detailLabel, "作品 → 人物");
  assert.deepEqual(directed?.discriminatorValues, ["2", "20"]);
  assert.equal(appearedIn?.owner, "character");
  assert.equal(appearedIn?.displayLabel, "主角");
  assert.equal(appearedIn?.detailLabel, "角色 → 作品");
  assert.deepEqual(
    [...new Set(choices.map(({ owner }) => owner))],
    ["subject", "person", "character"],
  );
  assert.equal(
    new Set(choices.map(({ value }) => value)).size,
    choices.length,
  );

  assert.deepEqual(relationChoiceCondition(directed!), {
    kind: "in",
    field: "position",
    values: [2, 20],
  });
  assert.deepEqual(resolveRelationChoice(choices, {
    factKind: "WORKED_ON",
    candidateRole: "subject",
    relatedRole: "person",
    related: "person:1",
    exists: true,
    condition: {
      kind: "compare",
      field: "position",
      operator: "eq",
      value: 2,
    },
  }), {
    choice: directed,
    discriminator: {
      kind: "compare",
      field: "position",
      operator: "eq",
      value: 2,
    },
    remainder: undefined,
  });
  assert.deepEqual(
    filterRelationChoices(choices, "导演").map(({ displayLabel, detailLabel }) =>
      [displayLabel, detailLabel]
    ),
    [
      ["导演", "作品 → 人物"],
      ["导演", "人物 → 作品"],
    ],
  );
});

test("keeps every relationship available before and after filtering", () => {
  const extensiveMappings: Mappings = {
    ...relationMappings,
    fact_labels: {
      ...relationMappings.fact_labels,
      WORKED_ON: {
        ...relationMappings.fact_labels?.WORKED_ON,
        ...Object.fromEntries(
          Array.from({ length: 24 }, (_, index) => [String(index + 100), `职位 ${index + 1}`]),
        ),
      },
    },
  };
  const choices = relationChoicesForScope(["subject"], extensiveMappings);

  assert.ok(choices.length > 12);
  assert.deepEqual(filterRelationChoices(choices, ""), choices);
  assert.ok(filterRelationChoices(choices, "导演").length > 0);
  assert.ok(filterRelationChoices(choices, "作品 人物").length > 0);
});

test("keeps the query button as the only way to execute a full name query", () => {
  const renderer = queryBarSource.match(
    /private renderNameSuggestions\([\s\S]*?\n  }(?=\n\n  private renderNameSuggestionError)/,
  )?.[0];

  assert.ok(renderer);
  assert.doesNotMatch(renderer, /activateSubmit|查看全部匹配|query-view-all/);
  assert.doesNotMatch(queryStyles, /\.query-view-all/);
});

test("keeps scoped body conditions separate from standalone corpus search", () => {
  assert.doesNotMatch(queryBarSource, /label: "正文内容"/);
  assert.doesNotMatch(queryBarSource, /检索正文/);
  const bodyEditor = queryBarSource.match(
    /private openBodyTextEditor\([\s\S]*?\n  }(?=\n\n  private openAllTextEditor)/,
  )?.[0];
  const corpusEditor = queryBarSource.match(
    /private openAllTextEditor\([\s\S]*?\n  }(?=\n\n  private textLeafConfig)/,
  )?.[0];
  assert.ok(bodyEditor);
  assert.ok(corpusEditor);
  assert.match(bodyEditor, /createScopedFullTextAction/);
  assert.doesNotMatch(bodyEditor, /setAllText|allText|所有正文与关系备注/);
  assert.match(corpusEditor, /type: "setAllText"/);
  assert.match(corpusEditor, /所有正文与关系备注/);
});

test("only offers removing a sort that already exists", () => {
  const editor = queryBarSource.match(
    /private openSortEditor\([\s\S]*?\n  }(?=\n\n  private openPathLimitEditor)/,
  )?.[0];

  assert.ok(editor);
  assert.match(editor, /const canRemove = Boolean\(query\.orderBy\?\.length \|\| query\.limit !== undefined\)/);
  assert.match(editor, /button\("移除排序", "query-secondary"\)/);
  assert.match(editor, /if \(canRemove\) actions\.append\(clear\)/);
  assert.doesNotMatch(editor, /不排序/);
});

test("edits the few relationship attributes as direct choices", () => {
  const condition = {
    kind: "all" as const,
    terms: [
      { kind: "compare" as const, field: "spoiler", operator: "eq" as const, value: true },
      { kind: "compare" as const, field: "ended", operator: "eq" as const, value: false },
    ],
  };

  assert.deepEqual(
    factConditionSelections(condition, ["spoiler", "ended"]),
    { spoiler: "true", ended: "false" },
  );
  assert.deepEqual(
    updateFactConditionSelection(
      "PERSON_REL",
      condition,
      ["spoiler", "ended"],
      "spoiler",
      "",
    ),
    { kind: "compare", field: "ended", operator: "eq", value: false },
  );
  assert.equal(factConditionSelections({
    kind: "any",
    terms: condition.terms,
  }, ["spoiler", "ended"]), null);
});

test("puts relationship meaning before the final apply action", () => {
  const editor = queryBarSource.match(
    /private openRelationEditor\([\s\S]*?\n  }(?=\n\n  private openColumnsEditor)/,
  )?.[0];

  assert.ok(editor);
  assert.match(editor, /document\.createElement\("form"\)/);
  assert.match(editor, /save\.type = "submit"/);
  const primaryControls = editor.indexOf("form.append(relation, target)");
  const optionalControls = editor.indexOf("const attributeFields");
  const exclusionControl = editor.indexOf("form.append(exclude, save)");
  assert.ok(primaryControls >= 0);
  assert.ok(optionalControls > primaryControls);
  assert.ok(exclusionControl > optionalControls);
  assert.match(editor, /form\.append\(exclude, save\)/);
  assert.match(editor, /form\.addEventListener\("submit"/);
  assert.match(editor, /queryRelationContextRoles/);
  assert.match(editor, /additionalEndpoints/);
  assert.match(editor, /限定\$\{context\.label\}/);
  assert.match(editor, /target\.setAttribute\("aria-label", targetLabel\)/);
  assert.doesNotMatch(editor, /optgroup|group\.label/);
  assert.match(editor, /const openRelationPicker/);
  assert.match(editor, /this\.openPanel\(\s*"选择关系"/);
  assert.match(editor, /const search = input\("搜索关系"\)/);
  assert.match(editor, /filterRelationChoices\(choices, search\.value\)/);
  assert.match(editor, /list\.setAttribute\("role", "listbox"\)/);
  assert.match(editor, /choice\.setAttribute\("role", "option"\)/);
  assert.match(editor, /search\.addEventListener\("input", renderChoices\)/);
  assert.match(editor, /if \(current\) render\(\);\s*else openRelationPicker\(back\)/);
  assert.doesNotMatch(editor, /attachValueAutocomplete|relationFocusValues|input\("具体关系"\)/);
  assert.match(editor, /relationChoicesForScope\(scope, this\.mappings\)/);
  assert.match(editor, /selected\.topology/);
  assert.match(editor, /state\.discriminator/);
  assert.match(editor, /factConditionSelections/);
  assert.match(editor, /updateFactConditionSelection/);
  assert.doesNotMatch(editor, /select\("是否存在"\)|排除此关系|已排除/);
  assert.match(
    editor,
    /button\(\s*"没有此关联"[\s\S]*aria-pressed[\s\S]*state\.exists = !state\.exists/,
  );
  assert.match(
    editor,
    /state\.focusAfterRender[\s\S]*state\.focusAfterRender === "target"[\s\S]*state\.focusAfterRender === "exclude"/,
  );
  assert.doesNotMatch(editor, /labeled\("(?:关系|对象|条件)"/);
  assert.doesNotMatch(editor, /body\.append\(form, save/);
});

test("continues entity-reference suggestions until the release is exhausted", () => {
  const picker = queryBarSource.match(
    /private openEntityPicker\([\s\S]*?\n  }(?=\n\n  private cancelSuggestions)/,
  )?.[0];
  const provider = queryRuntimeSource.match(
    /const suggestQueryEntities = async function\*[\s\S]*?\n  };(?=\n\n  const navigateEntity)/,
  )?.[0];

  assert.ok(picker);
  assert.ok(provider);
  assert.match(picker, /AsyncIterator<EntitySuggestionBatch>/);
  assert.match(picker, /results\.addEventListener\("scroll"/);
  assert.match(picker, /revealMore\(\)/);
  assert.match(provider, /while \(cursors\.length\)/);
  assert.match(provider, /complete: cursors\.length === 0/);
  assert.doesNotMatch(provider, /limit:\s*\d+|slice\(0,/);
  assert.match(queryRuntimeSource, /limit: offset \+ pageSize \+ 1/);
});

test("gives the complete relationship vocabulary a full-width searchable list", () => {
  assert.match(queryBarSource, /`选择\$\{OWNER_LABEL\[targetOwner\]\}`/);
  assert.match(
    queryStyles,
    /\.query-relation-exclude\[aria-pressed="true"\]\s*\{[^}]*border-color:\s*var\(--pink\)/s,
  );
  assert.match(
    queryStyles,
    /\.query-relation-editor \.query-entity-picker-button\s*\{[^}]*width:\s*12ch[^}]*text-overflow:\s*ellipsis/s,
  );
  assert.match(
    queryStyles,
    /\.query-relation-picker-list\s*\{[^}]*grid-template-columns:[^;}]*auto-fit[^}]*max-height:[^;}]*[^}]*overflow:\s*auto/s,
  );
  assert.match(
    queryStyles,
    /\.query-relation-search\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none/s,
  );
  assert.doesNotMatch(queryStyles, /\.query-relation-choice > \.query-popover-control/);
});

test("does not offer modifier controls for answer-only shapes", () => {
  const draft = {
    kind: "path",
    from: "subject:1" as const,
    to: "person:2" as const,
    maxHops: 6,
    maxPaths: 10,
  } as const;

  assert.deepEqual(queryAddChoices(draft), []);
  assert.deepEqual(queryAddChoices({
    kind: "aggregate",
    query: {
      owner: "subject",
      aggregate: { groupBy: [], metrics: [{ function: "count" }] },
    },
  }), []);
});

test("does not offer singular fragments already represented by tokens", () => {
  const draft: QueryDraft = {
    kind: "list",
    query: {
      scope: ["subject"] as const,
      fullText: {
        value: "时间旅行",
      },
      orderBy: [{
        column: "score",
        direction: "desc" as const,
        nulls: "last" as const,
      }],
    },
  };

  assert.deepEqual(
    new Set(queryAddChoices(draft).map(({ kind }) => kind)),
    new Set(["condition", "relation"]),
  );
  assert.deepEqual(queryAddChoices({ kind: "list", allText: "星空" }), []);
});

test("offers Episode ownership as a named entity condition", () => {
  const choice = queryAddChoices({
    kind: "list",
    query: { scope: ["episode"] },
  }).find(({ id }) => id === "condition:episode:subjectRef");

  assert.deepEqual(choice, {
    id: "condition:episode:subjectRef",
    kind: "condition",
    label: "所属作品",
    detail: "",
    owners: ["episode"],
    field: "subjectRef",
  });
  assert.match(queryBarSource, /referenceOwner:\s*\(field\)\s*=>\s*queryReferenceOwner\(owner, field\)/);
  assert.match(
    queryBarSource,
    /const referenceOwner = config\.referenceOwner\?\.\(node\.field\)[\s\S]*?openEntityPicker\([\s\S]*?\[referenceOwner\]/,
  );
});

test("resolves labels only for entity-reference conditions", () => {
  assert.deepEqual(conditionEntityRefs("episode", {
    kind: "compare",
    field: "subjectRef",
    operator: "eq",
    value: "subject:265",
  }), ["subject:265"]);
  assert.deepEqual(conditionEntityRefs("subject", {
    kind: "compare",
    field: "name",
    operator: "eq",
    value: "subject:265",
  }), []);
});

test("treats a result count as part of an ordered top-N answer", () => {
  const draft = {
    kind: "list",
    query: { scope: ["subject"] as const },
  } as const;
  const orderBy = [{
    column: "score",
    direction: "desc" as const,
    nulls: "last" as const,
  }];

  const ranked = applyOrderAndLimit(draft, orderBy, 10);
  assert.deepEqual(ranked, {
    kind: "list",
    query: { scope: ["subject"], orderBy, limit: 10 },
  });
  assert.deepEqual(applyOrderAndLimit(ranked, undefined, undefined), draft);
});

test("does not split query fragments into a secondary operation menu", () => {
  assert.doesNotMatch(
    queryBarSource,
    /其他操作|其他查询操作|openActions|openActionMenu|openScopedActions|返回全部操作/,
  );
});

test("edits the result scope without asking users to choose an answer shape", () => {
  assert.doesNotMatch(queryBarSource, /openShapeEditor|选择答案/);
});

test("does not expose result count as a standalone editor", () => {
  assert.doesNotMatch(queryBarSource, /结果条数|最多结果数|最多显示/);
});

test("reveals boolean group controls only for an actual group", () => {
  const leaf: EditCondition = {
    kind: "leaf",
    field: "type",
    operator: "eq",
    raw: "2",
  };

  assert.equal(conditionGroupControlsVisible(leaf), false);
  assert.equal(conditionGroupControlsVisible({ kind: "all", terms: [leaf] }), false);
  assert.equal(conditionGroupControlsVisible({ kind: "all", terms: [leaf, leaf] }), true);
  assert.equal(conditionGroupControlsVisible({ kind: "any", terms: [leaf, leaf] }), true);
  assert.equal(conditionGroupControlsVisible({ kind: "not", terms: [leaf] }), true);
});

test("keeps the quick condition composer on one wrapping row", () => {
  assert.match(
    queryStyles,
    /\.query-condition-editor-compact\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/s,
  );
  assert.match(
    queryStyles,
    /\.query-condition-editor-compact\s+\.query-condition-tree\s*\{[^}]*flex:/s,
  );
  assert.match(
    queryStyles,
    /\.query-condition-editor-compact\s+footer\s*\{[^}]*margin-top:\s*0/s,
  );
});

test("reserves a separate trailing cell for the add action", () => {
  const inputGroup = queryStyles.match(/\.query-input-group\s*\{(?<body>[^}]*)\}/s)
    ?.groups?.body ?? "";

  assert.match(inputGroup, /display:\s*grid/);
  assert.match(inputGroup, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+36px/);
  assert.match(inputGroup, /gap:\s*4px/);
});

test("keeps the name input and query action in one command group", () => {
  assert.match(
    queryBarSource,
    /this\.commandGroup\.append\(this\.inputGroup, this\.submit\)/,
  );
  assert.match(
    queryStyles,
    /\.query-command-group\s*\{[^}]*display:\s*flex[^}]*gap:\s*6px/s,
  );
});

test("does not maintain a separate viewport-specific query UI", () => {
  assert.doesNotMatch(queryStyles, /@media\s*\(max-width:/);
  assert.match(queryStyles, /@container\s*\(max-width:\s*34rem\)/);
});

test("lets add choices choose columns from their readable content width", () => {
  assert.match(
    queryStyles,
    /\.query-add-list\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(12rem,\s*100%\),\s*1fr\)\)/s,
  );
});

test("fits the query panel into the visible height after browser zoom", () => {
  assert.equal(queryPanelMaxHeight(116, 256, 179, 14), 126);
  assert.equal(queryPanelMaxHeight(72, 900, 560, 14), 560);
});

test("sizes query internals from their container and the dynamic viewport", () => {
  const workbench = queryStyles.match(/#query-workbench\s*\{(?<body>[^}]*)\}/s)
    ?.groups?.body ?? "";
  const tokenShell = queryStyles.match(/\.query-token-shell\s*\{(?<body>[^}]*)\}/s)
    ?.groups?.body ?? "";

  assert.match(
    workbench,
    /height:\s*calc\(100dvh\s*-\s*var\(--page-inset\)\s*-\s*var\(--page-inset\)\)/,
  );
  assert.doesNotMatch(tokenShell, /\b(?:d?vw)\b/);
});

test("uses distinct semantic colors for query token roles", () => {
  const hues = ["entity", "text", "condition", "relation", "shape"].map((kind) => {
    const match = queryStyles.match(
      new RegExp(`\\.query-token-${kind}[^\\{]*\\{[^}]*--token-hue:\\s*(\\d+)`, "s"),
    );
    assert.ok(match, `missing semantic color for ${kind} tokens`);
    return match[1];
  });

  assert.equal(new Set(hues).size, hues.length);
  assert.match(
    queryStyles,
    /\.query-token\s*\{[^}]*border:[^;]*var\(--token-hue\)[^;]*;[^}]*background:[^;]*var\(--token-hue\)[^;]*;[^}]*color:[^;]*var\(--token-hue\)/s,
  );
});

test("offers vocabulary suggestions only for the two subject tag fields", () => {
  assert.equal(tagVocabularyField("subject", "tags"), "tags");
  assert.equal(tagVocabularyField("subject", "metaTags"), "metaTags");
  assert.equal(tagVocabularyField("person", "tags"), null);
  assert.equal(tagVocabularyField("subject", "name"), null);
  assert.deepEqual(featuredMetaTagValuesFor("metaTags", ["原创", "日本"]), [
    "原创",
    "日本",
  ]);
  const complete = Array.from({ length: 24 }, (_, index) => `分类 ${index + 1}`);
  assert.deepEqual(featuredMetaTagValuesFor("metaTags", complete), complete);
  assert.equal(featuredMetaTagValuesFor("tags", ["原创", "日本"]), undefined);
});

test("shows complete numeric comparisons without redundant set operators", () => {
  const complete = [
    "eq", "ne", "lt", "lte", "gt", "gte", "in", "notIn", "isNull",
    "isNotNull",
  ];

  assert.deepEqual(conditionEditorOperatorChoices(
    complete,
    "number",
    "eq",
  ), ["eq", "ne", "lt", "lte", "gt", "gte", "isNull", "isNotNull"]);
  assert.deepEqual(conditionEditorOperatorChoices(
    complete,
    "number",
    "in",
  ), ["eq", "ne", "lt", "lte", "gt", "gte", "isNull", "isNotNull", "in"]);
  assert.deepEqual(conditionEditorOperatorChoices(
    ["eq", "ne", "in", "notIn"],
    "text",
    "eq",
  ), ["eq", "ne", "in", "notIn"]);
  assert.deepEqual(conditionEditorOperatorChoices(
    ["eq", "ne", "gt", "gte", "in", "notIn", "isNull", "isNotNull"],
    "text",
    "eq",
    6,
  ), ["eq", "ne", "in", "notIn", "isNull", "isNotNull"]);
  assert.deepEqual(conditionEditorOperatorChoices(
    ["eq", "ne", "in", "notIn", "isNull", "isNotNull"],
    "text",
    "eq",
    2,
  ), ["eq", "isNull", "isNotNull"]);
  assert.deepEqual(conditionEditorOperatorChoices(
    ["contains", "notContains"],
    "text",
    "contains",
    7,
  ), ["contains", "notContains"]);
  assert.deepEqual(conditionEditorOperatorChoices(
    complete,
    "date",
    "gte",
  ), ["eq", "ne", "lt", "lte", "gt", "gte", "isNull", "isNotNull"]);
  assert.equal(conditionValueInputType("number", "gte"), "number");
  assert.equal(conditionValueInputType("number", "in"), "text");
  assert.equal(conditionValueInputType("text", "in"), "text");
  assert.equal(conditionValueInputType("date", "gte"), "date");
  assert.equal(conditionValueInputStep("number", "gte"), "any");
  assert.equal(conditionValueInputStep("number", "in"), null);
  assert.equal(conditionValueInputStep("text", "eq"), null);
  assert.doesNotMatch(queryBarSource, /更多…|MORE_CONDITION_OPERATORS/);
});

test("renders a fixed operator as text instead of a one-option menu", () => {
  const editor = queryBarSource.match(
    /private openConditionEditor\([\s\S]*?\n  }(?=\n\n  private openRelationEditor)/,
  )?.[0];

  assert.ok(editor);
  assert.match(editor, /visible\.length === 1/);
  assert.match(editor, /query-condition-operator-label/);
  assert.match(
    queryStyles,
    /\.query-condition-operator-label\s*\{[^}]*white-space:\s*nowrap/s,
  );
});

test("keeps conjunction and negation as separate, lossless concepts", () => {
  const editor = queryBarSource.match(
    /private openConditionEditor\([\s\S]*?\n  }(?=\n\n  private openRelationEditor)/,
  )?.[0];

  assert.ok(editor);
  assert.doesNotMatch(editor, /option\("not", "排除"\)|terms\.splice\(1\)/);
  assert.match(editor, /排除以下条件/);
  assert.doesNotMatch(editor, /＋ 条件组/);
});

test("uses direct choices instead of a modifier-key multi-select listbox", () => {
  const editor = queryBarSource.match(
    /private openConditionEditor\([\s\S]*?\n  }(?=\n\n  private openRelationEditor)/,
  )?.[0];

  assert.ok(editor);
  assert.match(editor, /query-multi-choice/);
  assert.doesNotMatch(editor, /control\.multiple = multiple|control\.size =/);
});

test("uses a search icon for querying and a stop icon while running", () => {
  assert.deepEqual(queryRunPresentation({
    running: false,
    runnable: true,
  }), {
    icon: "search",
    ariaLabel: "执行查询",
    disabled: false,
    busy: false,
  });
  assert.doesNotMatch(queryBarSource, /更新结果/);
  assert.deepEqual(queryRunPresentation({
    running: true,
    runnable: true,
  }), {
    icon: "stop",
    ariaLabel: "正在查询，点击停止",
    disabled: false,
    busy: true,
  });
  assert.deepEqual(queryRunPresentation({
    running: false,
    runnable: false,
  }), {
    icon: "search",
    ariaLabel: "当前查询不可执行",
    disabled: true,
    busy: false,
  });
});

test("keeps the persistent query input independent from popover sizing", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
  } as unknown as Document;

  try {
    const control = createQueryNameInput() as unknown as FakeElement;

    assert.equal(control.className, "query-name-input");
    assert.equal(control.attributes.get("aria-label"), "按名称、中文名或别名查找");
  } finally {
    globalThis.document = originalDocument;
  }
});

test("keeps a new enum condition's visible default as its real value", () => {
  const edit = createDefaultConditionEdit({
    fields: () => ["type"],
    operators: () => ["eq"],
    values: () => ({ "1": "书籍", "2": "动画" }),
  });

  assert.deepEqual(edit, {
    kind: "leaf",
    field: "type",
    operator: "eq",
    raw: "1",
  });
});

test("starts a condition at the field chosen in the add picker", () => {
  const edit = createDefaultConditionEdit({
    fields: () => ["type", "score"],
    operators: (field) => field === "score" ? ["gte"] : ["eq"],
    values: (field) => field === "type" ? { "1": "书籍" } : null,
  }, "score");

  assert.deepEqual(edit, {
    kind: "leaf",
    field: "score",
    operator: "gte",
    raw: "",
  });
});

test("keeps the visible enum value real after switching fields", () => {
  const choices = { "1": "书籍", "2": "动画" };

  assert.equal(resolveSingleChoiceValue("", choices), "1");
  assert.equal(resolveSingleChoiceValue("2", choices), "2");
});

test("gives a removable token an independent mouse delete button", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
  } as unknown as Document;
  let edits = 0;
  let removals = 0;

  try {
    const control = createQueryTokenControl(removableToken, {
      edit: () => edits++,
      remove: () => removals++,
    }) as unknown as FakeElement;
    const [token, remove] = control.children;

    assert.equal(control.className, "query-token-shell");
    assert.equal(token?.textContent, "评分 ≥ 8");
    assert.equal(remove?.dataset.queryIcon, "close");
    assert.equal(remove?.children.length, 1);
    assert.equal(remove?.attributes.get("aria-label"), "删除：评分 ≥ 8");

    const click = remove?.emit("click");
    assert.equal(click?.defaultPrevented, true);
    assert.equal(click?.propagationStopped, true);
    assert.equal(removals, 1);
    assert.equal(edits, 0);

    token?.emit("click");
    assert.equal(edits, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("keeps keyboard deletion on the token itself", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
  } as unknown as Document;
  let removals = 0;

  try {
    const control = createQueryTokenControl(removableToken, {
      edit: () => undefined,
      remove: () => removals++,
    }) as unknown as FakeElement;
    const event = control.children[0]?.emit("keydown", new FakeEvent("Delete"));

    assert.equal(event?.defaultPrevented, true);
    assert.equal(removals, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("finds the token button inside its removable mouse-control shell", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
  } as unknown as Document;

  try {
    const control = createQueryTokenControl(removableToken, {
      edit: () => undefined,
      remove: () => undefined,
    }) as unknown as FakeElement;

    assert.equal(
      findQueryTokenButton(control as unknown as Element),
      control.children[0],
    );
  } finally {
    globalThis.document = originalDocument;
  }
});

test("focuses the nearest surviving token after mouse or keyboard deletion", () => {
  assert.equal(tokenFocusIndexAfterRemoval(2, 4), 2);
  assert.equal(tokenFocusIndexAfterRemoval(4, 4), 3);
  assert.equal(tokenFocusIndexAfterRemoval(0, 0), -1);
});

test("forces the active text input to follow history navigation", () => {
  assert.equal(shouldSyncQueryInput(true, "星空", true), true);
  assert.equal(shouldSyncQueryInput(true, "星空", false), false);
});

test("commits the visible name before a structural action can restore stale text", () => {
  const draft = {
    kind: "list" as const,
    query: {
      scope: ["episode"] as const,
      text: { value: "机", capability: "lookup" as const },
    },
  };

  assert.deepEqual(visibleNameAction(draft, ""), {
    type: "setText",
    text: undefined,
  });
  assert.equal(visibleNameAction(draft, "机"), null);
});

test("accepts the conjunction selected for the outer condition group", () => {
  const config = {
    fields: () => ["score"],
    fieldLabel: (field: string) => field,
    operators: () => ["gte"],
    values: () => null,
    inputType: () => "number" as const,
    create: (field: string, operator: string, raw: string) => ({
      kind: "compare" as const,
      field,
      operator: operator as "gte",
      value: Number(raw),
    }),
  };

  const edit: EditCondition = {
      kind: "any",
      terms: [
        { kind: "leaf", field: "score", operator: "gte", raw: "8" },
        { kind: "leaf", field: "score", operator: "gte", raw: "9" },
      ],
    };
  const saved = finishConditionEdit(edit, config);

  assert.deepEqual(saved, {
      kind: "any",
      terms: [
        { kind: "compare", field: "score", operator: "gte", value: 8 },
        { kind: "compare", field: "score", operator: "gte", value: 9 },
      ],
    });
  assert.deepEqual(createConditionEditRoot(saved), edit);
});

test("restores focus to the same repeated control after an editor redraw", () => {
  const before = [new FakeElement(), new FakeElement()];
  const after = [new FakeElement(), new FakeElement()];
  for (const control of [...before, ...after]) control.setAttribute("aria-label", "字段");

  const focus = captureControlFocus(
    before[1] as unknown as Element,
    before as unknown as HTMLElement[],
  );

  assert.deepEqual(focus, { key: "字段", index: 1 });
  assert.equal(
    restoreControlFocus(focus, after as unknown as HTMLElement[]),
    after[1],
  );
});

test("prefers the explicit primary control, then a field, then the first control", () => {
  const first = new FakeElement();
  const value = new FakeElement();
  value.dataset.queryPrimary = "true";
  const clicked = new FakeElement();
  clicked.dataset.queryFocus = "true";
  const field = new FakeElement();
  field.setAttribute("aria-label", "字段");

  assert.equal(
    findPrimaryEditorControl(
      [first, field, value, clicked] as unknown as HTMLElement[],
    ),
    clicked,
  );
  assert.equal(
    findPrimaryEditorControl([first, field, value] as unknown as HTMLElement[]),
    value,
  );
  assert.equal(
    findPrimaryEditorControl([first, field] as unknown as HTMLElement[]),
    field,
  );
  assert.equal(
    findPrimaryEditorControl([first] as unknown as HTMLElement[]),
    first,
  );
});

test("focuses the condition term represented by the clicked token", () => {
  const first: EditCondition = {
    kind: "leaf", field: "year", operator: "eq", raw: "2024",
  };
  const second: EditCondition = {
    kind: "leaf", field: "score", operator: "gte", raw: "8",
  };
  const root: EditCondition = { kind: "all", terms: [first, second] };

  assert.equal(conditionEditFocusTerm(root, 1), second);
  assert.equal(conditionEditFocusTerm(root, 2), undefined);
});

test("starts common sort fields in their user-expected direction", () => {
  assert.deepEqual(createSortTerm("score"), {
    column: "score",
    direction: "desc",
    nulls: "last",
  });
  assert.deepEqual(createSortTerm("rank"), {
    column: "rank",
    direction: "asc",
    nulls: "first",
  });
  assert.deepEqual(createSortTerm("score", ["subject"]), {
    column: "score",
    owners: ["subject"],
    direction: "desc",
    nulls: "last",
  });
  assert.deepEqual(
    sortTermWithDirection(createSortTerm("score", ["subject"]), "asc"),
    {
      column: "score",
      owners: ["subject"],
      direction: "asc",
      nulls: "last",
    },
  );
});

test("puts an exact entity name before earlier substring suggestions", () => {
  assert.deepEqual(
    rankEntitySuggestions("宮崎駿", [
      { ref: "subject:1", owner: "subject", label: "宮崎駿：十年一夢" },
      { ref: "person:1", owner: "person", label: "宮崎駿", match: "宮崎駿" },
    ]).map((item) => item.ref),
    ["person:1", "subject:1"],
  );
});

test("creates only a scoped body condition without inferring a query mode", () => {
  const draft: QueryDraft = {
    kind: "list",
    query: {
      scope: ["subject"],
      condition: {
        kind: "compare",
        field: "score",
        operator: "gte",
        value: 8,
      },
    },
  };
  assert.deepEqual(
    applyQueryAction(draft, createScopedFullTextAction("  时间旅行  ")),
    {
      kind: "list",
      query: {
        ...draft.query,
        fullText: {
          value: "时间旅行",
        },
      },
    },
  );

  const withName: QueryDraft = {
    kind: "list",
    query: {
      scope: ["subject", "episode"],
      text: { value: "机器人", capability: "lookup" },
    },
  };
  assert.deepEqual(
    applyQueryAction(withName, createScopedFullTextAction("未来")),
    {
      kind: "list",
      query: {
        ...withName.query,
        fullText: { value: "未来" },
      },
    },
  );
  assert.throws(() => createScopedFullTextAction("星"), /至少需要/);

  const editor = queryBarSource.match(
    /private openBodyTextEditor\([\s\S]*?\n  }(?=\n\n  private openAllTextEditor)/,
  )?.[0];
  assert.ok(editor);
  assert.match(editor, /openConditionEditor/);
  assert.match(editor, /const scope = draftScope\(this\.history\.current\)/);
  assert.match(editor, /const label = scopedFullTextLabel\(scope\)/);
  assert.match(editor, /label,\s*leaf,\s*this\.textLeafConfig\("body", label\)/);
  assert.match(editor, /createScopedFullTextAction\(leaf\.raw\)/);
  assert.doesNotMatch(editor, /document\.createElement\("form"\)/);
  assert.doesNotMatch(editor, /正文范围|labeled\("范围"|select\(/);
  assert.match(
    queryStyles,
    /\.query-condition-editor-compact \.query-condition-value\s*\{[^}]*flex:\s*1/s,
  );
  assert.match(
    queryStyles,
    /\.query-condition-editor-compact \.query-condition-value > \.query-popover-control\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none/s,
  );
  assert.doesNotMatch(queryStyles, /query-text-editor|query-all-text-action/);
  for (const [scope, label] of [
    [["subject"], "简介"],
    [["episode"], "分集介绍"],
    [["subject", "episode"], "简介与分集介绍"],
  ] as const) {
    const choice = queryAddChoices({ kind: "list", query: { scope } })
      .find(({ kind }) => kind === "fullText");
    assert.equal(choice?.label, label);
    assert.equal(choice?.detail, "内容包含关键词");
  }
});

test("moves autocomplete selection with wrapping arrow-key navigation", () => {
  assert.equal(moveSuggestionIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(moveSuggestionIndex(0, 3, "ArrowUp"), 2);
  assert.equal(moveSuggestionIndex(2, 3, "ArrowDown"), 0);
  assert.equal(moveSuggestionIndex(0, 0, "ArrowDown"), -1);
});

test("uses slash as an action shortcut only in an otherwise empty name input", () => {
  assert.equal(isActionShortcut("/", ""), true);
  assert.equal(isActionShortcut("/", "已有文字"), false);
  assert.equal(isActionShortcut("/条件", ""), false);
  assert.equal(isActionShortcut("机器人/动画", "机器人"), false);
});

test("derives name suggestions from the same visible entity scope", () => {
  assert.deepEqual(queryNameSuggestionOwners({
    kind: "list",
    query: { scope: ["subject", "person", "character"] },
  }), ["subject", "person", "character"]);
  assert.deepEqual(queryNameSuggestionOwners({
    kind: "list",
    allText: "时间旅行",
  }), []);
  assert.deepEqual(queryNameSuggestionOwners({
    kind: "path",
    from: "subject:1",
    to: "person:2",
    maxHops: 6,
    maxPaths: 10,
  }), []);
});
