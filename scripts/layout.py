"""Production 3D layout for the star atlas (EXPLORER.md §6).

Reads map-scope edges from data/parquet/, lays out connected nodes with
the chosen algorithm (bake-off winner), detects Leiden communities with
cross-week ID alignment, banishes isolated nodes to an outer shell
ordered by type+year, and warm-starts from last week's coordinates when
provided. Output: data/layout/coords.parquet
(key u32, x/y/z f32, community u16, isolated bool).
"""

import argparse
import json
import time
from pathlib import Path

import igraph as ig
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
PARQUET = ROOT / "data" / "parquet"
OUT = ROOT / "data" / "layout"

ETYPE = {"subject": 1, "person": 2, "character": 3}
EDGE_FILES = [
    ("relates_to", "from_id", "subject", "to_id", "subject"),
    ("worked_on", "from_id", "person", "to_id", "subject"),
    ("appears_in", "from_id", "character", "to_id", "subject"),
    ("voiced", "from_id", "person", "to_id", "character"),
    ("person_rel", "from_id", "person", "to_id", "person"),
    ("character_rel", "from_id", "character", "to_id", "character"),
]

rng = np.random.default_rng(7)


def node_key(etype: str, ids: np.ndarray) -> np.ndarray:
    return (ETYPE[etype] << 24) | ids.astype(np.uint32)


def load_nodes() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """All map nodes -> (key, year, collect) arrays."""
    keys, years, collects = [], [], []
    t = pq.read_table(
        PARQUET / "subject.parquet",
        columns=["id", "date", "wish", "done", "doing", "on_hold", "dropped"],
    )
    ids = np.asarray(t.column("id"), dtype=np.uint32)
    keys.append(node_key("subject", ids))
    date = t.column("date").to_pylist()
    years.append(
        np.array(
            [int(d[:4]) if d and d[:4].isdigit() else 0 for d in date],
            dtype=np.uint16,
        )
    )
    collects.append(
        sum(
            np.asarray(t.column(c), dtype=np.int64)
            for c in ("wish", "done", "doing", "on_hold", "dropped")
        )
    )
    for name in ("person", "character"):
        t = pq.read_table(
            PARQUET / f"{name}.parquet", columns=["id", "collects"]
        )
        ids = np.asarray(t.column("id"), dtype=np.uint32)
        keys.append(node_key(name, ids))
        years.append(np.zeros(len(ids), dtype=np.uint16))
        collects.append(np.asarray(t.column("collects"), dtype=np.int64))
    return (
        np.concatenate(keys),
        np.concatenate(years),
        np.concatenate(collects),
    )


def load_edges(index: dict[int, int]) -> np.ndarray:
    parts = []
    for fname, src_col, src_t, dst_col, dst_t in EDGE_FILES:
        t = pq.read_table(
            PARQUET / f"{fname}.parquet", columns=[src_col, dst_col]
        )
        a = node_key(src_t, np.asarray(t.column(src_col), dtype=np.uint32))
        b = node_key(dst_t, np.asarray(t.column(dst_col), dtype=np.uint32))
        parts.append(np.stack([a, b], axis=1))
    edges = np.concatenate(parts)
    lookup = np.vectorize(index.__getitem__, otypes=[np.int64])
    return lookup(edges)


def run_layout(
    g: ig.Graph, algo: str, seed: np.ndarray | None
) -> np.ndarray:
    """3D 布局,hub 降权(§6:边权 ∝ 1/√度数积)。传入 seed 即周更
    热启动:epochs 降为 10,结果 Procrustes 对齐回 seed 坐标框架。"""
    # simplify 后的真实度数;UMAP 语义是距离(越大越疏远),
    # 故 hub-hub 边给大距离 = 对 1/√(du·dv) 权重的等价表达
    dsub = np.asarray(g.degree(), dtype=np.float64)
    el = np.asarray(g.get_edgelist(), dtype=np.int64)
    hub_dist = np.sqrt(dsub[el[:, 0]] * dsub[el[:, 1]])
    hub_dist /= hub_dist.max()
    seed_list = seed.tolist() if seed is not None else None
    if algo == "drl":
        layout = g.layout_drl(
            seed=seed_list, dim=3, weights=(1.0 / hub_dist).tolist()
        )
    elif algo == "umap":
        epochs = 10 if seed is not None else 200
        layout = g.layout_umap(
            dim=3, epochs=epochs, seed=seed_list, dist=hub_dist.tolist()
        )
    else:
        raise ValueError(algo)
    coords = np.asarray(layout.coords, dtype=np.float32)
    if seed is not None:
        # 旋转对齐回上周坐标框架,保持心智地图连续
        from scipy.linalg import orthogonal_procrustes

        a = coords - coords.mean(0)
        b = seed - seed.mean(0)
        rot, _ = orthogonal_procrustes(a, b)
        coords = (a @ rot + seed.mean(0)).astype(np.float32)
    return coords


