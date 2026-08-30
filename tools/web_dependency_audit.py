from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit


HTML_REFERENCE = re.compile(r"\b(href|src)\s*=\s*['\"]([^'\"]+)['\"]", re.IGNORECASE)
CSS_REFERENCE = re.compile(r"\burl\(\s*['\"]?([^'\")]+)", re.IGNORECASE)
FETCH_REFERENCE = re.compile(r"\bfetch\s*\(\s*['\"]([^'\"]+)['\"]", re.IGNORECASE)
XHR_REFERENCE = re.compile(
    r"\.open\s*\(\s*['\"][A-Z]+['\"]\s*,\s*['\"]([^'\"]+)['\"]",
    re.IGNORECASE,
)
SCANNED_SUFFIXES = {".html", ".htm", ".css", ".js"}
IGNORED_SCHEMES = {"data", "http", "https", "mailto", "tel", "javascript", "blob"}
IGNORED_DIRECTORIES = {".git", ".venv", "venv", "node_modules", "__pycache__"}


def extract_references(path: Path, text: str) -> list[tuple[str, str]]:
    if path.suffix.lower() in {".html", ".htm"}:
        return [(match.group(2), "html") for match in HTML_REFERENCE.finditer(text)]
    if path.suffix.lower() == ".css":
        return [(match.group(1), "css") for match in CSS_REFERENCE.finditer(text)]
    if path.suffix.lower() == ".js":
        references = [(match.group(1), "fetch") for match in FETCH_REFERENCE.finditer(text)]
        references.extend((match.group(1), "xhr") for match in XHR_REFERENCE.finditer(text))
        return references
    return []


def is_external(reference: str) -> bool:
    stripped = reference.strip()
    if not stripped or stripped.startswith(("#", "//")):
        return True
    if any(marker in stripped for marker in ("{{", "}}", "${")):
        return True
    parsed = urlsplit(stripped)
    return parsed.scheme.lower() in IGNORED_SCHEMES


def resolve_reference(root: Path, source: Path, reference: str) -> tuple[str | None, bool, str]:
    parsed = urlsplit(reference.strip())
    clean_path = unquote(parsed.path).replace("\\", "/")
    if clean_path.startswith("/api/") or clean_path == "/api":
        return None, True, "api"

    if clean_path.startswith("/"):
        target = root / clean_path.lstrip("/")
    else:
        target = source.parent / clean_path
    resolved = target.resolve()
    try:
        relative = resolved.relative_to(root).as_posix()
    except ValueError:
        return str(resolved), False, "outside-root"
    return relative, resolved.exists(), "local"


def audit(root: Path, excluded_prefixes: tuple[str, ...]) -> dict:
    resolved_root = root.resolve()
    references: list[dict] = []
    scanned_files = 0

    for source in sorted(resolved_root.rglob("*")):
        if not source.is_file() or source.suffix.lower() not in SCANNED_SUFFIXES:
            continue
        relative_source = source.relative_to(resolved_root).as_posix()
        parts = set(source.relative_to(resolved_root).parts)
        if parts & IGNORED_DIRECTORIES:
            continue
        if any(
            relative_source == prefix or relative_source.startswith(prefix.rstrip("/") + "/")
            for prefix in excluded_prefixes
        ):
            continue

        scanned_files += 1
        try:
            text = source.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = source.read_text(encoding="utf-8", errors="replace")

        for reference, source_kind in extract_references(source, text):
            if is_external(reference):
                continue
            target, exists, resolved_kind = resolve_reference(resolved_root, source, reference)
            references.append(
                {
                    "source": relative_source,
                    "reference": reference,
                    "resolved_target": target,
                    "exists": exists,
                    "kind": resolved_kind if resolved_kind != "local" else source_kind,
                }
            )

    references.sort(key=lambda item: (item["source"], item["reference"], item["kind"]))
    missing_count = sum(
        1 for item in references if not item["exists"] and item["kind"] != "api"
    )
    return {
        "schema_version": 1,
        "root": str(resolved_root),
        "excluded_prefixes": list(excluded_prefixes),
        "scanned_files": scanned_files,
        "missing_count": missing_count,
        "references": references,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit local Web file dependencies.")
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--exclude", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        raise SystemExit(f"Web root does not exist: {root}")
    report = audit(root, tuple(item.replace("\\", "/").strip("/") for item in args.exclude))
    report["root"] = args.root.as_posix()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"scanned_files={report['scanned_files']}")
    print(f"references={len(report['references'])}")
    print(f"missing_count={report['missing_count']}")
    return 1 if report["missing_count"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
