from __future__ import annotations

import unittest
from collections.abc import Callable
from unittest import mock

import igraph as ig
import numpy as np

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
        graph = ig.Graph(n=15, directed=False)
        graph.add_edges(
            [
                *[(a, b) for a in range(5) for b in range(a + 1, 5)],
                *[(a, b) for a in range(5, 10) for b in range(a + 1, 10)],
                (4, 5),
                (10, 11),
                (12, 13),
                (13, 14),
            ]
        )
        keys = np.arange(200, 215, dtype=np.uint32)

        first = hierarchical_connected_layout(graph, keys, target_islands=2)
        second = hierarchical_connected_layout(graph, keys, target_islands=2)
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
            report["min_community_island_gap"], ISLAND_GAP - 1e-9
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


if __name__ == "__main__":
    unittest.main()
