"""Production 3D layout for the star atlas (EXPLORER.md §6).

Reads map-scope edges from data/parquet/, lays out connected nodes with
the chosen algorithm (bake-off winner), detects Leiden communities with
cross-week ID alignment, banishes isolated nodes to an outer shell
ordered by type+year, and warm-starts from last week's coordinates when
provided. Output: data/layout/coords.parquet
(key u32, x/y/z f32, community u16, isolated bool).
"""

import argparse
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
    g: ig.Graph, algo: str, weights: list[float], seed: np.ndarray | None
) -> np.ndarray:
    """对决裁决(2026-07-31):UMAP 胜出——全图 15 分钟 vs DRL 子图
    2h+ 未完成;周更协议 = 热启动 + 小 epoch + Procrustes 对齐。"""
    seed_list = seed.tolist() if seed is not None else None
    if algo == "drl":
        layout = g.layout_drl(seed=seed_list, dim=3)
    elif algo == "umap":
        epochs = 10 if seed is not None else 200
        layout = g.layout_umap(dim=3, epochs=epochs, seed=seed_list)
    else:
        raise ValueError(algo)
    del weights  # DRL/UMAP 权重接口不稳定,v1 用无权布局
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
    """Match community IDs to last week's by member overlap."""
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
    old_of = np.array([old_map.get(int(k), -1) for k in keys])
    out = comm.copy()
    for c in np.unique(comm):
        members_old = old_of[comm == c]
        members_old = members_old[members_old >= 0]
        if len(members_old):
            vals, counts = np.unique(members_old, return_counts=True)
            out[comm == c] = vals[counts.argmax()]
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
    ap.add_argument("--algo", choices=["drl", "umap"], default="drl")
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
        w = [
            1.0 / np.sqrt(deg[connected][e[0]] * deg[connected][e[1]])
            for e in g.get_edgelist()
        ]
        seed = None
        if args.warm_start and args.warm_start.exists():
            prev = pq.read_table(
                args.warm_start, columns=["key", "x", "y", "z"]
            )
            pmap = {
                int(k): (x, y, z)
                for k, x, y, z in zip(
                    np.asarray(prev.column("key")),
                    np.asarray(prev.column("x")),
                    np.asarray(prev.column("y")),
                    np.asarray(prev.column("z")),
                    strict=True,
                )
            }
            lo = np.array([v for v in pmap.values()]).min(0)
            hi = np.array([v for v in pmap.values()]).max(0)
            seed = np.array(
                [
                    pmap.get(int(k), tuple(rng.uniform(lo, hi)))
                    for k in keys[connected]
                ],
                dtype=np.float32,
            )
            print("热启动:载入上周坐标", flush=True)
        t0 = time.time()
        coords[connected] = run_layout(g, args.algo, w, seed)
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
        comm[connected] = (aligned % 0xFFFF).astype(np.uint16)
        print(f"社区检测+对齐 {time.time() - t0:,.0f}s", flush=True)

    # 居中缩放,孤立节点放外壳(半径 = 主体半径 × 1.35)
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
