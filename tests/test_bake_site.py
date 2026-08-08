from __future__ import annotations

import gzip
import random
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from scripts import bake_site


class EntityEncodingTests(unittest.TestCase):
    def test_subject_zero_score_and_rank_are_encoded_as_absent(self) -> None:
        row = bake_site.subject_entity_row(
            {
                "name": ["未评分条目"],
                "name_cn": [""],
                "type": [2],
                "platform_code": [0],
                "platform": ["Web"],
                "date": [""],
                "score": [0.0],
                "rank": [0],
                "nsfw": [False],
                "wish": [0],
                "done": [0],
                "doing": [0],
                "on_hold": [0],
                "dropped": [0],
                "series": [False],
                "score_details": [[0] * 10],
                "meta_tags": [[]],
                "tags": [[]],
            },
            0,
            0,
            text_bits={
                "summary": bake_site.np.array([False]),
                "infobox": bake_site.np.array([False]),
            },
            meta_id={},
            tag_id={},
        )

        self.assertEqual(row[3], 0)  # platform 0 is a real mapped category
        self.assertIsNone(row[5])
        self.assertIsNone(row[6])

    def test_subject_empty_platform_is_encoded_as_absent(self) -> None:
        row = bake_site.subject_entity_row(
            {
                "name": ["未指定平台"],
                "name_cn": [""],
                "type": [3],
                "platform_code": [0],
                "platform": [""],
                "date": [""],
                "score": [0.0],
                "rank": [0],
                "nsfw": [False],
                "wish": [0],
                "done": [0],
                "doing": [0],
                "on_hold": [0],
                "dropped": [0],
                "series": [False],
                "score_details": [[0] * 10],
                "meta_tags": [[]],
                "tags": [[]],
            },
            0,
            0,
            text_bits={
                "summary": bake_site.np.array([False]),
                "infobox": bake_site.np.array([False]),
            },
            meta_id={},
            tag_id={},
        )

        self.assertIsNone(row[3])

    def test_person_and_character_do_not_store_a_fake_chinese_name(
        self,
    ) -> None:
        person = bake_site.person_entity_row(
            {
                "name": ["Alice"],
                "type": [1],
                "career": [["声优"]],
                "comments": [2],
                "collects": [3],
            },
            0,
            0,
            text_bits={
                "summary": bake_site.np.asarray([True]),
                "infobox": bake_site.np.asarray([False]),
            },
            career_id={"声优": 0},
        )
        character = bake_site.character_entity_row(
            {
                "name": ["Bob"],
                "role": [1],
                "comments": [4],
                "collects": [5],
            },
            0,
            0,
            text_bits={
                "summary": bake_site.np.asarray([False]),
                "infobox": bake_site.np.asarray([True]),
            },
        )

        self.assertEqual(person, ["Alice", 1, [0], 2, 3, 1, 0])
        self.assertEqual(character, ["Bob", 1, 4, 5, 0, 1])


class MappingTests(unittest.TestCase):
    def test_voice_credit_codes_have_release_display_labels(self) -> None:
        *_, voice_roles = bake_site.load_mappings(bake_site.MAPPING_SNAPSHOT)

        self.assertEqual(voice_roles[0]["cn"], "CV")
        self.assertEqual(voice_roles[4]["cn"], "日配")


