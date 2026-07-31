from __future__ import annotations

import unittest

from scripts.check_layout_report import enforce_shift_limit


class LayoutGateTests(unittest.TestCase):
    def test_rejects_unmeasured_layout_unless_bootstrap_is_explicit(
        self,
    ) -> None:
        with self.assertRaisesRegex(ValueError, "no warm-start baseline"):
            enforce_shift_limit({"p95_shift_pct": None})
        enforce_shift_limit(
            {"p95_shift_pct": None},
            allow_cold_start=True,
        )

    def test_accepts_values_at_the_limit(self) -> None:
        enforce_shift_limit({"p95_shift_pct": 3.0})

    def test_rejects_publish_when_shift_exceeds_limit(self) -> None:
        with self.assertRaisesRegex(ValueError, "3.001% exceeds 3.0%"):
            enforce_shift_limit({"p95_shift_pct": 3.001})

    def test_rejects_missing_or_malformed_measurements(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing p95_shift_pct"):
            enforce_shift_limit({})
        with self.assertRaisesRegex(ValueError, "must be a number or null"):
            enforce_shift_limit({"p95_shift_pct": "2.0"})


if __name__ == "__main__":
    unittest.main()
