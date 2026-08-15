"""Bake the structural SiteRelease from parquet + layout.

契约见 docs/STRUCTURAL_SITE_DATA_DESIGN.md 与 scripts/site_release.py。

产物:site/data/ 下 manifest.json、几何 SoA bins、rank-by-key.bin、
names pack(2,048 rank/成员)、entities/facts/episodes pack(词表、
FactRef incidence、存在位)、四类长文本侧车 + text.idx、自适应前缀
搜索与二元字符子串候选、vocab、mappings.json、pages.pack、骨架边、标签表。
纪律:失败与截断显式报出、行级对账,对不上非零退出;
成员超过压缩或解压硬上限时在稳定身份边界自动细分,门禁失败即终止。
"""

import argparse
import gzip
import hashlib
import heapq
import math
import os
import re
import shutil
import sys
import tempfile
import time
from array import array
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, BinaryIO, cast

import numpy as np
import orjson
import pyarrow.compute as pc
import pyarrow.parquet as pq

from . import site_release as sr
from .build_lock import parquet_layout_lock
from .community_labels import build_community_labels
from .enum_mappings import load_mappings
from .layout import shape_digest
from .position_encoding import decode_positions, quantize_positions
from .query_contracts import (
    load_query_contract,
    query_schema_digest,
    validate_query_contract,
)
from .site_contracts import (
    require_current_release_inputs,
    validate_layout_report,
    validate_name_pack,
)
from .world_scale import (
    CANONICAL_WORLD_SPAN,
    MIN_NODE_CENTER_DISTANCE,
    find_minimum_distance_violation,
    normalize_world_scale,
    separate_published_nodes,
)

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "data" / "dump"
PARQUET = ROOT / "data" / "parquet"
LAYOUT_DIR = ROOT / "data" / "layout"
LAYOUT = LAYOUT_DIR / "coords.parquet"
LAYOUT_REPORT = LAYOUT_DIR / "report.json"
DUMP_ZIP = ROOT / "data" / "dump.zip"
SITE = ROOT / "site" / "data"
MAPPING_SNAPSHOT = ROOT / "data" / "mappings"

SKELETON_TARGET = 500_000  # 传输目标;连通节点覆盖优先,超限显式报出
LABELS_TOP = 20_000
SIZE_BUDGET = 1_000_000_000  # GH Pages 1GB 硬限(发布门禁按 site/ 全量)
SIZE_WARN = 900_000_000
FILE_BUDGET = 20_000  # CF Pages 迁移预案的文件数上限
FACT_BATCH_ROWS = 100_000
INCIDENCE_SHARDS = 64
SUBJECT_DATE_CODE_PATH = "subject-date-code.bin"
SUBJECT_DATE_DICTIONARY_PATH = "subject-date-dictionary.json.gz"
SUBJECT_BGM_RANK_PATH = "subject-bgm-rank.bin"

# 人物类型与角色分类没有上游映射文件;这是站点显示映射的权威声明,
# 参与 mappings.json 摘要。未覆盖的原始码由客户端按数值显示。
PERSON_TYPE_NAMES = {1: "个人", 2: "公司", 3: "组合"}
CHARACTER_ROLE_NAMES = {1: "角色", 2: "机体", 3: "舰船", 4: "组织"}
# Bangumi API EpType: MainStory, SP, OP, ED, PV, MAD, Other.
EPISODE_TYPE_NAMES = {
    0: "本篇",
    1: "特别篇",
    2: "OP",
    3: "ED",
    4: "预告/宣传/广告",
    5: "MAD",
    6: "其他",
}

failures: list[str] = []

type FactRow = tuple[tuple[int, ...], tuple[Any, ...]]
type RankLookup = dict[int, np.ndarray]
type IncidenceEntry = tuple[int, str, list[Any]]
type SearchEntry = tuple[str, str, int, str, int]


@dataclass(frozen=True, slots=True)
class SubjectSourceQueryColumns:
    """Lossless Subject query scalars aligned by archive source id."""

    date_dictionary: list[str]
    date_codes: np.ndarray
    ranks: np.ndarray


def log(msg: str) -> None:
    print(msg, flush=True)


def reconcile(label: str, expected: int, actual: int) -> None:
    ok = expected == actual
    if not ok:
        failures.append(label)
    log(
        f"  {'ok' if ok else 'MISMATCH':8s} {label}: "
        f"expected {expected:,}, got {actual:,}"
    )


def jdump(obj: Any) -> bytes:
    return sr.canonical_json(obj)


def write_gzip_json(
    name: str,
    obj: Any,
    level: int,
    *,
    cap: int = sr.MEMBER_CAP,
) -> None:
    member = sr.gzip_member(obj, level)
    sr.require_member_size(member, name, cap=cap)
    (SITE / name).write_bytes(member)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def publish_manifest(
    manifest: dict[str, Any],
    *,
    total_bytes: int,
    core_bytes: int,
    n_files: int,
    started: float,
) -> None:
    """Publish the release marker only after every gate has passed."""

    if total_bytes > SIZE_BUDGET:
        failures.append("站点数据超 GH Pages 1GB 硬限")
    elif total_bytes > SIZE_WARN:
        log(f"WARNING: 站点数据 {total_bytes / 1e6:,.0f}MB 接近 1GB 门禁")
    if n_files > FILE_BUDGET:
        log(f"WARNING: 文件数 {n_files:,} 超 CF Pages 2 万限")
    if failures:
        sys.exit(f"FAILED: {len(failures)} 处对账不符: {failures}")

    staging = SITE / ".manifest.json.build"
    staging.unlink(missing_ok=True)
    try:
        staging.write_bytes(jdump(manifest))
        staging.replace(SITE / "manifest.json")
    finally:
        staging.unlink(missing_ok=True)
    log(
        f"manifest 写出;数据合计 {total_bytes / 1e6:,.0f} MB"
        f"(core {core_bytes / 1e6:,.0f} MB),{n_files:,} 个文件;"
        f"总耗时 {time.time() - started:,.0f}s"
    )


def validate_output_directory(output: Path) -> Path:
    """Resolve only the release directory or managed temporary outputs."""

    if output.is_symlink() or output.parent.is_symlink():
        raise ValueError(f"output must not traverse a symlink: {output}")
    resolved = output.resolve()
    default_path = ROOT / "site" / "data"
    default = default_path.resolve()
    if resolved == default:
        if default_path.is_symlink() or default_path.parent.is_symlink():
            raise ValueError("project site/data must not be a symlink")
        return resolved

    temporary_roots = [Path(tempfile.gettempdir()).resolve()]
    if runner_temp := os.environ.get("RUNNER_TEMP"):
        temporary_roots.append(Path(runner_temp).resolve())
    in_managed_root = any(
        resolved.is_relative_to(root) and resolved.parent != root
        for root in temporary_roots
    )
    if resolved.name != "data" or not in_managed_root:
        raise ValueError(
            "output must be project site/data or */data below a managed "
            "temporary root; "
            f"refusing recursive cleanup of {resolved}"
        )
    return resolved


def validate_release_capacity(node_count: int) -> None:
    if type(node_count) is not int or node_count < 0:
        raise ValueError("node count must be a non-negative integer")
    if node_count >= 1 << 21:
        raise ValueError("edge deduplication requires node count < 2^21")
    if node_count >= sr.RANK_SENTINEL:
        raise ValueError(
            "VisualRank reached its u24 sentinel; upgrade the rank format"
        )


def validate_media_flag_values(values: np.ndarray) -> None:
    media = np.asarray(values)
    if media.ndim != 1 or media.dtype.kind not in "iu":
        raise ValueError(
            "media flag values must be a one-dimensional integer array"
        )
    if len(media) and (int(media.min()) < 0 or int(media.max()) >= 8):
        raise ValueError("media exceeds the three published flags bits")


def subject_query_year(value: Any) -> int:
    """Encode Subject.date with the browser query's exact year semantics."""

    if not isinstance(value, str):
        return 0
    match = re.match(r"^([0-9]{4})(?:-|$)", value)
    if match is None:
        return 0
    year = int(match.group(1))
    if year == 0:
        raise ValueError(
            "Subject query year 0000 conflicts with the null sentinel"
        )
    return year


def subject_query_score(value: Any) -> int:
    """Encode only scores that the u8 query column can reproduce exactly."""

    if value is None or value == 0:
        return 0
    score = float(value)
    scaled = score * 10
    if not math.isfinite(scaled):
        raise ValueError(
            f"Subject score {value!r} cannot be represented losslessly as u8"
        )
    encoded = round(scaled)
    if encoded < 0 or encoded > 255 or encoded / 10 != score:
        raise ValueError(
            f"Subject score {value!r} cannot be represented losslessly as u8"
        )
    return encoded


def build_subject_source_query_columns(
    *,
    source_ids: Sequence[Any],
    dates: Sequence[Any],
    ranks: Sequence[Any],
    source_count: int,
) -> SubjectSourceQueryColumns:
    """Encode exact date/rank values without materializing entity tuples."""

    if (
        not isinstance(source_count, int)
        or isinstance(source_count, bool)
        or source_count < 0
    ):
        raise ValueError("Subject query source id count is invalid")
    if len(source_ids) != len(dates) or len(source_ids) != len(ranks):
        raise ValueError("Subject query source columns have different lengths")

    seen = np.zeros(source_count, dtype=np.bool_)
    date_values: list[str] = []
    encoded_ranks = np.zeros(source_count, dtype="<u2")
    normalized_ids: list[int] = []
    for raw_id, raw_date, raw_rank in zip(
        source_ids, dates, ranks, strict=True
    ):
        if not isinstance(raw_id, (int, np.integer)) or isinstance(
            raw_id, (bool, np.bool_)
        ):
            raise ValueError(f"Subject query source id {raw_id!r} is invalid")
        source_id = int(raw_id)
        if source_id < 0 or source_id >= source_count:
            raise ValueError(
                f"Subject query source id {source_id} is out of range"
            )
        if seen[source_id]:
            raise ValueError(f"duplicate Subject query source id {source_id}")
        seen[source_id] = True
        normalized_ids.append(source_id)

        if raw_date is None:
            date_values.append("")
        elif isinstance(raw_date, str):
            date_values.append(raw_date)
        else:
            raise ValueError(
                f"Subject date {raw_date!r} cannot be represented losslessly"
            )

        if raw_rank is None:
            encoded_rank = 0
        elif (
            isinstance(raw_rank, (int, np.integer))
            and not isinstance(raw_rank, (bool, np.bool_))
            and 0 <= int(raw_rank) <= np.iinfo(np.uint16).max
        ):
            encoded_rank = int(raw_rank)
        else:
            raise ValueError(
                f"Subject rank {raw_rank!r} cannot be represented losslessly"
            )
        encoded_ranks[source_id] = encoded_rank

    date_dictionary = sorted(
        set(date_values), key=lambda value: value.encode("utf-8")
    )
    if len(date_dictionary) > np.iinfo(np.uint16).max + 1:
        raise ValueError("Subject date dictionary exceeds u16 capacity")
    code_by_date = {value: code for code, value in enumerate(date_dictionary)}
    date_codes = np.zeros(source_count, dtype="<u2")
    for source_id, value in zip(normalized_ids, date_values, strict=True):
        date_codes[source_id] = code_by_date[value]

    return SubjectSourceQueryColumns(
        date_dictionary=date_dictionary,
        date_codes=date_codes,
        ranks=encoded_ranks,
    )


def quantiles(sizes: list[int]) -> dict[str, int]:
    if not sizes:
        return {"p50": 0, "p90": 0, "p99": 0, "max": 0, "members": 0}
    arr = np.sort(np.asarray(sizes))
    pick = lambda q: int(arr[min(len(arr) - 1, int(q * len(arr)))])  # noqa: E731
    return {
        "p50": pick(0.50),
        "p90": pick(0.90),
        "p99": pick(0.99),
        "max": int(arr[-1]),
        "members": len(arr),
    }


def build_episode_subject_index(
    episode_ids: Sequence[Any], subject_ids: Sequence[Any]
) -> np.ndarray:
    """Build the dense EpisodeId -> Subject source-id point index."""
    if len(episode_ids) != len(subject_ids):
        raise ValueError("episode and subject columns have different lengths")
    if not episode_ids:
        return np.empty(0, dtype="<u4")
    maximum = max(int(value) for value in episode_ids)
    if maximum < 0 or maximum >= sr.EPISODE_SUBJECT_SENTINEL:
        raise ValueError("episode id exceeds u32 index capacity")
    result = np.full(
        maximum + 1,
        sr.EPISODE_SUBJECT_SENTINEL,
        dtype="<u4",
    )
    for episode_id, subject_id in zip(episode_ids, subject_ids, strict=True):
        eid = int(episode_id)
        sid = int(subject_id)
        if eid < 0 or sid < 0 or sid > sr.MAX_SOURCE_ID:
            raise ValueError("episode index contains an out-of-range identity")
        if result[eid] != sr.EPISODE_SUBJECT_SENTINEL:
            raise ValueError(f"duplicate episode id {eid}")
        result[eid] = sid
    return result


