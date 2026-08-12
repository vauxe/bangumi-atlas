"""Affine uint16 encoding for browser-streamed 3-D positions."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np

POSITION_ENCODING = "u16le-affine-3d-v1"
POSITION_COMPONENTS = 3
POSITION_QUANTIZED_MAX = (1 << 16) - 1


def _vector(
    metadata: Mapping[str, Any], name: str, *, nonnegative: bool = False
) -> np.ndarray:
    raw = metadata.get(name)
    if (
        not isinstance(raw, Sequence)
        or isinstance(raw, (str, bytes, bytearray))
        or len(raw) != POSITION_COMPONENTS
        or any(isinstance(value, bool) for value in raw)
    ):
        raise ValueError(
            f"position encoding {name} must contain three numbers"
        )
    try:
        result = np.asarray(raw, dtype=np.float64)
    except (TypeError, ValueError) as error:
        raise ValueError(
            f"position encoding {name} must contain three numbers"
        ) from error
    if not np.isfinite(result).all() or (
        nonnegative and bool((result < 0).any())
    ):
        raise ValueError(f"position encoding {name} is invalid")
    return result


def validate_position_encoding(metadata: Mapping[str, Any]) -> None:
    if (
        metadata.get("encoding") != POSITION_ENCODING
        or metadata.get("components") != POSITION_COMPONENTS
    ):
        raise ValueError("unsupported position encoding")
    _vector(metadata, "offset")
    scale = _vector(metadata, "scale", nonnegative=True)
    endpoint = _vector(metadata, "offset") + scale * POSITION_QUANTIZED_MAX
    if not np.isfinite(endpoint).all():
        raise ValueError("position encoding endpoint is not finite")


def quantize_positions(
    coordinates: np.ndarray,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Quantize finite ``(n, 3)`` coordinates after float32 publication."""

    source = np.asarray(coordinates)
    if source.ndim != 2 or source.shape[1] != POSITION_COMPONENTS:
        raise ValueError("positions must be an (n, 3) array")
    if len(source) == 0:
        raise ValueError("positions must not be empty")
    if not np.isfinite(source).all():
        raise ValueError("positions must be finite")
    source = source.astype("<f4", copy=False)
    offset = source.min(axis=0).astype(np.float64)
    span = source.max(axis=0).astype(np.float64) - offset
    scale = span / POSITION_QUANTIZED_MAX
    encoded = np.zeros(source.shape, dtype="<u2")
    active = scale > 0
    if bool(active.any()):
        normalized = (
            source[:, active].astype(np.float64) - offset[active]
        ) / scale[active]
        encoded[:, active] = np.clip(
            np.rint(normalized), 0, POSITION_QUANTIZED_MAX
        ).astype("<u2")
    metadata: dict[str, Any] = {
        "encoding": POSITION_ENCODING,
        "components": POSITION_COMPONENTS,
        "offset": [float(value) for value in offset],
        "scale": [float(value) for value in scale],
    }
    return encoded, metadata


def decode_positions(
    encoded: np.ndarray, metadata: Mapping[str, Any]
) -> np.ndarray:
    """Decode exactly as the browser: affine math followed by float32."""

    validate_position_encoding(metadata)
    values = np.asarray(encoded)
    if (
        values.ndim != 2
        or values.shape[1] != POSITION_COMPONENTS
        or values.dtype.kind != "u"
        or values.dtype.itemsize != 2
    ):
        raise ValueError("encoded positions must be an (n, 3) uint16 array")
    offset = _vector(metadata, "offset")
    scale = _vector(metadata, "scale", nonnegative=True)
    return (offset + values.astype(np.float64) * scale).astype("<f4")
