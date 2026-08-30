from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.merge.delivery_manifest import build_entries, create_manifest, verify_manifest


class DeliveryManifestTests(unittest.TestCase):
    def test_created_manifest_names_the_parent_as_content_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "README.md").write_text("hello\n", encoding="utf-8")
            output = root / "delivery-manifest.json"
            with (
                patch("tools.merge.delivery_manifest.tracked_files", return_value={"README.md"}),
                patch("tools.merge.delivery_manifest.git", return_value="abc123"),
            ):
                manifest = create_manifest(root, output)

            self.assertEqual(2, manifest["schema_version"])
            self.assertEqual("abc123", manifest["content_commit"])
            self.assertNotIn("verified_base_commit", manifest)
            self.assertIn("content_commit", manifest["scope"])

    def test_manifest_hashes_files_and_detects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "nested").mkdir()
            (root / "README.md").write_text("hello\n", encoding="utf-8")
            (root / "nested" / "data.json").write_text('{"ok": true}\n', encoding="utf-8")
            paths = ["README.md", "nested/data.json"]
            manifest = {
                "schema_version": 2,
                "content_commit": "abc123",
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
                "schema_version": 2,
                "content_commit": "abc123",
                "manifest_path": "docs/evidence/delivery-manifest.json",
                "files": build_entries(root, ["one.txt"]),
            }

            failures = verify_manifest(root, manifest, {"one.txt", "extra.txt"})
            self.assertIn("unexpected tracked file: extra.txt", failures)


if __name__ == "__main__":
    unittest.main()
