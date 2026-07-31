"""Order-independent, duplicate-sensitive fingerprints for table rows."""

from __future__ import annotations

import hashlib
from typing import Any

import orjson

_BITS = 128
_MODULUS = 1 << _BITS


class RowFingerprint:
    """Compact multiset fingerprint suitable for streaming large tables."""

    def __init__(self) -> None:
        self._count = 0
        self._sum = 0
        self._xor = 0

    def add(self, row: Any) -> None:
        payload = orjson.dumps(row, option=orjson.OPT_SORT_KEYS)
        value = int.from_bytes(
            hashlib.blake2b(payload, digest_size=_BITS // 8).digest(),
            "big",
        )
        self._count += 1
        self._sum = (self._sum + value) % _MODULUS
        self._xor ^= value

    def snapshot(self) -> tuple[int, str, str]:
        """Return a printable and directly comparable immutable snapshot."""

        return (
            self._count,
            f"{self._sum:032x}",
            f"{self._xor:032x}",
        )
