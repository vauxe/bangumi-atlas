"""Fail the publish gate when cross-release layout movement is excessive."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any


def enforce_shift_limit(
    report: Mapping[str, Any],
    limit: float = 3.0,
) -> None:
    if "p95_shift_pct" not in report:
        raise ValueError("layout report is missing p95_shift_pct")
    shift = report["p95_shift_pct"]
    if shift is None:  # cold start has no previous coordinate set
        return
    if (
        isinstance(shift, bool)
        or not isinstance(shift, (int, float))
        or not math.isfinite(shift)
    ):
        raise ValueError("p95_shift_pct must be a number or null")
    if shift > limit:
        raise ValueError(f"p95 shift {shift}% exceeds {limit}% publish limit")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("--limit", type=float, default=3.0)
    args = parser.parse_args()
    try:
        report = json.loads(args.report.read_text())
        enforce_shift_limit(report, args.limit)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        sys.exit(f"layout publish gate failed: {error}")
    shift = report["p95_shift_pct"]
    print(
        "layout publish gate passed: "
        + ("cold start" if shift is None else f"p95 shift {shift}%")
    )


if __name__ == "__main__":
    main()
