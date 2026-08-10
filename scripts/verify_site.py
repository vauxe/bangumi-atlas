"""Independently verify the baked SiteRelease against parquet.

设计契约见 docs/STRUCTURAL_SITE_DATA_DESIGN.md §8。本脚本不复用
烘焙器的装配逻辑:自行读取 parquet 重推期望值,自行解码 site/data
字节,再做重复敏感、顺序无关的对账。任何不符以非零状态退出,
阻断发布。共享的只有 scripts/site_release.py 中的格式契约本身。
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import heapq
import sys
import tempfile
import time
import zlib
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator, Sequence
from functools import cache
from itertools import pairwise
from pathlib import Path
from typing import Any

import numpy as np
import orjson
import pyarrow.parquet as pq
from opencc import OpenCC
from scipy.spatial import cKDTree

from . import site_release as sr
from .build_lock import parquet_layout_lock
from .content_fingerprint import RowFingerprint
from .enum_mappings import load_mappings
from .layout import shape_digest
from .query_contracts import (
    load_query_contract,
    query_schema_digest,
    validate_query_contract,
)
from .site_contracts import require_current_release_inputs

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "data" / "dump"
DUMP_ZIP = ROOT / "data" / "dump.zip"
PARQUET = ROOT / "data" / "parquet"
LAYOUT_DIR = ROOT / "data" / "layout"
LAYOUT = LAYOUT_DIR / "coords.parquet"
SITE = ROOT / "site" / "data"
SITE_ROOT = ROOT / "site"
MAPPING_SNAPSHOT = ROOT / "data" / "mappings"

failures: list[str] = []
artifact_files: dict[str, list[Any]] = {}
member_spans: dict[str, set[tuple[int, int]]] = defaultdict(set)
MIN_NODE_CENTER_DISTANCE = 0.28
VERIFY_BATCH_ROWS = 32_768
EPISODE_TYPE_NAMES = {
    "0": "本篇",
    "1": "特别篇",
    "2": "OP",
    "3": "ED",
    "4": "预告/宣传/广告",
    "5": "MAD",
    "6": "其他",
}
PERSON_TYPE_NAMES = {"1": "个人", "2": "公司", "3": "组合"}
CHARACTER_ROLE_NAMES = {"1": "角色", "2": "机体", "3": "舰船", "4": "组织"}
FACT_INDEX_DTYPE = np.dtype(
    [
        ("offset", "<u8"),
        ("length", "<u4"),
        ("multiplicity", "<u4"),
        ("incidence", "u1"),
    ]
)
GEOMETRY_STRIDES = {
    "positions.bin": 12,
    "year.bin": 2,
    "key.bin": 4,
    "size.bin": 1,
    "flags.bin": 1,
    "score.bin": 1,
    "tags.bin": 4,
}


def _natural(value: Any) -> bool:
    return (
        isinstance(value, (int, np.integer))
        and not isinstance(value, bool)
        and int(value) >= 0
    )


def load_array(logical_name: str, dtype: str) -> np.ndarray:
    """Decode one fixed-width array exactly as the browser does."""

    raw = site_file(logical_name).read_bytes()
    item_type = np.dtype(dtype)
    if len(raw) % item_type.itemsize:
        type_name = f"{item_type.kind}{item_type.itemsize * 8}"
        raise ValueError(
            f"{logical_name}: byte length is not a {type_name} array"
        )
    return np.frombuffer(raw, dtype=item_type)


def canonical_entity_key(value: Any) -> int:
    """Accept only the decimal object key requested by Data.factEntry()."""

    if not isinstance(value, str):
        raise ValueError("entity key must be a decimal string")
    try:
        key = int(value)
    except ValueError as error:
        raise ValueError("entity key must be a decimal string") from error
    if not _natural(key) or value != str(key):
        raise ValueError(f"noncanonical entity key: {value!r}")
    return key


def expected_layout_projection(
    layout: dict[str, np.ndarray],
) -> dict[str, np.ndarray]:
    """Derive rank-aligned geometry fields from the layout input."""

    collect = np.asarray(layout["collect"])
    order = np.argsort(-collect, kind="stable")
    ranked_collect = collect[order]
    sizes = np.round(18 * np.log2(1 + ranked_collect))
    return {
        "key": np.asarray(layout["key"])[order].astype("<u4"),
        "year": np.asarray(layout["year"])[order].astype("<u2"),
        "size": np.minimum(255, sizes).astype(np.uint8),
        "isolated": np.asarray(layout["isolated"])[order].astype(np.uint8),
    }


def expected_year_range(years: np.ndarray) -> list[int]:
    nonzero = years[years > 0]
    if not len(nonzero):
        return [0, 0]
    lower = int(np.clip(nonzero.min(), 1900, 2035))
    return [lower, int(np.clip(nonzero.max(), lower, 2035))]


def edge_array_is_valid(
    endpoints: np.ndarray, *, n_nodes: int, n_edges: int
) -> bool:
    """Validate only the published skeleton's browser-visible shape."""

    return (
        isinstance(endpoints, np.ndarray)
        and endpoints.ndim == 1
        and _natural(n_nodes)
        and _natural(n_edges)
        and len(endpoints) == n_edges * 2
        and bool((endpoints < n_nodes).all())
    )


def incidence_tuple_is_valid(kind: str, row: Any) -> bool:
    """Validate the fixed tuple shape before Python can ignore extra fields."""

    attrs = sr.FACT_ATTRS.get(kind)
    roles = sr.FACT_ROLES.get(kind)
    return bool(
        attrs is not None
        and roles is not None
        and isinstance(row, list)
        and len(row) == 4 + len(attrs)
        and _natural(row[0])
        and _natural(row[1])
        and row[1] > 0
        and _natural(row[2])
        and 0 < row[2] < 1 << len(roles)
        and isinstance(row[3], list)
        and all(_natural(key) for key in row[3])
        and (
            kind != "VOICE_CREDIT"
            or (type(row[-1]) is int and row[-1] in (0, 1))
        )
    )


def record_fact_participant(
    masks: np.ndarray,
    ref: int,
    key: int,
    participants: tuple[int, ...],
) -> bool:
    """Record one unique participant key for a canonical FactRef."""

    unique = tuple(dict.fromkeys(participants))
    try:
        bit = 1 << unique.index(key)
    except ValueError:
        return False
    previous = int(masks[ref])
    if previous & bit:
        return False
    masks[ref] = previous | bit
    return True


def rank_index_layout_is_valid(index: Any, raw_size: int) -> bool:
    """Validate the complete byte layout before decoding any u24 rank."""

    if (
        not isinstance(index, dict)
        or index.get("encoding") != sr.RANK_ENCODING
        or index.get("sentinel") != sr.RANK_SENTINEL
        or not isinstance(index.get("segments"), dict)
        or set(index["segments"]) != {str(kind) for kind in sr.KINDS}
        or not _natural(raw_size)
    ):
        return False
    cursor = 0
    for kind in sr.KINDS:
        segment = index["segments"][str(kind)]
        if (
            not isinstance(segment, dict)
            or set(segment) != {"offset", "count"}
            or not _natural(segment.get("offset"))
            or not _natural(segment.get("count"))
            or segment["offset"] != cursor
        ):
            return False
        cursor += segment["count"] * 3
    return cursor == raw_size


def rank_block_index_is_valid(
    index: Any,
    *,
    n_rows: int,
    block_size: int,
    pack_size: int,
) -> bool:
    """Validate exact rank coverage and every gzip member boundary."""

    if (
        not _natural(n_rows)
        or not _natural(block_size)
        or block_size == 0
        or not _natural(pack_size)
        or not hasattr(index, "__len__")
    ):
        return False
    blocks = (n_rows + block_size - 1) // block_size
    if len(index) != blocks + 1:
        return False
    offsets = list(index)
    return (
        all(_natural(value) for value in offsets)
        and int(offsets[0]) == 0
        and int(offsets[-1]) == pack_size
        and all(
            0 < int(end) - int(start) <= sr.MEMBER_CAP
            for start, end in pairwise(offsets)
        )
    )


def geometry_sizes_are_valid(sizes: Any, n_nodes: int) -> bool:
    """Verify every geometry SoA width before allocating or decoding it."""

    return (
        isinstance(sizes, dict)
        and _natural(n_nodes)
        and all(
            _natural(sizes.get(name)) and sizes[name] == n_nodes * stride
            for name, stride in GEOMETRY_STRIDES.items()
        )
    )


def search_alias_row_is_valid(row: Any) -> bool:
    """Validate browser shape; an unsearchable rank may have no aliases."""

    return (
        isinstance(row, list)
        and len(row) == 3
        and isinstance(row[0], list)
        and all(
            isinstance(alias, list)
            and len(alias) == 2
            and isinstance(alias[0], str)
            and bool(alias[0])
            and isinstance(alias[1], str)
            for alias in row[0]
        )
        and isinstance(row[1], str)
        and type(row[2]) is int
        and row[2] in sr.KINDS
    )


def log(msg: str) -> None:
    print(msg, flush=True)


def check(label: str, ok: bool, detail: str = "") -> None:
    if not ok:
        failures.append(label)
    log(
        f"  {'ok' if ok else 'MISMATCH':8s} {label}"
        f"{': ' + detail if detail else ''}"
    )


def reconcile(label: str, expected: Any, actual: Any) -> None:
    check(label, expected == actual, f"expected {expected}, got {actual}")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def validated_artifact_path(logical_name: str, meta: Any) -> Path:
    """Resolve one manifest artifact without trusting a manifest path."""

    if not isinstance(logical_name, str) or not isinstance(meta, list):
        raise ValueError("manifest artifact entry has invalid types")
    if len(meta) != 3:
        raise ValueError(f"invalid artifact metadata for {logical_name}")
    size, digest, physical_name = meta
    if not _natural(size):
        raise ValueError(f"invalid artifact size for {logical_name}")
    if not isinstance(digest, str) or not isinstance(physical_name, str):
        raise ValueError(f"invalid artifact identity for {logical_name}")
    expected_name = sr.published_object_name(logical_name, digest)
    if physical_name != expected_name:
        raise ValueError(
            f"{logical_name}: physical name must be {expected_name}, "
            f"got {physical_name}"
        )
    path = SITE / expected_name
    if path.is_symlink():
        raise ValueError(f"{logical_name}: artifact must not be a symlink")
    if not path.is_file():
        raise ValueError(f"{logical_name}: artifact is not a regular file")
    return path


def validated_site_data_root(site_root: Path) -> Path:
    """Require a real direct ``data`` directory below the selected site."""

    root = site_root.resolve()
    candidate = root / "data"
    if candidate.is_symlink():
        raise ValueError("site/data must not be a symlink")
    if not candidate.is_dir():
        raise ValueError("site/data must be an existing directory")
    resolved = candidate.resolve()
    if resolved.parent != root or resolved.name != "data":
        raise ValueError("site/data must be a direct child of the site root")
    return resolved


def site_file(logical_name: str) -> Path:
    meta = artifact_files.get(logical_name)
    if meta is None:
        raise ValueError(
            f"manifest missing physical object for {logical_name}"
        )
    return validated_artifact_path(logical_name, meta)


