from __future__ import annotations

import gzip
import unittest

from scripts.content_fingerprint import RowFingerprint
from scripts.site_contracts import (
    artifact_version,
    gzip_json,
    reverse_navigation_label,
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
