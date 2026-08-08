import assert from "node:assert/strict";
import { test } from "node:test";

import type { Manifest } from "../src/types";
import type { TextSearchMember } from "../src/loader";
import { SiteQuerySearchIndex } from "../src/query/site-search";
import type { SiteQueryReader } from "../src/query/site-source";

const key = (kind: number, id: number): number => (kind << 24) | id;
const subject = {
  kind: "subject" as const,
  key: key(1, 3),
  name: "星空",
  nameCn: "",
  type: 2,
  platformCode: null,
  date: "",
  score: null,
  bgmRank: null,
  nsfw: false,
  favorite: [0, 0, 0, 0, 0] as [number, number, number, number, number],
  series: false,
  scoreDetails: [],
  metaTags: [],
  tags: [],
  hasSummary: false,
  hasInfobox: false,
};

test("enforces the published normalized search length", async () => {
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星",
    page: async () => assert.fail("short lookup must not read candidates"),
    keys: async () => new Uint32Array(),
  });

  await assert.rejects(async () => {
    for await (const _hit of search.lookup("星", "subject", ["name"])) {
      assert.fail("short lookup cannot return a result");
    }
  }, /at least 2 normalized characters/);
});

test("verifies indexed aliases and resolves visual ranks to stable entities", async () => {
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async (entityKey) => entityKey === subject.key ? subject : null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const keys = new Uint32Array(5);
  keys[4] = subject.key;
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({
      entries: [["星空", "星空", 4, "星空", 1]],
      next: null,
      scannedThroughRank: 4,
    }),
    keys: async () => keys,
  });

  const results = [];
  for await (const entity of search.lookup("星空", "subject", ["name"]))
    results.push(entity);

  assert.deepEqual(results, [{
    entity: subject,
    field: "name",
    text: "星空",
    utf8Range: [0, 6],
  }]);
});

test("uses hashed text members only as candidates and verifies authoritative text", async () => {
  const descriptor: TextSearchMember = ["entity-summary", 1, 0, 10, 20];
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async (entityKey) => entityKey === subject.key ? subject : null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => [
      { owner: "subject", id: 3, field: "summary", text: "穿过星空的旅程" },
      { owner: "subject", id: 4, field: "summary", text: "散列碰撞但没有命中" },
    ],
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({
      members: [descriptor],
      next: null,
      totalCandidates: 1,
    }),
  });

  const results = [];
  for await (const hit of search.fullText("星空", "subject", "summary"))
    results.push(hit);
  assert.deepEqual(results, [{
    entity: subject,
    field: "summary",
    text: "穿过星空的旅程",
    utf8Range: [6, 12],
  }]);
});

test("does not truncate decoded text candidates", async () => {
  const descriptor: TextSearchMember = ["entity-summary", 1, 0, 10, 20];
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => [
      { owner: "subject", id: 1, field: "summary", text: "无关文本一" },
      { owner: "subject", id: 2, field: "summary", text: "无关文本二" },
      { owner: "subject", id: 3, field: "summary", text: "无关文本三" },
    ],
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({
      members: [descriptor],
      next: null,
      totalCandidates: 1,
    }),
  });

  const hits = [];
  for await (const hit of search.fullText("星空", "subject", "summary")) hits.push(hit);
  assert.deepEqual(hits, []);
});

test("filters text candidates by owner before reading source members", async () => {
  const descriptors: TextSearchMember[] = [
    ["entity-summary", 1, 0, 10, 20],
    ["entity-summary", 2, 0, 30, 20],
    ["episode-description", 0, 0, 50, 20],
  ];
  const reads: TextSearchMember[] = [];
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async (entityKey) => entityKey === subject.key ? subject : null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async (descriptor) => {
      reads.push(descriptor);
      return [{ owner: "subject", id: 3, field: "summary", text: "穿过星空的旅程" }];
    },
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({
      members: descriptors,
      next: null,
      totalCandidates: 3,
    }),
  });

  const results = [];
  for await (const hit of search.fullText("星空", "subject", "summary"))
    results.push(hit);

  assert.deepEqual(reads, [descriptors[0]]);
  assert.equal(results.length, 1);
});

test("loads authoritative text members with bounded concurrency", async () => {
  const descriptors: TextSearchMember[] = Array.from(
    { length: 7 },
    (_, index) => ["entity-summary", 1, 0, index * 10, 10],
  );
  let active = 0;
  let maximum = 0;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return [];
    },
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({
      members: descriptors,
      next: null,
      totalCandidates: descriptors.length,
    }),
  });

  for await (const _hit of search.fullText("星空", "subject", "summary")) {
    assert.fail("empty source members cannot produce a hit");
  }

  assert.ok(maximum > 1);
  assert.ok(maximum <= 6);
});

test("reports converted spellings as derived name variants and respects lookup field scope", async () => {
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async (entityKey) => entityKey === subject.key ? subject : null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const keys = new Uint32Array([subject.key]);
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({
      entries: [["星空", "星空異體", 0, "星空", 1]],
      next: null,
      scannedThroughRank: 0,
    }),
    keys: async () => keys,
  });

  const results = [];
  for await (const hit of search.lookup("星空", "subject", ["nameVariant"]))
    results.push(hit);
  assert.deepEqual(results, [{
    entity: subject,
    field: "nameVariant",
    text: "星空異體",
    utf8Range: [0, 6],
  }]);
});

test("returns verified fact-summary candidates without pretending they are entities", async () => {
  const descriptor: TextSearchMember = ["fact-summary", 0, 0, 10, 20];
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => [
      { owner: "fact", id: 9, field: "summary", text: "守护星空的声音" },
    ],
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({
      members: [descriptor],
      next: null,
      totalCandidates: 1,
    }),
  });

  const results = [];
  for await (const hit of search.factFullText(
    "星空",
    "VOICE_CREDIT",
    "summary",
  )) results.push(hit);

  assert.deepEqual(results, [{
    ref: "fact:9",
    field: "summary",
    text: "守护星空的声音",
    utf8Range: [6, 12],
  }]);
});

test("looks up Episode names through published identity members without a global scan", async () => {
  const descriptor = ["episode-identity", 0, 0, 10, 20] as unknown as TextSearchMember;
  const episode = {
    id: 20,
    subject: key(1, 3),
    name: "星空之旅",
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
    episodes: async function* () {
      throw new Error("Episode global scan must not run for lookup");
    },
    episode: async (id) => id === episode.id ? episode : null,
    entity: async () => null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => [{
      owner: "episode",
      id: 20,
      field: "name",
      text: "星空之旅",
    }] as never,
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({
      members: [descriptor],
      next: null,
      totalCandidates: 1,
    }),
  });

  const results = [];
  for await (const hit of search.lookup("星空", "episode", ["name"]))
    results.push(hit);

  assert.deepEqual(results, [{
    entity: episode,
    field: "name",
    text: "星空之旅",
    utf8Range: [0, 6],
  }]);
});
