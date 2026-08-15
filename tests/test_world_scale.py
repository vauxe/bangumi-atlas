from __future__ import annotations

import unittest

import numpy as np

from scripts.world_scale import (
    CANONICAL_WORLD_SPAN,
    MIN_NODE_CENTER_DISTANCE,
    normalize_world_scale,
    separate_published_nodes,
)


class WorldScaleTests(unittest.TestCase):
    def test_default_world_scale_uses_virtual_large_nodes_for_separation(
        self,
    ) -> None:
        self.assertEqual(CANONICAL_WORLD_SPAN, 1200.0)
        self.assertEqual(MIN_NODE_CENTER_DISTANCE, 2.0)

    def test_normalizes_the_largest_axis_span_to_the_canonical_span(
        self,
    ) -> None:
        coords = np.array(
            [[-50.5, -10.0, 0.0], [50.5, 10.0, 5.0]], dtype=np.float64
        )
        scaled, scale = normalize_world_scale(coords)
        spans = scaled.max(axis=0) - scaled.min(axis=0)
        self.assertAlmostEqual(float(spans.max()), CANONICAL_WORLD_SPAN)
        self.assertAlmostEqual(scale, CANONICAL_WORLD_SPAN / 101.0)

    def test_preserves_shape_proportions(self) -> None:
        coords = np.array(
            [[0.0, 0.0, 0.0], [10.0, 5.0, 2.0]], dtype=np.float64
        )
        scaled, _ = normalize_world_scale(coords, span=100.0)
        spans = scaled.max(axis=0) - scaled.min(axis=0)
        self.assertAlmostEqual(float(spans[0]), 100.0)
        self.assertAlmostEqual(float(spans[1]), 50.0)
        self.assertAlmostEqual(float(spans[2]), 20.0)

    def test_rejects_degenerate_or_malformed_layouts(self) -> None:
        with self.assertRaises(ValueError):
            normalize_world_scale(np.zeros((2, 2)))
        with self.assertRaises(ValueError):
            normalize_world_scale(np.zeros((0, 3)))
        with self.assertRaises(ValueError):
            normalize_world_scale(np.zeros((3, 3)))  # 零跨度

    def test_separates_every_published_node_after_float32_rounding(
        self,
    ) -> None:
        coords = np.array(
            [
                [-300.0, 0.0, 0.0],
                [300.0, 0.0, 0.0],
                [0.0, 0.0, 0.0],
                [0.01, 0.0, 0.0],
                [0.0, 0.01, 0.0],
                [0.0, 0.0, 0.0],
            ],
            dtype=np.float64,
        )

        separated, report = separate_published_nodes(coords)

        self.assertEqual(separated.dtype, np.dtype("<f4"))
        delta = separated[:, None, :] - separated[None, :, :]
        distance = np.linalg.norm(delta.astype(np.float64), axis=2)
        distance[np.diag_indices_from(distance)] = np.inf
        self.assertGreaterEqual(
            float(distance.min()), MIN_NODE_CENTER_DISTANCE
        )
        self.assertGreater(report.moved_nodes, 0)
        self.assertGreaterEqual(
            report.placement_clearance, MIN_NODE_CENTER_DISTANCE
        )

    def test_separation_is_deterministic_and_keeps_anchor_moves_local(
        self,
    ) -> None:
        coords = np.array(
            [
                [-300.0, 0.0, 0.0],
                [300.0, 0.0, 0.0],
                [0.0, 0.0, 0.0],
                [10.0, 10.0, 10.0],
                [0.0, 0.0, 0.0],
            ],
            dtype=np.float64,
        )

        first, first_report = separate_published_nodes(coords)
        second, second_report = separate_published_nodes(coords)

        np.testing.assert_array_equal(first, second)
        anchor_moves = np.linalg.norm(
            first[:4].astype(np.float64) - coords[:4], axis=1
        )
        self.assertLess(float(anchor_moves.max()), MIN_NODE_CENTER_DISTANCE)
        self.assertEqual(first_report, second_report)


if __name__ == "__main__":
    unittest.main()
