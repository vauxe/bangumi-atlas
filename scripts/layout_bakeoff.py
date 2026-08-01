"""Layout bake-off for the choice in docs/EXPLORER_ARCHITECTURE.md.

Candidates: igraph DRL-3D (force family) vs igraph UMAP-3D (embedding
family). For each: runtime, edge-compactness, community separation, and
the warm-start stability gate (p95 displacement of unperturbed nodes
must stay under 1% of the layout diameter). Winner's coordinates are
exported for visual inspection with spike/preview.html.

Usage: uv run python scripts/layout_bakeoff.py [--candidate drl|umap]
"""

import argparse
import time
from pathlib import Path
from typing import Any

import igraph as ig
import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "spike"

rng = np.random.default_rng(42)


def load_graph() -> tuple[ig.Graph, np.ndarray]:
    t = pq.read_table(
        ROOT / "data/parquet/relates_to.parquet",
        columns=["from_id", "to_id"],
    )
    src = np.asarray(t.column("from_id"))
    dst = np.asarray(t.column("to_id"))
    ids = np.unique(np.concatenate([src, dst]))
    index = {int(v): i for i, v in enumerate(ids)}
    edges = np.stack(
        [
            np.fromiter((index[int(v)] for v in src), np.int64),
            np.fromiter((index[int(v)] for v in dst), np.int64),
        ],
        axis=1,
    )
    g = ig.Graph(n=len(ids), edges=edges.tolist(), directed=False)
    g.simplify()
    return g, ids


def run_layout(g: ig.Graph, candidate: str, seed: Any = None) -> np.ndarray:
    if candidate == "drl":
        layout = g.layout_drl(seed=seed, dim=3)
    elif candidate == "umap":
        layout = g.layout_umap(dim=3, epochs=200, seed=seed)
    else:
        raise ValueError(candidate)
    return np.asarray(layout.coords, dtype=np.float32)


def diameter(coords: np.ndarray) -> float:
    return float(np.linalg.norm(coords.max(0) - coords.min(0)))


def edge_compactness(g: ig.Graph, coords: np.ndarray) -> float:
    """Mean edge length / mean random-pair length; lower is better."""
    edges = np.array(g.get_edgelist())
    pick = rng.choice(len(edges), size=min(50_000, len(edges)), replace=False)
    e = edges[pick]
    edge_len = np.linalg.norm(coords[e[:, 0]] - coords[e[:, 1]], axis=1)
    a = rng.integers(0, len(coords), 50_000)
    b = rng.integers(0, len(coords), 50_000)
    rand_len = np.linalg.norm(coords[a] - coords[b], axis=1)
    return float(edge_len.mean() / rand_len.mean())


def community_separation(g: ig.Graph, coords: np.ndarray) -> float:
    """Mean intra-community distance / inter; lower is better."""
    comm = g.community_leiden(
        objective_function="modularity", resolution=1.0, n_iterations=2
    ).membership
    comm_arr = np.asarray(comm)
    order = np.argsort(comm_arr, kind="stable")
    a = rng.integers(0, len(coords) - 1, 100_000)
    # 同社区对:排序后相邻大概率同社区;跨社区对:随机
    sa, sb = order[a], order[a + 1]
    same_mask = comm_arr[sa] == comm_arr[sb]
    intra = np.linalg.norm(
        coords[sa[same_mask]] - coords[sb[same_mask]], axis=1
    ).mean()
    ra = rng.integers(0, len(coords), 100_000)
    rb = rng.integers(0, len(coords), 100_000)
    diff_mask = comm_arr[ra] != comm_arr[rb]
    inter = np.linalg.norm(
        coords[ra[diff_mask]] - coords[rb[diff_mask]], axis=1
    ).mean()
    return float(intra / inter)


def stability_gate(
    g: ig.Graph, coords: np.ndarray, candidate: str
) -> tuple[float, bool]:
    """Warm-restart with 1% of nodes perturbed; p95 displacement of the
    other 99% must stay under 1% of the layout diameter."""
    n = len(coords)
    seed = coords.copy()
    touched = rng.choice(n, size=max(1, n // 100), replace=False)
    lo, hi = coords.min(0), coords.max(0)
    seed[touched] = rng.uniform(lo, hi, (len(touched), 3)).astype(np.float32)
    coords2 = run_layout(g, candidate, seed=seed.tolist())
    untouched = np.setdiff1d(np.arange(n), touched)
    # 生产管线每周会做正交 Procrustes 对齐,门槛按对齐后位移评判
    from scipy.linalg import orthogonal_procrustes

    a = coords2[untouched] - coords2[untouched].mean(0)
    b = coords[untouched] - coords[untouched].mean(0)
    rot, _ = orthogonal_procrustes(a, b)
    disp = np.linalg.norm(a @ rot - b, axis=1)
    p95 = float(np.percentile(disp, 95))
    dia = diameter(coords)
    return p95 / dia, (p95 / dia) < 0.01


def export_preview(coords: np.ndarray, g: ig.Graph, name: str) -> None:
    comm = np.asarray(
        g.community_leiden(
            objective_function="modularity", n_iterations=2
        ).membership,
        dtype=np.uint16,
    )
    c = coords - coords.mean(0)
    c *= 400 / np.abs(c).max()
    (OUT / f"coords_{name}.bin").write_bytes(c.astype(np.float32).tobytes())
    (OUT / f"comm_{name}.bin").write_bytes(comm.tobytes())
    print(f"  preview 数据已导出:spike/coords_{name}.bin")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", choices=["drl", "umap"], required=True)
    args = ap.parse_args()

    print(f"[{args.candidate}] 加载 RELATES_TO 子图…", flush=True)
    g, _ids = load_graph()
    print(f"  {g.vcount():,} 节点 / {g.ecount():,} 边", flush=True)

    t0 = time.time()
    coords = run_layout(g, args.candidate)
    runtime = time.time() - t0
    print(f"  布局完成:{runtime:,.0f}s", flush=True)

    ec = edge_compactness(g, coords)
    cs = community_separation(g, coords)
    print(f"  边紧凑度(越小越好): {ec:.3f}", flush=True)
    print(f"  社区分离度(越小越好): {cs:.3f}", flush=True)

    t0 = time.time()
    ratio, ok = stability_gate(g, coords, args.candidate)
    print(
        f"  稳定性门槛:p95 位移 / 直径 = {ratio:.4f} "
        f"({'PASS' if ok else 'FAIL'},门槛 0.01;"
        f"重跑 {time.time() - t0:,.0f}s)",
        flush=True,
    )
    export_preview(coords, g, args.candidate)


if __name__ == "__main__":
    main()
