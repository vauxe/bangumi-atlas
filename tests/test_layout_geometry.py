from __future__ import annotations

import unittest

import igraph as ig
import numpy as np

from scripts.layout import (
    DEPTH_RATIO,
    TYPICAL_NODE_DISTANCE,
    run_layout,
    shape_layout,
)


class TopologyLayoutTests(unittest.TestCase):
    def test_layout_is_computed_in_three_dimensions(self) -> None:
        coords = run_layout(ig.Graph.Ring(4), "umap")

        self.assertEqual(coords.shape, (4, 3))
        self.assertTrue(np.isfinite(coords).all())

    def test_connected_layout_has_bounded_nonzero_depth(self) -> None:
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

        self.assertEqual(shaped.shape, (6, 3))
        self.assertTrue(np.isfinite(shaped).all())
        self.assertGreater(float(spans[1]), 0.0)
        self.assertLessEqual(
            float(spans[1]),
            float(max(spans[0], spans[2])) * (DEPTH_RATIO + 0.02),
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

    def test_isolated_nodes_form_a_halo_outside_connected_body(self) -> None:
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
        radius = np.linalg.norm(shaped[:, (0, 2)], axis=1)

        self.assertGreater(radius[degree == 0].min(), radius[degree > 0].max())


if __name__ == "__main__":
    unittest.main()
