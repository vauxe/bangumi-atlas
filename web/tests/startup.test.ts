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
  assert.match(
    main,
    /const queryPanel = \$\("#query-workbench"\);\s*queryLoader\.replaceWith\(queryPanel\)/,
  );
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
    /<aside id="pinned-manager"[^>]*aria-label="固定节点"[^>]*hidden/s,
  );
  assert.match(main, /new PinnedManager\(/);
  assert.match(
    main,
    /const displayName = \(rank: number\)[\s\S]*?decodeDisplayText\(name\)/,
  );
  assert.match(main, /nameOf:\s*displayName/);
  assert.match(main, /focus:\s*\(rank\)\s*=>[\s\S]*?select\(rank, "center"\)/);
  assert.match(main, /subscribe\([\s\S]*?pinnedManager\.sync\(\)/);
  assert.match(main, /drawer\.syncState\(\)/);
});

test("keeps a fatal scene failure in the unoccupied map area", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const page = readFileSync("../site/index.html", "utf8");
  const layoutOwner = page.match(/(?:^|\n)body\s*\{(?<body>[^}]*)\}/s)
    ?.groups?.body ?? "";
  const queryDock = page.match(/#query-dock\s*\{(?<body>[^}]*)\}/s)
    ?.groups?.body ?? "";
  const errorHud = page.match(
    /#hud\[data-state="error"\]\s*\{(?<body>[^}]*)\}/s,
  )?.groups?.body ?? "";
  const drawerErrorHud = page.match(
    /body:has\(#drawer\.open\)\s+#hud\[data-state="error"\]\s*\{(?<body>[^}]*)\}/s,
  )?.groups?.body ?? "";
  const coveredErrorHud = page.match(
    /body:has\(#drawer\.open\):has\(\.query-workspace:not\(\[hidden\]\)\)\s+#hud\[data-state="error"\]\s*\{(?<body>[^}]*)\}/s,
  )?.groups?.body ?? "";

  assert.match(main, /let sceneFailureMessage: string \| null = null/);
  assert.match(
    main,
    /onError: \(error\) => \{[\s\S]*?sceneFailureMessage = [\s\S]*?hud\.dataset\.state = "error";[\s\S]*?hud\.textContent = sceneFailureMessage;/,
  );
  assert.match(
    main,
    /const updateGeometryHud = \(message: string\): void => \{[\s\S]*?if \(sceneFailureMessage === null\) hud\.textContent = message;/,
  );
  assert.match(main, /gstream\.start\(\(loaded\) => \{[\s\S]*?updateGeometryHud\(/);
  assert.match(main, /geoDone\.then\(\(\) => \{[\s\S]*?updateGeometryHud\(""\)/);
  assert.match(layoutOwner, /--query-shell-width:\s*min\(/);
  assert.match(
    layoutOwner,
    /--query-occupied-bottom:\s*calc\(var\(--page-inset\)\s*\+\s*48px\)/,
  );
  assert.match(queryDock, /width:\s*var\(--query-shell-width\)/);
  assert.match(
    errorHud,
    /top:\s*calc\(var\(--query-occupied-bottom\)\s*\+\s*10px\)/,
  );
  assert.match(errorHud, /bottom:\s*auto/);
  assert.match(errorHud, /right:\s*calc\(var\(--occupied-right\)/);
  assert.match(errorHud, /max-width:[^;]*var\(--query-shell-width\)/s);
  assert.match(errorHud, /overflow-wrap:\s*anywhere/);
  assert.match(
    drawerErrorHud,
    /max-width:[^;]*100dvw\s*-\s*var\(--occupied-right\)[^;]*var\(--page-inset\)[^;]*var\(--page-inset\)/s,
  );
  assert.match(coveredErrorHud, /opacity:\s*0/);
  assert.match(
    main,
    /const observeQueryOccupancy = \(panel: HTMLElement\): void => \{[\s\S]*?querySelector<HTMLElement>\("\.query-compose"\)[\s\S]*?getBoundingClientRect\(\)\.bottom[\s\S]*?--query-occupied-bottom[\s\S]*?new ResizeObserver\(sync\)[\s\S]*?observe\(compose\)/,
  );
  assert.match(
    main,
    /queryLoader\.replaceWith\(queryPanel\);[\s\S]*?observeQueryOccupancy\(queryPanel\)/,
  );
});

test("starts node details before waiting for the complete relation fan", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const selectStart = main.indexOf("async function select(");
  const selectEnd = main.indexOf("\n  function deselect", selectStart);
  const select = main.slice(selectStart, selectEnd);
  const detailReads = select.indexOf("allRelationFacts(data, key");
  const show = select.indexOf("drawer.show(");
  const awaitRelations = select.indexOf(
    "const resolvedRelationData = await relationData",
  );
  const publishRelations = select.indexOf("state.neighbors = nb.ranks");

  assert.ok(selectStart >= 0 && selectEnd > selectStart);
  assert.ok(detailReads >= 0, "selection should load every relation page");
  assert.ok(show > detailReads, "details should share the relation task");
  assert.ok(
    show < awaitRelations,
    "node details must start before the complete relation fan resolves",
  );
  assert.ok(publishRelations > awaitRelations);
  assert.match(select, /drawer\.show\([\s\S]*?relationRanksPromise/);
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
  const showDrawer = main.indexOf(
    "drawer.show(",
    completeFacts,
  );

  assert.ok(completeFacts >= 0, "selection must request every fact page");
  assert.ok(
    sparseRankLookup > completeFacts && sparseRankLookup < buildWorkingSet,
    "all neighbor keys must resolve before the working set is built",
  );
  assert.ok(buildWorkingSet > completeFacts);
  assert.ok(
    showDrawer > completeFacts && showDrawer < buildWorkingSet,
    "drawer should receive the pending complete rank resolution immediately",
  );
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