class PackFile:
    """单文件 pack:独立 gzip 成员连续写入,返回 [offset, length]。"""

    def __init__(self, name: str) -> None:
        self.name = name
        self.path = SITE / name
        self.size = 0
        self.sizes: list[int] = []
        self._writer: BinaryIO | None = open(  # noqa: SIM115
            self.path, "wb", buffering=0
        )

    def add(self, gz: bytes) -> list[int]:
        sr.require_member_size(gz, self.name)
        if self._writer is None:
            raise RuntimeError(f"{self.name} is already closed")
        off = self.size
        self._writer.write(gz)
        self.size += len(gz)
        self.sizes.append(len(gz))
        return [off, len(gz)]

    def add_json(self, obj: Any, level: int) -> list[int]:
        return self.add(sr.gzip_member(obj, level))

    def write(self) -> None:
        if self._writer is not None:
            self._writer.close()
            self._writer = None
        if self.size > sr.PACK_CAP:
            failures.append(f"{self.name} 超过单 pack 80MB 上限")

    def discard(self) -> None:
        if self._writer is not None:
            self._writer.close()
            self._writer = None
        self.path.unlink(missing_ok=True)


class RolloverPack:
    """跨文件 pack 序列:在成员边界滚动到下一文件,单文件 <= 80MB。

    即使没有任何成员也写出一个零长度文件——某类文本全空时以
    规范空目录 + 零长度 pack 表达,不能靠缺文件表达“没有内容”。
    """

    def __init__(self, stem: str) -> None:
        self.stem = stem
        self.file_sizes = [0]
        self.sizes: list[int] = []
        self._writer: BinaryIO | None = open(  # noqa: SIM115
            SITE / self.files[0], "wb", buffering=0
        )

    def add(self, gz: bytes) -> list[int]:
        sr.require_member_size(gz, self.stem)
        if self._writer is None:
            raise RuntimeError(f"{self.stem} is already closed")
        if self.file_sizes[-1] + len(gz) > sr.PACK_CAP:
            self._writer.close()
            self.file_sizes.append(0)
            self._writer = open(  # noqa: SIM115
                SITE / self.files[-1], "wb", buffering=0
            )
        file_idx = len(self.file_sizes) - 1
        off = self.file_sizes[file_idx]
        self._writer.write(gz)
        self.file_sizes[file_idx] += len(gz)
        self.sizes.append(len(gz))
        return [file_idx, off, len(gz)]

    @property
    def files(self) -> list[str]:
        return [f"{self.stem}-{i}.pack" for i in range(len(self.file_sizes))]

    def write(self) -> None:
        if self._writer is not None:
            self._writer.close()
            self._writer = None


def emit_ranged(
    pack: PackFile | RolloverPack,
    items: list[tuple[int, Any]],
    width: int,
    level: int,
    encode: Callable[[list[tuple[int, Any]]], Any],
    on_member: (
        Callable[[list[int], list[tuple[int, Any]]], None] | None
    ) = None,
) -> list[list[int]]:
    """按身份窗口切成员;成员超 256,000 字节时按身份中点递归细分。

    items 按身份升序;返回 [start, end, *loc] 目录行(闭区间)。
    单条身份仍超限时抛错——必须升级 profile,不能截断。
    """
    ranges: list[list[int]] = []

    def emit(chunk: list[tuple[int, Any]]) -> None:
        gz = sr.gzip_member(encode(chunk), level)
        if not sr.member_fits(gz):
            if len(chunk) == 1:
                raise ValueError(
                    f"single identity {chunk[0][0]} exceeds member cap; "
                    "upgrade the profile instead of truncating"
                )
            mid = len(chunk) // 2
            emit(chunk[:mid])
            emit(chunk[mid:])
            return
        loc = pack.add(gz)
        if on_member is not None:
            on_member(loc, chunk)
        ranges.append([chunk[0][0], chunk[-1][0], *loc])

    start = 0
    while start < len(items):
        window = items[start][0] // width
        end = start
        while end < len(items) and items[end][0] // width == window:
            end += 1
        emit(items[start:end])
        start = end
    return ranges


def emit_sorted_entity_parquet(
    pack: PackFile,
    parquet: Path,
    columns: list[str],
    *,
    width: int,
    level: int,
    row_for_index: Callable[[dict[str, list[Any]], int, int], Any],
    batch_size: int = 65_536,
) -> tuple[list[list[int]], int]:
    """Stream an ID-sorted entity table, retaining one ID window."""
    ranges: list[list[int]] = []
    items: list[tuple[int, Any]] = []
    current_window: int | None = None
    previous_id = -1
    row_offset = 0

    def encode_rows(chunk: list[tuple[int, Any]]) -> Any:
        return {
            "i": [item[0] for item in chunk],
            "r": [item[1] for item in chunk],
        }

    def flush() -> None:
        nonlocal items
        if items:
            ranges.extend(emit_ranged(pack, items, width, level, encode_rows))
            items = []

    parquet_file = pq.ParquetFile(parquet)
    for batch in parquet_file.iter_batches(
        batch_size=batch_size, columns=columns
    ):
        values = batch.to_pydict()
        for index, raw_id in enumerate(values["id"]):
            source_id = int(raw_id)
            if source_id < previous_id:
                raise ValueError(f"{parquet.name} must be sorted by id")
            previous_id = source_id
            window = source_id // width
            if current_window is None:
                current_window = window
            elif window != current_window:
                flush()
                current_window = window
            items.append(
                (
                    source_id,
                    row_for_index(values, index, row_offset + index),
                )
            )
        row_offset += batch.num_rows
    flush()
    return ranges, row_offset


def collect_parquet_vocab(
    parquet: Path,
    column: str,
    strings_for_value: Callable[[Any], Iterable[str]],
    *,
    batch_size: int = 65_536,
) -> list[str]:
    """Collect a deterministic vocabulary without materializing the table."""
    strings: set[str] = set()
    parquet_file = pq.ParquetFile(parquet)
    for batch in parquet_file.iter_batches(
        batch_size=batch_size, columns=[column]
    ):
        for value in batch.column(0).to_pylist():
            strings.update(strings_for_value(value))
    return vocab_sorted(strings)


def subject_entity_row(
    table: dict[str, list[Any]],
    i: int,
    text_index: int,
    *,
    text_bits: dict[str, np.ndarray],
    meta_id: dict[str, int],
    tag_id: dict[str, int],
) -> list[Any]:
    score = table["score"][i]
    bgm_rank = table["rank"][i]
    return [
        table["name"][i],
        table["name_cn"][i] or None,
        table["type"][i],
        table["platform_code"][i],
        table["date"][i],
        score,
        bgm_rank,
        int(table["nsfw"][i]),
        table["wish"][i],
        table["done"][i],
        table["doing"][i],
        table["on_hold"][i],
        table["dropped"][i],
        int(table["series"][i]),
        table["score_details"][i],
        [meta_id[t] for t in table["meta_tags"][i]],
        [[tag_id[t["name"]], t["count"]] for t in table["tags"][i]],
        int(bool(text_bits["summary"][text_index])),
        int(bool(text_bits["infobox"][text_index])),
    ]


def person_entity_row(
    table: dict[str, list[Any]],
    i: int,
    text_index: int,
    *,
    text_bits: dict[str, np.ndarray],
    career_id: dict[str, int],
) -> list[Any]:
    return [
        table["name"][i],
        table["type"][i],
        [career_id[c] for c in table["career"][i]],
        table["comments"][i],
        table["collects"][i],
        int(bool(text_bits["summary"][text_index])),
        int(bool(text_bits["infobox"][text_index])),
    ]


def character_entity_row(
    table: dict[str, list[Any]],
    i: int,
    text_index: int,
    *,
    text_bits: dict[str, np.ndarray],
) -> list[Any]:
    return [
        table["name"][i],
        table["role"][i],
        table["comments"][i],
        table["collects"][i],
        int(bool(text_bits["summary"][text_index])),
        int(bool(text_bits["infobox"][text_index])),
    ]


def load_layout() -> dict[str, np.ndarray]:
    t = pq.read_table(LAYOUT)
    return {c: np.asarray(t.column(c)) for c in t.column_names}


def read_text_presence(
    table: str, columns: tuple[str, ...]
) -> dict[str, np.ndarray]:
    """Read long-text columns one at a time and retain only presence bits."""
    present: dict[str, np.ndarray] = {}
    for column in columns:
        values = pq.read_table(
            PARQUET / f"{table}.parquet", columns=[column]
        ).column(column)
        present[column] = pc.not_equal(values, "").to_numpy(
            zero_copy_only=False
        )
    return present


def emit_sorted_parquet_text(
    pack: RolloverPack,
    parquet: Path,
    column: str,
    *,
    width: int,
    level: int,
    batch_size: int = 65_536,
    on_member: (
        Callable[[list[int], list[tuple[int, Any]]], None] | None
    ) = None,
) -> tuple[list[list[int]], dict[str, int]]:
    """Stream an ID-sorted text column, retaining only one ID window."""
    ranges: list[list[int]] = []
    items: list[tuple[int, Any]] = []
    current_window: int | None = None
    previous_id = -1
    non_empty = 0
    empty = 0
    raw_bytes = 0

    def encode_text(chunk: list[tuple[int, Any]]) -> Any:
        return {
            "i": [item[0] for item in chunk],
            "t": [item[1] for item in chunk],
        }

    def flush() -> None:
        nonlocal items
        if items:
            ranges.extend(
                emit_ranged(
                    pack,
                    items,
                    width,
                    level,
                    encode_text,
                    on_member,
                )
            )
            items = []

    parquet_file = pq.ParquetFile(parquet)
    for batch in parquet_file.iter_batches(
        batch_size=batch_size, columns=["id", column]
    ):
        values = batch.to_pydict()
        for raw_id, text in zip(values["id"], values[column], strict=True):
            source_id = int(raw_id)
            if source_id < previous_id:
                raise ValueError(f"{parquet.name} must be sorted by id")
            previous_id = source_id
            window = source_id // width
            if current_window is None:
                current_window = window
            elif window != current_window:
                flush()
                current_window = window
            if text:
                items.append((source_id, text))
                non_empty += 1
                raw_bytes += len(text.encode("utf-8"))
            else:
                empty += 1
    flush()
    return ranges, {
        "non_empty": non_empty,
        "empty": empty,
        "raw_bytes": raw_bytes,
    }


def emit_fact_summary(
    items: Iterable[tuple[int, Any]],
    *,
    non_empty_count: int,
    empty_count: int,
    raw_bytes: int,
    on_member: (
        Callable[[list[int], list[tuple[int, Any]]], None] | None
    ) = None,
) -> tuple[dict[str, Any], dict[str, int], list[int]]:
    """Write non-empty VOICE_CREDIT summaries addressed by FactRef."""
    family = "fact-summary"
    width = sr.TEXT_BLOCK_IDS[family]
    level = sr.GZIP_LEVELS[family]
    ordered_items = sorted(dict(items).items())
    if non_empty_count < len(ordered_items):
        raise ValueError(
            "fact-summary source non-empty count is smaller than stored "
            "FactRefs"
        )
    pack = RolloverPack(family)
    ranges = emit_ranged(
        pack,
        ordered_items,
        width,
        level,
        lambda chunk: {
            "i": [fact_ref for fact_ref, _text in chunk],
            "t": [text for _fact_ref, text in chunk],
        },
        on_member,
    )
    pack.write()
    sizes = pack.sizes
    return (
        {
            "gzip": level,
            "width": width,
            "files": pack.files,
            "ranges": ranges,
        },
        {
            "non_empty": non_empty_count,
            "empty": empty_count,
            "raw_bytes": raw_bytes,
            "compressed_bytes": sum(sizes),
        },
        sizes,
    )