def align_communities(
    comm: np.ndarray, prev: pq.ParquetFile | None, keys: np.ndarray
) -> np.ndarray:
    """按成员重叠一对一匹配上周社区 ID(防配色每周洗牌)。

    贪心:按重叠数降序配对,新旧各只用一次——多对一会把不同社区
    别名成同色,正是该机制要防的事。未匹配的新社区取未占用的新 ID。
    0xFFFF 是孤立节点哨兵,永不分配。"""
    if prev is None:
        return comm
    old = prev.read(columns=["key", "community"])
    old_map = dict(
        zip(
            np.asarray(old.column("key")).tolist(),
            np.asarray(old.column("community")).tolist(),
            strict=True,
        )
    )
    old_of = np.array(
        [old_map.get(int(k), -1) for k in keys], dtype=np.int64
    )
    valid = (old_of >= 0) & (old_of != 0xFFFF)
    base = int(old_of.max()) + 1
    codes = comm[valid] * base + old_of[valid]
    uniq, counts = np.unique(codes, return_counts=True)
    mapping: dict[int, int] = {}
    used_old: set[int] = set()
    for idx in np.argsort(-counts, kind="stable"):
        new_c, old_c = int(uniq[idx]) // base, int(uniq[idx]) % base
        if new_c not in mapping and old_c not in used_old:
            mapping[new_c] = old_c
            used_old.add(old_c)
    free = (i for i in range(0xFFFF) if i not in used_old)
    lut = np.zeros(int(comm.max()) + 1, dtype=np.int64)
    for c in np.unique(comm):
        if int(c) not in mapping:
            mapping[int(c)] = next(free)
            used_old.add(mapping[int(c)])
        lut[c] = mapping[int(c)]
    out = lut[comm]
    if out.max() >= 0xFFFF:
        raise SystemExit(
            f"社区 ID {out.max()} 溢出 u16 契约(0xFFFF 为孤立哨兵)"
        )
    return out


