from __future__ import annotations

import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import ladybug as lb
import orjson
import pyarrow.parquet as pq

from scripts import build_db


class SourceSchemaTests(unittest.TestCase):
    def test_unknown_source_field_stops_ingest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory)
            (dump / "subject.jsonlines").write_text(
                '{"id":1,"unexpected":"value"}\n'
            )

            with (
                patch.object(build_db, "DUMP", dump),
                self.assertRaisesRegex(
                    ValueError,
                    "subject.*unexpected",
                ),
            ):
                list(build_db.iter_jsonl("subject"))

    def test_unknown_nested_source_field_stops_ingest(self) -> None:
        cases = (
            ("favorite", {"wish": 1, "rewatch": 2}, "rewatch"),
            ("score_details", {"1": 1, "11": 2}, "11"),
            ("tags", [{"name": "动画", "count": 1, "weight": 2}], "weight"),
        )
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory)
            path = dump / "subject.jsonlines"
            for field, value, unknown in cases:
                with self.subTest(field=field):
                    path.write_bytes(
                        orjson.dumps({"id": 1, field: value}) + b"\n"
                    )
                    with (
                        patch.object(build_db, "DUMP", dump),
                        self.assertRaisesRegex(
                            ValueError,
                            rf"subject\.{field}.*{unknown}",
                        ),
                    ):
                        list(build_db.iter_jsonl("subject"))

    def test_unknown_person_relation_type_stops_ingest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory)
            (dump / "person-relations.jsonlines").write_text(
                '{"person_type":"organization","person_id":1,'
                '"related_person_id":2,"relation_type":3,'
                '"spoiler":false,"ended":false}\n'
            )

            with (
                patch.object(build_db, "DUMP", dump),
                self.assertRaisesRegex(
                    ValueError,
                    "person-relations.person_type.*organization",
                ),
            ):
                list(build_db.iter_jsonl("person-relations"))


class ParquetProjectionTests(unittest.TestCase):
    def test_subject_platform_keeps_source_code_and_decoded_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump = root / "dump"
            parquet = root / "parquet"
            dump.mkdir()
            for name in build_db.EXPECTED_FIELDS:
                (dump / f"{name}.jsonlines").write_bytes(b"")
            (dump / "subject.jsonlines").write_text(
                '{"id":1,"type":1,"platform":1002}\n'
            )
            mappings = (
                {"*": {}},
                {"*": {}},
                {1: {1002: {"type_cn": "小说"}}},
                {},
            )

            with (
                patch.object(build_db, "DUMP", dump),
                patch.object(build_db, "PARQUET", parquet),
                patch.object(build_db, "load_mappings", return_value=mappings),
            ):
                build_db.build_parquet()

            subjects = pq.read_table(
                parquet / "subject.parquet",
                columns=["id", "platform_code", "platform"],
            ).to_pylist()
            self.assertEqual(
                subjects,
                [{"id": 1, "platform_code": 1002, "platform": "小说"}],
            )

            target = root / "bangumi.lb"
            with (
                patch.object(build_db, "PARQUET", parquet),
                redirect_stdout(StringIO()),
            ):
                build_db.replace_database(target, build_db._populate_database)
            database = lb.Database(str(target), read_only=True)
            connection = lb.Connection(database)
            try:
                result = connection.execute(
                    "MATCH (n:Subject {id: 1}) "
                    "RETURN n.platform_code,n.platform"
                )
                self.assertEqual(result.get_next(), [1002, "小说"])
            finally:
                connection.close()
                database.close()


class DatabaseReplacementTests(unittest.TestCase):
    def test_failed_rebuild_preserves_live_database(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "bangumi.lb"
            target.write_text("last known good")

            def fail(staging: Path) -> None:
                staging.write_text("incomplete")
                staging.with_name(f"{staging.name}.wal").write_text("dirty")
                raise RuntimeError("load failed")

            with self.assertRaisesRegex(RuntimeError, "load failed"):
                build_db.replace_database(target, fail)

            self.assertEqual(target.read_text(), "last known good")
            self.assertEqual(
                list(Path(directory).glob(".bangumi.lb.build*")), []
            )

    def test_successful_rebuild_replaces_live_database(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "bangumi.lb"
            target.write_text("old")

            def succeed(staging: Path) -> None:
                staging.write_text("new")

            build_db.replace_database(target, succeed)

            self.assertEqual(target.read_text(), "new")
            self.assertFalse((Path(directory) / ".bangumi.lb.build").exists())


if __name__ == "__main__":
    unittest.main()
