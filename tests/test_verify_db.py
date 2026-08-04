from __future__ import annotations

import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from scripts import verify_db


class SourceEnumCoverageTests(unittest.TestCase):
    def test_reports_raw_enums_outside_the_declared_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory)
            records = {
                "subject": '{"type":1}\n',
                "person": '{"type":0}\n',
                "character": '{"role":4}\n',
                "episode": '{"type":6}\n',
                "subject-characters": '{"type":6}\n',
                "person-characters": '{"type":7}\n',
            }
            for name, content in records.items():
                (dump / f"{name}.jsonlines").write_text(content)

            with patch.object(verify_db, "DUMP", dump):
                anomalies = verify_db.source_enum_anomalies()

            self.assertEqual(
                anomalies,
                {
                    "Person.type": Counter({0: 1}),
                    "VOICED.type": Counter({7: 1}),
                },
            )

    def test_only_growth_beyond_the_audited_baseline_is_rejected(self) -> None:
        growth = verify_db.enum_anomaly_growth(
            {
                "Person.type": Counter({0: 2}),
                "Episode.type": Counter({7: 1}),
            }
        )

        self.assertEqual(growth, {"Person.type": 1, "Episode.type": 1})


if __name__ == "__main__":
    unittest.main()
