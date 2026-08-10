from __future__ import annotations

import json
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest import mock

import igraph as ig
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from scripts import layout
from scripts.layout import (
    ISLAND_GAP,
    SATELLITE_GAP,
    TYPICAL_NODE_DISTANCE,
    detect_communities,
    hierarchical_connected_layout,
    minimum_island_gap,
    pack_island_centers,
    place_islands,
    run_layout,
    satellite_island_centers,
    shape_digest,
    shape_layout,
    wrap_isolated_shell,
)


class TopologyLayoutTests(unittest.TestCase):
    def test_node_key_rejects_ids_that_would_alias_after_cast(self) -> None:
        with self.assertRaisesRegex(ValueError, "24-bit"):
            layout.node_key("subject", np.array([1 << 24], dtype=np.int64))

    def test_node_keys_map_to_compact_indices(self) -> None:
        keys = np.array([0x01000001, 0x01000004, 0x02000002], dtype=np.uint32)
        endpoint_keys = np.array(
            [
                [0x02000002, 0x01000001],
                [0x01000004, 0x02000002],
            ],
            dtype=np.uint32,
        )

        mapped = layout.map_node_keys(keys, endpoint_keys)

        self.assertEqual(mapped.dtype, np.dtype(np.uint32))
        np.testing.assert_array_equal(mapped, [[2, 0], [1, 2]])
        with self.assertRaisesRegex(ValueError, "edge endpoint"):
            layout.map_node_keys(
                keys, np.array([[0x01000002, 0x01000004]], dtype=np.uint32)
            )

    def test_graph_build_does_not_require_a_python_edge_list(self) -> None:
        class ArrayWithoutToList(np.ndarray):
            def tolist(self) -> list[object]:
                raise AssertionError(
                    "edge array must not become a Python list"
                )

        edges = np.array(
            [[0, 1], [1, 0], [1, 2], [2, 2]], dtype=np.uint32
        ).view(ArrayWithoutToList)

        graph = layout.build_graph(3, edges)

        self.assertEqual(graph.vcount(), 3)
        self.assertEqual(graph.get_edgelist(), [(0, 1), (1, 2)])

    def test_hierarchical_layout_consumes_raw_numpy_edges(self) -> None:
        edges = np.array(
            [
                *[(a, b) for a in range(5) for b in range(a + 1, 5)],
                *[(a, b) for a in range(5, 10) for b in range(a + 1, 10)],
                (4, 5),
                (10, 11),
                (12, 13),
                (13, 14),
                (4, 5),
                (14, 14),
            ],
            dtype=np.uint32,
        )
        keys = np.arange(200, 215, dtype=np.uint32)

        coords, communities, report = hierarchical_connected_layout(
            edges, keys, target_islands=2
        )

        self.assertEqual(coords.shape, (15, 3))
        self.assertTrue(np.isfinite(coords).all())
        self.assertEqual(len(np.unique(communities[:10])), 2)
        self.assertEqual(report["n_components"], 3)
        self.assertEqual(report["n_satellite_islands"], 2)

    def test_layout_is_computed_in_three_dimensions(self) -> None:
        coords = run_layout(ig.Graph.Ring(4))

        self.assertEqual(coords.shape, (4, 3))
        self.assertTrue(np.isfinite(coords).all())

    def test_layout_is_reproducible_across_runs(self) -> None:
        graph = ig.Graph.Famous("Zachary")

        np.testing.assert_array_equal(run_layout(graph), run_layout(graph))
        np.testing.assert_array_equal(
            detect_communities(graph), detect_communities(graph)
        )

    def test_connected_layout_keeps_its_topology_depth(self) -> None:
        desired = np.array(
            [
                [-3.0, -1.0, 0.2],
                [-2.0, 1.5, -0.4],
                [-0.5, -1.8, 1.2],
                [0.8, 2.2, -1.0],
                [2.0, -1.2, 0.7],
                [3.2, 0.6, -0.3],
            ],
            dtype=np.float32,
        )
        keys = np.arange(1, 7, dtype=np.uint32)
        degree = np.array([2, 2, 3, 2, 2, 1], dtype=np.int64)
        years = np.zeros(6, dtype=np.uint16)

        shaped = shape_layout(desired, keys, degree, years)
        spans = np.ptp(shaped, axis=0)
        centred = desired.astype(np.float64) - desired.mean(axis=0)
        rotated = centred @ np.linalg.eigh(centred.T @ centred)[1][:, ::-1]
        source = np.ptp(rotated, axis=0)

        self.assertEqual(shaped.shape, (6, 3))
        self.assertTrue(np.isfinite(shaped).all())
        self.assertGreater(float(spans[1]), 0.0)
        self.assertAlmostEqual(
            float(spans[1]) / float(spans[0]),
            float(source[2]) / float(source[0]),
            delta=0.1,
        )

    def test_near_coincident_clusters_do_not_explode_world_size(self) -> None:
        epsilon = 1e-6
        desired = np.array(
            [
                [-1, 0, 0],
                [-1 + epsilon, 0, 0],
                [-1, epsilon, 0],
                [1, 0, 0],
                [1 - epsilon, 0, 0],
                [1, -epsilon, 0],
            ],
            dtype=np.float32,
        )
        keys = np.arange(1, 7, dtype=np.uint32)
        degree = np.ones(6, dtype=np.int64)
        years = np.zeros(6, dtype=np.uint16)

        shaped = shape_layout(desired, keys, degree, years)
        horizontal_span = float(
            max(np.ptp(shaped[:, 0]), np.ptp(shaped[:, 2]))
        )

        self.assertLessEqual(
            horizontal_span,
            TYPICAL_NODE_DISTANCE * np.sqrt(len(shaped)) * 1.1,
        )

    def test_isolated_nodes_form_a_shell_around_connected_body(self) -> None:
        desired = np.array(
            [
                [-1.0, 0.0, 0.2],
                [0.0, 1.0, -0.2],
                [1.0, 0.0, 0.3],
                [0.0, 0.0, 0.0],
                [0.0, 0.0, 0.0],
                [0.0, 0.0, 0.0],
            ],
            dtype=np.float32,
        )
        keys = np.arange(10, 16, dtype=np.uint32)
        degree = np.array([2, 1, 1, 0, 0, 0], dtype=np.int64)
        years = np.array([0, 0, 0, 1999, 2000, 2001], dtype=np.uint16)

        shaped = shape_layout(desired, keys, degree, years)
        radius = np.linalg.norm(shaped, axis=1)

        self.assertGreater(radius[degree == 0].min(), radius[degree > 0].max())
        shell = radius[degree == 0]
        self.assertAlmostEqual(float(shell.max() - shell.min()), 0.0, places=4)
        self.assertGreater(float(np.ptp(shaped[degree == 0][:, 1])), 0.0)

    def test_wraps_prebuilt_connected_islands_without_moving_them(
        self,
    ) -> None:
        connected = np.array(
            [[-3.0, 0.5, 0.0], [2.0, -0.5, 1.0]], dtype=np.float32
        )
        keys = np.arange(20, 24, dtype=np.uint32)
        degree = np.array([1, 0, 1, 0], dtype=np.int64)
        years = np.array([0, 2001, 0, 1999], dtype=np.uint16)

        wrapped = wrap_isolated_shell(connected, keys, degree, years)

        np.testing.assert_array_equal(wrapped[degree > 0], connected)
        connected_radius = np.linalg.norm(wrapped[degree > 0], axis=1)
        shell_radius = np.linalg.norm(wrapped[degree == 0], axis=1)
        self.assertGreater(shell_radius.min(), connected_radius.max())
        self.assertAlmostEqual(
            float(shell_radius.max() - shell_radius.min()), 0.0, places=4
        )


