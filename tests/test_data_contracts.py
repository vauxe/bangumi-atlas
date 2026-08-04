from __future__ import annotations

import gzip
import json
import struct
import tempfile
import unittest
from pathlib import Path

from scripts import site_release as sr
from scripts.content_fingerprint import RowFingerprint
from scripts.site_contracts import (
    read_dump_version,
    validate_layout_report,
    validate_name_pack,
)


class SiteReleaseContractTests(unittest.TestCase):
    def test_entity_key_packs_kind_and_source_id(self) -> None:
        self.assertEqual(sr.entity_key(1, 42), (1 << 24) | 42)
        self.assertEqual(sr.entity_key(3, 0), 3 << 24)

    def test_entity_key_refuses_truncation(self) -> None:
        with self.assertRaisesRegex(ValueError, "24-bit"):
            sr.entity_key(1, 1 << 24)
        with self.assertRaisesRegex(ValueError, "unknown entity kind"):
            sr.entity_key(4, 1)

    def test_gzip_member_is_reproducible(self) -> None:
        first = sr.gzip_member({"b": 2, "a": 1}, 6)
        second = sr.gzip_member({"a": 1, "b": 2}, 6)

        self.assertEqual(first, second)
        self.assertEqual(gzip.decompress(first), b'{"a":1,"b":2}')

    def test_canonical_fact_keeps_text_attributes(self) -> None:
        base = sr.canonical_fact(
            "VOICE_CREDIT",
            ((2 << 24) | 1, (3 << 24) | 2, (1 << 24) | 3),
            (0, ""),
        )
        with_text = sr.canonical_fact(
            "VOICE_CREDIT",
            ((2 << 24) | 1, (3 << 24) | 2, (1 << 24) | 3),
            (0, "备注"),
        )
        # 仅文本不同的两行是两个事实,不能因侧车另存而合并
        self.assertNotEqual(base, with_text)

    def test_canonical_fact_validates_shape(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown fact kind"):
            sr.canonical_fact("EPISODE_OF", (1, 2), ())
        with self.assertRaisesRegex(ValueError, "participant count"):
            sr.canonical_fact("RELATES_TO", ((1 << 24) | 1,), (1, 0))

    def test_incidence_roundtrip_restores_participants(self) -> None:
        participants = ((2 << 24) | 1, (3 << 24) | 2, (1 << 24) | 3)
        for key in participants:
            tup = sr.incidence_tuple(7, 2, key, participants, (0, 1))
            ref, mult, role_bits, others, *attrs = tup
            self.assertEqual((ref, mult, attrs), (7, 2, [0, 1]))
            self.assertEqual(
                sr.participants_from_incidence(
                    "VOICE_CREDIT", key, role_bits, others
                ),
                participants,
            )

    def test_incidence_self_loop_uses_role_bits(self) -> None:
        key = (1 << 24) | 9
        tup = sr.incidence_tuple(1, 1, key, (key, key), (1, 0))
        _ref, _mult, role_bits, others, *_attrs = tup
        self.assertEqual(role_bits, 0b11)
        self.assertEqual(others, [])
        self.assertEqual(
            sr.participants_from_incidence(
                "RELATES_TO", key, role_bits, others
            ),
            (key, key),
        )

    def test_incidence_rejects_non_participants(self) -> None:
        with self.assertRaisesRegex(ValueError, "not a participant"):
            sr.incidence_tuple(
                1, 1, (1 << 24) | 5, ((1 << 24) | 1, (1 << 24) | 2), (1, 0)
            )

    def test_manifest_version_covers_content_not_itself(self) -> None:
        body = {"schema": sr.SCHEMA, "files": {"a.bin": [3, "aaa"]}}
        version = sr.manifest_version(body)
        reordered = sr.manifest_version(
            {"files": {"a.bin": [3, "aaa"]}, "schema": sr.SCHEMA}
        )
        changed = sr.manifest_version(
            {"schema": sr.SCHEMA, "files": {"a.bin": [3, "bbb"]}}
        )

        self.assertEqual(version, reordered)
        self.assertNotEqual(version, changed)
        with self.assertRaisesRegex(ValueError, "must not contain itself"):
            sr.manifest_version({"version": "x"})

    def test_published_object_name_contains_the_complete_file_digest(
        self,
    ) -> None:
        digest = "ab" * 32

        self.assertEqual(
            sr.published_object_name("facts.pack", digest),
            f"{digest}-facts.pack",
        )
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            sr.published_object_name("facts.pack", "ab")
        with self.assertRaisesRegex(ValueError, "top-level"):
            sr.published_object_name("nested/facts.pack", digest)

    def test_member_gate_rejects_every_oversized_gzip_member(self) -> None:
        sr.require_member_size(b"x" * sr.MEMBER_CAP, "boundary")

        with self.assertRaisesRegex(ValueError, "member cap"):
            sr.require_member_size(
                b"x" * (sr.MEMBER_CAP + 1),
                "oversized page",
            )

    def test_gzip_pages_split_deterministically_at_the_member_cap(
        self,
    ) -> None:
        rows = [[i, f"row-{i:04d}-" * 8] for i in range(16)]

        members = sr.gzip_pages(rows, level=6, max_rows=16, cap=100)
        decoded = [
            row
            for member in members
            for row in json.loads(gzip.decompress(member))
        ]

        self.assertGreater(len(members), 1)
        self.assertTrue(all(len(member) <= 100 for member in members))
        self.assertEqual(decoded, rows)

    def test_search_internal_node_is_only_a_bounded_autocomplete_projection(
        self,
    ) -> None:
        self.assertEqual(
            sr.TUPLE_SCHEMAS["search_node"],
            {
                "leaf": ["offset", "length"],
                "internal": ["top_offset", "top_length"],
            },
        )

    def test_field_policy_declares_every_source_field(self) -> None:
        for table, fields in sr.FIELD_POLICY.items():
            for field, policy in fields.items():
                self.assertIn(
                    policy,
                    ("core", "sidecar", "omitted"),
                    f"{table}.{field}",
                )
        # explorer-v1 不省略任何字段
        self.assertNotIn(
            "omitted",
            {p for f in sr.FIELD_POLICY.values() for p in f.values()},
        )


class SiteContractTests(unittest.TestCase):
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
            validate_layout_report({**report, "stub": True}, allow_stub=True)[
                "stub"
            ],
            True,
        )
        with self.assertRaisesRegex(ValueError, "three-dimensional"):
            validate_layout_report({**report, "dimensions": 2})
        with self.assertRaisesRegex(ValueError, "topology-3d"):
            validate_layout_report({**report, "geometry": "free-3d"})

    def test_name_pack_validation_reads_every_published_block(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = sr.gzip_member([["A", None], ["B", "乙"]], 6)
            second = bytearray(sr.gzip_member([["C", "丙"]], 6))
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
            block = sr.gzip_member([["A", None]], 6)
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
            block = sr.gzip_member([["A", None]], 6)
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
            block = sr.gzip_member([["A", None, "unexpected"]], 6)
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
