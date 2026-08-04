"""Download the latest bangumi/Archive dump, verify it, extract it.

Resolves aux/latest.json for the current release asset, streams the zip
to data/dump.zip, checks its SHA256 against the published digest, then
extracts into data/dump/. Skips the download when the local zip already
matches the digest.
"""

import hashlib
import json
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZIP_PATH = ROOT / "data" / "dump.zip"
DUMP_DIR = ROOT / "data" / "dump"
LATEST_URL = (
    "https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json"
)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    with urllib.request.urlopen(LATEST_URL, timeout=15) as resp:
        latest = json.load(resp)
    expected = latest["digest"].removeprefix("sha256:")
    size_mb = latest["size"] / 1e6
    print(f"latest: {latest['name']} ({size_mb:.0f} MB)")

    if ZIP_PATH.exists() and sha256_of(ZIP_PATH) == expected:
        print("local zip already matches digest, skipping download")
    else:
        ZIP_PATH.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {latest['browser_download_url']}")
        with (
            urllib.request.urlopen(
                latest["browser_download_url"], timeout=60
            ) as resp,
            open(ZIP_PATH, "wb") as out,
        ):
            done = 0
            while chunk := resp.read(1 << 20):
                out.write(chunk)
                done += len(chunk)
                print(
                    f"\r  {done / 1e6:.0f}/{size_mb:.0f} MB",
                    end="",
                    flush=True,
                )
            print()
        actual = sha256_of(ZIP_PATH)
        if actual != expected:
            ZIP_PATH.unlink()  # 坏包不留盘,防下次误判"已就绪"
            sys.exit(f"SHA256 mismatch: expected {expected}, got {actual}")
        print("SHA256 verified")

    # start clean so files removed upstream don't linger and get imported
    shutil.rmtree(DUMP_DIR, ignore_errors=True)
    print(f"extracting to {DUMP_DIR}")
    with zipfile.ZipFile(ZIP_PATH) as zf:
        root = DUMP_DIR.resolve()
        for m in zf.namelist():  # 路径消毒:拒绝越界成员
            if not (root / m).resolve().is_relative_to(root):
                sys.exit(f"zip member escapes extract dir: {m}")
        zf.extractall(DUMP_DIR)
    # 数据版本落盘,烘焙 manifest 以此为缓存寻址依据
    (DUMP_DIR / "VERSION").write_text(Path(latest["name"]).stem + "\n")
    print("done; next: uv run python scripts/build_db.py")


if __name__ == "__main__":
    main()
