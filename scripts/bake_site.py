"""Bake all static site data from parquet + layout (EXPLORER.md §6).

Products: site/data/ 下 manifest.json、几何 SoA bins、names.ndjson(流式)、
骨架边、邻接分片(top-200 + 组总数 + 溢出分页)、详情分片(分集分页)、
搜索索引分片(简繁日折叠)、标签表、坐标快照。
纪律:失败与截断显式报出、行级对账,对不上非零退出。
"""

import gzip
import hashlib
import shutil
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import orjson
import pyarrow.parquet as pq
from opencc import OpenCC


def jdump(obj: Any) -> bytes:
    """orjson 序列化(实测比 stdlib json 快 ~4.7x;int 键转 str,
    与标准库 dumps 行为一致,输出为紧凑 UTF-8)。"""
    return orjson.dumps(obj, option=orjson.OPT_NON_STR_KEYS)


class PackWriter:
    """逐片 gzip 打包:每片独立压缩后连续写入一个 pack 文件,
    客户端按 [offset, length) HTTP Range 取片、DecompressionStream
    解压。分片数不再等于文件数(文件数曾达 2.5 万,详情分片裸存
    700MB 靠 CDN 压缩;打包后存储即压缩,体积与文件数同时解决)。"""

    def __init__(self) -> None:
        self.blob = bytearray()

    def add(self, obj: Any) -> list[int]:
        gz = gzip.compress(jdump(obj), 6)
        off = len(self.blob)
        self.blob += gz
        return [off, len(gz)]

    def write(self, path: Path) -> None:
        path.write_bytes(bytes(self.blob))

ROOT = Path(__file__).resolve().parent.parent
PARQUET = ROOT / "data" / "parquet"
LAYOUT = ROOT / "data" / "layout" / "coords.parquet"
LAYOUT_REPORT = ROOT / "data" / "layout" / "report.json"
DUMP_VERSION = ROOT / "data" / "dump" / "VERSION"
SITE = ROOT / "site" / "data"

BUCKETS = 8192
ADJ_INLINE = 200
EPS_INLINE = 200
PAGE = 500
DET_SPLIT = 4  # 详情 pack 按桶均分 4 个文件,单文件压缩后 <100MB
SKELETON_TARGET = 500_000  # §2 预算;保底覆盖优先,超限显式报出
LABELS_TOP = 20_000
HOT_SHARDS = 24  # 高频首字分片数,随首块预取(§1 冷分片对冲)
SIZE_BUDGET = 1_000_000_000  # GH Pages 1GB 硬限
FILE_BUDGET = 20_000  # CF Pages 迁移预案的文件数上限

ETYPE = {"subject": 1, "person": 2, "character": 3}

# 归一链:日文新字体 → 繁体(jp2t)→ 简体(t2s),再小写(§6 变体折叠)。
# 契约:索引键与客户端查询都从同一张单字映射表逐字折叠——OpenCC 整串
# 转换有短语级上下文(編集→编辑),与客户端逐字 charmap 必然分歧,
# 实测会让数千条目击不中,所以烘焙侧也只允许逐字。
_jp2t = OpenCC("jp2t")
_t2s = OpenCC("t2s")

failures: list[str] = []


def build_charmap(chars: set[str]) -> tuple[dict[str, str], int]:
    """返回 (单字映射表, 被丢弃的多字映射数)。丢弃必须显式报出。"""
    charmap = {}
    dropped = 0
    for c in chars:
        m = _t2s.convert(_jp2t.convert(c))
        if m == c:
            continue
        if len(m) == 1:
            charmap[c] = m
        else:
            dropped += 1
    return charmap, dropped


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


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def load_layout() -> dict[str, np.ndarray]:
    t = pq.read_table(LAYOUT)
    return {c: np.asarray(t.column(c)) for c in t.column_names}


def quantize(
    coords: np.ndarray,
) -> tuple[np.ndarray, list[float], list[float]]:
    lo = coords.min(0)
    hi = coords.max(0)
    q = ((coords - lo) / (hi - lo) * 65535).astype(np.uint16)
    return q, [float(v) for v in lo], [float(v) for v in hi]


