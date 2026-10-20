"""Reviewed W02 schema planning against synthetic legacy stores only."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]


def legacy_store(tmp_path):
    business = tmp_path / "business-backup-boundary" / "legacy.db"
    business.parent.mkdir()
    ledger = tmp_path / "independent-authority" / "heads.db"
    with sqlite3.connect(business) as db:
        db.executescript("""
            CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL);
            CREATE TABLE patients (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
                                   researcher_id INTEGER, age INTEGER, patient_type TEXT);
            INSERT INTO users VALUES (1, 'Synthetic Legacy Owner'), (2, 'Synthetic Legacy Doctor');
            INSERT INTO patients VALUES (10, 1, 2, 26, 'adult');
        """)
    return business, ledger


def invoke(business, ledger, *flags):
    # The tool selects APP_ENV=migration before importing settings. The fixture
    # also supplies synthetic environment values and never loads backend/.env.
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools/plan-w02-schema.py"),
         "--database-url", f"sqlite:///{business.as_posix()}",
         "--authorization-ledger", str(ledger), *flags],
        cwd=ROOT, env=os.environ.copy(), text=True, encoding="utf-8",
        capture_output=True, timeout=45,
    )
    return result


def test_schema_plan_is_read_only_and_runtime_requires_explicit_upgrade(tmp_path):
    business, ledger = legacy_store(tmp_path)
    result = invoke(business, ledger)
    assert result.returncode == 0, result.stderr
    plan = json.loads(result.stdout)
    assert plan["requires_explicit_review"] is True
    assert "patient_access" in plan["missing_tables"]
    assert "consent_records" in plan["missing_tables"]
    assert any("ALTER TABLE patients ADD COLUMN display_name" in sql for sql in plan["statements"])
    assert not ledger.exists()
    with sqlite3.connect(business) as db:
        assert {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")} == {"users", "patients"}
        assert "display_name" not in {row[1] for row in db.execute("PRAGMA table_info(patients)")}
    from sqlalchemy import create_engine
    import backend.app.models  # Registers metadata; no runtime startup.
    from backend.app.db.identity_migration import require_identity_schema
    engine = create_engine(f"sqlite:///{business.as_posix()}")
    try:
        with pytest.raises(RuntimeError, match="explicit reviewed migration"):
            require_identity_schema(engine)
    finally:
        engine.dispose()


def test_reviewed_temporary_upgrade_is_repeatable_and_never_upgrades_old_binding(tmp_path):
    business, ledger = legacy_store(tmp_path)
    first = invoke(business, ledger, "--execute", "--reviewed")
    assert first.returncode == 0, first.stderr
    assert json.loads(first.stdout)["statements"]
    second = invoke(business, ledger, "--execute", "--reviewed")
    assert second.returncode == 0, second.stderr
    assert json.loads(second.stdout)["statements"] == []
    assert json.loads(second.stdout)["missing_tables"] == []
    with sqlite3.connect(business) as db:
        assert db.execute("SELECT id,user_id,researcher_id,age,patient_type,display_name FROM patients").fetchall() == [(10, 1, 2, 26, "adult", None)]
        assert db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 2
        for table in ("patient_access", "guardian_relationships", "care_relationships", "consent_records", "consent_authorities"):
            assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    with sqlite3.connect(ledger) as db:
        assert db.execute("SELECT COUNT(*) FROM authorization_heads").fetchone()[0] == 0


def test_temporary_upgrade_execution_requires_reviewed_flag(tmp_path):
    business, ledger = legacy_store(tmp_path)
    result = invoke(business, ledger, "--execute")
    assert result.returncode != 0
    assert "--reviewed" in result.stderr
    assert not ledger.exists()
    with sqlite3.connect(business) as db:
        assert {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")} == {"users", "patients"}
