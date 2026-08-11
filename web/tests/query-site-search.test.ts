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

test("passes structural owner filtering to substring candidate loading", async () => {
  const personKey = key(2, 7);
  const person = {
    kind: "person" as const,
    key: personKey,
    name: "星空",
    type: 1,
    career: [],
    comments: 0,
    collects: 0,
    hasSummary: false,
    hasInfobox: false,
  };
  const keys = new Uint32Array([subject.key, personKey]);
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async (entityKey) => entityKey === personKey ? person : null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async (_query, _cursor, _signal, acceptRank) => {
      assert.equal(acceptRank?.(0), false);
      assert.equal(acceptRank?.(1), true);
      return {
        entries: [["星空", "星空", 1, "星空", 2]],
        next: null,
        scannedThroughRank: 1,
      };
    },
    keys: async () => keys,
  });

  const results = [];
  for await (const hit of search.lookup("星空", "person", ["name"]))
    results.push(hit.entity);
  assert.deepEqual(results, [person]);
});

test("reuses a verified structural candidate page for the same lookup", async () => {
  let pageReads = 0;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async (entityKey) => entityKey === subject.key ? subject : null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const keys = new Uint32Array(1);
  keys[0] = subject.key;
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => {
      pageReads++;
      return {
        entries: [["星空", "星空", 0, "星空", 1]],
        next: null,
        scannedThroughRank: 0,
      };
    },
    keys: async () => keys,
  });

  const execute = async (): Promise<unknown[]> => {
    const results = [];
    for await (const hit of search.lookup("星空", "subject", ["name"]))
      results.push(hit);
    return results;
  };
  const first = await execute();
  const second = await execute();

  assert.equal(pageReads, 1);
  assert.deepEqual(second, first);
});

test("shares verified broad candidate pages across structural owners", async () => {
  const subjectKey = key(1, 1);
  const personKey = key(2, 2);
  const keys = new Uint32Array([subjectKey, personKey]);
  const pageCalls: string[] = [];
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async (entityKey) => entityKey === subjectKey
      ? { ...subject, key: subjectKey }
      : entityKey === personKey
        ? {
            kind: "person",
            key: personKey,
            name: "星空人物",
            type: 1,
            career: [],
            comments: 0,
            collects: 0,
            hasSummary: false,
            hasInfobox: false,
          }
        : null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async (_query, cursor, _signal, acceptRank) => {
      pageCalls.push(`${cursor}:${acceptRank ? "scoped" : "shared"}`);
      if (cursor < 128) {
        return {
          entries: [],
          next: cursor + 64,
          scannedThroughRank: cursor,
        };
      }
      return {
        entries: [
          ["星空", "星空", 0, "星空", 1],
          ["星空人物", "星空人物", 1, "星空人物", 2],
        ],
        next: null,
        scannedThroughRank: 1,
      };
    },
    keys: async () => keys,
  });

  const owners: string[] = [];
  for await (const hit of search.lookup("星空", "subject", ["name"]))
    owners.push("kind" in hit.entity ? hit.entity.kind : "episode");
  for await (const hit of search.lookup("星空", "person", ["name"]))
    owners.push("kind" in hit.entity ? hit.entity.kind : "episode");

  assert.deepEqual(owners, ["subject", "person"]);
  assert.deepEqual(pageCalls, [
    "0:scoped",
    "64:scoped",
    "128:shared",
    "0:scoped",
    "64:scoped",
  ]);
});

test("loads lookup entities with bounded concurrency while preserving rank order", async () => {
  const count = 7;
  const keys = new Uint32Array(
    Array.from({ length: count }, (_, index) => key(1, index + 1)),
  );
  let active = 0;
  let maximum = 0;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async (entityKey) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return {
        ...subject,
        key: entityKey,
        name: `星空${entityKey & 0xffffff}`,
      };
    },
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({
      entries: [
        ...Array.from(
          { length: count },
          (_, index) => [
            "星空",
            `星空${index + 1}`,
            index,
            `星空${index + 1}`,
            1,
          ] as [string, string, number, string, 1],
        ),
        ["星空", "星空1", 0, "星空1", 1] as [string, string, number, string, 1],
      ],
      next: null,
      scannedThroughRank: count - 1,
    }),
    keys: async () => keys,
  });

  const results = [];
  for await (const hit of search.lookup("星空", "subject", ["name"]))
    results.push(hit);

  assert.ok(maximum > 1);
  assert.ok(maximum <= 6);
  assert.deepEqual(
    results.map(({ entity }) => "key" in entity ? entity.key : null),
    [...keys],
  );
});

