from __future__ import annotations

import unittest
from collections.abc import Callable
from unittest import mock

import igraph as ig
import numpy as np

from scripts import layout
from scripts.layout import (
    TYPICAL_NODE_DISTANCE,
    detect_communities,
    run_layout,
    shape_digest,
    shape_layout,
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
        # 只做等比缩放:整形后的轴比例与 PCA 主轴的输入比例一致,
        # 纵深不再被压成地图厚度
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

        # 球壳:孤立节点在各方向包住实体,且彼此等距于原点
        self.assertGreater(radius[degree == 0].min(), radius[degree > 0].max())
        shell = radius[degree == 0]
        self.assertAlmostEqual(float(shell.max() - shell.min()), 0.0, places=4)
        self.assertGreater(float(np.ptp(shaped[degree == 0][:, 1])), 0.0)


class ShapeIdentityTests(unittest.TestCase):
    def test_digest_is_a_stable_sha256(self) -> None:
        digest = shape_digest()

        self.assertRegex(digest, r"^[0-9a-f]{64}$")
        self.assertEqual(digest, shape_digest())

    def test_digest_follows_the_shaping_constants(self) -> None:
        before = shape_digest()
        with mock.patch.object(
            layout, "_SHAPE_CONSTANTS", {"typical_node_distance": 0.29}
        ):
            self.assertNotEqual(shape_digest(), before)
        self.assertEqual(shape_digest(), before)

    def test_digest_follows_the_shaping_logic(self) -> None:
        # 同名同签名、只换实现:平面光环改成球壳这类改动必须被摘要抓到
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

    def test_digest_ignores_comments_and_docstrings(self) -> None:
        def documented() -> Callable[[int], int]:
            def shaped(x: int) -> int:
                """原始说明。"""
                return x + 1

            return shaped

        def reworded() -> Callable[[int], int]:
            def shaped(x: int) -> int:
                """改写后的说明,逻辑一字未动。"""
                # 顺手加一行注释
                return x + 1

            return shaped

        self.assertEqual(
            layout._canonical_logic(documented()),
            layout._canonical_logic(reworded()),
        )


if __name__ == "__main__":
    unittest.main()
