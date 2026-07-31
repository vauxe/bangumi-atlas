// 冒烟:骰子入搜索栏 / 工具栏移除 / C 键着色切换 / 左侧筛选列。
import puppeteer from "puppeteer-core";

const [url, shot] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--no-first-run", "--window-size=1280,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errs = [];
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text().slice(0, 400));
});
page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 9000)); // 等几何流就绪

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
await new Promise((r) => setTimeout(r, 200));
await page.click('#media-chips [data-media]');
await new Promise((r) => setTimeout(r, 600));
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
await new Promise((r) => setTimeout(r, 300));

// 3) 骰子 → 选中 + 抽屉
await page.click("#dice");
await new Promise((r) => setTimeout(r, 3500));
const dice = await page.evaluate(() => ({
  drawerOpen: document.querySelector("#drawer")?.classList.contains("open"),
  drawerTitle: document.querySelector("#drawer h2")?.textContent?.trim(),
  url: location.hash.slice(0, 80),
}));

console.log("LAYOUT:", JSON.stringify(layout));
console.log("PANELS:", JSON.stringify(panels));
console.log("DICE:", JSON.stringify(dice));
console.log("ERRORS:", errs.length ? errs.slice(0, 10) : "none");
if (shot) await page.screenshot({ path: shot });
await browser.close();
