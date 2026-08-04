"""Stable contracts shared by the site-data baker and its tests.

SiteRelease 的格式契约(元组、成员、门禁)在 scripts/site_release.py;
这里只保留布局报告、名字表和来源版本这类跨阶段的通用校验。
"""

from __future__ import annotations

import gzip
import struct
import zlib
from itertools import pairwise
from pathlib import Path
from typing import Any

import orjson


def validate_layout_report(report: Any) -> dict[str, Any]:
    """Reject test or obsolete geometry before it can be published."""

    if not isinstance(report, dict):
        raise ValueError("layout report must be an object")
    if report.get("stub"):
        raise ValueError("stub layout is not publishable")
    if report.get("dimensions") != 3:
        raise ValueError("layout must be three-dimensional")
    if report.get("geometry") != "topology-3d":
        raise ValueError("layout geometry must be topology-3d")
    return report


def validate_name_pack(
    pack_path: Path,
    index_path: Path,
    *,
    n_rows: int,
    block_size: int,
) -> None:
    """Prove that every indexed name block is readable and complete."""

    if n_rows < 0:
        raise ValueError("name row count must not be negative")
    if block_size <= 0:
        raise ValueError("name block size must be positive")

    block_count = (n_rows + block_size - 1) // block_size
    index_bytes = index_path.read_bytes()
    expected_index_bytes = (block_count + 1) * 4
    if len(index_bytes) != expected_index_bytes:
        raise ValueError(
            f"{index_path.name}: expected {expected_index_bytes} bytes, "
            f"got {len(index_bytes)}"
        )
    offsets = [value for (value,) in struct.iter_unpack("<I", index_bytes)]
    if offsets[0] != 0 or any(
        current <= previous for previous, current in pairwise(offsets)
    ):
        raise ValueError(
            f"{index_path.name}: offsets must strictly increase from zero"
        )

    pack_size = pack_path.stat().st_size
    if offsets[-1] != pack_size:
        raise ValueError(
            f"{index_path.name}: index endpoint {offsets[-1]} "
            f"does not match {pack_path.name} size {pack_size}"
        )

    with open(pack_path, "rb") as pack:
        for block, (start, end) in enumerate(pairwise(offsets)):
            pack.seek(start)
            payload = pack.read(end - start)
            try:
                rows = orjson.loads(gzip.decompress(payload))
            except (
                EOFError,
                OSError,
                orjson.JSONDecodeError,
                zlib.error,
            ) as error:
                raise ValueError(
                    f"names block {block}: unreadable gzip JSON"
                ) from error
            expected_rows = min(block_size, n_rows - block * block_size)
            if not isinstance(rows, list) or len(rows) != expected_rows:
                actual = len(rows) if isinstance(rows, list) else "non-array"
                raise ValueError(
                    f"names block {block}: expected {expected_rows} rows, "
                    f"got {actual}"
                )
            if any(
                not isinstance(row, list)
                or len(row) != 2
                or not isinstance(row[0], str)
                or (row[1] is not None and not isinstance(row[1], str))
                for row in rows
            ):
                raise ValueError(f"names block {block}: invalid row")


def read_dump_version(path: Path) -> str:
    """Read required source provenance without a wall-clock fallback."""

    try:
        version = path.read_text().strip()
    except FileNotFoundError:
        version = ""
    if not version:
        raise ValueError(f"{path}: dump VERSION is missing or empty")
    return version


def require_parquet_matches_dump(
    dump_version: str, parquet_version: str
) -> None:
    """Reject baking a Parquet projection that predates the current dump.

    The bake reads `data/parquet` but stamps the release with the dump
    version, so a stale projection would be published under a version
    string it was never built from.
    """

    if parquet_version != dump_version:
        raise ValueError(
            f"parquet VERSION {parquet_version} != dump VERSION "
            f"{dump_version}; rerun build_db.py before baking"
        )
