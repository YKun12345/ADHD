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
        ["git", "ls-files", "-z"],
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
            if "-----BEGIN PRIVATE KEY-----" in text or "-----BEGIN RSA PRIVATE KEY-----" in text:
                violations.append(f"{relative}: private key")

            if path.name == ".env.example":
                continue
            for match in SECRET_ASSIGNMENT.finditer(text):
                name, value = match.groups()
                normalized = value.strip().lower()
                if normalized not in SAFE_EXAMPLE_VALUES:
                    violations.append(f"{relative}: unsafe default for {name}")

        self.assertEqual([], violations, "sensitive defaults: " + ", ".join(violations))


if __name__ == "__main__":
    unittest.main()
