from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
