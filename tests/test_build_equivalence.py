from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from scripts import build_equivalence_subset as subset
from scripts import verify_build_equivalence as equivalence


class RepresentativeSelectionTests(unittest.TestCase):
    def test_stress_selection_uses_one_outlier_per_dimension(self) -> None:
        self.assertEqual(subset.stress_slots(2_048), 1)

    def test_required_ids_come_before_preferred_and_fallback(self) -> None:
        selected = subset.choose_bounded_ids(
            required=[9, 2],
            preferred=[[3, 4], [4, 5]],
            fallback=[1, 6, 7],
            limit=5,
        )

        self.assertEqual(selected.tolist(), [2, 3, 4, 5, 9])

    def test_rejects_a_limit_smaller_than_the_required_set(self) -> None:
        with self.assertRaisesRegex(ValueError, "required IDs"):
            subset.choose_bounded_ids(
                required=[1, 2, 3], preferred=[], fallback=[], limit=2
            )


class SemanticManifestTests(unittest.TestCase):
    def test_ignores_physical_packing_and_layout_source_digest(self) -> None:
        reference = {
            "version": "old",
            "files": {"facts.pack": [10, "a", "a-facts.pack"]},
            "total_bytes": 10,
            "core_bytes": 10,
            "n_files": 1,
            "layout": {"shape_digest": "old-shape", "n_nodes": 2},
            "counts": {"facts": 4},
            "schema": "v1",
        }
        candidate = {
            **reference,
            "version": "new",
            "files": {"facts.pack": [11, "b", "b-facts.pack"]},
            "total_bytes": 11,
            "core_bytes": 11,
            "layout": {"shape_digest": "new-shape", "n_nodes": 2},
        }

        self.assertEqual(
            equivalence.semantic_manifest_differences(reference, candidate),
            {},
        )

        candidate["counts"] = {"facts": 3}
        self.assertEqual(
            equivalence.semantic_manifest_differences(reference, candidate),
            {"counts": ({"facts": 4}, {"facts": 3})},
        )

    def test_materializes_baseline_scripts_without_a_worktree(self) -> None:
        repository = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as directory:
            revision = equivalence.materialize_git_scripts(
                repository, "HEAD", Path(directory)
            )

            self.assertTrue((Path(directory) / "layout.py").is_file())
            self.assertTrue((Path(directory) / "bake_site.py").is_file())
            self.assertEqual(len(revision), 40)


