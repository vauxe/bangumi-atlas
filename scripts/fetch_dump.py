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
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from .build_lock import parquet_layout_lock

ROOT = Path(__file__).resolve().parent.parent
ZIP_PATH = ROOT / "data" / "dump.zip"
DUMP_DIR = ROOT / "data" / "dump"
PARQUET = ROOT / "data" / "parquet"
LATEST_URL = (
    "https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json"
)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _require_safe_storage_paths() -> None:
    data_dir = ZIP_PATH.parent
    if data_dir.is_symlink():
        raise ValueError(f"data directory must not be a symlink: {data_dir}")
    if ZIP_PATH.is_symlink():
        raise ValueError(f"dump archive must not be a symlink: {ZIP_PATH}")
    if DUMP_DIR.is_symlink():
        raise ValueError(f"dump directory must not be a symlink: {DUMP_DIR}")
    if DUMP_DIR.parent.resolve() != data_dir.resolve():
        raise ValueError("dump archive and directory must share a real parent")
    if DUMP_DIR.exists() and not DUMP_DIR.is_dir():
        raise ValueError(f"dump path must be a directory: {DUMP_DIR}")


def _download_archive(url: str, expected: str, size_mb: float) -> None:
    ZIP_PATH.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix=".dump-download-",
        suffix=".zip",
        dir=ZIP_PATH.parent,
        delete=False,
    ) as output:
        staging = Path(output.name)
        try:
            print(f"downloading {url}")
            with urllib.request.urlopen(url, timeout=60) as response:
                done = 0
                while chunk := response.read(1 << 20):
                    output.write(chunk)
                    done += len(chunk)
                    print(
                        f"\r  {done / 1e6:.0f}/{size_mb:.0f} MB",
                        end="",
                        flush=True,
                    )
                print()
            output.flush()
            actual = sha256_of(staging)
            if actual != expected:
                sys.exit(f"SHA256 mismatch: expected {expected}, got {actual}")
            staging.replace(ZIP_PATH)
        finally:
            staging.unlink(missing_ok=True)
    print("SHA256 verified")


def _extract_dump(version: str) -> None:
    print(f"extracting to {DUMP_DIR}")
    with tempfile.TemporaryDirectory(
        prefix=".dump-extract-", dir=DUMP_DIR.parent
    ) as directory:
        staging = Path(directory) / "dump"
        staging.mkdir()
        with zipfile.ZipFile(ZIP_PATH) as archive:
            root = staging.resolve()
            for member in archive.namelist():
                if not (root / member).resolve().is_relative_to(root):
                    sys.exit(f"zip member escapes extract dir: {member}")
            archive.extractall(staging)
        (staging / "VERSION").write_text(f"{version}\n")
        if DUMP_DIR.exists():
            shutil.rmtree(DUMP_DIR)
        staging.replace(DUMP_DIR)


def _fetch_dump() -> None:
    _require_safe_storage_paths()
    with urllib.request.urlopen(LATEST_URL, timeout=15) as resp:
        latest = json.load(resp)
    expected = latest["digest"].removeprefix("sha256:")
    size_mb = latest["size"] / 1e6
    print(f"latest: {latest['name']} ({size_mb:.0f} MB)")

    if ZIP_PATH.exists() and sha256_of(ZIP_PATH) == expected:
        print("local zip already matches digest, skipping download")
    else:
        _download_archive(latest["browser_download_url"], expected, size_mb)

    _require_safe_storage_paths()
    _extract_dump(Path(latest["name"]).stem)
    print("done; next: uv run python -m scripts.build_db")


def main() -> None:
    with parquet_layout_lock(PARQUET):
        _fetch_dump()


if __name__ == "__main__":
    main()
