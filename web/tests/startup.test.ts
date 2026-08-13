import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("keeps the query workspace out of the initial ESM entry", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const build = readFileSync("build.mjs", "utf8");
  const page = readFileSync("../site/index.html", "utf8");

  assert.doesNotMatch(main, /import \{ QueryWorkbench \} from/);
  assert.match(main, /await import\("\.\/query\/runtime"\)/);
  assert.match(build, /splitting:\s*true/);
  assert.match(build, /format:\s*"esm"/);
  assert.match(page, /rel="modulepreload" href="app\.js"/);
  assert.match(page, /<script type="module" src="app\.js"><\/script>/);
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
