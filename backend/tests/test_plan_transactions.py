from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from sqlalchemy import select, func, text, create_engine, inspect
from sqlalchemy.orm import Session
from backend.tests.test_report_publications import saved_draft, publication_body


def test_plan_failure_rolls_back_the_entire_schedule_and_binding_tamper_or_read_audit_discloses_nothing(client, monkeypatch):
    owner, doctor, _, session, draft, _ = saved_draft(client)
    result = client.post('/api/v1/care/review-publications', headers=doctor, json=publication_body(client, doctor, draft))
    assert result.status_code == 201, result.text
    ctx = client.get(f"/api/v1/care/assessments/{session['id']}/plan-context", headers=doctor).json()
    today = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    body = {'client_plan_version_id': 'atomic-original-plan', 'patient_id': session['patient_id'], 'assessment_id': session['id'],
        'expected_assessment_version': ctx['assessment_version'], 'expected_previous_version': 0, 'expected_plan_revision': 0,
        'source_report_id': ctx['source_report_id'], 'input_digest': ctx['input_digest'], 'plan_context': ctx['plan_context'],
        'title': '合成原计划', 'instructions': '合成私人计划正文，不应在拒绝或审计失败时披露。',
        'start_date': str(today), 'end_date': str(today + timedelta(days=1)), 'confirmed': True}
    from backend.app.services import security_service
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_plan import CarePlan, PlanVersion, PlanTask, PlanAcknowledgement
    from backend.app.models.care_cycle import CareCycle
    original_audit, original_commit = security_service._append_audit_log, Session.commit
    def no_audit(*args, **kwargs):
        if kwargs.get('action') == 'professional_plan_published':
            raise RuntimeError('Synthetic critical plan audit failure')
        return original_audit(*args, **kwargs)
    def no_commit(db, *args, **kwargs):
        request = db.info.get('authorization_request')
        if request is not None and request.url.path.endswith('/care/plan-versions'):
            raise RuntimeError('Synthetic plan final COMMIT failure')
        return original_commit(db, *args, **kwargs)
    for failure in ['audit', 'commit']:
        with monkeypatch.context() as patch:
            if failure == 'audit': patch.setattr(security_service, '_append_audit_log', no_audit)
            else: patch.setattr(Session, 'commit', no_commit)
            response = client.post('/api/v1/care/plan-versions', headers=doctor, json=body)
            assert response.status_code == 503, response.text
        with SessionLocal() as db:
            for model in (CarePlan, PlanVersion, PlanTask, PlanAcknowledgement):
                assert db.scalar(select(func.count()).select_from(model)) == 0
            assert db.scalar(select(func.count()).select_from(CareCycle).where(CareCycle.cycle_type == 'professional')) == 0
        assert client.get('/api/v1/care/plan-versions/submissions/atomic-original-plan', headers=doctor).status_code == 404
    saved = client.post('/api/v1/care/plan-versions', headers=doctor, json=body)
    assert saved.status_code == 201, saved.text
    ack = saved.json()
    assert client.post('/api/v1/care/plan-versions', headers=doctor, json={**body, 'instructions': '同一ID改写正文'}).status_code == 409
    assert client.post('/api/v1/care/plan-versions', headers=doctor, json={**body, 'client_plan_version_id': 'old-context-plan'}).status_code == 409
    with SessionLocal() as db:
        db.execute(text('UPDATE care_plans SET current_plan_version_id=:bad WHERE id=:id'), {'bad': ack['id'] + 999, 'id': ack['plan_id']}); db.commit()
    denied = client.get(f"/api/v1/care/plans/{ack['plan_id']}", headers=owner)
    assert denied.status_code == 503 and body['instructions'] not in denied.text
    with SessionLocal() as db:
        db.execute(text('UPDATE care_plans SET current_plan_version_id=:head WHERE id=:id'), {'head': ack['id'], 'id': ack['plan_id']}); db.commit()
    def no_read_audit(*args, **kwargs):
        if kwargs.get('action') == 'data_read': raise RuntimeError('Synthetic plan read audit failure')
        return original_audit(*args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(security_service, '_append_audit_log', no_read_audit)
        response = client.get(f"/api/v1/care/plans/{ack['plan_id']}", headers=owner)
        assert response.status_code == 503 and body['instructions'] not in response.text


def test_plan_schema_plan_detects_actual_old_self_only_constraint_without_changing_the_selected_store(client):
    from backend.app.db.care_plan_migration import care_plan_schema_plan
    engine = create_engine('sqlite:///:memory:')
    try:
        with engine.begin() as db:
            db.execute(text("CREATE TABLE care_cycles(id INTEGER PRIMARY KEY,patient_id INTEGER,cycle_type TEXT,responsible_doctor_id INTEGER,plan_version_id INTEGER,CHECK(cycle_type='self' AND responsible_doctor_id IS NULL AND plan_version_id IS NULL))"))
        before = inspect(engine).get_table_names()
        result = care_plan_schema_plan(engine)
        assert result['executed'] is False and result['requires_explicit_review'] is True
        assert result['missing_constraints']['care_cycles'] and 'professional' in result['care_cycle_target_ddl']
        assert len(result['statements']) >= 4
        mysql = care_plan_schema_plan(engine, dialect_name='mysql')
        assert 'LONGTEXT' in '\n'.join(mysql['statements'])
        assert inspect(engine).get_table_names() == before
    finally:
        engine.dispose()
