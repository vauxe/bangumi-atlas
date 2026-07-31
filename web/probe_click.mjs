// 交互冒烟:随机传送 → 选中 + 飞行 + 抽屉;抓错误与终态截图。
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
await page.click("#dice-cold");
await new Promise((r) => setTimeout(r, 3500)); // flyTo + 抽屉加载
const state = await page.evaluate(() => ({
  drawerOpen: document.querySelector("#drawer")?.classList.contains("open"),
  drawerTitle: document.querySelector("#drawer h2")?.textContent?.trim(),
  groups: document.querySelectorAll("#drawer .group").length,
  chips: document.querySelectorAll("#drawer .chip").length,
  url: location.hash.slice(0, 80),
  docked: document.body.classList.contains("docked"),
}));
console.log("STATE:", JSON.stringify(state, null, 1));
console.log("ERRORS:", errs.length ? errs.slice(0, 10) : "none");
if (shot) await page.screenshot({ path: shot });
await browser.close();
