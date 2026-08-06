/** 真实数据端到端冒烟:对本地 Range 服务器上的完整 SiteRelease
 * 走一遍 Data 契约(weekly 发布门禁;本地用法见 npm run smoke)。 */

import assert from "node:assert/strict";

import { Data } from "../src/data";
import {
  ensureRankIndex,
  fold,
  loadCharmap,
  loadManifest,
  openNames,
  openSearchAliases,
} from "../src/loader";
import { findSubstringEntries } from "../src/search";

const BASE = process.env["SMOKE_BASE"] ?? "http://127.0.0.1:8391";
const realFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  requests++;
  return realFetch(new URL(String(input), `${BASE}/`), init);
}) as typeof fetch;

const manifest = await loadManifest();
console.log(
  `manifest ok: ${manifest.profile}, ${manifest.n_nodes.toLocaleString()} nodes,`,
  `${(manifest.total_bytes / 1e6).toFixed(0)}MB data`,
);
const names = openNames(manifest);
const searchAliases = openSearchAliases(manifest);
const data = new Data(manifest, names);
await ensureRankIndex();

await loadCharmap();
const substringQuery = fold("之境");
const substringPage = await findSubstringEntries(substringQuery, searchAliases);
const substringHits = substringPage.entries;
assert.ok(substringHits.length > 0);
assert.ok(
  substringHits.every(([normalized]) => normalized.includes(substringQuery)),
);
console.log(
  `substring search ok: ${substringHits[0]?.[1]} (${substringHits.length} hits)`,
);

const commonQuery = fold("动画");
const firstCommonPage = await findSubstringEntries(commonQuery, searchAliases);
assert.ok(firstCommonPage.entries.length > 0);
assert.notEqual(firstCommonPage.next, null);
const secondCommonPage = await findSubstringEntries(commonQuery, searchAliases, {
  cursor: firstCommonPage.next ?? 0,
});
assert.ok(secondCommonPage.entries.length > 0);
assert.ok(
  secondCommonPage.entries.every(([normalized]) =>
    normalized.includes(commonQuery),
  ),
);
assert.equal(
  new Set(
    [...firstCommonPage.entries, ...secondCommonPage.entries].map(
      (entry) => entry[2],
    ),
  ).size,
  firstCommonPage.entries.length + secondCommonPage.entries.length,
);
console.log(
  `substring pagination ok: ${firstCommonPage.entries.length} + ` +
    `${secondCommonPage.entries.length} hits`,
);

const beforeCollision = requests;
const collisionPage = await findSubstringEntries(fold("ererer"), searchAliases);
const collisionRequests = requests - beforeCollision;
assert.deepEqual(collisionPage.entries, []);
assert.notEqual(collisionPage.next, null);
assert.ok(
  collisionRequests <= 65,
  `one collision page used ${collisionRequests} requests`,
);
console.log(`collision scan bounded: ${collisionRequests} requests`);

// 取一个高热度作品(rank 0 未必是 subject,扫描前几名)
const keyObject = manifest.files["key.bin"]?.[2];
assert.ok(keyObject, "manifest contains the key.bin physical object");
const keyResponse = await realFetch(`${BASE}/data/${keyObject}`);
assert.equal(keyResponse.status, 200);
const keyBytes = await keyResponse.arrayBuffer();
const keys = new Uint32Array(keyBytes);
const subjectKey = [...keys.slice(0, 50)].find((k) => k >>> 24 === 1);
assert.ok(subjectKey);

const rank = data.rankOf(subjectKey);
assert.ok(rank !== null && rank < 50, "rankOf 与 key.bin 一致");

const entity = await data.entity(subjectKey);
assert.ok(entity && entity.kind === "subject");
console.log(
  `entity ok: ${entity.nameCn || entity.name} (score ${entity.score},`,
  `${entity.tags.length} tags, summary=${entity.hasSummary},`,
  `infobox=${entity.hasInfobox})`,
);
assert.ok(entity.name.length > 0);
assert.ok(entity.metaTags.every((t) => typeof t === "string" && t !== ""));

const facts = await data.factsFor(subjectKey);
assert.ok(facts.total > 0 && facts.items.length > 0);
console.log(
  `facts ok: inline ${facts.items.length} / total ${facts.total},`,
  `next=${facts.next}`,
);
if (facts.next) {
  const page2 = await data.factsFor(subjectKey, facts.next);
  assert.ok(page2.items.length > 0);
  console.log(`facts page-2 ok: ${page2.items.length} items`);
}

const episodes = await data.episodesFor(subjectKey);
console.log(`episodes ok: ${episodes.items.length} / ${episodes.total}`);
for (const ep of episodes.items.slice(0, 200)) {
  assert.equal(ep.subject, subjectKey);
}
const withDesc = episodes.items.find((e) => e.hasDescription);
if (withDesc) {
  const desc = await data.longText({
      kind: "episode-description",
      subject: subjectKey,
      episode: withDesc.id,
      present: withDesc.hasDescription,
  });
  assert.equal(desc.kind, "present");
  console.log(`episode description ok (${withDesc.id})`);
}

if (entity.hasSummary) {
  const summary = await data.longText({
      kind: "entity-summary",
      entity: subjectKey,
      present: entity.hasSummary,
  });
  assert.equal(summary.kind, "present");
  console.log(
    `summary ok: ${(summary as { text: string }).text.slice(0, 40)}…`,
  );
}
if (entity.hasInfobox) {
  const infobox = await data.longText({
      kind: "entity-infobox",
      entity: subjectKey,
      present: entity.hasInfobox,
  });
  assert.equal(infobox.kind, "present");
  assert.ok((infobox as { text: string }).text.includes("{{Infobox"));
  console.log("infobox ok (raw wiki source preserved)");
}

// 存在位为假的实体:empty 不触发文本请求以外的失败
const emptyOne = await (async () => {
  for (let r = 0; r < 2000; r++) {
    const k = keys[r] ?? 0;
    if (k >>> 24 !== 1) continue;
    const e = await data.entity(k);
    if (e && !e.hasSummary) return k;
  }
  return null;
})();
if (emptyOne) {
  const beforeEmpty = requests;
  const res = await data.longText({
    kind: "entity-summary",
    entity: emptyOne,
    present: false,
  });
  assert.equal(res.kind, "empty");
  assert.equal(requests, beforeEmpty);
  console.log("empty summary ok");
}

const mappings = await data.mappings();
assert.ok(Object.keys(mappings.fact_labels["RELATES_TO"] ?? {}).length > 0);
console.log("mappings ok");

// 成员缓存命中不得产生网络请求
const before = requests;
await data.entity(subjectKey);
await data.factsFor(subjectKey);
assert.equal(requests, before, "缓存命中零请求");
console.log(`cache ok (total ${requests} requests)`);
console.log("SMOKE PASS");