def encode_delta_varints(values: Iterable[int]) -> bytes:
    """Encode one sorted posting page without a fixed-width padding cost."""
    encoded = bytearray()
    previous = -1
    for index, value in enumerate(values):
        if value < 0 or (index and value <= previous):
            raise ValueError(
                "delta-varint postings must be non-negative and sorted"
            )
        delta = value if index == 0 else value - previous
        while delta >= 0x80:
            encoded.append((delta & 0x7F) | 0x80)
            delta >>= 7
        encoded.append(delta)
        previous = value
    return bytes(encoded)


class TextSearchBuilder:
    """Hash visible text; projected source text verifies candidate hits."""

    def __init__(self) -> None:
        self.members: list[list[Any]] = []
        self.postings = [array("I") for _ in range(sr.SEARCH_NGRAM_BUCKETS)]
        self.trigram_postings = [
            array("I") for _ in range(sr.SEARCH_NGRAM_BUCKETS)
        ]
        self._written = False

    def add(
        self,
        family: str,
        entity_kind: int,
        loc: list[int],
        texts: Iterable[str],
        *,
        full_text: bool = False,
    ) -> None:
        if self._written:
            raise RuntimeError("text search index is already written")
        if len(loc) != 3:
            raise ValueError("text search requires a rollover-pack locator")
        member_id = len(self.members)
        if member_id >= sr.RANK_SENTINEL:
            raise ValueError("text search member id exceeds u24")
        self.members.append([family, entity_kind, *loc])
        buckets: set[int] = set()
        trigram_buckets: set[int] = set()
        for text in texts:
            folded = sr.search_fold(sr.display_text(text))
            buckets.update(
                sr.search_gram_bucket(
                    folded[start : start + sr.SEARCH_NGRAM_WIDTH]
                )
                for start in range(len(folded) - sr.SEARCH_NGRAM_WIDTH + 1)
            )
            if full_text:
                width = sr.TEXT_SEARCH_TRIGRAM_WIDTH
                trigram_buckets.update(
                    sr.search_gram_bucket(
                        folded[start : start + width], width=width
                    )
                    for start in range(len(folded) - width + 1)
                )
        for bucket in buckets:
            self.postings[bucket].append(member_id)
        for bucket in trigram_buckets:
            self.trigram_postings[bucket].append(member_id)

    def _write_postings(
        self, stem: str, postings: list[array[int]]
    ) -> tuple[int, int]:
        pack = PackFile(f"{stem}.pack")
        bucket_count = len(postings)
        bucket_members = np.empty(bucket_count + 1, dtype="<u4")
        counts = np.empty(bucket_count, dtype="<u4")
        first: list[int] = []
        last: list[int] = []
        posting_count = 0
        for bucket, member_ids in enumerate(postings):
            bucket_members[bucket] = len(pack.sizes)
            counts[bucket] = len(member_ids)
            posting_count += len(member_ids)
            for start in range(
                0, len(member_ids), sr.SEARCH_NGRAM_MEMBER_RANKS
            ):
                values = np.asarray(
                    member_ids[start : start + sr.SEARCH_NGRAM_MEMBER_RANKS],
                    dtype="<u4",
                )
                encoded = encode_delta_varints(int(value) for value in values)
                pack.add(
                    gzip.compress(
                        encoded,
                        compresslevel=sr.GZIP_LEVELS["search"],
                        mtime=0,
                    )
                )
                first.append(int(values[0]))
                last.append(int(values[-1]))
        bucket_members[-1] = len(pack.sizes)
        pack.write()
        offsets = np.empty(len(pack.sizes) + 1, dtype="<u4")
        offsets[0] = 0
        np.cumsum(pack.sizes, dtype=np.uint32, out=offsets[1:])
        (SITE / f"{stem}.idx").write_bytes(
            bucket_members.tobytes()
            + offsets.tobytes()
            + np.asarray(first, dtype="<u4").tobytes()
            + np.asarray(last, dtype="<u4").tobytes()
            + counts.tobytes()
        )
        return posting_count, pack.size

    def _write_sharded_postings(
        self,
        stem: str,
        postings: list[array[int]],
        shards: int,
    ) -> tuple[int, int]:
        if shards <= 0 or len(postings) % shards:
            raise ValueError("text search posting shards must divide buckets")
        posting_count = 0
        pack_bytes = 0
        for shard in range(shards):
            shard_count, shard_bytes = self._write_postings(
                f"{stem}-{shard}", postings[shard::shards]
            )
            posting_count += shard_count
            pack_bytes += shard_bytes
        return posting_count, pack_bytes

    def write(self) -> None:
        if self._written:
            raise RuntimeError("text search index is already written")
        write_gzip_json(
            "text.search.members",
            {"schema": "text-search-members-v1", "members": self.members},
            9,
        )
        posting_count, bigram_bytes = self._write_sharded_postings(
            "text.search.ngram",
            self.postings,
            sr.TEXT_SEARCH_POSTING_SHARDS,
        )
        trigram_count, trigram_bytes = self._write_sharded_postings(
            "text.search.trigram",
            self.trigram_postings,
            sr.TEXT_SEARCH_POSTING_SHARDS,
        )
        member_count = len(self.members)
        log(
            f"文本候选索引:{member_count:,} 成员,"
            f"二元 {posting_count:,}/{bigram_bytes / 1e6:,.1f}MB,"
            f"全文三元 {trigram_count:,}/{trigram_bytes / 1e6:,.1f}MB"
        )
        self.members.clear()
        self.postings.clear()
        self.trigram_postings.clear()
        self._written = True


def collect_fact_encodings(
    encodings: list[bytes],
    fact_kind: str,
    rows: Iterable[FactRow],
    *,
    row_count: int,
) -> np.ndarray:
    """Consume one fact source once, retaining compact canonical bytes."""
    if row_count < 0:
        raise ValueError("fact row count must not be negative")
    edges = np.empty((row_count, 2), dtype=np.uint32)
    actual = 0
    for actual, (participants, attrs) in enumerate(rows, start=1):
        if actual > row_count:
            raise ValueError("fact source yielded more rows than declared")
        encoded = sr.canonical_fact(fact_kind, participants, attrs)
        encodings.append(encoded)
        edges[actual - 1] = participants[:2]
    if actual != row_count:
        raise ValueError(
            f"fact source yielded {actual} rows, expected {row_count}"
        )
    return edges


def write_fact_run(
    directory: Path,
    run_number: int,
    fact_kind: str,
    rows: Iterable[FactRow],
    *,
    row_count: int,
) -> tuple[Path, np.ndarray]:
    """Sort one bounded fact batch and spill it to a newline-delimited run."""
    encodings: list[bytes] = []
    edges = collect_fact_encodings(
        encodings, fact_kind, rows, row_count=row_count
    )
    encodings.sort()
    path = directory / f"fact-{run_number:06d}.jsonl.gz"
    with gzip.open(path, "wb", compresslevel=1) as writer:
        for encoded in encodings:
            if b"\n" in encoded:
                raise ValueError("canonical JSON fact contains a raw newline")
            writer.write(encoded + b"\n")
    return path, edges


def read_fact_run(path: Path) -> Iterator[bytes]:
    """Yield canonical facts from one already-sorted disk run."""
    with gzip.open(path, "rb") as reader:
        for line in reader:
            if not line.endswith(b"\n"):
                raise ValueError(f"truncated fact run: {path}")
            yield line[:-1]


def merge_fact_runs(
    runs_by_kind: dict[str, list[Path]],
) -> Iterator[tuple[bytes, int]]:
    """Merge bounded runs into canonical FactRef order with multiplicity."""
    paths = [path for runs in runs_by_kind.values() for path in runs]
    merged = heapq.merge(*(read_fact_run(path) for path in paths))
    previous: bytes | None = None
    multiplicity = 0
    for encoded in merged:
        if previous is None:
            previous = encoded
            multiplicity = 1
        elif encoded == previous:
            multiplicity += 1
        else:
            yield previous, multiplicity
            previous = encoded
            multiplicity = 1
    if previous is not None:
        yield previous, multiplicity


def build_rank_lookup(keys: np.ndarray) -> RankLookup:
    """Build compact source-ID segments that map EntityKey to VisualRank."""
    if keys.ndim != 1 or len(keys) > sr.RANK_SENTINEL:
        raise ValueError("rank keys must be a one-dimensional u24-sized array")
    kinds = keys >> np.uint32(24)
    if len(keys) and not np.isin(kinds, sr.KINDS).all():
        raise ValueError("rank keys contain an unknown entity kind")

    ranks = np.arange(len(keys), dtype=np.uint32)
    lookup: RankLookup = {}
    for kind in sr.KINDS:
        selected = kinds == kind
        ids = (keys[selected] & sr.MAX_SOURCE_ID).astype(np.int64)
        if not len(ids):
            lookup[kind] = np.empty(0, dtype=np.uint32)
            continue
        if len(np.unique(ids)) != len(ids):
            raise ValueError(f"rank keys contain duplicate kind {kind} IDs")
        segment = np.full(
            int(ids.max()) + 1, sr.RANK_SENTINEL, dtype=np.uint32
        )
        segment[ids] = ranks[selected]
        lookup[kind] = segment
    return lookup


def entity_rank(lookup: RankLookup, key: int) -> int:
    """Look up one EntityKey, returning the published missing sentinel."""
    segment = lookup.get(key >> 24)
    source_id = key & sr.MAX_SOURCE_ID
    if segment is None or source_id >= len(segment):
        return sr.RANK_SENTINEL
    return int(segment[source_id])


def entity_ranks(lookup: RankLookup, keys: np.ndarray) -> np.ndarray:
    """Vectorized EntityKey lookup with the same missing sentinel."""
    key_array = np.asarray(keys, dtype=np.uint32)
    result = np.full(key_array.shape, sr.RANK_SENTINEL, dtype=np.uint32)
    kinds = key_array >> np.uint32(24)
    ids = key_array & sr.MAX_SOURCE_ID
    for kind, segment in lookup.items():
        selected = kinds == kind
        selected_ids = ids[selected]
        values = np.full(len(selected_ids), sr.RANK_SENTINEL, dtype=np.uint32)
        valid = selected_ids < len(segment)
        values[valid] = segment[selected_ids[valid]]
        result[selected] = values
    return result


def ranks_for_source_ids(
    lookup: RankLookup, kind: int, source_ids: Sequence[Any]
) -> np.ndarray:
    """Map source IDs after enforcing the shared EntityKey boundary."""

    return entity_ranks(lookup, sr.entity_keys(kind, source_ids))


class IncidenceSpool:
    """Spill incidence into bounded contiguous bucket shards."""

    def __init__(
        self,
        directory: Path,
        lookup: RankLookup,
        node_count: int,
        *,
        buckets: int,
        shards: int,
    ) -> None:
        if buckets <= 0 or shards <= 0 or buckets % shards:
            raise ValueError(
                "incidence buckets must divide evenly into shards"
            )
        directory.mkdir(parents=True, exist_ok=True)
        self._directory = directory
        self._lookup = lookup
        self._present = np.zeros(node_count, dtype=bool)
        self._external: set[int] = set()
        self._buckets = buckets
        self._shards = shards
        self._buckets_per_shard = buckets // shards
        self._closed = False
        self._writers: list[gzip.GzipFile] = []
        try:
            for shard in range(shards):
                self._writers.append(
                    gzip.open(  # noqa: SIM115 -- closed together in close()
                        directory / f"incidence-{shard:03d}.jsonl.gz",
                        "wb",
                        compresslevel=1,
                    )
                )
        except BaseException:
            for writer in self._writers:
                writer.close()
            raise

    def append(self, key: int, entry: IncidenceEntry) -> None:
        if self._closed:
            raise RuntimeError("incidence spool is already closed")
        rank = entity_rank(self._lookup, key)
        if rank == sr.RANK_SENTINEL:
            self._external.add(key)
        else:
            self._present[rank] = True
        bucket = key % self._buckets
        shard = bucket // self._buckets_per_shard
        encoded = jdump([key, *entry])
        if b"\n" in encoded:
            raise ValueError("incidence JSON contains a raw newline")
        self._writers[shard].write(encoded + b"\n")

    def close(self) -> None:
        if self._closed:
            return
        for writer in self._writers:
            writer.close()
        self._writers.clear()
        self._closed = True

    def bucket_range(self, shard: int) -> range:
        if not 0 <= shard < self._shards:
            raise IndexError("incidence shard is out of range")
        start = shard * self._buckets_per_shard
        return range(start, start + self._buckets_per_shard)

    def read_shard(self, shard: int) -> dict[int, list[IncidenceEntry]]:
        if not self._closed:
            raise RuntimeError("close incidence spool before reading it")
        self.bucket_range(shard)
        groups: dict[int, list[IncidenceEntry]] = defaultdict(list)
        path = self._directory / f"incidence-{shard:03d}.jsonl.gz"
        with gzip.open(path, "rb") as reader:
            for line in reader:
                row = orjson.loads(line)
                groups[int(row[0])].append(
                    (
                        int(row[1]),
                        cast("str", row[2]),
                        cast("list[Any]", row[3]),
                    )
                )
        return groups

    def __len__(self) -> int:
        return int(self._present.sum()) + len(self._external)


