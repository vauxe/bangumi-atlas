from __future__ import annotations

import gzip
import hashlib
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import numpy as np
import orjson
import pyarrow as pa
import pyarrow.parquet as pq

from scripts import site_release as sr
from scripts import verify_site


class InputGenerationTests(unittest.TestCase):
    def test_main_holds_generation_lock_for_validation_and_verify(
        self,
    ) -> None:
        events: list[str] = []

        @contextmanager
        def lock(_parquet: Path):
            events.append("lock-enter")
            try:
                yield
            finally:
                events.append("lock-exit")

        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "site"
            with (
                patch.object(verify_site, "parquet_layout_lock", lock),
                patch.object(
                    verify_site,
                    "require_current_release_inputs",
                    side_effect=lambda **_kwargs: (
                        events.append("validate")
                        or {"parquet_generation": "v1"}
                    ),
                ),
                patch.object(
                    verify_site,
                    "verify_release",
                    side_effect=lambda _site, _identity: events.append(
                        "verify"
                    ),
                ),
                patch("sys.argv", ["verify_site.py", "--site", str(site)]),
            ):
                verify_site.main()

        self.assertEqual(
            events, ["lock-enter", "validate", "verify", "lock-exit"]
        )


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


class ArtifactPathSafetyTests(unittest.TestCase):
    def test_site_data_directory_cannot_be_a_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            site = root / "site"
            outside = root / "outside"
            site.mkdir()
            outside.mkdir()
            (site / "data").symlink_to(outside, target_is_directory=True)

            with self.assertRaisesRegex(ValueError, "site/data.*symlink"):
                verify_site.validated_site_data_root(site)

    def test_manifest_physical_name_cannot_escape_site_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            site = root / "site" / "data"
            site.mkdir(parents=True)
            payload = b"outside"
            digest = sr.sha256_hex(payload)
            outside = root / "outside.bin"
            outside.write_bytes(payload)
            files = {"safe.bin": [len(payload), digest, "../../outside.bin"]}

            with (
                patch.object(verify_site, "SITE", site),
                patch.object(verify_site, "artifact_files", files),
                self.assertRaisesRegex(ValueError, "physical name"),
            ):
                verify_site.site_file("safe.bin")

    def test_content_addressed_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            site = root / "site" / "data"
            site.mkdir(parents=True)
            payload = b"outside"
            digest = sr.sha256_hex(payload)
            physical = sr.published_object_name("safe.bin", digest)
            outside = root / "outside.bin"
            outside.write_bytes(payload)
            (site / physical).symlink_to(outside)
            files = {"safe.bin": [len(payload), digest, physical]}

            with (
                patch.object(verify_site, "SITE", site),
                patch.object(verify_site, "artifact_files", files),
                self.assertRaisesRegex(ValueError, "symlink"),
            ):
                verify_site.site_file("safe.bin")


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

    def test_fact_summary_expectation_preserves_fact_and_source_identities(
        self,
    ) -> None:
        person = sr.entity_key(sr.KIND_PERSON, 1)
        character = sr.entity_key(sr.KIND_CHARACTER, 2)
        subject = sr.entity_key(sr.KIND_SUBJECT, 3)
        text = "重复配音说明"
        voiced = sr.canonical_fact(
            "VOICE_CREDIT",
            (person, character, subject),
            (4, text),
        )
        empty = sr.canonical_fact(
            "VOICE_CREDIT",
            (person, character, subject),
            (1, ""),
        )
        unrelated = sr.canonical_fact(
            "WORKED_ON",
            (person, subject),
            (5, ""),
        )

        class OneShotFacts:
            def __init__(self) -> None:
                self._iterated = False

            def __iter__(self):
                if self._iterated:
                    raise AssertionError("facts were traversed more than once")
                self._iterated = True
                return iter([(0, voiced, 2), (1, empty, 3), (2, unrelated, 4)])

        anchors_match, summaries, stats = verify_site.expected_fact_metadata(
            OneShotFacts(),
            np.asarray([person, person, person], dtype=np.uint32),
        )

        self.assertTrue(anchors_match)
        self.assertEqual(summaries, {0: text})
        self.assertEqual(
            stats,
            {
                "non_empty": 2,
                "empty": 3,
                "raw_bytes": len(text.encode()) * 2,
            },
        )


