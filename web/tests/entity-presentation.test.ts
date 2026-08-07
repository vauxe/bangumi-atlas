import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectionBreakdown,
  parseInfobox,
  relationshipSection,
  scoreBreakdown,
  tagGroups,
} from "../src/entity-presentation";
import type { Fact, SubjectEntity } from "../src/types";

const S = (id: number): number => (1 << 24) | id;
const P = (id: number): number => (2 << 24) | id;
const C = (id: number): number => (3 << 24) | id;

function subject(overrides: Partial<SubjectEntity> = {}): SubjectEntity {
  return {
    kind: "subject",
    key: S(1),
    name: "Example",
    nameCn: "示例",
    type: 4,
    platformCode: null,
    date: "",
    score: null,
    bgmRank: null,
    nsfw: false,
    favorite: [11, 22, 33, 44, 55],
    series: false,
    scoreDetails: [],
    metaTags: [],
    tags: [],
    hasSummary: false,
    hasInfobox: false,
    ...overrides,
  };
}

test("collection breakdown uses media-specific verbs without dropping counts", () => {
  assert.deepEqual(collectionBreakdown(subject()), [
    { label: "想玩", count: 11 },
    { label: "玩过", count: 22 },
    { label: "在玩", count: 33 },
    { label: "搁置", count: 44 },
    { label: "抛弃", count: 55 },
  ]);

  assert.deepEqual(
    collectionBreakdown(subject({ type: 1 })).map((item) => item.label),
    ["想读", "读过", "在读", "搁置", "抛弃"],
  );
  assert.deepEqual(
    collectionBreakdown(subject({ type: 3 })).map((item) => item.label),
    ["想听", "听过", "在听", "搁置", "抛弃"],
  );
});

test("score breakdown exposes all ten source buckets in scan order", () => {
  assert.deepEqual(scoreBreakdown([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [
    { score: 10, count: 10 },
    { score: 9, count: 9 },
    { score: 8, count: 8 },
    { score: 7, count: 7 },
    { score: 6, count: 6 },
    { score: 5, count: 5 },
    { score: 4, count: 4 },
    { score: 3, count: 3 },
    { score: 2, count: 2 },
    { score: 1, count: 1 },
  ]);
});

test("tag groups preserve every structural tag and source count", () => {
  const tags = tagGroups(
    subject({
      metaTags: ["科幻", "TV", "日本"],
      tags: [
        ["时间旅行", 1200],
        ["悬疑", 900],
        ["世界线", 300],
      ],
    }),
  );

  assert.deepEqual(tags, {
    meta: ["科幻", "TV", "日本"],
    community: [
      { label: "时间旅行", count: 1200 },
      { label: "悬疑", count: 900 },
      { label: "世界线", count: 300 },
    ],
  });
});

test("infobox parser preserves official scalar and list structure", () => {
  const source = `{{Infobox animanga/TVAnime
|中文名= 命运石之门
|别名={
[日文简称|シュタゲ]
[石头门]
}
|话数= 25
|导演= 佐藤卓哉 / 浜崎博嗣
}}`;

  assert.deepEqual(parseInfobox(source), {
    template: "animanga/TVAnime",
    fields: [
      { label: "中文名", kind: "text", value: "命运石之门" },
      {
        label: "别名",
        kind: "list",
        items: [
          { label: "日文简称", value: "シュタゲ" },
          { value: "石头门" },
        ],
      },
      { label: "话数", kind: "text", value: "25" },
      { label: "导演", kind: "text", value: "佐藤卓哉 / 浜崎博嗣" },
    ],
  });
});

test("infobox parser keeps duplicate fields in source order", () => {
  const parsed = parseInfobox(`{{Infobox Crt\r
|职业= 声优\r
|职业= 歌手\r
}}`);

  assert.deepEqual(parsed.fields, [
    { label: "职业", kind: "text", value: "声优" },
    { label: "职业", kind: "text", value: "歌手" },
  ]);
});

test("infobox parser exposes a fail-soft issue for unusual source", () => {
  assert.deepEqual(parseInfobox("free-form source"), {
    template: "",
    fields: [],
    issue: { line: 1 },
  });
});

test("every typed fact kind maps to a user-language section", () => {
  const facts: Fact[] = [
    {
      kind: "RELATES_TO",
      ref: 1,
      multiplicity: 1,
      source: S(1),
      target: S(2),
      relationType: 1,
      sortOrder: 0,
    },
    {
      kind: "WORKED_ON",
      ref: 2,
      multiplicity: 1,
      person: P(1),
      subject: S(1),
      position: 1,
      appearEps: "",
    },
    {
      kind: "APPEARS_IN",
      ref: 3,
      multiplicity: 1,
      character: C(1),
      subject: S(1),
      type: 1,
      sortOrder: 0,
    },
    {
      kind: "VOICE_CREDIT",
      ref: 4,
      multiplicity: 1,
      person: P(1),
      character: C(1),
      subjectContext: S(1),
      type: 1,
      hasSummary: false,
    },
    {
      kind: "PERSON_REL",
      ref: 5,
      multiplicity: 1,
      source: P(1),
      target: P(2),
      relationType: 1,
      spoiler: false,
      ended: false,
    },
    {
      kind: "CHARACTER_REL",
      ref: 6,
      multiplicity: 1,
      source: C(1),
      target: C(2),
      relationType: 1,
      spoiler: false,
      ended: false,
    },
  ];

  assert.deepEqual(facts.map(relationshipSection), [
    { id: "works", label: "作品谱系" },
    { id: "credits", label: "创作者与制作" },
    { id: "cast", label: "角色与出演" },
    { id: "voices", label: "配音关联" },
    { id: "people", label: "人物关系" },
    { id: "characters", label: "角色关系" },
  ]);
});
