"""Natural expiry denies immediately and must also persist unfinished-work suspension."""
import importlib.util
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from backend.tests.test_assessment_consumers import drain
from backend.tests.test_submission_context import scale_submission
from backend.tests.test_submission_cognitive_evidence import cognitive_submission


@pytest.fixture
def worker_client(monkeypatch, request):
    monkeypatch.setenv('CARE_WORKER_ENABLED', 'true')
    monkeypatch.setenv('CARE_WORKER_INTERVAL_SECONDS', '0.1')
    return request.getfixturevalue('client')


@pytest.mark.parametrize('cause', ['doctor_expiry', 'membership_expiry', 'account_disabled'])
def test_actual_natural_invalidation_requires_persistent_reconciliation(client, cause):
    owner, doctor, session, _, _, scale = scale_submission(client, doctor=True, suffix='natural-invalidation')
    _, _, item, _, body = cognitive_submission(client, 'flanker', context=(owner, session, scale['patient_id']))
    body['task_id'] = item['patient_task_id']
    body['content']['execution_metadata']['interrupted_count'] = 1
    result = client.post('/api/v1/care/submissions', headers=owner, json=body)
    assert result.status_code == 201, result.text
    assert drain() == 2
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    from backend.app.models.identity import DoctorQualification, InstitutionMembership
    from backend.app.models.user import User
    with SessionLocal() as db:
        item = db.scalar(select(AttentionItem).where(AttentionItem.assessment_id == session['id']))
        identifier = item.id
        assert item.status == 'open'
        if cause == 'doctor_expiry':
            row = db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == session['responsible_doctor_id']))
            row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        elif cause == 'membership_expiry':
            row = db.scalar(select(InstitutionMembership).where(InstitutionMembership.user_id == session['responsible_doctor_id']))
            row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        else:
            db.get(User, session['responsible_doctor_id']).is_active = False
        db.commit()
    denied = client.get('/api/v1/care/doctor/work_queue', headers=doctor)
    assert denied.status_code in {401, 403}, denied.text
    # Request-time denial alone has not changed the durable responsibility state.
    with SessionLocal() as db:
        assert db.get(AttentionItem, identifier).status == 'open'
    assert importlib.util.find_spec('backend.app.services.care_authority_reconciliation'), 'Missing bounded persistent reconciliation for actual expired/disabled original authority.'
    from backend.app.services.care_authority_reconciliation import reconcile_once
    assert reconcile_once(SessionLocal, limit=50) >= 1
    with SessionLocal() as db:
        actual = db.get(AttentionItem, identifier)
        assert actual.status == 'suspended'
        assert actual.responsible_doctor_id == session['responsible_doctor_id']
        from backend.app.models.care_system_event import CareSystemEvent
        fact = db.scalar(select(CareSystemEvent).where(CareSystemEvent.assessment_id == session['id']))
        assert fact.payload['observation']['code'] == {'doctor_expiry': 'doctor_qualification_expired',
            'membership_expiry': 'institution_membership_expired', 'account_disabled': 'account_disabled'}[cause]
    assert reconcile_once(SessionLocal, limit=50) == 0
    history = client.get(f"/api/v1/care/patient/attention?patient_id={scale['patient_id']}", headers=owner)
    assert history.status_code == 200, history.text
    observed = next(row for row in history.json()['items'] if row['id'] == identifier)['suspension_observation']
    assert observed['human_action'] is False and observed['system_principal'] == 'care_authority_reconciler'
    assert datetime.fromisoformat(observed['observed_at']).tzinfo is not None


def test_actual_worker_lifespan_reconciles_expiry_without_a_request_performing_suspension(worker_client):
    import time
    owner, _, session, _, _, scale = scale_submission(worker_client, doctor=True, suffix='natural-worker')
    _, _, item, _, body = cognitive_submission(worker_client, 'flanker', context=(owner, session, scale['patient_id']))
    body['task_id'] = item['patient_task_id']
    body['content']['execution_metadata']['interrupted_count'] = 1
    saved = worker_client.post('/api/v1/care/submissions', headers=owner, json=body)
    assert saved.status_code == 201, saved.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    from backend.app.models.identity import DoctorQualification
    from backend.app.models.care_system_event import CareSystemEvent
    for _ in range(100):
        with SessionLocal() as db:
            attention = db.scalar(select(AttentionItem).where(AttentionItem.assessment_id == session['id']))
            if attention:
                identifier = attention.id
                break
        time.sleep(0.05)
    else:
        raise AssertionError('Actual worker did not create attention before the expiry probe.')
    with SessionLocal() as db:
        row = db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == session['responsible_doctor_id']))
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    for _ in range(120):
        with SessionLocal() as db:
            if db.get(AttentionItem, identifier).status == 'suspended':
                facts = db.scalars(select(CareSystemEvent).where(CareSystemEvent.assessment_id == session['id'])).all()
                assert len(facts) == 1 and facts[0].system_principal == 'care_authority_reconciler'
                assert facts[0].payload['human_action'] is False
                break
        time.sleep(0.05)
    else:
        raise AssertionError('Actual background runtime never persisted natural-expiry suspension.')


