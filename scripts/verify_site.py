"""Independently verify the baked SiteRelease against parquet.

设计契约见 docs/STRUCTURAL_SITE_DATA_DESIGN.md §8。本脚本不复用
烘焙器的装配逻辑:自行读取 parquet 重推期望值,自行解码 site/data
字节,再做重复敏感、顺序无关的对账。任何不符以非零状态退出,
阻断发布。共享的只有 scripts/site_release.py 中的格式契约本身。
"""

from __future__ import annotations

import gzip
import hashlib
import heapq
import sys
import tempfile
import time
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import orjson
import pyarrow.parquet as pq
import site_release as sr
from content_fingerprint import RowFingerprint
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
PARQUET = ROOT / "data" / "parquet"
SITE = ROOT / "site" / "data"
SITE_ROOT = ROOT / "site"

failures: list[str] = []
artifact_files: dict[str, list[Any]] = {}
member_spans: dict[str, set[tuple[int, int]]] = defaultdict(set)
MIN_NODE_CENTER_DISTANCE = 0.28
VERIFY_BATCH_ROWS = 32_768
FACT_INDEX_DTYPE = np.dtype(
    [
        ("offset", "<u8"),
        ("length", "<u4"),
        ("multiplicity", "<u4"),
        ("incidence", "u1"),
    ]
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


def site_file(logical_name: str) -> Path:
    meta = artifact_files.get(logical_name)
    if meta is None or len(meta) != 3:
        raise ValueError(
            f"manifest missing physical object for {logical_name}"
        )
    return SITE / meta[2]


def load_member(logical_name: str, off: int, length: int) -> Any:
    path = site_file(logical_name)
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
    return orjson.loads(gzip.decompress(raw))


def load_idx(name: str) -> Any:
    return orjson.loads(gzip.decompress(site_file(name).read_bytes()))


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


def main() -> None:  # noqa: PLR0915
    global artifact_files
    t0 = time.time()
    manifest = orjson.loads((SITE / "manifest.json").read_bytes())
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
    listed = {meta[2] for meta in artifact_files.values()}
    on_disk = {
        p.name
        for p in SITE.iterdir()
        if p.is_file() and p.name != "manifest.json"
    }
    reconcile("manifest.files 覆盖全部数据文件", on_disk, listed)
    total = 0
    for fname, (size, digest, physical_name) in sorted(artifact_files.items()):
        reconcile(
            f"{fname} 内容寻址物理名",
            sr.published_object_name(fname, digest),
            physical_name,
        )
        p = SITE / physical_name
        ok = p.stat().st_size == size and sha256_of(p) == digest
        if not ok:
            check(f"{fname} 字节数与 SHA-256", False)
        total += size
        if fname.endswith(".pack") and size > sr.PACK_CAP:
            check(f"{fname} <= 80MB pack 上限", False, f"{size:,}")
    check(
        "files 字节数与摘要全部一致",
        total == manifest["total_bytes"],
        f"sum {total:,} vs total_bytes {manifest['total_bytes']:,}",
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
    key_r = np.fromfile(site_file("key.bin"), dtype="<u4")
    reconcile("key.bin 记录数", n, len(key_r))
    check("key.bin 无重复键", len(np.unique(key_r)) == n)
    positions_flat = np.fromfile(site_file("positions.bin"), dtype="<f4")
    reconcile("positions.bin 记录数", n * 3, len(positions_flat))
    if len(positions_flat) != n * 3:
        raise ValueError("positions.bin has an invalid float32 record count")
    positions = positions_flat.reshape(n, 3)
    declared_distance = manifest["layout"].get("minimum_node_center_distance")
    reconcile(
        "layout 声明全局最小节点中心距",
        MIN_NODE_CENTER_DISTANCE,
        declared_distance,
    )
    violation = find_position_overlap(positions, MIN_NODE_CENTER_DISTANCE)
    check(
        "positions.bin 所有节点不重叠",
        violation is None,
        ""
        if violation is None
        else (
            f"rank {violation[0]} / {violation[1]} 中心距 "
            f"{violation[2]:.6f} < {MIN_NODE_CENTER_DISTANCE:g}"
        ),
    )
    del positions_flat, positions
    seg_meta = manifest["rank_index"]["segments"]
    raw = np.frombuffer(site_file("rank-by-key.bin").read_bytes(), np.uint8)
    decoded: dict[int, np.ndarray] = {}
    for kind in sr.KINDS:
        seg = seg_meta[str(kind)]
        b = raw[seg["offset"] : seg["offset"] + seg["count"] * 3]
        u32 = (
            b[0::3].astype(np.uint32)
            | (b[1::3].astype(np.uint32) << 8)
            | (b[2::3].astype(np.uint32) << 16)
        )
        decoded[kind] = u32
    non_sentinel = sum(
        int((v != sr.RANK_SENTINEL).sum()) for v in decoded.values()
    )
    reconcile("rank-by-key 覆盖数 = 节点数", n, non_sentinel)
    ok_rank = True
    for rank, key in enumerate(key_r):
        k = int(key)
        if decoded[k >> 24][k & sr.MAX_SOURCE_ID] != rank:
            ok_rank = False
            break
    check("rank-by-key[key] = rank(全量)", ok_rank)

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
    name_idx = np.fromfile(site_file("names.idx"), dtype="<u4")
    block = manifest["name_block_size"]
    names_by_rank: list[list[Any]] = []
    name_sizes: list[int] = []
    for bi in range(len(name_idx) - 1):
        off, end = int(name_idx[bi]), int(name_idx[bi + 1])
        name_sizes.append(end - off)
        names_by_rank.extend(load_member("names.pack", off, end - off))
    reconcile("names 行数", n, len(names_by_rank))
    check(
        "名称成员 P99 体验门禁",
        quantile(name_sizes, 0.99) <= sr.NAME_P99_CAP,
    )
    check("名称成员硬上限", max(name_sizes) <= sr.MEMBER_CAP)
    reconcile("names 块宽声明", block, manifest["name_block_size"])

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
        for row in ranges:
            start, end, off, length = row
            ent_sizes.append(length)
            member = load_member("entities.pack", off, length)
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
                    site_ent_fp.add(
                        [
                            kind,
                            sid,
                            nm[0],
                            nm[1] or "",
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
                    ptyp, careers, comments, collects, hs, hi = tup
                    site_ent_fp.add(
                        [
                            kind,
                            sid,
                            nm[0],
                            ptyp,
                            [vocab["career"][c] for c in careers],
                            comments,
                            collects,
                        ]
                    )
                else:
                    role, comments, collects, hs, hi = tup
                    site_ent_fp.add(
                        [kind, sid, nm[0], role, comments, collects]
                    )
                presence[kind_s][sid] = int(hs) | (int(hi) << 1)
                ent_counts[kind] += 1
    for kind_name, kind in (("subject", 1), ("person", 2), ("character", 3)):
        reconcile(
            f"实体计数 {kind_name}",
            manifest["counts"]["entities"][kind_name],
            ent_counts[kind],
        )
    check("实体成员硬上限", max(ent_sizes) <= sr.MEMBER_CAP)

    pq_ent_fp = RowFingerprint()
    subject_columns = [
        "id",
        "name",
        "name_cn",
        "type",
        "platform_code",
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
            pq_ent_fp.add(
                [
                    1,
                    sub["id"][i],
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
    del key_r, raw, site_ent_fp, pq_ent_fp

    # ---- 文本侧车:非空/空计数、字节数、指纹、存在位 ----
    log("[5] 文本侧车")
    text_idx = load_idx("text.idx")["families"]

    def verify_entity_text(family: str, column: str, bit: int) -> None:
        fam = text_idx[family]
        fp_site = RowFingerprint()
        sizes: list[int] = []
        seen_count = 0
        raw_bytes = 0
        seen_by_kind: dict[str, np.ndarray] = {
            str(kind): np.zeros(len(decoded[kind]), dtype=np.bool_)
            for kind in sr.KINDS
        }
        for kind_s, ranges in fam["ranges"].items():
            for start, end, fidx, off, length in ranges:
                sizes.append(length)
                m = load_member(fam["files"][fidx], off, length)
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
                    bits = int(presence[str(kind)][source_id])
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

    verify_entity_text("entity-summary", "summary", 0)
    verify_entity_text("entity-infobox", "infobox", 1)

    # episode-description:识别 (subject, episode) 唯一定位
    fam = text_idx["episode-description"]
    desc_site: set[tuple[int, int]] = set()
    fp_site = RowFingerprint()
    sizes = []
    desc_raw = 0
    for row in fam["ranges"]:
        start, end, fidx, off, length = row[:5]
        sizes.append(length)
        m = load_member(fam["files"][fidx], off, length)
        for sid, pairs in zip(m["i"], m["t"], strict=True):
            for epid, text in pairs:
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

    # fact-summary:当前全空快照必须产生零负载 + 规范空目录
    fam = text_idx["fact-summary"]
    fact_summary: dict[int, str] = {}
    for _start, _end, fidx, off, length in fam["ranges"]:
        m = load_member(fam["files"][fidx], off, length)
        for ref, text in zip(m["i"], m["t"], strict=True):
            fact_summary[ref] = text
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

    # ---- 分集结构 ----
    log("[6] 分集结构")
    eps_idx = load_idx("episodes.idx")
    pages_path = "pages.pack"
    site_ep_fp = RowFingerprint()
    ep_rows_seen = 0
    orphan_groups = 0
    eps_sizes: list[int] = []
    seen_sids: set[int] = set()
    for start, end, off, length in eps_idx["ranges"]:
        eps_sizes.append(length)
        m = load_member("episodes.pack", off, length)
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
    pq_ep_fp = RowFingerprint()
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
        "分集内容指纹 = parquet", site_ep_fp.snapshot() == pq_ep_fp.snapshot()
    )
    reconcile("分集行数", manifest["counts"]["episodes"], ep_rows_seen)
    reconcile(
        "孤儿分组数",
        manifest["counts"]["episode_orphan_groups"],
        orphan_groups,
    )
    check("分集成员硬上限", max(eps_sizes) <= sr.MEMBER_CAP)
    decoded.clear()
    presence.clear()
    del desc_site, site_ep_fp, pq_ep_fp

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
            seen_incidence = np.zeros(n_facts, dtype=np.uint8)
            n_inc_seen = 0
            fact_sizes: list[int] = []
            ok_incidence = True
            for bucket_i, members in enumerate(facts_idx["b"]):
                for off, length, _last_key in members:
                    fact_sizes.append(length)
                    member = load_member("facts.pack", off, length)
                    for key_s, entry in member.items():
                        key = int(key_s)
                        if key % sr.FACT_BUCKETS != bucket_i:
                            check("事实桶键归属", False, key_s)
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
                            check("事实条目分组计数", False, key_s)
                        for tag, tup in items:
                            f_kind = tag_to_kind[tag]
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
                            if ref < 0 or ref >= n_facts:
                                ok_incidence = False
                            else:
                                exp_enc, exp_mult, _exp_inc = expected.lookup(
                                    ref
                                )
                                if enc != exp_enc or mult != exp_mult:
                                    ok_incidence = False
                                else:
                                    seen_incidence[ref] += 1
                            n_inc_seen += 1
            check(
                "每条 incidence 还原为同一规范事实与 FactRef",
                ok_incidence,
            )
            check(
                "每个事实在每个参与者下恰好一条 incidence",
                bool((seen_incidence == expected.incidence_counts).all()),
            )
            reconcile(
                "incidence 总数",
                manifest["counts"]["incidence"],
                n_inc_seen,
            )
            check("事实成员硬上限", max(fact_sizes) <= sr.MEMBER_CAP)
        finally:
            expected.close()
    del fact_summary, seen_incidence

    # ---- 搜索:自适应前缀树与全量排序一致 ----
    log("[8] 搜索索引")
    charmap = orjson.loads(site_file("charmap.json").read_bytes())

    def fold(text: str) -> str:
        t = text.strip().lower()
        return "".join(charmap.get(ch, ch) for ch in t)

    search_dir = orjson.loads(site_file("search.idx.json").read_bytes())
    by_prefix: dict[str, list[list[Any]]] = {
        prefix: [] for prefix in search_dir
    }
    uncovered_entry: str | None = None
    for rank in range(n):
        nm = names_by_rank[rank]
        for text in dict.fromkeys(t for t in (nm[0], nm[1] or "") if t):
            nk = fold(text)
            if not nk:
                continue
            matched = False
            for plen in range(1, len(nk) + 1):
                p = nk[:plen]
                node = search_dir.get(p)
                if node is None:
                    break
                matched = True
                expected_items = by_prefix[p]
                if "l" in node or len(expected_items) < sr.SEARCH_TOP:
                    expected_items.append([nk, text, rank])
            if not matched and uncovered_entry is None:
                uncovered_entry = nk[:8]
    ok_search = True
    search_max = 0
    for prefix, node in search_dir.items():
        exp_items = by_prefix[prefix]
        if "l" in node:
            if set(node) != {"l"}:
                ok_search = False
            off, length = node["l"]
            search_max = max(search_max, length)
            got = load_member("search.pack", off, length)
            if got != exp_items:
                ok_search = False
        else:
            if set(node) != {"t"}:
                ok_search = False
            off, length = node["t"]
            search_max = max(search_max, length)
            got = load_member("search.pack", off, length)
            if got != exp_items[: sr.SEARCH_TOP]:
                ok_search = False
    check("搜索叶与内部 top-12 与全量排序一致", ok_search)
    check(
        "搜索成员 <= 64,000",
        search_max <= sr.SEARCH_LEAF_CAP,
        f"max {search_max:,}",
    )
    check(
        "搜索目录覆盖全部条目",
        uncovered_entry is None,
        uncovered_entry or "",
    )
    del by_prefix, names_by_rank

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
        for values in iter_parquet_dict_batches(
            PARQUET / f"{table}.parquet", [code_col, name_col]
        ):
            if not all(
                (not name and str(code) not in table_map)
                or table_map.get(str(code)) == name
                for code, name in zip(
                    values[code_col], values[name_col], strict=True
                )
            ):
                ok_map = False
                break
        check(f"mappings.{kind_name} 与 parquet 解码一致", ok_map)

    elapsed = time.time() - t0
    if failures:
        log(
            f"FAILED: {len(failures)} 处不符 ({elapsed:,.0f}s): "
            f"{failures[:10]}"
        )
        sys.exit(1)
    log(f"verify_site: all checks passed in {elapsed:,.0f}s")


if __name__ == "__main__":
    main()
