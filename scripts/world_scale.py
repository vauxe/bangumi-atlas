"""Normalize and globally separate published layout coordinates."""

from __future__ import annotations

from dataclasses import dataclass
from math import sqrt

import numpy as np
from scipy.spatial import cKDTree

# 探索端的聚焦层级、工作集字号和节点尺寸按绝对 zoom 调参,
# 其语义依赖稳定的世界尺度;UMAP 等布局算法的输出尺度是任意的,
# 发布前必须归一到规范跨度。
CANONICAL_WORLD_SPAN = 600.0
MIN_NODE_CENTER_DISTANCE = 0.28

# 发布点落在带小幅确定性扰动的三维网格上。网格间距比
# 公开契约多 0.02，扰动后的理论下界仍比契约多 0.01，足以
# 覆盖 float32 在 600 左右世界尺度上的量化误差。
_LATTICE_EXTRA_DISTANCE = 0.02
_LATTICE_BITS = 21
_LATTICE_BIAS = 1 << (_LATTICE_BITS - 1)
_INITIAL_OFFSET_COUNT = 8192
_OFFSET_SEARCH_STRIDE = 1024
_MAX_ASSIGNMENT_ROUNDS = 128
_HASH_MULTIPLIER = 11_400_714_819_323_198_485


@dataclass(frozen=True)
class SeparationReport:
    """发布坐标的全局节点间距处理报告。"""

    total_nodes: int
    moved_nodes: int
    max_displacement: float
    minimum_center_distance: float
    placement_clearance: float
    assignment_rounds: int


def _require_coordinate_matrix(coordinates: np.ndarray) -> None:
    if coordinates.ndim != 2 or coordinates.shape[1] != 3:
        raise ValueError("coordinates must be (n, 3)")
    if len(coordinates) == 0:
        raise ValueError("layout must contain at least one node")


def _encode_lattice_cells(cells: np.ndarray) -> np.ndarray:
    """Pack three signed 21-bit cell coordinates into one uint64."""

    shifted = cells.astype(np.int64) + _LATTICE_BIAS
    if int(shifted.min()) < 0 or int(shifted.max()) >= 1 << _LATTICE_BITS:
        raise ValueError("layout exceeds the lattice encoding range")
    unsigned = shifted.astype(np.uint64)
    return (
        unsigned[:, 0]
        | (unsigned[:, 1] << np.uint64(_LATTICE_BITS))
        | (unsigned[:, 2] << np.uint64(_LATTICE_BITS * 2))
    )


def _nearest_lattice_offsets(count: int) -> np.ndarray:
    """Build at least ``count`` integer offsets, nearest shells first."""

    offsets = [(0, 0, 0)]
    shell = 1
    while len(offsets) < count:
        part = [
            (dx, dy, dz)
            for dx in range(-shell, shell + 1)
            for dy in range(-shell, shell + 1)
            for dz in range(-shell, shell + 1)
            if max(abs(dx), abs(dy), abs(dz)) == shell
        ]
        part.sort(
            key=lambda p: (
                p[0] * p[0] + p[1] * p[1] + p[2] * p[2],
                abs(p[1]),
                p,
            )
        )
        offsets.extend(part)
        shell += 1
    return np.asarray(offsets, dtype=np.int32)