def test_guardian_expiry_persists_pause_without_giving_the_expired_guardian_history_access(client):
    owner, session, _, _, body = cognitive_submission(client, 'flanker', child=True)
    body['content']['execution_metadata']['interrupted_count'] = 1
    assert client.post('/api/v1/care/submissions', headers=owner, json=body).status_code == 201
    assert drain() == 2
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import GuardianRelationship
    from backend.app.models.attention import AttentionItem
    from backend.app.models.care_system_event import CareSystemEvent
    with SessionLocal() as db:
        guardian = db.scalar(select(GuardianRelationship).where(GuardianRelationship.patient_id == body['patient_id']))
        guardian.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    from backend.app.services.care_authority_reconciliation import reconcile_once
    assert reconcile_once(SessionLocal) == 1
    assert client.get(f"/api/v1/care/patient/attention?patient_id={body['patient_id']}", headers=owner).status_code == 403
    with SessionLocal() as db:
        row = db.scalar(select(AttentionItem).where(AttentionItem.assessment_id == session['id']))
        assert row.status == 'suspended' and row.responsible_doctor_id is None
        fact = db.scalar(select(CareSystemEvent).where(CareSystemEvent.assessment_id == session['id']))
        assert fact.payload['observation']['code'] == 'guardian_relationship_expired'


def test_system_denial_fact_and_pause_roll_back_if_critical_audit_fails(client, monkeypatch):
    owner, session, _, _, body = cognitive_submission(client, 'flanker')
    body['content']['execution_metadata']['interrupted_count'] = 1
    assert client.post('/api/v1/care/submissions', headers=owner, json=body).status_code == 201
    assert drain() == 2
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.models.attention import AttentionItem
    from backend.app.models.care_system_event import CareSystemEvent
    with SessionLocal() as db:
        db.get(User, body['actor_user_id']).is_active = False
        db.commit()
    from backend.app.services import security_service
    original = security_service._append_audit_log
    def fail(db, **kwargs):
        if kwargs['action'] == 'care_authority_reconciled':
            raise OSError('synthetic system critical audit unavailable')
        return original(db, **kwargs)
    monkeypatch.setattr(security_service, '_append_audit_log', fail)
    from backend.app.services.care_authority_reconciliation import reconcile_once
    with pytest.raises(OSError, match='critical audit'):
        reconcile_once(SessionLocal)
    with SessionLocal() as db:
        assert db.scalar(select(AttentionItem).where(AttentionItem.assessment_id == session['id'])).status == 'open'
        assert db.scalar(select(CareSystemEvent)) is None
    monkeypatch.setattr(security_service, '_append_audit_log', original)
    assert reconcile_once(SessionLocal) == 1


def test_durable_cursor_advances_past_valid_work_to_a_later_invalid_round(client):
    from backend.tests.test_assessment_sessions import actor, created
    _, live, live_pid = actor(client, suffix='natural-cursor-live')
    valid = created(client, live, live_pid)
    owner, session, _, _, body = cognitive_submission(client, 'flanker')
    body['content']['execution_metadata']['interrupted_count'] = 1
    assert client.post('/api/v1/care/submissions', headers=owner, json=body).status_code == 201
    assert drain() == 2
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.models.assessment import AssessmentSession
    with SessionLocal() as db:
        db.get(User, body['actor_user_id']).is_active = False
        db.commit()
    from backend.app.services.care_authority_reconciliation import reconcile_once
    assert reconcile_once(SessionLocal, limit=1) == 0
    assert reconcile_once(SessionLocal, limit=1) == 1
    with SessionLocal() as db:
        assert db.get(AssessmentSession, valid['id']).status == 'active'
        assert db.get(AssessmentSession, session['id']).status == 'suspended'


def test_one_corrupt_original_is_withheld_without_starving_later_invalid_work(client):
    from sqlalchemy import text
    from backend.tests.test_assessment_sessions import actor, created
    owner, first, _, _, body = cognitive_submission(client, 'flanker')
    body['content']['execution_metadata']['interrupted_count'] = 1
    assert client.post('/api/v1/care/submissions', headers=owner, json=body).status_code == 201
    _, other, other_pid = actor(client, suffix='natural-after-corrupt')
    second = created(client, other, other_pid)
    _, _, _, _, later = cognitive_submission(client, 'flanker', context=(other, second, other_pid))
    later['submission_id'] = 'after-corrupt-' + later['run_id']
    later['content']['execution_metadata']['interrupted_count'] = 1
    assert client.post('/api/v1/care/submissions', headers=other, json=later).status_code == 201
    assert drain() == 4
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.models.assessment import AssessmentSession
    from backend.app.models.care_system_event import CareSystemEvent
    with SessionLocal() as db:
        db.execute(text('UPDATE attention_items SET state_snapshot = :broken WHERE assessment_id = :identifier'),
            {'broken': 'synthetic-corrupt-original', 'identifier': first['id']})
        db.get(User, later['actor_user_id']).is_active = False
        db.commit()
    from backend.app.services.care_authority_reconciliation import reconcile_once
    assert reconcile_once(SessionLocal, limit=50) == 1
    with SessionLocal() as db:
        assert db.get(AssessmentSession, first['id']).status == 'active'
        assert db.get(AssessmentSession, second['id']).status == 'suspended'
        assert db.scalar(select(CareSystemEvent).where(CareSystemEvent.assessment_id == first['id'])) is None
