"""Stable contracts shared by the site-data baker and its tests."""

from __future__ import annotations

import gzip
import hashlib
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
