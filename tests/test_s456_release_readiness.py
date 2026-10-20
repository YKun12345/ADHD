"""Release checks must not turn configuration presence into deployment evidence."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'tools/nonfederated-release-readiness.py'


def run_check(tmp_path, *args, values=None):
    assert TOOL.is_file(), 'The offline release readiness command is missing'
    config = tmp_path / 'selected.env'
    config.write_text('\n'.join(f'{key}={value}' for key, value in (values or {}).items()), encoding='utf8')
    result = subprocess.run([sys.executable, str(TOOL), '--env-file', str(config), *map(str, args)],
        cwd=ROOT, env={**os.environ, 'DATABASE_URL': 'sqlite:///MUST-NOT-CREATE.db',
            'WECHAT_APP_SECRET': 'MUST-NOT-LEAK-OR-OVERRIDE'}, capture_output=True, text=True, encoding='utf8')
    return result, json.loads(result.stdout)


def test_default_checks_do_not_connect_or_echo_secrets(tmp_path):
    result, report = run_check(tmp_path)
    assert result.returncode == 2
    assert report['checks']['database_schema']['status'] == 'not_checked'
    assert report['checks']['live_database_credentials']['status'] == 'not_checked'
    assert report['checks']['wechat_live_delivery']['status'] == 'not_checked'
    assert report['checks']['wechat_configuration']['configured']['app_secret'] is False
    assert not (ROOT / 'MUST-NOT-CREATE.db').exists()
    assert 'MUST-NOT-LEAK' not in result.stdout + result.stderr
    assert report['effects'] == {'database_writes': False, 'network_requests': False,
        'weights_loaded': False, 'workers_started': False, 'activation_performed': False}


def test_present_synthetic_credentials_never_claim_verified_delivery(tmp_path):
    result, report = run_check(tmp_path, values={
        'APP_ENV': 'production', 'SECRET_KEY': 'synthetic-signing-secret-0123456789abcdef',
        'DATA_ENCRYPTION_KEY': 'c3ludGhldGljLW9ubHkta2V5LTAxMjM0NTY3ODkwMTI=',
        'DATABASE_URL': 'mysql+pymysql://synthetic:synthetic-password@db.invalid/test',
        'PUBLIC_API_BASE_URL': 'https://api.example.invalid',
        'WECHAT_APP_ID': 'wx0123456789abcdef', 'WECHAT_APP_SECRET': 'synthetic-private-value',
        'WECHAT_SUBSCRIBE_TEMPLATE_ID': 'synthetic-template',
        'WECHAT_SUBSCRIBE_TITLE_FIELD': 'thing1', 'WECHAT_SUBSCRIBE_TIME_FIELD': 'time2',
        'WECHAT_NOTIFICATION_SEND_ENABLED': 'true', 'WECHAT_NOTIFICATION_WORKER_ENABLED': 'true'})
    assert result.returncode == 2
    assert report['checks']['wechat_configuration']['status'] == 'pass'
    assert report['checks']['worker_enable_gate']['status'] == 'blocked'
    assert report['checks']['wechat_live_delivery']['status'] == 'not_checked'
    assert report['checks']['model_admission']['status'] == 'blocked'
    assert report['release_status'] == 'blocked'
    assert 'synthetic-private-value' not in result.stdout + result.stderr
    assert 'synthetic-password' not in result.stdout + result.stderr


def test_explicit_sqlite_schema_is_read_only_and_checks_constraints(tmp_path):
    database = tmp_path / 'synthetic.db'
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE notification_cursors (name TEXT PRIMARY KEY)')
        db.execute("INSERT INTO notification_cursors VALUES ('synthetic-sentinel')")
    before = database.read_bytes()
    result, report = run_check(tmp_path, '--sqlite-schema', database)
    assert result.returncode == 2
    check = report['checks']['database_schema']
    assert check['status'] == 'blocked' and check['missing_tables']
    assert check['rows_read'] is False
    assert 'synthetic-sentinel' not in result.stdout
    assert database.read_bytes() == before


def test_missing_sqlite_is_never_created(tmp_path):
    database = tmp_path / 'absent.db'
    result, report = run_check(tmp_path, '--sqlite-schema', database)
    assert result.returncode == 2 and not database.exists()
    assert report['checks']['database_schema']['reason_codes'] == ['sqlite_file_missing']


def test_backup_restore_rehearsal_uses_synthetic_temp_store(tmp_path):
    tool = ROOT / 'tools/rehearse-nonfederated-backup.py'
    assert tool.is_file(), 'The synthetic backup/restore rehearsal is missing'
    output = tmp_path / 'receipt.json'
    result = subprocess.run([sys.executable, str(tool), '--output', str(output)],
        cwd=ROOT, capture_output=True, text=True, encoding='utf8')
    assert result.returncode == 0, result.stderr
    report = json.loads(output.read_text(encoding='utf8'))
    assert report['synthetic_only'] is True and report['temporary_workspace_removed'] is True
    assert report['database_sha256'] == report['restored_database_sha256']
    assert report['upload_sha256'] == report['restored_upload_sha256']
    assert report['tampered_archive_rejected'] is True
    assert report['wrong_key_rejected'] is True
    assert report['synthetic_record_decrypted_after_restore'] is True
    assert report['authorization_ledger_restored_from_business_backup'] is False
