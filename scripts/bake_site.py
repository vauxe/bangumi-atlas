"""Bake the structural SiteRelease from parquet + layout.

契约见 docs/STRUCTURAL_SITE_DATA_DESIGN.md 与 scripts/site_release.py。

产物:site/data/ 下 manifest.json、几何 SoA bins、rank-by-key.bin、
names pack(2,048 rank/成员)、entities/facts/episodes pack(词表、
FactRef incidence、存在位)、四类长文本侧车 + text.idx、自适应前缀
搜索、vocab、mappings.json、pages.pack、骨架边、标签表。
纪律:失败与截断显式报出、行级对账,对不上非零退出;
成员超 256,000 字节在稳定身份边界自动细分,门禁失败即终止。
"""

import argparse
import hashlib
import shutil
import sys
import time
from collections import Counter, defaultdict
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import numpy as np
import orjson
import pyarrow.compute as pc
import pyarrow.parquet as pq
import site_release as sr
from community_labels import build_community_labels
from layout import shape_digest
from opencc import OpenCC
from site_contracts import (
    read_dump_version,
    require_parquet_matches_dump,
    validate_layout_report,
    validate_name_pack,
)
from world_scale import CANONICAL_WORLD_SPAN, normalize_world_scale

ROOT = Path(__file__).resolve().parent.parent
PARQUET = ROOT / "data" / "parquet"
LAYOUT = ROOT / "data" / "layout" / "coords.parquet"
LAYOUT_REPORT = ROOT / "data" / "layout" / "report.json"
DUMP_VERSION = ROOT / "data" / "dump" / "VERSION"
DUMP_ZIP = ROOT / "data" / "dump.zip"
SITE = ROOT / "site" / "data"

SKELETON_TARGET = 500_000  # 传输目标;连通节点覆盖优先,超限显式报出
LABELS_TOP = 20_000
SIZE_BUDGET = 1_000_000_000  # GH Pages 1GB 硬限(发布门禁按 site/ 全量)
SIZE_WARN = 900_000_000
FILE_BUDGET = 20_000  # CF Pages 迁移预案的文件数上限

# 人物类型与角色分类没有上游映射文件;这是站点显示映射的权威声明,
# 参与 mappings.json 摘要。未覆盖的原始码由客户端按数值显示。
PERSON_TYPE_NAMES = {1: "个人", 2: "公司", 3: "组合"}
CHARACTER_ROLE_NAMES = {1: "角色", 2: "机体", 3: "舰船", 4: "组织"}

failures: list[str] = []

# 归一链:日文新字体 → 繁体(jp2t) → 简体(t2s),再小写。
# 契约:索引键与客户端查询从同一张单字映射表逐字折叠。
_jp2t = OpenCC("jp2t")
_t2s = OpenCC("t2s")


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
    return orjson.dumps(obj, option=orjson.OPT_NON_STR_KEYS)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


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


class PackFile:
    """单文件 pack:独立 gzip 成员连续写入,返回 [offset, length]。"""

    def __init__(self, name: str) -> None:
        self.name = name
        self.blob = bytearray()
        self.sizes: list[int] = []

    def add(self, gz: bytes) -> list[int]:
        sr.require_member_size(gz, self.name)
        off = len(self.blob)
        self.blob += gz
        self.sizes.append(len(gz))
        return [off, len(gz)]

    def add_json(self, obj: Any, level: int) -> list[int]:
        return self.add(sr.gzip_member(obj, level))

    def write(self) -> None:
        if len(self.blob) > sr.PACK_CAP:
            failures.append(f"{self.name} 超过单 pack 80MB 上限")
        (SITE / self.name).write_bytes(bytes(self.blob))


class RolloverPack:
    """跨文件 pack 序列:在成员边界滚动到下一文件,单文件 <= 80MB。

    即使没有任何成员也写出一个零长度文件——某类文本全空时以
    规范空目录 + 零长度 pack 表达,不能靠缺文件表达“没有内容”。
    """

    def __init__(self, stem: str) -> None:
        self.stem = stem
        self.blobs: list[bytearray] = [bytearray()]
        self.sizes: list[int] = []

    def add(self, gz: bytes) -> list[int]:
        sr.require_member_size(gz, self.stem)
        if len(self.blobs[-1]) + len(gz) > sr.PACK_CAP:
            self.blobs.append(bytearray())
        file_idx = len(self.blobs) - 1
        off = len(self.blobs[file_idx])
        self.blobs[file_idx] += gz
        self.sizes.append(len(gz))
        return [file_idx, off, len(gz)]

    @property
    def files(self) -> list[str]:
        return [f"{self.stem}-{i}.pack" for i in range(len(self.blobs))]

    def write(self) -> None:
        for fname, blob in zip(self.files, self.blobs, strict=True):
            (SITE / fname).write_bytes(bytes(blob))


def emit_ranged(
    pack: PackFile | RolloverPack,
    items: list[tuple[int, Any]],
    width: int,
    level: int,
    encode: Callable[[list[tuple[int, Any]]], Any],
) -> list[list[int]]:
    """按身份窗口切成员;成员超 256,000 字节时按身份中点递归细分。

    items 按身份升序;返回 [start, end, *loc] 目录行(闭区间)。
    单条身份仍超限时抛错——必须升级 profile,不能截断。
    """
    ranges: list[list[int]] = []

    def emit(chunk: list[tuple[int, Any]]) -> None:
        gz = sr.gzip_member(encode(chunk), level)
        if len(gz) > sr.MEMBER_CAP:
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


