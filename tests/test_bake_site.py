from __future__ import annotations

import gzip
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from scripts import bake_site


class StreamingPackTests(unittest.TestCase):
    def test_pack_file_streams_members_and_preserves_offsets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with patch.object(bake_site, "SITE", site):
                pack = bake_site.PackFile("rows.pack")

                self.assertEqual(pack.add(b"abc"), [0, 3])
                self.assertEqual(pack.add(b"defg"), [3, 4])
                self.assertEqual((site / "rows.pack").read_bytes(), b"abcdefg")
                pack.write()

            self.assertEqual((site / "rows.pack").read_bytes(), b"abcdefg")

    def test_rollover_pack_streams_each_bounded_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            with (
                patch.object(bake_site, "SITE", site),
                patch.object(bake_site.sr, "PACK_CAP", 5),
            ):
                pack = bake_site.RolloverPack("text")

                self.assertEqual(pack.add(b"abc"), [0, 0, 3])
                self.assertEqual(pack.add(b"def"), [1, 0, 3])
                self.assertEqual(pack.add(b"gh"), [1, 3, 2])
                self.assertEqual(pack.files, ["text-0.pack", "text-1.pack"])
                self.assertEqual((site / "text-0.pack").read_bytes(), b"abc")
                self.assertEqual((site / "text-1.pack").read_bytes(), b"defgh")
                pack.write()


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
