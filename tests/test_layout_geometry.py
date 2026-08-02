from __future__ import annotations

import unittest

import igraph as ig
import numpy as np
from scipy.spatial.distance import pdist

from scripts.layout import MIN_NODE_DISTANCE, pack_planar_layout, run_layout


class PlanarLayoutTests(unittest.TestCase):
    def test_layout_is_computed_from_the_current_graph(self) -> None:
        coords = run_layout(ig.Graph.Ring(4), "umap")

        self.assertEqual(coords.shape, (4, 2))
        self.assertTrue(np.isfinite(coords).all())

    def test_degree_changes_do_not_reassign_existing_cells(self) -> None:
        desired = np.zeros((4, 2), dtype=np.float32)
        keys = np.arange(1, 5, dtype=np.uint32)
        years = np.zeros(4, dtype=np.uint16)

        before = pack_planar_layout(
            desired,
            keys,
            np.array([4, 3, 2, 1]),
            years,
        )
        after = pack_planar_layout(
            desired,
            keys,
            np.array([1, 2, 3, 4]),
            years,
        )

        np.testing.assert_array_equal(after, before)

    def test_packing_is_planar_and_nodes_do_not_overlap(self) -> None:
        desired = np.array(
            [
                [0.0, 0.0],
                [0.0, 0.0],
                [0.01, 0.0],
                [0.01, 0.01],
                [0.0, 0.0],
                [0.0, 0.0],
            ],
            dtype=np.float32,
        )
        keys = np.arange(1, 7, dtype=np.uint32)
        degree = np.array([4, 3, 2, 1, 0, 0], dtype=np.int64)
        years = np.array([0, 0, 0, 0, 2001, 2002], dtype=np.uint16)

        packed = pack_planar_layout(desired, keys, degree, years)

        self.assertEqual(packed.shape, (6, 3))
        np.testing.assert_array_equal(packed[:, 1], 0)
        self.assertGreaterEqual(
            float(pdist(packed[:, (0, 2)]).min()),
            MIN_NODE_DISTANCE,
        )

    def test_isolated_nodes_stay_outside_the_connected_body(self) -> None:
        desired = np.zeros((5, 2), dtype=np.float32)
        keys = np.arange(10, 15, dtype=np.uint32)
        degree = np.array([2, 1, 1, 0, 0], dtype=np.int64)
        years = np.array([0, 0, 0, 1999, 2000], dtype=np.uint16)

        packed = pack_planar_layout(desired, keys, degree, years)
        radius = np.linalg.norm(packed[:, (0, 2)], axis=1)

        self.assertGreater(radius[degree == 0].min(), radius[degree > 0].max())


if __name__ == "__main__":
    unittest.main()
