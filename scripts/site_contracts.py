"""Stable contracts shared by the site-data baker and its tests."""

from __future__ import annotations

import gzip
import hashlib
from pathlib import Path
from typing import Any

import orjson


def _canonical_json(value: Any) -> bytes:
    return orjson.dumps(
        value,
        option=orjson.OPT_NON_STR_KEYS | orjson.OPT_SORT_KEYS,
    )


def reverse_navigation_label(label: str) -> str:
    """Label a synthesized reverse adjacency without inventing reciprocity."""

    return f"← {label or '关联'}"


def gzip_json(value: Any, compresslevel: int = 6) -> bytes:
    """Encode JSON into reproducible gzip bytes."""

    return gzip.compress(
        _canonical_json(value),
        compresslevel=compresslevel,
        mtime=0,
    )


def artifact_version(dump_version: str, contract: dict[str, Any]) -> str:
    """Derive the cache identity from the complete published contract."""

    payload = {"dump_version": dump_version, "contract": contract}
    digest = hashlib.sha256(_canonical_json(payload)).hexdigest()[:16]
    return f"{dump_version}-{digest}"


def validate_layout_report(
    report: Any, *, allow_stub: bool = False
) -> dict[str, Any]:
    """Reject test or obsolete geometry before it can be published."""

    if not isinstance(report, dict):
        raise ValueError("layout report must be an object")
    if report.get("stub") is not False and not allow_stub:
        raise ValueError("stub layout is not publishable")
    if report.get("dimensions") != 3:
        raise ValueError("layout must be three-dimensional")
    if report.get("geometry") != "topology-2.5d":
        raise ValueError("layout geometry must be topology-2.5d")
    return report


def read_dump_version(path: Path) -> str:
    """Read required source provenance without a wall-clock fallback."""

    try:
        version = path.read_text().strip()
    except FileNotFoundError:
        version = ""
    if not version:
        raise ValueError(f"{path}: dump VERSION is missing or empty")
    return version
