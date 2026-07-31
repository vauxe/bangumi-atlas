// 冒烟:搜索栏内骰子、左侧筛选/结果布局及随机选点抽屉。
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { chromePath, pause, stubCoverImages } from "./probe_support.mjs";

const [url, shot] = process.argv.slice(2);
assert.ok(url, "usage: node probe_leftcol.mjs <url> [screenshot]");
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: "new",
  args: ["--no-first-run", "--window-size=1280,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const coverRequests = await stubCoverImages(page);
const errs = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warn")
    errs.push(`[${m.type()}] ${m.text().slice(0, 400)}`);
});
page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (request) =>
  errs.push(`[reqfail] ${request.url()} ${request.failure()?.errorText}`),
);

await page.goto(url, { waitUntil: "domcontentloaded" });
await pause(9000); // 等几何流就绪

// 1) 布局:骰子在搜索框内、旧工具栏/按钮不存在、左列几何
const layout = await page.evaluate(() => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) };
  };
  return {
    dice: r("#dice"),
    search: r("#search"),
    diceInSearchwrap: !!document.querySelector("#searchwrap #dice"),
    toolbar: !!document.querySelector("#toolbar"),
    layerToggle: !!document.querySelector("#layer-toggle"),
    topToggle: !!document.querySelector("#top-toggle"),
    leftcol: r("#leftcol"),
    filters: r("#filters"),
  };
});

// 2) 筛选展开 + 应用一个媒介过滤 → 结果面板出现在筛选下方
await page.click("#filters-head");
await pause(200);
await page.click('#media-chips [data-media]');
await pause(600);
const panels = await page.evaluate(() => {
  const fb = document.querySelector("#filters").getBoundingClientRect();
  const rs = document.querySelector("#results").getBoundingClientRect();
  return {
    filtersOpen: !document
      .querySelector("#filters")
      .classList.contains("closed"),
    resultsOpen: document
      .querySelector("#results")
      .classList.contains("open"),
    resultsBelowFilters: rs.top >= fb.bottom,
    resultsLeft: Math.round(rs.x),
    resultRows: document.querySelectorAll("#results .rrow").length,
  };
});
// 撤掉过滤,再点骰子
await page.click('#media-chips [data-media]');
await page.click("#filters-head");
await pause(300);

// 3) 骰子 → 选中 + 抽屉
await page.click("#dice");
await pause(3500);
const dice = await page.evaluate(() => ({
  drawerOpen: document.querySelector("#drawer")?.classList.contains("open"),
  drawerTitle: document.querySelector("#drawer h2")?.textContent?.trim(),
  coverLoaded:
    (document.querySelector("#drawer .cover")?.naturalWidth ?? 0) > 0,
  url: location.hash.slice(0, 80),
}));

console.log("LAYOUT:", JSON.stringify(layout));
console.log("PANELS:", JSON.stringify(panels));
console.log("DICE:", JSON.stringify(dice));
console.log("COVERS:", JSON.stringify(coverRequests));
console.log("ERRORS:", errs.length ? errs.slice(0, 10) : "none");
if (shot) await page.screenshot({ path: shot });
await browser.close();

assert.deepEqual(errs, [], `browser errors:\n${errs.join("\n")}`);
assert.deepEqual(coverRequests.errors, [], "cover request stub failed");
assert.equal(layout.diceInSearchwrap, true, "dice is outside search wrapper");
assert.equal(layout.toolbar, false, "legacy toolbar is still present");
assert.equal(layout.layerToggle, false, "legacy layer toggle is present");
assert.equal(layout.topToggle, false, "legacy top toggle is present");
assert.ok(layout.leftcol && layout.filters, "left-column panels are missing");
assert.equal(panels.filtersOpen, true, "filters did not open");
assert.equal(panels.resultsOpen, true, "filtered results did not open");
assert.equal(panels.resultsBelowFilters, true, "results overlap filters");
assert.ok(panels.resultRows > 0, "filter produced no result rows");
assert.equal(dice.drawerOpen, true, "dice did not open the drawer");
assert.ok(dice.drawerTitle, "drawer title is empty");
assert.equal(dice.coverLoaded, true, "drawer cover did not load");
assert.ok(coverRequests.grid > 0, "map covers were not requested");
assert.ok(coverRequests.small > 0, "drawer covers were not requested");
assert.equal(coverRequests.medium, 0, "oversized medium covers were requested");
assert.match(dice.url, /(?:^|&)n=\d+/, "URL lacks stable node identity");
