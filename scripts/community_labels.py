"""Build readable labels for published layout communities."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np


def build_community_labels(
    communities: np.ndarray,
    coordinates: np.ndarray,
    names: Sequence[str],
    cn_names: Sequence[str],
) -> dict[int, list[Any]]:
    """Use each community's hottest name at its geometric centroid."""

    if (
        coordinates.shape != (len(communities), 3)
        or len(names) != len(communities)
        or len(cn_names) != len(communities)
    ):
        raise ValueError("community label arrays must align")

    valid = communities != 0xFFFF
    valid_communities = communities[valid].astype(np.int64, copy=False)
    if not len(valid_communities):
        return {}
    width = int(valid_communities.max()) + 1
    counts = np.bincount(valid_communities, minlength=width)
    sums = np.empty((width, 3), dtype=np.float64)
    for axis in range(3):
        sums[:, axis] = np.bincount(
            valid_communities,
            weights=coordinates[valid, axis],
            minlength=width,
        )

    labels: dict[int, list[Any]] = {}
    for rank, community_value in enumerate(communities):
        community = int(community_value)
        if community == 0xFFFF or community in labels:
            continue
        labels[community] = [
            str(cn_names[rank] or names[rank]),
            [
                round(float(value), 1)
                for value in sums[community] / counts[community]
            ],
        ]
    return labels
