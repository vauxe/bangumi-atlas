"""Stable EntityKey encoding shared by pipeline producers and consumers."""

from __future__ import annotations

from numbers import Integral
from typing import Any

import numpy as np

ENTITY_KEY_FORMAT = "entity-key-v1"
KIND_SUBJECT = 1
KIND_PERSON = 2
KIND_CHARACTER = 3
KINDS = (KIND_SUBJECT, KIND_PERSON, KIND_CHARACTER)
KIND_NAMES = {
    KIND_SUBJECT: "subject",
    KIND_PERSON: "person",
    KIND_CHARACTER: "character",
}
MAX_SOURCE_ID = (1 << 24) - 1


def is_entity_kind(value: object) -> bool:
    return (
        isinstance(value, Integral)
        and not isinstance(value, bool)
        and int(value) in KINDS
    )


def entity_key(kind: int, source_id: int) -> int:
    """Encode ``kind << 24 | source_id`` without truncating invalid IDs."""

    if not is_entity_kind(kind):
        raise ValueError(f"unknown entity kind {kind}")
    if (
        not isinstance(source_id, Integral)
        or isinstance(source_id, bool)
        or not 0 <= int(source_id) <= MAX_SOURCE_ID
    ):
        raise ValueError(
            f"source id {source_id} exceeds 24-bit EntityKey; "
            "upgrade the key format instead of truncating"
        )
    return (int(kind) << 24) | int(source_id)


def entity_keys(kind: int, source_ids: Any) -> np.ndarray:
    """Vector encoder that validates IDs before any narrowing cast."""

    if not is_entity_kind(kind):
        raise ValueError(f"unknown entity kind {kind}")
    values = np.asarray(source_ids)
    if not values.size:
        return np.empty(values.shape, dtype=np.uint32)
    if values.dtype.kind in "iu" and values.dtype.kind != "b":
        minimum = int(values.min())
        maximum = int(values.max())
    elif values.dtype.kind == "O":
        flattened = values.ravel().tolist()
        if any(
            not isinstance(value, Integral) or isinstance(value, bool)
            for value in flattened
        ):
            raise ValueError("source ids must contain only integers")
        minimum = min(int(value) for value in flattened)
        maximum = max(int(value) for value in flattened)
    else:
        raise ValueError("source ids must contain only integers")
    if minimum < 0 or maximum > MAX_SOURCE_ID:
        raise ValueError(
            f"source id range {minimum}..{maximum} exceeds 24-bit "
            "EntityKey; upgrade the key format instead of truncating"
        )
    narrowed = values.astype(np.uint32, copy=False)
    return (np.uint32(int(kind)) << np.uint32(24)) | narrowed