class ResourceSampleTests(unittest.TestCase):
    def test_script_entrypoint_is_after_runtime_dependencies(self) -> None:
        source = Path(equivalence.__file__).read_text(encoding="utf-8")

        self.assertLess(
            source.index("from build_equivalence_subset import "),
            source.index('if __name__ == "__main__":'),
        )

    def test_parses_ps_rss_kib_and_cpu_percent(self) -> None:
        sample = equivalence.parse_ps_sample("  12345  87.5\n    100   3.0\n")

        self.assertEqual(sample.rss_bytes, 12_743_680)
        self.assertEqual(sample.cpu_percent, 90.5)

    def test_empty_ps_output_means_process_has_exited(self) -> None:
        self.assertIsNone(equivalence.parse_ps_sample(""))

    def test_monitored_process_records_peak_resources(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = equivalence.run_monitored(
                "small",
                [
                    sys.executable,
                    "-c",
                    "import time; print('ok'); time.sleep(0.1)",
                ],
                log_path=Path(directory) / "small.log",
                max_rss_bytes=256 * 1024 * 1024,
                min_available_bytes=0,
                timeout_seconds=5,
                poll_seconds=0.02,
            )

        self.assertEqual(result.exit_code, 0)
        self.assertGreater(result.peak_rss_bytes, 0)
        self.assertIsNone(result.termination_reason)

    def test_memory_floor_fails_closed_when_os_metrics_are_unavailable(
        self,
    ) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(
                equivalence, "available_memory_bytes", return_value=None
            ),
            self.assertRaisesRegex(
                equivalence.ResourceLimitError,
                "cannot read available memory",
            ),
        ):
            equivalence.run_monitored(
                "missing-metric",
                [sys.executable, "-c", "pass"],
                log_path=Path(directory) / "missing.log",
                max_rss_bytes=256 * 1024 * 1024,
                min_available_bytes=1,
                timeout_seconds=5,
            )

    def test_monitor_failure_terminates_the_child_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sentinel = root / "child-survived"
            command = [
                sys.executable,
                "-c",
                (
                    "import pathlib, time; time.sleep(0.3); "
                    f"pathlib.Path({str(sentinel)!r}).write_text('bad')"
                ),
            ]
            with (
                mock.patch.object(
                    equivalence,
                    "_sample_process",
                    side_effect=PermissionError("ps denied"),
                ),
                self.assertRaises(PermissionError),
            ):
                equivalence.run_monitored(
                    "broken-monitor",
                    command,
                    log_path=root / "broken.log",
                    max_rss_bytes=256 * 1024 * 1024,
                    min_available_bytes=0,
                    timeout_seconds=5,
                    poll_seconds=0.02,
                )
            time.sleep(0.4)

            self.assertFalse(sentinel.exists())

    def test_monitored_process_stops_before_memory_budget_is_exceeded(
        self,
    ) -> None:
        command = [
            sys.executable,
            "-c",
            "import time; hold = bytearray(32 * 1024 * 1024); time.sleep(5)",
        ]
        with (
            tempfile.TemporaryDirectory() as directory,
            self.assertRaisesRegex(
                equivalence.ResourceLimitError, "RSS budget"
            ),
        ):
            equivalence.run_monitored(
                "memory-guard",
                command,
                log_path=Path(directory) / "memory.log",
                max_rss_bytes=24 * 1024 * 1024,
                min_available_bytes=0,
                timeout_seconds=5,
                poll_seconds=0.02,
            )


