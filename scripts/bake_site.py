"""Bake all static site data from parquet + layout (EXPLORER.md §6).

Products (site/data/): manifest.json, geometry SoA bins, names.json,
skeleton edges, adjacency shards (top-200 + overflow pages), detail
shards (episode lists paged), search index shards (CJK folded), label
tables. Every truncation is counted and reported loudly.
"""

import json
import shutil
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow.parquet as pq
from opencc import OpenCC

ROOT = Path(__file__).resolve().parent.parent
PARQUET = ROOT / "data" / "parquet"
LAYOUT = ROOT / "data" / "layout" / "coords.parquet"
SITE = ROOT / "site" / "data"

BUCKETS = 8192
ADJ_INLINE = 200
EPS_INLINE = 200
SKELETON_EDGES = 500_000
LABELS_TOP = 20_000

ETYPE = {"subject": 1, "person": 2, "character": 3}

t2s = OpenCC("t2s")


def norm_key(text: str) -> str:
    return t2s.convert(text.strip().lower())


def log(msg: str) -> None:
    print(msg, flush=True)


def load_layout() -> dict[str, np.ndarray]:
    t = pq.read_table(LAYOUT)
    return {c: np.asarray(t.column(c)) for c in t.column_names}


def build_rank(lay: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Sort by collect desc -> rank order arrays."""
    order = np.argsort(-lay["collect"], kind="stable")
    out = {c: v[order] for c, v in lay.items()}
    out["rank_of_key"] = np.empty(0)  # replaced below
    return out


def quantize(
    coords: np.ndarray,
) -> tuple[np.ndarray, list[float], list[float]]:
    lo = coords.min(0)
    hi = coords.max(0)
    q = ((coords - lo) / (hi - lo) * 65535).astype(np.uint16)
    return q, [float(v) for v in lo], [float(v) for v in hi]


def main() -> None:  # noqa: PLR0915
    t_start = time.time()
    # 清场重建:防止上次运行的产物残留(与 fetch_dump 同一纪律)
    shutil.rmtree(SITE, ignore_errors=True)
    SITE.mkdir(parents=True, exist_ok=True)
    lay = load_layout()
    n = len(lay["key"])
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
    log(f"节点 {n:,},rank 排序完成")

    # ---- 节点表:名字 / nsfw / 详情所需短属性 ----
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
            "tags": sub["meta_tags"][i][:8],
            "sum": sub["summary"][i],
        }
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
    log("节点属性装载完成")

    # ---- 几何 SoA ----
    q, lo, hi = quantize(coords_r.astype(np.float32))
    (SITE / "positions.bin").write_bytes(q.tobytes())
    (SITE / "year.bin").write_bytes(year_r.tobytes())
    (SITE / "key.bin").write_bytes(key_r.tobytes())
    (SITE / "community.bin").write_bytes(comm_r.tobytes())
    size_u8 = np.minimum(255, np.round(18 * np.log2(1 + collect_r))).astype(
        np.uint8
    )
    (SITE / "size.bin").write_bytes(size_u8.tobytes())
    flags = np.zeros(n, dtype=np.uint8)
    nsfw_arr = np.array(
        [bool(info[int(k)]["nsfw"]) for k in key_r], dtype=bool
    )
    flags |= nsfw_arr.astype(np.uint8)
    flags |= (iso_r.astype(np.uint8)) << 1
    media = np.array(
        [int(info[int(k)].get("media", 0)) & 7 for k in key_r],
        dtype=np.uint8,
    )
    flags |= media << 2
    (SITE / "flags.bin").write_bytes(flags.tobytes())
    log("几何 SoA 写出完成")

    # ---- 名字表(与 rank 同序)----
    names = [info[int(k)]["name"] for k in key_r]
    names_cn = [info[int(k)]["cn"] or None for k in key_r]
    (SITE / "names.json").write_text(
        json.dumps(
            {"n": names, "c": names_cn},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    log("名字表写出完成")

    # ---- 邻接(全部 6 张边表,双向,带解码关系名)----
    adj: dict[int, list[tuple[int, int]]] = defaultdict(list)
    label_table: list[str] = []
    label_id: dict[str, int] = {}

    def lid(label: str) -> int:
        if label not in label_id:
            label_id[label] = len(label_table)
            label_table.append(label)
        return label_id[label]

    def add_edges(
        fname: str,
        s_t: str,
        d_t: str,
        label_col: str | None,
        fixed: tuple[str, str] | None = None,
    ) -> np.ndarray:
        cols = ["from_id", "to_id"] + ([label_col] if label_col else [])
        t = pq.read_table(PARQUET / f"{fname}.parquet", columns=cols)
        a_ids = np.asarray(t.column("from_id"), dtype=np.uint32)
        b_ids = np.asarray(t.column("to_id"), dtype=np.uint32)
        a = (ETYPE[s_t] << 24) | a_ids
        b = (ETYPE[d_t] << 24) | b_ids
        labels = t.column(label_col).to_pylist() if label_col else None
        for i in range(len(a)):
            la = labels[i] if labels else fixed[0]  # type: ignore[index]
            lb = labels[i] if labels else fixed[1]  # type: ignore[index]
            ra, rb = rank_of_key[int(a[i])], rank_of_key[int(b[i])]
            adj[int(a[i])].append((rb, lid(la or "关联")))
            adj[int(b[i])].append((ra, lid(lb or "关联")))
        return np.stack([a, b], axis=1)

    all_edges = []
    all_edges.append(add_edges("relates_to", "subject", "subject", "relation"))
    all_edges.append(
        add_edges("worked_on", "person", "subject", "position_cn")
    )
    all_edges.append(
        add_edges("appears_in", "character", "subject", "role_cn")
    )
    all_edges.append(
        add_edges("voiced", "person", "character", None, ("配音角色", "声优"))
    )
    all_edges.append(add_edges("person_rel", "person", "person", "relation"))
    all_edges.append(
        add_edges("character_rel", "character", "character", "relation")
    )
    log(f"邻接构建完成:{sum(len(v) for v in adj.values()):,} 条目")

    # ---- 邻接分片(top-200 + 溢出分页)----
    overflow_nodes = 0
    shards: list[dict[str, Any]] = [dict() for _ in range(BUCKETS)]
    (SITE / "adj_over").mkdir(exist_ok=True)
    for k, lst in adj.items():
        lst.sort(key=lambda e: -collect_r[e[0]])
        total = len(lst)
        inline, over = lst[:ADJ_INLINE], lst[ADJ_INLINE:]
        groups: dict[int, list[int]] = defaultdict(list)
        for r, li in inline:
            groups[li].append(r)
        entry: dict[str, Any] = {
            "g": [[li, rs] for li, rs in groups.items()],
            "n": total,
        }
        if over:
            overflow_nodes += 1
            pages = [over[i : i + 500] for i in range(0, len(over), 500)]
            entry["p"] = len(pages)
            odir = SITE / "adj_over" / str(k)
            odir.mkdir(exist_ok=True)
            for pi, page in enumerate(pages):
                (odir / f"{pi}.json").write_text(
                    json.dumps(page, separators=(",", ":"))
                )
        shards[k % BUCKETS][str(k)] = entry
    (SITE / "adj").mkdir(exist_ok=True)
    for i, sh in enumerate(shards):
        (SITE / "adj" / f"{i}.json").write_text(
            json.dumps(sh, ensure_ascii=False, separators=(",", ":"))
        )
    log(f"邻接分片写出完成(溢出节点 {overflow_nodes:,},显式分页)")

    # ---- 骨架边:每节点保底 top-1 + 度归一权重补足 ----
    edges = np.concatenate(all_edges)
    er = np.stack(
        [
            np.fromiter((rank_of_key[int(k)] for k in edges[:, 0]), np.int64),
            np.fromiter((rank_of_key[int(k)] for k in edges[:, 1]), np.int64),
        ],
        axis=1,
    )
    deg = np.zeros(n, dtype=np.int64)
    np.add.at(deg, er[:, 0], 1)
    np.add.at(deg, er[:, 1], 1)
    w = (collect_r[er[:, 0]] + collect_r[er[:, 1]]) / np.sqrt(
        deg[er[:, 0]] * deg[er[:, 1]]
    )
    best: dict[int, int] = {}
    for i in range(len(er)):
        for endp in (er[i, 0], er[i, 1]):
            if endp not in best or w[i] > w[best[endp]]:
                best[int(endp)] = i
    keep = set(best.values())
    for i in np.argsort(-w):
        if len(keep) >= SKELETON_EDGES:
            break
        keep.add(int(i))
    skel = er[sorted(keep)].astype(np.uint32)
    (SITE / "edges.bin").write_bytes(skel.tobytes())
    log(f"骨架边 {len(skel):,} 条(保底覆盖 {len(best):,} 节点)")

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
    (SITE / "det_eps").mkdir(exist_ok=True)
    eps_paged = 0
    for rank, k in enumerate(key_r):
        ki = int(k)
        det: dict[str, Any] = dict(info[ki])
        det.pop("nsfw")
        det.pop("media", None)
        det["r"] = rank
        if ki >> 24 == 1:
            elist = eps_by_subject.get(ki & 0xFFFFFF, [])
            det["ne"] = len(elist)
            det["eps"] = elist[:EPS_INLINE]
            if len(elist) > EPS_INLINE:
                eps_paged += 1
                epages = [
                    elist[i : i + 500]
                    for i in range(EPS_INLINE, len(elist), 500)
                ]
                pdir = SITE / "det_eps" / str(ki)
                pdir.mkdir(exist_ok=True)
                for pi, epage in enumerate(epages):
                    (pdir / f"{pi}.json").write_text(
                        json.dumps(
                            epage, ensure_ascii=False, separators=(",", ":")
                        )
                    )
        det_shards[ki % BUCKETS][str(ki)] = det
    (SITE / "det").mkdir(exist_ok=True)
    for i, sh in enumerate(det_shards):
        (SITE / "det" / f"{i}.json").write_text(
            json.dumps(sh, ensure_ascii=False, separators=(",", ":"))
        )
    log(f"详情分片写出完成(分集分页节点 {eps_paged:,})")

    # ---- 搜索索引(CJK 折叠,前缀分片)----
    entries: dict[str, list[list[Any]]] = defaultdict(list)
    n_entries = 0
    for rank, k in enumerate(key_r):
        di = info[int(k)]
        for text in (di["name"], di["cn"]):
            if not text:
                continue
            nk = norm_key(str(text))
            if not nk:
                continue
            entries[nk[0]].append([nk, str(text), rank])
            n_entries += 1
    (SITE / "search").mkdir(exist_ok=True)
    for ch, slist in entries.items():
        slist.sort(key=lambda e: e[2])
        (SITE / "search" / f"{ord(ch):x}.json").write_text(
            json.dumps(slist, ensure_ascii=False, separators=(",", ":"))
        )
    # 客户端同款归一:导出出现过的字符的 t2s 单字映射
    chars = {c for lst in entries.values() for e in lst for c in e[1]}
    charmap = {}
    for c in chars:
        m = t2s.convert(c)
        if m != c and len(m) == 1:
            charmap[c] = m
    (SITE / "charmap.json").write_text(
        json.dumps(charmap, ensure_ascii=False, separators=(",", ":"))
    )
    log(
        f"搜索索引 {n_entries:,} 条,{len(entries):,} 个前缀分片,"
        f"折叠映射 {len(charmap):,} 字"
    )

    # ---- 标签表 ----
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
    charset = sorted(
        {ch for _, t in labels for ch in str(t)}
        | {ch for cl in comm_labels.values() for ch in str(cl[0])}
    )
    (SITE / "labels.json").write_text(
        json.dumps(
            {
                "nodes": labels,
                "comm": comm_labels,
                "charset": "".join(charset),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    log(f"标签表:节点 {len(labels):,} + 社区 {len(comm_labels):,}")

    # ---- 分享卡片:top-N og:meta 静态 stub(爬虫用,人类被跳转)----
    (SITE / "n").mkdir(exist_ok=True)
    for rank in range(min(10_000, n)):
        ki = int(key_r[rank])
        d0 = info[ki]
        title = str(d0["cn"] or d0["name"])
        bits = [str(d0["t"])]
        if d0.get("score"):
            bits.append(f"评分 {d0['score']}")
        desc = " · ".join(bits) + " | Bangumi 星图"
        (SITE / "n" / f"{ki}.html").write_text(
            "<!doctype html><meta charset=utf-8>"
            f"<title>{title}</title>"
            f'<meta property="og:title" content="{title}">'
            f'<meta property="og:description" content="{desc}">'
            f'<script>location.replace("../#n={ki}")</script>'
        )
    log("分享卡片 10,000 个写出")

    # ---- manifest ----
    files = {
        p.relative_to(SITE).as_posix(): p.stat().st_size
        for p in SITE.rglob("*")
        if p.is_file() and p.name != "manifest.json"
    }
    manifest = {
        "n_nodes": n,
        "n_edges_skeleton": len(skel),
        "buckets": BUCKETS,
        "adj_inline": ADJ_INLINE,
        "eps_inline": EPS_INLINE,
        "bbox": [lo, hi],
        "labels": label_table,
        "total_bytes": sum(files.values()),
        "n_files": len(files),
    }
    (SITE / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False)
    )
    log(
        f"manifest 写出;站点 raw 合计 {sum(files.values()) / 1e6:,.0f} MB,"
        f"{len(files):,} 个文件;总耗时 {time.time() - t_start:,.0f}s"
    )


if __name__ == "__main__":
    main()
