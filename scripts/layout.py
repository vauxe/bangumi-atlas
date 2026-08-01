"""Bake a stable, planar and collision-free graph layout."""

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

# The lattice and bounded jitter make this a strict geometric invariant.
MIN_NODE_DISTANCE = 0.25
_LATTICE_SPACING = MIN_NODE_DISTANCE * 1.12
_JITTER_RADIUS = MIN_NODE_DISTANCE * 0.05

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
    """Create a 2D layout, or preserve the published weekly baseline."""
    if seed is not None:
        return seed.copy()
    if algo == "drl":
        layout = g.layout_drl(dim=2)
    elif algo == "umap":
        layout = g.layout_umap(dim=2, epochs=200)
    else:
        raise ValueError(algo)
    return np.asarray(layout.coords, dtype=np.float32)


def _hex_ring(radius: int) -> list[tuple[int, int]]:
    if radius == 0:
        return [(0, 0)]
    q, r = -radius, radius
    cells: list[tuple[int, int]] = []
    for dq, dr in (
        (1, 0),
        (1, -1),
        (0, -1),
        (-1, 0),
        (-1, 1),
        (0, 1),
    ):
        for _ in range(radius):
            cells.append((q, r))
            q += dq
            r += dr
    return cells


def _nearest_hex(points: np.ndarray) -> np.ndarray:
    """Round Cartesian points to axial hex-grid coordinates."""
    root3 = np.sqrt(3.0)
    rf = points[:, 1] / (_LATTICE_SPACING * root3 / 2)
    qf = points[:, 0] / _LATTICE_SPACING - rf / 2
    xf, zf, yf = qf, rf, -qf - rf
    rx, ry, rz = np.rint(xf), np.rint(yf), np.rint(zf)
    dx, dy, dz = np.abs(rx - xf), np.abs(ry - yf), np.abs(rz - zf)
    x_largest = (dx > dy) & (dx > dz)
    y_largest = (~x_largest) & (dy > dz)
    rx[x_largest] = -ry[x_largest] - rz[x_largest]
    ry[y_largest] = -rx[y_largest] - rz[y_largest]
    z_largest = ~x_largest & ~y_largest
    rz[z_largest] = -rx[z_largest] - ry[z_largest]
    return np.column_stack((rx, rz)).astype(np.int64)


def _cell_key(q: int, r: int) -> int:
    return (q << 32) ^ (r & 0xFFFF_FFFF)


def _assign_hex_cells(
    desired: np.ndarray,
    keys: np.ndarray,
    *,
    normalize: bool,
    fixed: np.ndarray | None,
) -> np.ndarray:
    positions = desired.astype(np.float64)
    if normalize:
        positions -= positions.mean(0)
    if normalize and len(positions) > 1:
        nearest = cKDTree(positions).query(
            positions,
            k=2,
            workers=-1,
        )[0][:, 1]
        positive = nearest[nearest > np.finfo(np.float64).eps]
        if len(positive):
            positions *= _LATTICE_SPACING / float(np.median(positive))
    base = _nearest_hex(positions)

    fixed = np.zeros(len(keys), dtype=bool) if fixed is None else fixed
    order = np.lexsort((keys, ~fixed))
    occupied: set[int] = set()
    assigned = np.empty_like(base)
    rings: list[list[tuple[int, int]]] = [[]]
    for index in order:
        i = int(index)
        q, r = int(base[i, 0]), int(base[i, 1])
        code = _cell_key(q, r)
        if code not in occupied:
            occupied.add(code)
            assigned[i] = (q, r)
            continue

        ring = 1
        while True:
            if ring == len(rings):
                rings.append(_hex_ring(ring))
            offsets = rings[ring]
            start = int(keys[i]) % len(offsets)
            for offset in range(len(offsets)):
                dq, dr = offsets[(start + offset) % len(offsets)]
                qq, rr = q + dq, r + dr
                code = _cell_key(qq, rr)
                if code in occupied:
                    continue
                occupied.add(code)
                assigned[i] = (qq, rr)
                break
            else:
                ring += 1
                continue
            break
    return assigned


def _outer_ring_cells(
    count: int,
    first_ring: int,
    origin: np.ndarray,
) -> np.ndarray:
    cells: list[tuple[int, int]] = []
    ring = max(first_ring, 1)
    while len(cells) < count:
        cells.extend(_hex_ring(ring))
        ring += 1
    return np.asarray(cells[:count], dtype=np.int64) + origin


