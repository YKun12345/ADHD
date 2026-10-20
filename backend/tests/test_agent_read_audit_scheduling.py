"""Assembling a large read context must not hold SQLite's writer meanwhile."""
from backend.tests.test_review_drafts import context_and_body


def test_deferred_audits_preserve_order_and_fail_closed(client, monkeypatch):
    import pytest
    from types import SimpleNamespace
    from fastapi import HTTPException
    from backend.app.services import security_service
    from backend.app.services.deferred_read_audit import append_read_audit, finish_reads_before_audits
    emitted = []
    db = SimpleNamespace(info={})
    monkeypatch.setattr(security_service, '_append_audit_log', lambda db, **values: emitted.append(values))
    @finish_reads_before_audits
    def read(db):
        details = {'items': [1]}
        append_read_audit(db, failure_detail='audit unavailable', action='data_read', detail_json=details)
        details['items'].append(2)
        append_read_audit(db, failure_detail='audit unavailable', action='care_cycle_read', detail_json={'id': 3})
        assert not emitted
        return 'read result'
    assert read(db) == 'read result'
    assert emitted == [{'action': 'data_read', 'detail_json': {'items': [1]}}, {'action': 'care_cycle_read', 'detail_json': {'id': 3}}]
    assert not db.info
    def unavailable(*a, **k):
        raise RuntimeError('synthetic storage failure')
    monkeypatch.setattr(security_service, '_append_audit_log', unavailable)
    emitted.clear()
    with pytest.raises(HTTPException) as error:
        read(db)
    assert error.value.status_code == 503 and not db.info


def test_context_reads_finish_before_critical_audits_take_writer(client, monkeypatch):
    from sqlalchemy import event, select
    from backend.app.db.session import SessionLocal, engine
    from backend.app.models.security import SecurityAuditLog
    from backend.app.models.user import User
    from backend.app.services.agent.context import build_context
    from backend.app.services import care_cycle_service

    _, _, _, assessment, _, _ = context_and_body(client)
    writes = []
    def observe(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().split(' ', 1)[0].upper() in {'INSERT', 'UPDATE', 'DELETE'}:
            writes.append(True)
    original = care_cycle_service.list_cycles
    reached = []
    def check_read_phase(*args, **kwargs):
        reached.append(True)
        assert not writes, 'Nested read audits must not lock the writer before remaining context reads.'
        return original(*args, **kwargs)
    monkeypatch.setattr(care_cycle_service, 'list_cycles', check_read_phase)
    event.listen(engine, 'before_cursor_execute', observe)
    try:
        with SessionLocal() as db:
            actor = db.get(User, assessment['responsible_doctor_id'])
            frame = build_context(db, actor, assessment['patient_id'])
            assert frame['patient_id'] == assessment['patient_id']
            assert reached and writes, 'Read audits must actually be emitted before context returns.'
            assert not any('deferred_read_audit' in key for key in db.info)
            db.commit()
        with SessionLocal() as db:
            scopes = [row.detail_json.get('scope') for row in db.scalars(select(SecurityAuditLog).where(SecurityAuditLog.actor_user_id == assessment['responsible_doctor_id']))]
            assert 'specific_clarifications' in scopes and 'unified_agent_context' in scopes
    finally:
        event.remove(engine, 'before_cursor_execute', observe)