class StreamingPackTests(unittest.TestCase):
    def test_episode_subject_index_is_dense_and_rejects_duplicates(
        self,
    ) -> None:
        index = bake_site.build_episode_subject_index(
            [3, 1],
            [40, 20],
        )

        self.assertEqual(
            index.tolist(),
            [
                bake_site.sr.EPISODE_SUBJECT_SENTINEL,
                20,
                bake_site.sr.EPISODE_SUBJECT_SENTINEL,
                40,
            ],
        )
        with self.assertRaisesRegex(ValueError, "duplicate"):
            bake_site.build_episode_subject_index([1, 1], [20, 21])

    def test_pack_file_streams_members_and_preserves_offsets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            first = bake_site.sr.gzip_member("abc", 1)
            second = bake_site.sr.gzip_member("defg", 1)
            with patch.object(bake_site, "SITE", site):
                pack = bake_site.PackFile("rows.pack")

                self.assertEqual(pack.add(first), [0, len(first)])
                self.assertEqual(pack.add(second), [len(first), len(second)])
                self.assertEqual(
                    (site / "rows.pack").read_bytes(), first + second
                )
                pack.write()

            self.assertEqual((site / "rows.pack").read_bytes(), first + second)

    def test_rollover_pack_streams_each_bounded_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            first = bake_site.sr.gzip_member("abcdefghij", 1)
            second = bake_site.sr.gzip_member("def", 1)
            third = bake_site.sr.gzip_member("gh", 1)
            pack_cap = len(second) + len(third)
            self.assertLessEqual(len(first), pack_cap)
            self.assertGreater(len(first) + len(second), pack_cap)
            with (
                patch.object(bake_site, "SITE", site),
                patch.object(bake_site.sr, "PACK_CAP", pack_cap),
            ):
                pack = bake_site.RolloverPack("text")

                self.assertEqual(pack.add(first), [0, 0, len(first)])
                self.assertEqual(pack.add(second), [1, 0, len(second)])
                self.assertEqual(pack.add(third), [1, len(second), len(third)])
                self.assertEqual(pack.files, ["text-0.pack", "text-1.pack"])
                self.assertEqual((site / "text-0.pack").read_bytes(), first)
                self.assertEqual(
                    (site / "text-1.pack").read_bytes(), second + third
                )
                pack.write()