def read_member_bytes(logical_name: str, off: int, length: int) -> bytes:
    path = site_file(logical_name)
    if off < 0 or length <= 0:
        raise ValueError(
            f"{logical_name}: invalid member [{off}, {off + length})"
        )
    if length > sr.MEMBER_CAP:
        check(
            f"{logical_name} 成员硬上限",
            False,
            f"offset {off:,}, length {length:,}",
        )
    member_spans[logical_name].add((off, length))
    with open(path, "rb") as f:
        f.seek(off)
        raw = f.read(length)
    if len(raw) != length:
        raise ValueError(f"{path.name}: truncated member at {off}")
    return raw


def decompress_member(member: bytes, label: str) -> bytes:
    """Decode one gzip member without ever retaining more than the raw cap."""

    if len(member) > sr.MEMBER_CAP:
        raise ValueError(
            f"{label}: gzip member {len(member):,} exceeds "
            f"member cap {sr.MEMBER_CAP:,}"
        )
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    output = bytearray()
    pending = member
    try:
        while not decoder.eof:
            chunk = decoder.decompress(
                pending, sr.MEMBER_RAW_CAP + 1 - len(output)
            )
            output.extend(chunk)
            if len(output) > sr.MEMBER_RAW_CAP:
                raise ValueError(
                    f"{label}: decoded member cap "
                    f"{sr.MEMBER_RAW_CAP:,} exceeded"
                )
            pending = decoder.unconsumed_tail
            if not pending and not decoder.eof:
                raise ValueError(f"{label}: truncated gzip member")
    except zlib.error as error:
        raise ValueError(f"{label}: unreadable gzip member") from error
    if decoder.unused_data:
        raise ValueError(
            f"{label}: multiple gzip members in one directory row"
        )
    return bytes(output)


def load_member(logical_name: str, off: int, length: int) -> Any:
    raw = read_member_bytes(logical_name, off, length)
    return orjson.loads(decompress_member(raw, logical_name))


def load_binary_member(logical_name: str, off: int, length: int) -> bytes:
    raw = read_member_bytes(logical_name, off, length)
    return decompress_member(raw, logical_name)


def decode_delta_posting(
    raw: bytes, expected_count: int, upper_bound: int
) -> list[int]:
    """Independently decode the text-search posting representation."""
    result: list[int] = []
    offset = 0
    previous = -1
    while len(result) < expected_count:
        delta = 0
        shift = 0
        while True:
            if offset >= len(raw) or shift > 28:
                raise ValueError("truncated or overflowing text-search varint")
            byte = raw[offset]
            offset += 1
            delta += (byte & 0x7F) << shift
            if not byte & 0x80:
                if shift and not byte & 0x7F:
                    raise ValueError("non-canonical text-search varint")
                break
            shift += 7
        identity = delta if previous < 0 else previous + delta
        if identity <= previous or identity >= upper_bound:
            raise ValueError("invalid text-search member id")
        result.append(identity)
        previous = identity
    if offset != len(raw):
        raise ValueError("trailing text-search posting bytes")
    return result


def load_idx(name: str) -> Any:
    return orjson.loads(decompress_member(site_file(name).read_bytes(), name))


def _range_index(ranges: list[list[int]], identity: int) -> int | None:
    lo = 0
    hi = len(ranges) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        row = ranges[mid]
        if identity < row[0]:
            hi = mid - 1
        elif identity > row[1]:
            lo = mid + 1
        else:
            return mid
    return None


def range_routes_are_valid(
    ranges: list[list[int]],
    identities: list[list[int]],
    *,
    row_length: int = 4,
    file_count: int | None = None,
) -> bool:
    """Mirror the client's binary range lookup for every stored identity."""

    if (
        len(ranges) != len(identities)
        or not _natural(row_length)
        or row_length < 2
        or (file_count is not None and not _natural(file_count))
    ):
        return False
    previous_end = -1
    for index, (row, member_ids) in enumerate(
        zip(ranges, identities, strict=True)
    ):
        if (
            not isinstance(row, list)
            or len(row) != row_length
            or any(not _natural(value) for value in row)
            or row[0] > row[1]
            or row[0] <= previous_end
            or (
                file_count is not None
                and (row_length < 3 or row[2] >= file_count)
            )
            or not isinstance(member_ids, list)
            or not member_ids
            or any(not _natural(identity) for identity in member_ids)
            or member_ids != sorted(set(member_ids))
            or member_ids[0] != row[0]
            or member_ids[-1] != row[1]
        ):
            return False
        if any(
            identity < row[0]
            or identity > row[1]
            or _range_index(ranges, identity) != index
            for identity in member_ids
        ):
            return False
        previous_end = row[1]
    return True


def fact_routes_are_valid(
    index: dict[str, Any], member_keys: list[list[list[int]]], buckets: int
) -> bool:
    """Mirror factEntry(): bucket, then first member covering the key."""

    directories = index.get("b")
    if (
        index.get("buckets") != buckets
        or not isinstance(directories, list)
        or len(directories) != buckets
        or len(member_keys) != buckets
    ):
        return False
    for bucket, (rows, keys_by_member) in enumerate(
        zip(directories, member_keys, strict=True)
    ):
        if len(rows) != len(keys_by_member):
            return False
        previous_last = -1
        for member_index, (row, keys) in enumerate(
            zip(rows, keys_by_member, strict=True)
        ):
            if (
                not isinstance(row, list)
                or len(row) != 3
                or any(not _natural(value) for value in row)
                or not keys
                or any(not _natural(key) for key in keys)
                or keys != sorted(set(keys))
                or row[2] != keys[-1]
                or row[2] <= previous_last
                or any(key % buckets != bucket for key in keys)
            ):
                return False
            for key in keys:
                routed = next(
                    (
                        i
                        for i, candidate in enumerate(rows)
                        if key <= candidate[2]
                    ),
                    None,
                )
                if routed != member_index:
                    return False
            previous_last = row[2]
    return True


def episode_text_routes_are_valid(
    ranges: list[list[int]],
    identities: list[list[tuple[int, int]]],
    *,
    file_count: int,
) -> bool:
    """Mirror the client's subject/episode range filter for every text row."""

    if len(ranges) != len(identities) or not _natural(file_count):
        return False
    previous_order: tuple[int, int, int] | None = None
    for index, (row, pairs) in enumerate(zip(ranges, identities, strict=True)):
        if (
            not isinstance(row, list)
            or len(row) not in (5, 7)
            or any(not _natural(value) for value in row)
            or row[0] > row[1]
            or row[2] >= file_count
            or (len(row) == 7 and row[5] > row[6])
            or not isinstance(pairs, list)
            or not pairs
            or any(
                not isinstance(pair, tuple)
                or len(pair) != 2
                or any(not _natural(value) for value in pair)
                for pair in pairs
            )
            or pairs != sorted(set(pairs))
            or pairs[0][0] != row[0]
            or pairs[-1][0] != row[1]
            or (
                len(row) == 7
                and (pairs[0][1] != row[5] or pairs[-1][1] != row[6])
            )
        ):
            return False
        order = (row[0], row[1], row[5] if len(row) == 7 else -1)
        if previous_order is not None and order <= previous_order:
            return False
        previous_order = order
        for subject, episode in pairs:
            routed = [
                route
                for route, candidate in enumerate(ranges)
                if candidate[0] <= subject <= candidate[1]
                and (
                    len(candidate) < 7
                    or candidate[5] <= episode <= candidate[6]
                )
            ]
            if routed != [index]:
                return False
    return True


def quantile(sizes: list[int], q: float) -> int:
    if not sizes:
        return 0
    arr = sorted(sizes)
    return arr[min(len(arr) - 1, int(q * len(arr)))]


def iter_parquet_dict_batches(
    path: Path,
    columns: Sequence[str],
    *,
    batch_size: int = VERIFY_BATCH_ROWS,
) -> Iterator[dict[str, list[Any]]]:
    """Project and decode one bounded Parquet record batch at a time."""

    for batch in pq.ParquetFile(path).iter_batches(
        batch_size=batch_size,
        columns=list(columns),
    ):
        yield batch.to_pydict()


def _read_fact_run(path: Path) -> Iterator[bytes]:
    with gzip.open(path, "rb") as reader:
        for line in reader:
            if not line.endswith(b"\n"):
                raise ValueError(f"truncated fact run: {path}")
            yield line[:-1]


class ExpectedFactStore:
    """Disk-backed canonical fact lookup addressed by deterministic FactRef."""

    def __init__(
        self,
        data_path: Path,
        index_path: Path,
        *,
        count: int,
        source_rows: int,
    ) -> None:
        self.count = count
        self.source_rows = source_rows
        self._data = np.memmap(data_path, dtype=np.uint8, mode="r")
        self._index = np.memmap(
            index_path,
            dtype=FACT_INDEX_DTYPE,
            mode="r",
            shape=(count,),
        )

    def lookup(self, ref: int) -> tuple[bytes, int, int]:
        record = self._index[ref]
        offset = int(record["offset"])
        length = int(record["length"])
        encoded = bytes(self._data[offset : offset + length])
        return (
            encoded,
            int(record["multiplicity"]),
            int(record["incidence"]),
        )

    @property
    def incidence_counts(self) -> np.ndarray:
        return self._index["incidence"]

    @property
    def multiplicities(self) -> np.ndarray:
        return self._index["multiplicity"]

    def close(self) -> None:
        self._data._mmap.close()  # type: ignore[attr-defined]
        self._index._mmap.close()  # type: ignore[attr-defined]


def build_expected_fact_store(
    directory: Path,
    encoded_batches: Iterable[Iterable[bytes]],
) -> ExpectedFactStore:
    """External-sort canonical facts into a compact random-access index."""

    directory.mkdir(parents=True, exist_ok=True)
    runs: list[Path] = []
    source_rows = 0
    for run_number, batch in enumerate(encoded_batches):
        encoded = list(batch)
        if not encoded:
            continue
        source_rows += len(encoded)
        encoded.sort()
        path = directory / f"fact-{run_number:06d}.jsonl.gz"
        with gzip.open(path, "wb", compresslevel=1) as writer:
            for value in encoded:
                if b"\n" in value:
                    raise ValueError("canonical fact contains a raw newline")
                writer.write(value + b"\n")
        runs.append(path)

    data_path = directory / "facts.data"
    index_path = directory / "facts.index"
    count = 0
    index_rows: list[tuple[int, int, int, int]] = []
    merged = heapq.merge(*(_read_fact_run(path) for path in runs))

    with data_path.open("wb") as data, index_path.open("wb") as index:
        previous: bytes | None = None
        multiplicity = 0

        def emit(value: bytes, repeats: int) -> None:
            nonlocal count
            offset = data.tell()
            data.write(value)
            parts = orjson.loads(value)[1]
            index_rows.append((offset, len(value), repeats, len(set(parts))))
            count += 1
            if len(index_rows) == VERIFY_BATCH_ROWS:
                index.write(
                    np.asarray(index_rows, dtype=FACT_INDEX_DTYPE).tobytes()
                )
                index_rows.clear()

        for value in merged:
            if value == previous:
                multiplicity += 1
                continue
            if previous is not None:
                emit(previous, multiplicity)
            previous = value
            multiplicity = 1
        if previous is not None:
            emit(previous, multiplicity)
        if index_rows:
            index.write(
                np.asarray(index_rows, dtype=FACT_INDEX_DTYPE).tobytes()
            )

    if not count:
        raise ValueError("expected at least one fact")
    return ExpectedFactStore(
        data_path,
        index_path,
        count=count,
        source_rows=source_rows,
    )