class CommunityIslandTests(unittest.TestCase):
    def test_tightens_island_centers_while_spreading_local_nodes(
        self,
    ) -> None:
        island_count = 8
        core = layout._fibonacci_unit_sphere(20)
        template = np.vstack([core, [8.0, 0.0, 0.0]])
        template -= template.mean(axis=0)
        local = np.tile(template, (island_count, 1))
        islands = np.repeat(np.arange(island_count), len(template))
        full_radii = np.array(
            [
                np.linalg.norm(local[islands == group], axis=1).max()
                for group in range(island_count)
            ]
        )
        base_centers = pack_island_centers(
            layout._fibonacci_unit_sphere(island_count),
            full_radii,
            ISLAND_GAP,
        )

        coords, centers, actual_radii, core_radii = layout.tighten_islands(
            local,
            islands,
            base_centers,
        )

        base_center_distance = np.linalg.norm(
            base_centers[:, None] - base_centers[None, :], axis=2
        )
        center_distance = np.linalg.norm(
            centers[:, None] - centers[None, :], axis=2
        )
        pairs = np.triu_indices(island_count, 1)
        self.assertLess(
            float(np.median(center_distance[pairs])),
            float(np.median(base_center_distance[pairs])) * 0.6,
        )
        self.assertGreaterEqual(
            minimum_island_gap(centers, core_radii),
            TYPICAL_NODE_DISTANCE - 1e-9,
        )
        self.assertGreater(
            float(np.median(actual_radii / full_radii)),
            1.45,
        )
        for group in range(island_count):
            np.testing.assert_allclose(
                coords[islands == group].mean(axis=0),
                centers[group],
                atol=1e-6,
            )

    def test_packs_island_bounding_spheres_with_a_deterministic_gap(
        self,
    ) -> None:
        desired = np.array(
            [
                [-0.02, 0.00, -0.01],
                [0.01, 0.02, 0.00],
                [0.00, -0.01, 0.02],
                [0.02, 0.01, -0.02],
            ],
            dtype=np.float64,
        )
        radii = np.array([2.0, 1.5, 1.0, 0.75], dtype=np.float64)

        first = pack_island_centers(desired, radii, ISLAND_GAP)
        second = pack_island_centers(desired, radii, ISLAND_GAP)

        np.testing.assert_array_equal(first, second)
        self.assertGreaterEqual(
            minimum_island_gap(first, radii), ISLAND_GAP - 1e-9
        )
        self.assertTrue((np.ptp(first, axis=0) > 0).all())

    def test_places_local_topology_in_separate_community_islands(self) -> None:
        desired = np.array(
            [
                [-1.0, 0.0, 0.2],
                [-0.2, 0.8, -0.1],
                [0.7, -0.4, 0.5],
                [1.0, 0.3, -0.4],
                [-0.8, 0.1, -0.2],
                [-0.1, -0.7, 0.4],
                [0.6, 0.5, -0.5],
                [1.1, -0.2, 0.1],
            ],
            dtype=np.float32,
        )
        keys = np.arange(100, 108, dtype=np.uint32)
        islands = np.array([0, 0, 0, 0, 1, 1, 1, 1], dtype=np.int64)
        desired_centers = np.array(
            [[-0.01, 0.0, 0.0], [0.01, 0.0, 0.0]], dtype=np.float64
        )

        coords, centers, radii = place_islands(
            desired, keys, islands, desired_centers, ISLAND_GAP
        )

        self.assertEqual(coords.shape, desired.shape)
        self.assertGreaterEqual(
            minimum_island_gap(centers, radii), ISLAND_GAP - 1e-9
        )
        for island in range(2):
            np.testing.assert_allclose(
                coords[islands == island].mean(axis=0),
                centers[island],
                atol=1e-6,
            )

    def test_places_satellite_islands_outside_the_body_without_overlap(
        self,
    ) -> None:
        radii = np.array([2.0, 1.5, 1.0, 0.8, 0.6], dtype=np.float64)
        body_radius = 5.0

        centers = satellite_island_centers(radii, body_radius)

        center_radius = np.linalg.norm(centers, axis=1)
        self.assertAlmostEqual(float(np.ptp(center_radius)), 0.0, places=8)
        self.assertGreaterEqual(
            float(center_radius.min() - radii.max()),
            body_radius + SATELLITE_GAP - 1e-9,
        )
        self.assertGreaterEqual(
            minimum_island_gap(centers, radii), ISLAND_GAP - 1e-9
        )
        self.assertTrue((np.ptp(centers, axis=0) > 0).all())

    def test_builds_macro_communities_and_component_satellites(self) -> None:
        edges = np.array(
            [
                *[(a, b) for a in range(5) for b in range(a + 1, 5)],
                *[(a, b) for a in range(5, 10) for b in range(a + 1, 10)],
                (4, 5),
                (10, 11),
                (12, 13),
                (13, 14),
            ],
            dtype=np.uint32,
        )
        keys = np.arange(200, 215, dtype=np.uint32)

        first = hierarchical_connected_layout(edges, keys, target_islands=2)
        second = hierarchical_connected_layout(edges, keys, target_islands=2)
        coords, communities, report = first

        np.testing.assert_array_equal(first[0], second[0])
        np.testing.assert_array_equal(first[1], second[1])
        self.assertEqual(coords.shape, (15, 3))
        self.assertTrue(np.isfinite(coords).all())
        self.assertEqual(len(np.unique(communities[:10])), 2)
        self.assertEqual(communities[10], communities[11])
        self.assertEqual(communities[12], communities[13])
        self.assertEqual(communities[13], communities[14])
        self.assertNotEqual(communities[10], communities[12])
        self.assertEqual(report["n_components"], 3)
        self.assertEqual(report["n_giant_nodes"], 10)
        self.assertEqual(report["n_community_islands"], 2)
        self.assertEqual(report["n_satellite_islands"], 2)
        self.assertGreaterEqual(
            report["min_community_core_gap"],
            layout.COMMUNITY_CORE_GAP - 1e-9,
        )
        self.assertLess(
            report["min_community_island_gap"],
            report["min_community_core_gap"],
        )
        self.assertEqual(
            report["community_node_spread"], layout.COMMUNITY_NODE_SPREAD
        )
        self.assertGreaterEqual(
            report["min_satellite_island_gap"], ISLAND_GAP - 1e-9
        )


