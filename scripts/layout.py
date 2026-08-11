"""Bake a topology-preserving 3D graph layout."""

import argparse
import ast
import hashlib
import inspect
import json
import platform
import random
import sys
import textwrap
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import igraph as ig
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import scipy
from scipy.spatial import cKDTree

from . import entity_key as ek
from . import parquet_provenance
from .build_lock import parquet_layout_lock

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "data" / "dump"
DUMP_ZIP = ROOT / "data" / "dump.zip"
MAPPINGS = ROOT / "data" / "mappings"
PARQUET = ROOT / "data" / "parquet"
OUT = ROOT / "data" / "layout"
LAYOUT_CACHE_DEPENDENCIES = {
    "entity_key.py": Path(ek.__file__),
    "layout.py": Path(__file__),
}

ETYPE = {"subject": 1, "person": 2, "character": 3}
EDGE_FILES = [
    ("relates_to", "from_id", "subject", "to_id", "subject"),
    ("worked_on", "from_id", "person", "to_id", "subject"),
    ("appears_in", "from_id", "character", "to_id", "subject"),
    ("voiced", "from_id", "person", "to_id", "character"),
    ("person_rel", "from_id", "person", "to_id", "person"),
    ("character_rel", "from_id", "character", "to_id", "character"),
]
LAYOUT_INPUT_FILES = (
    "subject.parquet",
    "person.parquet",
    "character.parquet",
    *(f"{name}.parquet" for name, *_ in EDGE_FILES),
)
LAYOUT_CACHE_FILE = "cache.json"
LAYOUT_CACHE_FORMAT = "layout-cache-v1"
LAYOUT_SCHEMA = pa.schema(
    [
        ("key", pa.uint32()),
        ("x", pa.float32()),
        ("y", pa.float32()),
        ("z", pa.float32()),
        ("community", pa.uint16()),
        ("isolated", pa.bool_()),
        ("collect", pa.int64()),
        ("year", pa.uint16()),
        ("degree", pa.int64()),
    ]
)

# UMAP preserves local topology inside each island; Leiden and a weighted
# community supergraph provide the global hierarchy.
ALGO = "hierarchical-community-islands"

# python-igraph draws from the stdlib random module, not numpy.
SEED = 7
LAYOUT_EPOCHS = 100

# Keep the connected graph volumetric and place structureless nodes around it.
TYPICAL_NODE_DISTANCE = 0.28
_JITTER_RADIUS = TYPICAL_NODE_DISTANCE * 0.15
ISLAND_GAP = TYPICAL_NODE_DISTANCE * 4
SATELLITE_GAP = TYPICAL_NODE_DISTANCE * 6
TARGET_COMMUNITY_ISLANDS = 64
COMMUNITY_NODE_SPREAD = 1.5
COMMUNITY_CORE_QUANTILE = 0.95
COMMUNITY_CORE_GAP = TYPICAL_NODE_DISTANCE
_HALO_GAP = TYPICAL_NODE_DISTANCE * 6
_GOLDEN_ANGLE = np.pi * (3 - np.sqrt(5.0))


def node_key(etype: str, ids: np.ndarray) -> np.ndarray:
    return ek.entity_keys(ETYPE[etype], ids)


def load_nodes() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """All map nodes -> (key, year, collect) arrays."""
    keys, years, collects = [], [], []
    t = pq.read_table(
        PARQUET / "subject.parquet",
        columns=["id", "date", "wish", "done", "doing", "on_hold", "dropped"],
    )
    ids = np.asarray(t.column("id"), dtype=np.int64)
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
        ids = np.asarray(t.column("id"), dtype=np.int64)
        keys.append(node_key(name, ids))
        years.append(np.zeros(len(ids), dtype=np.uint16))
        collects.append(np.asarray(t.column("collects"), dtype=np.int64))
    return (
        np.concatenate(keys),
        np.concatenate(years),
        np.concatenate(collects),
    )


def map_node_keys(keys: np.ndarray, endpoints: np.ndarray) -> np.ndarray:
    """Map sorted entity keys to compact u32 vertex indices."""
    if keys.ndim != 1 or endpoints.ndim == 0:
        raise ValueError("node keys and edge endpoints must be arrays")
    if len(keys) > 1 and (keys[1:] <= keys[:-1]).any():
        raise ValueError("node keys must be strictly increasing")

    positions = np.searchsorted(keys, endpoints)
    found = positions < len(keys)
    matched = np.zeros(endpoints.shape, dtype=bool)
    matched[found] = keys[positions[found]] == endpoints[found]
    if not matched.all():
        missing = int(endpoints[~matched][0])
        raise ValueError(f"edge endpoint {missing} has no matching node")
    if len(keys) > np.iinfo(np.uint32).max:
        raise ValueError("node count exceeds compact u32 edge indices")
    return positions.astype(np.uint32)


