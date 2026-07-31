// 交互冒烟:随机传送 → 选中 + 飞行 + 抽屉;抓错误与终态截图。
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { chromePath, pause, stubCoverImages } from "./probe_support.mjs";

const [url, shot] = process.argv.slice(2);
assert.ok(url, "usage: node probe_click.mjs <url> [screenshot]");
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
await page.click("#dice");
await pause(3500); // flyTo + 抽屉加载
const state = await page.evaluate(() => ({
  drawerOpen: document.querySelector("#drawer")?.classList.contains("open"),
  drawerTitle: document.querySelector("#drawer h2")?.textContent?.trim(),
  groups: document.querySelectorAll("#drawer .group").length,
  chips: document.querySelectorAll("#drawer .chip").length,
  coverLoaded:
    (document.querySelector("#drawer .cover")?.naturalWidth ?? 0) > 0,
  url: location.hash.slice(0, 80),
}));

// 连接模式必须进入 URL,刷新后仍恢复为同一种结果视图。
await page.click('[data-arm="common"]');
await page.click("#dice");
await pause(4000);
const linked = await page.evaluate(() => ({
  title: document.querySelector("#drawer h2")?.textContent?.trim(),
  avatarCount: document.querySelectorAll("#drawer .chip-av").length,
  url: location.hash,
}));
await page.reload({ waitUntil: "domcontentloaded" });
await pause(5000);
const restored = await page.evaluate(() => ({
  title: document.querySelector("#drawer h2")?.textContent?.trim(),
  url: location.hash,
}));
console.log("STATE:", JSON.stringify(state, null, 1));
console.log("LINKED:", JSON.stringify(linked, null, 1));
console.log("RESTORED:", JSON.stringify(restored, null, 1));
console.log("COVERS:", JSON.stringify(coverRequests, null, 1));
console.log("ERRORS:", errs.length ? errs.slice(0, 10) : "none");
if (shot) await page.screenshot({ path: shot });
await browser.close();

assert.deepEqual(errs, [], `browser errors:\n${errs.join("\n")}`);
assert.deepEqual(coverRequests.errors, [], "cover request stub failed");
assert.equal(state.drawerOpen, true, "dice did not open the drawer");
assert.ok(state.drawerTitle, "drawer title is empty");
assert.equal(state.coverLoaded, true, "drawer cover did not load");
assert.ok(linked.avatarCount > 0, "linked-node avatars were not rendered");
assert.ok(coverRequests.grid > 0, "relation-chip covers were not requested");
assert.ok(coverRequests.small > 0, "map or drawer covers were not requested");
assert.equal(coverRequests.medium, 0, "oversized medium covers were requested");
assert.match(state.url, /(?:^|&)n=\d+/, "URL lacks stable node identity");
assert.equal(linked.title, "⚭ 共同关联", "common-link view did not open");
assert.match(linked.url, /(?:^|&)q=common(?:&|$)/, "URL lacks link mode");
assert.match(linked.url, /(?:^|&)f=\d+(?:&|$)/, "URL lacks source key");
assert.match(linked.url, /(?:^|&)fr=\d+(?:&|$)/, "URL lacks source rank");
assert.equal(restored.title, linked.title, "reload did not restore link view");
assert.equal(restored.url, linked.url, "reload changed the shared URL state");
