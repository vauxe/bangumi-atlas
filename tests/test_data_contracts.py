from __future__ import annotations

import gzip
import struct
import tempfile
import unittest
from pathlib import Path

from scripts.content_fingerprint import RowFingerprint
from scripts.site_contracts import (
    artifact_version,
    gzip_json,
    read_dump_version,
    reverse_navigation_label,
    validate_layout_report,
    validate_name_pack,
)


class SiteContractTests(unittest.TestCase):
    def test_reverse_navigation_never_reuses_forward_label(self) -> None:
        self.assertEqual(reverse_navigation_label("单恋"), "← 单恋")
        self.assertEqual(reverse_navigation_label(""), "← 关联")

    def test_gzip_json_is_reproducible(self) -> None:
        first = gzip_json({"b": 2, "a": 1})
        second = gzip_json({"a": 1, "b": 2})

        self.assertEqual(first, second)
        self.assertEqual(gzip.decompress(first), b'{"a":1,"b":2}')

    def test_artifact_version_tracks_content_not_mapping_order(self) -> None:
        first = artifact_version(
            "dump-2026-07-28",
            {"files": {"a.bin": {"sha256": "aaa", "size": 3}}},
        )
        reordered = artifact_version(
            "dump-2026-07-28",
            {"files": {"a.bin": {"size": 3, "sha256": "aaa"}}},
        )
        changed = artifact_version(
            "dump-2026-07-28",
            {"files": {"a.bin": {"sha256": "bbb", "size": 3}}},
        )

        self.assertEqual(first, reordered)
        self.assertNotEqual(first, changed)
        self.assertTrue(first.startswith("dump-2026-07-28-"))

    def test_dump_version_is_required_instead_of_using_build_time(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            version_file = Path(directory) / "VERSION"
            with self.assertRaisesRegex(ValueError, "missing or empty"):
                read_dump_version(version_file)

            version_file.write_text("  \n")
            with self.assertRaisesRegex(ValueError, "missing or empty"):
                read_dump_version(version_file)

            version_file.write_text("dump-2026-07-28\n")
            self.assertEqual(
                read_dump_version(version_file),
                "dump-2026-07-28",
            )

    def test_only_real_three_dimensional_layouts_are_publishable(self) -> None:
        report = {
            "algo": "umap",
            "dimensions": 3,
            "geometry": "topology-3d",
            "stub": False,
        }

        self.assertIs(validate_layout_report(report), report)
        with self.assertRaisesRegex(ValueError, "stub"):
            validate_layout_report({**report, "stub": True})
        self.assertIs(
            validate_layout_report(
                {**report, "stub": True}, allow_stub=True
            )["stub"],
            True,
        )
        with self.assertRaisesRegex(ValueError, "three-dimensional"):
            validate_layout_report({**report, "dimensions": 2})
        with self.assertRaisesRegex(ValueError, "topology-3d"):
            validate_layout_report({**report, "geometry": "free-3d"})

    def test_name_pack_validation_reads_every_published_block(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = gzip_json([["A", None], ["B", "乙"]])
            second = bytearray(gzip_json([["C", "丙"]]))
            second[-1] ^= 0xFF
            pack = first + second
            (root / "names.pack").write_bytes(pack)
            (root / "names.idx").write_bytes(
                struct.pack("<III", 0, len(first), len(pack))
            )

            with self.assertRaisesRegex(ValueError, "names block 1"):
                validate_name_pack(
                    root / "names.pack",
                    root / "names.idx",
                    n_rows=3,
                    block_size=2,
                )

    def test_name_pack_validation_reconciles_pack_with_index(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            block = gzip_json([["A", None]])
            (root / "names.pack").write_bytes(block + b"trailing")
            (root / "names.idx").write_bytes(struct.pack("<II", 0, len(block)))

            with self.assertRaisesRegex(ValueError, "index endpoint"):
                validate_name_pack(
                    root / "names.pack",
                    root / "names.idx",
                    n_rows=1,
                    block_size=2,
                )

    def test_name_pack_validation_reconciles_published_row_count(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            block = gzip_json([["A", None]])
            (root / "names.pack").write_bytes(block)
            (root / "names.idx").write_bytes(struct.pack("<II", 0, len(block)))

            with self.assertRaisesRegex(ValueError, "expected 2 rows"):
                validate_name_pack(
                    root / "names.pack",
                    root / "names.idx",
                    n_rows=2,
                    block_size=2,
                )

    def test_name_pack_validation_enforces_published_row_shape(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            block = gzip_json([["A", None, "unexpected"]])
            (root / "names.pack").write_bytes(block)
            (root / "names.idx").write_bytes(struct.pack("<II", 0, len(block)))

            with self.assertRaisesRegex(ValueError, "invalid row"):
                validate_name_pack(
                    root / "names.pack",
                    root / "names.idx",
                    n_rows=1,
                    block_size=2,
                )


class RowFingerprintTests(unittest.TestCase):
    def test_fingerprint_is_order_independent(self) -> None:
        forward = RowFingerprint()
        reverse = RowFingerprint()
        rows = [[1, "a", {"x": 2}], [2, "b", None]]
        for row in rows:
            forward.add(row)
        for row in reversed(rows):
            reverse.add(row)

        self.assertEqual(forward.snapshot(), reverse.snapshot())

    def test_fingerprint_detects_mutations_and_duplicate_counts(self) -> None:
        original = RowFingerprint()
        original.add([1, ["a", "b"]])

        mutated = RowFingerprint()
        mutated.add([1, ["a", "c"]])

        duplicated = RowFingerprint()
        duplicated.add([1, ["a", "b"]])
        duplicated.add([1, ["a", "b"]])

        self.assertNotEqual(original.snapshot(), mutated.snapshot())
        self.assertNotEqual(original.snapshot(), duplicated.snapshot())


if __name__ == "__main__":
    unittest.main()
