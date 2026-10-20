"""A saved original deadline creates a separate system fact, never resolution."""
import importlib.util
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from backend.tests.test_assessment_consumers import drain
from backend.tests.test_service_coverage import coverage_body, institutional_actor, versions_route
from backend.tests.test_submission_context import scale_submission
from backend.tests.test_submission_cognitive_evidence import cognitive_submission


def actual_deadline_attention(client):
    owner, doctor, session, _, _, scale = scale_submission(client, doctor=True, suffix='deadline-source')
    _, reviewer = institutional_actor(client, 'deadline-reviewer', reviewer=True)
    configured = client.post(versions_route(session['responsible_doctor_id']), headers=reviewer, json=coverage_body())
    assert configured.status_code == 201, configured.text
    _, _, item, _, body = cognitive_submission(client, 'flanker', context=(owner, session, scale['patient_id']))
    body['task_id'] = item['patient_task_id']
    body['content']['execution_metadata']['interrupted_count'] = 1
    submitted = client.post('/api/v1/care/submissions', headers=owner, json=body)
    assert submitted.status_code == 201, submitted.text
    assert drain() == 2
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    with SessionLocal() as db:
        row = db.scalar(select(AttentionItem).where(AttentionItem.assessment_id == session['id']))
        assert row.detail['response_coverage']['status'] == 'configured'
        deadline = row.expected_response_at
        deadline = deadline if deadline.tzinfo else deadline.replace(tzinfo=timezone.utc)
        return owner, doctor, session, row.id, deadline


def test_actual_original_deadline_produces_one_overdue_fact_without_resolving_or_accepting(client):
    owner, doctor, session, identifier, deadline = actual_deadline_attention(client)
    assert deadline > datetime.now(timezone.utc)
    assert importlib.util.find_spec('backend.app.services.attention_deadline_service'), 'Missing actual original response-window monitor.'
    from backend.app.services.attention_deadline_service import monitor_once
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    from backend.app.models.care_system_event import CareSystemEvent
    assert monitor_once(SessionLocal, clock=lambda: deadline - timedelta(seconds=1)) == 0
    assert monitor_once(SessionLocal, clock=lambda: deadline + timedelta(seconds=1)) == 1
    assert monitor_once(SessionLocal, clock=lambda: deadline + timedelta(seconds=2)) == 0
    assert monitor_once(SessionLocal, clock=lambda: deadline + timedelta(seconds=3)) == 0
    with SessionLocal() as db:
        original = db.get(AttentionItem, identifier)
        assert original.status == 'open' and original.version == 1
        events = db.scalars(select(CareSystemEvent).where(CareSystemEvent.event_type == 'attention_response_overdue')).all()
        assert len(events) == 1 and events[0].system_principal == 'attention_deadline_monitor'
        assert events[0].payload['attention_id'] == identifier
        assert events[0].payload['human_action'] is False
        assert events[0].payload['external_delivery_status'] == 'not_configured'
    work = client.get('/api/v1/care/doctor/work_queue', headers=doctor)
    assert work.status_code == 200, work.text
    observed = next(row for row in work.json()['items'] if row['id'] == identifier)['overdue_observation']
    assert observed['status'] == 'requires_institutional_action'
    assert observed['original_deadline'] == deadline.isoformat()
    actual = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert actual.status_code == 200, actual.text
    assert all(row['acceptance_status'] == 'pending_review' for row in actual.json()['items'])


def test_acknowledgement_does_not_resolve_deadline_but_terminal_close_keeps_it_as_history(client):
    _, doctor, _, identifier, deadline = actual_deadline_attention(client)
    from backend.app.db.session import SessionLocal
    from backend.app.services.attention_deadline_service import monitor_once
    from backend.tests.test_attention_lifecycle import preflight, action_body
    assert monitor_once(SessionLocal, clock=lambda: deadline + timedelta(seconds=1)) == 1
    view = preflight(client, doctor, identifier)
    ack = client.post(f'/api/v1/care/attention/{identifier}/actions', headers=doctor,
        json=action_body(view, 'overdue-acknowledged', 'acknowledge'))
    assert ack.status_code == 201, ack.text
    current = preflight(client, doctor, identifier)
    assert current['attention']['status'] == 'acknowledged'
    assert current['attention']['overdue_observation']['status'] == 'requires_institutional_action'
    closed = client.post(f'/api/v1/care/attention/{identifier}/actions', headers=doctor,
        json=action_body(current, 'overdue-closed-with-reason', 'close_with_reason', '合成实际关闭说明，另有现实处置记录。'))
    assert closed.status_code == 201, closed.text
    history = preflight(client, doctor, identifier)
    assert history['attention']['status'] == 'closed_with_reason'
    assert history['attention']['overdue_observation']['status'] == 'historical'
    assert monitor_once(SessionLocal, clock=lambda: deadline + timedelta(minutes=1)) == 0


