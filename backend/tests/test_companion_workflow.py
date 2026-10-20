"""Companion follows actual synthetic HTTP business state, without external AI."""
import base64
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from backend.tests.test_review_drafts import context_and_body
from backend.tests.test_report_publications import saved_draft, publication_body


def actions(client, headers, pid):
    response = client.get(f'/api/v1/agent/actions?patient_id={pid}', headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def observe(client, headers, pid, current):
    response = client.post('/api/v1/agent/companion-observations', headers=headers,
        json={'patient_id': pid, 'observation_context': current['companion']['observation_context']})
    assert response.status_code == 200, response.text
    assert response.json() == {'observed': True, 'fingerprint': current['companion']['fingerprint']}
    return response.json()


def ask(client, doctor, session, suffix='first'):
    ctx = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor).json()
    response = client.post('/api/v1/care/clarifications', headers=doctor, json={
        'client_question_id': 'companion-question-' + suffix, 'patient_id': session['patient_id'],
        'assessment_id': session['id'], 'expected_assessment_version': ctx['assessment_version'],
        'input_digest': ctx['input_digest'], 'review_context': ctx['review_context'], 'source_type': 'submission',
        'source_key': ctx['submissions'][0]['submission_id'], 'question': 'PRIVATE_合成补问正文，不应进入观察签名或审计。', 'confirmed': True})
    assert response.status_code == 201, response.text
    return response.json()


def test_resolved_current_action_is_a_preference_and_expired_action_does_not_mean_completed(client):
    owner, doctor, _, session, _, _ = context_and_body(client)
    pid = session['patient_id']
    initial = actions(client, owner, pid)
    assert initial['companion']['protocol'] == 'Xingzai-flow-1'
    selected = initial['items'][-1]
    resolved = client.post(f"/api/v1/agent/actions/{selected['id']}/resolve", headers=owner,
        json={'patient_id': pid, 'expected_action_digest': selected['action_digest']})
    assert resolved.status_code == 200, resolved.text
    resumed = actions(client, owner, pid)
    assert resumed['items'][0] == selected
    assert resumed['companion']['resume_action_id'] == selected['id']
    continuing = next(row for row in resumed['items'] if row['kind'] == 'continue_assessment')
    assert client.post(f"/api/v1/agent/actions/{continuing['id']}/resolve", headers=owner,
        json={'patient_id': pid, 'expected_action_digest': continuing['action_digest']}).status_code == 200
    ask(client, doctor, session)
    current = actions(client, owner, pid)
    assert current['companion']['resume_action_id'] is None
    assert current['items'][0]['kind'] == current['companion']['stage_key'] == 'answer_questions'
    assert continuing['id'] not in [row['id'] for row in current['items']]
    assert '完成' not in current['companion']['title']
    stale = client.post(f"/api/v1/agent/actions/{continuing['id']}/resolve", headers=owner,
        json={'patient_id': pid, 'expected_action_digest': continuing['action_digest']})
    assert stale.status_code == 409, stale.text


def test_get_does_not_observe_and_private_observation_does_not_clear_another_actors_updates(client):
    owner, doctor, _, session, _, _ = context_and_body(client)
    pid = session['patient_id']
    baseline = actions(client, owner, pid)
    doctor_baseline = actions(client, doctor, pid)
    observe(client, owner, pid, baseline)
    observe(client, doctor, pid, doctor_baseline)
    question = ask(client, doctor, session)
    current = actions(client, owner, pid)
    assert any('补问' in row['text'] and f"#{question['id']}" in row['text'] for row in current['companion']['updates'])
    repeated = actions(client, owner, pid)
    assert repeated['companion']['updates'] == current['companion']['updates']
    assert repeated['companion']['fingerprint'] == current['companion']['fingerprint']
    observe(client, owner, pid, current)
    assert actions(client, owner, pid)['companion']['updates'] == []
    assert actions(client, doctor, pid)['companion']['updates']
    displayed_before_reply = actions(client, owner, pid)
    preflight = client.get(f"/api/v1/care/clarifications/{question['id']}/reply-context", headers=owner).json()
    reply = client.post('/api/v1/care/clarification-replies', headers=owner, json={
        'client_reply_id': 'companion-unknown-reply', 'patient_id': pid, 'assessment_id': session['id'],
        'question_id': question['id'], 'expected_assessment_version': preflight['assessment_version'],
        'expected_previous_revision': 0, 'reply_context': preflight['reply_context'],
        'answer_status': 'unknown', 'answer': None, 'confirmed': True})
    assert reply.status_code == 201, reply.text
    changed = actions(client, owner, pid)
    text = ' '.join(row['text'] for row in changed['companion']['updates'])
    assert '答复' in text and '不知道' in text and '医生确认' not in text
    # A delayed ACK records exactly its signed, displayed snapshot, not the newer reply.
    observe(client, owner, pid, displayed_before_reply)
    assert actions(client, owner, pid)['companion']['updates'] == changed['companion']['updates']
    observe(client, owner, pid, changed)
    observe(client, owner, pid, displayed_before_reply)
    assert actions(client, owner, pid)['companion']['updates'] == []


