"""Build a deterministic, relation-closed Parquet verification subset."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import orjson
import pyarrow as pa
import pyarrow.parquet as pq

SUBSET_BATCH_ROWS = 16_384
FACT_TABLES = (
    "relates_to",
    "worked_on",
    "appears_in",
    "voiced",
    "person_rel",
    "character_rel",
)
MAX_SUBSET_EPISODES_PER_SUBJECT = 256


@dataclass(frozen=True)
class SubsetLimits:
    subjects: int = 2_048
    people: int = 1_024
    characters: int = 2_048

    def validate(self) -> None:
        if min(self.subjects, self.people, self.characters) < 4:
            raise ValueError("every entity subset limit must be at least four")


class IdStats:
    """Accumulate non-negative integer ID frequencies in a compact array."""

    def __init__(self) -> None:
        self._counts = np.zeros(0, dtype=np.uint64)

    def _ensure(self, largest_id: int) -> None:
        if largest_id < len(self._counts):
            return
        size = max(largest_id + 1, max(1024, len(self._counts) * 2))
        grown = np.zeros(size, dtype=np.uint64)
        grown[: len(self._counts)] = self._counts
        self._counts = grown

    def add(self, ids: np.ndarray) -> None:
        values = np.asarray(ids, dtype=np.int64)
        if values.ndim != 1 or (len(values) and values.min() < 0):
            raise ValueError("stat IDs must be a non-negative vector")
        if not len(values):
            return
        self._ensure(int(values.max()))
        np.add.at(self._counts, values, 1)

    def top(self, limit: int) -> np.ndarray:
        if limit < 0:
            raise ValueError("top ID limit must not be negative")
        ids = np.flatnonzero(self._counts)
        if not len(ids) or limit == 0:
            return np.empty(0, dtype=np.int64)
        order = np.lexsort((ids, -self._counts[ids]))
        return ids[order[:limit]].astype(np.int64, copy=False)

    def counts_for(self, ids: np.ndarray) -> np.ndarray:
        values = np.asarray(ids, dtype=np.int64)
        result = np.zeros(values.shape, dtype=np.uint64)
        valid = (values >= 0) & (values < len(self._counts))
        result[valid] = self._counts[values[valid]]
        return result

    def max_count(self) -> int:
        return int(self._counts.max(initial=0))


def stable_id_order(ids: np.ndarray) -> np.ndarray:
    """Order unique IDs by a deterministic, data-independent hash."""
    values = np.unique(np.asarray(ids, dtype=np.int64))
    unsigned = values.astype(np.uint64, copy=False)
    hashed = unsigned * np.uint64(0x9E3779B185EBCA87)
    hashed ^= hashed >> np.uint64(30)
    hashed *= np.uint64(0xBF58476D1CE4E5B9)
    hashed ^= hashed >> np.uint64(27)
    return values[np.lexsort((values, hashed))]


def _top_by_metric(
    ids: np.ndarray, metric: np.ndarray, limit: int
) -> np.ndarray:
    values = np.asarray(ids, dtype=np.int64)
    scores = np.asarray(metric)
    order = np.lexsort((values, -scores))
    return values[order[:limit]]


def stress_slots(subset_limit: int) -> int:
    """Keep extreme cases without making them dominate subset quantiles."""
    if subset_limit < 4:
        raise ValueError("subset limit must be at least four")
    return 1


def _iter_columns(
    path: Path, columns: Sequence[str], *, batch_size: int = 65_536
) -> Iterable[dict[str, np.ndarray]]:
    parquet = pq.ParquetFile(path)
    for batch in parquet.iter_batches(
        batch_size=batch_size, columns=list(columns)
    ):
        yield {
            column: np.asarray(batch.column(column), dtype=np.int64)
            for column in columns
        }


def _membership_mask(values: np.ndarray, selected: np.ndarray) -> np.ndarray:
    positions = np.searchsorted(selected, values)
    found = positions < len(selected)
    matched = np.zeros(len(values), dtype=bool)
    matched[found] = selected[positions[found]] == values[found]
    return matched


def filter_parquet(
    source: Path,
    destination: Path,
    identity_filters: dict[str, np.ndarray],
    *,
    batch_size: int = 65_536,
) -> int:
    """Copy rows matching every identity filter without loading the table."""
    parquet = pq.ParquetFile(source)
    selections = {
        column: np.unique(np.asarray(ids, dtype=np.int64))
        for column, ids in identity_filters.items()
    }
    missing = set(selections) - set(parquet.schema_arrow.names)
    if missing:
        raise ValueError(
            f"{source.name} lacks filter columns {sorted(missing)}"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    rows = 0
    writer = pq.ParquetWriter(
        destination, parquet.schema_arrow, compression="zstd"
    )
    try:
        for batch in parquet.iter_batches(batch_size=batch_size):
            keep = np.ones(batch.num_rows, dtype=bool)
            for column, selected in selections.items():
                values = np.asarray(batch.column(column), dtype=np.int64)
                keep &= _membership_mask(values, selected)
            filtered = batch.filter(pa.array(keep))
            if filtered.num_rows:
                writer.write_table(pa.Table.from_batches([filtered]))
                rows += filtered.num_rows
    finally:
        writer.close()
    return rows


def select_subject_ids(parquet: Path, *, limit: int) -> np.ndarray:
    """Select stratified, stressful subjects plus a connected one-hop shell."""
    if limit < 4:
        raise ValueError("subject subset must contain at least four IDs")
    subject = pq.read_table(
        parquet / "subject.parquet",
        columns=[
            "id",
            "type",
            "wish",
            "done",
            "doing",
            "on_hold",
            "dropped",
        ],
    )
    subject_ids = np.asarray(subject.column("id"), dtype=np.int64)
    subject_types = np.asarray(subject.column("type"), dtype=np.int64)
    collects = np.zeros(len(subject_ids), dtype=np.int64)
    for column in ("wish", "done", "doing", "on_hold", "dropped"):
        collects += np.asarray(subject.column(column), dtype=np.int64)
    stress_count = stress_slots(limit)

    episode_counts = IdStats()
    longest_descriptions: list[tuple[int, int]] = []
    episode_file = pq.ParquetFile(parquet / "episode.parquet")
    for batch in episode_file.iter_batches(
        batch_size=65_536, columns=["subject_id", "description"]
    ):
        subject_batch = np.asarray(batch.column("subject_id"), dtype=np.int64)
        episode_counts.add(subject_batch)
        for subject_id, description in zip(
            subject_batch,
            batch.column("description").to_pylist(),
            strict=True,
        ):
            if description:
                longest_descriptions.append(
                    (len(description.encode("utf-8")), int(subject_id))
                )
        if len(longest_descriptions) > stress_count * 8:
            longest_descriptions = sorted(
                longest_descriptions, key=lambda row: (-row[0], row[1])
            )[: stress_count * 4]

    episode_count_values = episode_counts.counts_for(subject_ids)
    eligible = episode_count_values <= MAX_SUBSET_EPISODES_PER_SUBJECT
    eligible_ids = subject_ids[eligible]
    known_subjects = np.unique(eligible_ids)
    if limit > len(eligible_ids):
        limit = len(eligible_ids)
    if limit < 4:
        raise ValueError("fewer than four subjects meet the subset bounds")

    subject_incidence = IdStats()
    for rows in _iter_columns(
        parquet / "relates_to.parquet", ["from_id", "to_id"]
    ):
        subject_incidence.add(rows["from_id"])
        subject_incidence.add(rows["to_id"])
    for table, column in (
        ("worked_on", "to_id"),
        ("appears_in", "to_id"),
        ("voiced", "subject_id"),
    ):
        for rows in _iter_columns(parquet / f"{table}.parquet", [column]):
            subject_incidence.add(rows[column])

    description_subjects: list[int] = []
    for _length, subject_id in sorted(
        longest_descriptions, key=lambda row: (-row[0], row[1])
    ):
        if subject_id not in description_subjects:
            description_subjects.append(subject_id)
        if len(description_subjects) >= stress_count:
            break
    required = set(
        _top_by_metric(eligible_ids, collects[eligible], stress_count).tolist()
    )
    required.update(
        _top_by_metric(
            eligible_ids, episode_count_values[eligible], stress_count
        ).tolist()
    )
    required.update(description_subjects)
    required.update(
        _top_by_metric(
            eligible_ids,
            subject_incidence.counts_for(eligible_ids),
            stress_count,
        ).tolist()
    )
    required = {
        subject_id
        for subject_id in required
        if _membership_mask(
            np.asarray([subject_id], dtype=np.int64), known_subjects
        )[0]
    }

    media_types = np.unique(subject_types)
    per_type = max(1, limit // max(1, len(media_types) * 4))
    stratified = [
        stable_id_order(subject_ids[(subject_types == media_type) & eligible])[
            :per_type
        ]
        for media_type in media_types
    ]
    global_order = stable_id_order(eligible_ids)
    seed_limit = max(len(required), limit // 2)
    seeds = choose_bounded_ids(
        required=required,
        preferred=stratified,
        fallback=global_order,
        limit=seed_limit,
    )

    neighbors: list[np.ndarray] = []
    for rows in _iter_columns(
        parquet / "relates_to.parquet", ["from_id", "to_id"]
    ):
        from_seed = _membership_mask(rows["from_id"], seeds)
        to_seed = _membership_mask(rows["to_id"], seeds)
        neighbors.extend([rows["to_id"][from_seed], rows["from_id"][to_seed]])
    neighbor_ids = (
        stable_id_order(np.concatenate(neighbors))
        if neighbors
        else np.empty(0, dtype=np.int64)
    )
    neighbor_ids = neighbor_ids[_membership_mask(neighbor_ids, known_subjects)]
    return choose_bounded_ids(
        required=seeds,
        preferred=[neighbor_ids],
        fallback=global_order,
        limit=limit,
    )


def _first_relation_pairs(path: Path, limit: int) -> tuple[set[int], set[int]]:
    from_ids: set[int] = set()
    to_ids: set[int] = set()
    if limit <= 0:
        return from_ids, to_ids
    rows_seen = 0
    for rows in _iter_columns(path, ["from_id", "to_id"]):
        for from_id, to_id in zip(rows["from_id"], rows["to_id"], strict=True):
            from_ids.add(int(from_id))
            to_ids.add(int(to_id))
            rows_seen += 1
            if rows_seen >= limit:
                return from_ids, to_ids
    return from_ids, to_ids


def select_linked_entity_ids(
    parquet: Path,
    subjects: np.ndarray,
    *,
    person_limit: int,
    character_limit: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Select linked endpoints while retaining relation/voice stress rows."""
    if person_limit < 4 or character_limit < 4:
        raise ValueError(
            "linked entity subsets must contain at least four IDs"
        )
    people_stats = IdStats()
    character_stats = IdStats()
    for rows in _iter_columns(
        parquet / "worked_on.parquet", ["from_id", "to_id"]
    ):
        selected = _membership_mask(rows["to_id"], subjects)
        people_stats.add(rows["from_id"][selected])
    for rows in _iter_columns(
        parquet / "appears_in.parquet", ["from_id", "to_id"]
    ):
        selected = _membership_mask(rows["to_id"], subjects)
        character_stats.add(rows["from_id"][selected])

    sample_rows = max(1, min(8, person_limit // 4, character_limit // 4))
    required_people: set[int] = set()
    required_characters: set[int] = set()
    voice_samples = 0
    for rows in _iter_columns(
        parquet / "voiced.parquet", ["from_id", "to_id", "subject_id"]
    ):
        selected = _membership_mask(rows["subject_id"], subjects)
        people_stats.add(rows["from_id"][selected])
        character_stats.add(rows["to_id"][selected])
        for person_id, character_id in zip(
            rows["from_id"][selected], rows["to_id"][selected], strict=True
        ):
            if voice_samples >= sample_rows:
                break
            required_people.add(int(person_id))
            required_characters.add(int(character_id))
            voice_samples += 1

    person_from, person_to = _first_relation_pairs(
        parquet / "person_rel.parquet", sample_rows
    )
    character_from, character_to = _first_relation_pairs(
        parquet / "character_rel.parquet", sample_rows
    )
    required_people.update(person_from | person_to)
    required_characters.update(character_from | character_to)

    person = pq.read_table(
        parquet / "person.parquet", columns=["id", "collects"]
    )
    person_ids = np.asarray(person.column("id"), dtype=np.int64)
    person_collects = np.asarray(person.column("collects"), dtype=np.int64)
    character = pq.read_table(
        parquet / "character.parquet", columns=["id", "collects"]
    )
    character_ids = np.asarray(character.column("id"), dtype=np.int64)
    character_collects = np.asarray(
        character.column("collects"), dtype=np.int64
    )
    known_people = np.unique(person_ids)
    known_characters = np.unique(character_ids)
    required_people = {
        entity_id
        for entity_id in required_people
        if _membership_mask(
            np.asarray([entity_id], dtype=np.int64), known_people
        )[0]
    }
    required_characters = {
        entity_id
        for entity_id in required_characters
        if _membership_mask(
            np.asarray([entity_id], dtype=np.int64), known_characters
        )[0]
    }
    linked_people = people_stats.top(person_limit)
    linked_people = linked_people[
        _membership_mask(linked_people, known_people)
    ]
    linked_characters = character_stats.top(character_limit)
    linked_characters = linked_characters[
        _membership_mask(linked_characters, known_characters)
    ]
    people = choose_bounded_ids(
        required=required_people,
        preferred=[
            linked_people,
            _top_by_metric(person_ids, person_collects, min(32, person_limit)),
        ],
        fallback=stable_id_order(person_ids),
        limit=min(person_limit, len(person_ids)),
    )
    characters = choose_bounded_ids(
        required=required_characters,
        preferred=[
            linked_characters,
            _top_by_metric(
                character_ids,
                character_collects,
                min(32, character_limit),
            ),
        ],
        fallback=stable_id_order(character_ids),
        limit=min(character_limit, len(character_ids)),
    )
    return people, characters


def subset_identity_filters(
    subjects: np.ndarray,
    people: np.ndarray,
    characters: np.ndarray,
) -> dict[str, dict[str, np.ndarray]]:
    """Declare the entity closure required by every published source table."""
    return {
        "subject": {"id": subjects},
        "person": {"id": people},
        "character": {"id": characters},
        "episode": {"subject_id": subjects},
        "episode_of": {"to_id": subjects},
        "relates_to": {"from_id": subjects, "to_id": subjects},
        "worked_on": {"from_id": people, "to_id": subjects},
        "appears_in": {"from_id": characters, "to_id": subjects},
        "voiced": {
            "from_id": people,
            "to_id": characters,
            "subject_id": subjects,
        },
        "person_rel": {"from_id": people, "to_id": people},
        "character_rel": {
            "from_id": characters,
            "to_id": characters,
        },
    }


def _subset_incidence_quality(parquet: Path) -> tuple[int, int]:
    subject_stats = IdStats()
    people_stats = IdStats()
    character_stats = IdStats()
    for rows in _iter_columns(
        parquet / "relates_to.parquet", ["from_id", "to_id"]
    ):
        subject_stats.add(rows["from_id"])
        subject_stats.add(rows["to_id"])
    for rows in _iter_columns(
        parquet / "worked_on.parquet", ["from_id", "to_id"]
    ):
        people_stats.add(rows["from_id"])
        subject_stats.add(rows["to_id"])
    for rows in _iter_columns(
        parquet / "appears_in.parquet", ["from_id", "to_id"]
    ):
        character_stats.add(rows["from_id"])
        subject_stats.add(rows["to_id"])
    for rows in _iter_columns(
        parquet / "voiced.parquet", ["from_id", "to_id", "subject_id"]
    ):
        people_stats.add(rows["from_id"])
        character_stats.add(rows["to_id"])
        subject_stats.add(rows["subject_id"])
    for table, stats in (
        ("person_rel", people_stats),
        ("character_rel", character_stats),
    ):
        for rows in _iter_columns(
            parquet / f"{table}.parquet", ["from_id", "to_id"]
        ):
            stats.add(rows["from_id"])
            stats.add(rows["to_id"])
    maximum = max(
        subject_stats.max_count(),
        people_stats.max_count(),
        character_stats.max_count(),
    )
    total = sum(
        pq.ParquetFile(parquet / f"{table}.parquet").metadata.num_rows
        for table in FACT_TABLES
    )
    return maximum, total


def _count_non_empty_text(parquet: Path) -> int:
    total = 0
    for table, columns in (
        ("subject", ("summary", "infobox")),
        ("person", ("summary", "infobox")),
        ("character", ("summary", "infobox")),
        ("episode", ("description",)),
    ):
        source = pq.ParquetFile(parquet / f"{table}.parquet")
        for batch in source.iter_batches(
            batch_size=SUBSET_BATCH_ROWS, columns=list(columns)
        ):
            for column in columns:
                values = batch[column].to_pylist()
                total += sum(bool(value) for value in values)
    return total


def _subset_quality(
    parquet: Path, table_rows: dict[str, int]
) -> dict[str, Any]:
    episodes = IdStats()
    for rows in _iter_columns(parquet / "episode.parquet", ["subject_id"]):
        episodes.add(rows["subject_id"])
    max_incidence, fact_rows = _subset_incidence_quality(parquet)
    subject_types = pq.read_table(
        parquet / "subject.parquet", columns=["type"]
    ).column("type")
    empty_fact_tables = [
        table for table in FACT_TABLES if table_rows[table] == 0
    ]
    subject_type_count = len(np.unique(np.asarray(subject_types)))
    max_episode_group = episodes.max_count()
    non_empty_text = _count_non_empty_text(parquet)
    quality: dict[str, Any] = {
        "subject_types": subject_type_count,
        "max_episode_group": max_episode_group,
        "max_entity_incidence_rows": max_incidence,
        "fact_rows": fact_rows,
        "non_empty_text_values": non_empty_text,
        "empty_fact_tables": empty_fact_tables,
    }
    failures: list[str] = []
    if empty_fact_tables:
        failures.append(f"empty fact tables: {empty_fact_tables}")
    if subject_type_count < 4:
        failures.append("fewer than four subject media types")
    if max_episode_group <= 200:
        failures.append("episode paging boundary (>200) is not covered")
    if max_incidence <= 200:
        failures.append("fact paging boundary (>200) is not covered")
    if not non_empty_text:
        failures.append("no non-empty long text is covered")
    quality["failures"] = failures
    return quality


def build_representative_subset(
    source_parquet: Path,
    destination: Path,
    limits: SubsetLimits,
    *,
    enforce_quality: bool = True,
) -> dict[str, Any]:
    """Build a deterministic, relation-closed Parquet differential subset."""
    limits.validate()
    parquet = destination / "parquet"
    dump = destination / "dump"
    parquet.mkdir(parents=True, exist_ok=True)
    dump.mkdir(parents=True, exist_ok=True)

    subjects = select_subject_ids(source_parquet, limit=limits.subjects)
    people, characters = select_linked_entity_ids(
        source_parquet,
        subjects,
        person_limit=limits.people,
        character_limit=limits.characters,
    )
    filters = subset_identity_filters(subjects, people, characters)
    table_rows: dict[str, int] = {}
    for table, identity_filters in filters.items():
        table_rows[table] = filter_parquet(
            source_parquet / f"{table}.parquet",
            parquet / f"{table}.parquet",
            identity_filters,
            batch_size=SUBSET_BATCH_ROWS,
        )

    version = (source_parquet / "VERSION").read_text().strip()
    (parquet / "VERSION").write_text(version + "\n")
    (dump / "VERSION").write_text(version + "\n")
    quality = _subset_quality(parquet, table_rows)
    report: dict[str, Any] = {
        "source_version": version,
        "limits": {
            "subjects": limits.subjects,
            "people": limits.people,
            "characters": limits.characters,
        },
        "selected": {
            "subjects": len(subjects),
            "people": len(people),
            "characters": len(characters),
        },
        "tables": table_rows,
        "quality": quality,
    }
    (destination / "subset-report.json").write_bytes(
        orjson.dumps(report, option=orjson.OPT_INDENT_2)
    )
    if enforce_quality and quality["failures"]:
        raise RuntimeError(
            "representative subset quality failed: "
            + "; ".join(quality["failures"])
        )
    return report


def choose_bounded_ids(
    *,
    required: Iterable[int],
    preferred: Sequence[Iterable[int]],
    fallback: Iterable[int],
    limit: int,
) -> np.ndarray:
    """Choose deterministic IDs while preserving all required stress cases."""
    required_ids = set(required)
    if len(required_ids) > limit:
        raise ValueError("limit is smaller than the required IDs")
    selected = set(required_ids)
    for candidates in (*preferred, fallback):
        for candidate in candidates:
            if len(selected) >= limit:
                break
            selected.add(int(candidate))
        if len(selected) >= limit:
            break
    return np.asarray(sorted(selected), dtype=np.int64)
