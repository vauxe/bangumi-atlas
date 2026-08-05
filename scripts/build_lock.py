"""Cross-process serialization for Parquet publishers and layout readers."""

from __future__ import annotations

import fcntl
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

PARQUET_BUILD_MARKER = ".build-in-progress"


@contextmanager
def parquet_layout_lock(parquet: Path) -> Iterator[None]:
    """Prevent layout from observing a concurrent multi-file Parquet build."""
    lock_path = parquet.parent / ".parquet-layout.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