def load_edges(keys: np.ndarray) -> np.ndarray:
    counts = [
        pq.ParquetFile(PARQUET / f"{fname}.parquet").metadata.num_rows
        for fname, *_ in EDGE_FILES
    ]
    edges = np.empty((sum(counts), 2), dtype=np.uint32)
    offset = 0
    for fname, src_col, src_t, dst_col, dst_t in EDGE_FILES:
        t = pq.read_table(
            PARQUET / f"{fname}.parquet", columns=[src_col, dst_col]
        )
        end = offset + len(t)
        src_keys = node_key(
            src_t, np.asarray(t.column(src_col), dtype=np.int64)
        )
        edges[offset:end, 0] = map_node_keys(keys, src_keys)
        dst_keys = node_key(
            dst_t, np.asarray(t.column(dst_col), dtype=np.int64)
        )
        edges[offset:end, 1] = map_node_keys(keys, dst_keys)
        offset = end
    return edges


def build_graph(count: int, edges: np.ndarray) -> ig.Graph:
    """Build a simple graph without expanding edges into Python objects."""
    edge_array = np.asarray(edges)
    if edge_array.ndim != 2 or edge_array.shape[1] != 2:
        raise ValueError("graph edges must have two endpoints")
    if count < 0 or (
        edge_array.size and (edge_array.min() < 0 or edge_array.max() >= count)
    ):
        raise ValueError("graph edge endpoint is outside the vertex range")
    graph = ig.Graph(n=count, edges=edge_array, directed=False)
    graph.simplify()
    return graph


def run_layout(g: ig.Graph) -> np.ndarray:
    """Embed graph topology directly into three dimensions."""
    random.seed(SEED)
    layout = g.layout_umap(dim=3, epochs=LAYOUT_EPOCHS)
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


