"""Idempotent, backed-up conversion of legacy cleartext storage."""

from __future__ import annotations
import json
import hashlib
import hmac
from datetime import datetime, timezone
from pathlib import Path
from sqlalchemy import inspect, text
from backend.app.core.data_encryption import (
    EncryptedValue,
    PREFIX,
    FILE_MAGIC,
    master_key,
    encrypt_value,
    encrypt_bytes,
    decrypt_bytes,
)
from backend.app.db.base import Base

BACKUP_ROOT = Path(__file__).resolve().parents[2] / "migration-backups"


def migrate_sensitive_storage(engine) -> dict:
    master_key()
    candidates = []
    dialect = engine.dialect.name
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    schema_changes = []
    for table in Base.metadata.sorted_tables:
        if table.name not in tables:
            continue
        for column in table.columns:
            if not isinstance(column.type, EncryptedValue):
                continue
            if dialect == "mysql":
                actual = {
                    c["name"]: c["type"] for c in inspector.get_columns(table.name)
                }
                if str(actual.get(column.name)).upper() != "LONGTEXT":
                    schema_changes.append((table.name, column.name, column.nullable))
            with engine.connect() as conn:
                rows = conn.execute(
                    text(
                        f"SELECT id, {column.name} FROM {table.name} WHERE {column.name} IS NOT NULL"
                    )
                ).all()
            for row_id, value in rows:
                if not (isinstance(value, str) and value.startswith(PREFIX)):
                    candidates.append(
                        (
                            table.name,
                            column.name,
                            row_id,
                            column.type.legacy_value(value),
                            column.type.context,
                        )
                    )
    from backend.app.core.config import settings

    upload_root = Path(settings.UPLOAD_ROOT).expanduser().resolve()
    legacy_files = []
    upload_files = set()
    if "uploads" in tables:
        with engine.connect() as conn:
            paths = (
                conn.execute(
                    text(
                        "SELECT stored_path FROM uploads WHERE stored_path IS NOT NULL"
                    )
                )
                .scalars()
                .all()
            )
        for stored in paths:
            target = Path(stored).resolve()
            if not target.is_relative_to(upload_root):
                raise RuntimeError(
                    "Legacy upload path is outside UPLOAD_ROOT; migration aborted."
                )
            if target.is_file():
                if target in upload_files:
                    continue
                upload_files.add(target)
                with target.open("rb") as inp:
                    magic = inp.read(len(FILE_MAGIC))
                if magic != FILE_MAGIC:
                    legacy_files.append(target)
    if not candidates and not legacy_files and not schema_changes:
        return {"encrypted_values": 0, "encrypted_files": 0}
    backup = BACKUP_ROOT / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup.mkdir(parents=True, exist_ok=False)
    if dialect == "sqlite":
        import sqlite3
        from contextlib import closing

        raw = engine.raw_connection()
        try:
            with closing(sqlite3.connect(":memory:")) as out:
                raw.driver_connection.backup(out)
                snapshot = out.serialize()
            _write_backup(backup, "database-before-encryption.db", snapshot)
        finally:
            raw.close()
    else:
        with engine.connect() as conn:
            raw_tables = {
                table: list(
                    map(
                        dict,
                        conn.execute(text(f"SELECT * FROM {table}")).mappings().all(),
                    )
                )
                for table in sorted(tables)
            }
        _write_backup(
            backup,
            "database-before-encryption.json",
            json.dumps(raw_tables, ensure_ascii=False, default=str).encode("utf8"),
        )
    for target in sorted(upload_files):
        _write_backup(
            backup,
            "uploads/" + target.relative_to(upload_root).as_posix(),
            target.read_bytes(),
        )
    _write_manifest(backup)
    if schema_changes:
        with engine.begin() as conn:
            for table, column, is_nullable in schema_changes:
                nullable = "NULL" if is_nullable else "NOT NULL"
                conn.exec_driver_sql(
                    f"ALTER TABLE {table} MODIFY COLUMN {column} LONGTEXT {nullable}"
                )
    prepared = [
        (t, c, i, encrypt_value(v, context)) for t, c, i, v, context in candidates
    ]
    with engine.begin() as conn:
        for table, column, row_id, envelope in prepared:
            conn.execute(
                text(f"UPDATE {table} SET {column}=:value WHERE id=:id"),
                {"value": envelope, "id": row_id},
            )
    for target in legacy_files:
        temporary = target.with_name(target.name + ".encrypting")
        temporary.write_bytes(
            FILE_MAGIC + encrypt_bytes(target.read_bytes(), "upload:" + target.name)
        )
        temporary.replace(target)
    return {
        "encrypted_values": len(candidates),
        "encrypted_files": len(legacy_files),
        "schema_changes": len(schema_changes),
        "backup_directory": str(backup),
    }


