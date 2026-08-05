from __future__ import annotations

import multiprocessing
import tempfile
import time
import unittest
from pathlib import Path

from scripts.build_lock import parquet_layout_lock


def wait_for_lock(
    lock_root: str,
    entered: multiprocessing.synchronize.Event,
) -> None:
    with parquet_layout_lock(Path(lock_root) / "parquet"):
        entered.set()


class BuildLockTests(unittest.TestCase):
    def test_parquet_and_layout_are_serialized_across_processes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parquet = root / "parquet"
            context = multiprocessing.get_context("spawn")
            entered = context.Event()

            with parquet_layout_lock(parquet):
                process = context.Process(
                    target=wait_for_lock,
                    args=(str(root), entered),
                )
                process.start()
                time.sleep(0.1)
                self.assertFalse(entered.is_set())

            process.join(timeout=5)
            if process.is_alive():
                process.terminate()
                process.join()
            self.assertEqual(process.exitcode, 0)
            self.assertTrue(entered.is_set())


if __name__ == "__main__":
    unittest.main()