class ShapeIdentityTests(unittest.TestCase):
    def test_digest_follows_the_shaping_constants(self) -> None:
        before = shape_digest()
        with mock.patch.object(
            layout, "_SHAPE_CONSTANTS", {"typical_node_distance": 0.29}
        ):
            self.assertNotEqual(shape_digest(), before)
        self.assertEqual(shape_digest(), before)

    def test_digest_follows_the_shaping_logic(self) -> None:
        def _isolated_halo(count: int, inner_radius: float) -> None:
            """Spread structureless nodes over a shell around the body."""
            raise NotImplementedError

        with mock.patch.object(
            layout, "_SHAPE_LOGIC", (layout._isolated_halo,)
        ):
            real = shape_digest()
        with mock.patch.object(layout, "_SHAPE_LOGIC", (_isolated_halo,)):
            fake = shape_digest()

        self.assertNotEqual(real, fake)

    def test_digest_ignores_docstrings(self) -> None:
        def documented() -> Callable[[int], int]:
            def shaped(x: int) -> int:
                """原始说明。"""
                return x + 1

            return shaped

        def reworded() -> Callable[[int], int]:
            def shaped(x: int) -> int:
                """改写后的说明,逻辑一字未动。"""
                return x + 1

            return shaped

        self.assertEqual(
            layout._canonical_logic(documented()),
            layout._canonical_logic(reworded()),
        )


