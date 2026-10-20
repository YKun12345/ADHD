"""Synthetic legacy data only; never reads backend/app.db or development .env."""
import hashlib
import importlib.util
from pathlib import Path
import sqlite3

import pytest

ROOT = Path(__file__).resolve().parents[2]


def upgrade_module():
    spec = importlib.util.spec_from_file_location('explicit_sqlite_upgrade', ROOT / 'tools/upgrade-project-sqlite.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def legacy_store(tmp_path, monkeypatch):
    from sqlalchemy import create_engine
    import backend.app.models
    from backend.app.db.base import Base
    from backend.app.core.config import settings
    from backend.app.core.data_encryption import encrypt_value
    monkeypatch.setattr(settings, 'DATA_ENCRYPTION_KEY', 'dGVzdC1rZXktMzItYnl0ZXMtaXNvbGF0ZWQtMDAwMDE=')
    path = tmp_path / 'legacy-synthetic.db'
    engine = create_engine('sqlite:///' + path.as_posix())
    Base.metadata.tables['users'].create(engine)
    Base.metadata.tables['patients'].create(engine)
    engine.dispose()
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO users(id,email,full_name,password_hash,role,consent_agreed,is_active,created_at) VALUES(1,'synthetic@example.org',?,'unchanged-password-hash','PATIENT',1,1,'2026-01-01')", (encrypt_value('Synthetic only','users.full_name'),))
        db.execute("INSERT INTO patients(id,user_id,age,patient_type,created_at) VALUES(2,1,26,'ADULT','2026-01-01')")
        db.execute('CREATE TABLE scale_results(id INTEGER PRIMARY KEY,patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,scale_type VARCHAR(32) NOT NULL,total_score TEXT NOT NULL,risk_level TEXT NOT NULL,score_json TEXT NOT NULL,created_at DATETIME NOT NULL)')
        db.execute("INSERT INTO scale_results VALUES(3,2,'ASRS',?,?,?,'2026-01-01')", tuple(encrypt_value(value, 'scale_results.' + field) for field,value in [('total_score',12),('risk_level','low'),('score_json',{'synthetic':True,'answers':[0,1,2]})]))
    return path


def test_copy_upgrade_preserves_old_records_and_never_invents_authority(tmp_path, monkeypatch):
    source = legacy_store(tmp_path, monkeypatch)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    module = upgrade_module()
    receipt = module.prepare_upgraded_copy(source, tmp_path / 'work', tmp_path / 'backups')
    assert receipt['logical_content_preserved'] is True
    assert receipt['foreign_key_issues'] == 0
    assert receipt['converted_rows'] == 1
    assert receipt['missing_schema_after'] == {}
    assert receipt['backup_restore_verified'] is True
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    with sqlite3.connect(receipt['upgraded_path']) as db:
        assert db.execute('SELECT id,patient_id,legacy,assessment_id,envelope_status FROM scale_results').fetchone() == (3,2,1,None,'migrated_from_legacy')
        for table in ('consent_records','patient_access','doctor_qualifications','institution_memberships'):
            assert db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] == 0
        assert db.execute('SELECT password_hash FROM users').fetchone()[0] == 'unchanged-password-hash'


def test_repeated_upgrade_has_no_new_conversion(tmp_path, monkeypatch):
    source = legacy_store(tmp_path, monkeypatch)
    module = upgrade_module()
    first = module.prepare_upgraded_copy(source, tmp_path/'first', tmp_path/'backups1')
    second = module.prepare_upgraded_copy(Path(first['upgraded_path']), tmp_path/'second', tmp_path/'backups2')
    assert second['converted_rows'] == 0
    assert second['logical_content_preserved'] is True
    assert second['new_tables'] == [] and second['added_columns'] == []


def test_corrupt_legacy_cipher_keeps_source_unchanged(tmp_path, monkeypatch):
    source = legacy_store(tmp_path, monkeypatch)
    with sqlite3.connect(source) as db:
        db.execute("UPDATE scale_results SET score_json='aesgcm:v1:broken'")
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    with pytest.raises(Exception):
        upgrade_module().prepare_upgraded_copy(source, tmp_path/'work', tmp_path/'backups')
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before


def test_backup_manifest_can_be_finalized_after_adding_resources(tmp_path, monkeypatch):
    legacy_store(tmp_path, monkeypatch)
    from backend.app.db.encryption_migration import _write_backup, _write_manifest, restore_backup
    backup=tmp_path/'bundle'; backup.mkdir()
    _write_backup(backup,'database-before-upgrade.db',b'synthetic-db-only')
    _write_manifest(backup)
    _write_backup(backup,'backend.env',b'SYNTHETIC_ONLY=true')
    _write_manifest(backup)
    restored=tmp_path/'restored'
    assert restore_backup(backup,restored)==2
    assert (restored/'backend.env').read_bytes()==b'SYNTHETIC_ONLY=true'
