from __future__ import annotations

import gzip
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import orjson
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from scripts import site_release as sr
from scripts import verify_site


class ParquetStreamingTests(unittest.TestCase):
    def test_iter_parquet_dict_batches_is_bounded_and_projected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rows.parquet"
            pq.write_table(
                pa.table(
                    {
                        "id": list(range(5)),
                        "name": [f"row-{i}" for i in range(5)],
                        "unused": [True] * 5,
                    }
                ),
                path,
            )

            batches = list(
                verify_site.iter_parquet_dict_batches(
                    path, ["id", "name"], batch_size=2
                )
            )

            self.assertEqual(
                [len(batch["id"]) for batch in batches], [2, 2, 1]
            )
            self.assertTrue(
                all(set(batch) == {"id", "name"} for batch in batches)
            )
            self.assertEqual(
                [value for batch in batches for value in batch["id"]],
                list(range(5)),
            )


class ExpectedFactStoreTests(unittest.TestCase):
    def test_external_store_assigns_sorted_refs_and_counts_duplicates(
        self,
    ) -> None:
        first = sr.canonical_fact(
            "RELATES_TO",
            (
                sr.entity_key(sr.KIND_SUBJECT, 1),
                sr.entity_key(sr.KIND_SUBJECT, 2),
            ),
            (3, 0),
        )
        second = sr.canonical_fact(
            "WORKED_ON",
            (
                sr.entity_key(sr.KIND_PERSON, 4),
                sr.entity_key(sr.KIND_SUBJECT, 2),
            ),
            (5, ""),
        )
        with tempfile.TemporaryDirectory() as directory:
            store = verify_site.build_expected_fact_store(
                Path(directory), [[second, first], [first]]
            )
            try:
                self.assertEqual(store.count, 2)
                self.assertEqual(store.source_rows, 3)
                for ref, encoded in enumerate(sorted((first, second))):
                    actual, multiplicity, incidence = store.lookup(ref)
                    parts = orjson.loads(encoded)[1]
                    self.assertEqual(actual, encoded)
                    self.assertEqual(
                        multiplicity, 2 if encoded == first else 1
                    )
                    self.assertEqual(incidence, len(set(parts)))
            finally:
                store.close()


