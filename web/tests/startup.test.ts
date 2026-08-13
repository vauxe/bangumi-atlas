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
    /if \(state\.queryBundle \|\| appliedHash === "#query-dock"\)\s*activateQueryRuntime\(\)/,
  );
});

test("waits for geometry completion before warming the reverse index", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const streamStart = main.indexOf("const geoDone = gstream.start");
  const completion = main.indexOf("geoDone.then");
  const warmup = main.indexOf("runTask(ensureRankIndex(), \"反向索引加载\")");

  assert.ok(streamStart >= 0);
  assert.ok(completion > streamStart);
  assert.ok(warmup > completion);
  assert.match(
    main.slice(completion, warmup),
    /geometryComplete = true/,
  );
});