def test_observation_token_binds_actual_actor_profile_and_authority_and_has_no_body(client):
    owner, doctor, _, session, _, _ = context_and_body(client)
    pid = session['patient_id']
    ask(client, doctor, session)
    current = actions(client, owner, pid)
    token = current['companion']['observation_context']
    raw = base64.urlsafe_b64decode(token.split('.')[2] + '=' * (-len(token.split('.')[2]) % 4)).decode()
    assert 'PRIVATE_' not in raw and 'Synthetic Adult' not in raw and 'question"' not in raw
    body = {'patient_id': pid, 'observation_context': token}
    assert client.post('/api/v1/agent/companion-observations', headers=doctor, json=body).status_code == 403
    assert client.post('/api/v1/agent/companion-observations', headers=owner, json={**body, 'patient_id': pid + 999}).status_code == 409
    assert client.post('/api/v1/agent/companion-observations', headers=owner,
        json={**body, 'observation_context': token[:-1] + ('a' if token[-1] != 'a' else 'b')}).status_code == 409
    for invalid in ({**body, 'patient_id': True}, {**body, 'observation_context': 12}, {**body, 'extra': True},
                    {**body, 'observation_context': 'x' * 131073}):
        assert client.post('/api/v1/agent/companion-observations', headers=owner, json=invalid).status_code == 422
    observe(client, owner, pid, current)
    from backend.app.db.session import SessionLocal
    from backend.app.models.security import SecurityAuditLog
    with SessionLocal() as db:
        records = db.scalars(select(SecurityAuditLog).where(SecurityAuditLog.action == 'agent_companion_observed')).all()
        assert len(records) == 1 and records[0].patient_id == pid
        assert records[0].actor_user_id == current['actor_user_id']
        assert 'PRIVATE_' not in json.dumps(records[0].detail_json)
    relation = next(row for row in client.get('/api/v1/care/relationships', headers=owner).json()['items']
        if row['doctor_user_id'] == session['responsible_doctor_id'])
    old_doctor = actions(client, doctor, pid)
    assert client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=owner,
        json={'expected_revision': relation['revision']}).status_code == 200
    denied = client.post('/api/v1/agent/companion-observations', headers=doctor,
        json={'patient_id': pid, 'observation_context': old_doctor['companion']['observation_context']})
    assert denied.status_code in {403, 409}, denied.text