def find_position_overlap(
    positions: np.ndarray,
    minimum_distance: float,
) -> tuple[int, int, float] | None:
    """独立检查最终 float32 坐标，不复用烘焙器的格点逻辑。"""

    tree = cKDTree(positions)
    for start in range(0, len(positions), 100_000):
        end = min(start + 100_000, len(positions))
        distance, neighbor = tree.query(positions[start:end], k=2, workers=1)
        nearest = distance[:, 1]
        local = int(np.argmin(nearest))
        if float(nearest[local]) < minimum_distance:
            index = start + local
            other = int(neighbor[local, 1])
            first, second = sorted((index, other))
            return first, second, float(nearest[local])
    return None


class OrderedRows:
    """Compact digest for an ordered sequence of JSON rows."""

    __slots__ = ("count", "digest")

    def __init__(self) -> None:
        self.count = 0
        self.digest = hashlib.sha256()

    def add(self, row: list[Any]) -> None:
        encoded = orjson.dumps(row)
        self.digest.update(len(encoded).to_bytes(4, "little"))
        self.digest.update(encoded)
        self.count += 1

    def snapshot(self) -> tuple[int, bytes]:
        return self.count, self.digest.digest()


EMPTY_ROWS = OrderedRows().snapshot()


def add_ordered_row(
    expectations: dict[str, OrderedRows], prefix: str, row: list[Any]
) -> None:
    expectations.setdefault(prefix, OrderedRows()).add(row)


def rows_snapshot(rows: list[list[Any]]) -> tuple[int, bytes]:
    digest = OrderedRows()
    for row in rows:
        digest.add(row)
    return digest.snapshot()


def expected_search_fold(text: str, charmap: dict[str, str]) -> str:
    """Fold text from the version-pinned table, independent of the producer."""

    trimmed = text.strip(sr.SEARCH_TRIM_CHARS)
    return "".join(charmap.get(char, char) for char in trimmed)


@cache
def _oracle_opencc(config: str) -> OpenCC:
    return OpenCC(config)


_JAPANESE_RANGES = (
    (0x3040, 0x30FF),
    (0x31F0, 0x31FF),
    (0xFF66, 0xFF9D),
)


def _has_japanese_script(text: str) -> bool:
    return any(
        start <= ord(char) <= end
        for char in text
        for start, end in _JAPANESE_RANGES
    )


def expected_search_aliases(
    name: str, name_cn: str, charmap: dict[str, str]
) -> list[tuple[str, str]]:
    """Independently derive aliases that the published index must contain."""

    aliases: list[tuple[str, str]] = []
    seen_keys: set[str] = set()
    for source in dict.fromkeys(text for text in (name_cn, name) if text):
        variants = [
            source,
            _oracle_opencc("t2s").convert(source),
            _oracle_opencc("s2t").convert(source),
        ]
        if _has_japanese_script(source):
            variants.extend(
                (
                    _oracle_opencc("jp2t").convert(source),
                    _oracle_opencc("t2jp").convert(source),
                )
            )
        for matched in dict.fromkeys(variants):
            normalized = expected_search_fold(matched, charmap)
            if normalized and normalized not in seen_keys:
                seen_keys.add(normalized)
                aliases.append((normalized, matched))
    return aliases


def expected_search_gram_bucket(gram: str) -> int:
    """Independently apply the declared FNV-1a codepoint bucket contract."""

    if len(gram) != sr.SEARCH_NGRAM_WIDTH:
        raise ValueError(
            f"search gram must contain {sr.SEARCH_NGRAM_WIDTH} code points"
        )
    value = (2166136261 ^ sr.SEARCH_NGRAM_WIDTH) & 0xFFFFFFFF
    for char in gram:
        value ^= ord(char)
        value = (value * 16777619) & 0xFFFFFFFF
    return value & (sr.SEARCH_NGRAM_BUCKETS - 1)


def iter_alias_entries(alias_rows: list[list[Any]]) -> Iterator[list[Any]]:
    """Expand aliases already derived by this independent verifier."""

    for rank, (aliases, display, entity_kind) in enumerate(alias_rows):
        for normalized, matched in aliases:
            yield [normalized, matched, rank, display, entity_kind]


def expected_charmap() -> dict[str, str]:
    """Return the complete version-pinned query fold table."""

    value = orjson.loads(sr.SEARCH_CASEFOLD_PATH.read_bytes())
    if not isinstance(value, dict) or any(
        not isinstance(key, str)
        or len(key) != 1
        or not isinstance(folded, str)
        or not folded
        for key, folded in value.items()
    ):
        raise ValueError(f"invalid case-fold table: {sr.SEARCH_CASEFOLD_PATH}")
    charmap: dict[str, str] = value
    if any(
        len(folded) > sr.SEARCH_FOLD_MAX_EXPANSION
        for folded in charmap.values()
    ):
        raise ValueError(
            "case-fold expansion exceeds "
            f"{sr.SEARCH_FOLD_MAX_EXPANSION} code points"
        )
    if any(
        "".join(charmap.get(char, char) for char in folded) != folded
        for folded in charmap.values()
    ):
        raise ValueError(
            f"non-idempotent case-fold table: {sr.SEARCH_CASEFOLD_PATH}"
        )
    return charmap


