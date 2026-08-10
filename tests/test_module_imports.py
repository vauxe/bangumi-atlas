import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class ModuleImportTests(unittest.TestCase):
    def test_pipeline_uses_one_package_module_graph(self) -> None:
        check = """
import sys

from scripts import (
    bake_site,
    build_db,
    content_fingerprint,
    entity_key,
    enum_mappings,
    layout,
    parquet_provenance,
    site_release,
    source_projection,
    verify_db,
    verify_site,
)

assert bake_site.sr is site_release
assert build_db.sr is site_release
assert build_db.enum_mappings is enum_mappings
assert layout.ek is entity_key
assert parquet_provenance.ek is entity_key
assert source_projection.ek is entity_key
assert site_release.entity_key is entity_key.entity_key
assert site_release.entity_keys is entity_key.entity_keys
assert verify_db.RowFingerprint is content_fingerprint.RowFingerprint
assert verify_site.sr is site_release
assert bake_site.shape_digest.__module__ == "scripts.layout"
for alias in (
    "build_lock",
    "content_fingerprint",
    "entity_key",
    "enum_mappings",
    "layout",
    "parquet_provenance",
    "site_contracts",
    "site_release",
    "source_projection",
):
    assert alias not in sys.modules, alias
"""
        result = subprocess.run(
            [sys.executable, "-c", check],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
