from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_inside(root: Path, relative_path: str) -> Path:
    normalized = relative_path.replace("\\", "/")
    candidate = (root / normalized).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise ValueError(f"path escapes delivery root: {relative_path}") from error
    return candidate


def build_entries(root: Path, relative_paths: list[str]) -> list[dict]:
    entries: list[dict] = []
    for relative_path in sorted(set(relative_paths)):
        path = resolve_inside(root, relative_path)
        if not path.is_file():
            raise FileNotFoundError(f"tracked file is missing: {relative_path}")
        entries.append(
            {
                "path": relative_path.replace("\\", "/"),
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
            }
        )
    return entries


def verify_manifest(root: Path, manifest: dict, tracked_paths: set[str]) -> list[str]:
    failures: list[str] = []
    entries = manifest.get("files") or []
    expected_paths = {entry["path"] for entry in entries}
    normalized_tracked = {path.replace("\\", "/") for path in tracked_paths}

    for missing in sorted(expected_paths - normalized_tracked):
        failures.append(f"manifest file is not tracked: {missing}")
    for unexpected in sorted(normalized_tracked - expected_paths):
        failures.append(f"unexpected tracked file: {unexpected}")

    for entry in entries:
        relative_path = entry["path"]
        try:
            path = resolve_inside(root, relative_path)
        except ValueError as error:
            failures.append(str(error))
            continue
        if not path.is_file():
            failures.append(f"missing file: {relative_path}")
            continue
        actual_size = path.stat().st_size
        if actual_size != entry["size"]:
            failures.append(
                f"size mismatch: {relative_path} expected={entry['size']} actual={actual_size}"
            )
            continue
        actual_hash = sha256_file(path)
        if actual_hash != entry["sha256"]:
            failures.append(
                f"sha256 mismatch: {relative_path} expected={entry['sha256']} actual={actual_hash}"
            )
    return failures


def git(root: Path, *arguments: str, binary: bool = False):
    command = [
        "git",
        "-c",
        f"safe.directory={root.resolve().as_posix()}",
        "-C",
        str(root),
        *arguments,
    ]
    result = subprocess.run(command, check=True, capture_output=True)
    return result.stdout if binary else result.stdout.decode("utf-8").strip()


def tracked_files(root: Path) -> set[str]:
    output = git(root, "ls-files", "-z", binary=True)
    return {
        item.replace("\\", "/")
        for item in output.decode("utf-8", errors="surrogateescape").split("\0")
        if item
    }


def create_manifest(root: Path, output: Path) -> dict:
    root = root.resolve()
    output = output.resolve()
    output_relative = output.relative_to(root).as_posix()
    paths = tracked_files(root)
    paths.discard(output_relative)
    content_commit = git(root, "rev-parse", "HEAD")
    manifest = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "content_commit": content_commit,
        "manifest_path": output_relative,
        "scope": "All Git-tracked files at content_commit, excluding this manifest file.",
        "file_count": len(paths),
        "files": build_entries(root, list(paths)),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create or verify an AB delivery manifest.")
    parser.add_argument("action", choices=("create", "verify"))
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("docs/evidence/delivery-manifest.json"),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    manifest_path = args.manifest
    if not manifest_path.is_absolute():
        manifest_path = root / manifest_path

    if args.action == "create":
        manifest = create_manifest(root, manifest_path)
        print(f"content_commit={manifest['content_commit']}")
        print(f"file_count={manifest['file_count']}")
        print(f"manifest={manifest_path}")
        return 0

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tracked = tracked_files(root)
    tracked.discard(manifest_path.resolve().relative_to(root).as_posix())
    failures = verify_manifest(root, manifest, tracked)
    if failures:
        for failure in failures:
            print(f"ERROR {failure}")
        return 1
    print(f"verified_files={len(manifest['files'])}")
    print(f"content_commit={manifest['content_commit']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