def verify_release(  # noqa: PLR0915
    site_root: Path, input_identity: dict[str, Any]
) -> None:
    global SITE, SITE_ROOT, artifact_files  # noqa: PLW0603
    SITE_ROOT = site_root.resolve()
    SITE = validated_site_data_root(SITE_ROOT)
    failures.clear()
    member_spans.clear()
    t0 = time.time()
    validate_query_contract(
        load_query_contract(), sr.FACT_ROLES, sr.FACT_ATTRS
    )
    manifest_path = SITE / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("site/data/manifest.json must be a regular file")
    manifest = orjson.loads(manifest_path.read_bytes())
    artifact_files = manifest["files"]

    # ---- manifest 自身:版本、schema、文件摘要 ----
    log("[1] manifest 与文件摘要")
    body = {k: v for k, v in manifest.items() if k != "version"}
    reconcile(
        "manifest.version = 除自身外内容的 SHA-256",
        sr.manifest_version(body),
        manifest["version"],
    )
    reconcile("schema", sr.SCHEMA, manifest["schema"])
    reconcile("profile", sr.PROFILE, manifest["profile"])
    reconcile("schema_digest", sr.schema_digest(), manifest["schema_digest"])
    reconcile("field_policy", sr.FIELD_POLICY, manifest["field_policy"])
    reconcile(
        "source generation identity",
        input_identity,
        manifest.get("source"),
    )
    query_release = manifest.get("query", {})
    check(
        "查询能力合同完整",
        query_release.get("schema") == "atlas-release-query-v1"
        and query_release.get("capabilities")
        == [
            "atlas-query-v1",
            "fact-ref-v1",
            "full-text-v1",
        ]
        and query_release.get("contractDigest") == query_schema_digest(),
    )
    alias_block_size = manifest["limits"].get("search_alias_block_ranks")
    if (
        not _natural(alias_block_size)
        or alias_block_size == 0
        or alias_block_size > sr.SEARCH_ALIAS_BLOCK_RANKS_MAX
        or alias_block_size & (alias_block_size - 1)
    ):
        raise ValueError("invalid search alias block size")
    reconcile(
        "limits",
        sr.release_limits(search_alias_block_ranks=alias_block_size),
        manifest["limits"],
    )
    if not isinstance(artifact_files, dict):
        raise ValueError("manifest.files must be an object")
    data_entries = [
        path for path in SITE.iterdir() if path.name != "manifest.json"
    ]
    invalid_entries = sorted(
        path.name
        for path in data_entries
        if path.is_symlink() or not path.is_file()
    )
    if invalid_entries:
        raise ValueError(
            f"site/data contains non-regular artifacts: {invalid_entries}"
        )
    on_disk = {path.name for path in data_entries}
    listed: set[str] = set()
    total = 0
    for fname, meta in sorted(artifact_files.items()):
        p = validated_artifact_path(fname, meta)
        size, digest, physical_name = meta
        listed.add(physical_name)
        check(f"{fname} 内容寻址物理名", True, physical_name)
        ok = p.stat().st_size == size and sha256_of(p) == digest
        if not ok:
            check(f"{fname} 字节数与 SHA-256", False)
        total += size
        if fname.endswith(".pack") and size > sr.PACK_CAP:
            check(f"{fname} <= 80MB pack 上限", False, f"{size:,}")
    reconcile("manifest.files 覆盖全部数据文件", on_disk, listed)
    check(
        "files 字节数与摘要全部一致",
        total == manifest["total_bytes"],
        f"sum {total:,} vs total_bytes {manifest['total_bytes']:,}",
    )
    reconcile("manifest.n_files", len(artifact_files), manifest["n_files"])
    check(
        "manifest.core_bytes 在总字节数内",
        0 <= manifest["core_bytes"] <= manifest["total_bytes"],
    )
    staging_total = sum(
        p.stat().st_size for p in SITE_ROOT.rglob("*") if p.is_file()
    )
    log(
        f"  staging site/ 全部普通文件 {staging_total:,} B"
        f"(发布门禁 <= 1,000,000,000)"
    )
    check("staging site/ <= 1GB", staging_total <= 1_000_000_000)

    # ---- 几何与 rank-by-key ----
    log("[2] 几何与反向索引")
    n = manifest["n_nodes"]
    check("n_nodes 在 u24 rank 容量内", 0 < n < sr.RANK_SENTINEL)
    geometry_sizes = {
        name: artifact_files.get(name, [None])[0] for name in GEOMETRY_STRIDES
    }
    check(
        "几何 SoA 文件宽度与 n_nodes 一致",
        geometry_sizes_are_valid(geometry_sizes, n),
    )
    key_r = load_array("key.bin", "<u4")
    reconcile("key.bin 记录数", n, len(key_r))
    check("key.bin 无重复键", len(np.unique(key_r)) == n)
    check(
        "key.bin 实体种类合法",
        bool(np.isin(key_r >> np.uint32(24), sr.KINDS).all()),
    )
    layout_table = pq.read_table(
        LAYOUT, columns=["key", "collect", "year", "isolated"]
    )
    expected_geometry = expected_layout_projection(
        {
            column: np.asarray(layout_table.column(column))
            for column in layout_table.column_names
        }
    )
    del layout_table
    reconcile("layout 节点数", n, len(expected_geometry["key"]))
    check(
        "key.bin rank 顺序 = layout",
        np.array_equal(key_r, expected_geometry["key"]),
    )
    check(
        "year.bin = layout",
        np.array_equal(
            load_array("year.bin", "<u2"), expected_geometry["year"]
        ),
    )
    check(
        "size.bin = layout collect 编码",
        np.array_equal(
            load_array("size.bin", "u1"), expected_geometry["size"]
        ),
    )
    reconcile(
        "manifest.year_range = layout",
        expected_year_range(expected_geometry["year"]),
        manifest["year_range"],
    )
    expected_flags = expected_geometry["isolated"] << np.uint8(1)
    del expected_geometry

    edges = load_array("edges.bin", "<u4")
    check(
        "edges.bin 计数与端点范围合法",
        edge_array_is_valid(
            edges,
            n_nodes=n,
            n_edges=manifest["n_edges_skeleton"],
        ),
    )
    del edges

    positions_flat = load_array("positions.bin", "<f4")
    reconcile("positions.bin 记录数", n * 3, len(positions_flat))
    if len(positions_flat) != n * 3:
        raise ValueError("positions.bin has an invalid float32 record count")
    positions = positions_flat.reshape(n, 3)
    positions_finite = bool(np.isfinite(positions).all())
    check("positions.bin 坐标全部有限", positions_finite)
    if positions_finite:
        actual_bbox = [
            [float(value) for value in positions.min(axis=0)],
            [float(value) for value in positions.max(axis=0)],
        ]
        reconcile(
            "manifest.bbox = positions.bin 全量边界",
            actual_bbox,
            manifest["bbox"],
        )
    declared_distance = manifest["layout"].get("minimum_node_center_distance")
    reconcile(
        "layout 声明全局最小节点中心距",
        MIN_NODE_CENTER_DISTANCE,
        declared_distance,
    )
    violation = (
        find_position_overlap(positions, MIN_NODE_CENTER_DISTANCE)
        if positions_finite
        else None
    )
    check(
        "positions.bin 所有节点不重叠",
        positions_finite and violation is None,
        ""
        if violation is None
        else (
            f"rank {violation[0]} / {violation[1]} 中心距 "
            f"{violation[2]:.6f} < {MIN_NODE_CENTER_DISTANCE:g}"
        ),
    )
    del positions_flat, positions
    raw = np.frombuffer(site_file("rank-by-key.bin").read_bytes(), np.uint8)
    rank_layout_ok = rank_index_layout_is_valid(
        manifest["rank_index"], len(raw)
    )
    check(
        "rank_index 版本、segment 偏移与文件长度一致",
        rank_layout_ok,
    )
    decoded: dict[int, np.ndarray] = {}
    if rank_layout_ok:
        seg_meta = manifest["rank_index"]["segments"]
        for kind in sr.KINDS:
            seg = seg_meta[str(kind)]
            b = raw[seg["offset"] : seg["offset"] + seg["count"] * 3]
            decoded[kind] = (
                b[0::3].astype(np.uint32)
                | (b[1::3].astype(np.uint32) << 8)
                | (b[2::3].astype(np.uint32) << 16)
            )
        rank_values_ok = all(
            bool(((values == sr.RANK_SENTINEL) | (values < n)).all())
            for values in decoded.values()
        )
        check("rank-by-key 值为有效 rank 或哨兵", rank_values_ok)
        non_sentinel = sum(
            int((values != sr.RANK_SENTINEL).sum())
            for values in decoded.values()
        )
        reconcile("rank-by-key 覆盖数 = 节点数", n, non_sentinel)
        ok_rank = all(
            (kind := int(key) >> 24) in decoded
            and (source_id := int(key) & sr.MAX_SOURCE_ID) < len(decoded[kind])
            and decoded[kind][source_id] == rank
            for rank, key in enumerate(key_r)
        )
        check("rank-by-key[key] = rank(全量)", ok_rank)
    del raw

    # ---- 词表 ----
    log("[3] 词表")
    vocab_dir = load_idx("vocab.idx")["members"]
    vocab: dict[str, list[str]] = {}
    for fam, members in vocab_dir.items():
        out: list[str] = []
        for off, length in members:
            out.extend(load_member("vocab.pack", off, length))
        vocab[fam] = out
        reconcile(
            f"vocab.{fam} 摘要",
            manifest["vocab_digests"][fam],
            sr.sha256_hex(sr.canonical_json(out)),
        )
        check(
            f"vocab.{fam} UTF-8 字节序",
            all(
                out[i].encode() < out[i + 1].encode()
                for i in range(len(out) - 1)
            ),
        )

    # ---- 实体结构 + 名称:与 parquet 的重复敏感指纹对账 ----
    log("[4] 实体结构与名称")
    name_idx = load_array("names.idx", "<u4")
    block = manifest["name_block_size"]
    name_index_ok = rank_block_index_is_valid(
        name_idx,
        n_rows=n,
        block_size=block,
        pack_size=site_file("names.pack").stat().st_size,
    )
    check("names.idx 精确覆盖全部 rank 与 pack", name_index_ok)
    check(
        "names 块宽是发布上限内的二次幂",
        type(block) is int
        and 0 < block <= sr.NAME_BLOCK_SIZE
        and block & (block - 1) == 0,
    )
    if not name_index_ok:
        raise ValueError("names.idx has an invalid rank-block layout")
    names_by_rank: list[list[Any]] = []
    name_sizes: list[int] = []
    name_rows_ok = True
    for bi in range(len(name_idx) - 1):
        off, end = int(name_idx[bi]), int(name_idx[bi + 1])
        name_sizes.append(end - off)
        rows = load_member("names.pack", off, end - off)
        expected_rows = min(block, n - bi * block)
        if not isinstance(rows, list) or len(rows) != expected_rows:
            name_rows_ok = False
            break
        names_by_rank.extend(rows)
    check("names 每个成员行数与 rank 分块一致", name_rows_ok)
    if not name_rows_ok:
        raise ValueError("names.pack rows do not match names.idx")
    reconcile("names 行数", n, len(names_by_rank))
    names_shape_ok = all(
        isinstance(row, list)
        and len(row) == 3
        and isinstance(row[0], str)
        and (row[1] is None or isinstance(row[1], str))
        and type(row[2]) is int
        and row[2] in sr.KINDS
        for row in names_by_rank
    )
    check("names 行结构与实体种类合法", names_shape_ok)
    if not names_shape_ok:
        raise ValueError("names.pack contains an invalid row")
    check(
        "名称成员 P99 体验门禁",
        quantile(name_sizes, 0.99) <= sr.NAME_P99_CAP,
    )
    check("名称成员硬上限", max(name_sizes) <= sr.MEMBER_CAP)

    ent_idx = load_idx("entities.idx")
    site_ent_fp = RowFingerprint()
    ent_counts: dict[int, int] = {k: 0 for k in sr.KINDS}
    ent_sizes: list[int] = []
    presence: dict[str, np.ndarray] = {
        str(kind): np.zeros(len(decoded[kind]), dtype=np.uint8)
        for kind in sr.KINDS
    }
    for kind_s, ranges in ent_idx["k"].items():
        kind = int(kind_s)
        seen_ids = np.zeros(len(decoded[kind]), dtype=np.bool_)
        routed_ids: list[list[int]] = []
        names_match = True
        first_name_mismatch = ""
        for row in ranges:
            start, end, off, length = row
            ent_sizes.append(length)
            member = load_member("entities.pack", off, length)
            routed_ids.append(member["i"])
            for sid, tup in zip(member["i"], member["r"], strict=True):
                invalid_id = (
                    sid < start
                    or sid > end
                    or sid >= len(seen_ids)
                    or seen_ids[sid]
                )
                if invalid_id:
                    check(
                        f"entities kind={kind} 身份唯一且在范围内",
                        False,
                        str(sid),
                    )
                    continue
                seen_ids[sid] = True
                rank = int(decoded[kind][sid])
                if rank == sr.RANK_SENTINEL:
                    check(
                        f"entities kind={kind} 身份存在于 rank",
                        False,
                        str(sid),
                    )
                    continue
                nm = names_by_rank[rank]
                if kind == sr.KIND_SUBJECT:
                    (
                        name,
                        name_cn,
                        styp,
                        plat,
                        date,
                        score,
                        brank,
                        nsfw,
                        wish,
                        done,
                        doing,
                        hold,
                        drop,
                        series,
                        sd,
                        mts,
                        tags,
                        hs,
                        hi,
                    ) = tup
                    if [name, name_cn] != nm[:2]:
                        names_match = False
                        if not first_name_mismatch:
                            first_name_mismatch = str(sid)
                    site_ent_fp.add(
                        [
                            kind,
                            sid,
                            name,
                            name_cn or "",
                            styp,
                            plat,
                            date,
                            score,
                            brank,
                            nsfw,
                            wish,
                            done,
                            doing,
                            hold,
                            drop,
                            series,
                            sd,
                            [vocab["meta_tags"][t] for t in mts],
                            [[vocab["tags"][t], c] for t, c in tags],
                        ]
                    )
                elif kind == sr.KIND_PERSON:
                    (
                        name,
                        ptyp,
                        careers,
                        comments,
                        collects,
                        hs,
                        hi,
                    ) = tup
                    if [name, None] != nm[:2]:
                        names_match = False
                        if not first_name_mismatch:
                            first_name_mismatch = str(sid)
                    site_ent_fp.add(
                        [
                            kind,
                            sid,
                            name,
                            ptyp,
                            [vocab["career"][c] for c in careers],
                            comments,
                            collects,
                        ]
                    )
                else:
                    name, role, comments, collects, hs, hi = tup
                    if [name, None] != nm[:2]:
                        names_match = False
                        if not first_name_mismatch:
                            first_name_mismatch = str(sid)
                    site_ent_fp.add(
                        [kind, sid, name, role, comments, collects]
                    )
                presence[kind_s][sid] = int(hs) | (int(hi) << 1)
                ent_counts[kind] += 1
        check(
            f"entities kind={kind} 二分目录可达",
            range_routes_are_valid(ranges, routed_ids),
        )
        check(
            f"entities kind={kind} 名称与 rank 名称一致",
            names_match,
            first_name_mismatch,
        )
    for kind_name, kind in (("subject", 1), ("person", 2), ("character", 3)):
        reconcile(
            f"实体计数 {kind_name}",
            manifest["counts"]["entities"][kind_name],
            ent_counts[kind],
        )
    reconcile("实体总数 = n_nodes", n, sum(ent_counts.values()))
    check("实体成员硬上限", max(ent_sizes) <= sr.MEMBER_CAP)

    pq_ent_fp = RowFingerprint()
    expected_scores = np.zeros(n, dtype=np.uint8)
    expected_tags = np.zeros(n, dtype=np.uint32)
    tag_counts: Counter[str] = Counter()
    tag_first: dict[str, tuple[int, int]] = {}
    tag_bits = {tag: bit for bit, tag in enumerate(manifest["tags"])}
    subject_columns = [
        "id",
        "name",
        "name_cn",
        "type",
        "platform_code",
        "platform",
        "date",
        "score",
        "rank",
        "nsfw",
        "wish",
        "done",
        "doing",
        "on_hold",
        "dropped",
        "series",
        "score_details",
        "meta_tags",
        "tags",
    ]
    for sub in iter_parquet_dict_batches(
        PARQUET / "subject.parquet", subject_columns
    ):
        for i in range(len(sub["id"])):
            source_id = sub["id"][i]
            rank = int(decoded[sr.KIND_SUBJECT][source_id])
            if rank == sr.RANK_SENTINEL:
                check("subject 几何投影存在于 rank", False, str(source_id))
            else:
                expected_flags[rank] |= np.uint8(
                    int(bool(sub["nsfw"][i])) | (int(sub["type"][i]) << 2)
                )
                score = float(sub["score"][i] or 0)
                expected_scores[rank] = np.uint8(np.round(score * 10))
                mask = 0
                for tag_index, tag in enumerate(sub["meta_tags"][i]):
                    first = (rank, tag_index)
                    tag_first[tag] = min(tag_first.get(tag, first), first)
                    bit = tag_bits.get(tag)
                    if bit is not None:
                        mask |= 1 << bit
                expected_tags[rank] = mask
            tag_counts.update(sub["meta_tags"][i])
            pq_ent_fp.add(
                [
                    1,
                    source_id,
                    sub["name"][i],
                    sub["name_cn"][i],
                    sub["type"][i],
                    sub["platform_code"][i],
                    sub["date"][i],
                    sub["score"][i],
                    sub["rank"][i],
                    int(sub["nsfw"][i]),
                    sub["wish"][i],
                    sub["done"][i],
                    sub["doing"][i],
                    sub["on_hold"][i],
                    sub["dropped"][i],
                    int(sub["series"][i]),
                    sub["score_details"][i],
                    sub["meta_tags"][i],
                    [[t["name"], t["count"]] for t in sub["tags"][i]],
                ]
            )
    for per in iter_parquet_dict_batches(
        PARQUET / "person.parquet",
        ["id", "name", "type", "career", "comments", "collects"],
    ):
        for i in range(len(per["id"])):
            pq_ent_fp.add(
                [
                    2,
                    per["id"][i],
                    per["name"][i],
                    per["type"][i],
                    per["career"][i],
                    per["comments"][i],
                    per["collects"][i],
                ]
            )
    for cha in iter_parquet_dict_batches(
        PARQUET / "character.parquet",
        ["id", "name", "role", "comments", "collects"],
    ):
        for i in range(len(cha["id"])):
            pq_ent_fp.add(
                [
                    3,
                    cha["id"][i],
                    cha["name"][i],
                    cha["role"][i],
                    cha["comments"][i],
                    cha["collects"][i],
                ]
            )
    check(
        "实体结构内容指纹 = parquet",
        site_ent_fp.snapshot() == pq_ent_fp.snapshot(),
    )
    top_tags = sorted(
        tag_counts,
        key=lambda tag: (-tag_counts[tag], tag_first[tag]),
    )[:32]
    reconcile("manifest.tags = parquet", top_tags, manifest["tags"])
    check(
        "flags.bin = parquet + layout",
        np.array_equal(load_array("flags.bin", "u1"), expected_flags),
    )
    check(
        "score.bin = parquet",
        np.array_equal(load_array("score.bin", "u1"), expected_scores),
    )
    check(
        "tags.bin = parquet",
        np.array_equal(load_array("tags.bin", "<u4"), expected_tags),
    )
    del (
        expected_flags,
        expected_scores,
        expected_tags,
    )
    del ent_idx, ent_sizes, pq_ent_fp, site_ent_fp, vocab

    # ---- 文本侧车:非空/空计数、字节数、指纹、存在位 ----
    log("[5] 文本侧车")
    text_idx = load_idx("text.idx")["families"]

    def verify_entity_text(
        family: str,
        column: str,
        bit: int,
        entity_presence: dict[str, np.ndarray],
    ) -> None:
        fam = text_idx[family]
        fp_site = RowFingerprint()
        sizes: list[int] = []
        seen_count = 0
        raw_bytes = 0
        seen_by_kind: dict[str, np.ndarray] = {
            str(kind): np.zeros(
                len(entity_presence[str(kind)]), dtype=np.bool_
            )
            for kind in sr.KINDS
        }
        for kind_s, ranges in fam["ranges"].items():
            routed_ids: list[list[int]] = []
            for start, end, fidx, off, length in ranges:
                sizes.append(length)
                m = load_member(fam["files"][fidx], off, length)
                routed_ids.append(m["i"])
                for sid, text in zip(m["i"], m["t"], strict=True):
                    if (
                        sid < start
                        or sid > end
                        or sid >= len(seen_by_kind[kind_s])
                        or seen_by_kind[kind_s][sid]
                        or not text
                    ):
                        check(f"{family} 身份唯一且非空", False, str(sid))
                        continue
                    seen_by_kind[kind_s][sid] = True
                    fp_site.add([int(kind_s), sid, text])
                    raw_bytes += len(text.encode())
                    seen_count += 1
            check(
                f"{family} kind={kind_s} 二分目录可达",
                range_routes_are_valid(
                    ranges,
                    routed_ids,
                    row_length=5,
                    file_count=len(fam["files"]),
                ),
            )
        fp_pq = RowFingerprint()
        pq_non_empty = 0
        pq_empty = 0
        for kind, table in ((1, "subject"), (2, "person"), (3, "character")):
            for t in iter_parquet_dict_batches(
                PARQUET / f"{table}.parquet", ["id", column]
            ):
                for source_id, text in zip(t["id"], t[column], strict=True):
                    if text:
                        fp_pq.add([kind, source_id, text])
                        pq_non_empty += 1
                    else:
                        pq_empty += 1
                    bits = int(entity_presence[str(kind)][source_id])
                    if ((bits >> bit) & 1) != int(bool(text)):
                        check(
                            f"{family} 存在位一致",
                            False,
                            f"{kind}:{source_id}",
                        )
        check(
            f"{family} 内容指纹 = parquet",
            fp_site.snapshot() == fp_pq.snapshot(),
        )
        reconcile(
            f"{family} 非空计数",
            manifest["counts"]["text"][family]["non_empty"],
            seen_count,
        )
        reconcile(f"{family} 非空计数 = parquet", pq_non_empty, seen_count)
        reconcile(
            f"{family} 空计数",
            manifest["counts"]["text"][family]["empty"],
            pq_empty,
        )
        reconcile(
            f"{family} UTF-8 字节数",
            manifest["text_bytes"][family]["raw"],
            raw_bytes,
        )
        check(f"{family} 成员硬上限", not sizes or max(sizes) <= sr.MEMBER_CAP)
        check(
            f"{family} P99 体验门禁", quantile(sizes, 0.99) <= sr.TEXT_P99_CAP
        )
        reconcile(
            f"{family} 成员大小分布 = manifest",
            manifest["text_layout"][family]["max"],
            max(sizes) if sizes else 0,
        )

    verify_entity_text("entity-summary", "summary", 0, presence)
    verify_entity_text("entity-infobox", "infobox", 1, presence)
    del presence

    # episode-description:识别 (subject, episode) 唯一定位
    fam = text_idx["episode-description"]
    desc_site: set[tuple[int, int]] = set()
    fp_site = RowFingerprint()
    sizes = []
    desc_raw = 0
    desc_routes: list[list[tuple[int, int]]] = []
    for row in fam["ranges"]:
        start, end, fidx, off, length = row[:5]
        sizes.append(length)
        m = load_member(fam["files"][fidx], off, length)
        member_routes: list[tuple[int, int]] = []
        for sid, pairs in zip(m["i"], m["t"], strict=True):
            for epid, text in pairs:
                member_routes.append((sid, epid))
                if (sid, epid) in desc_site or not text:
                    check(
                        "episode-description 身份唯一且非空",
                        False,
                        f"{sid}:{epid}",
                    )
                if len(row) == 7 and not (row[5] <= epid <= row[6]):
                    check("episode-description 分集边界", False, str(epid))
                desc_site.add((sid, epid))
                fp_site.add([sid, epid, text])
                desc_raw += len(text.encode())
        desc_routes.append(member_routes)
    check(
        "episode-description 目录按 subject/episode 可达",
        episode_text_routes_are_valid(
            fam["ranges"], desc_routes, file_count=len(fam["files"])
        ),
    )
    fp_pq = RowFingerprint()
    pq_non_empty = 0
    pq_empty = 0
    for ep_t in iter_parquet_dict_batches(
        PARQUET / "episode.parquet", ["id", "subject_id", "description"]
    ):
        for i in range(len(ep_t["id"])):
            text = ep_t["description"][i]
            if text:
                fp_pq.add([ep_t["subject_id"][i], ep_t["id"][i], text])
                pq_non_empty += 1
            else:
                pq_empty += 1
    check(
        "episode-description 内容指纹 = parquet",
        fp_site.snapshot() == fp_pq.snapshot(),
    )
    reconcile("episode-description 非空计数", pq_non_empty, len(desc_site))
    reconcile(
        "episode-description 空计数",
        manifest["counts"]["text"]["episode-description"]["empty"],
        pq_empty,
    )
    reconcile(
        "episode-description UTF-8 字节数",
        manifest["text_bytes"]["episode-description"]["raw"],
        desc_raw,
    )
    check(
        "episode-description 成员硬上限",
        not sizes or max(sizes) <= sr.MEMBER_CAP,
    )
    check(
        "episode-description P99 体验门禁",
        quantile(sizes, 0.99) <= sr.TEXT_P99_CAP,
    )
    del ep_t, fp_pq, fp_site, sizes

    # fact-summary:当前全空快照必须产生零负载 + 规范空目录
    fam = text_idx["fact-summary"]
    fact_summary: dict[int, str] = {}
    fact_summary_routes: list[list[int]] = []
    for _start, _end, fidx, off, length in fam["ranges"]:
        m = load_member(fam["files"][fidx], off, length)
        fact_summary_routes.append(m["i"])
        for ref, text in zip(m["i"], m["t"], strict=True):
            fact_summary[ref] = text
    check(
        "fact-summary 二分目录可达",
        range_routes_are_valid(
            fam["ranges"],
            fact_summary_routes,
            row_length=5,
            file_count=len(fam["files"]),
        ),
    )
    check(
        "fact-summary 目录与 pack 存在",
        all(site_file(f).exists() for f in fam["files"]),
    )
    voiced_summary_count = 0
    for vo in iter_parquet_dict_batches(
        PARQUET / "voiced.parquet", ["summary"]
    ):
        voiced_summary_count += sum(1 for summary in vo["summary"] if summary)
    reconcile(
        "fact-summary 非空值 = parquet",
        voiced_summary_count,
        len(fact_summary),
    )
    del vo

    # 成员候选索引覆盖 Episode 名称和合同允许全文查询的原文；原始
    # infobox 仍在侧车中，但不得扩大全文索引或进入候选集。
    text_search_dir = load_idx("text.search.members")
    expected_members: list[list[Any]] = []
    expected_counts = np.zeros(sr.SEARCH_NGRAM_BUCKETS, dtype=np.uint32)
    expected_hashes: list[Any | None] = [None] * sr.SEARCH_NGRAM_BUCKETS

    def add_expected_search_member(
        family: str,
        entity_kind: int,
        file_index: int,
        off: int,
        length: int,
        texts: Iterable[str],
    ) -> None:
        member_id = len(expected_members)
        expected_members.append([family, entity_kind, file_index, off, length])
        buckets = {
            expected_search_gram_bucket(
                folded[start : start + sr.SEARCH_NGRAM_WIDTH]
            )
            for text in texts
            for folded in [sr.search_fold(text)]
            for start in range(len(folded) - sr.SEARCH_NGRAM_WIDTH + 1)
        }
        encoded = member_id.to_bytes(3, "little")
        for bucket in buckets:
            expected_counts[bucket] += 1
            digest = expected_hashes[bucket]
            if digest is None:
                digest = hashlib.sha256()
                expected_hashes[bucket] = digest
            digest.update(encoded)

    for _start, _end, off, length in load_idx("episodes.idx")["ranges"]:
        decoded_member = load_member("episodes.pack", off, length)
        episode_rows = []
        for entry in decoded_member["g"]:
            episode_rows.extend(entry["e"])
            for page_off, page_length in entry.get("op", []):
                episode_rows.extend(
                    load_member("pages.pack", page_off, page_length)
                )
        add_expected_search_member(
            "episode-identity",
            0,
            0,
            off,
            length,
            (
                str(name)
                for episode in episode_rows
                for name in episode[1:3]
                if name
            ),
        )

    for family in sr.TEXT_FAMILIES:
        if family == "entity-infobox":
            continue
        definition = text_idx[family]
        routed: list[tuple[int, list[int]]] = []
        if family in ("entity-summary", "entity-infobox"):
            for kind_s, ranges in definition["ranges"].items():
                routed.extend((int(kind_s), row) for row in ranges)
        else:
            routed.extend((0, row) for row in definition["ranges"])
        for entity_kind, row in routed:
            fidx, off, length = row[2:5]
            decoded_member = load_member(
                definition["files"][fidx], off, length
            )
            texts = (
                [
                    text
                    for pairs in decoded_member["t"]
                    for _episode_id, text in pairs
                ]
                if family == "episode-description"
                else decoded_member["t"]
            )
            add_expected_search_member(
                family,
                entity_kind,
                fidx,
                off,
                length,
                texts,
            )
    check(
        "文本候选目录逐成员覆盖全部可搜索原文",
        text_search_dir.get("schema") == "text-search-members-v1"
        and text_search_dir.get("members") == expected_members,
    )

    raw = np.frombuffer(
        site_file("text.search.ngram.idx").read_bytes(), dtype="<u4"
    )
    minimum = sr.SEARCH_NGRAM_BUCKETS + 1
    text_ngram_ok = len(raw) >= minimum
    if text_ngram_ok:
        bucket_members = raw[:minimum]
        member_count = int(bucket_members[-1])
        text_ngram_ok = (
            len(raw) == sr.SEARCH_NGRAM_BUCKETS * 2 + member_count * 3 + 2
        )
    if text_ngram_ok:
        offsets_start = minimum
        first_start = offsets_start + member_count + 1
        last_start = first_start + member_count
        counts_start = last_start + member_count
        offsets = raw[offsets_start:first_start]
        text_first = raw[first_start:last_start]
        text_last = raw[last_start:counts_start]
        text_counts = raw[counts_start:]
        spans = np.diff(offsets.astype(np.int64))
        text_ngram_ok = bool(
            bucket_members[0] == 0
            and np.all(bucket_members[1:] >= bucket_members[:-1])
            and offsets[0] == 0
            and offsets[-1]
            == site_file("text.search.ngram.pack").stat().st_size
            and np.all(spans > 0)
            and np.all(spans <= sr.MEMBER_CAP)
            and np.array_equal(text_counts, expected_counts)
        )
    if text_ngram_ok:
        for bucket in range(sr.SEARCH_NGRAM_BUCKETS):
            start = int(bucket_members[bucket])
            end = int(bucket_members[bucket + 1])
            expected_count = int(expected_counts[bucket])
            if (
                end - start
                != (expected_count + sr.SEARCH_NGRAM_MEMBER_RANKS - 1)
                // sr.SEARCH_NGRAM_MEMBER_RANKS
            ):
                text_ngram_ok = False
                break
            actual_digest = hashlib.sha256()
            decoded_count = 0
            for posting_member in range(start, end):
                posting = load_binary_member(
                    "text.search.ngram.pack",
                    int(offsets[posting_member]),
                    int(spans[posting_member]),
                )
                posting_count = min(
                    sr.SEARCH_NGRAM_MEMBER_RANKS,
                    expected_count - decoded_count,
                )
                ids = decode_delta_posting(
                    posting, posting_count, len(expected_members)
                )
                for identity in ids:
                    actual_digest.update(identity.to_bytes(3, "little"))
                if (
                    not len(ids)
                    or ids[0] != text_first[posting_member]
                    or ids[-1] != text_last[posting_member]
                ):
                    text_ngram_ok = False
                decoded_count += len(ids)
            expected_digest = expected_hashes[bucket]
            if decoded_count != expected_count or actual_digest.digest() != (
                expected_digest.digest()
                if expected_digest is not None
                else hashlib.sha256().digest()
            ):
                text_ngram_ok = False
                break
    check("文本散列候选与全部原文成员等价", text_ngram_ok)

    # ---- 分集结构 ----
    log("[6] 分集结构")
    eps_idx = load_idx("episodes.idx")
    pages_path = "pages.pack"
    site_ep_fp = RowFingerprint()
    ep_rows_seen = 0
    orphan_groups = 0
    eps_sizes: list[int] = []
    seen_sids: set[int] = set()
    episode_routes: list[list[int]] = []
    for start, end, off, length in eps_idx["ranges"]:
        eps_sizes.append(length)
        m = load_member("episodes.pack", off, length)
        episode_routes.append(m["i"])
        for sid, entry in zip(m["i"], m["g"], strict=True):
            if sid < start or sid > end or sid in seen_sids:
                check("episodes 分组键唯一且在范围内", False, str(sid))
            seen_sids.add(sid)
            if (
                sid >= len(decoded[sr.KIND_SUBJECT])
                or decoded[sr.KIND_SUBJECT][sid] == sr.RANK_SENTINEL
            ):
                orphan_groups += 1
            rows = list(entry["e"])
            for poff, plen in entry.get("op", []):
                rows.extend(load_member(pages_path, poff, plen))
            reconcile_ok = len(rows) == entry["n"]
            if not reconcile_ok:
                check("episodes 分页总数 = n", False, str(sid))
            prev_key = None
            for r in rows:
                epid, name, cn, air, disc, dur, sort, typ, hd = r
                if hd != int((sid, epid) in desc_site):
                    check("episodes 描述存在位", False, str(epid))
                site_ep_fp.add(
                    [sid, epid, name, cn, air, disc, dur, sort, typ]
                )
                order_key = (
                    typ,
                    disc,
                    float("inf") if sort is None else sort,
                    epid,
                )
                if prev_key is not None and order_key < prev_key:
                    check("episodes 组内有序", False, str(epid))
                prev_key = order_key
                ep_rows_seen += 1
    check(
        "episodes 二分目录可达",
        range_routes_are_valid(eps_idx["ranges"], episode_routes),
    )
    pq_ep_fp = RowFingerprint()
    episode_subjects = load_array("episode-subject.bin", "<u4")
    episode_index_meta = manifest.get("episode_index", {})
    check(
        "episode_index 版本与文件长度一致",
        episode_index_meta.get("encoding") == "u32le-subject-id"
        and episode_index_meta.get("sentinel") == sr.EPISODE_SUBJECT_SENTINEL
        and episode_index_meta.get("count") == len(episode_subjects),
    )
    episode_index_matches = True
    episode_columns = [
        "id",
        "subject_id",
        "name",
        "name_cn",
        "airdate",
        "disc",
        "duration",
        "sort",
        "type",
    ]
    for ep_full in iter_parquet_dict_batches(
        PARQUET / "episode.parquet", episode_columns
    ):
        for i in range(len(ep_full["id"])):
            episode_id = int(ep_full["id"][i])
            subject_id = int(ep_full["subject_id"][i])
            if (
                episode_id >= len(episode_subjects)
                or int(episode_subjects[episode_id]) != subject_id
            ):
                episode_index_matches = False
            pq_ep_fp.add(
                [
                    ep_full["subject_id"][i],
                    ep_full["id"][i],
                    ep_full["name"][i],
                    ep_full["name_cn"][i],
                    ep_full["airdate"][i],
                    ep_full["disc"][i],
                    ep_full["duration"][i],
                    ep_full["sort"][i],
                    ep_full["type"][i],
                ]
            )
    check(
        "episode-subject.bin = parquet",
        episode_index_matches
        and int(
            np.count_nonzero(episode_subjects != sr.EPISODE_SUBJECT_SENTINEL)
        )
        == ep_rows_seen,
    )
    check(
        "分集内容指纹 = parquet", site_ep_fp.snapshot() == pq_ep_fp.snapshot()
    )
    reconcile("分集行数", manifest["counts"]["episodes"], ep_rows_seen)
    reconcile(
        "孤儿分组数",
        manifest["counts"]["episode_orphan_groups"],
        orphan_groups,
    )
    check("分集成员硬上限", max(eps_sizes) <= sr.MEMBER_CAP)
    del (
        decoded,
        desc_site,
        ep_full,
        episode_subjects,
        eps_idx,
        eps_sizes,
        pq_ep_fp,
        site_ep_fp,
    )

    # ---- 事实:incidence 还原 FactRef、multiplicity 对账 ----
    log("[7] 事实与 incidence")

    def encode_source(
        table: str,
        columns: Sequence[str],
        kind: str,
        row_for_index: Any,
    ) -> Iterator[list[bytes]]:
        for values in iter_parquet_dict_batches(
            PARQUET / f"{table}.parquet", columns
        ):
            yield [
                sr.canonical_fact(kind, *row_for_index(values, i))
                for i in range(len(values[columns[0]]))
            ]

    def encoded_fact_batches() -> Iterator[list[bytes]]:
        yield from encode_source(
            "relates_to",
            ["from_id", "to_id", "relation_type", "sort_order"],
            "RELATES_TO",
            lambda row, i: (
                (
                    sr.entity_key(sr.KIND_SUBJECT, row["from_id"][i]),
                    sr.entity_key(sr.KIND_SUBJECT, row["to_id"][i]),
                ),
                (row["relation_type"][i], row["sort_order"][i]),
            ),
        )
        yield from encode_source(
            "worked_on",
            ["from_id", "to_id", "position", "appear_eps"],
            "WORKED_ON",
            lambda row, i: (
                (
                    sr.entity_key(sr.KIND_PERSON, row["from_id"][i]),
                    sr.entity_key(sr.KIND_SUBJECT, row["to_id"][i]),
                ),
                (row["position"][i], row["appear_eps"][i]),
            ),
        )
        yield from encode_source(
            "appears_in",
            ["from_id", "to_id", "type", "sort_order"],
            "APPEARS_IN",
            lambda row, i: (
                (
                    sr.entity_key(sr.KIND_CHARACTER, row["from_id"][i]),
                    sr.entity_key(sr.KIND_SUBJECT, row["to_id"][i]),
                ),
                (row["type"][i], row["sort_order"][i]),
            ),
        )
        yield from encode_source(
            "voiced",
            ["from_id", "to_id", "subject_id", "type", "summary"],
            "VOICE_CREDIT",
            lambda row, i: (
                (
                    sr.entity_key(sr.KIND_PERSON, row["from_id"][i]),
                    sr.entity_key(sr.KIND_CHARACTER, row["to_id"][i]),
                    sr.entity_key(sr.KIND_SUBJECT, row["subject_id"][i]),
                ),
                (row["type"][i], row["summary"][i]),
            ),
        )
        for table, kind, entity_kind in (
            ("person_rel", "PERSON_REL", sr.KIND_PERSON),
            ("character_rel", "CHARACTER_REL", sr.KIND_CHARACTER),
        ):
            yield from encode_source(
                table,
                ["from_id", "to_id", "relation_type", "spoiler", "ended"],
                kind,
                lambda row, i, entity_kind=entity_kind: (
                    (
                        sr.entity_key(entity_kind, row["from_id"][i]),
                        sr.entity_key(entity_kind, row["to_id"][i]),
                    ),
                    (
                        row["relation_type"][i],
                        int(row["spoiler"][i]),
                        int(row["ended"][i]),
                    ),
                ),
            )

    with tempfile.TemporaryDirectory(
        prefix="bangumi-atlas-verify-facts-"
    ) as temp:
        expected = build_expected_fact_store(
            Path(temp), encoded_fact_batches()
        )
        try:
            n_facts = expected.count
            fact_source_rows = expected.source_rows
            reconcile("事实计数", manifest["counts"]["facts"], n_facts)
            fact_anchors = load_array("fact-anchor.bin", "<u4")
            fact_index_meta = manifest.get("fact_index", {})
            check(
                "fact_index 版本与文件长度一致",
                fact_index_meta.get("encoding") == "u32le-anchor-entity-key"
                and fact_index_meta.get("count") == len(fact_anchors)
                and len(fact_anchors) == n_facts,
            )
            anchors_match = len(fact_anchors) == n_facts
            if anchors_match:
                for ref in range(n_facts):
                    encoded, _multiplicity, _incidence = expected.lookup(ref)
                    participants = orjson.loads(encoded)[1]
                    if not participants or int(fact_anchors[ref]) != int(
                        participants[0]
                    ):
                        anchors_match = False
                        break
            check("fact-anchor.bin = 每条规范事实的首个参与者", anchors_match)
            reconcile(
                "事实源行数",
                manifest["counts"]["fact_source_rows"],
                fact_source_rows,
            )
            reconcile(
                "multiplicity 总和 = 源行数",
                fact_source_rows,
                int(expected.multiplicities.sum(dtype=np.uint64)),
            )

            tag_to_kind = {v: k for k, v in sr.FACT_TAGS.items()}
            facts_idx = load_idx("facts.idx")
            participant_masks = np.zeros(n_facts, dtype=np.uint8)
            n_inc_seen = 0
            fact_sizes: list[int] = []
            ok_incidence = True
            fact_route_keys: list[list[list[int]]] = []
            for bucket_i, members in enumerate(facts_idx["b"]):
                bucket_route_keys: list[list[int]] = []
                for off, length, _last_key in members:
                    fact_sizes.append(length)
                    member = load_member("facts.pack", off, length)
                    parsed_entries = [
                        (canonical_entity_key(key_s), entry)
                        for key_s, entry in member.items()
                    ]
                    bucket_route_keys.append(
                        sorted(key for key, _entry in parsed_entries)
                    )
                    for key, entry in parsed_entries:
                        if key % sr.FACT_BUCKETS != bucket_i:
                            check("事实桶键归属", False, str(key))
                        items: list[tuple[str, list[Any]]] = []
                        for tag, tuples in entry["g"].items():
                            items.extend((tag, t) for t in tuples)
                        for poff, plen in entry.get("op", []):
                            for page_item in load_member(
                                pages_path, poff, plen
                            ):
                                items.append((page_item[0], page_item[1:]))
                        totals = Counter(tag for tag, _ in items)
                        if dict(totals) != entry["n"]:
                            check("事实条目分组计数", False, str(key))
                        for tag, tup in items:
                            f_kind = tag_to_kind[tag]
                            n_inc_seen += 1
                            if not incidence_tuple_is_valid(f_kind, tup):
                                ok_incidence = False
                                continue
                            ref, mult, role_bits, others, *attrs = tup
                            parts = sr.participants_from_incidence(
                                f_kind, key, role_bits, others
                            )
                            if f_kind == "VOICE_CREDIT":
                                text = fact_summary.get(ref, "")
                                if bool(text) != bool(attrs[1]):
                                    ok_incidence = False
                                attrs = [attrs[0], text]
                            enc = sr.canonical_fact(
                                f_kind, parts, tuple(attrs)
                            )
                            if type(ref) is not int or not 0 <= ref < n_facts:
                                ok_incidence = False
                            else:
                                exp_enc, exp_mult, _exp_inc = expected.lookup(
                                    ref
                                )
                                if (
                                    enc != exp_enc
                                    or mult != exp_mult
                                    or not record_fact_participant(
                                        participant_masks, ref, key, parts
                                    )
                                ):
                                    ok_incidence = False
                fact_route_keys.append(bucket_route_keys)
            check(
                "facts 桶与 last_key 路由可达",
                fact_routes_are_valid(
                    facts_idx, fact_route_keys, sr.FACT_BUCKETS
                ),
            )
            check(
                "每条 incidence 还原为同一规范事实与 FactRef",
                ok_incidence,
            )
            check(
                "每个事实在每个参与者下恰好一条 incidence",
                np.array_equal(
                    participant_masks,
                    (1 << expected.incidence_counts) - 1,
                ),
            )
            reconcile(
                "incidence 总数",
                manifest["counts"]["incidence"],
                n_inc_seen,
            )
            check("事实成员硬上限", max(fact_sizes) <= sr.MEMBER_CAP)
        finally:
            expected.close()
    del fact_summary, participant_masks

    # ---- 搜索:自适应前缀树与全量排序一致 ----
    log("[8] 搜索索引")
    charmap = orjson.loads(site_file("charmap.json").read_bytes())
    derived_charmap = expected_charmap()
    check(
        "charmap 与完整 Unicode casefold 契约一致",
        isinstance(charmap, dict)
        and all(
            isinstance(key, str) and len(key) == 1 and isinstance(value, str)
            for key, value in charmap.items()
        )
        and charmap == derived_charmap,
    )
    name_kinds_ok = all(
        len(nm) == 3 and type(nm[2]) is int and nm[2] == int(key_r[rank] >> 24)
        for rank, nm in enumerate(names_by_rank)
    )
    check("名称实体种类与 key.bin 一致", name_kinds_ok)

    expected_alias_rows = [
        [
            [
                list(alias)
                for alias in expected_search_aliases(
                    nm[0], nm[1] or "", derived_charmap
                )
            ],
            nm[1] or nm[0],
            nm[2],
        ]
        for nm in names_by_rank
    ]
    alias_idx = load_array("search.alias.idx", "<u4")
    alias_pack_size = site_file("search.alias.pack").stat().st_size
    alias_blocks = (n + alias_block_size - 1) // alias_block_size
    alias_index_ok = rank_block_index_is_valid(
        alias_idx,
        n_rows=n,
        block_size=alias_block_size,
        pack_size=alias_pack_size,
    )
    if alias_index_ok:
        for block in range(alias_blocks):
            off = int(alias_idx[block])
            end = int(alias_idx[block + 1])
            rows = load_member("search.alias.pack", off, end - off)
            start_rank = block * alias_block_size
            expected_count = min(
                alias_block_size,
                n - start_rank,
            )
            expected_rows = expected_alias_rows[
                start_rank : start_rank + expected_count
            ]
            if (
                not isinstance(rows, list)
                or len(rows) != expected_count
                or not all(search_alias_row_is_valid(row) for row in rows)
                or rows != expected_rows
            ):
                alias_index_ok = False
                break
    check(
        "搜索别名块完整覆盖全部 rank",
        alias_index_ok,
    )

    search_dir = orjson.loads(site_file("search.idx.json").read_bytes())
    if not isinstance(search_dir, dict):
        raise ValueError("search.idx.json must be an object")

    leaf_expected: dict[str, OrderedRows] = {}
    exact_expected: dict[str, OrderedRows] = {}
    top_expected: dict[str, OrderedRows] = {}
    exact_ranks: dict[str, set[int]] = defaultdict(set)
    for row in iter_alias_entries(expected_alias_rows):
        normalized, _matched, rank, _display, _kind = row
        prefix = ""
        for char in normalized:
            prefix += char
            node = search_dir.get(prefix)
            if not isinstance(node, dict) or set(node) == {"l"}:
                break
            if normalized == prefix:
                exact_ranks[prefix].add(rank)
                break

    exact_seen: dict[str, set[int]] = defaultdict(set)
    top_seen: dict[str, set[int]] = defaultdict(set)
    ok_search = True
    for row in iter_alias_entries(expected_alias_rows):
        normalized = row[0]
        prefix = ""
        terminal = False
        for char in normalized:
            prefix += char
            node = search_dir.get(prefix)
            if not isinstance(node, dict):
                ok_search = False
                break
            if set(node) == {"l"}:
                add_ordered_row(leaf_expected, prefix, row)
                terminal = True
                break
            if set(node) != {"t"}:
                ok_search = False
                break
            if normalized == prefix:
                if row[2] not in exact_seen[prefix]:
                    add_ordered_row(exact_expected, prefix, row)
                    exact_seen[prefix].add(row[2])
                terminal = True
                break
            if (
                row[2] not in exact_ranks[prefix]
                and row[2] not in top_seen[prefix]
                and len(top_seen[prefix]) < sr.SEARCH_TOP
            ):
                add_ordered_row(top_expected, prefix, row)
                top_seen[prefix].add(row[2])
        if not terminal:
            ok_search = False

    def valid_search_row(
        row: Any, prefix: str, aliases_by_rank: list[list[Any]]
    ) -> bool:
        if (
            not isinstance(row, list)
            or len(row) != 5
            or not isinstance(row[0], str)
            or not row[0].startswith(prefix)
            or not isinstance(row[1], str)
            or type(row[2]) is not int
            or not 0 <= row[2] < len(aliases_by_rank)
            or not isinstance(row[3], str)
            or type(row[4]) is not int
        ):
            return False
        aliases, display, entity_kind = aliases_by_rank[row[2]]
        return (
            [row[0], row[1]] in aliases
            and row[3] == display
            and row[4] == entity_kind
        )

    leaf_max = 0
    for prefix, node in search_dir.items():
        if not isinstance(prefix, str) or not isinstance(node, dict):
            ok_search = False
            continue
        if set(node) == {"l"}:
            location = node["l"]
            expected_rows = leaf_expected.get(prefix)
            is_leaf = True
        else:
            if set(node) != {"t"}:
                ok_search = False
                continue
            location = node["t"]
            expected_rows = None
            is_leaf = False
        if (
            not isinstance(location, list)
            or len(location) != 2
            or any(type(value) is not int for value in location)
        ):
            ok_search = False
            continue
        if is_leaf:
            leaf_max = max(leaf_max, location[1])
        got = load_member("search.pack", *location)
        if not isinstance(got, list) or not all(
            valid_search_row(row, prefix, expected_alias_rows) for row in got
        ):
            ok_search = False
            continue
        if expected_rows is not None:
            if rows_snapshot(got) != expected_rows.snapshot():
                ok_search = False
            continue
        split = 0
        while split < len(got) and got[split][0] == prefix:
            split += 1
        if any(row[0] == prefix for row in got[split:]):
            ok_search = False
        exact_snapshot = exact_expected.get(prefix)
        top_snapshot = top_expected.get(prefix)
        if rows_snapshot(got[:split]) != (
            exact_snapshot.snapshot() if exact_snapshot else EMPTY_ROWS
        ) or rows_snapshot(got[split:]) != (
            top_snapshot.snapshot() if top_snapshot else EMPTY_ROWS
        ):
            ok_search = False
    check(
        f"搜索叶、全部精确项与额外 top-{sr.SEARCH_TOP} 建议一致",
        ok_search,
    )
    check(
        "搜索叶成员 <= 64,000",
        leaf_max <= sr.SEARCH_LEAF_CAP,
        f"max {leaf_max:,}",
    )

    # 每个散列桶由一个或多个有界 gzip 成员组成。索引声明桶的成员
    # 范围、成员字节边界与首尾 rank，以及解压后的 posting 数。
    ngram_index_raw = site_file("search.ngram.idx").read_bytes()
    ngram_index = np.frombuffer(ngram_index_raw, dtype="<u4")
    ngram_path = site_file("search.ngram.pack")
    ngram_size = ngram_path.stat().st_size
    minimum_index_length = sr.SEARCH_NGRAM_BUCKETS + 1
    index_shape_ok = len(ngram_index) >= minimum_index_length
    if index_shape_ok:
        bucket_members = ngram_index[:minimum_index_length]
        n_members = int(bucket_members[-1])
        expected_index_length = sr.SEARCH_NGRAM_BUCKETS * 2 + n_members * 3 + 2
        index_shape_ok = len(ngram_index) == expected_index_length
    if index_shape_ok:
        offsets_start = minimum_index_length
        first_start = offsets_start + n_members + 1
        last_start = first_start + n_members
        counts_start = last_start + n_members
        member_offsets = ngram_index[offsets_start:first_start]
        member_first = ngram_index[first_start:last_start]
        member_last = ngram_index[last_start:counts_start]
        counts = ngram_index[counts_start:]
        spans = np.diff(member_offsets.astype(np.int64))
        index_shape_ok = bool(
            bucket_members[0] == 0
            and np.all(bucket_members[1:] >= bucket_members[:-1])
            and bucket_members[-1] == n_members
            and member_offsets[0] == 0
            and member_offsets[-1] == ngram_size
            and np.all(spans > 0)
            and np.all(spans <= sr.MEMBER_CAP)
            and np.all(member_first <= member_last)
            and (not n_members or member_last.max() < n)
        )
        if index_shape_ok:
            for bucket in range(sr.SEARCH_NGRAM_BUCKETS):
                start = int(bucket_members[bucket])
                end = int(bucket_members[bucket + 1])
                count = int(counts[bucket])
                expected_member_pages = (
                    count + sr.SEARCH_NGRAM_MEMBER_RANKS - 1
                ) // sr.SEARCH_NGRAM_MEMBER_RANKS
                if end - start != expected_member_pages or (
                    end - start > 1
                    and np.any(
                        member_last[start : end - 1]
                        >= member_first[start + 1 : end]
                    )
                ):
                    index_shape_ok = False
                    break
    check("子串索引偏移和计数覆盖全部 gzip 成员", index_shape_ok)
    check(
        "search.ngram.pack <= 80MB pack 上限",
        ngram_size <= sr.PACK_CAP,
        f"{ngram_size:,}",
    )
    if index_shape_ok:
        expected_counts = np.zeros(sr.SEARCH_NGRAM_BUCKETS, dtype=np.uint32)
        expected_rank_hashes: list[Any | None] = [None] * (
            sr.SEARCH_NGRAM_BUCKETS
        )
        for rank, (aliases, _display, _entity_kind) in enumerate(
            expected_alias_rows
        ):
            rank_buckets = {
                expected_search_gram_bucket(
                    normalized[start : start + sr.SEARCH_NGRAM_WIDTH]
                )
                for normalized, _matched in aliases
                for start in range(len(normalized) - sr.SEARCH_NGRAM_WIDTH + 1)
            }
            encoded = rank.to_bytes(3, "little")
            for bucket in rank_buckets:
                expected_counts[bucket] += 1
                digest = expected_rank_hashes[bucket]
                if digest is None:
                    digest = hashlib.sha256()
                    expected_rank_hashes[bucket] = digest
                digest.update(encoded)

        ngram_ok = True
        actual_count = 0
        for bucket in range(sr.SEARCH_NGRAM_BUCKETS):
            member_start = int(bucket_members[bucket])
            member_end = int(bucket_members[bucket + 1])
            count = int(counts[bucket])
            expected_count = int(expected_counts[bucket])
            actual_count += count
            digest = expected_rank_hashes[bucket]
            expected_digest = (
                digest.digest()
                if digest is not None
                else hashlib.sha256().digest()
            )
            if count == 0:
                if expected_count != 0:
                    ngram_ok = False
                continue
            actual_digest = hashlib.sha256()
            decoded_count = 0
            for member in range(member_start, member_end):
                posting_bytes = load_binary_member(
                    "search.ngram.pack",
                    int(member_offsets[member]),
                    int(spans[member]),
                )
                actual_digest.update(posting_bytes)
                raw_ranks = np.frombuffer(posting_bytes, dtype=np.uint8)
                member_count = min(
                    sr.SEARCH_NGRAM_MEMBER_RANKS,
                    count - decoded_count,
                )
                decoded_ok = len(raw_ranks) == member_count * 3
                if decoded_ok:
                    actual_ranks = (
                        raw_ranks[0::3].astype(np.uint32)
                        | (raw_ranks[1::3].astype(np.uint32) << 8)
                        | (raw_ranks[2::3].astype(np.uint32) << 16)
                    )
                    decoded_ok = bool(
                        len(actual_ranks)
                        and actual_ranks[0] == member_first[member]
                        and actual_ranks[-1] == member_last[member]
                        and actual_ranks[-1] < n
                        and np.all(actual_ranks[1:] > actual_ranks[:-1])
                    )
                if not decoded_ok:
                    ngram_ok = False
                decoded_count += member_count
            if (
                decoded_count != count
                or count != expected_count
                or actual_digest.digest() != expected_digest
            ):
                ngram_ok = False
        check(
            "子串散列桶与全部规范化名称一致",
            ngram_ok,
            f"postings {actual_count:,}",
        )
    del charmap, key_r, names_by_rank, search_dir

    for logical_name, (
        size,
        _digest,
        _physical_name,
    ) in artifact_files.items():
        if not logical_name.endswith(".pack"):
            continue
        cursor = 0
        contiguous = True
        for off, length in sorted(member_spans.get(logical_name, set())):
            if off != cursor or length <= 0:
                contiguous = False
                break
            cursor += length
        check(
            f"{logical_name} 成员边界完整覆盖 pack",
            contiguous and cursor == size,
            f"covered {cursor:,} / {size:,}",
        )

    # ---- 显示映射 ----
    log("[9] 显示映射")
    mappings = orjson.loads(site_file("mappings.json").read_bytes())
    reconcile(
        "mappings.json 摘要",
        manifest["mapping_digests"]["mappings.json"],
        sr.sha256_hex(sr.canonical_json(mappings)),
    )
    for kind_name, table, code_col, name_col in (
        ("RELATES_TO", "relates_to", "relation_type", "relation"),
        ("WORKED_ON", "worked_on", "position", "position_cn"),
        ("APPEARS_IN", "appears_in", "type", "role_cn"),
        ("PERSON_REL", "person_rel", "relation_type", "relation"),
        ("CHARACTER_REL", "character_rel", "relation_type", "relation"),
    ):
        table_map = mappings["fact_labels"][kind_name]
        ok_map = True
        for mapping_batch in iter_parquet_dict_batches(
            PARQUET / f"{table}.parquet", [code_col, name_col]
        ):
            if not all(
                (not name and str(code) not in table_map)
                or table_map.get(str(code)) == name
                for code, name in zip(
                    mapping_batch[code_col],
                    mapping_batch[name_col],
                    strict=True,
                )
            ):
                ok_map = False
                break
        check(f"mappings.{kind_name} 与 parquet 解码一致", ok_map)
    *_, voice_roles = load_mappings(MAPPING_SNAPSHOT)
    expected_voice_labels = {
        str(code): str(definition["cn"])
        for code, definition in sorted(voice_roles.items())
        if isinstance(definition, dict) and definition.get("cn")
    }
    reconcile(
        "mappings.VOICE_CREDIT 与固定枚举快照一致",
        mappings["fact_labels"].get("VOICE_CREDIT"),
        expected_voice_labels,
    )
    reconcile(
        "mappings.episode_type 与 Bangumi EpType 一致",
        mappings.get("episode_type"),
        EPISODE_TYPE_NAMES,
    )
    expected_subject_types: dict[str, str] = {}
    expected_platforms: dict[str, str] = {}
    mapping_conflict = False
    for mapping_batch in iter_parquet_dict_batches(
        PARQUET / "subject.parquet",
        ["type", "type_name", "platform_code", "platform"],
    ):
        for subject_type, type_name, platform_code, platform in zip(
            mapping_batch["type"],
            mapping_batch["type_name"],
            mapping_batch["platform_code"],
            mapping_batch["platform"],
            strict=True,
        ):
            type_key = str(subject_type)
            if type_key in expected_subject_types:
                mapping_conflict |= (
                    expected_subject_types[type_key] != type_name
                )
            else:
                expected_subject_types[type_key] = type_name
            if platform_code is None or not platform:
                continue
            platform_key = f"{subject_type}:{platform_code}"
            if platform_key in expected_platforms:
                mapping_conflict |= (
                    expected_platforms[platform_key] != platform
                )
            else:
                expected_platforms[platform_key] = platform
    check("作品类型与平台解码无冲突", not mapping_conflict)
    reconcile(
        "mappings.subject_type 与 parquet 解码一致",
        mappings.get("subject_type"),
        expected_subject_types,
    )
    reconcile(
        "mappings.platform 与 parquet 解码一致",
        mappings.get("platform"),
        dict(sorted(expected_platforms.items())),
    )
    reconcile(
        "mappings.person_type 与公开人物类型一致",
        mappings.get("person_type"),
        PERSON_TYPE_NAMES,
    )
    reconcile(
        "mappings.character_role 与公开角色定位一致",
        mappings.get("character_role"),
        CHARACTER_ROLE_NAMES,
    )
    person_codes = {
        str(value)
        for batch in iter_parquet_dict_batches(
            PARQUET / "person.parquet", ["type"]
        )
        for value in batch["type"]
    }
    character_codes = {
        str(value)
        for batch in iter_parquet_dict_batches(
            PARQUET / "character.parquet", ["role"]
        )
        for value in batch["role"]
    }
    check(
        "发布人物类型只有官方值或已知零哨兵",
        person_codes <= {*PERSON_TYPE_NAMES, "0"},
        f"codes {sorted(person_codes)}",
    )
    check(
        "发布角色定位均有领域名称",
        character_codes <= CHARACTER_ROLE_NAMES.keys(),
        f"codes {sorted(character_codes)}",
    )

    elapsed = time.time() - t0
    if failures:
        log(
            f"FAILED: {len(failures)} 处不符 ({elapsed:,.0f}s): "
            f"{failures[:10]}"
        )
        sys.exit(1)
    log(f"verify_site: all checks passed in {elapsed:,.0f}s")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--site",
        type=Path,
        default=SITE_ROOT,
        help="staging site root (default: site)",
    )
    args = parser.parse_args()
    site_root = args.site.resolve()
    with parquet_layout_lock(PARQUET):
        input_identity = require_current_release_inputs(
            dump=DUMP,
            dump_zip=DUMP_ZIP,
            mappings=MAPPING_SNAPSHOT,
            parquet=PARQUET,
            layout_dir=LAYOUT_DIR,
            shape_digest=shape_digest(),
        )
        verify_release(site_root, input_identity)


if __name__ == "__main__":
    main()
