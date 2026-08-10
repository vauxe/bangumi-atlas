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

from . import parquet_provenance
from .layout import (
    layout_cache_matches,
    layout_input_digest_from_generation,
)


def validate_layout_report(
    report: Any, *, shape_digest: str
) -> dict[str, Any]:
    """Reject test or obsolete geometry before it can be published.

    shape_digest 由调用方从当前整形代码算出:报告里的摘要与它不等,
    说明这份坐标出自另一套整形逻辑,只能重跑布局。
    """

    if not isinstance(report, dict):
        raise ValueError("layout report must be an object")
    if report.get("stub"):
        raise ValueError("stub layout is not publishable")
    if report.get("dimensions") != 3:
        raise ValueError("layout must be three-dimensional")
    if report.get("shape_digest") != shape_digest:
        raise ValueError(
            "layout shape digest does not match the current shaping code, "
            "rerun layout.py"
        )
    return report


def validate_name_pack(
    pack_path: Path,
    index_path: Path,
    *,
    n_rows: int,
    block_size: int,
) -> None:
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
                or len(row) != 3
                or not isinstance(row[0], str)
                or (row[1] is not None and not isinstance(row[1], str))
                or type(row[2]) is not int
                or row[2] not in (1, 2, 3)
                for row in rows
            ):
                raise ValueError(f"names block {block}: invalid row")


def require_current_release_inputs(
    *,
    dump: Path,
    dump_zip: Path,
    mappings: Path,
    parquet: Path,
    layout_dir: Path,
    shape_digest: str,
) -> dict[str, Any]:
    """Require one exact Parquet generation and its intact layout cache."""

    generation = parquet_provenance.require_valid_generation(
        dump=dump,
        dump_zip=dump_zip,
        mappings=mappings,
        parquet=parquet,
    )
    input_digest = layout_input_digest_from_generation(generation)
    if not layout_cache_matches(layout_dir, input_digest, shape_digest):
        raise ValueError(
            "layout cache does not match the current Parquet generation; "
            "rerun layout.py"
        )
    try:
        cache = orjson.loads((layout_dir / "cache.json").read_bytes())
    except (OSError, orjson.JSONDecodeError) as error:
        raise ValueError(
            f"cannot read validated layout cache: {error}"
        ) from error
    return {
        "dump_version": generation["source"]["dump_version"],
        "dump_sha256": generation["source"]["archive"]["sha256"],
        "parquet_generation": generation["version"],
        "layout_input_digest": input_digest,
        "layout_cache_identity": cache["cache_identity"],
        "layout_artifacts": cache["artifacts"],
    }