def write_search_alias_pack(alias_rows: Sequence[list[Any]]) -> int:
    """Write uniform rank blocks, halving globally until every member fits."""

    block_size = sr.SEARCH_ALIAS_BLOCK_RANKS_MAX
    while True:
        pack = PackFile("search.alias.pack")
        offsets = [0]
        oversized = False
        for start in range(0, len(alias_rows), block_size):
            member = sr.gzip_member(
                alias_rows[start : start + block_size],
                sr.GZIP_LEVELS["search"],
            )
            if not sr.member_fits(member):
                oversized = True
                break
            pack.add(member)
            offsets.append(pack.size)
        if not oversized:
            pack.write()
            (SITE / "search.alias.idx").write_bytes(
                np.asarray(offsets, dtype="<u4").tobytes()
            )
            return block_size
        pack.discard()
        if block_size == 1:
            raise ValueError(
                "single search alias row exceeds member cap; upgrade profile"
            )
        block_size //= 2
        log(f"  搜索别名成员超硬上限,块宽折半为 {block_size}")


def build_search_index(
    names: Sequence[str],
    cn_names: Sequence[str],
    entity_kinds: Sequence[int] | np.ndarray,
) -> int:
    """Build prefix autocomplete and an exact substring candidate index."""
    if len(names) != len(cn_names) or len(names) != len(entity_kinds):
        raise ValueError("search names and entity kinds must align")
    alias_rows: list[list[Any]] = []
    postings = [array("I") for _ in range(sr.SEARCH_NGRAM_BUCKETS)]
    aligned = zip(names, cn_names, entity_kinds, strict=True)
    for rank, (name, cn_name, entity_kind) in enumerate(aligned):
        if not sr.is_entity_kind(entity_kind):
            raise ValueError(f"unknown search entity kind {entity_kind}")
        kind = int(entity_kind)
        visible_name = sr.display_text(name)
        visible_name_cn = sr.display_text(cn_name)
        display = visible_name_cn or visible_name
        aliases = sr.search_aliases(visible_name, visible_name_cn)
        alias_rows.append([[list(alias) for alias in aliases], display, kind])
        rank_buckets = {
            sr.search_gram_bucket(
                normalized[start : start + sr.SEARCH_NGRAM_WIDTH]
            )
            for normalized, _matched in aliases
            for start in range(len(normalized) - sr.SEARCH_NGRAM_WIDTH + 1)
        }
        for bucket in rank_buckets:
            postings[bucket].append(rank)

    alias_block_size = write_search_alias_pack(alias_rows)
    del alias_rows

    # 每个规范化名称的连续二元字符进入固定散列桶；桶内只保存按
    # VisualRank 升序的 u24 候选。散列碰撞由客户端读取完整名称后过滤，
    # 因而只增加少量候选，不会漏掉或伪造最终命中。
    ngram_pack = PackFile("search.ngram.pack")
    bucket_members = np.empty(sr.SEARCH_NGRAM_BUCKETS + 1, dtype="<u4")
    ngram_counts = np.empty(sr.SEARCH_NGRAM_BUCKETS, dtype="<u4")
    member_first: list[int] = []
    member_last: list[int] = []
    for bucket, ranks in enumerate(postings):
        bucket_members[bucket] = len(ngram_pack.sizes)
        ngram_counts[bucket] = len(ranks)
        for start in range(0, len(ranks), sr.SEARCH_NGRAM_MEMBER_RANKS):
            values = np.asarray(
                ranks[start : start + sr.SEARCH_NGRAM_MEMBER_RANKS],
                dtype="<u4",
            )
            encoded = values.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
            ngram_pack.add(
                gzip.compress(
                    encoded,
                    compresslevel=sr.GZIP_LEVELS["search"],
                    mtime=0,
                )
            )
            member_first.append(int(values[0]))
            member_last.append(int(values[-1]))
    bucket_members[-1] = len(ngram_pack.sizes)
    ngram_pack.write()
    member_offsets = np.empty(len(ngram_pack.sizes) + 1, dtype="<u4")
    member_offsets[0] = 0
    np.cumsum(ngram_pack.sizes, dtype=np.uint32, out=member_offsets[1:])
    if sr.SEARCH_NGRAM_BUCKETS % sr.SEARCH_NGRAM_SHARDS:
        raise ValueError("search ngram buckets must divide evenly into shards")
    buckets_per_shard = sr.SEARCH_NGRAM_BUCKETS // sr.SEARCH_NGRAM_SHARDS
    ngram_directories: list[list[Any]] = [
        [None] * buckets_per_shard for _ in range(sr.SEARCH_NGRAM_SHARDS)
    ]
    for bucket in range(sr.SEARCH_NGRAM_BUCKETS):
        count = int(ngram_counts[bucket])
        if not count:
            continue
        locations = []
        for member in range(
            int(bucket_members[bucket]),
            int(bucket_members[bucket + 1]),
        ):
            start = int(member_offsets[member])
            end = int(member_offsets[member + 1])
            locations.append(
                [
                    start,
                    end - start,
                    member_first[member],
                    member_last[member],
                ]
            )
        ngram_directories[bucket % sr.SEARCH_NGRAM_SHARDS][
            bucket // sr.SEARCH_NGRAM_SHARDS
        ] = [count, locations]
    ngram_index_bytes = 0
    for shard, ngram_directory in enumerate(ngram_directories):
        encoded = sr.gzip_member(
            ngram_directory,
            sr.GZIP_LEVELS["search"],
        )
        sr.require_member_size(
            encoded,
            f"search.ngram.idx-{shard}.json.gz",
        )
        (SITE / f"search.ngram.idx-{shard}.json.gz").write_bytes(encoded)
        ngram_index_bytes += len(encoded)
    ngram_size = ngram_pack.size
    ngram_postings = sum(len(ranks) for ranks in postings)
    del (
        postings,
        bucket_members,
        member_offsets,
        member_first,
        member_last,
        ngram_counts,
        ngram_directories,
    )

    # 名称别名负载、子串 postings 与前缀树条目都很大，但彼此没有
    # 身份依赖。前两类发布并释放后再构建前缀条目，避免三份完整
    # Python 对象图在同一峰值内存窗口中共存。
    entries: list[SearchEntry] = []
    aligned = zip(names, cn_names, entity_kinds, strict=True)
    for rank, (name, cn_name, entity_kind) in enumerate(aligned):
        kind = int(entity_kind)
        visible_name = sr.display_text(name)
        visible_name_cn = sr.display_text(cn_name)
        display = visible_name_cn or visible_name
        entries.extend(
            (normalized, matched, rank, display, kind)
            for normalized, matched in sr.search_aliases(
                visible_name, visible_name_cn
            )
        )

    charmap = sr.search_charmap()
    search_pack = PackFile("search.pack")
    search_level = sr.GZIP_LEVELS["search"]
    search_dir: dict[str, Any] = {}
    n_leaves = 0
    n_internal = 0

    def next_char(normalized: str, prefix_len: int) -> str:
        # Python 字符串按码点索引;客户端以 codePointAt 对齐同一规则
        return normalized[prefix_len]

    def emit_search(
        prefix: str,
        items: list[SearchEntry],
    ) -> list[tuple[str, list[SearchEntry]]]:
        nonlocal n_leaves, n_internal
        rows = [list(entry) for entry in items]
        gz = sr.gzip_member(rows, search_level)
        if sr.member_fits(gz, cap=sr.SEARCH_LEAF_CAP):
            search_dir[prefix] = {"l": search_pack.add(gz)}
            n_leaves += 1
            return []
        n_internal += 1
        exact: list[SearchEntry] = []
        suggestions: list[SearchEntry] = []
        seen_ranks: set[int] = set()
        for entry in items:
            if entry[0] == prefix and entry[2] not in seen_ranks:
                exact.append(entry)
                seen_ranks.add(entry[2])
        for entry in items:
            if entry[0] != prefix and entry[2] not in seen_ranks:
                suggestions.append(entry)
                seen_ranks.add(entry[2])
                if len(suggestions) == sr.SEARCH_TOP:
                    break
        top = [list(entry) for entry in exact + suggestions]
        search_dir[prefix] = {
            "t": search_pack.add(sr.gzip_member(top, search_level))
        }
        children: dict[str, list[SearchEntry]] = defaultdict(list)
        for entry in items:
            if entry[0] != prefix:
                children[next_char(entry[0], len(prefix))].append(entry)
        return [(prefix + char, children[char]) for char in sorted(children)]

    roots: dict[str, list[SearchEntry]] = defaultdict(list)
    for entry in entries:
        roots[next_char(entry[0], 0)].append(entry)
    pending = [(char, roots[char]) for char in reversed(sorted(roots))]
    while pending:
        prefix, items = pending.pop()
        children = emit_search(prefix, items)
        pending.extend(reversed(children))
    search_pack.write()
    search_shards: list[dict[str, Any]] = [
        {} for _ in range(sr.SEARCH_PREFIX_SHARDS)
    ]
    for prefix, node in search_dir.items():
        search_shards[ord(prefix[0]) % sr.SEARCH_PREFIX_SHARDS][prefix] = node
    for shard, prefix_directory in enumerate(search_shards):
        logical_name = f"search.idx-{shard}.json.gz"
        encoded = sr.gzip_member(prefix_directory, search_level)
        sr.require_member_size(encoded, logical_name)
        (SITE / logical_name).write_bytes(encoded)
    del search_shards
    (SITE / "charmap.json").write_bytes(jdump(charmap))
    search_q = quantiles(search_pack.sizes)
    reconcile(
        "搜索条目数(根分组对账)",
        len(entries),
        sum(len(values) for values in roots.values()),
    )
    log(
        f"搜索:{len(entries):,} 条,叶 {n_leaves:,}/内部 {n_internal:,},"
        f"{search_pack.size / 1e6:,.1f}MB,最大成员 "
        f"{search_q['max']:,}B"
    )
    log(
        f"子串候选:{ngram_postings:,} 条 u24,{ngram_size / 1e6:,.1f}MB,"
        f"分片目录 {ngram_index_bytes / 1e6:,.1f}MB"
    )
    return alias_block_size


def vocab_sorted(strings: set[str]) -> list[str]:
    """词表按 UTF-8 字节序确定性排序;ID = 下标(发布内实现细节)。"""
    return sorted(strings, key=lambda s: s.encode("utf-8"))


def collect_mappings() -> tuple[dict[str, Any], dict[str, int]]:
    """从 parquet 的原始码-解码列对提取显示映射。

    当前快照所有事实种类的码都全局唯一(逐次构建重新验证);任一
    码映射到多个名称即失败——那意味着需要引入更细的命名空间并
    升级 mappings schema,而不是静默取其一。platform 的命名空间
    是作品类型,键为 "type:code"。
    """
    fact_labels: dict[str, dict[str, str]] = {}
    unresolved = {"voice_subject_context": 0}
    specs = [
        ("RELATES_TO", "relates_to", "relation_type", "relation"),
        ("WORKED_ON", "worked_on", "position", "position_cn"),
        ("APPEARS_IN", "appears_in", "type", "role_cn"),
        ("PERSON_REL", "person_rel", "relation_type", "relation"),
        ("CHARACTER_REL", "character_rel", "relation_type", "relation"),
    ]
    for kind, table, code_col, name_col in specs:
        t = pq.read_table(
            PARQUET / f"{table}.parquet", columns=[code_col, name_col]
        ).to_pydict()
        seen: dict[int, str] = {}
        for code, name in zip(t[code_col], t[name_col], strict=True):
            prev = seen.get(code)
            if prev is None:
                seen[code] = name
            elif prev != name:
                raise ValueError(
                    f"{kind} code {code} decodes to both "
                    f"{prev!r} and {name!r}; the per-kind namespace is "
                    "no longer sufficient — extend the mapping schema"
                )
        fact_labels[kind] = {str(c): n for c, n in sorted(seen.items()) if n}
    *_, voice_roles = load_mappings(MAPPING_SNAPSHOT)
    fact_labels["VOICE_CREDIT"] = {
        str(code): str(definition["cn"])
        for code, definition in sorted(voice_roles.items())
        if isinstance(definition, dict) and definition.get("cn")
    }
    sub = pq.read_table(
        PARQUET / "subject.parquet",
        columns=["type", "type_name", "platform_code", "platform"],
    ).to_pydict()
    subject_type: dict[str, str] = {}
    platform: dict[str, str] = {}
    for i in range(len(sub["type"])):
        st = sub["type"][i]
        subject_type.setdefault(str(st), sub["type_name"][i])
        code = sub["platform_code"][i]
        if code is not None and sub["platform"][i]:
            key = f"{st}:{code}"
            prev = platform.get(key)
            if prev is not None and prev != sub["platform"][i]:
                raise ValueError(f"platform {key} decode conflict")
            platform[key] = sub["platform"][i]
    mappings = {
        "fact_labels": fact_labels,
        "subject_type": subject_type,
        "platform": dict(sorted(platform.items())),
        "person_type": {str(k): v for k, v in PERSON_TYPE_NAMES.items()},
        "character_role": {str(k): v for k, v in CHARACTER_ROLE_NAMES.items()},
        "episode_type": {str(k): v for k, v in EPISODE_TYPE_NAMES.items()},
    }
    return mappings, unresolved