def _write_backup(directory: Path, relative: str, content: bytes) -> None:
    destination = directory / (relative + ".enc")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(
        FILE_MAGIC + encrypt_bytes(content, "migration-backup:" + relative)
    )


MANIFEST_NAME = "backup-manifest.json.enc"
MANIFEST_CONTEXT = "migration-backup:backup-manifest.json"


def _write_manifest(directory: Path) -> None:
    files = []
    for source in sorted(directory.rglob("*.enc")):
        payload = source.read_bytes()
        files.append(
            {
                "path": source.relative_to(directory).as_posix(),
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        )
    content = json.dumps({"version": 1, "files": files}, sort_keys=True).encode("utf8")
    _write_backup(directory, "backup-manifest.json", content)


def _backup_path(directory: Path, relative: str) -> Path:
    # Validate independently of authentication so an invalid manifest cannot write outside its root.
    if not isinstance(relative, str) or not relative.endswith(".enc"):
        raise ValueError("Invalid backup component path.")
    segments = relative.split("/")
    if (
        any(part in ("", ".", "..") for part in segments)
        or "\\" in relative
        or ":" in relative
    ):
        raise ValueError("Unsafe backup component path.")
    target = directory.joinpath(*segments)
    if target.is_symlink() or not target.resolve().is_relative_to(directory):
        raise ValueError("Backup component escapes its directory.")
    return target


def restore_backup(directory: Path, destination: Path) -> int:
    """Authenticate the complete backup before writing to a new empty directory."""
    directory = directory.resolve()
    destination = destination.resolve()
    if destination.exists() and (
        not destination.is_dir() or any(destination.iterdir())
    ):
        raise ValueError("Restore destination must be a new or empty directory.")
    manifest_file = directory / MANIFEST_NAME
    if not manifest_file.is_file() or manifest_file.is_symlink():
        raise ValueError("Authenticated backup manifest is missing.")
    manifest_payload = manifest_file.read_bytes()
    if not manifest_payload.startswith(FILE_MAGIC):
        raise ValueError("Invalid backup manifest format.")
    manifest = json.loads(
        decrypt_bytes(manifest_payload[len(FILE_MAGIC) :], MANIFEST_CONTEXT)
    )
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise ValueError("Unsupported backup manifest.")
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Backup manifest contains no components.")
    expected = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Invalid backup manifest entry.")
        relative = entry.get("path")
        _backup_path(directory, relative)
        if relative == MANIFEST_NAME or relative in expected:
            raise ValueError("Duplicate or invalid backup component.")
        if type(entry.get("size")) is not int or entry["size"] <= len(FILE_MAGIC):
            raise ValueError("Invalid backup component size.")
        if not isinstance(entry.get("sha256"), str) or len(entry["sha256"]) != 64:
            raise ValueError("Invalid backup component digest.")
        expected[relative] = entry
    actual = {p.relative_to(directory).as_posix() for p in directory.rglob("*.enc")}
    if actual != set(expected) | {MANIFEST_NAME}:
        raise ValueError("Backup components do not match the authenticated manifest.")
    prepared = []
    for relative, entry in expected.items():
        source = _backup_path(directory, relative)
        payload = source.read_bytes()
        if not payload.startswith(FILE_MAGIC):
            raise ValueError("Invalid backup component format.")
        original_relative = relative[:-4]
        content = decrypt_bytes(
            payload[len(FILE_MAGIC) :], "migration-backup:" + original_relative
        )
        if len(payload) != entry["size"] or not hmac.compare_digest(
            hashlib.sha256(payload).hexdigest(), entry["sha256"]
        ):
            raise ValueError(
                "Backup component differs from the authenticated manifest."
            )
        prepared.append((original_relative, content))
    destination.mkdir(parents=True, exist_ok=True)
    for relative, content in prepared:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return len(prepared)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Restore encrypted migration backups to a new directory."
    )
    parser.add_argument("--restore", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    print({"restored_files": restore_backup(args.restore, args.destination)})