def load_info() -> dict[int, dict[str, Any]]:
    """节点 key -> 名字 / nsfw / 详情所需短属性(infobox 刻意不上站)。"""
    sub = pq.read_table(
        PARQUET / "subject.parquet",
        columns=[
            "id",
            "type",
            "type_name",
            "name",
            "name_cn",
            "date",
            "score",
            "rank",
            "nsfw",
            "wish",
            "done",
            "doing",
            "on_hold",
            "dropped",
            "meta_tags",
            "summary",
        ],
    ).to_pydict()
    per = pq.read_table(
        PARQUET / "person.parquet",
        columns=["id", "name", "career", "comments", "collects", "summary"],
    ).to_pydict()
    cha = pq.read_table(
        PARQUET / "character.parquet",
        columns=["id", "name", "role", "comments", "collects", "summary"],
    ).to_pydict()
    info: dict[int, dict[str, Any]] = {}
    for i in range(len(sub["id"])):
        k = (1 << 24) | sub["id"][i]
        info[k] = {
            "t": "作品",
            "media": sub["type"][i],
            "st": sub["type_name"][i],
            "name": sub["name"][i],
            "cn": sub["name_cn"][i],
            "date": sub["date"][i],
            "score": sub["score"][i],
            "bgm_rank": sub["rank"][i],
            "nsfw": sub["nsfw"][i],
            "fav": [
                sub[c][i]
                for c in ("wish", "done", "doing", "on_hold", "dropped")
            ],
            "tags": sub["meta_tags"][i][:8],  # 截断,计数见下方 log
            "sum": sub["summary"][i],
        }
    tags_truncated = sum(
        1 for i in range(len(sub["id"])) if len(sub["meta_tags"][i]) > 8
    )
    if tags_truncated:
        log(f"  截断:meta_tags 超 8 个的作品 {tags_truncated:,}(显式报出)")
    for i in range(len(per["id"])):
        k = (2 << 24) | per["id"][i]
        info[k] = {
            "t": "人物",
            "name": per["name"][i],
            "cn": "",
            "career": per["career"][i],
            "collects": per["collects"][i],
            "sum": per["summary"][i],
            "nsfw": False,
        }
    for i in range(len(cha["id"])):
        k = (3 << 24) | cha["id"][i]
        info[k] = {
            "t": "角色",
            "name": cha["name"][i],
            "cn": "",
            "collects": cha["collects"][i],
            "sum": cha["summary"][i],
            "nsfw": False,
        }
    return info