def shell_placement(
    n: int, years: np.ndarray, keys: np.ndarray, radius: float
) -> np.ndarray:
    """Golden-spiral sphere ordered by (type, year): neighbors are at
    least thematically adjacent."""
    order = np.lexsort((years, keys >> 24))
    idx = np.empty(n, dtype=np.int64)
    idx[order] = np.arange(n)
    golden = np.pi * (3 - np.sqrt(5))
    y = 1 - 2 * (idx + 0.5) / n
    r = np.sqrt(1 - y * y)
    theta = golden * idx
    pts = np.stack([r * np.cos(theta), y, r * np.sin(theta)], axis=1)
    return (pts * radius).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser()
    # 默认 = 对决胜者 UMAP(EXPLORER.md §3 裁决);drl 仅留作对照
    ap.add_argument("--algo", choices=["drl", "umap"], default="umap")
    ap.add_argument(
        "--warm-start",
        type=Path,
        default=None,
        help="上周 coords.parquet,热启动用",
    )
    ap.add_argument(
        "--stub",
        action="store_true",
        help="跳过真实布局,生成随机坐标(管道联调用)",
    )
    args = ap.parse_args()

    keys, years, collects = load_nodes()
    index = {int(k): i for i, k in enumerate(keys)}
    print(f"节点 {len(keys):,}", flush=True)
    edges = load_edges(index)
    print(f"边 {len(edges):,}", flush=True)

    deg = np.zeros(len(keys), dtype=np.int64)
    np.add.at(deg, edges[:, 0], 1)
    np.add.at(deg, edges[:, 1], 1)
    isolated = deg == 0
    print(f"孤立节点 {isolated.sum():,}(放逐外壳)", flush=True)

    connected = np.where(~isolated)[0]
    remap = -np.ones(len(keys), dtype=np.int64)
    remap[connected] = np.arange(len(connected))
    sub_edges = remap[edges]

    coords = np.zeros((len(keys), 3), dtype=np.float32)
    comm = np.full(len(keys), 0xFFFF, dtype=np.uint16)
    prev_map: dict[int, tuple[float, float, float]] | None = None

    if args.stub:
        coords[connected] = rng.normal(0, 150, (len(connected), 3)).astype(
            np.float32
        )
        comm[connected] = (keys[connected] % 512).astype(np.uint16)
    else:
        g = ig.Graph(
            n=len(connected), edges=sub_edges.tolist(), directed=False
        )
        g.simplify()
        seed = None
        if args.warm_start and args.warm_start.exists():
            prev = pq.read_table(
                args.warm_start, columns=["key", "x", "y", "z", "isolated"]
            )
            # 上周在外壳(孤立)的节点不作 seed 也不进位移统计:
            # 外壳 → 星体的位移是拓扑事件而非布局漂移
            prev_map = {
                int(k): (x, y, z)
                for k, x, y, z, iso in zip(
                    np.asarray(prev.column("key")),
                    np.asarray(prev.column("x")),
                    np.asarray(prev.column("y")),
                    np.asarray(prev.column("z")),
                    np.asarray(prev.column("isolated")),
                    strict=True,
                )
                if not iso
            }
            lo = np.array([v for v in prev_map.values()]).min(0)
            hi = np.array([v for v in prev_map.values()]).max(0)
            ck = keys[connected]
            known = np.array([int(k) in prev_map for k in ck])
            seed = np.zeros((len(ck), 3), dtype=np.float32)
            if known.any():
                seed[known] = np.array(
                    [prev_map[int(k)] for k in ck[known]], dtype=np.float32
                )
            n_new = int((~known).sum())
            if n_new:
                # 新节点 seed = 已知邻居质心(§7 论据"新节点长在簇
                # 边缘"的落实);无已知邻居才退回 bbox 均匀随机
                sums = np.zeros((len(ck), 3), dtype=np.float64)
                cnts = np.zeros(len(ck), dtype=np.int64)
                e0, e1 = sub_edges[:, 0], sub_edges[:, 1]
                m = known[e1]
                np.add.at(sums, e0[m], seed[e1[m]])
                np.add.at(cnts, e0[m], 1)
                m = known[e0]
                np.add.at(sums, e1[m], seed[e0[m]])
                np.add.at(cnts, e1[m], 1)
                anchored = (~known) & (cnts > 0)
                jitter = 0.01 * float(np.max(hi - lo))
                seed[anchored] = (
                    sums[anchored] / cnts[anchored, None]
                    + rng.normal(0, jitter, (int(anchored.sum()), 3))
                ).astype(np.float32)
                stray = (~known) & (cnts == 0)
                seed[stray] = rng.uniform(
                    lo, hi, (int(stray.sum()), 3)
                ).astype(np.float32)
                print(
                    f"热启动:新节点 {n_new:,}"
                    f"(邻居质心 {int(anchored.sum()):,} / "
                    f"随机 {int(stray.sum()):,})",
                    flush=True,
                )
            print("热启动:载入上周坐标", flush=True)
        t0 = time.time()
        coords[connected] = run_layout(g, args.algo, seed)
        print(f"布局完成 {time.time() - t0:,.0f}s", flush=True)
        t0 = time.time()
        leiden = np.asarray(
            g.community_leiden(
                objective_function="modularity", n_iterations=2
            ).membership,
            dtype=np.int64,
        )
        prev_pf = (
            pq.ParquetFile(args.warm_start)
            if args.warm_start and args.warm_start.exists()
            else None
        )
        aligned = align_communities(leiden, prev_pf, keys[connected])
        comm[connected] = aligned.astype(np.uint16)
        print(f"社区检测+对齐 {time.time() - t0:,.0f}s", flush=True)

    # 居中;孤立节点放逐外壳
    c = coords[connected]
    center = c.mean(0)
    coords[connected] = c - center
    body_r = float(np.abs(coords[connected]).max())
    n_iso = int(isolated.sum())
    if n_iso:
        coords[isolated] = shell_placement(
            n_iso, years[isolated], keys[isolated], body_r * 1.35
        )

    OUT.mkdir(parents=True, exist_ok=True)

    # 跨周位移测量(§7 "位移留观" 的落地):对上周也在图中的
    # 连通节点,统计 Procrustes 对齐后的位移 / 全图直径
    report: dict[str, object] = {
        "algo": args.algo,
        "warm_start": prev_map is not None,
        "n_nodes": int(len(keys)),
        "n_connected": int(len(connected)),
        "p95_shift_pct": None,
        "median_shift_pct": None,
        "n_common": 0,
    }
    if prev_map is not None:
        common = np.array(
            [
                i
                for i in connected
                if int(keys[i]) in prev_map
            ],
            dtype=np.int64,
        )
        if len(common):
            prev_xyz = np.array(
                [prev_map[int(keys[i])] for i in common], dtype=np.float32
            )
            shift = np.linalg.norm(coords[common] - prev_xyz, axis=1)
            span = coords[connected]
            diameter = float(np.linalg.norm(span.max(0) - span.min(0)))
            report["n_common"] = int(len(common))
            report["p95_shift_pct"] = round(
                float(np.percentile(shift, 95)) / diameter * 100, 3
            )
            report["median_shift_pct"] = round(
                float(np.median(shift)) / diameter * 100, 3
            )
            print(
                f"跨周位移:p95 {report['p95_shift_pct']}% / "
                f"中位 {report['median_shift_pct']}%(直径归一,"
                f"共同节点 {len(common):,};门槛 3%,超限需人工裁断)",
                flush=True,
            )
    (OUT / "report.json").write_text(json.dumps(report))
    pq.write_table(
        pa.table(
            {
                "key": pa.array(keys, pa.uint32()),
                "x": pa.array(coords[:, 0], pa.float32()),
                "y": pa.array(coords[:, 1], pa.float32()),
                "z": pa.array(coords[:, 2], pa.float32()),
                "community": pa.array(comm, pa.uint16()),
                "isolated": pa.array(isolated),
                "collect": pa.array(collects, pa.int64()),
                "year": pa.array(years, pa.uint16()),
                "degree": pa.array(deg, pa.int64()),
            }
        ),
        OUT / "coords.parquet",
    )
    print(f"已写出 {OUT / 'coords.parquet'}", flush=True)


if __name__ == "__main__":
    main()
