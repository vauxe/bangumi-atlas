from __future__ import annotations

import gzip
import random
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

from scripts import bake_site


def load_search_directory(site: Path) -> dict[str, object]:
    directory: dict[str, object] = {}
    for shard in range(bake_site.sr.SEARCH_PREFIX_SHARDS):
        path = site / f"search.idx-{shard}.json.gz"
        rows = bake_site.orjson.loads(gzip.decompress(path.read_bytes()))
        directory.update(rows)
    return directory


def load_search_ngram_bucket(
    site: Path,
    bucket: int,
) -> list[object] | None:
    shard = bucket % bake_site.sr.SEARCH_NGRAM_SHARDS
    directory = bake_site.orjson.loads(
        gzip.decompress(
            (site / f"search.ngram.idx-{shard}.json.gz").read_bytes()
        )
    )
    return directory[bucket // bake_site.sr.SEARCH_NGRAM_SHARDS]


class InputGenerationTests(unittest.TestCase):
    def test_main_holds_generation_lock_for_validation_and_bake(self) -> None:
        events: list[str] = []

        @contextmanager
        def lock(_parquet: Path):
            events.append("lock-enter")
            try:
                yield
            finally:
                events.append("lock-exit")

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "site" / "data"
            with (
                patch.object(bake_site, "parquet_layout_lock", lock),
                patch.object(
                    bake_site,
                    "require_current_release_inputs",
                    side_effect=lambda **_kwargs: (
                        events.append("validate") or {}
                    ),
                ),
                patch.object(
                    bake_site,
                    "bake_release",
                    side_effect=lambda _output, _identity: events.append(
                        "bake"
                    ),
                ),
                patch("sys.argv", ["bake_site.py", "--output", str(output)]),
            ):
                bake_site.main()

        self.assertEqual(
            events, ["lock-enter", "validate", "bake", "lock-exit"]
        )


class ReleaseBoundaryTests(unittest.TestCase):
    def test_output_guard_only_accepts_managed_site_data_roots(self) -> None:
        bake_site.validate_output_directory(bake_site.ROOT / "site" / "data")
        with tempfile.TemporaryDirectory() as directory:
            bake_site.validate_output_directory(
                Path(directory) / "site" / "data"
            )

        runner_temp = bake_site.ROOT / ".runner-temp-test"
        with patch.dict(
            bake_site.os.environ,
            {"RUNNER_TEMP": str(runner_temp)},
        ):
            bake_site.validate_output_directory(
                runner_temp / "bangumi-atlas-site" / "data"
            )

        for unsafe in (
            bake_site.ROOT,
            bake_site.ROOT / ".git",
            bake_site.ROOT / "scripts",
            bake_site.ROOT / "data" / "verifications" / "site" / "data",
            bake_site.ROOT.parent,
            Path("/tmp"),
        ):
            with (
                self.subTest(path=unsafe),
                self.assertRaisesRegex(ValueError, "output"),
            ):
                bake_site.validate_output_directory(unsafe)

    def test_output_guard_rejects_symlinked_staging_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.mkdir()
            linked_parent = root / "linked-site"
            linked_parent.symlink_to(target, target_is_directory=True)
            direct_parent = root / "direct-site"
            direct_parent.mkdir()
            linked_output = direct_parent / "data"
            linked_output.symlink_to(target, target_is_directory=True)

            for output in (linked_parent / "data", linked_output):
                with (
                    self.subTest(output=output),
                    self.assertRaisesRegex(ValueError, "symlink"),
                ):
                    bake_site.validate_output_directory(output)

    def test_capacity_checks_are_runtime_errors_not_assertions(self) -> None:
        bake_site.validate_release_capacity((1 << 21) - 1)
        with self.assertRaisesRegex(ValueError, r"2\^21"):
            bake_site.validate_release_capacity(1 << 21)
        with (
            patch.object(bake_site.sr, "RANK_SENTINEL", 10),
            self.assertRaisesRegex(ValueError, "VisualRank"),
        ):
            bake_site.validate_release_capacity(10)

    def test_media_flag_values_must_fit_the_published_bits(self) -> None:
        bake_site.validate_media_flag_values(
            bake_site.np.array([0, 1, 7], dtype=bake_site.np.int64)
        )
        for values in ([-1], [8]):
            with (
                self.subTest(values=values),
                self.assertRaisesRegex(ValueError, "media"),
            ):
                bake_site.validate_media_flag_values(
                    bake_site.np.asarray(values)
                )


class ManifestPublicationTests(unittest.TestCase):
    def test_reconciliation_failure_does_not_publish_a_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "data"
            site.mkdir()
            bake_site.failures[:] = ["semantic mismatch"]
            self.addCleanup(bake_site.failures.clear)

            with (
                patch.object(bake_site, "SITE", site),
                self.assertRaisesRegex(SystemExit, "semantic mismatch"),
            ):
                bake_site.publish_manifest(
                    {"version": "invalid"},
                    total_bytes=1,
                    core_bytes=1,
                    n_files=1,
                    started=bake_site.time.time(),
                )

            self.assertFalse((site / "manifest.json").exists())

    def test_size_gate_does_not_publish_a_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "data"
            site.mkdir()
            bake_site.failures.clear()
            self.addCleanup(bake_site.failures.clear)

            with (
                patch.object(bake_site, "SITE", site),
                self.assertRaisesRegex(SystemExit, "1GB"),
            ):
                bake_site.publish_manifest(
                    {"version": "too-large"},
                    total_bytes=bake_site.SIZE_BUDGET + 1,
                    core_bytes=1,
                    n_files=1,
                    started=bake_site.time.time(),
                )

            self.assertFalse((site / "manifest.json").exists())


class EntityEncodingTests(unittest.TestCase):
    def test_subject_zero_score_and_rank_remain_typed_values(self) -> None:
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
        self.assertEqual(row[5], 0.0)
        self.assertEqual(row[6], 0)

    def test_subject_platform_code_survives_missing_display_mapping(
        self,
    ) -> None:
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

        self.assertEqual(row[3], 0)

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

    def test_text_search_write_releases_source_buffers(self) -> None:
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
                self.assertTrue(index.members)
                self.assertTrue(any(index.postings))

                index.write()

                self.assertEqual(index.members, [])
                self.assertEqual(index.postings, [])
                with self.assertRaisesRegex(RuntimeError, "already written"):
                    index.add(
                        "entity-summary",
                        1,
                        [0, 56, 78],
                        ["不能继续追加"],
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

            search_dir = load_search_directory(site)

        self.assertIn(shared, search_dir)

    def test_search_directory_is_sharded_by_first_codepoint(self) -> None:
        names = ["alpha", "境界線上のホライゾン", "月姫"]
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with patch.object(bake_site, "SITE", site):
                bake_site.build_search_index(names, ["", "", ""], [1, 1, 1])

            self.assertFalse((site / "search.idx.json").exists())
            merged = load_search_directory(site)
            for prefix, node in merged.items():
                shard = ord(prefix[0]) % bake_site.sr.SEARCH_PREFIX_SHARDS
                rows = bake_site.orjson.loads(
                    gzip.decompress(
                        (site / f"search.idx-{shard}.json.gz").read_bytes()
                    )
                )
                self.assertEqual(rows[prefix], node)

        self.assertIn("a", merged)
        self.assertIn("境", merged)
        self.assertIn("月", merged)

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

            postings = (site / "search.ngram.pack").read_bytes()
            entries = {
                gram: load_search_ngram_bucket(
                    site, bake_site.sr.search_gram_bucket(gram)
                )
                for gram in ("之境", "境界")
            }

        def ranks_for(gram: str) -> list[int]:
            entry = entries[gram]
            self.assertIsNotNone(entry)
            count, members = entry
            raw = b""
            for offset, length, first, last in members:
                member_ranks = gzip.decompress(
                    postings[offset : offset + length]
                )
                self.assertEqual(
                    int.from_bytes(member_ranks[:3], "little"), first
                )
                self.assertEqual(
                    int.from_bytes(member_ranks[-3:], "little"), last
                )
                raw += member_ranks
            ranks = [
                raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16)
                for i in range(0, len(raw), 3)
            ]
            self.assertEqual(len(ranks), count)
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

            search_dir = load_search_directory(site)
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

            search_dir = load_search_directory(site)
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

            search_dir = load_search_directory(site)
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
                    non_empty_count=2,
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

    def test_counts_source_rows_separately_from_unique_fact_refs(self) -> None:
        text = "重复配音说明"
        raw_bytes = len(text.encode()) * 2

        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with patch.object(bake_site, "SITE", site):
                index, stats, _sizes = bake_site.emit_fact_summary(
                    [(7, text)],
                    non_empty_count=2,
                    empty_count=3,
                    raw_bytes=raw_bytes,
                )

        self.assertEqual(len(index["ranges"]), 1)
        self.assertEqual(
            {key: stats[key] for key in ("non_empty", "empty", "raw_bytes")},
            {
                "non_empty": 2,
                "empty": 3,
                "raw_bytes": raw_bytes,
            },
        )
        self.assertGreater(stats["compressed_bytes"], 0)


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

    def test_source_id_rank_lookup_rejects_entity_key_aliases(self) -> None:
        lookup = bake_site.build_rank_lookup(
            bake_site.np.array(
                [bake_site.sr.entity_key(bake_site.sr.KIND_SUBJECT, 0)],
                dtype=bake_site.np.uint32,
            )
        )

        with self.assertRaisesRegex(ValueError, "24-bit"):
            bake_site.ranks_for_source_ids(
                lookup,
                bake_site.sr.KIND_SUBJECT,
                [1 << 24],
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