def _community_supergraph(
    edges: np.ndarray,
    membership: np.ndarray,
) -> ig.Graph:
    """Aggregate node edges into a weighted undirected community graph."""
    if edges.ndim != 2 or edges.shape[1] != 2:
        raise ValueError("community edges must have two endpoints")
    if membership.ndim != 1 or (membership < 0).any():
        raise ValueError("community membership must be non-negative")
    count = int(membership.max()) + 1 if len(membership) else 0
    if count == 0:
        return ig.Graph(n=0, directed=False)
    if not np.array_equal(np.unique(membership), np.arange(count)):
        raise ValueError("community membership must be dense")
    left = membership[edges[:, 0]]
    right = membership[edges[:, 1]]
    low = np.minimum(left, right)
    high = np.maximum(left, right)
    cross = low != high
    codes = low[cross] * count + high[cross]
    unique, weights = np.unique(codes, return_counts=True)
    pairs = np.column_stack([unique // count, unique % count])
    return ig.Graph(
        n=count,
        edges=pairs.tolist(),
        directed=False,
        edge_attrs={"weight": weights.astype(float).tolist()},
    )


def coarsen_communities(
    edges: np.ndarray,
    fine: np.ndarray,
    target: int,
) -> np.ndarray:
    """Assign fine Leiden groups to the nearest large anchor communities."""
    if target <= 0:
        raise ValueError("target community count must be positive")
    count = int(fine.max()) + 1 if len(fine) else 0
    if count <= target:
        return fine.astype(np.int64, copy=True)

    sizes = np.bincount(fine, minlength=count)
    anchors = np.lexsort((np.arange(count), -sizes))[:target]
    graph = _community_supergraph(edges, fine)
    edge_weight = np.asarray(graph.es["weight"], dtype=np.float64)
    travel_cost = 1.0 / np.log1p(edge_weight)
    distances = np.asarray(
        graph.distances(target=anchors.tolist(), weights=travel_cost.tolist())
    )
    if not np.isfinite(distances).any(axis=1).all():
        raise RuntimeError("fine-community graph is disconnected")
    fine_owner = np.argmin(distances, axis=1).astype(np.int64)
    return fine_owner[fine]


def run_macro_layout(graph: ig.Graph) -> np.ndarray:
    """Layout the small weighted community supergraph in three dimensions."""
    count = graph.vcount()
    if count == 0:
        return np.empty((0, 3), dtype=np.float64)
    if count == 1:
        return np.zeros((1, 3), dtype=np.float64)
    random.seed(SEED)
    weights = np.log1p(np.asarray(graph.es["weight"], dtype=np.float64))
    layout = graph.layout_fruchterman_reingold(
        dim=3,
        niter=1000,
        weights=weights.tolist(),
    )
    return np.asarray(layout.coords, dtype=np.float64)


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


def minimum_island_gap(centers: np.ndarray, radii: np.ndarray) -> float:
    """Return the smallest surface-to-surface distance between islands."""
    count = len(radii)
    if centers.shape != (count, 3):
        raise ValueError("island centers and radii must align")
    if count < 2:
        return float("inf")
    closest = float("inf")
    for left in range(count - 1):
        distances = np.linalg.norm(centers[left + 1 :] - centers[left], axis=1)
        clearances = distances - radii[left + 1 :] - radii[left]
        closest = min(closest, float(clearances.min()))
    return closest


def _pair_direction(left: int, right: int) -> np.ndarray:
    """Deterministic 3D direction for coincident island centers."""
    order = float((left + 1) * 104729 + (right + 1) * 130363)
    height = 2.0 * ((order * 0.6180339887498949) % 1.0) - 1.0
    ring = np.sqrt(max(0.0, 1.0 - height * height))
    angle = order * _GOLDEN_ANGLE
    return np.array(
        [np.cos(angle) * ring, height, np.sin(angle) * ring],
        dtype=np.float64,
    )


def pack_island_centers(
    desired: np.ndarray,
    radii: np.ndarray,
    gap: float,
) -> np.ndarray:
    """Relax island centers until their bounding spheres no longer overlap."""
    count = len(radii)
    if desired.shape != (count, 3):
        raise ValueError("desired island centers and radii must align")
    if not np.isfinite(desired).all() or not np.isfinite(radii).all():
        raise ValueError("island geometry must be finite")
    if (radii < 0).any() or gap < 0:
        raise ValueError("island radii and gap must not be negative")
    if count == 0:
        return np.empty((0, 3), dtype=np.float64)
    if count == 1:
        return np.zeros((1, 3), dtype=np.float64)

    centers = desired.astype(np.float64, copy=True)
    centers -= centers.mean(axis=0)
    pair_distance = np.linalg.norm(
        centers[:, None, :] - centers[None, :, :], axis=2
    )
    nonzero = pair_distance[pair_distance > np.finfo(np.float64).eps]
    target_distance = 2 * float(np.median(radii)) + gap
    if len(nonzero):
        centers *= target_distance / float(np.median(nonzero))
    else:
        centers = _fibonacci_unit_sphere(count) * target_distance

    masses = np.maximum(radii, TYPICAL_NODE_DISTANCE / 2) ** 3
    tolerance = np.finfo(np.float64).eps * 64
    for _ in range(256):
        largest_overlap = 0.0
        for left in range(count - 1):
            for right in range(left + 1, count):
                delta = centers[right] - centers[left]
                distance = float(np.linalg.norm(delta))
                required = float(radii[left] + radii[right] + gap)
                overlap = required - distance
                if overlap <= tolerance:
                    continue
                largest_overlap = max(largest_overlap, overlap)
                direction = (
                    delta / distance
                    if distance > tolerance
                    else _pair_direction(left, right)
                )
                total_mass = masses[left] + masses[right]
                centers[left] -= (
                    direction * overlap * masses[right] / total_mass
                )
                centers[right] += (
                    direction * overlap * masses[left] / total_mass
                )
        centers -= centers.mean(axis=0)
        if largest_overlap <= tolerance:
            break

    required_scale = 1.0
    for left in range(count - 1):
        distances = np.linalg.norm(centers[left + 1 :] - centers[left], axis=1)
        required = radii[left + 1 :] + radii[left] + gap
        required_scale = max(
            required_scale,
            float(np.max(required / np.maximum(distances, tolerance))),
        )
    centers *= required_scale * (1.0 + 1e-12)
    return centers


def place_islands(
    desired: np.ndarray,
    keys: np.ndarray,
    island: np.ndarray,
    desired_centers: np.ndarray,
    gap: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Shape local topology independently, then place separated islands."""
    if desired.shape != (len(keys), 3) or island.shape != (len(keys),):
        raise ValueError("island node arrays must align")
    if len(island) == 0:
        return (
            np.empty((0, 3), dtype=np.float64),
            np.empty((0, 3), dtype=np.float64),
            np.empty(0, dtype=np.float64),
        )
    count = int(island.max()) + 1
    if island.min() < 0 or not np.array_equal(
        np.unique(island), np.arange(count)
    ):
        raise ValueError("island ids must be dense non-negative integers")
    if desired_centers.shape != (count, 3):
        raise ValueError("desired centers must match island count")

    local, radii = _local_island_geometry(desired, keys, island, count)
    centers = pack_island_centers(desired_centers, radii, gap)
    return local + centers[island], centers, radii


def _local_island_geometry(
    desired: np.ndarray,
    keys: np.ndarray,
    island: np.ndarray,
    count: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Orient and scale each island around its own local origin."""
    local = np.zeros_like(desired, dtype=np.float64)
    radii = np.zeros(count, dtype=np.float64)
    for group in range(count):
        members = island == group
        shaped = _shape_connected(desired[members], keys[members])
        shaped -= shaped.mean(axis=0)
        local[members] = shaped
        radii[group] = max(
            TYPICAL_NODE_DISTANCE / 2,
            float(np.linalg.norm(shaped, axis=1).max()),
        )
    return local, radii


def tighten_islands(
    local: np.ndarray,
    island: np.ndarray,
    desired_centers: np.ndarray,
    *,
    node_spread: float = COMMUNITY_NODE_SPREAD,
    core_quantile: float = COMMUNITY_CORE_QUANTILE,
    gap: float = COMMUNITY_CORE_GAP,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Spread local nodes, then repack centers around each dense core."""
    if local.ndim != 2 or local.shape[1] != 3:
        raise ValueError("local island geometry must have three dimensions")
    if island.shape != (len(local),) or len(local) == 0:
        raise ValueError("local geometry and island ids must align")
    count = len(desired_centers)
    if desired_centers.shape != (count, 3):
        raise ValueError("desired island centers must have three dimensions")
    if island.min() < 0 or not np.array_equal(
        np.unique(island), np.arange(count)
    ):
        raise ValueError("island ids must be dense non-negative integers")
    if node_spread <= 0 or not 0 < core_quantile <= 1 or gap < 0:
        raise ValueError("island tightening parameters are out of range")

    expanded = local.astype(np.float64, copy=True) * node_spread
    actual_radii = np.zeros(count, dtype=np.float64)
    core_radii = np.zeros(count, dtype=np.float64)
    node_radius = TYPICAL_NODE_DISTANCE / 2
    for group in range(count):
        radial = np.linalg.norm(expanded[island == group], axis=1)
        actual_radii[group] = max(node_radius, float(radial.max()))
        core_radii[group] = max(
            node_radius,
            float(np.quantile(radial, core_quantile)),
        )
    centers = pack_island_centers(desired_centers, core_radii, gap)
    return expanded + centers[island], centers, actual_radii, core_radii


def _fibonacci_unit_sphere(count: int) -> np.ndarray:
    """Evenly sample deterministic unit directions at any count."""
    if count == 0:
        return np.empty((0, 3), dtype=np.float64)
    order = np.arange(count, dtype=np.float64)
    height = 1.0 - 2.0 * (order + 0.5) / count
    ring = np.sqrt(np.maximum(0.0, 1.0 - height**2))
    angle = order * _GOLDEN_ANGLE
    coords = np.empty((count, 3), dtype=np.float64)
    coords[:, 0] = np.cos(angle) * ring
    coords[:, 1] = height
    coords[:, 2] = np.sin(angle) * ring
    return coords


def satellite_island_centers(
    radii: np.ndarray,
    body_radius: float,
) -> np.ndarray:
    """Place small connected components on a sphere outside the giant body."""
    if not np.isfinite(radii).all() or (radii < 0).any():
        raise ValueError("satellite radii must be finite and non-negative")
    if not np.isfinite(body_radius) or body_radius < 0:
        raise ValueError("body radius must be finite and non-negative")
    count = len(radii)
    if count == 0:
        return np.empty((0, 3), dtype=np.float64)

    units = _fibonacci_unit_sphere(count)
    padded = radii + ISLAND_GAP / 2
    area_radius = float(np.sqrt(np.square(padded).sum() / 2.8))
    sphere_radius = max(
        body_radius + SATELLITE_GAP + float(radii.max()),
        area_radius,
    )
    max_pair_distance = 2 * float(radii.max()) + ISLAND_GAP
    for _ in range(8):
        centers = units * sphere_radius
        pairs = cKDTree(centers).query_pairs(
            max_pair_distance, output_type="ndarray"
        )
        if not len(pairs):
            return centers
        distances = np.linalg.norm(
            centers[pairs[:, 0]] - centers[pairs[:, 1]], axis=1
        )
        required = radii[pairs[:, 0]] + radii[pairs[:, 1]] + ISLAND_GAP
        scale = float(np.max(required / distances))
        if scale <= 1.0 + 1e-12:
            return centers
        sphere_radius *= scale * (1.0 + 1e-12)
    raise RuntimeError("satellite island packing did not converge")


def _simple_induced_edges(
    edges: np.ndarray,
    vertices: np.ndarray,
    vertex_count: int,
) -> np.ndarray:
    """Return dense, unique undirected edges induced by selected vertices."""
    if vertices.ndim != 1 or (
        len(vertices)
        and (vertices.min() < 0 or vertices.max() >= vertex_count)
    ):
        raise ValueError("induced vertices are outside the graph")
    if len(vertices) == 0:
        return np.empty((0, 2), dtype=np.uint32)

    remap = np.full(vertex_count, -1, dtype=np.int32)
    remap[vertices] = np.arange(len(vertices), dtype=np.int32)
    mapped = remap[np.asarray(edges)]
    mapped = mapped[(mapped[:, 0] >= 0) & (mapped[:, 1] >= 0)]
    if not len(mapped):
        return np.empty((0, 2), dtype=np.uint32)

    low = np.minimum(mapped[:, 0], mapped[:, 1]).astype(np.uint64)
    high = np.maximum(mapped[:, 0], mapped[:, 1]).astype(np.uint64)
    keep = low != high
    codes = np.unique(low[keep] * np.uint64(len(vertices)) + high[keep])
    simple = np.empty((len(codes), 2), dtype=np.uint32)
    simple[:, 0] = codes // np.uint64(len(vertices))
    simple[:, 1] = codes % np.uint64(len(vertices))
    return simple


def hierarchical_connected_layout(
    edges: np.ndarray,
    keys: np.ndarray,
    *,
    target_islands: int = TARGET_COMMUNITY_ISLANDS,
) -> tuple[np.ndarray, np.ndarray, dict[str, int | float]]:
    """Build separated giant-component communities and component satellites."""
    count = len(keys)
    if keys.shape != (count,):
        raise ValueError("connected edges and keys must align")
    if count == 0:
        return (
            np.empty((0, 3), dtype=np.float32),
            np.empty(0, dtype=np.uint16),
            {
                "n_components": 0,
                "n_giant_nodes": 0,
                "n_community_islands": 0,
                "n_satellite_islands": 0,
                "min_community_island_gap": 0.0,
                "min_community_core_gap": 0.0,
                "community_core_quantile": COMMUNITY_CORE_QUANTILE,
                "community_node_spread": COMMUNITY_NODE_SPREAD,
                "min_satellite_island_gap": 0.0,
                "giant_body_radius": 0.0,
                "satellite_radius": 0.0,
            },
        )

    graph = build_graph(count, edges)
    components = np.asarray(
        graph.connected_components().membership, dtype=np.int32
    )
    component_sizes = np.bincount(components)
    giant_component = int(np.argmax(component_sizes))
    giant_vertices = np.flatnonzero(components == giant_component)
    small_vertices = np.flatnonzero(components != giant_component)
    # igraph preserves a component-sensitive edge order for this induced
    # graph. UMAP consumes that order, so retain the tiny native subgraph
    # while still releasing the million-node parent before the giant layout.
    small_graph = (
        graph.subgraph(small_vertices.tolist())
        if len(small_vertices)
        else None
    )
    del graph
    giant_edges = _simple_induced_edges(edges, giant_vertices, count)
    giant = build_graph(len(giant_vertices), giant_edges)

    fine = detect_communities(giant)
    macro = coarsen_communities(giant_edges, fine, target_islands)
    macro_count = int(macro.max()) + 1
    macro_graph = _community_supergraph(giant_edges, macro)
    macro_desired = run_macro_layout(macro_graph)
    giant_desired = run_layout(giant)
    del fine, giant, giant_edges, macro_graph
    giant_coords, macro_centers, _macro_radii = place_islands(
        giant_desired,
        keys[giant_vertices],
        macro,
        macro_desired,
        ISLAND_GAP,
    )
    giant_local = giant_coords - macro_centers[macro]
    giant_coords, macro_centers, macro_radii, macro_core_radii = (
        tighten_islands(giant_local, macro, macro_centers)
    )

    coords = np.zeros((count, 3), dtype=np.float64)
    communities = np.zeros(count, dtype=np.int64)
    coords[giant_vertices] = giant_coords
    communities[giant_vertices] = macro
    giant_radius = float(np.linalg.norm(giant_coords, axis=1).max())

    satellite_count = 0
    satellite_gap = 0.0
    satellite_radius = 0.0
    if small_graph is not None:
        _, satellite = np.unique(
            components[small_vertices], return_inverse=True
        )
        satellite = satellite.astype(np.int64)
        satellite_count = int(satellite.max()) + 1
        small_desired = run_layout(small_graph)
        del small_graph
        local, satellite_radii = _local_island_geometry(
            small_desired,
            keys[small_vertices],
            satellite,
            satellite_count,
        )
        local *= COMMUNITY_NODE_SPREAD
        satellite_radii *= COMMUNITY_NODE_SPREAD
        satellite_centers = satellite_island_centers(
            satellite_radii, giant_radius
        )
        coords[small_vertices] = local + satellite_centers[satellite]
        communities[small_vertices] = macro_count + satellite
        satellite_gap = minimum_island_gap(satellite_centers, satellite_radii)
        satellite_radius = float(np.linalg.norm(satellite_centers[0]))

    if int(communities.max()) >= 0xFFFF:
        raise RuntimeError("community island count exceeds the u16 contract")
    macro_gap = (
        minimum_island_gap(macro_centers, macro_radii)
        if macro_count > 1
        else 0.0
    )
    macro_core_gap = (
        minimum_island_gap(macro_centers, macro_core_radii)
        if macro_count > 1
        else 0.0
    )
    report: dict[str, int | float] = {
        "n_components": int(len(component_sizes)),
        "n_giant_nodes": int(len(giant_vertices)),
        "n_community_islands": macro_count,
        "n_satellite_islands": satellite_count,
        "min_community_island_gap": macro_gap,
        "min_community_core_gap": macro_core_gap,
        "community_core_quantile": COMMUNITY_CORE_QUANTILE,
        "community_node_spread": COMMUNITY_NODE_SPREAD,
        "min_satellite_island_gap": satellite_gap,
        "giant_body_radius": giant_radius,
        "satellite_radius": satellite_radius,
    }
    return coords.astype(np.float32), communities.astype(np.uint16), report


def _isolated_halo(count: int, inner_radius: float) -> np.ndarray:
    """Spread structureless nodes over a sparse shell around the body.

    A Fibonacci sphere keeps the shell evenly sampled at any count; the
    radius grows until every node owns a cell, so density never lies.
    """
    if count == 0:
        return np.empty((0, 3), dtype=np.float64)
    cell_area = np.sqrt(3.0) / 2 * TYPICAL_NODE_DISTANCE**2
    radius = max(inner_radius, float(np.sqrt(count * cell_area / (4 * np.pi))))
    return _fibonacci_unit_sphere(count) * radius


def wrap_isolated_shell(
    connected_coords: np.ndarray,
    keys: np.ndarray,
    degree: np.ndarray,
    years: np.ndarray,
) -> np.ndarray:
    """Preserve connected islands inside the degree-zero outer shell."""
    node_count = len(keys)
    connected = degree > 0
    if connected_coords.shape != (int(connected.sum()), 3):
        raise ValueError("connected coordinates must match non-isolated nodes")
    if degree.shape != (node_count,) or years.shape != (node_count,):
        raise ValueError("degree and years must match node count")

    coords = np.zeros((node_count, 3), dtype=np.float64)
    coords[connected] = connected_coords
    body_radius = (
        float(np.linalg.norm(connected_coords, axis=1).max())
        if len(connected_coords)
        else 0.0
    )
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

    connected = degree > 0
    shaped = _shape_connected(desired[connected], keys[connected])
    return wrap_isolated_shell(shaped, keys, degree, years)


_SHAPE_LOGIC = (
    build_graph,
    run_layout,
    detect_communities,
    _community_supergraph,
    coarsen_communities,
    run_macro_layout,
    _jitter,
    _shape_connected,
    _pair_direction,
    pack_island_centers,
    _local_island_geometry,
    place_islands,
    tighten_islands,
    _fibonacci_unit_sphere,
    satellite_island_centers,
    _simple_induced_edges,
    hierarchical_connected_layout,
    _isolated_halo,
    wrap_isolated_shell,
    shape_layout,
)
_SHAPE_CONSTANTS = {
    "algo": ALGO,
    "seed": SEED,
    "layout_epochs": LAYOUT_EPOCHS,
    "typical_node_distance": TYPICAL_NODE_DISTANCE,
    "jitter_radius": _JITTER_RADIUS,
    "island_gap": ISLAND_GAP,
    "satellite_gap": SATELLITE_GAP,
    "target_community_islands": TARGET_COMMUNITY_ISLANDS,
    "community_node_spread": COMMUNITY_NODE_SPREAD,
    "community_core_quantile": COMMUNITY_CORE_QUANTILE,
    "community_core_gap": COMMUNITY_CORE_GAP,
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


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def layout_input_digest(parquet: Path) -> str:
    """Identify every Parquet file that can affect layout output."""
    entries = [
        [name, _file_sha256(parquet / name)] for name in LAYOUT_INPUT_FILES
    ]
    return _layout_input_digest(entries)


def _layout_input_digest(entries: list[list[str]]) -> str:
    return hashlib.sha256(
        json.dumps(entries, separators=(",", ":")).encode()
    ).hexdigest()


def layout_input_digest_from_generation(generation: dict[str, Any]) -> str:
    """Reuse hashes already checked by generation validation."""

    parquet = generation.get("parquet")
    if not isinstance(parquet, dict):
        raise ValueError("generation has no Parquet identities")
    entries: list[list[str]] = []
    for name in LAYOUT_INPUT_FILES:
        identity = parquet.get(name)
        digest = identity.get("sha256") if isinstance(identity, dict) else None
        if not isinstance(digest, str) or len(digest) != 64:
            raise ValueError(f"generation has no valid digest for {name}")
        entries.append([name, digest])
    return _layout_input_digest(entries)


def _artifact_fingerprint(path: Path) -> dict[str, int | str]:
    return {"bytes": path.stat().st_size, "sha256": _file_sha256(path)}


def layout_cache_identity() -> str:
    """Identify layout code, shared key encoding, and numeric runtimes."""
    return hashlib.sha256(
        json.dumps(
            {
                "files": {
                    name: _file_sha256(path)
                    for name, path in sorted(LAYOUT_CACHE_DEPENDENCIES.items())
                },
                "runtime": {
                    "python": platform.python_implementation()
                    + " "
                    + ".".join(str(part) for part in sys.version_info[:3]),
                    "igraph": ig.__version__,
                    "numpy": np.__version__,
                    "pyarrow": pa.__version__,
                    "scipy": scipy.__version__,
                },
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def _layout_outputs_valid(output: Path, current_shape_digest: str) -> bool:
    try:
        report = json.loads((output / "report.json").read_text())
        if not isinstance(report, dict):
            return False
        parquet = pq.ParquetFile(output / "coords.parquet")
        rows = parquet.metadata.num_rows
        connected = report.get("n_connected")
        return (
            not report.get("stub")
            and report.get("dimensions") == 3
            and report.get("shape_digest") == current_shape_digest
            and report.get("n_nodes") == rows
            and isinstance(connected, int)
            and 0 <= connected <= rows
            and parquet.schema_arrow == LAYOUT_SCHEMA
        )
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
        return False


def write_layout_cache(
    output: Path,
    input_digest: str,
    current_shape_digest: str,
    cache_identity: str | None = None,
) -> None:
    """Publish a cache stamp only after both layout artifacts are valid."""
    if not _layout_outputs_valid(output, current_shape_digest):
        raise ValueError("refusing to cache invalid layout outputs")
    cache = {
        "format": LAYOUT_CACHE_FORMAT,
        "input_digest": input_digest,
        "shape_digest": current_shape_digest,
        "cache_identity": cache_identity or layout_cache_identity(),
        "artifacts": {
            name: _artifact_fingerprint(output / name)
            for name in ("coords.parquet", "report.json")
        },
    }
    target = output / LAYOUT_CACHE_FILE
    staging = output / f".{LAYOUT_CACHE_FILE}.build"
    staging.write_text(json.dumps(cache, sort_keys=True))
    staging.replace(target)


def layout_cache_matches(
    output: Path,
    input_digest: str,
    current_shape_digest: str,
    cache_identity: str | None = None,
) -> bool:
    """Return true only for an intact layout built from the exact inputs."""
    try:
        cache = json.loads((output / LAYOUT_CACHE_FILE).read_text())
        if (
            not isinstance(cache, dict)
            or cache.get("format") != LAYOUT_CACHE_FORMAT
            or cache.get("input_digest") != input_digest
            or cache.get("shape_digest") != current_shape_digest
            or cache.get("cache_identity")
            != (cache_identity or layout_cache_identity())
            or not _layout_outputs_valid(output, current_shape_digest)
        ):
            return False
        artifacts = cache.get("artifacts")
        if not isinstance(artifacts, dict):
            return False
        return all(
            artifacts.get(name) == _artifact_fingerprint(output / name)
            for name in ("coords.parquet", "report.json")
        )
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
        return False


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


def build_layout(force: bool, generation: dict[str, Any]) -> None:
    """Build or reuse layout for one already validated generation."""

    current_shape_digest = shape_digest()
    input_digest = layout_input_digest_from_generation(generation)
    cache_identity = layout_cache_identity()
    if not force and layout_cache_matches(
        OUT, input_digest, current_shape_digest, cache_identity
    ):
        print(
            f"布局缓存命中 {input_digest[:12]},坐标文件未重写",
            flush=True,
        )
        return
    (OUT / LAYOUT_CACHE_FILE).unlink(missing_ok=True)

    keys, years, collects = load_nodes()
    print(f"节点 {len(keys):,}", flush=True)
    edges = load_edges(keys)
    print(f"边 {len(edges):,}", flush=True)

    degree = np.zeros(len(keys), dtype=np.int64)
    np.add.at(degree, edges[:, 0], 1)
    np.add.at(degree, edges[:, 1], 1)
    isolated = degree == 0
    print(f"孤立节点 {isolated.sum():,}(外层球壳)", flush=True)

    connected = np.flatnonzero(~isolated)
    remap = np.full(len(keys), -1, dtype=np.int32)
    remap[connected] = np.arange(len(connected), dtype=np.int32)
    sub_edges = remap[edges]

    communities = np.full(len(keys), 0xFFFF, dtype=np.uint16)

    started = time.time()
    connected_coords, connected_communities, hierarchy = (
        hierarchical_connected_layout(sub_edges, keys[connected])
    )
    communities[connected] = connected_communities
    print(
        f"层次布局完成 {time.time() - started:,.0f}s:"
        f"主体 {hierarchy['n_community_islands']} 个社区岛,"
        f"卫星 {hierarchy['n_satellite_islands']} 个分量岛",
        flush=True,
    )

    started = time.time()
    coords = wrap_isolated_shell(connected_coords, keys, degree, years)
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
        "epochs": LAYOUT_EPOCHS,
        "dimensions": int(coords.shape[1]),
        "geometry": "topology-3d-community-islands",
        "shape_digest": current_shape_digest,
        "n_nodes": int(len(keys)),
        "n_connected": int(len(connected)),
        **{
            key: round(value, 6) if isinstance(value, float) else value
            for key, value in hierarchy.items()
        },
        "min_projected_neighbor_distance": round(min_distance, 6),
        "median_projected_neighbor_distance": round(median_distance, 6),
        "depth_ratio": round(actual_depth_ratio, 6),
        "edge_compactness": (
            round(compactness, 6) if compactness is not None else None
        ),
    }
    table = pa.table(
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
        },
        schema=LAYOUT_SCHEMA,
    )
    report_path = OUT / "report.json"
    coords_path = OUT / "coords.parquet"
    report_staging = OUT / ".report.json.build"
    coords_staging = OUT / ".coords.parquet.build"
    report_staging.unlink(missing_ok=True)
    coords_staging.unlink(missing_ok=True)
    try:
        report_staging.write_text(json.dumps(report))
        pq.write_table(table, coords_staging)
        if layout_input_digest(PARQUET) != input_digest:
            raise RuntimeError(
                "layout inputs changed while building; not published"
            )
        if layout_cache_identity() != cache_identity:
            raise RuntimeError(
                "layout implementation changed while building; not published"
            )
        coords_staging.replace(coords_path)
        report_staging.replace(report_path)
    finally:
        report_staging.unlink(missing_ok=True)
        coords_staging.unlink(missing_ok=True)
    write_layout_cache(
        OUT,
        input_digest,
        current_shape_digest,
        cache_identity,
    )
    print(f"已写出 {OUT / 'coords.parquet'}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--force",
        action="store_true",
        help="ignore a valid layout cache and recompute coordinates",
    )
    cli = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    with parquet_layout_lock(PARQUET):
        generation = parquet_provenance.require_valid_generation(
            dump=DUMP,
            dump_zip=DUMP_ZIP,
            mappings=MAPPINGS,
            parquet=PARQUET,
        )
        build_layout(cli.force, generation)


if __name__ == "__main__":
    main()
