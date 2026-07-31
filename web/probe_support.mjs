import { existsSync } from "node:fs";

const COVER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function coverRequestType(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== "https://api.bgm.tv") return null;
  if (!/^\/v0\/(subjects|persons|characters)\/\d+\/image$/.test(url.pathname))
    return null;
  const type = url.searchParams.get("type");
  return ["small", "grid", "medium"].includes(type) ? type : null;
}

/** Keep browser smoke tests deterministic while still proving that each UI
 * surface requests the official Bangumi image endpoint. Puppeteer requires
 * every intercepted request to be continued, responded to, or aborted:
 * https://pptr.dev/api/puppeteer.page.setrequestinterception */
export async function stubCoverImages(page) {
  const stats = { small: 0, grid: 0, medium: 0, errors: [] };
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.isInterceptResolutionHandled()) return;
    const type = coverRequestType(request.url());
    const action = type
      ? request.respond({
          status: 200,
          contentType: "image/png",
          headers: {
            "access-control-allow-origin": "*",
            "cache-control": "public, max-age=3600",
          },
          body: COVER_PNG,
        })
      : request.continue();
    if (type) stats[type]++;
    void action.catch((error) => stats.errors.push(String(error)));
  });
  return stats;
}

export function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found)
    throw new Error("Chrome not found; set CHROME_PATH to its executable");
  return found;
}

export const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