def bake_release(  # noqa: PLR0915
    output: Path, input_identity: dict[str, Any]
) -> None:
    global SITE  # noqa: PLW0603
    SITE = output
    failures.clear()
    t_start = time.time()
    dump_version = str(input_identity["dump_version"])
    validate_query_contract(
        load_query_contract(), sr.FACT_ROLES, sr.FACT_ATTRS
    )
    if not LAYOUT_REPORT.exists():
        sys.exit("FAILED: data/layout/report.json 缺失,先运行 layout.py")
    layout_report = validate_layout_report(
        orjson.loads(LAYOUT_REPORT.read_bytes()),
        shape_digest=shape_digest(),
    )
    if SITE.exists():
        if not SITE.is_dir():
            raise ValueError(f"output exists but is not a directory: {SITE}")
        shutil.rmtree(SITE)
    SITE.mkdir(parents=True, exist_ok=True)

    lay = load_layout()
    n = len(lay["key"])
    validate_release_capacity(n)
    order = np.argsort(-lay["collect"], kind="stable")
    key_r = lay["key"][order].astype(np.uint32)  # rank -> key
    kind_r = (key_r >> np.uint32(24)).astype(np.uint8)
    year_r = lay["year"][order].astype(np.uint16)
    comm_r = lay["community"][order].astype(np.uint16)
    iso_r = lay["isolated"][order]
    collect_r = lay["collect"][order]
    coords_r = np.stack(
        [lay["x"][order], lay["y"][order], lay["z"][order]], axis=1
    )
    # 全局去重叠会使用 O(n) 批量索引，先释放布局原始列和
    # 排序索引，避免与它们叠加在峰值内存中。
    del lay, order
    # 离线布局输出尺度任意;发布坐标归一到规范世界跨度,保证探索端
    # 聚焦层级、工作集字号和节点尺寸的绝对 zoom 语义
    coords_r, world_scale = normalize_world_scale(coords_r)
    # 必须在最终世界尺度上解决物理重叠;若放在 layout.py 中,
    # 此处的 600 跨度归一会再次缩小已经分开的中心距。
    coords_r, separation_report = separate_published_nodes(coords_r)
    distance_violation = find_minimum_distance_violation(coords_r)
    if distance_violation is not None:
        bad_rank_a, bad_rank_b, bad_distance = distance_violation
        sys.exit(
            f"FAILED: 发布坐标 rank {bad_rank_a}/{bad_rank_b} 中心距 "
            f"{bad_distance:.6f} < {MIN_NODE_CENTER_DISTANCE:g}"
        )
    published_layout = {
        **layout_report,
        "minimum_node_center_distance": MIN_NODE_CENTER_DISTANCE,
        "separation": {
            "moved_nodes": separation_report.moved_nodes,
            "max_displacement": separation_report.max_displacement,
            "placement_clearance": separation_report.placement_clearance,
            "assignment_rounds": separation_report.assignment_rounds,
        },
    }
    rank_lookup = build_rank_lookup(key_r)
    log(
        f"节点 {n:,},rank 排序完成(dump 版本 {dump_version}),"
        f"世界尺度 ×{world_scale:.3f} → 名义跨度 "
        f"{CANONICAL_WORLD_SPAN:g}"
    )
    log(
        f"全局物理去重叠: {separation_report.moved_nodes:,}/{n:,} "
        f"节点移动,最大位移 "
        f"{separation_report.max_displacement:.4f},"
        f"最小中心距 {MIN_NODE_CENTER_DISTANCE:g}"
    )

    # ---- 排名对齐列(先只读几何、名称和标签所需字段)----
    sub_t = pq.read_table(
        PARQUET / "subject.parquet",
        columns=[
            "id",
            "type",
            "name",
            "name_cn",
            "date",
            "score",
            "rank",
            "nsfw",
            "meta_tags",
        ],
    )
    sub_index = sub_t.to_pydict()
    del sub_t
    per_t = pq.read_table(
        PARQUET / "person.parquet",
        columns=["id", "name"],
    )
    per_names = per_t.to_pydict()
    del per_t
    cha_t = pq.read_table(
        PARQUET / "character.parquet",
        columns=["id", "name"],
    )
    cha_names = cha_t.to_pydict()
    del cha_t

    # 名称、几何标志和标签按 VisualRank 对齐,避免百万个嵌套字典。
    names_r = [""] * n
    cn_names_r = [""] * n
    present_r = np.zeros(n, dtype=bool)
    nsfw_arr = np.zeros(n, dtype=bool)
    media_vals = np.zeros(n, dtype=np.int64)
    score_u8 = np.zeros(n, dtype=np.uint8)
    meta_tags_r: list[list[str] | None] = [None] * n

    sub_ranks = ranks_for_source_ids(
        rank_lookup, sr.KIND_SUBJECT, sub_index["id"]
    )
    subject_source_count = len(rank_lookup[sr.KIND_SUBJECT])
    subject_source_query_columns = build_subject_source_query_columns(
        source_ids=sub_index["id"],
        dates=sub_index["date"],
        ranks=sub_index["rank"],
        source_count=subject_source_count,
    )
    for i, rank_value in enumerate(sub_ranks):
        rank = int(rank_value)
        if rank == sr.RANK_SENTINEL:
            continue
        present_r[rank] = True
        names_r[rank] = sub_index["name"][i]
        cn_names_r[rank] = sub_index["name_cn"][i]
        nsfw_arr[rank] = bool(sub_index["nsfw"][i])
        media_vals[rank] = int(sub_index["type"][i])
        query_year = subject_query_year(sub_index["date"][i])
        if int(year_r[rank]) != query_year:
            raise ValueError(
                "Subject year query column differs from Subject.date: "
                f"id={sub_index['id'][i]}, layout={int(year_r[rank])}, "
                f"query={query_year}"
            )
        score_u8[rank] = subject_query_score(sub_index["score"][i])
        meta_tags_r[rank] = sub_index["meta_tags"][i]
    per_ranks = ranks_for_source_ids(
        rank_lookup, sr.KIND_PERSON, per_names["id"]
    )
    for i, rank_value in enumerate(per_ranks):
        rank = int(rank_value)
        if rank != sr.RANK_SENTINEL:
            present_r[rank] = True
            names_r[rank] = per_names["name"][i]
    cha_ranks = ranks_for_source_ids(
        rank_lookup, sr.KIND_CHARACTER, cha_names["id"]
    )
    for i, rank_value in enumerate(cha_ranks):
        rank = int(rank_value)
        if rank != sr.RANK_SENTINEL:
            present_r[rank] = True
            names_r[rank] = cha_names["name"][i]

    entity_counts = {
        "subject": len(sub_index["id"]),
        "person": len(per_names["id"]),
        "character": len(cha_names["id"]),
    }
    database_entities = sum(entity_counts.values())
    reconcile("节点属性覆盖全部入图节点", n, int(present_r.sum()))
    reconcile("库实体数 = 入图节点数", database_entities, n)
    if failures:
        sys.exit(f"FAILED: 布局与库不同步({failures}),先重跑 layout.py 再烘焙")
    del present_r, sub_ranks, per_ranks, cha_ranks, per_names, cha_names

    # ---- 几何 SoA(19B/节点,定长记录支持 Range 点查)----
    # 坐标先以最终 float32 语义量化为逐轴 affine u16，再立即按浏览器
    # 算法解码并复核物理间距。查询数据与 rank 完全不参与该有损层。
    coords_f32 = coords_r.astype("<f4", copy=False)
    positions_u16, position_encoding = quantize_positions(coords_f32)
    decoded_positions = decode_positions(positions_u16, position_encoding)
    max_position_error = 0.0
    for start in range(0, n, 100_000):
        end = min(start + 100_000, n)
        delta = decoded_positions[start:end].astype(np.float64) - coords_f32[
            start:end
        ].astype(np.float64)
        max_position_error = max(
            max_position_error,
            float(np.linalg.norm(delta, axis=1).max(initial=0.0)),
        )
    quantized_violation = find_minimum_distance_violation(decoded_positions)
    if quantized_violation is not None:
        bad_rank_a, bad_rank_b, bad_distance = quantized_violation
        sys.exit(
            f"FAILED: u16 坐标 rank {bad_rank_a}/{bad_rank_b} 中心距 "
            f"{bad_distance:.6f} < {MIN_NODE_CENTER_DISTANCE:g}"
        )
    lo = [float(v) for v in decoded_positions.min(0)]
    hi = [float(v) for v in decoded_positions.max(0)]
    published_layout["position_quantization"] = {
        "encoding": position_encoding["encoding"],
        "max_displacement": max_position_error,
    }
    (SITE / "positions.bin").write_bytes(positions_u16.tobytes())
    del decoded_positions
    (SITE / "year.bin").write_bytes(year_r.tobytes())
    (SITE / "key.bin").write_bytes(key_r.tobytes())
    size_raw = np.round(18 * np.log2(1 + collect_r))
    clamped = int((size_raw > 255).sum())
    if clamped:
        log(f"  截断:size_u8 到顶 255 的节点 {clamped:,} 个(显式报出)")
    size_u8 = np.minimum(255, size_raw).astype(np.uint8)
    (SITE / "size.bin").write_bytes(size_u8.tobytes())
    flags = np.zeros(n, dtype=np.uint8)
    flags |= nsfw_arr.astype(np.uint8)
    flags |= (iso_r.astype(np.uint8)) << 1
    validate_media_flag_values(media_vals)
    flags |= (media_vals.astype(np.uint8)) << 2
    (SITE / "flags.bin").write_bytes(flags.tobytes())
    (SITE / "score.bin").write_bytes(score_u8.tobytes())
    (SITE / SUBJECT_DATE_CODE_PATH).write_bytes(
        subject_source_query_columns.date_codes.tobytes()
    )
    write_gzip_json(
        SUBJECT_DATE_DICTIONARY_PATH,
        subject_source_query_columns.date_dictionary,
        6,
    )
    (SITE / SUBJECT_BGM_RANK_PATH).write_bytes(
        subject_source_query_columns.ranks.tobytes()
    )
    tag_counts: Counter[str] = Counter()
    for meta_tags in meta_tags_r:
        tag_counts.update(meta_tags or [])
    top_tags = [t for t, _ in tag_counts.most_common(32)]
    tag_bit = {t: i for i, t in enumerate(top_tags)}
    tag_mask = np.zeros(n, dtype=np.uint32)
    for i, meta_tags in enumerate(meta_tags_r):
        m = 0
        for tg in meta_tags or []:
            b = tag_bit.get(tg)
            if b is not None:
                m |= 1 << b
        tag_mask[i] = m
    (SITE / "tags.bin").write_bytes(tag_mask.tobytes())
    for fname, stride in (
        ("positions.bin", 6),
        ("year.bin", 2),
        ("key.bin", 4),
        ("size.bin", 1),
        ("flags.bin", 1),
        ("score.bin", 1),
        ("tags.bin", 4),
    ):
        reconcile(f"{fname} 字节数", n * stride, (SITE / fname).stat().st_size)
    reconcile(
        f"{SUBJECT_DATE_CODE_PATH} 字节数",
        subject_source_count * 2,
        (SITE / SUBJECT_DATE_CODE_PATH).stat().st_size,
    )
    reconcile(
        f"{SUBJECT_BGM_RANK_PATH} 字节数",
        subject_source_count * 2,
        (SITE / SUBJECT_BGM_RANK_PATH).stat().st_size,
    )
    log("几何 SoA 写出完成")
    log(
        f"坐标 affine u16: {coords_f32.nbytes:,} → "
        f"{positions_u16.nbytes:,} 字节,最大位移 "
        f"{max_position_error:.6f}"
    )
    del (
        sub_index,
        meta_tags_r,
        nsfw_arr,
        media_vals,
        iso_r,
        coords_f32,
        positions_u16,
        size_raw,
        size_u8,
        flags,
        score_u8,
        subject_source_query_columns,
        tag_counts,
        tag_bit,
        tag_mask,
    )

    # ---- rank-by-key.bin:按实体种类拼接的 u24 反向索引 ----
    rank_segments: dict[str, dict[str, int]] = {}
    rank_buf = bytearray()
    for kind in sr.KINDS:
        seg = rank_lookup[kind].astype("<u4", copy=False)
        as_u8 = seg.view(np.uint8).reshape(-1, 4)[:, :3]
        rank_segments[str(kind)] = {
            "offset": len(rank_buf),
            "count": len(seg),
        }
        rank_buf += as_u8.tobytes()
    (SITE / "rank-by-key.bin").write_bytes(bytes(rank_buf))
    del key_r, rank_buf
    reconcile(
        "rank-by-key.bin 字节数",
        sum(seg["count"] * 3 for seg in rank_segments.values()),
        (SITE / "rank-by-key.bin").stat().st_size,
    )

    # ---- 名字表:2,048 rank/成员;超全局硬上限时全局折半重试 ----
    name_block_size = sr.NAME_BLOCK_SIZE
    while True:
        name_pack = PackFile("names.pack")
        name_offsets = [0]
        oversize = False
        for start in range(0, n, name_block_size):
            end = min(n, start + name_block_size)
            rows = [
                [
                    names_r[rank],
                    cn_names_r[rank] or None,
                    int(kind_r[rank]),
                ]
                for rank in range(start, end)
            ]
            gz = sr.gzip_member(rows, sr.GZIP_LEVELS["names"])
            if not sr.member_fits(gz):
                oversize = True
                break
            off, length = name_pack.add(gz)
            name_offsets.append(off + length)
        if not oversize:
            break
        name_pack.discard()
        name_block_size //= 2
        log(f"  名称成员超硬上限,块宽折半为 {name_block_size}")
        if name_block_size < 64:
            sys.exit("FAILED: 名称块宽折半到 64 仍超上限,升级 profile")
    name_pack.write()
    np.asarray(name_offsets, dtype="<u4").tofile(SITE / "names.idx")
    validate_name_pack(
        SITE / "names.pack",
        SITE / "names.idx",
        n_rows=n,
        block_size=name_block_size,
    )
    name_q = quantiles(name_pack.sizes)
    if name_q["p99"] > sr.NAME_P99_CAP:
        failures.append(
            f"名称成员 P99 {name_q['p99']:,} 超体验门禁 "
            f"{sr.NAME_P99_CAP:,};调小声明块宽后重建"
        )
    log(
        f"名字表:{len(name_pack.sizes):,} 成员,"
        f"P99 {name_q['p99']:,}B,最大 {name_q['max']:,}B"
    )
    del name_offsets, name_pack

    # ---- 实体结构 pack(三类实体顺序加载、立即编码和释放)----
    entities_pack = PackFile("entities.pack")
    ent_level = sr.GZIP_LEVELS["entities"]
    ent_ranges: dict[str, list[list[int]]] = {}

    subject_path = PARQUET / "subject.parquet"
    meta_vocab = collect_parquet_vocab(
        subject_path, "meta_tags", lambda values: values
    )
    tag_vocab = collect_parquet_vocab(
        subject_path,
        "tags",
        lambda values: (tag["name"] for tag in values),
    )
    sub_text_bits = read_text_presence("subject", ("summary", "infobox"))
    meta_id = {s: i for i, s in enumerate(meta_vocab)}
    tag_id = {s: i for i, s in enumerate(tag_vocab)}

    subject_row = partial(
        subject_entity_row,
        text_bits=sub_text_bits,
        meta_id=meta_id,
        tag_id=tag_id,
    )

    subject_ranges, subject_rows = emit_sorted_entity_parquet(
        entities_pack,
        subject_path,
        [
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
        ],
        width=sr.ENTITY_BLOCK_IDS,
        level=ent_level,
        row_for_index=subject_row,
    )
    ent_ranges[str(sr.KIND_SUBJECT)] = subject_ranges
    reconcile("subject 实体结构行数", entity_counts["subject"], subject_rows)
    del sub_text_bits, meta_id, tag_id, subject_row, subject_ranges

    person_path = PARQUET / "person.parquet"
    career_vocab = collect_parquet_vocab(
        person_path, "career", lambda values: values
    )
    per_text_bits = read_text_presence("person", ("summary", "infobox"))
    career_id = {s: i for i, s in enumerate(career_vocab)}

    person_row = partial(
        person_entity_row,
        text_bits=per_text_bits,
        career_id=career_id,
    )

    person_ranges, person_rows = emit_sorted_entity_parquet(
        entities_pack,
        person_path,
        ["id", "name", "type", "career", "comments", "collects"],
        width=sr.ENTITY_BLOCK_IDS,
        level=ent_level,
        row_for_index=person_row,
    )
    ent_ranges[str(sr.KIND_PERSON)] = person_ranges
    reconcile("person 实体结构行数", entity_counts["person"], person_rows)
    del per_text_bits, career_id, person_row, person_ranges

    character_path = PARQUET / "character.parquet"
    cha_text_bits = read_text_presence("character", ("summary", "infobox"))

    character_row = partial(
        character_entity_row,
        text_bits=cha_text_bits,
    )

    character_ranges, character_rows = emit_sorted_entity_parquet(
        entities_pack,
        character_path,
        ["id", "name", "role", "comments", "collects"],
        width=sr.ENTITY_BLOCK_IDS,
        level=ent_level,
        row_for_index=character_row,
    )
    ent_ranges[str(sr.KIND_CHARACTER)] = character_ranges
    reconcile(
        "character 实体结构行数",
        entity_counts["character"],
        character_rows,
    )
    del cha_text_bits, character_row, character_ranges

    entities_pack.write()
    write_gzip_json(
        "entities.idx",
        {"width": sr.ENTITY_BLOCK_IDS, "k": ent_ranges},
        6,
    )
    reconcile("实体结构行数", n, sum(entity_counts.values()))
    ent_q = quantiles(entities_pack.sizes)
    log(
        f"实体结构:{ent_q['members']:,} 成员,"
        f"{entities_pack.size / 1e6:,.1f}MB,最大 {ent_q['max']:,}B"
    )
    del entities_pack

    # ---- 词表(career / meta_tags / tags.name)----
    vocab_pack = PackFile("vocab.pack")
    vocab_level = sr.GZIP_LEVELS["vocab"]
    vocab_dir: dict[str, list[list[int]]] = {
        "career": [vocab_pack.add_json(career_vocab, vocab_level)],
        "meta_tags": [vocab_pack.add_json(meta_vocab, vocab_level)],
        "tags": [],
    }
    for start in range(0, len(tag_vocab), 8192):
        chunk = tag_vocab[start : start + 8192]
        gz = sr.gzip_member(chunk, vocab_level)
        if not sr.member_fits(gz):
            sys.exit("FAILED: tags 词表成员超上限,缩小分块")
        vocab_dir["tags"].append(vocab_pack.add(gz))
    vocab_pack.write()
    write_gzip_json("vocab.idx", {"chunk": 8192, "members": vocab_dir}, 6)
    vocab_digests = {
        "career": sr.sha256_hex(sr.canonical_json(career_vocab)),
        "meta_tags": sr.sha256_hex(sr.canonical_json(meta_vocab)),
        "tags": sr.sha256_hex(sr.canonical_json(tag_vocab)),
    }
    log(
        f"词表:career {len(career_vocab):,}、meta {len(meta_vocab):,}、"
        f"tags {len(tag_vocab):,}"
    )
    del career_vocab, meta_vocab, tag_vocab, vocab_pack

    # ---- 事实:有界排序段 → FactRef → incidence 磁盘分片 ----
    log("事实规范化…")
    edge_key_pairs: list[np.ndarray] = []  # 骨架边输入(key 对)
    source_rows = 0
    run_number = 0

    with tempfile.TemporaryDirectory(prefix="bangumi-atlas-facts-") as temp:
        temp_path = Path(temp)
        run_path = temp_path / "runs"
        run_path.mkdir()
        runs_by_kind: dict[str, list[Path]] = defaultdict(list)

        def spill_source(
            table: str,
            columns: list[str],
            fact_kind: str,
            row_for_index: Callable[[dict[str, list[Any]], int], FactRow],
        ) -> None:
            nonlocal run_number, source_rows
            parquet = pq.ParquetFile(PARQUET / f"{table}.parquet")
            for batch in parquet.iter_batches(
                batch_size=FACT_BATCH_ROWS, columns=columns
            ):
                values = batch.to_pydict()
                row_count = batch.num_rows
                path, edges = write_fact_run(
                    run_path,
                    run_number,
                    fact_kind,
                    (row_for_index(values, i) for i in range(row_count)),
                    row_count=row_count,
                )
                runs_by_kind[fact_kind].append(path)
                edge_key_pairs.append(edges)
                source_rows += row_count
                run_number += 1

        spill_source(
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
        spill_source(
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
        spill_source(
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
        spill_source(
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
        spill_source(
            "person_rel",
            ["from_id", "to_id", "relation_type", "spoiler", "ended"],
            "PERSON_REL",
            lambda row, i: (
                (
                    sr.entity_key(sr.KIND_PERSON, row["from_id"][i]),
                    sr.entity_key(sr.KIND_PERSON, row["to_id"][i]),
                ),
                (
                    row["relation_type"][i],
                    int(row["spoiler"][i]),
                    int(row["ended"][i]),
                ),
            ),
        )
        spill_source(
            "character_rel",
            ["from_id", "to_id", "relation_type", "spoiler", "ended"],
            "CHARACTER_REL",
            lambda row, i: (
                (
                    sr.entity_key(sr.KIND_CHARACTER, row["from_id"][i]),
                    sr.entity_key(sr.KIND_CHARACTER, row["to_id"][i]),
                ),
                (
                    row["relation_type"][i],
                    int(row["spoiler"][i]),
                    int(row["ended"][i]),
                ),
            ),
        )

        # incidence:每个不同参与者一条;分片后再按热度排序
        voice_unresolved = 0
        incid = IncidenceSpool(
            temp_path / "incidence",
            rank_lookup,
            n,
            buckets=sr.FACT_BUCKETS,
            shards=INCIDENCE_SHARDS,
        )
        n_incidence = 0
        n_facts = 0
        fs_items: list[tuple[int, Any]] = []
        fs_non_empty = 0
        fs_empty = 0
        fs_raw = 0
        fact_anchors = array("I")
        try:
            for ref, (encoded, mult) in enumerate(
                merge_fact_runs(runs_by_kind)
            ):
                n_facts = ref + 1
                decoded = orjson.loads(encoded)
                inc_kind = cast("str", decoded[0])
                inc_parts = tuple(cast("list[int]", decoded[1]))
                inc_attrs = tuple(cast("list[Any]", decoded[2]))
                if not inc_parts:
                    raise ValueError("canonical fact has no participant")
                fact_anchors.append(inc_parts[0])
                if inc_kind == "VOICE_CREDIT":
                    disk_attrs: tuple[Any, ...] = (
                        inc_attrs[0],
                        int(bool(inc_attrs[1])),
                    )
                    text = inc_attrs[1]
                    if text:
                        fs_items.append((ref, text))
                        fs_non_empty += mult
                        fs_raw += len(str(text).encode("utf-8")) * mult
                    else:
                        fs_empty += mult
                    if (
                        entity_rank(rank_lookup, inc_parts[2])
                        == sr.RANK_SENTINEL
                    ):
                        voice_unresolved += 1
                else:
                    disk_attrs = inc_attrs
                for inc_key in dict.fromkeys(inc_parts):
                    tup = sr.incidence_tuple(
                        ref, mult, inc_key, inc_parts, disk_attrs
                    )
                    others = cast("list[int]", tup[3])
                    heat = min(
                        (entity_rank(rank_lookup, o) for o in others),
                        default=entity_rank(rank_lookup, inc_key),
                    )
                    incid.append(inc_key, (heat, sr.FACT_TAGS[inc_kind], tup))
                    n_incidence += 1
        finally:
            incid.close()
        log(
            f"事实 {source_rows:,} 行 → {n_facts:,} 个"
            f"(合并完全重复 {source_rows - n_facts:,} 行,"
            f"multiplicity 保留;去重敏感对账 {n_facts:,})"
        )
        log(f"incidence {n_incidence:,} 条,覆盖实体 {len(incid):,}")
        np.asarray(fact_anchors, dtype="<u4").tofile(SITE / "fact-anchor.bin")
        del fact_anchors

        pages_pack = PackFile("pages.pack")
        pages_level = sr.GZIP_LEVELS["pages"]
        facts_pack = PackFile("facts.pack")
        facts_level = sr.GZIP_LEVELS["facts"]
        fact_dir: list[list[list[int]]] = [[] for _ in range(sr.FACT_BUCKETS)]
        inline_written = 0
        paged_written = 0

        def pack_bucket(bucket: dict[str, Any]) -> list[list[int]]:
            members: list[list[int]] = []

            def emit(keys: list[str]) -> None:
                gz = sr.gzip_member({k: bucket[k] for k in keys}, facts_level)
                if not sr.member_fits(gz) and len(keys) > 1:
                    mid = len(keys) // 2
                    emit(keys[:mid])
                    emit(keys[mid:])
                    return
                if not sr.member_fits(gz):
                    raise ValueError("single-entity fact bucket exceeds cap")
                off, length = facts_pack.add(gz)
                members.append([off, length, int(keys[-1])])

            skeys = sorted(bucket, key=int)
            if skeys:
                emit(skeys)
            return members

        for shard in range(INCIDENCE_SHARDS):
            incidence_groups = incid.read_shard(shard)
            bucket_range = incid.bucket_range(shard)
            bucket_start = bucket_range.start
            bucket_entries: list[dict[str, Any]] = [{} for _ in bucket_range]
            for key, lst in incidence_groups.items():
                lst.sort(key=lambda e: (e[0], e[1], e[2][0]))
                totals: Counter[str] = Counter(tag for _, tag, _ in lst)
                inline = lst[: sr.FACT_INLINE]
                over = lst[sr.FACT_INLINE :]
                groups: dict[str, list[list[Any]]] = defaultdict(list)
                for _, tag, tup in inline:
                    groups[tag].append(tup)
                entry: dict[str, Any] = {
                    "g": dict(groups),
                    "n": dict(totals),
                }
                inline_written += len(inline)
                if over:
                    page_rows = [[tag, *tup] for _, tag, tup in over]
                    entry["op"] = [
                        pages_pack.add(member)
                        for member in sr.gzip_pages(
                            page_rows, pages_level, sr.PAGE_SIZE
                        )
                    ]
                    paged_written += len(over)
                    del page_rows
                bucket_number = key % sr.FACT_BUCKETS
                bucket_entries[bucket_number - bucket_start][str(key)] = entry
                del lst, totals, inline, over, groups, entry
            for offset, bucket_data in enumerate(bucket_entries):
                fact_dir[bucket_start + offset] = pack_bucket(bucket_data)
            del incidence_groups, bucket_entries, bucket_data

        reconcile(
            "incidence inline + 分页",
            n_incidence,
            inline_written + paged_written,
        )
        facts_pack.write()
        write_gzip_json(
            "facts.idx",
            {"buckets": sr.FACT_BUCKETS, "b": fact_dir},
            6,
        )
        fact_q = quantiles(facts_pack.sizes)
        log(
            f"事实打包:{fact_q['members']:,} 成员,"
            f"{facts_pack.size / 1e6:,.1f}MB,最大 {fact_q['max']:,}B"
        )
        del incid, fact_dir

    # ---- 骨架边(与旧格式一致:保底 top-1 + 权重补足)----
    edges = np.concatenate(edge_key_pairs)
    edge_key_pairs.clear()
    ra = entity_ranks(rank_lookup, edges[:, 0])
    rb = entity_ranks(rank_lookup, edges[:, 1])
    if (ra == sr.RANK_SENTINEL).any() or (rb == sr.RANK_SENTINEL).any():
        raise KeyError("skeleton edge references an entity outside the layout")
    packed_edges = np.minimum(ra, rb).astype(np.uint64)
    packed_edges <<= np.uint64(21)
    packed_edges |= np.maximum(ra, rb)
    und = np.unique(packed_edges)
    del packed_edges, ra, rb
    er = np.empty((len(und), 2), dtype=np.uint32)
    er[:, 0] = und >> np.uint64(21)
    er[:, 1] = und & np.uint64((1 << 21) - 1)
    del und
    log(f"边 {len(edges):,} 行 → 无向去重 {len(er):,} 条")
    del edges
    deg = np.zeros(n, dtype=np.int64)
    np.add.at(deg, er[:, 0], 1)
    np.add.at(deg, er[:, 1], 1)
    w = (collect_r[er[:, 0]] + collect_r[er[:, 1]]) / np.sqrt(
        deg[er[:, 0]] * deg[er[:, 1]]
    )
    order_w = np.argsort(-w, kind="stable")
    ordered_edges = er[order_w]
    del er, order_w, w
    inf = len(ordered_edges)
    first = np.full(n, inf, dtype=np.int64)
    ua, ia = np.unique(ordered_edges[:, 0], return_index=True)
    first[ua] = ia
    ub, ib = np.unique(ordered_edges[:, 1], return_index=True)
    first[ub] = np.minimum(first[ub], ib)
    baseline = np.unique(first[first < inf])
    keep_mask = np.zeros(len(ordered_edges), dtype=bool)
    keep_mask[baseline] = True
    short = SKELETON_TARGET - int(keep_mask.sum())
    if short > 0:
        keep_mask[np.where(~keep_mask)[0][:short]] = True
    kept = np.where(keep_mask)[0]
    skel = ordered_edges[kept]
    if len(skel) > SKELETON_TARGET:
        log(
            f"WARNING: 骨架边 {len(skel):,} 条超出目标 "
            f"{SKELETON_TARGET:,}(保底覆盖优先)"
        )
    (SITE / "edges.bin").write_bytes(skel.tobytes())
    log(f"骨架边 {len(skel):,} 条(按权重降序,客户端前缀优先)")
    n_edges_skeleton = len(skel)
    del (
        collect_r,
        deg,
        ordered_edges,
        first,
        ua,
        ia,
        ub,
        ib,
        baseline,
        keep_mask,
        kept,
        skel,
    )

    # 名称与正文共用同一个成员级候选索引。Episode 名称先注册，正文
    # 成员随后注册；候选只定位权威成员，不复制名称负载。
    text_search = TextSearchBuilder()

    # ---- Episode 从属集合(结构记录;description 只留存在位)----
    eps_t = pq.read_table(
        PARQUET / "episode.parquet",
        columns=[
            "id",
            "name",
            "name_cn",
            "airdate",
            "disc",
            "duration",
            "sort",
            "type",
            "subject_id",
        ],
    )
    eps_desc_bits = pc.not_equal(
        pq.read_table(
            PARQUET / "episode.parquet", columns=["description"]
        ).column("description"),
        "",
    ).to_numpy(zero_copy_only=False)
    eps = eps_t.to_pydict()
    del eps_t
    n_eps = len(eps["id"])
    episode_subject_index = build_episode_subject_index(
        eps["id"], eps["subject_id"]
    )
    episode_subject_index.tofile(SITE / "episode-subject.bin")
    episode_subject_count = len(episode_subject_index)
    del episode_subject_index
    eps_by_subject: dict[int, list[list[Any]]] = defaultdict(list)
    for i in range(n_eps):
        eps_by_subject[eps["subject_id"][i]].append(
            [
                eps["id"][i],
                eps["name"][i],
                eps["name_cn"][i],
                eps["airdate"][i],
                eps["disc"][i],
                eps["duration"][i],
                eps["sort"][i],
                eps["type"][i],
                int(bool(eps_desc_bits[i])),
            ]
        )
    del eps, eps_desc_bits
    orphan_groups = sum(
        1
        for subject_id in eps_by_subject
        if entity_rank(
            rank_lookup,
            sr.entity_key(sr.KIND_SUBJECT, subject_id),
        )
        == sr.RANK_SENTINEL
    )
    orphan_eps = sum(
        len(episodes)
        for subject_id, episodes in eps_by_subject.items()
        if entity_rank(
            rank_lookup,
            sr.entity_key(sr.KIND_SUBJECT, subject_id),
        )
        == sr.RANK_SENTINEL
    )
    for episodes in eps_by_subject.values():
        episodes.sort(
            key=lambda episode: (
                episode[7],
                episode[4],
                episode[6] if episode[6] is not None else float("inf"),
                episode[0],
            )
        )
    episodes_pack = PackFile("episodes.pack")
    eps_level = sr.GZIP_LEVELS["episodes"]
    eps_items: list[tuple[int, Any]] = []
    eps_inline_rows = 0
    eps_paged_rows = 0
    for subject_id in sorted(eps_by_subject):
        episodes = eps_by_subject[subject_id]
        episode_entry: dict[str, Any] = {
            "e": episodes[: sr.EPISODE_INLINE],
            "n": len(episodes),
        }
        eps_inline_rows += len(episode_entry["e"])
        overflow = episodes[sr.EPISODE_INLINE :]
        if overflow:
            episode_entry["op"] = [
                pages_pack.add(member)
                for member in sr.gzip_pages(
                    overflow, pages_level, sr.PAGE_SIZE
                )
            ]
            eps_paged_rows += len(overflow)
        eps_items.append((subject_id, episode_entry))

    def encode_eps(chunk: list[tuple[int, Any]]) -> Any:
        return {
            "i": [item[0] for item in chunk],
            "g": [item[1] for item in chunk],
        }

    def index_episode_identities(
        loc: list[int],
        chunk: list[tuple[int, Any]],
        episode_rows: dict[int, list[list[Any]]] = eps_by_subject,
    ) -> None:
        text_search.add(
            "episode-identity",
            0,
            [0, *loc],
            (
                str(name)
                for subject_id, _entry in chunk
                for episode in episode_rows[subject_id]
                for name in episode[1:3]
                if name
            ),
        )

    eps_ranges = emit_ranged(
        episodes_pack,
        eps_items,
        sr.EPISODE_BLOCK_SUBJECTS,
        eps_level,
        encode_eps,
        index_episode_identities,
    )
    del index_episode_identities
    episodes_pack.write()
    write_gzip_json(
        "episodes.idx",
        {"width": sr.EPISODE_BLOCK_SUBJECTS, "ranges": eps_ranges},
        6,
    )
    reconcile("分集行数", n_eps, eps_inline_rows + eps_paged_rows)
    pages_pack.write()
    eps_q = quantiles(episodes_pack.sizes)
    log(
        f"分集:{len(eps_by_subject):,} 组(孤儿组 {orphan_groups:,}/"
        f"{orphan_eps:,} 条),{eps_q['members']:,} 成员,"
        f"{episodes_pack.size / 1e6:,.1f}MB"
    )
    del (
        eps_by_subject,
        eps_items,
        episodes_pack,
        eps_ranges,
        pages_pack,
    )

    # ---- 长文本侧车(四类;空值只计数,不写负载)----
    text_stats: dict[str, dict[str, Any]] = {}
    text_dir: dict[str, Any] = {}

    def text_quantile_gate(family: str, sizes: list[int]) -> None:
        q = quantiles(sizes)
        text_stats[family]["layout"] = q
        if q["p99"] > sr.TEXT_P99_CAP:
            failures.append(
                f"{family} 成员 P99 {q['p99']:,} 超体验门禁 "
                f"{sr.TEXT_P99_CAP:,};调小声明范围宽度后重建"
            )

    def emit_entity_text(family: str, columns: str) -> None:
        width = sr.TEXT_BLOCK_IDS[family]
        level = sr.GZIP_LEVELS[family]
        pack = RolloverPack(family)
        ranges: dict[str, list[list[int]]] = {}
        non_empty = 0
        empty = 0
        raw_bytes = 0
        for kind, table in (
            (sr.KIND_SUBJECT, "subject"),
            (sr.KIND_PERSON, "person"),
            (sr.KIND_CHARACTER, "character"),
        ):

            def add_entity_text_member(
                loc: list[int],
                chunk: list[tuple[int, Any]],
                selected_family: str = family,
                selected_kind: int = kind,
            ) -> None:
                text_search.add(
                    selected_family,
                    selected_kind,
                    loc,
                    (str(item[1]) for item in chunk),
                    full_text=True,
                )

            kind_ranges, kind_stats = emit_sorted_parquet_text(
                pack,
                PARQUET / f"{table}.parquet",
                columns,
                width=width,
                level=level,
                on_member=(
                    add_entity_text_member
                    if family == "entity-summary"
                    else None
                ),
            )
            ranges[str(kind)] = kind_ranges
            non_empty += kind_stats["non_empty"]
            empty += kind_stats["empty"]
            raw_bytes += kind_stats["raw_bytes"]
        pack.write()
        text_dir[family] = {
            "gzip": level,
            "width": width,
            "files": pack.files,
            "ranges": ranges,
        }
        text_stats[family] = {
            "non_empty": non_empty,
            "empty": empty,
            "raw_bytes": raw_bytes,
            "compressed_bytes": sum(pack.sizes),
        }
        text_quantile_gate(family, pack.sizes)
        log(
            f"{family}: 非空 {non_empty:,}/空 {empty:,},"
            f"{sum(pack.sizes) / 1e6:,.1f}MB"
        )

    emit_entity_text("entity-summary", "summary")
    emit_entity_text("entity-infobox", "infobox")

    # Episode description:按 SubjectKey 分组;单组超限再按 EpisodeId 拆
    family = "episode-description"
    width = sr.TEXT_BLOCK_IDS[family]
    level = sr.GZIP_LEVELS[family]
    desc_pack = RolloverPack(family)
    desc_by_subject: dict[int, list[list[Any]]] = defaultdict(list)
    desc_non_empty = 0
    desc_empty = 0
    desc_raw = 0
    desc_parquet = pq.ParquetFile(PARQUET / "episode.parquet")
    for batch in desc_parquet.iter_batches(
        batch_size=65_536,
        columns=["id", "subject_id", "description"],
    ):
        desc = batch.to_pydict()
        for episode_id, subject_id, text in zip(
            desc["id"],
            desc["subject_id"],
            desc["description"],
            strict=True,
        ):
            if text:
                desc_by_subject[subject_id].append([episode_id, text])
                desc_non_empty += 1
                desc_raw += len(text.encode("utf-8"))
            else:
                desc_empty += 1
        del desc
    for pairs in desc_by_subject.values():
        pairs.sort(key=lambda p: p[0])
    desc_ranges: list[list[int]] = []

    def emit_desc(chunk: list[tuple[int, Any]]) -> None:
        gz = sr.gzip_member(
            {"i": [c[0] for c in chunk], "t": [c[1] for c in chunk]},
            level,
        )
        if sr.member_fits(gz):
            loc = desc_pack.add(gz)
            text_search.add(
                family,
                0,
                loc,
                (
                    str(text)
                    for _sid, pairs in chunk
                    for _episode, text in pairs
                ),
                full_text=True,
            )
            desc_ranges.append([chunk[0][0], chunk[-1][0], *loc])
            return
        if len(chunk) > 1:
            mid = len(chunk) // 2
            emit_desc(chunk[:mid])
            emit_desc(chunk[mid:])
            return
        # 单 Subject 超限:按 EpisodeId 继续细分,目录行带分集边界
        sid, pairs = chunk[0]
        if len(pairs) == 1:
            raise ValueError(
                f"episode description {pairs[0][0]} exceeds member cap"
            )
        mid = len(pairs) // 2
        for part in (pairs[:mid], pairs[mid:]):
            part_gz = sr.gzip_member({"i": [sid], "t": [part]}, level)
            if not sr.member_fits(part_gz):
                emit_desc([(sid, part)])
                continue
            loc = desc_pack.add(part_gz)
            text_search.add(
                family,
                0,
                loc,
                (str(text) for _episode, text in part),
                full_text=True,
            )
            desc_ranges.append([sid, sid, *loc, part[0][0], part[-1][0]])

    desc_items = sorted(desc_by_subject.items())
    start = 0
    while start < len(desc_items):
        window = desc_items[start][0] // width
        end = start
        while end < len(desc_items) and (
            desc_items[end][0] // width == window
        ):
            end += 1
        emit_desc(desc_items[start:end])
        start = end
    del desc_by_subject, desc_items
    desc_pack.write()
    text_dir[family] = {
        "gzip": level,
        "width": width,
        "files": desc_pack.files,
        "ranges": desc_ranges,
    }
    text_stats[family] = {
        "non_empty": desc_non_empty,
        "empty": desc_empty,
        "raw_bytes": desc_raw,
        "compressed_bytes": sum(desc_pack.sizes),
    }
    text_quantile_gate(family, desc_pack.sizes)
    log(
        f"{family}: 非空 {desc_non_empty:,}/空 {desc_empty:,},"
        f"{sum(desc_pack.sizes) / 1e6:,.1f}MB"
    )

    # 事实文本(VOICE_CREDIT.summary):以 FactRef 寻址
    family = "fact-summary"
    fact_summary_dir, fact_summary_stats, fact_summary_sizes = (
        emit_fact_summary(
            fs_items,
            non_empty_count=fs_non_empty,
            empty_count=fs_empty,
            raw_bytes=fs_raw,
            on_member=lambda loc, chunk: text_search.add(
                "fact-summary",
                0,
                loc,
                (str(item[1]) for item in chunk),
                full_text=True,
            ),
        )
    )
    text_dir[family] = fact_summary_dir
    text_stats[family] = fact_summary_stats
    text_quantile_gate(family, fact_summary_sizes)
    write_gzip_json(
        "text.idx",
        {"families": text_dir},
        6,
        cap=sr.TEXT_INDEX_CAP,
    )
    del fs_items
    text_search.write()

    # ---- 显示映射 ----
    mappings, _ = collect_mappings()
    (SITE / "mappings.json").write_bytes(jdump(mappings))
    mapping_digest = sr.sha256_hex(sr.canonical_json(mappings))
    del mappings

    # ---- 搜索:规范化前缀自适应树 ----
    search_alias_block_ranks = build_search_index(names_r, cn_names_r, kind_r)
    del kind_r

    # ---- 标签表(社区标签名取社区 top 节点,位置取几何中心)----
    labels: list[list[Any]] = []
    for rank in range(min(LABELS_TOP, n)):
        labels.append([rank, str(cn_names_r[rank] or names_r[rank])])
    comm_labels = build_community_labels(comm_r, coords_r, names_r, cn_names_r)
    n_comm_total = len(np.unique(comm_r[comm_r != 0xFFFF]))
    reconcile("社区标签覆盖全部社区", n_comm_total, len(comm_labels))
    charset = sorted(
        {ch for _, t in labels for ch in str(t)}
        | {ch for cl in comm_labels.values() for ch in str(cl[0])}
    )
    (SITE / "labels.json").write_bytes(
        jdump(
            {
                "nodes": labels,
                "comm": comm_labels,
                "charset": "".join(charset),
            }
        )
    )
    log(f"标签表:节点 {len(labels):,} + 社区 {len(comm_labels):,}")

    # ---- manifest ----
    file_meta: dict[str, list[Any]] = {}
    total_bytes = 0
    n_files = 0
    text_files = {f for fam in text_dir.values() for f in fam["files"]}
    core_bytes = 0
    artifacts = sorted(SITE.iterdir())
    for fpath in artifacts:
        if fpath.name == "manifest.json":
            continue
        if not fpath.is_file():
            raise ValueError(
                f"published artifacts must be top-level files: {fpath.name}"
            )
        size = fpath.stat().st_size
        digest = sha256_of(fpath)
        physical_name = sr.published_object_name(fpath.name, digest)
        file_meta[fpath.name] = [size, digest, physical_name]
        total_bytes += size
        if fpath.name not in text_files:
            core_bytes += size
        n_files += 1
    for logical_name, (_size, _digest, physical_name) in file_meta.items():
        (SITE / logical_name).replace(SITE / physical_name)
    year_nonzero = year_r[year_r > 0]
    if len(year_nonzero):
        y_lo = int(np.clip(year_nonzero.min(), 1900, 2035))
        y_hi = int(np.clip(year_nonzero.max(), y_lo, 2035))
        n_dirty = int(((year_nonzero < 1900) | (year_nonzero > 2035)).sum())
        if n_dirty:
            log(f"  年份脏值 {n_dirty:,} 条在滑块窗口外(显式报出)")
    else:
        y_lo = y_hi = 0
    counts = {
        "entities": {
            **entity_counts,
        },
        "facts": n_facts,
        "fact_source_rows": source_rows,
        "incidence": n_incidence,
        "episodes": n_eps,
        "episode_orphan_groups": orphan_groups,
        "episode_orphan_rows": orphan_eps,
        "unresolved_voice_subject_context": voice_unresolved,
        "text": {
            fam: {
                "non_empty": st["non_empty"],
                "empty": st["empty"],
            }
            for fam, st in text_stats.items()
        },
    }
    manifest_body: dict[str, Any] = {
        "schema": sr.SCHEMA,
        "profile": sr.PROFILE,
        "source": {
            "dump_version": dump_version,
            "dump_sha256": input_identity["dump_sha256"],
            "parquet_generation": input_identity["parquet_generation"],
            "layout_input_digest": input_identity["layout_input_digest"],
            "layout_cache_identity": input_identity["layout_cache_identity"],
            "layout_artifacts": input_identity["layout_artifacts"],
        },
        "schema_digest": sr.schema_digest(),
        "field_policy": sr.FIELD_POLICY,
        "mapping_digests": {"mappings.json": mapping_digest},
        "vocab_digests": vocab_digests,
        "owned_collections": {
            "episode": {"parent": "subject", "via": "subject_id"}
        },
        "query": {
            "schema": "atlas-release-query-v1",
            "capabilities": [
                "atlas-query-v1",
                "fact-ref-v1",
                "full-text-v1",
                "subject-query-columns-v1",
                "subject-query-columns-v2",
            ],
            "contractDigest": query_schema_digest(),
            "subjectColumns": {
                "order": "source-id",
                "count": subject_source_count,
                "date": {
                    "encoding": "u16le-dictionary-v1",
                    "codes": SUBJECT_DATE_CODE_PATH,
                    "dictionary": SUBJECT_DATE_DICTIONARY_PATH,
                },
                "rank": {
                    "encoding": "u16le-zero-null-v1",
                    "values": SUBJECT_BGM_RANK_PATH,
                },
            },
        },
        "counts": counts,
        "text_bytes": {
            fam: {
                "raw": st["raw_bytes"],
                "compressed": st["compressed_bytes"],
            }
            for fam, st in text_stats.items()
        },
        "text_layout": {
            fam: {
                "width": text_dir[fam]["width"],
                "gzip": text_dir[fam]["gzip"],
                **st["layout"],
            }
            for fam, st in text_stats.items()
        },
        "limits": sr.release_limits(
            search_alias_block_ranks=search_alias_block_ranks
        ),
        "rank_index": {
            "encoding": sr.RANK_ENCODING,
            "sentinel": sr.RANK_SENTINEL,
            "segments": rank_segments,
        },
        "episode_index": {
            "encoding": "u32le-subject-id",
            "sentinel": sr.EPISODE_SUBJECT_SENTINEL,
            "count": episode_subject_count,
        },
        "fact_index": {
            "encoding": "u32le-anchor-entity-key",
            "count": n_facts,
        },
        "n_nodes": n,
        "n_edges_skeleton": n_edges_skeleton,
        "name_block_size": name_block_size,
        "position_encoding": position_encoding,
        "bbox": [lo, hi],
        "year_range": [y_lo, y_hi],
        "tags": top_tags,
        "layout": published_layout,
        "files": file_meta,
        "core_bytes": core_bytes,
        "total_bytes": total_bytes,
        "n_files": n_files,
    }
    version = sr.manifest_version(manifest_body)
    manifest = {"version": version, **manifest_body}
    publish_manifest(
        manifest,
        total_bytes=total_bytes,
        core_bytes=core_bytes,
        n_files=n_files,
        started=t_start,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=SITE,
        help="staging data directory (default: site/data)",
    )
    args = parser.parse_args()
    output = validate_output_directory(args.output)
    with parquet_layout_lock(PARQUET):
        input_identity = require_current_release_inputs(
            dump=DUMP,
            dump_zip=DUMP_ZIP,
            mappings=MAPPING_SNAPSHOT,
            parquet=PARQUET,
            layout_dir=LAYOUT_DIR,
            shape_digest=shape_digest(),
        )
        bake_release(output, input_identity)


if __name__ == "__main__":
    main()
