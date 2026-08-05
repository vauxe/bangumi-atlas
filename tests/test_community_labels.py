from __future__ import annotations

import unittest

import numpy as np

from scripts.community_labels import build_community_labels


class CommunityLabelTests(unittest.TestCase):
    def test_uses_top_node_name_at_the_community_centroid(self) -> None:
        communities = np.array([7, 7, 8, 0xFFFF], dtype=np.uint16)
        coordinates = np.array(
            [
                [0.0, 0.0, 0.0],
                [2.0, 4.0, 6.0],
                [10.0, 11.0, 12.0],
                [100.0, 100.0, 100.0],
            ],
            dtype=np.float32,
        )
        names = ["top", "second", "solo", "isolated"]
        cn_names = ["首选名", "", "", ""]

        self.assertEqual(
            build_community_labels(communities, coordinates, names, cn_names),
            {
                7: ["首选名", [1.0, 2.0, 3.0]],
                8: ["solo", [10.0, 11.0, 12.0]],
            },
        )


if __name__ == "__main__":
    unittest.main()