class BoundedParquetSubsetTests(unittest.TestCase):
    def test_id_stats_rank_by_frequency_then_id(self) -> None:
        stats = subset.IdStats()
        stats.add(np.array([7, 2, 7, 4, 2, 7], dtype=np.int64))

        self.assertEqual(stats.top(3).tolist(), [7, 2, 4])
        self.assertEqual(
            stats.counts_for(np.array([2, 4, 9], dtype=np.int64)).tolist(),
            [2, 1, 0],
        )

    def test_stable_id_order_does_not_depend_on_input_order(self) -> None:
        forward = subset.stable_id_order(
            np.array([10, 2, 7, 4], dtype=np.int64)
        )
        reverse = subset.stable_id_order(
            np.array([4, 7, 2, 10], dtype=np.int64)
        )

        np.testing.assert_array_equal(forward, reverse)
        self.assertEqual(sorted(forward.tolist()), [2, 4, 7, 10])

    def test_filters_identity_columns_in_source_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.parquet"
            destination = root / "destination.parquet"
            pq.write_table(
                pa.table(
                    {
                        "from_id": [1, 2, 1, 3],
                        "to_id": [10, 10, 11, 10],
                        "value": ["a", "b", "c", "d"],
                    }
                ),
                source,
                row_group_size=2,
            )

            rows = subset.filter_parquet(
                source,
                destination,
                {
                    "from_id": np.array([1, 3], dtype=np.int64),
                    "to_id": np.array([10], dtype=np.int64),
                },
                batch_size=2,
            )

            self.assertEqual(rows, 2)
            self.assertEqual(
                pq.read_table(destination).to_pydict(),
                {
                    "from_id": [1, 3],
                    "to_id": [10, 10],
                    "value": ["a", "d"],
                },
            )

    def test_subject_selection_keeps_each_stress_dimension(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet = Path(directory)
            pq.write_table(
                pa.table(
                    {
                        "id": list(range(1, 9)),
                        "type": [1, 1, 2, 2, 3, 3, 4, 4],
                        "wish": [100, 0, 0, 0, 0, 0, 0, 10_000],
                        "done": [0] * 8,
                        "doing": [0] * 8,
                        "on_hold": [0] * 8,
                        "dropped": [0] * 8,
                    }
                ),
                parquet / "subject.parquet",
            )
            pq.write_table(
                pa.table(
                    {
                        "subject_id": [2, 2, 2, 3] + [8] * 300,
                        "description": ["", "", "", "long description"]
                        + [""] * 300,
                    }
                ),
                parquet / "episode.parquet",
            )
            pq.write_table(
                pa.table(
                    {
                        "from_id": [4, 4, 4, 4, 4],
                        "to_id": [5, 6, 7, 8, 5],
                    }
                ),
                parquet / "relates_to.parquet",
            )
            for name, columns in {
                "worked_on": {"to_id": [1]},
                "appears_in": {"to_id": [1]},
                "voiced": {"subject_id": [1]},
            }.items():
                pq.write_table(pa.table(columns), parquet / f"{name}.parquet")

            selected = subset.select_subject_ids(parquet, limit=6)

            self.assertEqual(len(selected), 6)
            self.assertTrue({1, 2, 3, 4}.issubset(selected.tolist()))
            self.assertNotIn(8, selected)

    def test_linked_selection_keeps_voice_and_relation_pairs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parquet = Path(directory)
            pq.write_table(
                pa.table({"id": list(range(1, 8)), "collects": [0] * 7}),
                parquet / "person.parquet",
            )
            pq.write_table(
                pa.table(
                    {
                        "id": [30, 31, 32, 40, 41, 42, 43],
                        "collects": [0] * 7,
                    }
                ),
                parquet / "character.parquet",
            )
            pq.write_table(
                pa.table({"from_id": [1, 1, 2], "to_id": [10, 10, 10]}),
                parquet / "worked_on.parquet",
            )
            pq.write_table(
                pa.table({"from_id": [31, 31], "to_id": [10, 10]}),
                parquet / "appears_in.parquet",
            )
            pq.write_table(
                pa.table(
                    {
                        "from_id": [3],
                        "to_id": [30],
                        "subject_id": [10],
                    }
                ),
                parquet / "voiced.parquet",
            )
            pq.write_table(
                pa.table({"from_id": [4], "to_id": [5]}),
                parquet / "person_rel.parquet",
            )
            pq.write_table(
                pa.table({"from_id": [40], "to_id": [41]}),
                parquet / "character_rel.parquet",
            )

            people, characters = subset.select_linked_entity_ids(
                parquet,
                np.array([10], dtype=np.int64),
                person_limit=6,
                character_limit=6,
            )

            self.assertTrue({3, 4, 5}.issubset(people.tolist()))
            self.assertTrue({30, 40, 41}.issubset(characters.tolist()))
            self.assertIn(1, people)
            self.assertIn(31, characters)

    def test_subset_filters_close_every_relation_over_selected_entities(
        self,
    ) -> None:
        subjects = np.array([1, 2], dtype=np.int64)
        people = np.array([3], dtype=np.int64)
        characters = np.array([4], dtype=np.int64)

        filters = subset.subset_identity_filters(subjects, people, characters)

        self.assertEqual(
            {
                column: ids.tolist()
                for column, ids in filters["voiced"].items()
            },
            {"from_id": [3], "to_id": [4], "subject_id": [1, 2]},
        )
        self.assertEqual(
            set(filters),
            {
                "subject",
                "person",
                "character",
                "episode",
                "episode_of",
                "relates_to",
                "worked_on",
                "appears_in",
                "voiced",
                "person_rel",
                "character_rel",
            },
        )


if __name__ == "__main__":
    unittest.main()
