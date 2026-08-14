import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("keeps the query workspace out of the initial ESM entry", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const build = readFileSync("build.mjs", "utf8");
  const page = readFileSync("../site/index.html", "utf8");

  assert.doesNotMatch(main, /import \{ QueryWorkbench \} from/);
  assert.match(
    main,
    /prepare:\s*async\s*\(\)\s*=>[\s\S]*?Promise\.all\(\[[\s\S]*?import\("\.\/query\/runtime"\)[\s\S]*?prepareQueryStyles\(\)/,
  );
  assert.match(build, /splitting:\s*true/);
  assert.match(build, /format:\s*"esm"/);
  assert.match(page, /rel="modulepreload" href="app\.js"/);
  assert.match(page, /<script type="module" src="app\.js"><\/script>/);
});

test("keeps query URL codecs and Data construction out of the initial entry", () => {
  const main = readFileSync("src/main.ts", "utf8");

  assert.doesNotMatch(main, /import\s+\{\s*Data\s*\}\s+from\s+"\.\/data"/);
  assert.match(main, /import\s+type\s+\{\s*Data\s*\}\s+from\s+"\.\/data"/);
  assert.match(main, /import\("\.\/data"\)/);
  assert.doesNotMatch(main, /from\s+"\.\/url"/);
  assert.doesNotMatch(main, /query\/bundle-url/);
  assert.match(main, /from\s+"\.\/view-url"/);
});

test("renders a non-blocking query launcher before the runtime is installed", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const page = readFileSync("../site/index.html", "utf8");

  assert.match(
    page,
    /<a id="query-loader" href="#query-dock"[^>]*aria-label="打开搜索与查询"/s,
  );
  assert.doesNotMatch(page, /<link[^>]+href="query\.css"/);
  assert.match(main, /link\.href = "query\.css"/);
  assert.match(main, /queryLoader\.addEventListener\("click", activateQueryRuntime\)/);
  assert.match(main, /queryLoader\.replaceWith\(\$\("#query-workbench"\)\)/);
  assert.match(main, /appliedHash === "#query-dock"/);
  assert.match(main, /queryRuntime\.activate\(\{ focus: true \}\)/);
  assert.match(
    main,
    /if \(st\.query !== null \|\| appliedHash === "#query-dock"\)/,
  );
  assert.match(main, /queryUrlPayload = runtime\.restoreQuery\(st\.query\)/);
});

test("keeps the detail drawer out of the initial ESM entry", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const page = readFileSync("../site/index.html", "utf8");

  assert.doesNotMatch(main, /import \{ Drawer \} from/);
  assert.match(main, /createLazyDrawerRuntime\(async \(\) =>/);
  assert.match(main, /import\("\.\/drawer"\)/);
  assert.match(
    page,
    /<aside id="drawer"[^>]*aria-hidden="true"[^>]*inert/s,
  );
});

test("installs one visible manager for cumulative retained-node expansion", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const page = readFileSync("../site/index.html", "utf8");

  assert.match(
    page,
    /<aside id="pinned-manager"[^>]*aria-label="保留节点及其关系"[^>]*hidden/s,
  );
  assert.match(main, /new PinnedManager\(/);
  assert.match(main, /nameOf:\s*\(rank\)\s*=>\s*names\.get\(rank\)/);
  assert.match(main, /focus:\s*\(rank\)\s*=>[\s\S]*?select\(rank, "center"\)/);
  assert.match(main, /subscribe\([\s\S]*?pinnedManager\.sync\(\)/);
  assert.match(main, /drawer\.syncState\(\)/);
});

test("starts drawer preparation before waiting for complete relation data", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const selectStart = main.indexOf("async function select(");
  const selectEnd = main.indexOf("\n  function deselect", selectStart);
  const select = main.slice(selectStart, selectEnd);
  const prepare = select.indexOf("drawer.prepare()");
  const detailReads = select.indexOf("allRelationFacts(data, key");
  const publishRelations = select.indexOf("state.neighbors = nb.ranks");
  const show = select.indexOf("drawer.show(");

  assert.ok(selectStart >= 0 && selectEnd > selectStart);
  assert.ok(prepare >= 0, "selection should eagerly prepare the drawer chunk");
  assert.ok(prepare < detailReads, "drawer preparation should overlap relation reads");
  assert.ok(
    show > publishRelations,
    "drawer content should wait for the complete relation state",
  );
});

test("does not speculatively download the complete reverse index", () => {
  const main = readFileSync("src/main.ts", "utf8");
  assert.doesNotMatch(main, /runTask\(ensureRankIndex\(\), "反向索引加载"\)/);
});

test("builds the selected-node working set from every fact page", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const completeFacts = main.indexOf("allRelationFacts(data, key");
  const sparseRankLookup = main.indexOf("loadRanksByKey(", completeFacts);
  const buildWorkingSet = main.indexOf("relationNeighbors(", completeFacts);

  assert.ok(completeFacts >= 0, "selection must request every fact page");
  assert.ok(
    sparseRankLookup > completeFacts && sparseRankLookup < buildWorkingSet,
    "all neighbor keys must resolve before the working set is built",
  );
  assert.ok(buildWorkingSet > completeFacts);
  assert.doesNotMatch(
    main.slice(buildWorkingSet, buildWorkingSet + 500),
    /,\s*50\s*,?\s*\)/,
  );
});

test("clears the previous relation fan before selection camera rendering", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const selectStart = main.indexOf("async function select(");
  const selectEnd = main.indexOf("\n  function deselect", selectStart);
  const select = main.slice(selectStart, selectEnd);
  const begin = select.indexOf("beginSelection(rank, keyHint)");
  const fly = select.indexOf('if (cam === "fly") scene.flyTo(rank)');

  assert.ok(begin >= 0, "selection must clear its transient fan atomically");
  assert.ok(fly > begin, "camera rendering must observe the cleared relation fan");
});