class RoutingContractTests(unittest.TestCase):
    def test_verifier_caps_gzip_output_while_decompressing(self) -> None:
        member = gzip.compress(b"x" * 1_000, compresslevel=9, mtime=0)

        with (
            patch.object(verify_site.sr, "MEMBER_RAW_CAP", 100),
            self.assertRaisesRegex(ValueError, "decoded member cap"),
        ):
            verify_site.decompress_member(member, "test.pack")

    def test_verifier_derives_full_unicode_casefold(self) -> None:
        with patch.object(
            verify_site.sr, "search_charmap", return_value={"A": "wrong"}
        ):
            charmap = verify_site.expected_charmap()

        def fold(text: str) -> str:
            return "".join(charmap.get(char, char) for char in text)

        self.assertEqual(fold("ΤΈΛΟΣ"), fold("Τέλος"))
        self.assertEqual(fold("Progress"), fold("Progreſs"))
        self.assertEqual(fold("STRASSE"), fold("Straße"))
        self.assertEqual(fold("STRAẞE"), fold("Straße"))

    def test_verifier_derives_aliases_without_producer_helper(
        self,
    ) -> None:
        charmap = verify_site.expected_charmap()
        names = [["沪", "", 1]]

        with patch.object(
            verify_site.sr,
            "search_aliases",
            return_value=[("wrong", "wrong")],
        ):
            aliases = verify_site.expected_search_aliases(
                names[0][0], names[0][1], charmap
            )

        self.assertEqual({alias[0] for alias in aliases}, {"沪", "滬"})

    def test_verifier_reuses_derived_alias_rows(self) -> None:
        alias_rows = [[[["hu", "沪"], ["滬", "滬"]], "沪", 1]]

        with patch.object(
            verify_site,
            "expected_search_aliases",
            side_effect=AssertionError("aliases were derived twice"),
        ):
            entries = list(verify_site.iter_alias_entries(alias_rows))

        self.assertEqual(
            entries,
            [["hu", "沪", 0, "沪", 1], ["滬", "滬", 0, "沪", 1]],
        )

    def test_verifier_buckets_grams_without_the_producer_helper(self) -> None:
        with patch.object(
            verify_site.sr, "search_gram_bucket", return_value=0
        ):
            bucket = verify_site.expected_search_gram_bucket("之境")

        self.assertEqual(bucket, 53925)

    def test_search_alias_wire_shape_allows_unsearchable_ranks(self) -> None:
        self.assertTrue(verify_site.search_alias_row_is_valid([[], "　", 1]))
        self.assertTrue(
            verify_site.search_alias_row_is_valid(
                [[["strasse", "Straße"]], "Straße", 1]
            )
        )
        self.assertFalse(
            verify_site.search_alias_row_is_valid(
                [[["", "blank"]], "blank", 1]
            )
        )

    def test_rank_index_layout_is_versioned_and_contiguous(self) -> None:
        index = {
            "encoding": "u24le",
            "sentinel": 0xFFFFFF,
            "segments": {
                "1": {"offset": 0, "count": 2},
                "2": {"offset": 6, "count": 0},
                "3": {"offset": 6, "count": 1},
            },
        }

        self.assertTrue(verify_site.rank_index_layout_is_valid(index, 9))
        index["encoding"] = "u32le"
        self.assertFalse(verify_site.rank_index_layout_is_valid(index, 9))
        index["encoding"] = "u24le"
        index["segments"]["3"]["offset"] = 7
        self.assertFalse(verify_site.rank_index_layout_is_valid(index, 9))

    def test_rank_block_index_requires_exact_coverage(self) -> None:
        self.assertTrue(
            verify_site.rank_block_index_is_valid(
                [0, 10, 20], n_rows=3, block_size=2, pack_size=20
            )
        )
        self.assertFalse(
            verify_site.rank_block_index_is_valid(
                [0, 20], n_rows=3, block_size=2, pack_size=20
            )
        )
        self.assertFalse(
            verify_site.rank_block_index_is_valid(
                [0, 10, 21], n_rows=3, block_size=2, pack_size=20
            )
        )

    def test_geometry_file_sizes_follow_the_node_count(self) -> None:
        sizes = {
            name: 2 * stride
            for name, stride in verify_site.GEOMETRY_STRIDES.items()
        }
        self.assertTrue(verify_site.geometry_sizes_are_valid(sizes, 2))
        sizes["flags.bin"] += 1
        self.assertFalse(verify_site.geometry_sizes_are_valid(sizes, 2))

    def test_range_directory_routes_each_identity_to_its_member(self) -> None:
        ranges = [[1, 3, 0, 10], [7, 9, 10, 10]]
        identities = [[1, 3], [7, 8, 9]]

        self.assertTrue(verify_site.range_routes_are_valid(ranges, identities))
        self.assertFalse(
            verify_site.range_routes_are_valid(
                [[2, 3, 0, 10], [7, 9, 10, 10]], identities
            )
        )
        self.assertFalse(
            verify_site.range_routes_are_valid(
                [[7, 9, 10, 10], [1, 3, 0, 10]],
                [[7, 8, 9], [1, 3]],
            )
        )

    def test_fact_directory_last_key_routes_to_the_same_member(self) -> None:
        index = {
            "buckets": 2,
            "b": [
                [[0, 10, 4], [10, 10, 8]],
                [[20, 10, 5]],
            ],
        }
        keys = [[[2, 4], [6, 8]], [[1, 5]]]

        self.assertTrue(verify_site.fact_routes_are_valid(index, keys, 2))
        index["b"][0][0][2] = 0
        self.assertFalse(verify_site.fact_routes_are_valid(index, keys, 2))

    def test_episode_text_directory_covers_subject_and_episode(self) -> None:
        ranges = [[1, 1, 0, 0, 10, 10, 20], [1, 1, 0, 10, 10, 21, 30]]
        identities = [[(1, 10), (1, 20)], [(1, 21), (1, 30)]]

        self.assertTrue(
            verify_site.episode_text_routes_are_valid(ranges, identities)
        )
        ranges[0][0] = 2
        self.assertFalse(
            verify_site.episode_text_routes_are_valid(ranges, identities)
        )


if __name__ == "__main__":
    unittest.main()
