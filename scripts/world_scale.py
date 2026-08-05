"""Normalize published layout coordinates to the canonical world span."""

from __future__ import annotations

import numpy as np

# 探索端的聚焦层级、工作集字号和节点尺寸按绝对 zoom 调参,
# 其语义依赖稳定的世界尺度;UMAP 等布局算法的输出尺度是任意的,
# 发布前必须归一到规范跨度。
CANONICAL_WORLD_SPAN = 600.0


def normalize_world_scale(
    coordinates: np.ndarray,
    span: float = CANONICAL_WORLD_SPAN,
) -> tuple[np.ndarray, float]:
    """Scale coordinates so the largest axis span equals ``span``."""

    if coordinates.ndim != 2 or coordinates.shape[1] != 3:
        raise ValueError("coordinates must be (n, 3)")
    if len(coordinates) == 0:
        raise ValueError("layout must contain at least one node")
    extent = float((coordinates.max(axis=0) - coordinates.min(axis=0)).max())
    if not np.isfinite(extent) or extent <= 0:
        raise ValueError("layout extent must be positive and finite")
    scale = span / extent
    return coordinates * scale, scale