def load_layout() -> dict[str, np.ndarray]:
    t = pq.read_table(LAYOUT)
    return {c: np.asarray(t.column(c)) for c in t.column_names}


def fold_factory(
    charmap: dict[str, str],
) -> Callable[[str], str]:
    def fold(text: str) -> str:
        t = text.strip().lower()
        return "".join(charmap.get(ch, ch) for ch in t)

    return fold


def build_charmap(chars: set[str]) -> tuple[dict[str, str], int]:
    """返回 (单字映射表, 被丢弃的多字映射数)。丢弃必须显式报出。"""
    charmap = {}
    dropped = 0
    for c in sorted(chars):
        m = _t2s.convert(_jp2t.convert(c))
        if m == c:
            continue
        if len(m) == 1:
            charmap[c] = m
        else:
            dropped += 1
    return charmap, dropped


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
    }
    return mappings, unresolved


def main() -> None:  # noqa: PLR0915
    argparse.ArgumentParser().parse_args()
    t_start = time.time()
    dump_version = read_dump_version(DUMP_VERSION)
    # 烘焙读 Parquet,版本号却取自 dump:落后的 Parquet 会被贴上
    # 当前 dump 的版本号发布出去(只重跑烘焙时尤其容易发生)
    require_parquet_matches_dump(
        dump_version, read_dump_version(PARQUET / "VERSION")
    )
    if not LAYOUT_REPORT.exists():
        sys.exit("FAILED: data/layout/report.json 缺失,先运行 layout.py")
    layout_report = validate_layout_report(
        orjson.loads(LAYOUT_REPORT.read_bytes()),
        shape_digest=shape_digest(),
    )
    shutil.rmtree(SITE, ignore_errors=True)
    SITE.mkdir(parents=True, exist_ok=True)

    lay = load_layout()
    n = len(lay["key"])
    assert n < (1 << 21), "边去重编码假设节点数 < 2^21"
    assert n < sr.RANK_SENTINEL, "VisualRank 必须小于 u24 哨兵,升级格式"
    order = np.argsort(-lay["collect"], kind="stable")
    key_r = lay["key"][order].astype(np.uint32)  # rank -> key
    year_r = lay["year"][order].astype(np.uint16)
    comm_r = lay["community"][order].astype(np.uint16)
    iso_r = lay["isolated"][order]
    collect_r = lay["collect"][order]
    coords_r = np.stack(
        [lay["x"][order], lay["y"][order], lay["z"][order]], axis=1
    )
    # UMAP 输出尺度任意;发布坐标归一到规范世界跨度,保证探索端
    # 绝对 zoom 档位(标签切换/骨架边显隐/聚焦层级)的既定语义
    coords_r, world_scale = normalize_world_scale(coords_r)
    rank_of_key: dict[int, int] = {int(k): i for i, k in enumerate(key_r)}
    log(
        f"节点 {n:,},rank 排序完成(dump 版本 {dump_version}),"
        f"世界尺度 ×{world_scale:.3f} → 跨度 {CANONICAL_WORLD_SPAN:g}"
    )

    # ---- 实体结构列(文本只取存在位;字符串本体走侧车流程)----
    sub_t = pq.read_table(
        PARQUET / "subject.parquet",
        columns=[
            "id",
            "type",
            "name",
            "name_cn",
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
        ],
    )
    sub_text_bits = {
        "summary": pc.not_equal(
            pq.read_table(
                PARQUET / "subject.parquet", columns=["summary"]
            ).column("summary"),
            "",
        ).to_numpy(zero_copy_only=False),
        "infobox": pc.not_equal(
            pq.read_table(
                PARQUET / "subject.parquet", columns=["infobox"]
            ).column("infobox"),
            "",
        ).to_numpy(zero_copy_only=False),
    }
    sub = sub_t.to_pydict()
    del sub_t
    per_t = pq.read_table(
        PARQUET / "person.parquet",
        columns=[
            "id",
            "name",
            "type",
            "career",
            "comments",
            "collects",
            "summary",
            "infobox",
        ],
    )
    per = per_t.to_pydict()
    del per_t
    cha_t = pq.read_table(
        PARQUET / "character.parquet",
        columns=[
            "id",
            "name",
            "role",
            "comments",
            "collects",
            "summary",
            "infobox",
        ],
    )
    cha = cha_t.to_pydict()
    del cha_t

    # info: 几何标志、名字、搜索与标签所需的最小视图
    info: dict[int, dict[str, Any]] = {}
    for i in range(len(sub["id"])):
        k = sr.entity_key(sr.KIND_SUBJECT, sub["id"][i])
        info[k] = {
            "name": sub["name"][i],
            "cn": sub["name_cn"][i],
            "nsfw": sub["nsfw"][i],
            "media": sub["type"][i],
            "mt": sub["meta_tags"][i],
            "score": sub["score"][i],
        }
    for i in range(len(per["id"])):
        k = sr.entity_key(sr.KIND_PERSON, per["id"][i])
        info[k] = {"name": per["name"][i], "cn": "", "nsfw": False}
    for i in range(len(cha["id"])):
        k = sr.entity_key(sr.KIND_CHARACTER, cha["id"][i])
        info[k] = {"name": cha["name"][i], "cn": "", "nsfw": False}
    covered = sum(1 for k in key_r if int(k) in info)
    reconcile("节点属性覆盖全部入图节点", n, covered)
    reconcile("库实体数 = 入图节点数", len(info), n)
    if failures:
        sys.exit(f"FAILED: 布局与库不同步({failures}),先重跑 layout.py 再烘焙")

    # ---- 几何 SoA(25B/节点,定长记录支持 Range 点查)----
    coords_f32 = coords_r.astype("<f4")
    lo = [float(v) for v in coords_f32.min(0)]
    hi = [float(v) for v in coords_f32.max(0)]
    (SITE / "positions.bin").write_bytes(coords_f32.tobytes())
    (SITE / "year.bin").write_bytes(year_r.tobytes())
    (SITE / "key.bin").write_bytes(key_r.tobytes())
    size_raw = np.round(18 * np.log2(1 + collect_r))
    clamped = int((size_raw > 255).sum())
    if clamped:
        log(f"  截断:size_u8 到顶 255 的节点 {clamped:,} 个(显式报出)")
    size_u8 = np.minimum(255, size_raw).astype(np.uint8)
    (SITE / "size.bin").write_bytes(size_u8.tobytes())
    flags = np.zeros(n, dtype=np.uint8)
    nsfw_arr = np.array(
        [bool(info[int(k)]["nsfw"]) for k in key_r], dtype=bool
    )
    flags |= nsfw_arr.astype(np.uint8)
    flags |= (iso_r.astype(np.uint8)) << 1
    media_vals = np.array(
        [int(info[int(k)].get("media", 0)) for k in key_r], dtype=np.int64
    )
    assert media_vals.max() < 8, "media 超出 flags bit2-4 容量,契约需扩位"
    flags |= (media_vals.astype(np.uint8)) << 2
    (SITE / "flags.bin").write_bytes(flags.tobytes())
    score_u8 = np.zeros(n, dtype=np.uint8)
    for i, k in enumerate(key_r):
        s = info[int(k)].get("score")
        if s:
            score_u8[i] = int(round(float(s) * 10))
    (SITE / "score.bin").write_bytes(score_u8.tobytes())
    tag_counts: Counter[str] = Counter()
    for k in key_r:
        tag_counts.update(info[int(k)].get("mt") or [])
    top_tags = [t for t, _ in tag_counts.most_common(32)]
    tag_bit = {t: i for i, t in enumerate(top_tags)}
    tag_mask = np.zeros(n, dtype=np.uint32)
    for i, k in enumerate(key_r):
        m = 0
        for tg in info[int(k)].get("mt") or []:
            b = tag_bit.get(tg)
            if b is not None:
                m |= 1 << b
        tag_mask[i] = m
    (SITE / "tags.bin").write_bytes(tag_mask.tobytes())
    for fname, stride in (
        ("positions.bin", 12),
        ("year.bin", 2),
        ("key.bin", 4),
        ("size.bin", 1),
        ("flags.bin", 1),
        ("score.bin", 1),
        ("tags.bin", 4),
    ):
        reconcile(f"{fname} 字节数", n * stride, (SITE / fname).stat().st_size)
    log("几何 SoA 写出完成")

    # ---- rank-by-key.bin:按实体种类拼接的 u24 反向索引 ----
    rank_segments: dict[str, dict[str, int]] = {}
    rank_buf = bytearray()
    for kind in sr.KINDS:
        ids = [
            int(k) & sr.MAX_SOURCE_ID for k in key_r if int(k) >> 24 == kind
        ]
        count = (max(ids) + 1) if ids else 0
        seg = np.full(count, sr.RANK_SENTINEL, dtype="<u4")
        for k, rank in rank_of_key.items():
            if k >> 24 == kind:
                seg[k & sr.MAX_SOURCE_ID] = rank
        as_u8 = seg.view(np.uint8).reshape(-1, 4)[:, :3]
        rank_segments[str(kind)] = {
            "offset": len(rank_buf),
            "count": count,
        }
        rank_buf += as_u8.tobytes()
    (SITE / "rank-by-key.bin").write_bytes(bytes(rank_buf))
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
            rows = []
            for k in key_r[start : start + name_block_size]:
                d = info[int(k)]
                rows.append([d["name"], d["cn"] or None])
            gz = sr.gzip_member(rows, sr.GZIP_LEVELS["names"])
            if len(gz) > sr.MEMBER_CAP:
                oversize = True
                break
            off, length = name_pack.add(gz)
            name_offsets.append(off + length)
        if not oversize:
            break
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

    # ---- 词表(career / meta_tags / tags.name)----
    career_vocab = vocab_sorted({c for lst in per["career"] for c in lst})
    meta_vocab = vocab_sorted({t for lst in sub["meta_tags"] for t in lst})
    tag_vocab = vocab_sorted({tg["name"] for lst in sub["tags"] for tg in lst})
    career_id = {s: i for i, s in enumerate(career_vocab)}
    meta_id = {s: i for i, s in enumerate(meta_vocab)}
    tag_id = {s: i for i, s in enumerate(tag_vocab)}
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
        if len(gz) > sr.MEMBER_CAP:
            sys.exit("FAILED: tags 词表成员超上限,缩小分块")
        vocab_dir["tags"].append(vocab_pack.add(gz))
    vocab_pack.write()
    (SITE / "vocab.idx").write_bytes(
        sr.gzip_member({"chunk": 8192, "members": vocab_dir}, 6)
    )
    vocab_digests = {
        "career": sr.sha256_hex(sr.canonical_json(career_vocab)),
        "meta_tags": sr.sha256_hex(sr.canonical_json(meta_vocab)),
        "tags": sr.sha256_hex(sr.canonical_json(tag_vocab)),
    }
    log(
        f"词表:career {len(career_vocab):,}、meta {len(meta_vocab):,}、"
        f"tags {len(tag_vocab):,}"
    )

    # ---- 实体结构 pack(除名称与长文本外的全部字段)----
    entities_pack = PackFile("entities.pack")
    ent_level = sr.GZIP_LEVELS["entities"]
    ent_ranges: dict[str, list[list[int]]] = {}
    sub_rows: list[tuple[int, Any]] = []
    for i in range(len(sub["id"])):
        sub_rows.append(
            (
                sub["id"][i],
                [
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
                    [meta_id[t] for t in sub["meta_tags"][i]],
                    [[tag_id[t["name"]], t["count"]] for t in sub["tags"][i]],
                    int(bool(sub_text_bits["summary"][i])),
                    int(bool(sub_text_bits["infobox"][i])),
                ],
            )
        )
    sub_rows.sort(key=lambda r: r[0])
    per_rows: list[tuple[int, Any]] = []
    for i in range(len(per["id"])):
        per_rows.append(
            (
                per["id"][i],
                [
                    per["type"][i],
                    [career_id[c] for c in per["career"][i]],
                    per["comments"][i],
                    per["collects"][i],
                    int(bool(per["summary"][i])),
                    int(bool(per["infobox"][i])),
                ],
            )
        )
    per_rows.sort(key=lambda r: r[0])
    cha_rows: list[tuple[int, Any]] = []
    for i in range(len(cha["id"])):
        cha_rows.append(
            (
                cha["id"][i],
                [
                    cha["role"][i],
                    cha["comments"][i],
                    cha["collects"][i],
                    int(bool(cha["summary"][i])),
                    int(bool(cha["infobox"][i])),
                ],
            )
        )
    cha_rows.sort(key=lambda r: r[0])

    def encode_rows(chunk: list[tuple[int, Any]]) -> Any:
        return {"i": [c[0] for c in chunk], "r": [c[1] for c in chunk]}

    for ent_kind, ent_rows in (
        (sr.KIND_SUBJECT, sub_rows),
        (sr.KIND_PERSON, per_rows),
        (sr.KIND_CHARACTER, cha_rows),
    ):
        ent_ranges[str(ent_kind)] = emit_ranged(
            entities_pack,
            ent_rows,
            sr.ENTITY_BLOCK_IDS,
            ent_level,
            encode_rows,
        )
    entities_pack.write()
    (SITE / "entities.idx").write_bytes(
        sr.gzip_member({"width": sr.ENTITY_BLOCK_IDS, "k": ent_ranges}, 6)
    )
    reconcile(
        "实体结构行数",
        n,
        len(sub_rows) + len(per_rows) + len(cha_rows),
    )
    ent_q = quantiles(entities_pack.sizes)
    log(
        f"实体结构:{ent_q['members']:,} 成员,"
        f"{len(entities_pack.blob) / 1e6:,.1f}MB,最大 {ent_q['max']:,}B"
    )

    # ---- 事实:规范编码 → FactRef → incidence 分桶 ----
    log("事实规范化…")
    fact_rows: dict[str, list[tuple[tuple[int, ...], tuple[Any, ...]]]] = {}
    edge_key_pairs: list[np.ndarray] = []  # 骨架边输入(key 对)

    def read_cols(table: str, cols: list[str]) -> dict[str, list[Any]]:
        return pq.read_table(
            PARQUET / f"{table}.parquet", columns=cols
        ).to_pydict()

    rel = read_cols(
        "relates_to", ["from_id", "to_id", "relation_type", "sort_order"]
    )
    fact_rows["RELATES_TO"] = [
        (
            (
                sr.entity_key(sr.KIND_SUBJECT, rel["from_id"][i]),
                sr.entity_key(sr.KIND_SUBJECT, rel["to_id"][i]),
            ),
            (rel["relation_type"][i], rel["sort_order"][i]),
        )
        for i in range(len(rel["from_id"]))
    ]
    wo = read_cols("worked_on", ["from_id", "to_id", "position", "appear_eps"])
    fact_rows["WORKED_ON"] = [
        (
            (
                sr.entity_key(sr.KIND_PERSON, wo["from_id"][i]),
                sr.entity_key(sr.KIND_SUBJECT, wo["to_id"][i]),
            ),
            (wo["position"][i], wo["appear_eps"][i]),
        )
        for i in range(len(wo["from_id"]))
    ]
    ap = read_cols("appears_in", ["from_id", "to_id", "type", "sort_order"])
    fact_rows["APPEARS_IN"] = [
        (
            (
                sr.entity_key(sr.KIND_CHARACTER, ap["from_id"][i]),
                sr.entity_key(sr.KIND_SUBJECT, ap["to_id"][i]),
            ),
            (ap["type"][i], ap["sort_order"][i]),
        )
        for i in range(len(ap["from_id"]))
    ]
    vo = read_cols(
        "voiced", ["from_id", "to_id", "subject_id", "type", "summary"]
    )
    fact_rows["VOICE_CREDIT"] = [
        (
            (
                sr.entity_key(sr.KIND_PERSON, vo["from_id"][i]),
                sr.entity_key(sr.KIND_CHARACTER, vo["to_id"][i]),
                sr.entity_key(sr.KIND_SUBJECT, vo["subject_id"][i]),
            ),
            (vo["type"][i], vo["summary"][i]),
        )
        for i in range(len(vo["from_id"]))
    ]
    pr = read_cols(
        "person_rel",
        ["from_id", "to_id", "relation_type", "spoiler", "ended"],
    )
    fact_rows["PERSON_REL"] = [
        (
            (
                sr.entity_key(sr.KIND_PERSON, pr["from_id"][i]),
                sr.entity_key(sr.KIND_PERSON, pr["to_id"][i]),
            ),
            (
                pr["relation_type"][i],
                int(pr["spoiler"][i]),
                int(pr["ended"][i]),
            ),
        )
        for i in range(len(pr["from_id"]))
    ]
    cr = read_cols(
        "character_rel",
        ["from_id", "to_id", "relation_type", "spoiler", "ended"],
    )
    fact_rows["CHARACTER_REL"] = [
        (
            (
                sr.entity_key(sr.KIND_CHARACTER, cr["from_id"][i]),
                sr.entity_key(sr.KIND_CHARACTER, cr["to_id"][i]),
            ),
            (
                cr["relation_type"][i],
                int(cr["spoiler"][i]),
                int(cr["ended"][i]),
            ),
        )
        for i in range(len(cr["from_id"]))
    ]
    del rel, wo, ap, pr, cr

    source_rows = sum(len(v) for v in fact_rows.values())
    fact_mult: dict[bytes, int] = defaultdict(int)
    fact_meta: dict[bytes, tuple[str, tuple[int, ...], tuple[Any, ...]]] = {}
    for fact_kind, kind_rows in fact_rows.items():
        for f_parts, f_attrs in kind_rows:
            enc = sr.canonical_fact(fact_kind, f_parts, f_attrs)
            fact_mult[enc] += 1
            if enc not in fact_meta:
                fact_meta[enc] = (fact_kind, f_parts, f_attrs)
        # 骨架边:每行首两个参与者(VOICE_CREDIT 取 person-character)
        ea = np.asarray([p[0][0] for p in kind_rows], dtype=np.uint32)
        eb = np.asarray([p[0][1] for p in kind_rows], dtype=np.uint32)
        edge_key_pairs.append(np.stack([ea, eb], axis=1))
    del fact_rows
    merged_rows = source_rows - sum(fact_mult.values()) + len(fact_mult)
    fact_refs = {enc: i for i, enc in enumerate(sorted(fact_mult))}
    n_facts = len(fact_refs)
    log(
        f"事实 {source_rows:,} 行 → {n_facts:,} 个"
        f"(合并完全重复 {source_rows - n_facts:,} 行,"
        f"multiplicity 保留;去重敏感对账 {merged_rows:,})"
    )

    # incidence:每个不同参与者一条;写入桶前按热度排序
    voice_unresolved = 0
    incid: dict[int, list[tuple[int, str, list[Any]]]] = defaultdict(list)
    n_incidence = 0
    for enc, ref in fact_refs.items():
        inc_kind, inc_parts, inc_attrs = fact_meta[enc]
        mult = fact_mult[enc]
        if inc_kind == "VOICE_CREDIT":
            disk_attrs: tuple[Any, ...] = (
                inc_attrs[0],
                int(bool(inc_attrs[1])),
            )
            if inc_parts[2] not in info:
                voice_unresolved += 1
        else:
            disk_attrs = inc_attrs
        for inc_key in dict.fromkeys(inc_parts):
            tup = sr.incidence_tuple(ref, mult, inc_key, inc_parts, disk_attrs)
            others = cast("list[int]", tup[3])
            heat = min(
                (rank_of_key.get(o, sr.RANK_SENTINEL) for o in others),
                default=rank_of_key.get(inc_key, sr.RANK_SENTINEL),
            )
            incid[inc_key].append((heat, sr.FACT_TAGS[inc_kind], tup))
            n_incidence += 1
    del fact_meta, fact_mult
    log(f"incidence {n_incidence:,} 条,覆盖实体 {len(incid):,}")

    pages_pack = PackFile("pages.pack")
    pages_level = sr.GZIP_LEVELS["pages"]
    facts_pack = PackFile("facts.pack")
    facts_level = sr.GZIP_LEVELS["facts"]
    bucket_entries: list[dict[str, Any]] = [
        dict() for _ in range(sr.FACT_BUCKETS)
    ]
    inline_written = 0
    paged_written = 0
    for key, lst in incid.items():
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
        bucket_entries[key % sr.FACT_BUCKETS][str(key)] = entry
    del incid
    reconcile(
        "incidence inline + 分页", n_incidence, inline_written + paged_written
    )

    def pack_bucket(bucket: dict[str, Any]) -> list[list[int]]:
        members: list[list[int]] = []

        def emit(keys: list[str]) -> None:
            gz = sr.gzip_member({k: bucket[k] for k in keys}, facts_level)
            if len(gz) > sr.MEMBER_CAP and len(keys) > 1:
                mid = len(keys) // 2
                emit(keys[:mid])
                emit(keys[mid:])
                return
            if len(gz) > sr.MEMBER_CAP:
                raise ValueError("single-entity fact bucket exceeds cap")
            off, length = facts_pack.add(gz)
            members.append([off, length, int(keys[-1])])

        skeys = sorted(bucket, key=int)
        if skeys:
            emit(skeys)
        return members

    fact_dir = [pack_bucket(bucket) for bucket in bucket_entries]
    del bucket_entries
    facts_pack.write()
    (SITE / "facts.idx").write_bytes(
        sr.gzip_member({"buckets": sr.FACT_BUCKETS, "b": fact_dir}, 6)
    )
    fact_q = quantiles(facts_pack.sizes)
    log(
        f"事实打包:{fact_q['members']:,} 成员,"
        f"{len(facts_pack.blob) / 1e6:,.1f}MB,最大 {fact_q['max']:,}B"
    )

    # ---- 骨架边(与旧格式一致:保底 top-1 + 权重补足)----
    edges = np.concatenate(edge_key_pairs)
    ra = np.fromiter(
        (rank_of_key[int(k)] for k in edges[:, 0]), np.int64, len(edges)
    )
    rb = np.fromiter(
        (rank_of_key[int(k)] for k in edges[:, 1]), np.int64, len(edges)
    )
    und = np.unique(np.minimum(ra, rb) * (1 << 21) + np.maximum(ra, rb))
    er = np.stack([und >> 21, und & ((1 << 21) - 1)], axis=1)
    log(f"边 {len(edges):,} 行 → 无向去重 {len(er):,} 条")
    deg = np.zeros(n, dtype=np.int64)
    np.add.at(deg, er[:, 0], 1)
    np.add.at(deg, er[:, 1], 1)
    w = (collect_r[er[:, 0]] + collect_r[er[:, 1]]) / np.sqrt(
        deg[er[:, 0]] * deg[er[:, 1]]
    )
    order_w = np.argsort(-w, kind="stable")
    a_s, b_s = er[order_w, 0], er[order_w, 1]
    inf = len(er)
    first = np.full(n, inf, dtype=np.int64)
    ua, ia = np.unique(a_s, return_index=True)
    first[ua] = ia
    ub, ib = np.unique(b_s, return_index=True)
    first[ub] = np.minimum(first[ub], ib)
    baseline = np.unique(first[first < inf])
    keep_mask = np.zeros(len(er), dtype=bool)
    keep_mask[baseline] = True
    short = SKELETON_TARGET - int(keep_mask.sum())
    if short > 0:
        keep_mask[np.where(~keep_mask)[0][:short]] = True
    kept = np.where(keep_mask)[0]
    skel = er[order_w[kept]].astype(np.uint32)
    if len(skel) > SKELETON_TARGET:
        log(
            f"WARNING: 骨架边 {len(skel):,} 条超出目标 "
            f"{SKELETON_TARGET:,}(保底覆盖优先)"
        )
    (SITE / "edges.bin").write_bytes(skel.tobytes())
    log(f"骨架边 {len(skel):,} 条(按权重降序,客户端前缀优先)")

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
    orphan_groups = sum(
        1
        for sid in eps_by_subject
        if sr.entity_key(sr.KIND_SUBJECT, sid) not in info
    )
    orphan_eps = sum(
        len(v)
        for sid, v in eps_by_subject.items()
        if sr.entity_key(sr.KIND_SUBJECT, sid) not in info
    )
    for v in eps_by_subject.values():
        v.sort(
            key=lambda e: (
                e[7],
                e[4],
                e[6] if e[6] is not None else float("inf"),
                e[0],
            )
        )
    episodes_pack = PackFile("episodes.pack")
    eps_level = sr.GZIP_LEVELS["episodes"]
    eps_items: list[tuple[int, Any]] = []
    eps_inline_rows = 0
    eps_paged_rows = 0
    for sid in sorted(eps_by_subject):
        ep_rows = eps_by_subject[sid]
        entry = {"e": ep_rows[: sr.EPISODE_INLINE], "n": len(ep_rows)}
        eps_inline_rows += len(entry["e"])
        ep_over = ep_rows[sr.EPISODE_INLINE :]
        if ep_over:
            entry["op"] = [
                pages_pack.add(member)
                for member in sr.gzip_pages(ep_over, pages_level, sr.PAGE_SIZE)
            ]
            eps_paged_rows += len(ep_over)
        eps_items.append((sid, entry))

    def encode_eps(chunk: list[tuple[int, Any]]) -> Any:
        return {"i": [c[0] for c in chunk], "g": [c[1] for c in chunk]}

    eps_ranges = emit_ranged(
        episodes_pack,
        eps_items,
        sr.EPISODE_BLOCK_SUBJECTS,
        eps_level,
        encode_eps,
    )
    episodes_pack.write()
    (SITE / "episodes.idx").write_bytes(
        sr.gzip_member(
            {"width": sr.EPISODE_BLOCK_SUBJECTS, "ranges": eps_ranges}, 6
        )
    )
    reconcile("分集行数", n_eps, eps_inline_rows + eps_paged_rows)
    pages_pack.write()
    eps_q = quantiles(episodes_pack.sizes)
    log(
        f"分集:{len(eps_by_subject):,} 组(孤儿组 {orphan_groups:,}/"
        f"{orphan_eps:,} 条),{eps_q['members']:,} 成员,"
        f"{len(episodes_pack.blob) / 1e6:,.1f}MB"
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

    def encode_text(chunk: list[tuple[int, Any]]) -> Any:
        return {"i": [c[0] for c in chunk], "t": [c[1] for c in chunk]}

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
            t = pq.read_table(
                PARQUET / f"{table}.parquet", columns=["id", columns]
            ).to_pydict()
            items: list[tuple[int, Any]] = []
            for i in range(len(t["id"])):
                text = t[columns][i]
                if text:
                    items.append((t["id"][i], text))
                    non_empty += 1
                    raw_bytes += len(text.encode("utf-8"))
                else:
                    empty += 1
            items.sort(key=lambda r: r[0])
            ranges[str(kind)] = emit_ranged(
                pack, items, width, level, encode_text
            )
            del t, items
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
    desc_t = pq.read_table(
        PARQUET / "episode.parquet",
        columns=["id", "subject_id", "description"],
    ).to_pydict()
    desc_by_subject: dict[int, list[list[Any]]] = defaultdict(list)
    desc_non_empty = 0
    desc_empty = 0
    desc_raw = 0
    for i in range(len(desc_t["id"])):
        text = desc_t["description"][i]
        if text:
            desc_by_subject[desc_t["subject_id"][i]].append(
                [desc_t["id"][i], text]
            )
            desc_non_empty += 1
            desc_raw += len(text.encode("utf-8"))
        else:
            desc_empty += 1
    del desc_t
    for pairs in desc_by_subject.values():
        pairs.sort(key=lambda p: p[0])
    desc_ranges: list[list[int]] = []

    def emit_desc(chunk: list[tuple[int, Any]]) -> None:
        gz = sr.gzip_member(
            {"i": [c[0] for c in chunk], "t": [c[1] for c in chunk]},
            level,
        )
        if len(gz) <= sr.MEMBER_CAP:
            loc = desc_pack.add(gz)
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
            if len(part_gz) > sr.MEMBER_CAP:
                emit_desc([(sid, part)])
                continue
            loc = desc_pack.add(part_gz)
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
    fs_pack = RolloverPack(family)
    fs_items: list[tuple[int, Any]] = []
    fs_empty = 0
    fs_raw = 0
    for i in range(len(vo["from_id"])):
        text = vo["summary"][i]
        if not text:
            fs_empty += 1
            continue
        participants = (
            sr.entity_key(sr.KIND_PERSON, vo["from_id"][i]),
            sr.entity_key(sr.KIND_CHARACTER, vo["to_id"][i]),
            sr.entity_key(sr.KIND_SUBJECT, vo["subject_id"][i]),
        )
        enc = sr.canonical_fact(
            "VOICE_CREDIT", participants, (vo["type"][i], text)
        )
        fs_items.append((fact_refs[enc], text))
        fs_raw += len(text.encode("utf-8"))
    del vo
    fs_items = sorted(dict(fs_items).items())
    fs_ranges = emit_ranged(
        fs_pack,
        fs_items,
        sr.TEXT_BLOCK_IDS[family],
        sr.GZIP_LEVELS[family],
        encode_text,
    )
    fs_pack.write()
    text_dir[family] = {
        "gzip": sr.GZIP_LEVELS[family],
        "width": sr.TEXT_BLOCK_IDS[family],
        "files": fs_pack.files,
        "ranges": fs_ranges,
    }
    text_stats[family] = {
        "non_empty": len(fs_items),
        "empty": fs_empty,
        "raw_bytes": fs_raw,
        "compressed_bytes": sum(fs_pack.sizes),
    }
    text_quantile_gate(family, fs_pack.sizes)
    (SITE / "text.idx").write_bytes(sr.gzip_member({"families": text_dir}, 6))
    del fact_refs

    # ---- 显示映射 ----
    mappings, _ = collect_mappings()
    (SITE / "mappings.json").write_bytes(jdump(mappings))
    mapping_digest = sr.sha256_hex(sr.canonical_json(mappings))

    # ---- 搜索:规范化前缀自适应树 ----
    chars: set[str] = set()
    for k in key_r:
        di = info[int(k)]
        for text in (di["name"], di["cn"]):
            if text:
                chars.update(str(text).lower())
    charmap, charmap_dropped = build_charmap(chars)
    if charmap_dropped:
        log(
            f"  截断:charmap 丢弃多字映射 {charmap_dropped:,} 个"
            f"(逐字契约下无法表达,原字直存)"
        )
    fold = fold_factory(charmap)
    entries: list[tuple[str, str, int]] = []
    for rank, k in enumerate(key_r):
        di = info[int(k)]
        for text in dict.fromkeys(str(t) for t in (di["name"], di["cn"]) if t):
            nk = fold(text)
            if nk:
                entries.append((nk, text, rank))
    entries.sort(key=lambda e: e[2])  # 全局热度序
    search_pack = PackFile("search.pack")
    search_level = sr.GZIP_LEVELS["search"]
    search_dir: dict[str, Any] = {}
    n_leaves = 0
    n_internal = 0

    def next_char(norm: str, prefix_len: int) -> str:
        # Python 字符串按码点索引;客户端以 codePointAt 对齐同一规则
        return norm[prefix_len]

    def emit_search(prefix: str, items: list[tuple[str, str, int]]) -> None:
        nonlocal n_leaves, n_internal
        rows = [[e[0], e[1], e[2]] for e in items]
        gz = sr.gzip_member(rows, search_level)
        if len(gz) <= sr.SEARCH_LEAF_CAP:
            search_dir[prefix] = {"l": search_pack.add(gz)}
            n_leaves += 1
            return
        n_internal += 1
        top = [[e[0], e[1], e[2]] for e in items[: sr.SEARCH_TOP]]
        node: dict[str, Any] = {
            "t": search_pack.add(sr.gzip_member(top, search_level))
        }
        search_dir[prefix] = node
        children: dict[str, list[tuple[str, str, int]]] = defaultdict(list)
        for e in items:
            if e[0] != prefix:
                children[next_char(e[0], len(prefix))].append(e)
        for ch in sorted(children):
            emit_search(prefix + ch, children[ch])

    roots: dict[str, list[tuple[str, str, int]]] = defaultdict(list)
    for e in entries:
        roots[next_char(e[0], 0)].append(e)
    for ch in sorted(roots):
        emit_search(ch, roots[ch])
    search_pack.write()
    (SITE / "search.idx.json").write_bytes(jdump(search_dir))
    (SITE / "charmap.json").write_bytes(jdump(charmap))
    search_q = quantiles(search_pack.sizes)
    reconcile(
        "搜索条目数(根分组对账)",
        len(entries),
        sum(len(v) for v in roots.values()),
    )
    log(
        f"搜索:{len(entries):,} 条,叶 {n_leaves:,}/内部 {n_internal:,},"
        f"{len(search_pack.blob) / 1e6:,.1f}MB,最大成员 "
        f"{search_q['max']:,}B"
    )

    # ---- 标签表(社区标签名取社区 top 节点,位置取几何中心)----
    labels: list[list[Any]] = []
    for rank in range(min(LABELS_TOP, n)):
        dl = info[int(key_r[rank])]
        labels.append([rank, str(dl["cn"] or dl["name"])])
    comm_labels = build_community_labels(comm_r, coords_r, key_r, info)
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
        assert fpath.is_file(), f"产物应全为顶层文件,发现目录 {fpath.name}"
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
            "subject": len(sub_rows),
            "person": len(per_rows),
            "character": len(cha_rows),
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
            "dump_sha256": sha256_of(DUMP_ZIP) if DUMP_ZIP.exists() else "",
        },
        "schema_digest": sr.schema_digest(),
        "field_policy": sr.FIELD_POLICY,
        "mapping_digests": {"mappings.json": mapping_digest},
        "vocab_digests": vocab_digests,
        "owned_collections": {
            "episode": {"parent": "subject", "via": "subject_id"}
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
        "limits": {
            "member_cap": sr.MEMBER_CAP,
            "pack_cap": sr.PACK_CAP,
            "fact_buckets": sr.FACT_BUCKETS,
            "fact_inline": sr.FACT_INLINE,
            "episode_inline": sr.EPISODE_INLINE,
            "page_size": sr.PAGE_SIZE,
            "entity_block_ids": sr.ENTITY_BLOCK_IDS,
            "episode_block_subjects": sr.EPISODE_BLOCK_SUBJECTS,
            "search_leaf_cap": sr.SEARCH_LEAF_CAP,
            "search_top": sr.SEARCH_TOP,
            "cache_budget": {
                "total": 64_000_000,
                "names": 12_000_000,
                "structure": 24_000_000,
                "search": 8_000_000,
                "text": 20_000_000,
            },
        },
        "rank_index": {
            "encoding": sr.RANK_ENCODING,
            "sentinel": sr.RANK_SENTINEL,
            "segments": rank_segments,
        },
        "n_nodes": n,
        "n_edges_skeleton": len(skel),
        "name_block_size": name_block_size,
        "bbox": [lo, hi],
        "year_range": [y_lo, y_hi],
        "tags": top_tags,
        "layout": layout_report,
        "files": file_meta,
        "core_bytes": core_bytes,
        "total_bytes": total_bytes,
        "n_files": n_files,
    }
    version = sr.manifest_version(manifest_body)
    manifest = {"version": version, **manifest_body}
    (SITE / "manifest.json").write_bytes(jdump(manifest))
    if total_bytes > SIZE_BUDGET:
        failures.append("站点数据超 GH Pages 1GB 硬限")
    elif total_bytes > SIZE_WARN:
        log(f"WARNING: 站点数据 {total_bytes / 1e6:,.0f}MB 接近 1GB 门禁")
    if n_files > FILE_BUDGET:
        log(f"WARNING: 文件数 {n_files:,} 超 CF Pages 2 万限")
    log(
        f"manifest 写出;数据合计 {total_bytes / 1e6:,.0f} MB"
        f"(core {core_bytes / 1e6:,.0f} MB),{n_files:,} 个文件;"
        f"总耗时 {time.time() - t_start:,.0f}s"
    )
    if failures:
        sys.exit(f"FAILED: {len(failures)} 处对账不符: {failures}")


if __name__ == "__main__":
    main()
