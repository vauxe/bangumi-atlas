import { existsSync } from "node:fs";

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
