import assert from "node:assert/strict";
import { test } from "node:test";

import type { Fact, Mappings, Page, StructuralEntity } from "../src/types";
import {
  SiteQueryDataSource,
  type SiteQueryReader,
  type SiteQuerySearch,
} from "../src/query/site-source";

const key = (kind: number, id: number): number => (kind << 24) | id;

const subject: StructuralEntity = {
  kind: "subject",
  key: key(1, 3),
  name: "原名",
  nameCn: "中文名",
  type: 2,
  platformCode: 1,
  date: "2024-01-01",
  score: 8.5,
  bgmRank: 42,
  nsfw: false,
  favorite: [1, 2, 3, 4, 5],
  series: true,
  scoreDetails: [0, 0, 0, 0, 0, 0, 0, 1, 2, 3],
  metaTags: ["TV"],
  tags: [["科幻", 100], ["群像", 30]],
  hasSummary: true,
  hasInfobox: false,
};

const voice: Fact = {
  kind: "VOICE_CREDIT",
  ref: 7,
  multiplicity: 2,
  person: key(2, 11),
  character: key(3, 12),
  subjectContext: key(1, 3),
  type: 1,
  hasSummary: true,
};

const mappings: Mappings = {
  fact_labels: {},
  subject_type: { "2": "动画" },
  platform: { "2:1": "TV" },
  person_type: {},
  character_role: {},
  episode_type: { "0": "本篇" },
};

