from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.merge.delivery_manifest import build_entries, verify_manifest


class DeliveryManifestTests(unittest.TestCase):
    def test_manifest_hashes_files_and_detects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "nested").mkdir()
            (root / "README.md").write_text("hello\n", encoding="utf-8")
            (root / "nested" / "data.json").write_text('{"ok": true}\n', encoding="utf-8")
            paths = ["README.md", "nested/data.json"]
            manifest = {
                "schema_version": 1,
                "verified_base_commit": "abc123",
                "manifest_path": "docs/evidence/delivery-manifest.json",
                "files": build_entries(root, paths),
            }
            manifest_path = root / "delivery-manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            self.assertEqual([], verify_manifest(root, manifest, set(paths)))

            (root / "README.md").write_text("HELLO\n", encoding="utf-8")
            failures = verify_manifest(root, manifest, set(paths))
            self.assertTrue(any("sha256 mismatch" in failure for failure in failures))

    def test_manifest_detects_tracked_set_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "one.txt").write_text("one", encoding="utf-8")
            manifest = {
                "schema_version": 1,
                "verified_base_commit": "abc123",
                "manifest_path": "docs/evidence/delivery-manifest.json",
                "files": build_entries(root, ["one.txt"]),
            }

            failures = verify_manifest(root, manifest, {"one.txt", "extra.txt"})
            self.assertIn("unexpected tracked file: extra.txt", failures)


if __name__ == "__main__":
    unittest.main()