def test_published_report_plan_versions_and_actual_date_record_revisions_have_verifiable_updates(client):
    owner, doctor, _, session, draft, _ = saved_draft(client)
    pid = session['patient_id']
    observe(client, owner, pid, actions(client, owner, pid))
    report = client.post('/api/v1/care/review-publications', headers=doctor, json=publication_body(client, doctor, draft))
    assert report.status_code == 201, report.text
    current = actions(client, owner, pid)
    assert any('已发布' in row['text'] and '报告' in row['text'] for row in current['companion']['updates'])
    observe(client, owner, pid, current)
    ctx = client.get(f"/api/v1/care/assessments/{session['id']}/plan-context", headers=doctor).json()
    today = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    body = {'client_plan_version_id': 'companion-plan-1', 'patient_id': pid, 'assessment_id': session['id'],
        'expected_assessment_version': ctx['assessment_version'], 'expected_previous_version': ctx['expected_previous_version'],
        'expected_plan_revision': ctx['expected_plan_revision'], 'source_report_id': ctx['source_report_id'],
        'input_digest': ctx['input_digest'], 'plan_context': ctx['plan_context'], 'title': 'PRIVATE_合成计划标题',
        'instructions': 'PRIVATE_合成实际计划正文', 'start_date': str(today), 'end_date': str(today + timedelta(days=3)), 'confirmed': True}
    saved = client.post('/api/v1/care/plan-versions', headers=doctor, json=body)
    assert saved.status_code == 201, saved.text
    plan = saved.json()
    current = actions(client, owner, pid)
    assert any('计划' in row['text'] and '第 1 版' in row['text'] for row in current['companion']['updates'])
    observe(client, owner, pid, current)
    record = {'client_submission_id': 'companion-daily-1', 'patient_id': pid, 'cycle_id': plan['cycle_id'],
        'record_date': str(today), 'expected_revision': 0, 'recorded_at': None, 'content': {'note': 'PRIVATE_合成日期记录'}}
    saved_record = client.post('/api/v1/care/daily-records', headers=owner, json=record)
    assert saved_record.status_code == 201, saved_record.text
    current = actions(client, owner, pid)
    record_updates = [row['text'] for row in current['companion']['updates'] if str(today) in row['text'] and '实际记录' in row['text']]
    assert record_updates and all('医生确认' not in text and '0' not in text.replace(str(today), '') for text in record_updates)
    observe(client, owner, pid, current)
    revision = client.post('/api/v1/care/daily-records', headers=owner, json={**record,
        'client_submission_id': 'companion-daily-2', 'expected_revision': 1, 'content': {'note': 'PRIVATE_合成修订'}})
    assert revision.status_code == 201, revision.text
    current = actions(client, owner, pid)
    assert any('修订' in row['text'] and str(today) in row['text'] for row in current['companion']['updates'])
    observe(client, owner, pid, current)
    ctx = client.get(f"/api/v1/care/assessments/{session['id']}/plan-context", headers=doctor).json()
    revised = {**body, 'client_plan_version_id': 'companion-plan-2', 'expected_previous_version': 1,
        'expected_plan_revision': ctx['expected_plan_revision'], 'expected_assessment_version': ctx['assessment_version'],
        'input_digest': ctx['input_digest'], 'plan_context': ctx['plan_context'], 'start_date': str(today + timedelta(days=1))}
    result = client.post('/api/v1/care/plan-versions', headers=doctor, json=revised)
    assert result.status_code == 201, result.text
    assert any('计划' in row['text'] and '第 2 版' in row['text'] for row in actions(client, owner, pid)['companion']['updates'])


def test_history_only_keeps_no_processing_actions_and_does_not_use_old_processing_observation(client):
    owner, _, _, session, _, _ = context_and_body(client)
    pid = session['patient_id']
    before = actions(client, owner, pid)
    basic = next(row for row in client.get(f'/api/v1/patient/consents?patient_id={pid}', headers=owner).json()['items']
        if row['purpose'] == 'basic_use')
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=owner,
        json={'expected_revision': basic['revision']}).status_code == 200
    current = actions(client, owner, pid)
    assert current['mode'] == 'history_only' and current['items'] == []
    assert current['companion']['stage_key'] == 'history_only'
    assert current['companion']['resume_action_id'] is None and current['companion']['updates'] == []
    denied = client.post('/api/v1/agent/companion-observations', headers=owner,
        json={'patient_id': pid, 'observation_context': before['companion']['observation_context']})
    assert denied.status_code == 409, denied.text


def test_failed_observation_audit_rolls_back_without_consuming_business_changes(client, monkeypatch):
    owner, doctor, _, session, _, _ = context_and_body(client)
    pid = session['patient_id']
    observe(client, owner, pid, actions(client, owner, pid))
    ask(client, doctor, session)
    current = actions(client, owner, pid)
    from backend.app.services import security_service
    append = security_service._append_audit_log

    def failed(*args, **kwargs):
        if kwargs.get('action') == 'agent_companion_observed':
            raise RuntimeError('Synthetic observation audit failure')
        return append(*args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(security_service, '_append_audit_log', failed)
        result = client.post('/api/v1/agent/companion-observations', headers=owner,
            json={'patient_id': pid, 'observation_context': current['companion']['observation_context']})
        assert result.status_code == 503, result.text
    assert actions(client, owner, pid)['companion']['updates'] == current['companion']['updates']


def test_new_assessment_and_independent_cycle_are_current_business_updates_after_an_observed_baseline(client):
    from backend.tests.test_assessment_sessions import actor, created
    _, owner, pid = actor(client, suffix='companion-new-work')
    observe(client, owner, pid, actions(client, owner, pid))
    session = created(client, owner, pid)
    current = actions(client, owner, pid)
    assert any('评估' in row['text'] and f"#{session['id']}" in row['text'] for row in current['companion']['updates'])
    observe(client, owner, pid, current)
    today = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    result = client.post('/api/v1/care/cycles', headers=owner, json={'patient_id': pid,
        'client_cycle_id': 'companion-new-cycle', 'start_date': str(today - timedelta(days=13)), 'end_date': str(today)})
    assert result.status_code == 201, result.text
    cycle = result.json()
    current = actions(client, owner, pid)
    assert any('周期' in row['text'] and f"#{cycle['id']}" in row['text'] for row in current['companion']['updates'])