def main() -> None:  # noqa: PLR0915
    t_start = time.time()
    version = (
        DUMP_VERSION.read_text().strip() if DUMP_VERSION.exists() else ""
    )
    if not version:
        version = time.strftime("%Y-%m-%d")
        log(f"WARNING: {DUMP_VERSION} 缺失,version 回退构建日期 {version}")
    # 清场重建:防止上次运行的产物残留(与 fetch_dump 同一纪律)
    shutil.rmtree(SITE, ignore_errors=True)
    SITE.mkdir(parents=True, exist_ok=True)

    lay = load_layout()
    n = len(lay["key"])
    assert n < (1 << 21), "边去重编码假设节点数 < 2^21"
    order = np.argsort(-lay["collect"], kind="stable")
    key_r = lay["key"][order].astype(np.uint32)  # rank -> key
    year_r = lay["year"][order].astype(np.uint16)
    comm_r = lay["community"][order].astype(np.uint16)
    iso_r = lay["isolated"][order]
    collect_r = lay["collect"][order]
    coords_r = np.stack(
        [lay["x"][order], lay["y"][order], lay["z"][order]], axis=1
    )
    rank_of_key: dict[int, int] = {int(k): i for i, k in enumerate(key_r)}
    log(f"节点 {n:,},rank 排序完成(数据版本 {version})")

    info = load_info()
    covered = sum(1 for k in key_r if int(k) in info)
    reconcile("节点属性覆盖全部入图节点", n, covered)
    # 反向:库中实体数 = 入图节点数(coords.parquet 陈旧即在此暴露)
    reconcile("库实体数 = 入图节点数", len(info), n)
    if failures:
        sys.exit(
            f"FAILED: 布局与库不同步({failures}),"
            f"先重跑 layout.py 再烘焙"
        )
    log("节点属性装载完成")

    # ---- 几何 SoA(16B/节点,六文件,定长记录支持 Range 点查)----
    q, lo, hi = quantize(coords_r.astype(np.float32))
    (SITE / "positions.bin").write_bytes(q.tobytes())
    (SITE / "year.bin").write_bytes(year_r.tobytes())
    (SITE / "key.bin").write_bytes(key_r.tobytes())
    (SITE / "community.bin").write_bytes(comm_r.tobytes())
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
    for fname, stride in (
        ("positions.bin", 6),
        ("year.bin", 2),
        ("key.bin", 4),
        ("community.bin", 2),
        ("size.bin", 1),
        ("flags.bin", 1),
    ):
        reconcile(f"{fname} 字节数", n * stride, (SITE / fname).stat().st_size)
    log("几何 SoA 写出完成")

    # ---- 名字表:NDJSON,与几何同序,客户端逐行流式 ----
    with open(SITE / "names.ndjson", "wb") as nf:
        for k in key_r:
            d = info[int(k)]
            nf.write(jdump([d["name"], d["cn"] or None]))
            nf.write(b"\n")
    # actual 重读落盘文件计行(名字含换行等装配错误在此暴露)
    with open(SITE / "names.ndjson", encoding="utf-8") as nrf:
        n_names = sum(1 for _ in nrf)
    reconcile("names.ndjson 行数", n, n_names)
    log("名字表写出完成")

    # ---- 邻接(6 张边表;对称表去重:按源方向入列,缺反向行才补)----
    adj: dict[int, list[tuple[int, int]]] = defaultdict(list)
    label_table: list[str] = []
    label_id: dict[str, int] = {}
    entries_expected = 0
    synthesized_reverse = 0

    def lid(label: str) -> int:
        if label not in label_id:
            label_id[label] = len(label_table)
            label_table.append(label)
        return label_id[label]

    def read_edges(
        fname: str, s_t: str, d_t: str, label_col: str | None
    ) -> tuple[np.ndarray, np.ndarray, list[Any] | None]:
        cols = ["from_id", "to_id"] + ([label_col] if label_col else [])
        t = pq.read_table(PARQUET / f"{fname}.parquet", columns=cols)
        a = (ETYPE[s_t] << 24) | np.asarray(
            t.column("from_id"), dtype=np.uint32
        )
        b = (ETYPE[d_t] << 24) | np.asarray(
            t.column("to_id"), dtype=np.uint32
        )
        labels = t.column(label_col).to_pylist() if label_col else None
        return a, b, labels

    def add_sym(fname: str, etype_s: str, label_col: str) -> np.ndarray:
        """对称存储表(A→B 与 B→A 各带各的关系名)。每行只给源节点
        入列;上游漏存反向行时补一条(用本行关系名,总比缺失好)。
        期望条目数由行数 + 集合运算独立推导,不依赖入列过程。"""
        nonlocal entries_expected, synthesized_reverse
        a, b, labels = read_edges(fname, etype_s, etype_s, label_col)
        assert labels is not None
        codes = (a.astype(np.int64) << 32) | b.astype(np.int64)
        directed = set(codes.tolist())
        rev_codes = (b.astype(np.int64) << 32) | a.astype(np.int64)
        missing = int(
            sum(1 for c in rev_codes.tolist() if c not in directed)
        )
        entries_expected += len(a) + missing
        synthesized_reverse += missing
        for i in range(len(a)):
            ka, kb = int(a[i]), int(b[i])
            li = lid(labels[i] or "关联")
            adj[ka].append((rank_of_key[kb], li))
            if int(rev_codes[i]) not in directed:
                adj[kb].append((rank_of_key[ka], li))
        return np.stack([a, b], axis=1)

    def add_bip(
        fname: str,
        s_t: str,
        d_t: str,
        label_col: str | None,
        fixed: tuple[str, str] | None = None,
    ) -> np.ndarray:
        """二部表(person→subject 等):一行 = 一条参与关系,两端各入列。"""
        nonlocal entries_expected
        a, b, labels = read_edges(fname, s_t, d_t, label_col)
        entries_expected += 2 * len(a)
        for i in range(len(a)):
            la = labels[i] if labels else fixed[0]  # type: ignore[index]
            lb = labels[i] if labels else fixed[1]  # type: ignore[index]
            ra, rb = rank_of_key[int(a[i])], rank_of_key[int(b[i])]
            adj[int(a[i])].append((rb, lid(la or "关联")))
            adj[int(b[i])].append((ra, lid(lb or "关联")))
        return np.stack([a, b], axis=1)

    all_edges = []
    all_edges.append(add_sym("relates_to", "subject", "relation"))
    all_edges.append(add_bip("worked_on", "person", "subject", "position_cn"))
    all_edges.append(
        add_bip("appears_in", "character", "subject", "role_cn")
    )
    all_edges.append(
        add_bip("voiced", "person", "character", None, ("配音角色", "声优"))
    )
    all_edges.append(add_sym("person_rel", "person", "relation"))
    all_edges.append(add_sym("character_rel", "character", "relation"))
    reconcile(
        "邻接条目数(源行数按方向对账)",
        entries_expected,
        sum(len(v) for v in adj.values()),
    )
    log(
        f"邻接构建完成:{entries_expected:,} 条目"
        f"(补反向 {synthesized_reverse:,} 条)"
    )

    # ---- 邻接分片(top-200 + 各关系组总数 + 溢出分页入 pages.pack)----
    overflow_nodes = 0
    dup_dropped = 0
    written_inline = 0
    written_over = 0
    shards: list[dict[str, Any]] = [dict() for _ in range(BUCKETS)]
    pages_pack = PackWriter()  # 邻接溢出页与分集溢出页共用
    for k, lst in adj.items():
        # rank 即全库收藏度序:升序排序 = 按收藏度降序(§4 预排序)
        lst.sort()
        deduped: list[tuple[int, int]] = []
        for e in lst:
            if deduped and deduped[-1] == e:
                dup_dropped += 1  # 源数据完全重复行
                continue
            deduped.append(e)
        total = len(deduped)
        inline, over = deduped[:ADJ_INLINE], deduped[ADJ_INLINE:]
        group_total = Counter(li for _, li in deduped)
        groups: dict[int, list[int]] = defaultdict(list)
        for r, li in inline:
            groups[li].append(r)
        # 全部组都出现(仅在溢出中的组给空 inline),组内序即收藏度序
        entry: dict[str, Any] = {
            "g": [
                [li, group_total[li], groups.get(li, [])]
                for li in group_total
            ],
            "n": total,
        }
        written_inline += len(inline)
        if over:
            overflow_nodes += 1
            # 溢出页进 pages.pack,[offset, len] 内嵌进条目本身:
            # 客户端"展开全部"无需任何索引往返
            entry["op"] = [
                pages_pack.add(
                    [[li, r] for r, li in over[i : i + PAGE]]
                )
                for i in range(0, len(over), PAGE)
            ]
            written_over += len(over)
        shards[k % BUCKETS][str(k)] = entry
    adj_gz = [gzip.compress(jdump(sh), 6) for sh in shards]
    adj_idx = np.zeros(BUCKETS + 1, dtype=np.uint32)
    adj_idx[1:] = np.cumsum([len(g) for g in adj_gz])
    (SITE / "adj.pack").write_bytes(b"".join(adj_gz))
    (SITE / "adj.idx").write_bytes(adj_idx.tobytes())
    reconcile(
        "adj.pack 字节数 = 索引末位",
        int(adj_idx[-1]),
        (SITE / "adj.pack").stat().st_size,
    )
    reconcile(
        "邻接 inline+溢出 = 去重后条目",
        entries_expected - dup_dropped,
        written_inline + written_over,
    )
    log(
        f"邻接打包完成(溢出节点 {overflow_nodes:,},"
        f"源重复行剔除 {dup_dropped:,};pack {int(adj_idx[-1]) / 1e6:,.0f}MB)"
    )

    # ---- 骨架边:无向去重 → 每节点保底 top-1 + 权重补足,按权重降序 ----
    edges = np.concatenate(all_edges)
    ra = np.fromiter(
        (rank_of_key[int(k)] for k in edges[:, 0]), np.int64, len(edges)
    )
    rb = np.fromiter(
        (rank_of_key[int(k)] for k in edges[:, 1]), np.int64, len(edges)
    )
    und = np.unique(
        np.minimum(ra, rb) * (1 << 21) + np.maximum(ra, rb)
    )
    er = np.stack([und >> 21, und & ((1 << 21) - 1)], axis=1)
    log(f"边 {len(edges):,} 行 → 无向去重 {len(er):,} 条")
    deg = np.zeros(n, dtype=np.int64)
    np.add.at(deg, er[:, 0], 1)
    np.add.at(deg, er[:, 1], 1)
    w = (collect_r[er[:, 0]] + collect_r[er[:, 1]]) / np.sqrt(
        deg[er[:, 0]] * deg[er[:, 1]]
    )
    order_w = np.argsort(-w, kind="stable")
    # 保底 = 每个端点权重最高的那条边:权重降序序列上的首次出现
    a_s, b_s = er[order_w, 0], er[order_w, 1]
    inf = len(er)
    first = np.full(n, inf, dtype=np.int64)
    ua, ia = np.unique(a_s, return_index=True)
    first[ua] = ia
    ub, ib = np.unique(b_s, return_index=True)
    first[ub] = np.minimum(first[ub], ib)
    baseline = np.unique(first[first < inf])  # 位置为 order_w 坐标
    keep_mask = np.zeros(len(er), dtype=bool)
    keep_mask[baseline] = True
    short = SKELETON_TARGET - int(keep_mask.sum())
    if short > 0:  # 补足:未入选中权重最高的边
        keep_mask[np.where(~keep_mask)[0][:short]] = True
    kept = np.where(keep_mask)[0]  # 升序 = 权重降序
    skel = er[order_w[kept]].astype(np.uint32)
    if len(skel) > SKELETON_TARGET:
        log(
            f"WARNING: 骨架边 {len(skel):,} 条超出 §2 预算 "
            f"{SKELETON_TARGET:,}(保底覆盖 {len(baseline):,} 条边优先);"
            f"传输 {len(skel) * 8 / 1e6:.1f}MB,近景由客户端可见集上限兜底"
        )
    (SITE / "edges.bin").write_bytes(skel.tobytes())
    log(f"骨架边 {len(skel):,} 条(按权重降序,客户端前缀优先)")

    # ---- 详情分片(分集列表分页)----
    eps = pq.read_table(
        PARQUET / "episode.parquet",
        columns=["subject_id", "name", "name_cn", "airdate", "sort", "type"],
    ).to_pydict()
    eps_by_subject: dict[int, list[list[Any]]] = defaultdict(list)
    for i in range(len(eps["subject_id"])):
        eps_by_subject[eps["subject_id"][i]].append(
            [
                eps["type"][i],
                eps["sort"][i],
                eps["name"][i],
                eps["name_cn"][i],
                eps["airdate"][i],
            ]
        )
    for v in eps_by_subject.values():
        v.sort(key=lambda e: (e[0], e[1]))
    det_shards: list[dict[str, Any]] = [dict() for _ in range(BUCKETS)]
    eps_paged = 0
    eps_attached = 0
    for rank, k in enumerate(key_r):
        ki = int(k)
        det: dict[str, Any] = dict(info[ki])
        det.pop("nsfw")
        det.pop("media", None)
        det["r"] = rank
        if ki >> 24 == 1:
            elist = eps_by_subject.get(ki & 0xFFFFFF, [])
            eps_attached += len(elist)
            det["ne"] = len(elist)
            det["eps"] = elist[:EPS_INLINE]
            if len(elist) > EPS_INLINE:
                eps_paged += 1
                det["eo"] = [
                    pages_pack.add(elist[i : i + PAGE])
                    for i in range(EPS_INLINE, len(elist), PAGE)
                ]
        det_shards[ki % BUCKETS][str(ki)] = det
    # 4 个 pack 均分 8192 桶;索引存全局累计偏移,客户端按
    # pack 首桶偏移换算 pack 内相对位置
    det_gz = [gzip.compress(jdump(sh), 6) for sh in det_shards]
    det_idx = np.zeros(BUCKETS + 1, dtype=np.uint32)
    det_idx[1:] = np.cumsum([len(g) for g in det_gz])
    per_pack = BUCKETS // DET_SPLIT
    det_pack_bytes = 0
    for p in range(DET_SPLIT):
        seg = b"".join(det_gz[p * per_pack : (p + 1) * per_pack])
        (SITE / f"det-{p}.pack").write_bytes(seg)
        det_pack_bytes += len(seg)
    (SITE / "det.idx").write_bytes(det_idx.tobytes())
    reconcile("det pack 字节数 = 索引末位", int(det_idx[-1]), det_pack_bytes)
    # actual 取分片字典实存量而非循环计数(键冲突覆盖在此暴露)
    reconcile("详情条目数", n, sum(len(sh) for sh in det_shards))
    pages_pack.write(SITE / "pages.pack")
    orphan_eps = sum(len(v) for v in eps_by_subject.values()) - eps_attached
    log(
        f"详情打包完成(分集分页节点 {eps_paged:,};det pack "
        f"{det_pack_bytes / 1e6:,.0f}MB,溢出页 pack "
        f"{len(pages_pack.blob) / 1e6:,.1f}MB;"
        f"孤儿分集 {orphan_eps:,} 条不挂靠,与库中记录一致)"
    )

    # ---- 搜索索引(简繁日逐字折叠,CJK 一字一档)----
    # 先建 charmap,索引键与客户端查询用同一张表折叠(契约见文件头)
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

    def fold(text: str) -> str:
        t = text.strip().lower()
        return "".join(charmap.get(ch, ch) for ch in t)

    # 期望条目数独立预推导(与装配循环分离,防"数自己写的数")
    expected_entries = 0
    for k in key_r:
        di = info[int(k)]
        for text in dict.fromkeys(
            str(t) for t in (di["name"], di["cn"]) if t
        ):
            if fold(text):
                expected_entries += 1

    entries: dict[str, list[list[Any]]] = defaultdict(list)
    n_entries = 0
    for rank, k in enumerate(key_r):
        di = info[int(k)]
        # name == name_cn 时只入一条,防联想下拉重复占位
        for text in dict.fromkeys(
            str(t) for t in (di["name"], di["cn"]) if t
        ):
            nk = fold(text)
            if not nk:
                continue
            entries[nk[0]].append([nk, text, rank])
            n_entries += 1
    # 一字一档打包:pack + {首字码点 hex: [offset, len]} 偏移索引
    search_pack = PackWriter()
    search_idx: dict[str, list[int]] = {}
    for ch in sorted(entries):
        slist = entries[ch]
        slist.sort(key=lambda e: e[2])
        search_idx[f"{ord(ch):x}"] = search_pack.add(slist)
    search_pack.write(SITE / "search.pack")
    (SITE / "search.idx.json").write_bytes(jdump(search_idx))
    reconcile(
        "搜索条目数",
        expected_entries,
        sum(len(v) for v in entries.values()),
    )
    reconcile("搜索索引档数", len(entries), len(search_idx))
    hot_shards = [
        f"{ord(ch):x}"
        for ch, _ in sorted(
            entries.items(), key=lambda kv: -len(kv[1])
        )[:HOT_SHARDS]
    ]
    (SITE / "charmap.json").write_bytes(jdump(charmap))
    log(
        f"搜索索引 {n_entries:,} 条,{len(entries):,} 个前缀分片,"
        f"热分片 {len(hot_shards)},折叠映射 {len(charmap):,} 字"
    )

    # ---- 标签表(社区标签 = 社区内 top 节点名)----
    labels: list[list[Any]] = []
    for rank in range(min(LABELS_TOP, n)):
        dl = info[int(key_r[rank])]
        labels.append([rank, str(dl["cn"] or dl["name"])])
    comm_labels: dict[int, list[Any]] = {}
    for rank in range(n):
        c = int(comm_r[rank])
        if c != 0xFFFF and c not in comm_labels:
            dl = info[int(key_r[rank])]
            comm_labels[c] = [
                str(dl["cn"] or dl["name"]),
                [round(float(v), 1) for v in coords_r[rank]],
            ]
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

    # ---- 坐标快照:下周热启动 + 位置恒定的事实来源,纳入清单 ----
    shutil.copy(LAYOUT, SITE / "coords.parquet")

    # ---- manifest:版本 + 文件清单 + 哈希(客户端 ?v= 寻址防缓存错配)。
    # 分片已全部打包,产物只剩顶层文件,逐个 sha256 ----
    file_meta: dict[str, list[Any]] = {}
    total_bytes = 0
    n_files = 0
    for fpath in sorted(SITE.iterdir()):
        if fpath.name == "manifest.json":
            continue
        assert fpath.is_file(), f"产物应全为顶层文件,发现目录 {fpath.name}"
        file_meta[fpath.name] = [fpath.stat().st_size, sha256_of(fpath)]
        total_bytes += fpath.stat().st_size
        n_files += 1
    # 滑块标定:上游日期有脏值(实测 701 与 9000),钳到可信窗口;
    # 滑块拉满 = 不过滤,脏年份节点不受影响
    year_nonzero = year_r[year_r > 0]
    if len(year_nonzero):
        y_lo = int(np.clip(year_nonzero.min(), 1900, 2035))
        y_hi = int(np.clip(year_nonzero.max(), y_lo, 2035))
        n_dirty = int(
            ((year_nonzero < 1900) | (year_nonzero > 2035)).sum()
        )
        if n_dirty:
            log(f"  年份脏值 {n_dirty:,} 条在滑块窗口外(显式报出)")
    else:
        y_lo = y_hi = 0
    if LAYOUT_REPORT.exists():
        layout_report = orjson.loads(LAYOUT_REPORT.read_bytes())
    else:
        layout_report = None
        log(
            "WARNING: data/layout/report.json 缺失,manifest.layout = null"
            "(冷启动或本次未跑 layout.py)"
        )
    manifest = {
        "version": version,
        "n_nodes": n,
        "n_edges_skeleton": len(skel),
        "buckets": BUCKETS,
        "det_packs": DET_SPLIT,
        "adj_inline": ADJ_INLINE,
        "eps_inline": EPS_INLINE,
        "bbox": [lo, hi],
        "year_range": [y_lo, y_hi],
        "labels": label_table,
        "hot_shards": hot_shards,
        "layout": layout_report,
        "files": file_meta,
        "total_bytes": total_bytes,
        "n_files": n_files,
    }
    (SITE / "manifest.json").write_bytes(jdump(manifest))
    if total_bytes > SIZE_BUDGET:
        # 硬门禁(§2/§10 双重门禁的烘焙半边):超限即构建失败
        failures.append("站点体积超 GH Pages 1GB 硬限")
        log(
            f"MISMATCH: 站点 {total_bytes / 1e6:,.0f}MB 超 GH Pages 1GB "
            f"硬限,构建失败 → §8 R2 迁移预案"
        )
    if n_files > FILE_BUDGET:
        log(
            f"WARNING: 文件数 {n_files:,} 超 CF Pages 2 万限,"
            f"迁移走 R2(§8 既定路径)"
        )
    log(
        f"manifest 写出;站点 raw 合计 {total_bytes / 1e6:,.0f} MB,"
        f"{n_files:,} 个文件;总耗时 {time.time() - t_start:,.0f}s"
    )
    if failures:
        sys.exit(f"FAILED: {len(failures)} 处对账不符: {failures}")


if __name__ == "__main__":
    main()
