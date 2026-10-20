"""Package the approved plan and its local link closure, without runtime data.

Source documents stay byte-for-byte unchanged. Only machine-specific local links
in packaged Markdown copies become relative links. No Git staging is performed.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
PRIMARY = [f"docs/{name}-2026-10-13.md" for name in (
    "项目升级最终计划", "项目升级实施工作包", "联邦研究工程附录-最终版", "项目升级方案审查报告")]
LINK = re.compile(r"(?P<prefix>!?\[[^\]\n]*\]\()(?P<target>[^)\n]+)(?P<end>\))")
ALLOWED = {".md", ".json", ".txt", ".py", ".js", ".cjs", ".html", ".htm", ".css", ".ps1", ".yml", ".yaml", ".toml", ".cmd", ".png", ".jpg", ".svg", ".wxml", ".wxss", ".sql", ".sh", ".bat", ".conf", ".log", ".ttf", ".woff2"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def resolve_link(source, raw):
    target = unquote(raw.strip().strip("<>"))
    if re.match(r"^(https?://|mailto:|#)", target):
        return None, target
    line = re.search(r":(\d+)$", target)
    # Ordinary file links cannot resolve Codex's :line syntax or GitHub #L anchors.
    # Keep the original link in the manifest and open the portable target file.
    suffix = ""
    if line:
        target = target[:line.start()]
    target, sep, anchor = target.partition("#")
    suffix = ("#" + anchor) if sep else suffix
    path = Path(target)
    resolved = (path if path.is_absolute() else source.parent / path).resolve()
    resolved.relative_to(ROOT)
    if not resolved.is_file():
        raise FileNotFoundError(f"{source.relative_to(ROOT)} -> {raw}")
    allowed = resolved.suffix.lower() in ALLOWED or (resolved.name.startswith('.env.') and resolved.name.endswith('.example')) or resolved.name in {'.dockerignore', '.gitignore', '.env.example', 'Dockerfile'}
    runtime = resolved.suffix.lower() in {'.db', '.sqlite', '.pt', '.pth', '.pkl', '.npy', '.npz'} or resolved.name == '.env' or any(part in {'.keys', 'uploads'} for part in resolved.parts)
    if runtime:
        return resolved, "RUNTIME_OMITTED"
    if not allowed or any(part in {".git", ".venv"} for part in resolved.parts):
        raise ValueError(f"not a permitted document/source reference: {raw}")
    return resolved, suffix


def main():
    ignored = subprocess.run(["git", "check-ignore", "--", *PRIMARY], cwd=ROOT, capture_output=True)
    if ignored.returncode not in (0, 1) or ignored.stdout:
        raise RuntimeError(f"Normative document is ignored or Git check failed: {ignored.stdout!r} {ignored.stderr!r}")
    pending = [ROOT / p for p in PRIMARY]
    originals, packaged, links, omitted = {}, {}, [], []
    while pending:
        source = pending.pop()
        name = source.relative_to(ROOT).as_posix()
        if name in packaged:
            continue
        data = source.read_bytes()
        originals[name] = {"bytes": len(data), "sha256": digest(data)}
        if source.suffix == ".md":
            def replace(match):
                target, suffix = resolve_link(source, match["target"])
                if target is None:
                    return match[0]
                if suffix == 'RUNTIME_OMITTED':
                    entry = {"source": name, "target": target.relative_to(ROOT).as_posix()}
                    omitted.append(entry)
                    target = ROOT / 'docs/runtime-references.md'
                    suffix = ''
                else:
                    pending.append(target)
                relative = os.path.relpath(target, source.parent).replace("\\", "/") + suffix
                links.append({"source": name, "original_link": match['target'], "target": target.relative_to(ROOT).as_posix(), "packaged_link": relative})
                return match["prefix"] + relative + match["end"]
            data = LINK.sub(replace, data.decode("utf-8-sig")).encode("utf-8")
        packaged[name] = data
    if omitted:
        packaged['docs/runtime-references.md'] = ('# 运行资料引用边界\n\n这些旧阅读索引引用运行数据库或模型原件。本包没有读取或复制这些内容；真实资料操作需要另行授权。源码规范仍以最终总计划为准。\n\n' +
            '\n'.join(f"- `{entry['target']}`（引用自 `{entry['source']}`）" for entry in omitted) + '\n').encode('utf-8')
    manifest = {"schema": 1, "generated_at": datetime.now(timezone.utc).isoformat(),
        "scope": "Approved normative plans plus transitive local Markdown link targets; no runtime databases, secrets, uploads or model binaries",
        "primary": PRIMARY, "normative_not_ignored": True, "source_files_unchanged": True,
        "link_count": len(links), "links": links, "omitted_runtime_references": omitted,
        "files": [{"path": name, "source": originals.get(name), "packaged": {"bytes": len(data), "sha256": digest(data)}}
                  for name, data in sorted(packaged.items())]}
    output = ROOT / "docs/evidence/w01-plan-delivery.zip"
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(packaged.items()):
            archive.writestr(name, data)
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(output) as archive:
        for entry in manifest["files"]:
            assert digest(archive.read(entry["path"])) == entry["packaged"]["sha256"]
            if entry['source']:
                assert digest((ROOT / entry["path"]).read_bytes()) == entry["source"]["sha256"]
        assert all(link["target"] in archive.namelist() for link in links)
        assert all(p in archive.namelist() for p in PRIMARY)
    manifest["archive"] = {"path": output.relative_to(ROOT).as_posix(), "sha256": digest(output.read_bytes()),
        "verified_files": len(packaged), "all_local_links_resolve_inside_archive": True}
    (output.parent / "w01-plan-delivery-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"normative": len(PRIMARY), "verified_files": len(packaged), "local_links": len(links),
                      "not_ignored": True, "archive": str(output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
