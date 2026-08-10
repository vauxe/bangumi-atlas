from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from contextlib import contextmanager, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import ladybug as lb
import orjson
import pyarrow as pa
import pyarrow.parquet as pq

from scripts import build_db, site_release


def write_mapping_snapshot(directory: Path) -> None:
    files = {
        "subject_relations.yml": b"relations: {}\n",
        "subject_staffs.yml": b"staffs: {}\n",
        "subject_platforms.yml": b"platforms: {}\n",
        "person_relations.yml": (
            b"relations:\n  prsn: {}\n  prsn_cv: {}\n  crt: {}\n"
        ),
    }
    for name, data in files.items():
        (directory / name).write_bytes(data)
    manifest = {
        "schema_version": 1,
        "source": "https://github.com/bangumi/common",
        "revision": "a" * 40,
        "files": {
            name: hashlib.sha256(data).hexdigest()
            for name, data in files.items()
        },
    }
    (directory / "manifest.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )


class MappingSnapshotTests(unittest.TestCase):
    def test_snapshot_digest_detects_stale_or_mixed_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            mappings = Path(directory)
            write_mapping_snapshot(mappings)

            with patch.object(build_db, "MAPPINGS", mappings):
                revision = build_db.validate_mapping_snapshot()
                self.assertEqual(revision, "a" * 40)
                (mappings / "subject_staffs.yml").write_text(
                    "staffs: {1: {}}\n"
                )
                with self.assertRaisesRegex(
                    ValueError, "subject_staffs.yml.*digest mismatch"
                ):
                    build_db.validate_mapping_snapshot()


class SourceSchemaTests(unittest.TestCase):
    def test_source_projection_uses_the_published_field_policy(self) -> None:
        self.assertEqual(
            build_db.EXPECTED_FIELDS,
            {
                name: set(fields)
                for name, fields in site_release.FIELD_POLICY.items()
            },
        )

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
    def test_interrupted_generation_leaves_blocking_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet = Path(directory) / "parquet"
            with (
                patch.object(build_db, "PARQUET", parquet),
                patch.object(
                    build_db,
                    "_build_parquet_unlocked",
                    side_effect=RuntimeError("interrupted"),
                ),
                self.assertRaisesRegex(RuntimeError, "interrupted"),
            ):
                build_db.build_parquet()

            self.assertTrue(
                (parquet / build_db.PARQUET_BUILD_MARKER).is_file()
            )

    def test_failed_generation_finalizer_leaves_blocking_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet = Path(directory) / "parquet"

            def reject(_stats: dict[str, int]) -> None:
                raise RuntimeError("semantic publication rejected")

            with (
                patch.object(
                    build_db,
                    "_build_parquet_unlocked",
                    return_value={"Subject": 1},
                ),
                patch.object(build_db, "PARQUET", parquet),
                patch.object(
                    build_db,
                    "finalize_parquet_generation",
                    side_effect=reject,
                ),
                self.assertRaisesRegex(RuntimeError, "publication rejected"),
            ):
                build_db.build_parquet()

            self.assertTrue(
                (parquet / build_db.PARQUET_BUILD_MARKER).is_file()
            )

    def test_hot_loop_matches_previous_writer_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "reference"
            candidate = root / "candidate"
            reference.mkdir()
            candidate.mkdir()
            schema = pa.schema(
                [
                    ("id", pa.int64()),
                    ("name", pa.string()),
                    ("tags", pa.list_(pa.string())),
                ]
            )
            rows = [
                (index, f"row-{index}", [str(index), "tag"])
                for index in range(7)
            ]

            columns = {field.name: [] for field in schema}
            writer = pq.ParquetWriter(reference / "rows.parquet", schema)
            for row in rows:
                for field, value in zip(schema, row, strict=True):
                    columns[field.name].append(value)
                if len(columns["id"]) == 3:
                    writer.write_table(pa.table(columns, schema=schema))
                    for column in columns.values():
                        column.clear()
            if columns["id"]:
                writer.write_table(pa.table(columns, schema=schema))
            writer.close()

            with patch.object(build_db, "PARQUET", candidate):
                build_db.write_parquet_rows(
                    "rows", schema, iter(rows), batch_rows=3
                )

            self.assertEqual(
                (candidate / "rows.parquet").read_bytes(),
                (reference / "rows.parquet").read_bytes(),
            )

    def test_streaming_writer_flushes_bounded_row_groups(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet = Path(directory)
            schema = pa.schema([("id", pa.int64()), ("name", pa.string())])

            with patch.object(build_db, "PARQUET", parquet):
                count = build_db.write_parquet_rows(
                    "streamed",
                    schema,
                    ((index, f"row-{index}") for index in range(5)),
                    batch_rows=2,
                )

            file = pq.ParquetFile(parquet / "streamed.parquet")
            self.assertEqual(count, 5)
            self.assertEqual(file.metadata.num_row_groups, 3)
            self.assertEqual(
                file.read().to_pylist(),
                [{"id": index, "name": f"row-{index}"} for index in range(5)],
            )

    def test_streaming_writer_preserves_schema_for_empty_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet = Path(directory)
            schema = pa.schema(
                [("id", pa.int64()), ("tags", pa.list_(pa.string()))]
            )

            with patch.object(build_db, "PARQUET", parquet):
                count = build_db.write_parquet_rows(
                    "empty",
                    schema,
                    iter(()),
                    batch_rows=2,
                )

            table = pq.read_table(parquet / "empty.parquet")
            self.assertEqual(count, 0)
            self.assertEqual(table.schema, schema)
            self.assertEqual(table.to_pylist(), [])

    def test_streaming_writer_failure_preserves_published_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet = Path(directory)
            target = parquet / "stable.parquet"
            target.write_bytes(b"last-known-good")
            schema = pa.schema([("id", pa.int64())])

            def interrupted_rows():
                yield (1,)
                raise RuntimeError("interrupted")

            with (
                patch.object(build_db, "PARQUET", parquet),
                self.assertRaisesRegex(RuntimeError, "interrupted"),
            ):
                build_db.write_parquet_rows(
                    "stable", schema, interrupted_rows(), batch_rows=2
                )

            self.assertEqual(target.read_bytes(), b"last-known-good")
            self.assertFalse((parquet / ".stable.parquet.build").exists())

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
                {},
            )

            with (
                patch.object(build_db, "DUMP", dump),
                patch.object(build_db, "PARQUET", parquet),
                patch.object(build_db, "load_mappings", return_value=mappings),
                patch.object(
                    build_db,
                    "finalize_parquet_generation",
                    return_value=None,
                ),
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

    def test_all_raw_enum_fields_report_values_outside_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump = root / "dump"
            parquet = root / "parquet"
            dump.mkdir()
            for name in build_db.EXPECTED_FIELDS:
                (dump / f"{name}.jsonlines").write_bytes(b"")
            (dump / "subject.jsonlines").write_text('{"id":1,"type":1}\n')
            (dump / "person.jsonlines").write_text(
                '{"id":2,"name":"legacy","type":0}\n'
            )
            (dump / "character.jsonlines").write_text(
                '{"id":3,"name":"unknown","role":7}\n'
            )
            (dump / "episode.jsonlines").write_text(
                '{"id":4,"subject_id":1,"type":7}\n'
            )
            (dump / "person-characters.jsonlines").write_text(
                '{"person_id":2,"subject_id":1,"character_id":3,"type":7}\n'
            )
            mappings = (
                {"*": {}},
                {"*": {}},
                {},
                {},
                {code: {"cn": str(code)} for code in range(7)},
            )

            with (
                patch.object(build_db, "DUMP", dump),
                patch.object(build_db, "PARQUET", parquet),
                patch.object(build_db, "load_mappings", return_value=mappings),
                patch.object(
                    build_db,
                    "finalize_parquet_generation",
                    return_value=None,
                ),
            ):
                build_db.build_parquet()
                first = build_db.unknown_codes.copy()
                build_db.build_parquet()
                second = build_db.unknown_codes.copy()

            expected = {
                ("Person.type", "*", 0): 1,
                ("Character.role", "*", 7): 1,
                ("Episode.type", "*", 7): 1,
                ("VOICED.type", "prsn_cv", 7): 1,
            }
            self.assertEqual(dict(first), expected)
            self.assertEqual(dict(second), expected)


class EnumAnomalyGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_codes = build_db.unknown_codes.copy()
        build_db.unknown_codes.clear()

    def tearDown(self) -> None:
        build_db.unknown_codes.clear()
        build_db.unknown_codes.update(self.previous_codes)

    def test_exact_historical_baseline_is_accepted(self) -> None:
        build_db.unknown_codes.update(
            {
                ("Person.type", "*", 0): 1,
                ("RELATES_TO", 4, 4013): 6,
            }
        )

        with redirect_stdout(StringIO()):
            build_db.report_unknown_codes()

    def test_new_or_growing_anomaly_stops_the_build(self) -> None:
        cases = (
            {("Character.role", "*", 7): 1},
            {("Person.type", "*", 0): 2},
        )
        for codes in cases:
            with self.subTest(codes=codes):
                build_db.unknown_codes.clear()
                build_db.unknown_codes.update(codes)
                with (
                    redirect_stdout(StringIO()),
                    self.assertRaisesRegex(
                        RuntimeError, "enum anomaly baseline exceeded"
                    ),
                ):
                    build_db.report_unknown_codes()

    def test_generation_is_semantically_verified_before_manifest(self) -> None:
        stats = {"Subject": 1}
        fingerprints = {"Subject": (1, "a" * 32, "b" * 32)}
        with (
            patch.object(build_db, "report_unknown_codes") as enum_gate,
            patch.object(
                build_db.source_projection,
                "require_projection_matches",
                return_value=fingerprints,
            ) as semantic_gate,
            patch.object(
                build_db.parquet_provenance, "publish_generation"
            ) as publish,
        ):
            build_db.finalize_parquet_generation(stats)

        enum_gate.assert_called_once_with()
        semantic_gate.assert_called_once_with(
            dump=build_db.DUMP,
            mappings=build_db.MAPPINGS,
            parquet=build_db.PARQUET,
        )
        self.assertEqual(
            publish.call_args.kwargs["projection_fingerprints"],
            fingerprints,
        )


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


class PipelineGenerationLockTests(unittest.TestCase):
    def test_main_holds_one_lock_through_projection_and_database(self) -> None:
        events: list[str] = []

        @contextmanager
        def lock(_parquet: Path):
            events.append("lock-enter")
            try:
                yield
            finally:
                events.append("lock-exit")

        with (
            patch.object(build_db, "parquet_layout_lock", lock),
            patch.object(
                build_db,
                "fetch_mappings",
                side_effect=lambda: events.append("mappings") or "revision",
            ),
            patch.object(
                build_db,
                "_build_parquet_locked",
                side_effect=lambda: events.append("parquet") or {},
            ),
            patch.object(
                build_db,
                "build_db",
                side_effect=lambda: events.append("database"),
            ),
            patch("sys.argv", ["build_db.py"]),
        ):
            build_db.main()

        self.assertEqual(
            events,
            [
                "lock-enter",
                "mappings",
                "parquet",
                "database",
                "lock-exit",
            ],
        )


if __name__ == "__main__":
    unittest.main()