class RoutingContractTests(unittest.TestCase):
    def test_text_posting_decoder_rejects_noncanonical_values(self) -> None:
        self.assertEqual(
            verify_site.decode_delta_posting(
                bytes([0, 1, 126, 1, 128, 124]), 5, 20_000
            ),
            [0, 1, 127, 128, 16_000],
        )
        for malformed in (bytes([128]), bytes([129, 0])):
            with (
                self.subTest(malformed=malformed),
                self.assertRaises(ValueError),
            ):
                verify_site.decode_delta_posting(malformed, 1, 10)

    def test_text_posting_verifier_checks_trigram_members_independently(
        self,
    ) -> None:
        global_bucket = verify_site.expected_search_gram_bucket(
            "时间旅", width=3
        )
        shard = global_bucket % sr.TEXT_SEARCH_POSTING_SHARDS
        bucket = global_bucket // sr.TEXT_SEARCH_POSTING_SHARDS
        bucket_count = sr.SEARCH_NGRAM_BUCKETS // sr.TEXT_SEARCH_POSTING_SHARDS
        posting = gzip.compress(bytes([0, 2]), mtime=0)
        bucket_members = np.zeros(bucket_count + 1, dtype="<u4")
        bucket_members[bucket + 1 :] = 1
        offsets = np.asarray([0, len(posting)], dtype="<u4")
        counts = np.zeros(bucket_count, dtype="<u4")
        counts[bucket] = 2
        index = b"".join(
            (
                bucket_members.tobytes(),
                offsets.tobytes(),
                np.asarray([0], dtype="<u4").tobytes(),
                np.asarray([2], dtype="<u4").tobytes(),
                counts.tobytes(),
            )
        )
        expected_hash = hashlib.sha256()
        expected_hash.update((0).to_bytes(3, "little"))
        expected_hash.update((2).to_bytes(3, "little"))
        expected_hashes = [None] * bucket_count
        expected_hashes[bucket] = expected_hash

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stem = f"text.search.trigram-{shard}"
            (root / f"{stem}.idx").write_bytes(index)
            (root / f"{stem}.pack").write_bytes(posting)
            with patch.object(
                verify_site,
                "site_file",
                side_effect=lambda name: root / name,
            ):
                self.assertTrue(
                    verify_site.text_search_postings_are_valid(
                        stem,
                        counts,
                        expected_hashes,
                        3,
                        bucket_count=bucket_count,
                    )
                )
                counts[bucket] = 1
                self.assertFalse(
                    verify_site.text_search_postings_are_valid(
                        stem,
                        counts,
                        expected_hashes,
                        3,
                        bucket_count=bucket_count,
                    )
                )

    def test_binary_array_loader_rejects_trailing_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "index.bin"
            path.write_bytes(b"\x01\x00\x00\x00x")
            with (
                patch.object(verify_site, "site_file", return_value=path),
                self.assertRaisesRegex(ValueError, "u32 array"),
            ):
                verify_site.load_array("index.bin", "<u4")

    def test_fact_keys_use_the_browser_decimal_spelling(self) -> None:
        self.assertEqual(
            verify_site.canonical_entity_key("16777217"), 16777217
        )
        for value in ("016777217", "+16777217", " 16777217", "-1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                verify_site.canonical_entity_key(value)

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
            trigram_bucket = verify_site.expected_search_gram_bucket(
                "时间旅", width=3
            )

        self.assertEqual(bucket, 53925)
        self.assertEqual(trigram_bucket, 51211)

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

    def test_position_encoding_requires_finite_affine_u16(self) -> None:
        encoding = {
            "encoding": "u16le-affine-3d-v1",
            "components": 3,
            "offset": [-10.0, 2.0, 4.0],
            "scale": [0.1, 0.0, 0.2],
        }
        self.assertTrue(verify_site.position_encoding_is_valid(encoding))
        self.assertFalse(
            verify_site.position_encoding_is_valid(
                {**encoding, "encoding": "float32"}
            )
        )
        self.assertFalse(
            verify_site.position_encoding_is_valid(
                {**encoding, "scale": [0.1, -0.1, 0.2]}
            )
        )
        self.assertFalse(
            verify_site.position_encoding_is_valid(
                {**encoding, "offset": [-10.0, float("inf"), 4.0]}
            )
        )

    def test_position_quantization_rejects_a_rank_swap(self) -> None:
        expected = np.array([[-10.0, 2.0, 4.0], [10.0, 6.0, 4.0]], dtype="<f4")
        decoded = np.array([[-9.9, 2.1, 4.0], [9.9, 5.9, 4.0]], dtype="<f4")
        encoding = {
            "encoding": "u16le-affine-3d-v1",
            "components": 3,
            "offset": [-10.0, 2.0, 4.0],
            "scale": [0.25, 0.5, 0.0],
        }

        aligned_error = verify_site.maximum_position_displacement(
            expected, decoded
        )
        swapped_error = verify_site.maximum_position_displacement(
            expected, decoded[::-1]
        )
        bound = verify_site.position_quantization_error_bound(encoding)

        self.assertLessEqual(aligned_error, bound)
        self.assertGreater(swapped_error, bound)
        self.assertTrue(
            verify_site.position_quantization_report_is_valid(
                {
                    "encoding": "u16le-affine-3d-v1",
                    "max_displacement": aligned_error,
                },
                actual_max_displacement=aligned_error,
            )
        )
        self.assertFalse(
            verify_site.position_quantization_report_is_valid(
                {
                    "encoding": "u16le-affine-3d-v1",
                    "max_displacement": swapped_error,
                },
                actual_max_displacement=aligned_error,
            )
        )

    def test_position_quantization_bound_includes_float32_rounding(
        self,
    ) -> None:
        encoding = {
            "encoding": "u16le-affine-3d-v1",
            "components": 3,
            "offset": [-300.0, -300.0, -300.0],
            "scale": [600.0 / 65_535] * 3,
        }

        naive_rounding_bound = float(
            np.linalg.norm(np.asarray(encoding["scale"])) / 2
        )
        rigorous_bound = verify_site.position_quantization_error_bound(
            encoding
        )

        self.assertGreater(rigorous_bound, naive_rounding_bound + 1e-5)

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

    def test_range_directory_rejects_noncanonical_wire_rows(self) -> None:
        self.assertTrue(
            verify_site.range_routes_are_valid(
                [[1, 3, 0, 0, 10]],
                [[1, 3]],
                row_length=5,
                file_count=1,
            )
        )
        for ranges, identities in (
            ([[1, 3, -1, 0, 10]], [[1, 3]]),
            ([[1, 3, 1, 0, 10]], [[1, 3]]),
            ([[1, 3, 0, 0, 10, 11]], [[1, 3]]),
            ([[1, 3, 0, 0, 10]], [[1, 1, 3]]),
            ([[1, 3, 0, 0, 10]], [[True, 3]]),
        ):
            with self.subTest(ranges=ranges, identities=identities):
                self.assertFalse(
                    verify_site.range_routes_are_valid(
                        ranges,
                        identities,
                        row_length=5,
                        file_count=1,
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
            verify_site.episode_text_routes_are_valid(
                ranges, identities, file_count=1
            )
        )
        ranges[0][0] = 2
        self.assertFalse(
            verify_site.episode_text_routes_are_valid(
                ranges, identities, file_count=1
            )
        )

    def test_episode_text_directory_rejects_duplicate_or_invalid_ids(
        self,
    ) -> None:
        ranges = [[1, 1, 0, 0, 10, 10, 20]]
        self.assertFalse(
            verify_site.episode_text_routes_are_valid(
                ranges, [[(1, 10), (1, 10)]], file_count=1
            )
        )
        ranges[0][2] = -1
        self.assertFalse(
            verify_site.episode_text_routes_are_valid(
                ranges, [[(1, 10), (1, 20)]], file_count=1
            )
        )

    def test_incidence_masks_require_each_unique_participant_once(
        self,
    ) -> None:
        subject = sr.entity_key(sr.KIND_SUBJECT, 1)
        person = sr.entity_key(sr.KIND_PERSON, 2)
        participants = (person, subject)
        seen = np.zeros(1, dtype=np.uint8)

        self.assertTrue(
            verify_site.record_fact_participant(seen, 0, person, participants)
        )
        self.assertFalse(
            verify_site.record_fact_participant(seen, 0, person, participants)
        )
        np.testing.assert_array_equal(seen, [1])
        self.assertTrue(
            verify_site.record_fact_participant(seen, 0, subject, participants)
        )
        np.testing.assert_array_equal(seen, [3])

    def test_voice_incidence_requires_exact_shape_and_presence_bit(
        self,
    ) -> None:
        valid = [0, 1, 1, [2, 3], 4, 1]
        self.assertTrue(
            verify_site.incidence_tuple_is_valid("VOICE_CREDIT", valid)
        )
        self.assertFalse(
            verify_site.incidence_tuple_is_valid(
                "VOICE_CREDIT", [*valid, "ignored"]
            )
        )
        invalid_presence = [*valid]
        invalid_presence[-1] = 2
        self.assertFalse(
            verify_site.incidence_tuple_is_valid(
                "VOICE_CREDIT", invalid_presence
            )
        )

    def test_layout_projection_is_rank_aligned_and_value_exact(self) -> None:
        projection = verify_site.expected_layout_projection(
            {
                "key": np.array([10, 20, 30], dtype=np.uint32),
                "collect": np.array([0, 7, 3], dtype=np.int64),
                "year": np.array([2000, 2001, 2002], dtype=np.uint16),
                "isolated": np.array([False, True, False]),
                "x": np.array([0.0, 1.0, 2.0], dtype=np.float32),
                "y": np.zeros(3, dtype=np.float32),
                "z": np.zeros(3, dtype=np.float32),
            }
        )

        np.testing.assert_array_equal(projection["key"], [20, 30, 10])
        np.testing.assert_array_equal(projection["year"], [2001, 2002, 2000])
        np.testing.assert_array_equal(
            projection["size"],
            np.round(18 * np.log2(1 + np.array([7, 3, 0]))).astype(np.uint8),
        )
        np.testing.assert_array_equal(projection["isolated"], [1, 0, 0])
        np.testing.assert_allclose(
            projection["position"][:, 0], [300.0, 600.0, 0.0], atol=0.2
        )
        self.assertEqual(
            verify_site.expected_year_range(
                np.array([0, 701, 1900, 2035, 9000], dtype=np.uint16)
            ),
            [1900, 2035],
        )

    def test_edges_require_declared_count_and_valid_endpoints(self) -> None:
        edges = np.array([0, 2, 1, 2], dtype=np.uint32)
        self.assertTrue(
            verify_site.edge_array_is_valid(edges, n_nodes=3, n_edges=2)
        )
        self.assertFalse(
            verify_site.edge_array_is_valid(edges, n_nodes=3, n_edges=1)
        )
        edges[-1] = 3
        self.assertFalse(
            verify_site.edge_array_is_valid(edges, n_nodes=3, n_edges=2)
        )


if __name__ == "__main__":
    unittest.main()
