// 无头 Chrome 探针:加载星图,抓 console/pageerror,等待渲染后截图。
// 用法:node probe.mjs <url> <截图路径> [等待 ms]
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { chromePath, pause } from "./probe_support.mjs";

const [url, shot, waitMs = "12000"] = process.argv.slice(2);
assert.ok(url, "usage: node probe.mjs <url> [screenshot] [wait-ms]");
const browser = await puppeteer.launch({
  executablePath: chromePath(),
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
await pause(Number(waitMs));

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
const focusOrder = [];
for (let i = 0; i < 4; i++) {
  await page.keyboard.press("Tab");
  focusOrder.push(await page.evaluate(() => document.activeElement?.id ?? ""));
}
await page.click("#filters-head");
await pause(100);
const accessibility = await page.accessibility.snapshot();
const axNodes = [];
const walkAx = (node) => {
  if (!node) return;
  axNodes.push({ role: node.role, name: node.name });
  for (const child of node.children ?? []) walkAx(child);
};
walkAx(accessibility);
console.log("STATE:", JSON.stringify(state));
console.log("FOCUS:", JSON.stringify(focusOrder));
console.log(
  "AX:",
  JSON.stringify(
    axNodes.filter((node) =>
      ["application", "combobox", "button", "slider"].includes(node.role),
    ),
  ),
);
console.log("LOGS:");
for (const l of logs.slice(0, 60)) console.log(" ", l);
if (shot) await page.screenshot({ path: shot });
await browser.close();

assert.equal(
  logs.filter((line) =>
    /^\[(warn|error|pageerror|reqfail)\]/.test(line),
  ).length,
  0,
  `browser errors:\n${logs.join("\n")}`,
);
assert.equal(state.hasCanvas, true, "map canvas was not created");
assert.doesNotMatch(state.hud, /失败/, `HUD reports failure: ${state.hud}`);
assert.deepEqual(
  focusOrder,
  ["deckgl-overlay", "search", "dice", "filters-head"],
  "primary controls have an unexpected keyboard focus order",
);
for (const expected of [
  ["application", "Bangumi 三维关系星图"],
  ["combobox", "搜索作品、人物或角色"],
  ["button", "随机传送"],
  ["slider", "最低评分"],
  ["slider", "最早年份"],
  ["slider", "最晚年份"],
])
  assert.ok(
    axNodes.some(
      (node) => node.role === expected[0] && node.name === expected[1],
    ),
    `accessibility tree lacks ${expected[0]}: ${expected[1]}`,
  );
