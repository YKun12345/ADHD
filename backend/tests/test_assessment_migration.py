"""Only explicitly selected temporary legacy databases are used here."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]


def store(tmp_path):
    path = tmp_path / "w03-legacy.db"
    with sqlite3.connect(path) as db:
        db.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE patients (id INTEGER PRIMARY KEY, age INTEGER, patient_type TEXT);
        CREATE TABLE patient_tasks (id INTEGER PRIMARY KEY, patient_id INTEGER, researcher_id INTEGER, status TEXT);
        CREATE TABLE scale_results (id INTEGER PRIMARY KEY, patient_id INTEGER, score_json TEXT);
        CREATE TABLE cognitive_tests (id INTEGER PRIMARY KEY, patient_id INTEGER, result_json TEXT);
        INSERT INTO users VALUES (1),(2);
        INSERT INTO patients VALUES (10,26,'adult');
        INSERT INTO patient_tasks VALUES (20,10,2,'COMPLETED');
        INSERT INTO scale_results VALUES (30,10,'synthetic-old-scale');
        INSERT INTO cognitive_tests VALUES (40,10,'synthetic-old-cognitive');
        """)
    return path


def invoke(path, *flags):
    environment = {**os.environ, "PYTHONUTF8":"1", "PYTHONIOENCODING":"utf-8"}
    return subprocess.run([sys.executable,str(ROOT / "tools/plan-w03-schema.py"),"--database-url",f"sqlite:///{path.as_posix()}",*flags], cwd=ROOT, env=environment, capture_output=True, text=True, encoding="utf-8", timeout=45)


def test_w03_migration_read_only_plan_and_explicit_review(tmp_path):
    path = store(tmp_path)
    initial = path.read_bytes()
    result = invoke(path)
    assert result.returncode == 0, result.stderr
    plan = json.loads(result.stdout)
    assert set(plan["missing_tables"]) == {"assessment_sessions","assessment_items","task_attempts"}
    assert plan["requires_explicit_review"] is True
    assert path.read_bytes() == initial
    refused = invoke(path,"--execute")
    assert refused.returncode != 0 and "--reviewed" in refused.stderr
    assert path.read_bytes() == initial


def test_w03_temporary_migration_repeatable_preserves_unknown_history(tmp_path):
    path = store(tmp_path)
    first = invoke(path,"--execute","--reviewed")
    assert first.returncode == 0, first.stderr
    second = invoke(path,"--execute","--reviewed")
    assert second.returncode == 0, second.stderr
    assert json.loads(second.stdout)["statements"] == []
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT id,patient_id,researcher_id,status,assessment_id,assessment_item_id,legacy FROM patient_tasks").fetchall() == [(20,10,2,"COMPLETED",None,None,1)]
        assert db.execute("SELECT id,score_json,assessment_id,assessment_item_id,task_attempt_id,legacy FROM scale_results").fetchall() == [(30,"synthetic-old-scale",None,None,None,1)]
        assert db.execute("SELECT id,result_json,assessment_id,assessment_item_id,task_attempt_id,legacy FROM cognitive_tests").fetchall() == [(40,"synthetic-old-cognitive",None,None,None,1)]
        for table in ("assessment_sessions","assessment_items","task_attempts"):
            assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_non_test_startup_requires_reviewed_w03_schema_without_mutating_it(tmp_path,monkeypatch):
    from sqlalchemy import create_engine
    from backend.app.db import init_db, identity_migration
    from backend.app.core.config import settings
    path = store(tmp_path)
    engine = create_engine(f"sqlite:///{path.as_posix()}")
    original = path.read_bytes()
    monkeypatch.setattr(init_db,"engine",engine)
    monkeypatch.setattr(settings,"APP_ENV","production")
    monkeypatch.setattr(identity_migration,"require_identity_schema",lambda engine:None)
    try:
        with pytest.raises(RuntimeError,match="W03.*explicit reviewed migration"):
            init_db.init_db()
        assert path.read_bytes() == original
    finally:
        engine.dispose()


def test_partial_w03_table_columns_fail_closed_without_inventing_performer(tmp_path):
    from sqlalchemy import create_engine
    import backend.app.models
    from backend.app.db.base import Base
    from backend.app.db.assessment_migration import require_assessment_schema
    engine = create_engine(f"sqlite:///{(tmp_path / 'partial-w03.db').as_posix()}")
    try:
        Base.metadata.create_all(engine)
        with engine.begin() as db:
            db.exec_driver_sql("DROP TABLE task_attempts")
            db.exec_driver_sql("CREATE TABLE task_attempts (id INTEGER PRIMARY KEY)")
        with pytest.raises(RuntimeError,match="W03.*explicit reviewed migration"):
            require_assessment_schema(engine)
    finally:
        engine.dispose()