class SearchIndexTests(unittest.TestCase):
    def test_delta_varint_postings_round_trip_boundaries(self) -> None:
        encoded = bake_site.encode_delta_varints([0, 1, 127, 128, 16_000])
        self.assertEqual(encoded, bytes([0, 1, 126, 1, 128, 124]))
        with self.assertRaisesRegex(ValueError, "sorted"):
            bake_site.encode_delta_varints([2, 2])

    def test_text_search_indexes_members_and_keeps_hash_hits_as_candidates(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with patch.object(bake_site, "SITE", site):
                index = bake_site.TextSearchBuilder()
                index.add(
                    "entity-summary",
                    1,
                    [0, 12, 34],
                    ["穿过星空的旅程"],
                )
                index.add(
                    "episode-description",
                    2,
                    [0, 56, 78],
                    ["没有相同词语"],
                )
                index.write()

            directory_value = bake_site.orjson.loads(
                gzip.decompress((site / "text.search.members").read_bytes())
            )
            raw_index = bake_site.np.frombuffer(
                (site / "text.search.ngram.idx").read_bytes(), dtype="<u4"
            )
            bucket = bake_site.sr.search_gram_bucket("星空")
            bucket_members = raw_index[:65_537]
            posting_count = int(raw_index[-65_536 + bucket])

        self.assertEqual(
            directory_value["members"],
            [
                ["entity-summary", 1, 0, 12, 34],
                ["episode-description", 2, 0, 56, 78],
            ],
        )
        self.assertEqual(posting_count, 1)
        self.assertEqual(
            int(bucket_members[bucket + 1] - bucket_members[bucket]),
            1,
        )

    def test_alias_pack_halves_block_width_until_members_fit(self) -> None:
        random_text = random.Random(0).randbytes(180_000).hex()
        cases = {
            "compressed": random_text,
            "decoded": "x" * 1_100_000,
        }
        for label, display in cases.items():
            with self.subTest(label=label):
                with tempfile.TemporaryDirectory() as directory:
                    site = Path(directory)
                    rows = [[[], display, 1], [[], display, 1]]
                    with (
                        patch.object(bake_site, "SITE", site),
                        patch.object(
                            bake_site.sr, "SEARCH_ALIAS_BLOCK_RANKS_MAX", 2
                        ),
                    ):
                        block_size = bake_site.write_search_alias_pack(rows)

                    index = bake_site.np.frombuffer(
                        (site / "search.alias.idx").read_bytes(), dtype="<u4"
                    )
                    pack = (site / "search.alias.pack").read_bytes()

                self.assertEqual(block_size, 1)
                self.assertEqual(len(index), 3)
                self.assertTrue(
                    all(
                        len(
                            bake_site.orjson.loads(
                                gzip.decompress(pack[int(start) : int(end)])
                            )
                        )
                        == 1
                        for start, end in zip(
                            index[:-1], index[1:], strict=True
                        )
                    )
                )

    def test_search_index_publishes_complete_fold_and_language_aliases(
        self,
    ) -> None:
        names = ["Straße", "虎伥", "沪"]
        cn_names = ["", "", ""]
        kinds = [1, 3, 1]

        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with patch.object(bake_site, "SITE", site):
                bake_site.build_search_index(names, cn_names, kinds)

            charmap = bake_site.orjson.loads(
                (site / "charmap.json").read_bytes()
            )
            alias_index = bake_site.np.frombuffer(
                (site / "search.alias.idx").read_bytes(), dtype="<u4"
            )
            alias_pack = (site / "search.alias.pack").read_bytes()
            aliases: list[list[object]] = []
            for start, end in zip(
                alias_index[:-1], alias_index[1:], strict=True
            ):
                aliases.extend(
                    bake_site.orjson.loads(
                        gzip.decompress(alias_pack[int(start) : int(end)])
                    )
                )

        self.assertEqual(charmap["ẞ"], "ss")
        self.assertEqual(
            {key for key, _matched in aliases[1][0]},
            {"虎伥", "虎倀"},
        )
        self.assertEqual(
            {key for key, _matched in aliases[2][0]},
            {"沪", "滬"},
        )
        self.assertEqual(aliases[1][1:], ["虎伥", 3])

    def test_search_tree_handles_long_shared_prefix_iteratively(self) -> None:
        shared = "a" * 1_100
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with (
                patch.object(bake_site, "SITE", site),
                patch.object(bake_site.sr, "SEARCH_LEAF_CAP", 1),
            ):
                bake_site.build_search_index(
                    [f"{shared}b", f"{shared}c"],
                    ["", ""],
                    [1, 1],
                )

            search_dir = bake_site.orjson.loads(
                (site / "search.idx.json").read_bytes()
            )

        self.assertIn(shared, search_dir)

    def test_bigram_postings_preserve_global_rank_order(self) -> None:
        names = ["The Garden", "境界線上のホライゾン", "月姫"]
        cn_names = ["空之境界", "", "月之公主"]
        kinds = [1, 2, 3]

        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with (
                patch.object(bake_site, "SITE", site),
                patch.object(bake_site.sr, "SEARCH_NGRAM_MEMBER_RANKS", 1),
            ):
                bake_site.build_search_index(names, cn_names, kinds)

            index = bake_site.np.frombuffer(
                (site / "search.ngram.idx").read_bytes(), dtype="<u4"
            )
            postings = (site / "search.ngram.pack").read_bytes()

        bucket_count = bake_site.sr.SEARCH_NGRAM_BUCKETS
        bucket_members = index[: bucket_count + 1]
        member_count = int(bucket_members[-1])
        offsets_start = bucket_count + 1
        first_start = offsets_start + member_count + 1
        last_start = first_start + member_count
        counts_start = last_start + member_count
        offsets = index[offsets_start:first_start]
        counts = index[counts_start:]
        self.assertEqual(len(index), bucket_count * 2 + member_count * 3 + 2)

        def ranks_for(gram: str) -> list[int]:
            bucket = bake_site.sr.search_gram_bucket(gram)
            raw = b""
            for member in range(
                int(bucket_members[bucket]),
                int(bucket_members[bucket + 1]),
            ):
                start, end = int(offsets[member]), int(offsets[member + 1])
                raw += gzip.decompress(postings[start:end])
            ranks = [
                raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16)
                for i in range(0, len(raw), 3)
            ]
            self.assertEqual(len(ranks), int(counts[bucket]))
            return ranks

        self.assertEqual(ranks_for("之境"), [0])
        self.assertEqual(ranks_for("境界"), [0, 1])

    def test_internal_search_member_keeps_an_exact_low_rank_match(
        self,
    ) -> None:
        names = [f"a-name-{rank}" for rank in range(14)] + ["a"]
        cn_names = [""] * len(names)
        kinds = [1] * len(names)

        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with (
                patch.object(bake_site, "SITE", site),
                patch.object(bake_site.sr, "SEARCH_LEAF_CAP", 1),
            ):
                bake_site.build_search_index(names, cn_names, kinds)

            search_dir = bake_site.orjson.loads(
                (site / "search.idx.json").read_bytes()
            )
            offset, length = search_dir["a"]["t"]
            rows = bake_site.orjson.loads(
                gzip.decompress(
                    (site / "search.pack").read_bytes()[
                        offset : offset + length
                    ]
                )
            )

        self.assertEqual(rows[0], ["a", "a", 14, "a", 1])
        self.assertEqual(len(rows), bake_site.sr.SEARCH_TOP + 1)

    def test_internal_search_member_keeps_every_exact_match(self) -> None:
        names = ["a"] * (bake_site.sr.SEARCH_TOP + 2)
        cn_names = [""] * len(names)
        kinds = [1] * len(names)

        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with (
                patch.object(bake_site, "SITE", site),
                patch.object(bake_site.sr, "SEARCH_LEAF_CAP", 1),
            ):
                bake_site.build_search_index(names, cn_names, kinds)

            search_dir = bake_site.orjson.loads(
                (site / "search.idx.json").read_bytes()
            )
            offset, length = search_dir["a"]["t"]
            rows = bake_site.orjson.loads(
                gzip.decompress(
                    (site / "search.pack").read_bytes()[
                        offset : offset + length
                    ]
                )
            )

        self.assertEqual([row[2] for row in rows], list(range(len(names))))

    def test_internal_search_top_counts_unique_entities_not_alias_rows(
        self,
    ) -> None:
        names = [f"a-name-{rank}" for rank in range(14)]
        cn_names = [f"a-alias-{rank}" for rank in range(14)]
        kinds = [1] * len(names)

        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with (
                patch.object(bake_site, "SITE", site),
                patch.object(bake_site.sr, "SEARCH_LEAF_CAP", 1),
            ):
                bake_site.build_search_index(names, cn_names, kinds)

            search_dir = bake_site.orjson.loads(
                (site / "search.idx.json").read_bytes()
            )
            offset, length = search_dir["a"]["t"]
            rows = bake_site.orjson.loads(
                gzip.decompress(
                    (site / "search.pack").read_bytes()[
                        offset : offset + length
                    ]
                )
            )

        self.assertEqual(
            [row[2] for row in rows],
            list(range(bake_site.sr.SEARCH_TOP)),
        )


