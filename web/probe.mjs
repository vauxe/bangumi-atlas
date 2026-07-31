// 无头 Chrome 探针:加载星图,抓 console/pageerror,等待渲染后截图。
// 用法:node probe.mjs <url> <截图路径> [等待 ms]
import puppeteer from "puppeteer-core";

const [url, shot, waitMs = "12000"] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: [
    "--no-first-run",
    "--disable-extensions",
    "--window-size=1280,900",
    "--use-angle=default",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

const logs = [];
page.on("console", (m) => {
  const t = m.type();
  if (t === "error" || t === "warn" || t === "log")
    logs.push(`[${t}] ${m.text().slice(0, 2000)}`);
});
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) =>
  logs.push(`[reqfail] ${r.url().slice(-80)} ${r.failure()?.errorText}`),
);

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await new Promise((r) => setTimeout(r, Number(waitMs)));

// 页面侧状态:hud 文案、canvas 像素统计(非背景像素占比)
const state = await page.evaluate(() => {
  const hud = document.querySelector("#hud")?.textContent ?? "";
  const canvas = document.querySelector("#map canvas");
  let lit = -1;
  if (canvas) {
    const gl =
      canvas.getContext("webgl2", { preserveDrawingBuffer: false }) ??
      undefined;
    // 用 2D 截读不可行(WebGL);退而求其次读 canvas 尺寸
    lit = canvas.width * canvas.height;
  }
  return {
    hud,
    hasCanvas: !!canvas,
    canvasSize: canvas ? `${canvas.width}x${canvas.height}` : "none",
  };
});
console.log("STATE:", JSON.stringify(state));
console.log("LOGS:");
for (const l of logs.slice(0, 60)) console.log(" ", l);
if (shot) await page.screenshot({ path: shot });
await browser.close();