def test_withdrawn_original_authority_creates_no_overdue_event_and_is_paused_by_its_own_job(client):
    owner, _, session, _, deadline = actual_deadline_attention(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.models.care_system_event import CareSystemEvent
    with SessionLocal() as db:
        relation = db.scalar(select(CareRelationship).where(CareRelationship.patient_id == session['patient_id']))
        identifier, revision = relation.id, relation.revision
    response = client.post(f'/api/v1/care/relationships/{identifier}/revoke', headers=owner, json={'expected_revision': revision})
    assert response.status_code == 200, response.text
    from backend.app.services.attention_deadline_service import monitor_once
    assert monitor_once(SessionLocal, clock=lambda: deadline + timedelta(seconds=1)) == 0
    with SessionLocal() as db:
        assert db.scalar(select(CareSystemEvent).where(CareSystemEvent.event_type == 'attention_response_overdue')) is None
    from backend.app.services.care_authority_reconciliation import reconcile_once
    from backend.app.models.assessment import AssessmentSession
    assert reconcile_once(SessionLocal) == 1
    with SessionLocal() as db:
        assert db.get(AssessmentSession, session['id']).status == 'suspended'


def test_overdue_audit_failure_rolls_back_system_fact_and_original_attention_stays_open(client, monkeypatch):
    _, _, _, identifier, deadline = actual_deadline_attention(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    from backend.app.models.care_system_event import CareSystemEvent
    from backend.app.services import security_service
    original = security_service._append_audit_log
    def fail(db, **kwargs):
        if kwargs['action'] == 'attention_deadline_observed':
            raise OSError('synthetic overdue audit unavailable')
        return original(db, **kwargs)
    monkeypatch.setattr(security_service, '_append_audit_log', fail)
    from backend.app.services.attention_deadline_service import monitor_once
    import pytest
    with pytest.raises(OSError, match='overdue audit'):
        monitor_once(SessionLocal, clock=lambda: deadline + timedelta(seconds=1))
    with SessionLocal() as db:
        assert db.get(AttentionItem, identifier).status == 'open'
        assert db.scalar(select(CareSystemEvent).where(CareSystemEvent.event_type == 'attention_response_overdue')) is None
    monkeypatch.setattr(security_service, '_append_audit_log', original)
    assert monitor_once(SessionLocal, clock=lambda: deadline + timedelta(seconds=2)) == 1


def test_original_ledger_denied_immediately_before_commit_withholds_overdue_fact(client, monkeypatch):
    _, _, session, identifier, deadline = actual_deadline_attention(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.consent import ConsentRecord
    from backend.app.models.care_system_event import CareSystemEvent
    from backend.app.models.attention import AttentionItem
    from backend.app.services import attention_deadline_service as service, authorization_ledger as ledger
    from fastapi import HTTPException
    import pytest
    original = service._monitor_attention
    def deny_after_fact(db, factory, target, observed):
        result = original(db, factory, target, observed)
        if result:
            with SessionLocal() as revoker:
                basic = revoker.scalar(select(ConsentRecord).where(ConsentRecord.patient_id == session['patient_id'],
                    ConsentRecord.purpose == 'basic_use', ConsentRecord.status == 'active'))
                ledger.deny(basic)
        return result
    monkeypatch.setattr(service, '_monitor_attention', deny_after_fact)
    with pytest.raises(HTTPException) as caught:
        service.monitor_once(SessionLocal, clock=lambda: deadline + timedelta(seconds=1))
    assert caught.value.status_code == 403
    with SessionLocal() as db:
        assert db.get(AttentionItem, identifier).status == 'open'
        assert db.scalar(select(CareSystemEvent).where(CareSystemEvent.event_type == 'attention_response_overdue')) is None
