from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "web_dependency_audit.py"


class WebDependencyAuditTests(unittest.TestCase):
    def test_audit_resolves_local_assets_and_reports_missing_targets(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            site = Path(temp_dir)
            (site / "styles").mkdir()
            (site / "scripts" / "data").mkdir(parents=True)
            (site / "images").mkdir()
            (site / "index.html").write_text(
                """
                <link rel="stylesheet" href="styles/site.css">
                <script src="scripts/app.js"></script>
                <script src="missing.js"></script>
                <a href="{{ return_url }}">template target</a>
                <a href="https://example.com/help">external</a>
                <img src="data:image/png;base64,AAAA">
                """,
                encoding="utf-8",
            )
            (site / "styles" / "site.css").write_text(
                "body { background: url('../images/background.png'); }",
                encoding="utf-8",
            )
            (site / "scripts" / "app.js").write_text(
                "fetch('data/config.json'); fetch('/api/v1/health'); "
                "fetch('${dynamicPath}');",
                encoding="utf-8",
            )
            (site / "images" / "background.png").write_bytes(b"png")
            (site / "scripts" / "data" / "config.json").write_text("{}", encoding="utf-8")
            output = site / "report.json"

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--root",
                    str(site),
                    "--output",
                    str(output),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )

            self.assertEqual(1, result.returncode)
            report = json.loads(output.read_text(encoding="utf-8"))
            by_reference = {item["reference"]: item for item in report["references"]}
            self.assertTrue(by_reference["styles/site.css"]["exists"])
            self.assertTrue(by_reference["scripts/app.js"]["exists"])
            self.assertFalse(by_reference["missing.js"]["exists"])
            self.assertTrue(by_reference["../images/background.png"]["exists"])
            self.assertTrue(by_reference["data/config.json"]["exists"])
            self.assertEqual("api", by_reference["/api/v1/health"]["kind"])
            self.assertNotIn("https://example.com/help", by_reference)
            self.assertNotIn("data:image/png;base64,AAAA", by_reference)
            self.assertNotIn("{{ return_url }}", by_reference)
            self.assertNotIn("${dynamicPath}", by_reference)

    def test_merge_layout_separates_active_doctor_and_legacy_patient_web(self) -> None:
        doctor_web = ROOT / "doctor-web"
        legacy_web = ROOT / "archive" / "legacy-patient-web"

        for name in (
            "login.html",
            "doctor_analysis.html",
            "doctor_patients.html",
            "doctor_report.html",
            "doctor_imaging.html",
            "doctor_visualization.html",
            "dac_dashboard.html",
        ):
            self.assertTrue((doctor_web / name).is_file(), name)

        for name in (
            "patient_home.html",
            "patient_scale.html",
            "patient_test.html",
            "patient_tracking.html",
            "patient_report.html",
            "clinical_pathway.html",
        ):
            self.assertTrue((legacy_web / name).is_file(), name)

        self.assertEqual([], sorted(path.name for path in ROOT.glob("*.htm*")))
        active_text = "\n".join(
            path.read_text(encoding="utf-8", errors="replace")
            for path in doctor_web.rglob("*")
            if path.is_file() and path.suffix.lower() in {".html", ".js"}
        )
        self.assertNotRegex(active_text, r"patient_[A-Za-z0-9_-]*\.html")
        self.assertNotIn("clinical_pathway.html", active_text)

        task_script = (doctor_web / "js" / "doctor_patients.js").read_text(encoding="utf-8")
        self.assertIn("'/pages/scale/index'", task_script)
        self.assertIn("'/pages/cognitive-center/index'", task_script)
        self.assertIn("'/pages/tracking/index'", task_script)
        self.assertIn("'/pages/report/index'", task_script)

    def test_doctor_report_renders_explicit_mock_disclaimer(self) -> None:
        html = (ROOT / "doctor-web" / "doctor_report.html").read_text(encoding="utf-8")
        script = (ROOT / "doctor-web" / "js" / "doctor_report.js").read_text(encoding="utf-8")

        self.assertIn('id="modelPredictionDemoNotice"', html)
        self.assertIn("prediction.is_demo", script)
        self.assertIn("prediction.disclaimer", script)
        self.assertIn("modelPredictionDemoNotice", script)
        self.assertIn("演示 Mock", script)


if __name__ == "__main__":
    unittest.main()
