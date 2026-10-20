"""Explicitly provision synthetic examples in the owner's regular local backend.

Not run at app startup. Requires --apply, backs up the original stores first,
refuses account collisions, and uses real HTTP for all clinical business state.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import sys
from time import monotonic, sleep

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests/web')]
STORE = ROOT / '.codex-tmp/main-examples'
EVIDENCE = ROOT / 'docs/evidence/main-system-2026-10-18'


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.pending.json')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def _backup():
    from backend.app.core.config import settings
    from backend.app.db.session import engine
    database = Path(engine.url.database).resolve()
    if settings.APP_ENV != 'development' or database != (ROOT / 'backend/app.db').resolve():
        raise RuntimeError('Only the existing local development database is authorized.')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    directory = STORE / 'backups' / stamp
    directory.mkdir(parents=True)
    receipts = {}
    for label, path in {'business': database, 'authorization': Path(settings.AUTHORIZATION_LEDGER_PATH).resolve()}.items():
        if not path.is_file():
            raise RuntimeError(f'The existing {label} store is missing; no writes performed.')
        target = directory / (label + '.db')
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as original, closing(sqlite3.connect(target)) as backup:
            original.backup(backup)
            assert backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        receipts[label] = {'path': str(target), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
    for label, path in {'encryption-key': Path(settings.SECURITY_MASTER_KEY_PATH).resolve(), 'environment': ROOT / 'backend/.env'}.items():
        if not path.is_file():
            raise RuntimeError(f'The existing {label} file is missing; no writes performed.')
        target = directory / (label + '.backup')
        shutil.copy2(path, target)
        receipts[label] = {'path': str(target), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
    save(directory / 'receipt.json', receipts)
    return receipts


def _wait_assessment(client, owner, identifier):
    deadline = monotonic() + 45
    while monotonic() < deadline:
        response = client.get(f'/api/v1/care/assessments/{identifier}', headers=owner)
        response.raise_for_status()
        status = response.json()['status']
        if status == 'under_review':
            return
        sleep(.3)
    raise RuntimeError('Submission processing did not finish. Check the main CARE worker; existing records are retained.')


def _preserved_rows(backup):
    # Compare original raw rows (including encrypted bytes), not just row counts.
    # New users/records may be appended; none of the original rows are replaced.
    tables = ('users', 'patients', 'assessment_sessions', 'assessment_items', 'task_attempts',
              'scale_results', 'cognitive_tests', 'tracking_logs', 'care_messages',
              'model_predictions', 'imaging_visualizations', 'uploads', 'care_plans', 'daily_records')
    with closing(sqlite3.connect(backup)) as old, closing(sqlite3.connect(ROOT / 'backend/app.db')) as current:
        available = {r[0] for r in old.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        result = {}
        for table in tables:
            if table not in available:
                continue
            before = old.execute('SELECT * FROM "' + table + '" ORDER BY id').fetchall()
            for row in before:
                actual = current.execute('SELECT * FROM "' + table + '" WHERE id=?', (row[0],)).fetchone()
                if actual != row:
                    raise RuntimeError(f'An existing {table} row changed; inspect the saved backup before proceeding.')
            result[table] = {'original_rows': len(before), 'unchanged': True}
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        parser.error('--apply is required for the explicitly authorized example account writes.')
    import httpx
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.services.example_scope_service import mark_example_account
    from sqlalchemy import select
    import competition_fixture as flow
    from competition_imaging_fixture import provision_main_example_imaging

    pointer = json.loads((ROOT / '.codex-tmp/competition-demo/current.json').read_text(encoding='utf-8-sig'))
    old = json.loads((Path(pointer['runtime']) / 'source.json').read_text(encoding='utf-8'))
    if old.get('synthetic_only') is not True:
        raise RuntimeError('The account source is not the existing synthetic competition data.')
    source_path = STORE / 'source.json'
    previous = json.loads(source_path.read_text(encoding='utf-8')) if source_path.is_file() else None
    if previous and previous.get('status') != 'completed':
        raise RuntimeError('Partial provisioning exists; inspect its checkpoints rather than duplicating accounts.')
    with httpx.Client(base_url='http://127.0.0.1:8000', timeout=180, trust_env=False) as client:
        assert client.get('/api/v1/health').json()['status'] == 'ok'
        if previous:
            for account in previous['accounts'].values():
                login = flow._request(client, 'POST', '/api/v1/auth/login', body={
                    'identifier': account['email'], 'password': account['password'], 'role': account['role']})
                assert login['user']['id'] == account['user']['id']
            print(json.dumps({'status': 'reused', 'accounts': len(previous['accounts']), 'port': 8000}))
            return
        with SessionLocal() as db:
            for account in old['accounts'].values():
                if db.scalar(select(User.id).where(User.email == account['email'])):
                    raise RuntimeError('A requested example email already exists; no account is overwritten.')
        backup = _backup()
        source = {'status': 'preparing', 'synthetic_only': True, 'main_system': True,
            'service_port': 8000, 'accounts': {}, 'scenarios': {}, 'backups': backup,
            'external_ai_enabled': False, 'training_performed': False}
        save(source_path, source)
        password = old['accounts']['doctor']['password']
        headers = {}
        for key, name, role in (('doctor', '示例医生·林（合成）', 'researcher'),
                ('review', '示例用户·小禾（合成）', 'patient'), ('followup', '示例用户·小安（合成）', 'patient')):
            account, auth = flow._account(client, key, name, role, password)
            source['accounts'][key] = account
            save(source_path, source)
            with SessionLocal() as db:
                mark_example_account(db, account['user']['id'], doctor=key == 'doctor')
            headers[key] = auth
            print(json.dumps({'stage': 'account-created', 'key': key, 'user_id': account['user']['id']}), flush=True)
        for key in ('review', 'followup'):
            account, owner, doctor = source['accounts'][key], headers[key], headers['doctor']
            relation = flow._relationship(client, account, owner, doctor)
            scenario = flow._assessment(client, key, account, owner, doctor, wait_for_processing=_wait_assessment)
            scenario['relationship'] = relation
            source['scenarios'][key] = scenario
            save(source_path, source)
            print(json.dumps({'stage': 'assessment-submitted', 'key': key, 'assessment_id': scenario['assessment']['id']}), flush=True)
        reviewing, following = source['scenarios']['review'], source['scenarios']['followup']
        reviewing['clarification'] = flow._clarification(client, reviewing, headers['doctor'])
        save(source_path, source)
        today = flow._report_and_plan(client, following, headers['followup'], headers['doctor'])
        save(source_path, source)
        flow._history(client, following, headers['followup'], today)
        flow._messages(client, following, headers['followup'], headers['doctor'], following['relationship'])
        flow._agent(client, following, headers['followup'])
        source['calendar_today'] = today.isoformat()
        save(source_path, source)
        source['imaging'] = provision_main_example_imaging(client, headers['doctor'], headers['followup'],
            following['patient_id'], STORE, ROOT)
        for key in ('review', 'followup'):
            scenario = source['scenarios'][key]
            scenario['assessment'] = flow._request(client, 'GET', f"/api/v1/care/assessments/{scenario['assessment']['id']}", headers[key])
        source['preserved_original_rows'] = _preserved_rows(backup['business']['path'])
        source['status'] = 'completed'
        save(source_path, source)
        receipt = {key: source[key] for key in ('status', 'synthetic_only', 'main_system', 'service_port',
            'calendar_today', 'external_ai_enabled', 'training_performed', 'preserved_original_rows')}
        receipt['accounts'] = {key: {field: account['user'][field] for field in ('id', 'role')} for key, account in source['accounts'].items()}
        receipt['scenarios'] = {key: {'patient_id': scenario['patient_id'], 'assessment_id': scenario['assessment']['id'],
            'status': scenario['assessment']['status'], 'submissions': len(scenario['submissions'])} for key, scenario in source['scenarios'].items()}
        receipt['imaging'] = {key: source['imaging'][key] for key in ('prediction_id', 'system_report_id', 'doctor_report_id',
            'original_hgst_sha256_before', 'original_hgst_sha256_after')}
        save(EVIDENCE / 'provisioning-receipt.json', receipt)
        print(json.dumps(receipt, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