def _orient_offsets(offsets: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    """Rotate/reflect whole preferred-cell groups deterministically."""

    oriented = offsets.copy()
    swap = (seeds & np.uint64(8)) != 0
    old_x = oriented[swap, 0].copy()
    oriented[swap, 0] = oriented[swap, 2]
    oriented[swap, 2] = old_x
    for axis, bit in enumerate((1, 2, 4)):
        negative = (seeds & np.uint64(bit)) == 0
        oriented[negative, axis] *= -1
    return oriented


def _assign_unique_cells(
    preferred: np.ndarray,
    preferred_keys: np.ndarray,
) -> tuple[np.ndarray, int]:
    """Assign duplicate preferred cells in stable input order."""

    order = np.argsort(preferred_keys, kind="stable")
    sorted_keys = preferred_keys[order]
    new_group = np.r_[True, sorted_keys[1:] != sorted_keys[:-1]]
    starts = np.flatnonzero(new_group)
    lengths = np.diff(np.r_[starts, len(preferred)])
    ordinal_sorted = np.arange(len(preferred), dtype=np.int32) - np.repeat(
        starts.astype(np.int32), lengths
    )
    ordinal = np.empty(len(preferred), dtype=np.int32)
    ordinal[order] = ordinal_sorted

    assigned = np.empty_like(preferred)
    anchors = ordinal == 0
    assigned[anchors] = preferred[anchors]
    occupied = sorted_keys[starts]
    unresolved = np.flatnonzero(~anchors)
    attempt = ordinal[unresolved].copy()
    offset_count = max(
        _INITIAL_OFFSET_COUNT,
        int(attempt.max(initial=0)) + _OFFSET_SEARCH_STRIDE,
    )
    offsets = _nearest_lattice_offsets(offset_count)
    assignment_rounds = 0

    for round_number in range(1, _MAX_ASSIGNMENT_ROUNDS + 1):
        if len(unresolved) == 0:
            break
        assignment_rounds = round_number
        if int(attempt.max()) >= len(offsets):
            offsets = _nearest_lattice_offsets(len(offsets) * 2)
        raw_offsets = offsets[attempt]
        candidates = preferred[unresolved] + _orient_offsets(
            raw_offsets, preferred_keys[unresolved]
        )
        candidate_keys = _encode_lattice_cells(candidates)
        positions = np.searchsorted(occupied, candidate_keys)
        positions = np.minimum(positions, len(occupied) - 1)
        free_local = np.flatnonzero(occupied[positions] != candidate_keys)
        if len(free_local):
            _, first = np.unique(candidate_keys[free_local], return_index=True)
            winners_local = free_local[first]
        else:
            winners_local = np.empty(0, dtype=np.int64)

        winners = unresolved[winners_local]
        assigned[winners] = candidates[winners_local]
        occupied = np.union1d(occupied, candidate_keys[winners_local])
        keep = np.ones(len(unresolved), dtype=bool)
        keep[winners_local] = False
        unresolved = unresolved[keep]
        attempt = attempt[keep] + _OFFSET_SEARCH_STRIDE
    if len(unresolved):
        raise RuntimeError(
            f"cannot assign {len(unresolved)} nodes after "
            f"{_MAX_ASSIGNMENT_ROUNDS} lattice rounds"
        )
    return assigned, assignment_rounds


def normalize_world_scale(
    coordinates: np.ndarray,
    span: float = CANONICAL_WORLD_SPAN,
) -> tuple[np.ndarray, float]:
    """Scale coordinates so the largest axis span equals ``span``."""

    _require_coordinate_matrix(coordinates)
    extent = float((coordinates.max(axis=0) - coordinates.min(axis=0)).max())
    if not np.isfinite(extent) or extent <= 0:
        raise ValueError("layout extent must be positive and finite")
    scale = span / extent
    return coordinates * scale, scale


def separate_published_nodes(
    coordinates: np.ndarray,
    minimum_distance: float = MIN_NODE_CENTER_DISTANCE,
) -> tuple[np.ndarray, SeparationReport]:
    """Place every float32 node at least ``minimum_distance`` apart.

    The final points occupy distinct cells on a lightly jittered 3-D lattice.
    Every cell therefore has a mathematical distance lower bound independent
    of local density. Duplicate preferred cells are assigned in VisualRank
    order through vectorized sorted-key batches. The algorithm is O(n) in
    storage and never materializes the tens of millions of nearby pairs.

    Collision resolution may expand the final bounding box. There is
    deliberately no second normalization: shrinking the result afterward
    would invalidate the minimum-distance contract. The frontend already uses
    the published bbox to frame the full graph.
    """

    _require_coordinate_matrix(coordinates)
    if not np.isfinite(coordinates).all():
        raise ValueError("coordinates must be finite")
    if not np.isfinite(minimum_distance) or minimum_distance <= 0:
        raise ValueError("minimum_distance must be positive and finite")

    desired = np.asarray(coordinates, dtype="<f4")
    lattice_step = minimum_distance + _LATTICE_EXTRA_DISTANCE
    jitter_limit = _LATTICE_EXTRA_DISTANCE / (4 * sqrt(3))
    clearance = round(lattice_step - 2 * sqrt(3) * jitter_limit, 9)

    preferred = np.rint(desired / lattice_step).astype(np.int32)
    preferred_keys = _encode_lattice_cells(preferred)
    assigned_cells, assignment_rounds = _assign_unique_cells(
        preferred, preferred_keys
    )
    del preferred, preferred_keys

    final_keys = _encode_lattice_cells(assigned_cells)
    node_index = np.arange(len(desired), dtype=np.uint64)
    mixed = final_keys * np.uint64(_HASH_MULTIPLIER) + node_index * np.uint64(
        2_654_435_761
    )
    output = assigned_cells.astype(np.float32) * np.float32(lattice_step)
    for axis in range(3):
        value = ((mixed >> np.uint64(axis * 16)) & np.uint64(0xFFFF)).astype(
            np.float64
        )
        jitter = (value / 65_535.0 * 2.0 - 1.0) * jitter_limit
        output[:, axis] += jitter.astype(np.float32)

    moved_nodes = 0
    max_displacement = 0.0
    for start in range(0, len(output), 100_000):
        end = min(start + 100_000, len(output))
        delta = output[start:end].astype(np.float64) - desired[
            start:end
        ].astype(np.float64)
        displacement = np.linalg.norm(delta, axis=1)
        moved_nodes += int(np.count_nonzero(displacement))
        max_displacement = max(
            max_displacement, float(displacement.max(initial=0.0))
        )

    return output, SeparationReport(
        total_nodes=len(output),
        moved_nodes=moved_nodes,
        max_displacement=max_displacement,
        minimum_center_distance=minimum_distance,
        placement_clearance=clearance,
        assignment_rounds=assignment_rounds,
    )


def find_minimum_distance_violation(
    coordinates: np.ndarray,
    minimum_distance: float = MIN_NODE_CENTER_DISTANCE,
) -> tuple[int, int, float] | None:
    """Return the first pair below the global center-distance contract."""

    _require_coordinate_matrix(coordinates)
    if not np.isfinite(coordinates).all():
        raise ValueError("coordinates must be finite")
    if not np.isfinite(minimum_distance) or minimum_distance <= 0:
        raise ValueError("minimum_distance must be positive and finite")

    published = np.asarray(coordinates, dtype="<f4")
    tree = cKDTree(published)
    for start in range(0, len(published), 100_000):
        end = min(start + 100_000, len(published))
        distance, neighbor = tree.query(published[start:end], k=2, workers=1)
        nearest = distance[:, 1]
        local = int(np.argmin(nearest))
        if float(nearest[local]) < minimum_distance:
            index = start + local
            other = int(neighbor[local, 1])
            first, second = sorted((index, other))
            return first, second, float(nearest[local])
    return None
