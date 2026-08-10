from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

from scripts import build_db, source_projection


def write_mapping_snapshot(directory: Path) -> None:
    files = {
        "subject_relations.yml": (
            "relations:\n  1:\n    1:\n      cn: 续集\n"
        ).encode(),
        "subject_staffs.yml": (
            "staffs:\n  1:\n    1:\n      cn: 原作\n"
        ).encode(),
        "subject_platforms.yml": b"platforms: {}\n",
        "person_relations.yml": (
            "relations:\n"
            "  prsn:\n    1:\n      cn: 合作\n"
            "  prsn_cv:\n    0:\n      cn: 配音\n"
            "  crt:\n    1:\n      cn: 关联\n"
        ).encode(),
    }
    for name, data in files.items():
        (directory / name).write_bytes(data)
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "source": "https://github.com/bangumi/common",
                "revision": "b" * 40,
                "files": {
                    name: hashlib.sha256(data).hexdigest()
                    for name, data in files.items()
                },
            }
        )
    )


def write_dump(directory: Path) -> None:
    records = {
        "subject": [{"id": 1, "type": 1, "name": "Subject", "platform": None}],
        "person": [{"id": 2, "name": "Person", "type": 1}],
        "character": [{"id": 3, "name": "Character", "role": 1}],
        "episode": [{"id": 4, "subject_id": 1, "type": 0}],
        "subject-relations": [
            {
                "subject_id": 1,
                "related_subject_id": 1,
                "relation_type": 1,
                "order": 2,
            }
        ],
        "subject-persons": [{"person_id": 2, "subject_id": 1, "position": 1}],
        "subject-characters": [
            {"character_id": 3, "subject_id": 1, "type": 1}
        ],
        "person-characters": [
            {"person_id": 2, "character_id": 3, "subject_id": 1, "type": 0}
        ],
        "person-relations": [
            {
                "person_type": "prsn",
                "person_id": 2,
                "related_person_id": 2,
                "relation_type": 1,
            },
            {
                "person_type": "crt",
                "person_id": 3,
                "related_person_id": 3,
                "relation_type": 1,
            },
        ],
    }
    for name, rows in records.items():
        payload = b"".join(
            json.dumps(row, ensure_ascii=False).encode() + b"\n"
            for row in rows
        )
        (directory / f"{name}.jsonlines").write_bytes(payload)


class IndependentSourceProjectionTests(unittest.TestCase):
    def test_integer_score_matches_float64_parquet_projection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump = root / "dump"
            mappings = root / "mappings"
            parquet = root / "parquet"
            dump.mkdir()
            mappings.mkdir()
            write_dump(dump)
            write_mapping_snapshot(mappings)
            (dump / "subject.jsonlines").write_text(
                json.dumps(
                    {
                        "id": 1,
                        "type": 1,
                        "name": "Subject",
                        "platform": None,
                        "score": 9,
                    }
                )
                + "\n"
            )

            with (
                patch.object(build_db, "DUMP", dump),
                patch.object(build_db, "MAPPINGS", mappings),
                patch.object(build_db, "PARQUET", parquet),
                patch.object(
                    build_db,
                    "finalize_parquet_generation",
                    return_value=None,
                ),
            ):
                build_db.build_parquet()

            source_projection.require_projection_matches(
                dump=dump,
                mappings=mappings,
                parquet=parquet,
            )

    def test_entity_ids_are_rejected_before_projection_can_publish(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump = root / "dump"
            mappings = root / "mappings"
            dump.mkdir()
            mappings.mkdir()
            write_dump(dump)
            write_mapping_snapshot(mappings)
            (dump / "subject.jsonlines").write_text(
                json.dumps({"id": 1 << 24, "type": 1}) + "\n"
            )

            with self.assertRaisesRegex(ValueError, "subject.id.*24-bit"):
                source_projection.source_fingerprints(
                    dump=dump, mappings=mappings
                )

    def test_same_count_value_mutation_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump = root / "dump"
            mappings = root / "mappings"
            parquet = root / "parquet"
            dump.mkdir()
            mappings.mkdir()
            write_dump(dump)
            write_mapping_snapshot(mappings)

            with (
                patch.object(build_db, "DUMP", dump),
                patch.object(build_db, "MAPPINGS", mappings),
                patch.object(build_db, "PARQUET", parquet),
                patch.object(
                    build_db,
                    "finalize_parquet_generation",
                    return_value=None,
                ),
            ):
                build_db.build_parquet()

            source_projection.require_projection_matches(
                dump=dump,
                mappings=mappings,
                parquet=parquet,
            )

            path = parquet / "subject.parquet"
            table = pq.read_table(path)
            columns = table.to_pydict()
            columns["name"][0] = "Wrong but same row count"
            pq.write_table(pa.table(columns, schema=table.schema), path)

            with self.assertRaisesRegex(ValueError, "Subject.*content"):
                source_projection.require_projection_matches(
                    dump=dump,
                    mappings=mappings,
                    parquet=parquet,
                )


if __name__ == "__main__":
    unittest.main()