test("prefetches an owner range once broad lookup exceeds its entity blocks", async () => {
  const count = 3;
  const keys = new Uint32Array(
    Array.from({ length: count }, (_, index) => key(1, index + 1)),
  );
  const events: string[] = [];
  const reader: SiteQueryReader = {
    entities: async function* () {},
    prefetchEntities: async (owner) => { events.push(`prefetch:${owner}`); },
    entity: async (entityKey) => {
      events.push(`entity:${entityKey & 0xffffff}`);
      return {
        ...subject,
        key: entityKey,
        name: `星空${entityKey & 0xffffff}`,
      };
    },
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const manifest = {
    counts: { entities: { subject: 8, person: 0, character: 0 } },
    limits: { entity_block_ids: 4 },
  } as Manifest;
  const search = new SiteQuerySearchIndex(reader, manifest, {
    normalize: async () => "星空",
    page: async () => ({
      entries: Array.from(
        { length: count },
        (_, index) => [
          "星空",
          `星空${index + 1}`,
          index,
          `星空${index + 1}`,
          1,
        ] as [string, string, number, string, 1],
      ),
      next: null,
      scannedThroughRank: count - 1,
    }),
    keys: async () => keys,
  });

  const results = [];
  for await (const hit of search.lookup("星空", "subject", ["name"]))
    results.push(hit);

  assert.equal(results.length, count);
  assert.deepEqual(events, [
    "prefetch:subject",
    "entity:1",
    "entity:2",
    "entity:3",
  ]);
});

test("hydrates structural lookup hits through the projected point reader", async () => {
  const subjectKey = key(1, 3);
  let requested: readonly string[] = [];
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => {
      throw new Error("full entity hydration should not run");
    },
    projectEntity: async (entityKey, fields) => {
      assert.equal(entityKey, subjectKey);
      requested = fields;
      return {
        kind: "subject",
        key: subjectKey,
        fields: { name: "星空", nameCn: "星空", score: 8.5 },
      };
    },
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({
      entries: [["星空", "星空", 0, "星空", 1]],
      next: null,
      scannedThroughRank: 0,
    }),
    keys: async () => new Uint32Array([subjectKey]),
  });

  const hits = [];
  for await (const hit of search.lookup(
    "星空",
    "subject",
    ["name"],
    undefined,
    ["score"],
  )) hits.push(hit);

  assert.deepEqual(requested, ["score", "name", "nameCn"]);
  assert.equal(hits.length, 1);
  assert.equal("fields" in hits[0]!.entity, true);
});

test("verifies direct structural names before reading derived aliases", async () => {
  const subjectKey = key(1, 3);
  let aliasReads = 0;
  let entityReads = 0;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    projectEntity: async () => {
      entityReads++;
      throw new Error("identity-only lookup must not read entities.pack");
    },
    entity: async () => {
      throw new Error("full entity hydration should not run");
    },
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "少女",
    page: async () => {
      throw new Error("verified alias paging should not run");
    },
    rankPage: async () => ({ ranks: [0], next: null }),
    nameRows: async () => new Map([
      [0, ["Original", "星空少女", 1]],
    ]),
    aliasRows: async () => {
      aliasReads++;
      return new Map();
    },
    keys: async () => new Uint32Array([subjectKey]),
  });

  const hits = [];
  for await (const hit of search.lookup(
    "少女",
    "subject",
    ["name", "nameCn", "nameVariant"],
    undefined,
    ["ref", "name", "nameCn"],
  )) hits.push(hit);

  assert.equal(entityReads, 0);
  assert.equal(aliasReads, 0);
  assert.equal(hits[0]?.field, "nameCn");
  assert.equal(hits[0]?.text, "星空少女");
  assert.deepEqual(hits[0]?.utf8Range, [6, 12]);
});

test("falls back to authoritative aliases for a derived name variant", async () => {
  const personKey = key(2, 4);
  let aliasReads = 0;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    projectEntity: async () => ({
      kind: "person",
      key: personKey,
      fields: { name: "星海" },
    }),
    entity: async () => null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "少女",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    rankPage: async () => ({ ranks: [0], next: null }),
    aliasRows: async () => {
      aliasReads++;
      return new Map([[0, [[["少女", "少女"]], "星海", 2]]]);
    },
    keys: async () => new Uint32Array([personKey]),
  });

  const hits = [];
  for await (const hit of search.lookup(
    "少女",
    "person",
    ["name", "nameVariant"],
  )) hits.push(hit);

  assert.equal(aliasReads, 1);
  assert.equal(hits[0]?.field, "nameVariant");
  assert.equal(hits[0]?.text, "少女");
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

test("resolves full-text entities with bounded concurrency and stable hit order", async () => {
  const descriptor: TextSearchMember = ["episode-description", 0, 0, 10, 20];
  let active = 0;
  let maximum = 0;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    episode: async (id) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return {
        id,
        subject: key(1, id),
        name: `Episode ${id}`,
        nameCn: "",
        airdate: "",
        disc: 0,
        duration: "",
        sort: id,
        type: 0,
        hasDescription: true,
      };
    },
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => Array.from({ length: 7 }, (_, index) => ({
      owner: "episode" as const,
      id: index + 1,
      field: "description" as const,
      text: `星空 ${index + 1}`,
    })),
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({
      members: [descriptor],
      next: null,
      totalCandidates: 7,
    }),
  });

  const ids: number[] = [];
  for await (const hit of search.fullText("星空", "episode", "description"))
    ids.push("id" in hit.entity ? hit.entity.id : -1);

  assert.ok(maximum > 1);
  assert.ok(maximum <= 6);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7]);
});

