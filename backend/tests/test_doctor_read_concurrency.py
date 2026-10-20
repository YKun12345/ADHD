"""Doctor reads must finish with durable access audits while the care worker runs."""
from concurrent.futures import ThreadPoolExecutor

from backend.tests.test_security_regressions import actors


def test_doctor_reads_and_receipt_rechecks_bound_ledger_connection_churn(client, actors, monkeypatch):
    from contextlib import contextmanager
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.api.routes.doctor import get_my_patients, get_dashboard_stats
    from backend.app.services import authorization_ledger as ledger
    from backend.app.services.identity_access import require_patient_access, recheck_receipts, require_doctor, resolve_patient, authorized_patient_ids, readable_user

    original = ledger._connect
    opened = []
    @contextmanager
    def measured(*args, **kwargs):
        if kwargs.get('read_only'):
            opened.append(True)
        with original(*args, **kwargs) as connection:
            yield connection
    monkeypatch.setattr(ledger, '_connect', measured)
    counts = {}
    for label, endpoint in [('patients', get_my_patients), ('statistics', get_dashboard_stats)]:
        opened.clear()
        with SessionLocal() as db:
            endpoint(current_user=db.get(User, actors['doctor']['id']), db=db)
        counts[label] = len(opened)
    with SessionLocal() as db:
        user = db.get(User, actors['doctor']['id'])
        for scope in ['profile', 'assessment', 'tracking', 'care', 'imaging']:
            require_patient_access(db, user, actors['patient_id'], scope)
        receipts = list(db.info['authorization_receipts'])
    opened.clear()
    with SessionLocal() as db:
        recheck_receipts(db, receipts)
    counts['receipt_rechecks'] = len(opened)
    for label, call in [
        ('single_profile', lambda db: require_patient_access(db, db.get(User,actors['doctor']['id']),actors['patient_id'],'care')),
        ('doctor_qualification', lambda db: require_doctor(db,actors['doctor']['id'])),
        ('own_profile', lambda db: resolve_patient(db,db.get(User,actors['patient']['id']))),
        ('authorized_profiles', lambda db: authorized_patient_ids(db,actors['doctor']['id'])),
        ('account', lambda db: readable_user(db,db.get(User,actors['patient']['id']))),
    ]:
        opened.clear()
        with SessionLocal() as db:
            call(db)
        counts[label] = len(opened)
    assert all(count == 1 for count in counts.values()), counts


def test_doctor_parallel_reads_and_worker_keep_their_audits(client, actors):
    from backend.app.db.session import SessionLocal
    from backend.app.workers.care_worker_runtime import CareWorkerRuntime
    from backend.app.models.security import SecurityAuditLog
    from sqlalchemy import select, func

    runtime = CareWorkerRuntime(SessionLocal, interval_seconds=0.1, batch_size=4)
    urls = ['/api/v1/doctor/my_patients', '/api/v1/doctor/dashboard_stats',
        f'/api/v1/care/doctor/patient/{actors["patient_id"]}/summary'] * 4
    with SessionLocal() as db:
        before = db.scalar(select(func.count(SecurityAuditLog.id)).where(SecurityAuditLog.action == 'data_read'))
    runtime.start()
    try:
        with ThreadPoolExecutor(max_workers=6) as pool:
            responses = list(pool.map(lambda url: client.get(url, headers=actors['doctor']['headers']), urls))
        assert [response.status_code for response in responses] == [200] * len(urls), [
            (response.status_code, response.json().get('detail')) for response in responses if response.status_code != 200]
    finally:
        assert runtime.stop(timeout=6)
    with SessionLocal() as db:
        after = db.scalar(select(func.count(SecurityAuditLog.id)).where(SecurityAuditLog.action == 'data_read'))
    assert after - before == len(urls), 'Successful reads must not bypass their audit records.'


def test_same_original_grant_scopes_recheck_together(client, actors, monkeypatch):
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.services import identity_access as access
    with SessionLocal() as db:
        user = db.get(User, actors['doctor']['id'])
        for scope in ['profile', 'assessment', 'tracking', 'care', 'imaging']:
            access.require_patient_access(db, user, actors['patient_id'], scope)
        originals = list(db.info['authorization_receipts'])
    actual = access.require_patient_access
    calls = []
    def checked(db, user, patient_id, scope, **kwargs):
        calls.append(scope)
        return actual(db, user, patient_id, scope, **kwargs)
    monkeypatch.setattr(access, 'require_patient_access', checked)
    with SessionLocal() as db:
        access.recheck_receipts(db, originals)
        assert db.info['authorization_receipts'] == [originals[-1]]
    assert len(calls) == 1, 'The same actor, patient, purpose and exact original heads need one combined check.'


def test_grouped_recheck_preserves_last_original_processing_requirement(client, actors):
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.services import identity_access as access
    originals = []
    with SessionLocal() as db:
        user = db.get(User, actors['doctor']['id'])
        for scope, processing in [('profile', True), ('care', False), ('tracking', True)]:
            db.info['requires_basic_use'] = processing
            access.require_patient_access(db, user, actors['patient_id'], scope)
            originals.append(db.info['authorization_receipts'][-1])
    with SessionLocal() as db:
        access.recheck_receipts(db, originals)
        assert db.info['authorization_receipts'] == [originals[-1]]
        assert db.info['requires_basic_use'] is True
