from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

from scripts import entity_key as ek
from scripts import parquet_provenance as provenance


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
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "source": "https://github.com/bangumi/common",
                "revision": "a" * 40,
                "files": {
                    name: hashlib.sha256(data).hexdigest()
                    for name, data in files.items()
                },
            }
        )
    )


class ParquetGenerationManifestTests(unittest.TestCase):
    def make_generation(
        self, root: Path
    ) -> tuple[
        Path,
        Path,
        Path,
        Path,
        dict[str, int],
        dict[str, tuple[int, str, str]],
    ]:
        dump = root / "dump"
        mappings = root / "mappings"
        parquet = root / "parquet"
        dump.mkdir()
        mappings.mkdir()
        parquet.mkdir()
        (dump / "VERSION").write_text("dump-2026-08-10\n")
        for index, name in enumerate(provenance.JSONL_NAMES):
            (dump / f"{name}.jsonlines").write_text(
                json.dumps({"source": name, "index": index}) + "\n"
            )
        dump_zip = root / "dump.zip"
        with zipfile.ZipFile(
            dump_zip, "w", compression=zipfile.ZIP_DEFLATED
        ) as archive:
            for name in provenance.JSONL_NAMES:
                archive.write(
                    dump / f"{name}.jsonlines",
                    arcname=f"{name}.jsonlines",
                )
        write_mapping_snapshot(mappings)

        stats: dict[str, int] = {}
        for index, (table, stem) in enumerate(
            provenance.PARQUET_TABLES.items()
        ):
            pq.write_table(
                pa.table({"id": pa.array([index], pa.int64())}),
                parquet / f"{stem}.parquet",
            )
            stats[table] = 1
        stats["CHARACTER_REL"] = 0
        pq.write_table(
            pa.table({"id": pa.array([], pa.int64())}),
            parquet / "character_rel.parquet",
        )
        fingerprints = {
            table: (count, "0" * 32, "0" * 32)
            for table, count in stats.items()
        }
        return dump, dump_zip, mappings, parquet, stats, fingerprints

    def test_manifest_binds_every_input_and_output_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dump, dump_zip, mappings, parquet, stats, fingerprints = (
                self.make_generation(Path(directory))
            )

            published = provenance.publish_generation(
                dump=dump,
                dump_zip=dump_zip,
                mappings=mappings,
                parquet=parquet,
                projected_rows=stats,
                projection_fingerprints=fingerprints,
            )
            validated = provenance.require_valid_generation(
                dump=dump,
                dump_zip=dump_zip,
                mappings=mappings,
                parquet=parquet,
            )

            self.assertEqual(validated, published)
            self.assertEqual(published["format"], "parquet-generation-v1")
            self.assertEqual(
                validated["source"]["jsonl"]["subject.jsonlines"]["rows"],
                1,
            )
            self.assertEqual(validated["rows"]["projected"], stats)
            self.assertEqual(
                validated["semantic"]["raw_projection"],
                {table: list(value) for table, value in fingerprints.items()},
            )
            self.assertEqual(
                set(validated["parquet"]),
                {
                    f"{stem}.parquet"
                    for stem in provenance.PARQUET_TABLES.values()
                },
            )
            self.assertNotIn("archive_members", validated["source"])

            source = dump / "subject.jsonlines"
            original = source.read_bytes()
            source.write_bytes(original + b"{}\n")
            self.assertEqual(
                provenance.require_valid_generation(
                    dump=dump,
                    dump_zip=dump_zip,
                    mappings=mappings,
                    parquet=parquet,
                )["version"],
                published["version"],
            )
            source.write_bytes(original)

            table = parquet / "subject.parquet"
            table.write_bytes(table.read_bytes() + b"tampered")
            with self.assertRaisesRegex(ValueError, "subject.parquet.*digest"):
                provenance.require_valid_generation(
                    dump=dump,
                    dump_zip=dump_zip,
                    mappings=mappings,
                    parquet=parquet,
                )

    def test_same_version_different_archive_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dump, dump_zip, mappings, parquet, stats, fingerprints = (
                self.make_generation(Path(directory))
            )
            provenance.publish_generation(
                dump=dump,
                dump_zip=dump_zip,
                mappings=mappings,
                parquet=parquet,
                projected_rows=stats,
                projection_fingerprints=fingerprints,
            )

            dump_zip.write_bytes(b"different archive, same VERSION")

            with self.assertRaisesRegex(ValueError, "dump.zip.*digest"):
                provenance.require_valid_generation(
                    dump=dump,
                    dump_zip=dump_zip,
                    mappings=mappings,
                    parquet=parquet,
                )

    def test_publish_rejects_jsonl_that_did_not_come_from_archive(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dump, dump_zip, mappings, parquet, stats, fingerprints = (
                self.make_generation(Path(directory))
            )
            (dump / "subject.jsonlines").write_text(
                json.dumps({"source": "different", "index": 0}) + "\n"
            )

            with self.assertRaisesRegex(ValueError, "does not match dump.zip"):
                provenance.publish_generation(
                    dump=dump,
                    dump_zip=dump_zip,
                    mappings=mappings,
                    parquet=parquet,
                    projected_rows=stats,
                    projection_fingerprints=fingerprints,
                )

    def test_publish_rejects_extra_archive_member(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dump, dump_zip, mappings, parquet, stats, fingerprints = (
                self.make_generation(Path(directory))
            )
            with zipfile.ZipFile(
                dump_zip, "a", compression=zipfile.ZIP_DEFLATED
            ) as archive:
                archive.writestr("new-upstream-table.jsonlines", b"{}\n")

            with self.assertRaisesRegex(ValueError, "archive JSONL set"):
                provenance.publish_generation(
                    dump=dump,
                    dump_zip=dump_zip,
                    mappings=mappings,
                    parquet=parquet,
                    projected_rows=stats,
                    projection_fingerprints=fingerprints,
                )

    def test_changed_semantic_oracle_invalidates_the_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump, dump_zip, mappings, parquet, stats, fingerprints = (
                self.make_generation(root)
            )
            oracle = root / "source_projection.py"
            oracle.write_text("oracle-v1\n")
            with patch.object(
                provenance,
                "PROJECTION_ORACLE_PATH",
                oracle,
                create=True,
            ):
                provenance.publish_generation(
                    dump=dump,
                    dump_zip=dump_zip,
                    mappings=mappings,
                    parquet=parquet,
                    projected_rows=stats,
                    projection_fingerprints=fingerprints,
                )
                oracle.write_text("oracle-changed\n")
                with self.assertRaisesRegex(ValueError, "semantic oracle"):
                    provenance.require_valid_generation(
                        dump=dump,
                        dump_zip=dump_zip,
                        mappings=mappings,
                        parquet=parquet,
                    )

    def test_changed_oracle_dependency_invalidates_the_generation(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump, dump_zip, mappings, parquet, stats, fingerprints = (
                self.make_generation(root)
            )
            helper = root / "content_fingerprint.py"
            helper.write_text("fingerprint-v1\n")
            with patch.object(
                provenance,
                "PROJECTION_ORACLE_DEPENDENCIES",
                {"content_fingerprint.py": helper},
                create=True,
            ):
                provenance.publish_generation(
                    dump=dump,
                    dump_zip=dump_zip,
                    mappings=mappings,
                    parquet=parquet,
                    projected_rows=stats,
                    projection_fingerprints=fingerprints,
                )
                helper.write_text("fingerprint-changed\n")
                with self.assertRaisesRegex(ValueError, "semantic oracle"):
                    provenance.require_valid_generation(
                        dump=dump,
                        dump_zip=dump_zip,
                        mappings=mappings,
                        parquet=parquet,
                    )

    def test_oracle_identity_includes_entity_key_implementation(self) -> None:
        self.assertIn(
            "entity_key.py",
            provenance.PROJECTION_ORACLE_DEPENDENCIES,
        )

    def test_changed_entity_key_contract_invalidates_the_generation(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dump, dump_zip, mappings, parquet, stats, fingerprints = (
                self.make_generation(Path(directory))
            )
            provenance.publish_generation(
                dump=dump,
                dump_zip=dump_zip,
                mappings=mappings,
                parquet=parquet,
                projected_rows=stats,
                projection_fingerprints=fingerprints,
            )

            with (
                patch.object(ek, "ENTITY_KEY_FORMAT", "entity-key-changed"),
                self.assertRaisesRegex(ValueError, "semantic oracle"),
            ):
                provenance.require_valid_generation(
                    dump=dump,
                    dump_zip=dump_zip,
                    mappings=mappings,
                    parquet=parquet,
                )

    def test_incomplete_marker_always_blocks_consumers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dump, dump_zip, mappings, parquet, stats, fingerprints = (
                self.make_generation(Path(directory))
            )
            provenance.publish_generation(
                dump=dump,
                dump_zip=dump_zip,
                mappings=mappings,
                parquet=parquet,
                projected_rows=stats,
                projection_fingerprints=fingerprints,
            )
            (parquet / provenance.PARQUET_BUILD_MARKER).write_text(
                "incomplete\n"
            )

            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                provenance.require_valid_generation(
                    dump=dump,
                    dump_zip=dump_zip,
                    mappings=mappings,
                    parquet=parquet,
                )

    def test_publish_rejects_an_unmodelled_jsonl_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dump, dump_zip, mappings, parquet, stats, fingerprints = (
                self.make_generation(Path(directory))
            )
            (dump / "new-upstream-table.jsonlines").write_text("{}\n")

            with self.assertRaisesRegex(ValueError, "unexpected JSONL"):
                provenance.publish_generation(
                    dump=dump,
                    dump_zip=dump_zip,
                    mappings=mappings,
                    parquet=parquet,
                    projected_rows=stats,
                    projection_fingerprints=fingerprints,
                )


if __name__ == "__main__":
    unittest.main()