test("reuses verified full-text member matches across identical queries", async () => {
  const descriptor: TextSearchMember = ["episode-description", 0, 0, 10, 20];
  let textReads = 0;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    episode: async (id) => ({
      id,
      subject: key(1, 3),
      name: `Episode ${id}`,
      nameCn: "",
      airdate: "",
      disc: 0,
      duration: "",
      sort: id,
      type: 0,
      hasDescription: true,
    }),
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => {
      textReads++;
      return [{
        owner: "episode",
        id: 9,
        field: "description",
        text: "穿过星空的旅程",
      }];
    },
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({ members: [descriptor], next: null, totalCandidates: 1 }),
  });

  const execute = async (): Promise<number> => {
    let hits = 0;
    for await (const _hit of search.fullText(
      "星空",
      "episode",
      "description",
    )) hits++;
    return hits;
  };

  assert.equal(await execute(), 1);
  assert.equal(await execute(), 1);
  assert.equal(textReads, 1);
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

test("reuses the authoritative Episode decoded with an identity member", async () => {
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
  let episodeReads = 0;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    episode: async () => {
      episodeReads++;
      throw new Error("identity rows already contain the authoritative Episode");
    },
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => [{
      owner: "episode",
      id: episode.id,
      field: "name",
      text: episode.name,
      entity: episode,
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

  assert.equal(episodeReads, 0);
  assert.deepEqual(results, [{
    entity: episode,
    field: "name",
    text: episode.name,
    utf8Range: [0, 6],
  }]);
});

test("reuses verified Episode identity matches across identical queries", async () => {
  const descriptor = ["episode-identity", 0, 0, 10, 20] as unknown as TextSearchMember;
  const episode = {
    id: 20,
    subject: key(1, 3),
    name: "星空之旅",
    nameCn: "星空旅程",
    airdate: "2024-01-01",
    disc: 1,
    duration: "24m",
    sort: 1,
    type: 0,
    hasDescription: false,
  };
  let textReads = 0;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => {
      textReads++;
      return [{
        owner: "episode",
        id: episode.id,
        field: "name",
        text: episode.name,
        entity: episode,
      }] as never;
    },
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({ members: [descriptor], next: null, totalCandidates: 1 }),
  });

  const execute = async (): Promise<string[]> => {
    const refs: string[] = [];
    for await (const hit of search.lookup("星空", "episode", ["name"])) {
      assert.ok("id" in hit.entity);
      refs.push(`episode:${hit.entity.id}`);
    }
    return refs;
  };

  assert.deepEqual(await execute(), ["episode:20"]);
  assert.deepEqual(await execute(), ["episode:20"]);
  assert.equal(textReads, 1);
});

test("resolves Episode identity hits with bounded concurrency and stable order", async () => {
  const descriptor = ["episode-identity", 0, 0, 10, 20] as unknown as TextSearchMember;
  let active = 0;
  let maximum = 0;
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    episode: async (id) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return {
        id,
        subject: key(1, id),
        name: `星空 ${id}`,
        nameCn: "",
        airdate: "",
        disc: 0,
        duration: "",
        sort: id,
        type: 0,
        hasDescription: false,
      };
    },
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => Array.from({ length: 7 }, (_, index) => ({
      owner: "episode" as const,
      id: index + 1,
      field: "name" as const,
      text: `星空 ${index + 1}`,
    })),
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({
      members: [descriptor],
      next: null,
      totalCandidates: 7,
    }),
  });

  const ids: number[] = [];
  for await (const hit of search.lookup("星空", "episode", ["name"]))
    ids.push("id" in hit.entity ? hit.entity.id : -1);

  assert.ok(maximum > 1);
  assert.ok(maximum <= 6);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7]);
});

test("propagates cancellation through an Episode identity batch", async () => {
  const descriptor = ["episode-identity", 0, 0, 10, 20] as unknown as TextSearchMember;
  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const reader: SiteQueryReader = {
    entities: async function* () {},
    entity: async () => null,
    episode: async (_id, signal) => {
      markStarted?.();
      return await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    factsFor: async () => ({ items: [], total: 0, next: null }),
    textSearchRows: async () => [{
      owner: "episode",
      id: 1,
      field: "name",
      text: "星空 1",
    }],
  };
  const search = new SiteQuerySearchIndex(reader, {} as Manifest, {
    normalize: async () => "星空",
    page: async () => ({ entries: [], next: null, scannedThroughRank: -1 }),
    keys: async () => new Uint32Array(),
    textPage: async () => ({ members: [descriptor], next: null, totalCandidates: 1 }),
  });
  const iterator = search.lookup(
    "星空",
    "episode",
    ["name"],
    controller.signal,
  )[Symbol.asyncIterator]();
  const pending = iterator.next();
  await started;
  controller.abort(new Error("cancelled Episode lookup"));

  await assert.rejects(pending, /cancelled Episode lookup/);
});