class WindowedEntityPackTests(unittest.TestCase):
    def test_streams_sorted_entity_parquet_in_bounded_batches(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parquet = root / "entity.parquet"
            pq.write_table(
                pa.table({"id": [1, 2, 5], "value": ["one", "two", "five"]}),
                parquet,
            )
            with patch.object(bake_site, "SITE", root):
                pack = bake_site.PackFile("entities.pack")
                ranges, count = bake_site.emit_sorted_entity_parquet(
                    pack,
                    parquet,
                    ["id", "value"],
                    width=4,
                    level=1,
                    batch_size=2,
                    row_for_index=lambda table, index, global_index: [
                        table["value"][index],
                        global_index,
                    ],
                )
                pack.write()

            payload = (root / "entities.pack").read_bytes()
            decoded = [
                bake_site.orjson.loads(
                    gzip.decompress(payload[offset : offset + length])
                )
                for _start, _end, offset, length in ranges
            ]
            self.assertEqual(
                decoded,
                [
                    {"i": [1, 2], "r": [["one", 0], ["two", 1]]},
                    {"i": [5], "r": [["five", 2]]},
                ],
            )
            self.assertEqual(count, 3)


class EntityTextPresenceTests(unittest.TestCase):
    def test_reads_only_text_presence_bits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet = Path(directory)
            pq.write_table(
                pa.table(
                    {
                        "summary": ["", "简介"],
                        "infobox": ["资料", ""],
                    }
                ),
                parquet / "person.parquet",
            )

            with patch.object(bake_site, "PARQUET", parquet):
                bits = bake_site.read_text_presence(
                    "person", ("summary", "infobox")
                )

            self.assertEqual(bits["summary"].tolist(), [False, True])
            self.assertEqual(bits["infobox"].tolist(), [True, False])

    def test_streams_sorted_parquet_text_by_id_window(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parquet = root / "person.parquet"
            pq.write_table(
                pa.table({"id": [1, 2, 5], "summary": ["", "two", "five"]}),
                parquet,
            )
            with patch.object(bake_site, "SITE", root):
                pack = bake_site.RolloverPack("summary")
                ranges, stats = bake_site.emit_sorted_parquet_text(
                    pack,
                    parquet,
                    "summary",
                    width=4,
                    level=1,
                    batch_size=2,
                )
                pack.write()

            payload = (root / "summary-0.pack").read_bytes()
            decoded = [
                bake_site.orjson.loads(
                    gzip.decompress(payload[offset : offset + length])
                )
                for _start, _end, _file, offset, length in ranges
            ]
            self.assertEqual(
                decoded,
                [
                    {"i": [2], "t": ["two"]},
                    {"i": [5], "t": ["five"]},
                ],
            )
            self.assertEqual(
                stats,
                {"non_empty": 2, "empty": 1, "raw_bytes": 7},
            )


class FactSummaryTests(unittest.TestCase):
    def test_emits_non_empty_text_addressed_by_fact_ref(self) -> None:
        width = bake_site.sr.TEXT_BLOCK_IDS["fact-summary"]
        first_text = "配音说明"
        second_text = "另一条说明"
        items = [(width + 2, second_text), (3, first_text)]
        raw_bytes = len(first_text.encode()) + len(second_text.encode())

        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with patch.object(bake_site, "SITE", site):
                index, stats, sizes = bake_site.emit_fact_summary(
                    items,
                    empty_count=4,
                    raw_bytes=raw_bytes,
                )

            payloads = []
            for start, end, file_index, offset, length in index["ranges"]:
                packed = (site / index["files"][file_index]).read_bytes()
                decoded = bake_site.orjson.loads(
                    gzip.decompress(packed[offset : offset + length])
                )
                payloads.append((start, end, decoded))

        self.assertEqual(
            payloads,
            [
                (3, 3, {"i": [3], "t": [first_text]}),
                (
                    width + 2,
                    width + 2,
                    {"i": [width + 2], "t": [second_text]},
                ),
            ],
        )
        self.assertEqual(
            stats,
            {
                "non_empty": 2,
                "empty": 4,
                "raw_bytes": raw_bytes,
                "compressed_bytes": sum(sizes),
            },
        )
        self.assertTrue(all(size > 0 for size in sizes))


class FactAccumulationTests(unittest.TestCase):
    def test_merges_bounded_sorted_runs_with_global_fact_refs(self) -> None:
        subject_1 = bake_site.sr.entity_key(bake_site.sr.KIND_SUBJECT, 1)
        subject_2 = bake_site.sr.entity_key(bake_site.sr.KIND_SUBJECT, 2)
        person_1 = bake_site.sr.entity_key(bake_site.sr.KIND_PERSON, 1)
        duplicate = ((subject_1, subject_2), (3, 0))
        other = ((subject_2, subject_1), (4, 1))
        worked_on = ((person_1, subject_1), (5, "1-2"))

        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            rel_a, _ = bake_site.write_fact_run(
                run_dir,
                0,
                "RELATES_TO",
                iter([other, duplicate]),
                row_count=2,
            )
            rel_b, _ = bake_site.write_fact_run(
                run_dir,
                1,
                "RELATES_TO",
                iter([duplicate]),
                row_count=1,
            )
            work, _ = bake_site.write_fact_run(
                run_dir,
                2,
                "WORKED_ON",
                iter([worked_on]),
                row_count=1,
            )

            merged = list(
                bake_site.merge_fact_runs(
                    {"WORKED_ON": [work], "RELATES_TO": [rel_a, rel_b]}
                )
            )

        expected_rows = [
            bake_site.sr.canonical_fact("RELATES_TO", *duplicate),
            bake_site.sr.canonical_fact("RELATES_TO", *duplicate),
            bake_site.sr.canonical_fact("RELATES_TO", *other),
            bake_site.sr.canonical_fact("WORKED_ON", *worked_on),
        ]
        expected = []
        for encoded in sorted(set(expected_rows)):
            expected.append((encoded, expected_rows.count(encoded)))
        self.assertEqual(merged, expected)


class RankLookupTests(unittest.TestCase):
    def test_builds_compact_segmented_scalar_and_vector_lookup(self) -> None:
        keys = bake_site.np.array(
            [
                bake_site.sr.entity_key(bake_site.sr.KIND_PERSON, 2),
                bake_site.sr.entity_key(bake_site.sr.KIND_SUBJECT, 3),
                bake_site.sr.entity_key(bake_site.sr.KIND_SUBJECT, 1),
            ],
            dtype=bake_site.np.uint32,
        )

        lookup = bake_site.build_rank_lookup(keys)

        self.assertEqual(
            bake_site.entity_rank(
                lookup,
                bake_site.sr.entity_key(bake_site.sr.KIND_SUBJECT, 1),
            ),
            2,
        )
        self.assertEqual(
            bake_site.entity_rank(
                lookup,
                bake_site.sr.entity_key(bake_site.sr.KIND_CHARACTER, 1),
            ),
            bake_site.sr.RANK_SENTINEL,
        )
        bake_site.np.testing.assert_array_equal(
            bake_site.entity_ranks(lookup, keys[[2, 0]]), [2, 0]
        )


class IncidenceGroupTests(unittest.TestCase):
    def test_spools_contiguous_bucket_shards_and_tracks_coverage(self) -> None:
        known = bake_site.sr.entity_key(bake_site.sr.KIND_SUBJECT, 1)
        missing = bake_site.sr.entity_key(bake_site.sr.KIND_SUBJECT, 5)
        lookup = bake_site.build_rank_lookup(
            bake_site.np.array([known], dtype=bake_site.np.uint32)
        )
        first = (2, "r", [1])
        second = (3, "r", [2])
        external = (4, "r", [3])

        with tempfile.TemporaryDirectory() as directory:
            spool = bake_site.IncidenceSpool(
                Path(directory),
                lookup,
                node_count=1,
                buckets=8,
                shards=2,
            )
            spool.append(known, first)
            spool.append(missing, external)
            spool.append(known, second)
            spool.close()

            self.assertEqual(len(spool), 2)
            self.assertEqual(spool.bucket_range(0), range(0, 4))
            self.assertEqual(spool.bucket_range(1), range(4, 8))
            self.assertEqual(spool.read_shard(0), {known: [first, second]})
            self.assertEqual(spool.read_shard(1), {missing: [external]})


if __name__ == "__main__":
    unittest.main()