test("maps the existing complete structural entity to query fields", async () => {
  const reader: SiteQueryReader = {
    entities: async function* () {
      yield subject;
    },
    entity: async () => subject,
    mappings: async () => mappings,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const source = new SiteQueryDataSource(reader);

  const rows = [];
  for await (const entity of source.scan("subject")) rows.push(entity);

  assert.deepEqual(rows, [{
    kind: "entity",
    owner: "subject",
    ref: "subject:3",
    fields: {
      name: "原名",
      nameCn: "中文名",
      type: 2,
      platform: "TV",
      date: "2024-01-01",
      year: 2024,
      score: 8.5,
      rank: 42,
      nsfw: false,
      wish: 1,
      done: 2,
      doing: 3,
      onHold: 4,
      dropped: 5,
      series: true,
      scoreDetails: subject.scoreDetails,
      metaTags: ["TV"],
      tags: [
        { name: "科幻", count: 100 },
        { name: "群像", count: 30 },
      ],
      hasSummary: true,
      summaryState: "HAS",
      hasInfobox: false,
    },
  }]);
});

test("decodes a projected platform without leaking its physical context fields", async () => {
  let requested: readonly string[] = [];
  const reader: SiteQueryReader = {
    entities: async function* () {},
    projectEntities: async function* (_owner, fields) {
      requested = fields;
      yield {
        kind: "subject",
        key: key(1, 3),
        fields: { type: 2, platformCode: 1 },
      };
    },
    entity: async () => subject,
    mappings: async () => mappings,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const source = new SiteQueryDataSource(reader);
  const rows = [];

  for await (const entity of source.scan("subject", undefined, ["platform"]))
    rows.push(entity);

  assert.deepEqual(requested, ["type", "platformCode"]);
  assert.deepEqual(rows[0]?.fields, { platform: "TV" });
});

test("treats an unmapped platform sentinel as absent", async () => {
  const reader: SiteQueryReader = {
    entities: async function* () {},
    projectEntities: async function* () {
      yield {
        kind: "subject",
        key: key(1, 3),
        fields: { type: 3, platformCode: 0 },
      };
    },
    entity: async () => null,
    mappings: async () => mappings,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const source = new SiteQueryDataSource(reader);
  const rows = [];

  for await (const entity of source.scan("subject", undefined, ["platform"]))
    rows.push(entity);

  assert.deepEqual(rows[0]?.fields, { platform: null });
});

test("uses the query projection reader when scan fields are known", async () => {
  let requested: readonly string[] = [];
  const reader: SiteQueryReader = {
    entities: async function* () {
      throw new Error("full entity scan should not run");
    },
    projectEntities: async function* (_owner, fields) {
      requested = fields;
      yield {
        kind: "subject",
        key: key(1, 3),
        fields: { name: "原名", score: 8.5 },
      };
    },
    entity: async () => subject,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const source = new SiteQueryDataSource(reader);

  const rows = [];
  for await (const entity of source.scan(
    "subject",
    undefined,
    ["name", "score"],
  )) rows.push(entity);

  assert.deepEqual(requested, ["name", "score"]);
  assert.deepEqual(rows[0], {
    kind: "entity",
    owner: "subject",
    ref: "subject:3",
    fields: { name: "原名", score: 8.5 },
  });
});

test("rejects a projected field missing from the SiteRelease implementation", async () => {
  const source = new SiteQueryDataSource({
    entities: async function* () {},
    projectEntities: async function* () {
      yield { kind: "person", key: key(2, 11), fields: {} };
    },
    entity: async () => null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  });

  await assert.rejects(async () => {
    for await (const _entity of source.scan("person", undefined, ["name"])) {
      assert.fail("an incomplete projection cannot produce a query row");
    }
  }, /projection omitted person\.name/);
});

test("does not project synthetic empty nameCn values for Person and Character", async () => {
  const entities: StructuralEntity[] = [
    {
      kind: "person",
      key: key(2, 11),
      name: "Alice",
      type: 1,
      career: [],
      comments: 0,
      collects: 0,
      hasSummary: false,
      hasInfobox: true,
    },
    {
      kind: "character",
      key: key(3, 12),
      name: "Bob",
      role: 1,
      comments: 0,
      collects: 0,
      hasSummary: false,
      hasInfobox: true,
    },
  ];
  const reader: SiteQueryReader = {
    entities: async function* (owner) {
      yield* entities.filter((entity) => entity.kind === owner);
    },
    entity: async () => null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const source = new SiteQueryDataSource(reader);

  const rows = [];
  for await (const entity of source.scan("person")) rows.push(entity);
  for await (const entity of source.scan("character")) rows.push(entity);

  assert.equal("nameCn" in rows[0]!.fields, false);
  assert.equal("nameCn" in rows[1]!.fields, false);
});

test("normalizes the archived Person type zero outside the official enum", async () => {
  const archived = {
    kind: "person" as const,
    key: key(2, 22),
    name: "历史脏行",
    type: 0,
    career: [],
    comments: 0,
    collects: 0,
    hasSummary: false,
    hasInfobox: false,
  };
  const reader: SiteQueryReader = {
    entities: async function* () { yield archived; },
    entity: async () => archived,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const source = new SiteQueryDataSource(reader);
  const rows = [];

  for await (const entity of source.scan("person")) rows.push(entity);

  assert.equal(rows[0]?.fields.type, null);
  assert.equal((await source.entity("person:22"))?.fields.type, null);

  const projected = new SiteQueryDataSource({
    ...reader,
    projectEntities: async function* () {
      yield { kind: "person", key: key(2, 22), fields: { type: 0 } };
    },
  });
  const projectedRows = [];
  for await (const entity of projected.scan("person", undefined, ["type"]))
    projectedRows.push(entity);
  assert.equal(projectedRows[0]?.fields.type, null);
});

test("reads every fact page and preserves roles, ref, and multiplicity", async () => {
  const cursors: (string | undefined)[] = [];
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    factsFor: async (_key, cursor): Promise<Page<Fact>> => {
      cursors.push(cursor);
      return cursor === undefined
        ? { items: [], total: 1, next: "0" }
        : { items: [voice], total: 1, next: null };
    },
  };
  const source = new SiteQueryDataSource(reader);

  const facts = [];
  for await (const fact of source.facts!("person:11")) facts.push(fact);

  assert.deepEqual(cursors, [undefined, "0"]);
  assert.deepEqual(facts, [{
    kind: "fact",
    factKind: "VOICE_CREDIT",
    ref: "fact:7",
    multiplicity: 2,
    roles: {
      person: "person:11",
      character: "character:12",
      subjectContext: "subject:3",
    },
    fields: { type: 1, hasSummary: true, summaryState: "HAS" },
  }]);
});

test("loads a canonical fact directly through the published FactRef index", async () => {
  let requested: number | undefined;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    fact: async (ref) => {
      requested = ref;
      return ref === 7 ? voice : null;
    },
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const source = new SiteQueryDataSource(reader);

  const fact = await source.fact!("fact:7");

  assert.equal(requested, 7);
  assert.equal(fact?.ref, "fact:7");
  assert.equal(fact?.factKind, "VOICE_CREDIT");
});

test("uses the Episode ownership indexes for typed reference traversal", async () => {
  const episode = {
    id: 10,
    subject: subject.key,
    name: "第一话",
    nameCn: "",
    airdate: "2024-01-01",
    disc: 1,
    duration: "24m",
    sort: 1,
    type: 0,
    hasDescription: false,
  };
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async (entityKey) => entityKey === subject.key ? subject : null,
    mappings: async () => mappings,
    episode: async (id) => id === episode.id ? episode : null,
    episodesFor: async (subjectKey) => ({
      items: subjectKey === subject.key ? [episode] : [],
      total: subjectKey === subject.key ? 1 : 0,
      next: null,
    }),
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const source = new SiteQueryDataSource(reader);
  const episodeEntity = await source.entity("episode:10");
  const subjectEntity = await source.entity("subject:3");
  assert.ok(episodeEntity);
  assert.ok(subjectEntity);

  const forward = [];
  for await (const value of source.followRef!(
    episodeEntity,
    "episode",
    "subjectRef",
    "forward",
  )) forward.push(value);
  const reverse = [];
  for await (const value of source.followRef!(
    subjectEntity,
    "episode",
    "subjectRef",
    "reverse",
  )) reverse.push(value.ref);

  assert.deepEqual(forward.map((value) => value.ref), ["subject:3"]);
  assert.equal(forward[0]?.fields.platform, "TV");
  assert.deepEqual(reverse, ["episode:10"]);
});

test("treats an Episode whose archived Subject is absent as an unresolved reference", async () => {
  const episode = {
    id: 11,
    subject: key(1, 404),
    name: "孤立分集",
    nameCn: "",
    airdate: "",
    disc: 0,
    duration: "",
    sort: null,
    type: 0,
    hasDescription: false,
  };
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    episode: async (id) => id === episode.id ? episode : null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const source = new SiteQueryDataSource(reader);
  const anchor = await source.entity("episode:11");
  assert.ok(anchor);

  const results = [];
  for await (const value of source.followRef!(
    anchor,
    "episode",
    "subjectRef",
    "forward",
  )) results.push(value);

  assert.deepEqual(results, []);
});

test("resolves a verified fact-summary hit through the FactRef index", async () => {
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    fact: async (ref) => ref === voice.ref ? voice : null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const search: SiteQuerySearch = {
    lookup: async function* () {},
    fullText: async function* () {},
    factFullText: async function* () {
      yield {
        ref: "fact:7",
        field: "summary",
        text: "星空下的配音记录",
        utf8Range: [0, 6],
      };
    },
  };
  const source = new SiteQueryDataSource(reader, search);

  const results = [];
  for await (const fact of source.fullTextFact!(
    "星空",
    "VOICE_CREDIT",
    "summary",
  )) results.push(fact);

  assert.equal(results[0]?.ref, "fact:7");
  assert.equal(results[0]?.fields.summary, undefined);
  assert.equal(results[0]?.searchMatch?.text, "星空下的配音记录");
  assert.deepEqual(results[0]?.searchMatch?.utf8Range, [0, 6]);
});

test("returns a bounded full-text snippet instead of the complete sidecar", async () => {
  const longText = `${"前".repeat(200)}星空${"后".repeat(200)}`;
  const start = new TextEncoder().encode("前".repeat(200)).byteLength;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => subject,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const search: SiteQuerySearch = {
    lookup: async function* () {},
    fullText: async function* () {
      yield {
        entity: subject,
        field: "summary",
        text: longText,
        utf8Range: [start, start + 6],
      };
    },
    factFullText: async function* () {},
  };
  const source = new SiteQueryDataSource(reader, search);
  const results = [];
  for await (const entity of source.fullText!("星空", "subject", "summary"))
    results.push(entity);

  assert.equal(results[0]?.fields.summary, undefined);
  assert.match(results[0]?.searchMatch?.text ?? "", /^….*星空.*…$/s);
  assert.ok((results[0]?.searchMatch?.text.length ?? 0) < longText.length / 2);
});
