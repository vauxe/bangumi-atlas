from __future__ import annotations

import unittest

import numpy as np

from scripts.world_scale import CANONICAL_WORLD_SPAN, normalize_world_scale


class WorldScaleTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
