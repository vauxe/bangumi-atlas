import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { test } from "node:test";

const STATIC_IMPORT = /\bfrom["']\.\/([^"']+)["']|\bimport["']\.\/([^"']+)["']/g;

function staticModuleClosure(root: string, entry: string): string[] {
  const modules = new Set<string>();
  const visit = (href: string): void => {
    if (modules.has(href)) return;
    modules.add(href);
    const source = readFileSync(join(root, href), "utf8");
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const imported = match[1] ?? match[2];
      assert.ok(imported);
      visit(posix.normalize(posix.join(posix.dirname(href), imported)));
    }
  };
  visit(entry);
  return [...modules].sort();
}

test("preloads exactly the initial static ESM graph", () => {
  const staging = mkdtempSync(join(tmpdir(), "bangumi-atlas-web-build-"));
  try {
    copyFileSync(resolve("../site/index.html"), join(staging, "index.html"));
    const build = spawnSync(process.execPath, ["build.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, ATLAS_SITE_DIR: staging },
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

    const page = readFileSync(join(staging, "index.html"), "utf8");
    const preloads = [...page.matchAll(
      /<link rel="modulepreload" href="([^"]+)">/g,
    )].map((match) => match[1]!).sort();
    const expected = staticModuleClosure(staging, "app.js");

    assert.deepEqual(preloads, expected);
    assert.doesNotMatch(
      preloads.join("\n"),
      /(?:drawer|runtime|webgl-device)-/,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});