def _cartesian(cells: np.ndarray) -> np.ndarray:
    q, r = cells[:, 0], cells[:, 1]
    return _LATTICE_SPACING * np.column_stack(
        (q + r / 2, (np.sqrt(3.0) / 2) * r)
    )


def _jitter(keys: np.ndarray) -> np.ndarray:
    h = keys.astype(np.uint64) + np.uint64(0x9E3779B97F4A7C15)
    with np.errstate(over="ignore"):
        h = (h ^ (h >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        h = (h ^ (h >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
    h ^= h >> np.uint64(31)
    unit = (h & np.uint64(0xFFFF_FFFF)).astype(np.float64) / 2**32
    radial = (h >> np.uint64(32)).astype(np.float64) / 2**32
    angle = 2 * np.pi * unit
    radius = _JITTER_RADIUS * np.sqrt(radial)
    return np.column_stack((np.cos(angle) * radius, np.sin(angle) * radius))


def pack_planar_layout(
    desired: np.ndarray,
    keys: np.ndarray,
    degree: np.ndarray,
    years: np.ndarray,
    *,
    warm_mask: np.ndarray | None = None,
) -> np.ndarray:
    """Map desired 2D positions to unique nearby cells with a hard gap."""
    n = len(keys)
    if desired.shape != (n, 2):
        raise ValueError(f"expected {(n, 2)} desired coordinates")
    if warm_mask is not None and warm_mask.shape != (n,):
        raise ValueError(f"expected {(n,)} warm mask")
    connected = degree > 0
    cells = np.empty((n, 2), dtype=np.int64)
    if connected.any():
        cells[connected] = _assign_hex_cells(
            desired[connected],
            keys[connected],
            normalize=warm_mask is None,
            fixed=warm_mask[connected] if warm_mask is not None else None,
        )
        if warm_mask is None:
            origin = np.rint(cells[connected].mean(0)).astype(np.int64)
            cells[connected] -= origin
        ring_origin = np.rint(cells[connected].mean(0)).astype(np.int64)
        relative = cells[connected] - ring_origin
        body_radius = np.sqrt(
            relative[:, 0] ** 2
            + relative[:, 0] * relative[:, 1]
            + relative[:, 1] ** 2
        ).max()
        first_outer = int(np.ceil((body_radius + 3) * 2 / np.sqrt(3.0)))
    else:
        ring_origin = np.zeros(2, dtype=np.int64)
        first_outer = 1

    isolated = ~connected
    if isolated.any():
        isolated_index = np.flatnonzero(isolated)
        thematic_order = np.lexsort(
            (years[isolated], keys[isolated] >> 24)
        )
        cells[isolated_index[thematic_order]] = _outer_ring_cells(
            int(isolated.sum()),
            first_outer,
            ring_origin,
        )

    xy = _cartesian(cells) + _jitter(keys)
    coords = np.zeros((n, 3), dtype=np.float32)
    coords[:, 0] = xy[:, 0]
    coords[:, 2] = xy[:, 1]

    if n > 1:
        plane = coords[:, (0, 2)]
        nearest = cKDTree(plane).query(
            plane,
            k=2,
            workers=-1,
        )[0][:, 1]
        if float(nearest.min()) < MIN_NODE_DISTANCE:
            raise RuntimeError(
                f"layout overlap: minimum distance {nearest.min():.6f} "
                f"< {MIN_NODE_DISTANCE}"
            )
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


def _is_ground_plane(points: np.ndarray) -> bool:
    return float(np.ptp(points[:, 1])) < 1e-4


def _build_warm_seed(
    prev_map: dict[int, tuple[float, float, float]],
    keys: np.ndarray,
    edges: np.ndarray,
) -> tuple[np.ndarray | None, np.ndarray, int, int, int]:
    prev_keys = np.fromiter(prev_map, dtype=np.uint32)
    prev_xyz = np.asarray(list(prev_map.values()), dtype=np.float32)
    prev_xy = prev_xyz[:, (0, 2)]
    old = dict(zip(prev_keys.tolist(), prev_xy.tolist(), strict=True))
    known = np.array([int(key) in old for key in keys])
    if not known.any():
        return None, known, len(keys), 0, len(keys)

    seed = np.zeros((len(keys), 2), dtype=np.float32)
    seed[known] = np.asarray(
        [old[int(key)] for key in keys[known]], dtype=np.float32
    )
    new_count = int((~known).sum())
    if not new_count:
        return seed, known, 0, 0, 0

    sums = np.zeros((len(keys), 2), dtype=np.float64)
    counts = np.zeros(len(keys), dtype=np.int64)
    source, target = edges[:, 0], edges[:, 1]
    mask = known[target]
    np.add.at(sums, source[mask], seed[target[mask]])
    np.add.at(counts, source[mask], 1)
    mask = known[source]
    np.add.at(sums, target[mask], seed[source[mask]])
    np.add.at(counts, target[mask], 1)

    anchored = (~known) & (counts > 0)
    lo, hi = seed[known].min(0), seed[known].max(0)
    seed[anchored] = (
        sums[anchored] / counts[anchored, None]
        + rng.normal(0, _JITTER_RADIUS, (int(anchored.sum()), 2))
    ).astype(np.float32)
    stray = (~known) & (counts == 0)
    seed[stray] = rng.uniform(lo, hi, (int(stray.sum()), 2)).astype(
        np.float32
    )
    return seed, known, new_count, int(anchored.sum()), int(stray.sum())


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
    # UMAP 是布局对决胜者；DRL 仅保留用于复现实验。
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
    print(f"孤立节点 {isolated.sum():,}(平面外环)", flush=True)

    connected = np.where(~isolated)[0]
    remap = -np.ones(len(keys), dtype=np.int64)
    remap[connected] = np.arange(len(connected))
    sub_edges = remap[edges]

    desired = np.zeros((len(keys), 2), dtype=np.float32)
    comm = np.full(len(keys), 0xFFFF, dtype=np.uint16)
    prev_map: dict[int, tuple[float, float, float]] | None = None
    shift_baseline = False
    warm_started = False
    warm_mask: np.ndarray | None = None

    if args.stub:
        desired[connected] = rng.normal(0, 1, (len(connected), 2)).astype(
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
            # Isolated -> connected is a topology event, not layout drift.
            prev_map = {
                int(k): (float(x), float(y), float(z))
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
            prev_xyz = np.asarray(list(prev_map.values()), dtype=np.float32)
            shift_baseline = _is_ground_plane(prev_xyz)
            if shift_baseline:
                (
                    seed,
                    known,
                    n_new,
                    n_anchored,
                    n_stray,
                ) = _build_warm_seed(prev_map, keys[connected], sub_edges)
                if seed is not None:
                    warm_mask = np.zeros(len(keys), dtype=bool)
                    warm_mask[connected] = known
            else:
                n_new = n_anchored = n_stray = 0
            if n_new:
                print(
                    f"热启动:新节点 {n_new:,}"
                    f"(邻居质心 {n_anchored:,} / 随机 {n_stray:,})",
                    flush=True,
                )
            if seed is None:
                print("旧坐标不是二维布局:本次冷启动迁移", flush=True)
            else:
                print("热启动:载入上周二维坐标", flush=True)
            warm_started = seed is not None
        t0 = time.time()
        desired[connected] = run_layout(g, args.algo, seed)
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

    t0 = time.time()
    coords = pack_planar_layout(
        desired,
        keys,
        deg,
        years,
        warm_mask=warm_mask,
    )
    plane = coords[:, (0, 2)]
    min_distance = float(
        cKDTree(plane).query(plane, k=2, workers=-1)[0][:, 1].min()
    )
    compactness = edge_compactness(coords[connected], sub_edges)
    print(
        f"平面无重叠打包 {time.time() - t0:,.0f}s:"
        f"最小间距 {min_distance:.3f},"
        f"边紧凑度 {compactness:.3f}",
        flush=True,
    )

    OUT.mkdir(parents=True, exist_ok=True)

    # Published nodes are fixed; this report catches packing regressions.
    report: dict[str, object] = {
        "algo": args.algo,
        "dimensions": 2,
        "plane": "xz",
        "warm_start": warm_started,
        "shift_baseline": shift_baseline,
        "n_nodes": int(len(keys)),
        "n_connected": int(len(connected)),
        "min_node_distance": round(min_distance, 6),
        "overlap_pairs": 0,
        "plane_thickness": 0.0,
        "edge_compactness": (
            round(compactness, 6) if compactness is not None else None
        ),
        "p95_shift_pct": None,
        "median_shift_pct": None,
        "n_common": 0,
    }
    if prev_map is not None and shift_baseline:
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
    elif prev_map is not None:
        print(
            "跨周位移:旧坐标不是二维布局,本次视为显式迁移冷启动",
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
