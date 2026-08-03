"""Bake a topology-preserving 3D graph layout."""

import argparse
import json
import time
from pathlib import Path

import igraph as ig
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from scipy.spatial import cKDTree

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

# Keep a navigable map silhouette while allowing topology-derived parallax.
DEPTH_RATIO = 0.20
TYPICAL_NODE_DISTANCE = 0.28
_JITTER_RADIUS = TYPICAL_NODE_DISTANCE * 0.15
_HALO_GAP = TYPICAL_NODE_DISTANCE * 6
_GOLDEN_ANGLE = np.pi * (3 - np.sqrt(5.0))

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


def run_layout(g: ig.Graph, algo: str) -> np.ndarray:
    """Embed graph topology directly into three dimensions."""
    if algo == "drl":
        layout = g.layout_drl(dim=3)
    elif algo == "umap":
        layout = g.layout_umap(dim=3, epochs=200)
    else:
        raise ValueError(algo)
    return np.asarray(layout.coords, dtype=np.float32)


def _jitter(keys: np.ndarray) -> np.ndarray:
    """Add a small deterministic offset for coincident projections."""
    h = keys.astype(np.uint64) + np.uint64(0x9E3779B97F4A7C15)
    with np.errstate(over="ignore"):
        h = (h ^ (h >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        h = (h ^ (h >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
    h ^= h >> np.uint64(31)
    unit = (h & np.uint64(0xFFFF_FFFF)).astype(np.float64) / 2**32
    radial = (h >> np.uint64(32)).astype(np.float64) / 2**32
    angle = 2 * np.pi * unit
    radius = _JITTER_RADIUS * np.sqrt(radial)
    jitter = np.zeros((len(keys), 3), dtype=np.float64)
    jitter[:, 0] = np.cos(angle) * radius
    jitter[:, 2] = np.sin(angle) * radius
    return jitter


def _shape_connected(desired: np.ndarray, keys: np.ndarray) -> np.ndarray:
    """Orient, flatten and scale continuous 3D topology coordinates."""
    points = desired.astype(np.float64)
    points -= points.mean(axis=0)
    if len(points) > 1:
        covariance = points.T @ points
        values, axes = np.linalg.eigh(covariance)
        points = points @ axes[:, np.argsort(values)[::-1]]

    # Principal components 0/1 form the map; component 2 becomes restrained
    # depth. Quantiles keep a few outliers from flattening the whole galaxy.
    horizontal_span = 0.0
    if len(points) > 1:
        bounds = np.quantile(points, (0.01, 0.99), axis=0)
        spans = bounds[1] - bounds[0]
        horizontal_span = float(max(spans[0], spans[1]))
        depth_span = float(spans[2])
        if horizontal_span > 0 and depth_span > 0:
            points[:, 2] *= DEPTH_RATIO * horizontal_span / depth_span

    coords = points[:, (0, 2, 1)]
    if horizontal_span > np.finfo(np.float64).eps:
        target_span = TYPICAL_NODE_DISTANCE * np.sqrt(len(coords))
        coords *= target_span / horizontal_span
    coords += _jitter(keys)
    return coords


def _isolated_halo(count: int, inner_radius: float) -> np.ndarray:
    """Place structureless nodes in a sparse, honest outer halo."""
    if count == 0:
        return np.empty((0, 3), dtype=np.float64)
    cell_area = np.sqrt(3.0) / 2 * TYPICAL_NODE_DISTANCE**2
    outer_radius = np.sqrt(inner_radius**2 + count * cell_area / np.pi)
    order = np.arange(count, dtype=np.float64)
    fraction = (order + 0.5) / count
    radius = np.sqrt(
        inner_radius**2
        + fraction * (outer_radius**2 - inner_radius**2)
    )
    angle = order * _GOLDEN_ANGLE
    coords = np.zeros((count, 3), dtype=np.float64)
    coords[:, 0] = np.cos(angle) * radius
    coords[:, 2] = np.sin(angle) * radius
    return coords


def shape_layout(
    desired: np.ndarray,
    keys: np.ndarray,
    degree: np.ndarray,
    years: np.ndarray,
) -> np.ndarray:
    """Create a flattened topology cloud plus an isolated-node halo."""
    n = len(keys)
    if desired.shape != (n, 3):
        raise ValueError(f"expected {(n, 3)} desired coordinates")
    if degree.shape != (n,) or years.shape != (n,):
        raise ValueError("degree and years must match node count")

    coords = np.zeros((n, 3), dtype=np.float64)
    connected = degree > 0
    if connected.any():
        coords[connected] = _shape_connected(
            desired[connected], keys[connected]
        )
        body_radius = float(
            np.linalg.norm(coords[connected][:, (0, 2)], axis=1).max()
        )
    else:
        body_radius = 0.0

    isolated = ~connected
    if isolated.any():
        isolated_index = np.flatnonzero(isolated)
        thematic_order = np.lexsort(
            (keys[isolated], years[isolated], keys[isolated] >> 24)
        )
        halo = _isolated_halo(int(isolated.sum()), body_radius + _HALO_GAP)
        coords[isolated_index[thematic_order]] = halo

    if not np.isfinite(coords).all():
        raise RuntimeError("layout contains non-finite coordinates")
    return coords.astype(np.float32)


def edge_compactness(coords: np.ndarray, edges: np.ndarray) -> float | None:
    """Mean edge length divided by mean random-pair length."""
    if not len(edges) or len(coords) < 2:
        return None
    sample_rng = np.random.default_rng(7)
    count = min(50_000, len(edges))
    picked = sample_rng.choice(len(edges), count, replace=False)
    selected = edges[picked]
    edge_length = np.linalg.norm(
        coords[selected[:, 0]] - coords[selected[:, 1]], axis=1
    )
    a = sample_rng.integers(0, len(coords), count)
    b = sample_rng.integers(0, len(coords), count)
    random_length = np.linalg.norm(coords[a] - coords[b], axis=1)
    mean_random = float(random_length.mean())
    return float(edge_length.mean()) / mean_random if mean_random else None


def main() -> None:
    ap = argparse.ArgumentParser()
    # UMAP is the production winner; DRL remains for reproducible bake-offs.
    ap.add_argument("--algo", choices=["drl", "umap"], default="umap")
    ap.add_argument(
        "--stub",
        action="store_true",
        help="skip the real layout and emit non-publishable test geometry",
    )
    args = ap.parse_args()

    keys, years, collects = load_nodes()
    index = {int(k): i for i, k in enumerate(keys)}
    print(f"节点 {len(keys):,}", flush=True)
    edges = load_edges(index)
    print(f"边 {len(edges):,}", flush=True)

    degree = np.zeros(len(keys), dtype=np.int64)
    np.add.at(degree, edges[:, 0], 1)
    np.add.at(degree, edges[:, 1], 1)
    isolated = degree == 0
    print(f"孤立节点 {isolated.sum():,}(外围光环)", flush=True)

    connected = np.flatnonzero(~isolated)
    remap = -np.ones(len(keys), dtype=np.int64)
    remap[connected] = np.arange(len(connected))
    sub_edges = remap[edges]

    desired = np.zeros((len(keys), 3), dtype=np.float32)
    communities = np.full(len(keys), 0xFFFF, dtype=np.uint16)

    if args.stub:
        desired[connected] = rng.normal(0, 1, (len(connected), 3)).astype(
            np.float32
        )
        communities[connected] = (keys[connected] % 512).astype(np.uint16)
    else:
        graph = ig.Graph(
            n=len(connected), edges=sub_edges.tolist(), directed=False
        )
        graph.simplify()
        started = time.time()
        desired[connected] = run_layout(graph, args.algo)
        print(f"布局完成 {time.time() - started:,.0f}s", flush=True)
        started = time.time()
        leiden = np.asarray(
            graph.community_leiden(
                objective_function="modularity", n_iterations=2
            ).membership,
            dtype=np.int64,
        )
        communities[connected] = leiden.astype(np.uint16)
        print(f"社区检测 {time.time() - started:,.0f}s", flush=True)

    started = time.time()
    coords = shape_layout(desired, keys, degree, years)
    projected = coords[:, (0, 2)]
    if len(coords) > 1:
        nearest = cKDTree(projected).query(
            projected,
            k=2,
            workers=-1,
        )[0][:, 1]
        min_distance = float(nearest.min())
        median_distance = float(np.median(nearest))
    else:
        min_distance = median_distance = 0.0
    compactness = edge_compactness(coords[connected], sub_edges)
    body = coords[connected] if len(connected) else coords
    spans = np.ptp(body, axis=0)
    horizontal_span = float(max(spans[0], spans[2]))
    actual_depth_ratio = (
        float(spans[1]) / horizontal_span if horizontal_span else 0.0
    )
    compactness_text = (
        f"{compactness:.3f}" if compactness is not None else "n/a"
    )
    print(
        f"3D 整形 {time.time() - started:,.0f}s:"
        f"投影中位间距 {median_distance:.3f},"
        f"边紧凑度 {compactness_text}",
        flush=True,
    )

    OUT.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {
        "algo": args.algo,
        "dimensions": 3,
        "geometry": "topology-3d",
        "stub": args.stub,
        "n_nodes": int(len(keys)),
        "n_connected": int(len(connected)),
        "min_projected_neighbor_distance": round(min_distance, 6),
        "median_projected_neighbor_distance": round(median_distance, 6),
        "depth_ratio": round(actual_depth_ratio, 6),
        "edge_compactness": (
            round(compactness, 6) if compactness is not None else None
        ),
    }
    (OUT / "report.json").write_text(json.dumps(report))
    pq.write_table(
        pa.table(
            {
                "key": pa.array(keys, pa.uint32()),
                "x": pa.array(coords[:, 0], pa.float32()),
                "y": pa.array(coords[:, 1], pa.float32()),
                "z": pa.array(coords[:, 2], pa.float32()),
                "community": pa.array(communities, pa.uint16()),
                "isolated": pa.array(isolated),
                "collect": pa.array(collects, pa.int64()),
                "year": pa.array(years, pa.uint16()),
                "degree": pa.array(degree, pa.int64()),
            }
        ),
        OUT / "coords.parquet",
    )
    print(f"已写出 {OUT / 'coords.parquet'}", flush=True)


if __name__ == "__main__":
    main()
