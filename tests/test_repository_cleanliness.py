from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

FORBIDDEN_PARTS = {
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    "tmp",
    "downloads",
}
FORBIDDEN_PREFIXES = {"logs/", "backend/logs/", "findviz/logs/"}
FORBIDDEN_NAMES = {".env", "app.db"}
FORBIDDEN_SUFFIXES = {".pyc", ".pyo", ".pt", ".pth", ".ckpt"}
REQUIRED_IGNORE_RULES = {
    ".env",
    ".venv/",
    "venv/",
    "node_modules/",
    "__pycache__/",
    "*.py[cod]",
    ".pytest_cache/",
    "backend/app.db",
    "backend/uploads/",
    "backend/artifacts/",
    "logs/",
    "tmp/",
    "downloads/",
    "*.pt",
    "*.pth",
    "*.ckpt",
}
TEXT_SUFFIXES = {
    ".env",
    ".example",
    ".html",
    ".htm",
    ".js",
    ".json",
    ".md",
    ".py",
    ".ps1",
    ".sh",
    ".sql",
    ".txt",
    ".wxml",
    ".wxss",
    ".yaml",
    ".yml",
}
SECRET_ASSIGNMENT = re.compile(
    r"(?im)^\s*(SECRET_KEY|QWEN_API_KEY|MYSQL_PASSWORD)\s*(?::\s*str\s*)?=\s*"
    r"(?:os\.getenv\([^,\n]+,\s*)?[\"']([^\"']*)[\"']"
)
SAFE_EXAMPLE_VALUES = {"", "placeholder", "change-me", "example"}


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "-c", f"safe.directory={ROOT.as_posix()}", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    names = result.stdout.decode("utf-8", errors="surrogateescape").split("\0")
    return [ROOT / name for name in names if name]


class RepositoryCleanlinessTests(unittest.TestCase):
    def test_runtime_and_dependency_artifacts_are_not_tracked(self) -> None:
        violations: list[str] = []
        for path in tracked_files():
            relative = path.relative_to(ROOT)
            relative_posix = relative.as_posix().lower()
            lowered_parts = {part.lower() for part in relative.parts}
            if (
                lowered_parts & FORBIDDEN_PARTS
                or any(relative_posix.startswith(prefix) for prefix in FORBIDDEN_PREFIXES)
            ):
                violations.append(relative.as_posix())
                continue
            if path.name.lower() in FORBIDDEN_NAMES:
                violations.append(relative.as_posix())
                continue
            if path.suffix.lower() in FORBIDDEN_SUFFIXES:
                violations.append(relative.as_posix())

        self.assertEqual([], violations, "prohibited tracked files: " + ", ".join(violations))

    def test_gitignore_covers_all_runtime_boundaries(self) -> None:
        rules = {
            line.strip()
            for line in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        missing = sorted(REQUIRED_IGNORE_RULES - rules)
        self.assertEqual([], missing, "missing .gitignore rules: " + ", ".join(missing))

    def test_tracked_text_has_no_private_keys_or_real_secret_defaults(self) -> None:
        violations: list[str] = []
        for path in tracked_files():
            if path.suffix.lower() not in TEXT_SUFFIXES and path.name != ".env.example":
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            relative = path.relative_to(ROOT).as_posix()
            private_key_marker = "-----BEGIN " + "PRIVATE KEY-----"
            rsa_key_marker = "-----BEGIN RSA " + "PRIVATE KEY-----"
            if private_key_marker in text or rsa_key_marker in text:
                violations.append(f"{relative}: private key")

            if path.name == ".env.example":
                continue
            for match in SECRET_ASSIGNMENT.finditer(text):
                name, value = match.groups()
                normalized = value.strip().lower()
                if normalized not in SAFE_EXAMPLE_VALUES:
                    violations.append(f"{relative}: unsafe default for {name}")

        self.assertEqual([], violations, "sensitive defaults: " + ", ".join(violations))

    def test_one_authoritative_env_example_documents_backend_settings(self) -> None:
        config_text = (ROOT / "backend" / "app" / "core" / "config.py").read_text(encoding="utf-8")
        expected = set(re.findall(r'os\.getenv\("([A-Z0-9_]+)"', config_text))
        env_text = (ROOT / ".env.example").read_text(encoding="utf-8")
        documented = set(re.findall(r"(?m)^([A-Z][A-Z0-9_]*)=", env_text))

        self.assertEqual([], sorted(expected - documented))
        self.assertFalse((ROOT / "backend" / ".env.example").exists())

    def test_current_guides_use_portable_commands_and_current_web_paths(self) -> None:
        guide_paths = [
            ROOT / "README.md",
            ROOT / "backend" / "README.md",
            ROOT / "backend" / "docs" / "后端技术实现.md",
            ROOT / "backend" / "docs" / "内网访问方案.md",
            ROOT / "doctor-web" / "README.md",
        ]
        guide_paths.extend((ROOT / "docs" / "evidence").glob("manual-acceptance.md"))
        active_text = "\n".join(path.read_text(encoding="utf-8") for path in guide_paths)

        self.assertNotRegex(active_text, r"(?i)[A-Z]:\\Python\\")
        self.assertNotRegex(active_text, r"\.venv[\\/]Scripts[\\/]python\.exe")
        self.assertNotRegex(active_text, r"127\.0\.0\.1:8000/(?:login|doctor_|dac_dashboard)")
        self.assertIn("http://127.0.0.1:8000/doctor-web/", active_text)

        root_readme = guide_paths[0].read_text(encoding="utf-8")
        for required in (
            "python -m venv .venv",
            "pip install -r requirements.txt",
            "python -m backend.create_tables",
            "python -m backend.scripts.seed_demo_data",
            "uvicorn backend.app.main:app",
            "miniprogram/project.config.json",
            "演示 Mock",
            "医学有效性",
        ):
            self.assertIn(required, root_readme)

    def test_mysql_bootstrap_defers_foreign_key_tables_to_sqlalchemy(self) -> None:
        sql = (ROOT / "backend" / "sql" / "init_mysql.sql").read_text(encoding="utf-8")
        self.assertIn("CREATE DATABASE IF NOT EXISTS", sql)
        self.assertNotIn("CREATE TABLE IF NOT EXISTS `uploads`", sql)
        self.assertIn("python -m backend.create_tables", sql)


if __name__ == "__main__":
    unittest.main()
