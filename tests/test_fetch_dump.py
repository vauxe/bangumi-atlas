from __future__ import annotations

import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from scripts import fetch_dump


def latest_response(*, payload: bytes, name: str = "dump.zip") -> io.BytesIO:
    return io.BytesIO(
        json.dumps(
            {
                "digest": f"sha256:{hashlib.sha256(payload).hexdigest()}",
                "size": len(payload),
                "name": name,
                "browser_download_url": "https://example.invalid/dump.zip",
            }
        ).encode()
    )


class DumpGenerationLockTests(unittest.TestCase):
    def test_fetch_holds_the_same_lock_as_every_consumer(self) -> None:
        events: list[str] = []

        @contextmanager
        def lock(_parquet: Path):
            events.append("enter")
            try:
                yield
            finally:
                events.append("exit")

        with tempfile.TemporaryDirectory() as directory:
            parquet = Path(directory) / "parquet"
            with (
                patch.object(fetch_dump, "PARQUET", parquet),
                patch.object(fetch_dump, "parquet_layout_lock", lock),
                patch.object(
                    fetch_dump,
                    "_fetch_dump",
                    side_effect=lambda: events.append("fetch"),
                ),
            ):
                fetch_dump.main()

        self.assertEqual(events, ["enter", "fetch", "exit"])


class DumpStorageSafetyTests(unittest.TestCase):
    def test_successful_fetch_replaces_archive_and_dump_together(self) -> None:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("subject.jsonlines", b"{}\n")
        payload = buffer.getvalue()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            dump = data / "dump"
            data.mkdir()
            dump.mkdir()
            (dump / "old.jsonlines").write_text("old\n")
            archive = data / "dump.zip"
            archive.write_bytes(b"previous archive")

            with (
                patch.object(fetch_dump, "DUMP_DIR", dump),
                patch.object(fetch_dump, "ZIP_PATH", archive),
                patch.object(
                    fetch_dump.urllib.request,
                    "urlopen",
                    side_effect=[
                        latest_response(
                            payload=payload,
                            name="dump-2026-08-10.zip",
                        ),
                        io.BytesIO(payload),
                    ],
                ),
            ):
                fetch_dump._fetch_dump()

            self.assertEqual(archive.read_bytes(), payload)
            self.assertEqual(
                (dump / "subject.jsonlines").read_bytes(), b"{}\n"
            )
            self.assertEqual(
                (dump / "VERSION").read_text(), "dump-2026-08-10\n"
            )
            self.assertFalse((dump / "old.jsonlines").exists())

    def test_fetch_rejects_symlinked_dump_directory_before_network(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            outside = root / "outside"
            data.mkdir()
            outside.mkdir()
            dump = data / "dump"
            dump.symlink_to(outside, target_is_directory=True)

            with (
                patch.object(fetch_dump, "DUMP_DIR", dump),
                patch.object(fetch_dump, "ZIP_PATH", data / "dump.zip"),
                patch.object(
                    fetch_dump.urllib.request,
                    "urlopen",
                    side_effect=AssertionError("network must not be reached"),
                ),
                self.assertRaisesRegex(ValueError, "symlink"),
            ):
                fetch_dump._fetch_dump()

            self.assertEqual(list(outside.iterdir()), [])

    def test_fetch_rejects_symlinked_archive_before_network(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            outside = root / "outside.zip"
            outside.write_bytes(b"must remain unchanged")
            archive = data / "dump.zip"
            archive.symlink_to(outside)

            with (
                patch.object(fetch_dump, "DUMP_DIR", data / "dump"),
                patch.object(fetch_dump, "ZIP_PATH", archive),
                patch.object(
                    fetch_dump.urllib.request,
                    "urlopen",
                    side_effect=AssertionError("network must not be reached"),
                ),
                self.assertRaisesRegex(ValueError, "symlink"),
            ):
                fetch_dump._fetch_dump()

            self.assertEqual(outside.read_bytes(), b"must remain unchanged")

    def test_interrupted_download_preserves_the_previous_archive(self) -> None:
        class BrokenDownload(io.BytesIO):
            def read(self, size: int = -1) -> bytes:
                if self.tell() == 0:
                    return super().read(3)
                raise OSError("download interrupted")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            archive = data / "dump.zip"
            archive.write_bytes(b"previous archive")
            new_payload = b"new archive payload"

            with (
                patch.object(fetch_dump, "DUMP_DIR", data / "dump"),
                patch.object(fetch_dump, "ZIP_PATH", archive),
                patch.object(
                    fetch_dump.urllib.request,
                    "urlopen",
                    side_effect=[
                        latest_response(payload=new_payload),
                        BrokenDownload(new_payload),
                    ],
                ),
                self.assertRaisesRegex(OSError, "interrupted"),
            ):
                fetch_dump._fetch_dump()

            self.assertEqual(archive.read_bytes(), b"previous archive")

    def test_failed_extraction_preserves_the_previous_dump(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            dump = data / "dump"
            data.mkdir()
            dump.mkdir()
            sentinel = dump / "sentinel.jsonlines"
            sentinel.write_text("previous generation\n")
            archive = data / "dump.zip"
            payload = b"not a zip archive"
            archive.write_bytes(payload)

            with (
                patch.object(fetch_dump, "DUMP_DIR", dump),
                patch.object(fetch_dump, "ZIP_PATH", archive),
                patch.object(
                    fetch_dump.urllib.request,
                    "urlopen",
                    return_value=latest_response(payload=payload),
                ),
                self.assertRaises(zipfile.BadZipFile),
            ):
                fetch_dump._fetch_dump()

            self.assertEqual(sentinel.read_text(), "previous generation\n")


if __name__ == "__main__":
    unittest.main()
