"""Independent raw-JSONL oracle for the eleven Parquet projections."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import orjson
import pyarrow.parquet as pq

from . import entity_key as ek
from .content_fingerprint import RowFingerprint
from .enum_mappings import EnumMap, load_mappings
from .parquet_provenance import PARQUET_TABLES as PROJECTED_FILES

SUBJECT_TYPES = {1: "书籍", 2: "动画", 3: "音乐", 4: "游戏", 6: "三次元"}
CHARACTER_APPEAR_TYPES = {
    1: "主角",
    2: "配角",
    3: "客串",
    4: "闲角",
    5: "旁白",
    6: "声库",
}


def _require_entity_id(kind: int, value: Any, label: str) -> None:
    try:
        ek.entity_key(kind, value)
    except ValueError as error:
        raise ValueError(f"{label}: {error}") from error


def _rows(dump: Path, name: str) -> Iterator[dict[str, Any]]:
    path = dump / f"{name}.jsonlines"
    with path.open("rb") as stream:
        for line_number, line in enumerate(stream, start=1):
            try:
                value = orjson.loads(line)
            except orjson.JSONDecodeError as error:
                raise ValueError(
                    f"{path.name}:{line_number}: invalid JSON"
                ) from error
            if not isinstance(value, dict):
                raise ValueError(
                    f"{path.name}:{line_number}: row must be an object"
                )
            yield value


def _new_fingerprints() -> dict[str, RowFingerprint]:
    return {table: RowFingerprint() for table in PROJECTED_FILES}


def _project_nodes(
    dump: Path,
    fingerprints: dict[str, RowFingerprint],
    platforms: EnumMap,
) -> tuple[dict[int, int], set[int], set[int]]:
    subject_type: dict[int, int] = {}
    for row in _rows(dump, "subject"):
        source_id = row["id"]
        _require_entity_id(ek.KIND_SUBJECT, source_id, "subject.id")
        media_type = row["type"]
        if source_id in subject_type:
            continue
        subject_type[source_id] = media_type
        favorite = row.get("favorite") or {}
        platform_namespace = platforms.get(media_type)
        platform = (platform_namespace or {}).get(row.get("platform")) or {}
        score_details = row.get("score_details") or {}
        fingerprints["Subject"].add(
            (
                source_id,
                media_type,
                SUBJECT_TYPES.get(media_type, str(media_type)),
                row.get("name") or "",
                row.get("name_cn") or "",
                row.get("platform"),
                platform.get("type_cn") or platform.get("type") or "",
                row.get("date") or "",
                (
                    float(row["score"])
                    if row.get("score") is not None
                    else None
                ),
                row.get("rank"),
                bool(row.get("nsfw")),
                favorite.get("wish", 0),
                favorite.get("done", 0),
                favorite.get("doing", 0),
                favorite.get("on_hold", 0),
                favorite.get("dropped", 0),
                bool(row.get("series")),
                [score_details.get(str(score), 0) for score in range(1, 11)],
                row.get("meta_tags") or [],
                row.get("tags") or [],
                row.get("summary") or "",
                row.get("infobox") or "",
            )
        )

    person_ids: set[int] = set()
    for row in _rows(dump, "person"):
        source_id = row["id"]
        _require_entity_id(ek.KIND_PERSON, source_id, "person.id")
        if source_id in person_ids:
            continue
        person_ids.add(source_id)
        fingerprints["Person"].add(
            (
                source_id,
                row.get("name") or "",
                row.get("type"),
                row.get("career") or [],
                row.get("comments", 0),
                row.get("collects", 0),
                row.get("summary") or "",
                row.get("infobox") or "",
            )
        )

    character_ids: set[int] = set()
    for row in _rows(dump, "character"):
        source_id = row["id"]
        _require_entity_id(ek.KIND_CHARACTER, source_id, "character.id")
        if source_id in character_ids:
            continue
        character_ids.add(source_id)
        fingerprints["Character"].add(
            (
                source_id,
                row.get("name") or "",
                row.get("role"),
                row.get("comments", 0),
                row.get("collects", 0),
                row.get("summary") or "",
                row.get("infobox") or "",
            )
        )

    episode_ids: set[int] = set()
    for row in _rows(dump, "episode"):
        source_id = row["id"]
        _require_entity_id(
            ek.KIND_SUBJECT, row["subject_id"], "episode.subject_id"
        )
        if source_id in episode_ids:
            continue
        episode_ids.add(source_id)
        sort = row.get("sort")
        fingerprints["Episode"].add(
            (
                source_id,
                row.get("name") or "",
                row.get("name_cn") or "",
                row.get("description") or "",
                row.get("airdate") or "",
                row.get("disc", 0),
                row.get("duration") or "",
                float(sort) if sort is not None else None,
                row.get("type"),
                row["subject_id"],
            )
        )
        if row["subject_id"] in subject_type:
            fingerprints["EPISODE_OF"].add((source_id, row["subject_id"]))
    return subject_type, person_ids, character_ids


def _project_subject_edges(
    dump: Path,
    fingerprints: dict[str, RowFingerprint],
    subject_type: dict[int, int],
    person_ids: set[int],
    character_ids: set[int],
    relations: EnumMap,
    staffs: EnumMap,
) -> None:
    for row in _rows(dump, "subject-relations"):
        source_id = row["subject_id"]
        target_id = row["related_subject_id"]
        _require_entity_id(
            ek.KIND_SUBJECT, source_id, "subject-relations.subject_id"
        )
        _require_entity_id(
            ek.KIND_SUBJECT,
            target_id,
            "subject-relations.related_subject_id",
        )
        if source_id not in subject_type or target_id not in subject_type:
            continue
        relation = (
            (relations.get(subject_type[source_id]) or {}).get(
                row["relation_type"]
            )
            or relations["*"].get(row["relation_type"])
            or {}
        )
        fingerprints["RELATES_TO"].add(
            (
                source_id,
                target_id,
                row["relation_type"],
                relation.get("cn") or relation.get("en") or "",
                row.get("order", 0),
            )
        )

    for row in _rows(dump, "subject-persons"):
        person_id = row["person_id"]
        subject_id = row["subject_id"]
        _require_entity_id(
            ek.KIND_PERSON, person_id, "subject-persons.person_id"
        )
        _require_entity_id(
            ek.KIND_SUBJECT, subject_id, "subject-persons.subject_id"
        )
        if person_id not in person_ids or subject_id not in subject_type:
            continue
        position = (
            (staffs.get(subject_type[subject_id]) or {}).get(row["position"])
            or staffs["*"].get(row["position"])
            or {}
        )
        fingerprints["WORKED_ON"].add(
            (
                person_id,
                subject_id,
                row["position"],
                position.get("cn") or position.get("en") or "",
                row.get("appear_eps") or "",
            )
        )

    for row in _rows(dump, "subject-characters"):
        character_id = row["character_id"]
        subject_id = row["subject_id"]
        _require_entity_id(
            ek.KIND_CHARACTER,
            character_id,
            "subject-characters.character_id",
        )
        _require_entity_id(
            ek.KIND_SUBJECT, subject_id, "subject-characters.subject_id"
        )
        if character_id not in character_ids or subject_id not in subject_type:
            continue
        fingerprints["APPEARS_IN"].add(
            (
                character_id,
                subject_id,
                row["type"],
                CHARACTER_APPEAR_TYPES.get(row["type"], ""),
                row.get("order", 0),
            )
        )


def _project_person_edges(
    dump: Path,
    fingerprints: dict[str, RowFingerprint],
    person_ids: set[int],
    character_ids: set[int],
    person_relations: EnumMap,
) -> None:
    for row in _rows(dump, "person-characters"):
        person_id = row["person_id"]
        character_id = row["character_id"]
        _require_entity_id(
            ek.KIND_PERSON, person_id, "person-characters.person_id"
        )
        _require_entity_id(
            ek.KIND_CHARACTER,
            character_id,
            "person-characters.character_id",
        )
        _require_entity_id(
            ek.KIND_SUBJECT,
            row["subject_id"],
            "person-characters.subject_id",
        )
        if person_id not in person_ids or character_id not in character_ids:
            continue
        fingerprints["VOICED"].add(
            (
                person_id,
                character_id,
                row["subject_id"],
                row.get("type", 0),
                row.get("summary") or "",
            )
        )

    pools = {"prsn": person_ids, "crt": character_ids}
    tables = {"prsn": "PERSON_REL", "crt": "CHARACTER_REL"}
    for row in _rows(dump, "person-relations"):
        kind = row.get("person_type")
        if kind not in pools:
            raise ValueError(
                f"person-relations.person_type has unsupported value {kind!r}"
            )
        source_id = row["person_id"]
        target_id = row["related_person_id"]
        entity_kind = ek.KIND_PERSON if kind == "prsn" else ek.KIND_CHARACTER
        _require_entity_id(
            entity_kind, source_id, "person-relations.person_id"
        )
        _require_entity_id(
            entity_kind,
            target_id,
            "person-relations.related_person_id",
        )
        if source_id not in pools[kind] or target_id not in pools[kind]:
            continue
        relation = (person_relations.get(kind) or {}).get(
            row["relation_type"]
        ) or {}
        fingerprints[tables[kind]].add(
            (
                source_id,
                target_id,
                row["relation_type"],
                relation.get("cn") or "",
                bool(row.get("spoiler")),
                bool(row.get("ended")),
            )
        )


def source_fingerprints(
    *, dump: Path, mappings: Path
) -> dict[str, tuple[int, str, str]]:
    """Reconstruct every projected row without importing producer code."""

    relations, staffs, platforms, person_relations, _voice_roles = (
        load_mappings(mappings)
    )
    fingerprints = _new_fingerprints()
    subject_type, person_ids, character_ids = _project_nodes(
        dump, fingerprints, platforms
    )
    _project_subject_edges(
        dump,
        fingerprints,
        subject_type,
        person_ids,
        character_ids,
        relations,
        staffs,
    )
    _project_person_edges(
        dump,
        fingerprints,
        person_ids,
        character_ids,
        person_relations,
    )
    return {
        table: fingerprint.snapshot()
        for table, fingerprint in fingerprints.items()
    }


def parquet_fingerprints(
    parquet: Path,
) -> dict[str, tuple[int, str, str]]:
    fingerprints: dict[str, tuple[int, str, str]] = {}
    for table, stem in PROJECTED_FILES.items():
        fingerprint = RowFingerprint()
        file = pq.ParquetFile(parquet / f"{stem}.parquet")
        for batch in file.iter_batches(batch_size=32_768):
            columns = [
                batch.column(index).to_pylist()
                for index in range(batch.num_columns)
            ]
            for row in zip(*columns, strict=True):
                fingerprint.add(row)
        fingerprints[table] = fingerprint.snapshot()
    return fingerprints


def require_projection_matches(
    *, dump: Path, mappings: Path, parquet: Path
) -> dict[str, tuple[int, str, str]]:
    """Reject equal-count projections whose values or endpoints changed."""

    expected = source_fingerprints(dump=dump, mappings=mappings)
    actual = parquet_fingerprints(parquet)
    mismatches = [
        table for table in PROJECTED_FILES if expected[table] != actual[table]
    ]
    if mismatches:
        details = ", ".join(
            f"{table} content expected={expected[table]} "
            f"actual={actual[table]}"
            for table in mismatches
        )
        raise ValueError(f"raw-to-Parquet semantic mismatch: {details}")
    return actual
