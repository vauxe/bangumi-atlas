"""Bake a topology-preserving 3D graph layout."""

import argparse
import ast
import hashlib
import inspect
import json
import random
import textwrap
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

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

# UMAP won the layout bake-off; alternatives live in layout_bakeoff.py.
ALGO = "umap"

# python-igraph draws from the stdlib random module, not numpy.
SEED = 7

# Topology keeps all three axes: the body stays a volume, and structureless
# nodes surround it as a shell instead of being pushed into one plane.
TYPICAL_NODE_DISTANCE = 0.28
_JITTER_RADIUS = TYPICAL_NODE_DISTANCE * 0.15
_HALO_GAP = TYPICAL_NODE_DISTANCE * 6
_GOLDEN_ANGLE = np.pi * (3 - np.sqrt(5.0))


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


def run_layout(g: ig.Graph) -> np.ndarray:
    """Embed graph topology directly into three dimensions."""
    random.seed(SEED)
    layout = g.layout_umap(dim=3, epochs=200)
    return np.asarray(layout.coords, dtype=np.float32)


def detect_communities(g: ig.Graph) -> np.ndarray:
    """Partition the graph into the communities that colour the map."""
    random.seed(SEED)
    return np.asarray(
        g.community_leiden(
            objective_function="modularity", n_iterations=2
        ).membership,
        dtype=np.int64,
    )


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
    """Orient and scale continuous 3D topology coordinates."""
    points = desired.astype(np.float64)
    points -= points.mean(axis=0)
    if len(points) > 1:
        covariance = points.T @ points
        values, axes = np.linalg.eigh(covariance)
        points = points @ axes[:, np.argsort(values)[::-1]]

    # Principal components only fix a stable orientation; every axis keeps
    # its topology-derived extent, so scaling stays uniform and the body
    # stays a volume. Quantiles keep a few outliers from shrinking it.
    body_span = 0.0
    if len(points) > 1:
        bounds = np.quantile(points, (0.01, 0.99), axis=0)
        body_span = float((bounds[1] - bounds[0]).max())

    coords = points[:, (0, 2, 1)]
    if body_span > np.finfo(np.float64).eps:
        target_span = TYPICAL_NODE_DISTANCE * np.sqrt(len(coords))
        coords *= target_span / body_span
    coords += _jitter(keys)
    return coords


def _isolated_halo(count: int, inner_radius: float) -> np.ndarray:
    """Spread structureless nodes over a sparse shell around the body.

    A Fibonacci sphere keeps the shell evenly sampled at any count; the
    radius grows until every node owns a cell, so density never lies.
    """
    if count == 0:
        return np.empty((0, 3), dtype=np.float64)
    cell_area = np.sqrt(3.0) / 2 * TYPICAL_NODE_DISTANCE**2
    radius = max(inner_radius, float(np.sqrt(count * cell_area / (4 * np.pi))))
    order = np.arange(count, dtype=np.float64)
    height = 1.0 - 2.0 * (order + 0.5) / count
    ring = np.sqrt(np.maximum(0.0, 1.0 - height**2))
    angle = order * _GOLDEN_ANGLE
    coords = np.empty((count, 3), dtype=np.float64)
    coords[:, 0] = np.cos(angle) * ring * radius
    coords[:, 1] = height * radius
    coords[:, 2] = np.sin(angle) * ring * radius
    return coords


def shape_layout(
    desired: np.ndarray,
    keys: np.ndarray,
    degree: np.ndarray,
    years: np.ndarray,
) -> np.ndarray:
    """Create a topology volume wrapped in an isolated-node shell."""
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
        # The body is a volume, so the shell must clear its 3D extent.
        body_radius = float(np.linalg.norm(coords[connected], axis=1).max())
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


# 整形身份由下面这些函数和常量算出,不靠人手维护的形状标签:
# 忘记改标签会让新几何冒充旧几何,忘记改代码则摘要自然不动。
_SHAPE_LOGIC = (_jitter, _shape_connected, _isolated_halo, shape_layout)
_SHAPE_CONSTANTS = {
    "typical_node_distance": TYPICAL_NODE_DISTANCE,
    "jitter_radius": _JITTER_RADIUS,
    "halo_gap": _HALO_GAP,
    "golden_angle": float(_GOLDEN_ANGLE),
}


def _canonical_logic(fn: Callable[..., Any]) -> str:
    """函数逻辑的规范形式:注释、空行、缩进和文档字符串都不参与。"""
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.Module):
            continue
        head = node.body[0] if node.body else None
        if (
            isinstance(head, ast.Expr)
            and isinstance(head.value, ast.Constant)
            and isinstance(head.value.value, str)
        ):
            del node.body[0]
    return ast.dump(tree)


def shape_digest() -> str:
    """整形身份:整形逻辑或常量一变,摘要即变。"""
    return hashlib.sha256(
        json.dumps(
            {
                "constants": _SHAPE_CONSTANTS,
                "logic": [_canonical_logic(fn) for fn in _SHAPE_LOGIC],
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


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
    argparse.ArgumentParser().parse_args()

    keys, years, collects = load_nodes()
    index = {int(k): i for i, k in enumerate(keys)}
    print(f"节点 {len(keys):,}", flush=True)
    edges = load_edges(index)
    print(f"边 {len(edges):,}", flush=True)

    degree = np.zeros(len(keys), dtype=np.int64)
    np.add.at(degree, edges[:, 0], 1)
    np.add.at(degree, edges[:, 1], 1)
    isolated = degree == 0
    print(f"孤立节点 {isolated.sum():,}(外层球壳)", flush=True)

    connected = np.flatnonzero(~isolated)
    remap = -np.ones(len(keys), dtype=np.int64)
    remap[connected] = np.arange(len(connected))
    sub_edges = remap[edges]

    desired = np.zeros((len(keys), 3), dtype=np.float32)
    communities = np.full(len(keys), 0xFFFF, dtype=np.uint16)

    graph = ig.Graph(
        n=len(connected), edges=sub_edges.tolist(), directed=False
    )
    graph.simplify()
    started = time.time()
    desired[connected] = run_layout(graph)
    print(f"布局完成 {time.time() - started:,.0f}s", flush=True)
    started = time.time()
    communities[connected] = detect_communities(graph).astype(np.uint16)
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
        "algo": ALGO,
        "seed": SEED,
        "dimensions": int(coords.shape[1]),
        "shape_digest": shape_digest(),
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