class LayoutCacheTests(unittest.TestCase):
    def test_cache_identity_follows_every_implementation_dependency(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layout_source = root / "layout.py"
            entity_key_source = root / "entity_key.py"
            layout_source.write_text("layout-v1\n")
            entity_key_source.write_text("entity-key-v1\n")
            dependencies = {
                "layout.py": layout_source,
                "entity_key.py": entity_key_source,
            }

            with mock.patch.object(
                layout,
                "LAYOUT_CACHE_DEPENDENCIES",
                dependencies,
                create=True,
            ):
                before = layout.layout_cache_identity()
                layout_source.write_text("layout-v2\n")
                after_layout_change = layout.layout_cache_identity()
                layout_source.write_text("layout-v1\n")
                entity_key_source.write_text("entity-key-v2\n")
                after_entity_key_change = layout.layout_cache_identity()

            self.assertNotEqual(before, after_layout_change)
            self.assertNotEqual(before, after_entity_key_change)

    def write_inputs(self, parquet: Path) -> None:
        parquet.mkdir()
        for index, name in enumerate(layout.LAYOUT_INPUT_FILES):
            (parquet / name).write_bytes(f"input-{index}".encode())

    def write_outputs(self, output: Path, shape: str) -> None:
        output.mkdir()
        pq.write_table(
            pa.table(
                {
                    "key": pa.array([0x01000001], pa.uint32()),
                    "x": pa.array([1.0], pa.float32()),
                    "y": pa.array([2.0], pa.float32()),
                    "z": pa.array([3.0], pa.float32()),
                    "community": pa.array([0], pa.uint16()),
                    "isolated": pa.array([False]),
                    "collect": pa.array([4], pa.int64()),
                    "year": pa.array([2000], pa.uint16()),
                    "degree": pa.array([1], pa.int64()),
                },
                schema=layout.LAYOUT_SCHEMA,
            ),
            output / "coords.parquet",
        )
        (output / "report.json").write_text(
            json.dumps(
                {
                    "dimensions": 3,
                    "shape_digest": shape,
                    "n_nodes": 1,
                    "n_connected": 1,
                }
            )
        )

    def generation_for(self, parquet: Path) -> dict[str, object]:
        return {
            "parquet": {
                name: {"sha256": layout._file_sha256(parquet / name)}
                for name in layout.LAYOUT_INPUT_FILES
            }
        }

    def test_generation_digest_matches_the_same_verified_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet = Path(directory) / "parquet"
            self.write_inputs(parquet)

            self.assertEqual(
                layout.layout_input_digest_from_generation(
                    self.generation_for(parquet)
                ),
                layout.layout_input_digest(parquet),
            )

    def write_valid_cache(self, root: Path) -> tuple[Path, Path]:
        parquet = root / "parquet"
        output = root / "layout"
        self.write_inputs(parquet)
        shape = shape_digest()
        self.write_outputs(output, shape)
        layout.write_layout_cache(
            output, layout.layout_input_digest(parquet), shape
        )
        return parquet, output

    def test_cache_hit_requires_exact_inputs_and_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parquet = root / "parquet"
            output = root / "layout"
            self.write_inputs(parquet)
            shape = "shape-v1"
            self.write_outputs(output, shape)
            input_digest = layout.layout_input_digest(parquet)
            layout.write_layout_cache(output, input_digest, shape)

            self.assertTrue(
                layout.layout_cache_matches(output, input_digest, shape)
            )

            first_input = parquet / layout.LAYOUT_INPUT_FILES[0]
            first_input.write_bytes(b"changed")
            self.assertFalse(
                layout.layout_cache_matches(
                    output, layout.layout_input_digest(parquet), shape
                )
            )
            first_input.write_bytes(b"input-0")

            coords = output / "coords.parquet"
            coords.write_bytes(coords.read_bytes() + b"corrupt")
            self.assertFalse(
                layout.layout_cache_matches(output, input_digest, shape)
            )

    def test_cache_rejects_report_or_shape_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parquet = root / "parquet"
            output = root / "layout"
            self.write_inputs(parquet)
            self.write_outputs(output, "shape-v1")
            input_digest = layout.layout_input_digest(parquet)
            layout.write_layout_cache(output, input_digest, "shape-v1")

            self.assertFalse(
                layout.layout_cache_matches(output, input_digest, "shape-v2")
            )
            with mock.patch.object(
                layout, "layout_cache_identity", return_value="changed"
            ):
                self.assertFalse(
                    layout.layout_cache_matches(
                        output, input_digest, "shape-v1"
                    )
                )
            report = output / "report.json"
            report.write_text(report.read_text() + "\n")
            self.assertFalse(
                layout.layout_cache_matches(output, input_digest, "shape-v1")
            )
            report.write_text("[]")
            self.assertFalse(
                layout.layout_cache_matches(output, input_digest, "shape-v1")
            )

    def test_main_cache_hit_does_not_load_or_rewrite_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet, output = self.write_valid_cache(Path(directory))
            artifacts = [output / "coords.parquet", output / "report.json"]
            before = {
                path.name: (path.read_bytes(), path.stat().st_mtime_ns)
                for path in artifacts
            }

            with (
                mock.patch.object(layout, "PARQUET", parquet),
                mock.patch.object(layout, "OUT", output),
                mock.patch.object(
                    layout.parquet_provenance,
                    "require_valid_generation",
                    return_value=self.generation_for(parquet),
                ),
                mock.patch.object(
                    layout,
                    "load_nodes",
                    side_effect=AssertionError("cache hit loaded nodes"),
                ),
                mock.patch.object(
                    layout,
                    "load_edges",
                    side_effect=AssertionError("cache hit loaded edges"),
                ),
                mock.patch.object(
                    layout,
                    "hierarchical_connected_layout",
                    side_effect=AssertionError("cache hit ran layout"),
                ),
                mock.patch("sys.argv", ["layout.py"]),
            ):
                layout.main()

            after = {
                path.name: (path.read_bytes(), path.stat().st_mtime_ns)
                for path in artifacts
            }
            self.assertEqual(after, before)

    def test_force_skips_cache_check_and_removes_stamp(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet, output = self.write_valid_cache(Path(directory))

            with (
                mock.patch.object(layout, "PARQUET", parquet),
                mock.patch.object(layout, "OUT", output),
                mock.patch.object(
                    layout.parquet_provenance,
                    "require_valid_generation",
                    return_value=self.generation_for(parquet),
                ),
                mock.patch.object(
                    layout,
                    "layout_cache_matches",
                    side_effect=AssertionError("force checked cache"),
                ),
                mock.patch.object(
                    layout,
                    "load_nodes",
                    side_effect=RuntimeError("recompute started"),
                ),
                mock.patch("sys.argv", ["layout.py", "--force"]),
                self.assertRaisesRegex(RuntimeError, "recompute started"),
            ):
                layout.main()

            self.assertFalse((output / layout.LAYOUT_CACHE_FILE).exists())

    def test_cache_miss_removes_stale_stamp_before_recompute(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet, output = self.write_valid_cache(Path(directory))
            (parquet / layout.LAYOUT_INPUT_FILES[0]).write_bytes(b"changed")

            with (
                mock.patch.object(layout, "PARQUET", parquet),
                mock.patch.object(layout, "OUT", output),
                mock.patch.object(
                    layout.parquet_provenance,
                    "require_valid_generation",
                    return_value=self.generation_for(parquet),
                ),
                mock.patch.object(
                    layout,
                    "load_nodes",
                    side_effect=RuntimeError("recompute started"),
                ),
                mock.patch("sys.argv", ["layout.py"]),
                self.assertRaisesRegex(RuntimeError, "recompute started"),
            ):
                layout.main()

            self.assertFalse((output / layout.LAYOUT_CACHE_FILE).exists())

    def test_incomplete_parquet_build_is_not_consumed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parquet = root / "parquet"
            output = root / "layout"
            self.write_inputs(parquet)
            (parquet / ".build-in-progress").write_text("interrupted")

            with (
                mock.patch.object(layout, "PARQUET", parquet),
                mock.patch.object(layout, "OUT", output),
                mock.patch("sys.argv", ["layout.py"]),
                self.assertRaisesRegex(RuntimeError, "incomplete"),
            ):
                layout.main()

    def test_layout_requires_a_content_valid_parquet_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parquet = root / "parquet"
            output = root / "layout"
            parquet.mkdir()

            with (
                mock.patch.object(layout, "PARQUET", parquet),
                mock.patch.object(layout, "OUT", output),
                mock.patch.object(
                    layout.parquet_provenance,
                    "require_valid_generation",
                    side_effect=ValueError("generation rejected"),
                ) as validate,
                mock.patch("sys.argv", ["layout.py"]),
                self.assertRaisesRegex(ValueError, "generation rejected"),
            ):
                layout.main()

            validate.assert_called_once()

    def test_input_or_implementation_drift_is_not_published(self) -> None:
        for drift in ("inputs", "implementation"):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                parquet = root / "parquet"
                output = root / "layout"
                self.write_inputs(parquet)
                self.write_outputs(output, shape_digest())
                before = {
                    name: (output / name).read_bytes()
                    for name in ("coords.parquet", "report.json")
                }
                keys = np.array([0x01000001], dtype=np.uint32)
                empty_edges = np.empty((0, 2), dtype=np.int32)
                hierarchy = {
                    "n_community_islands": 0,
                    "n_satellite_islands": 0,
                }
                recorded_input_digest = mock.patch.object(
                    layout,
                    "layout_input_digest_from_generation",
                    return_value="before" if drift == "inputs" else "stable",
                )
                current_input_digest = mock.patch.object(
                    layout,
                    "layout_input_digest",
                    return_value="after" if drift == "inputs" else "stable",
                )
                cache_identity = (
                    mock.patch.object(
                        layout,
                        "layout_cache_identity",
                        side_effect=["before", "after"],
                    )
                    if drift == "implementation"
                    else mock.patch.object(
                        layout, "layout_cache_identity", return_value="stable"
                    )
                )

                with (
                    mock.patch.object(layout, "PARQUET", parquet),
                    mock.patch.object(layout, "OUT", output),
                    mock.patch.object(
                        layout.parquet_provenance,
                        "require_valid_generation",
                        return_value=self.generation_for(parquet),
                    ),
                    recorded_input_digest,
                    current_input_digest,
                    cache_identity,
                    mock.patch.object(
                        layout,
                        "load_nodes",
                        return_value=(
                            keys,
                            np.array([2000], dtype=np.uint16),
                            np.array([1], dtype=np.int64),
                        ),
                    ),
                    mock.patch.object(
                        layout, "load_edges", return_value=empty_edges
                    ),
                    mock.patch.object(
                        layout,
                        "hierarchical_connected_layout",
                        return_value=(
                            np.empty((0, 3), dtype=np.float64),
                            np.empty(0, dtype=np.uint16),
                            hierarchy,
                        ),
                    ),
                    mock.patch.object(
                        layout,
                        "wrap_isolated_shell",
                        return_value=np.array([[1.0, 2.0, 3.0]]),
                    ),
                    mock.patch("sys.argv", ["layout.py", "--force"]),
                    self.assertRaisesRegex(RuntimeError, f"{drift} changed"),
                ):
                    layout.main()

                self.assertEqual(
                    {
                        name: (output / name).read_bytes()
                        for name in ("coords.parquet", "report.json")
                    },
                    before,
                )
                self.assertFalse((output / layout.LAYOUT_CACHE_FILE).exists())


if __name__ == "__main__":
    unittest.main()
