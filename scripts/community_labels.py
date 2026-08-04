"""Build readable labels for published layout communities."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np


def build_community_labels(
    communities: np.ndarray,
    coordinates: np.ndarray,
    keys: np.ndarray,
    info: Mapping[int, Mapping[str, Any]],
) -> dict[int, list[Any]]:
    """Use each community's hottest name at its geometric centroid."""

    if coordinates.shape != (len(communities), 3) or len(keys) != len(
        communities
    ):
        raise ValueError("community label arrays must align")

    valid = communities != 0xFFFF
    community_ids, inverse = np.unique(communities[valid], return_inverse=True)
    sums = np.zeros((len(community_ids), 3), dtype=np.float64)
    np.add.at(sums, inverse, coordinates[valid])
    counts = np.bincount(inverse)
    centers = {
        int(community): [
            round(float(value), 1) for value in sums[index] / counts[index]
        ]
        for index, community in enumerate(community_ids)
    }

    labels: dict[int, list[Any]] = {}
    for rank, community_value in enumerate(communities):
        community = int(community_value)
        if community == 0xFFFF or community in labels:
            continue
        detail = info[int(keys[rank])]
        labels[community] = [
            str(detail["cn"] or detail["name"]),
            centers[community],
        ]
    return labels
