"""Only synthetic temporary stores; a human decision never writes business by itself."""
import json
from datetime import datetime, timedelta
from time import sleep
from zoneinfo import ZoneInfo
from backend.tests.test_assessment_sessions import actor


def run(client, headers, pid, intent, message, *, cycle_id=None):
    ctx = client.get(f'/api/v1/agent/run-context?patient_id={pid}', headers=headers).json()
    saved = client.post('/api/v1/agent/runs', headers=headers, json={
        'client_run_id': f"new-{ctx['actor_user_id']}-{intent}-{cycle_id or 0}", 'patient_id': pid, 'intent': intent,
        'assessment_id': None, 'cycle_id': cycle_id, 'message': message,
        'expected_context_digest': ctx['input_digest'], 'run_context': ctx['run_context']})
    assert saved.status_code == 202, saved.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.agent import AgentRun
    for _ in range(300):
        with SessionLocal() as db:
            if db.get(AgentRun, saved.json()['run_id']).status not in {'queued', 'running'}:
                break
        sleep(.05)
    read = client.get(f"/api/v1/agent/runs/{saved.json()['run_id']}", headers=headers)
    assert read.status_code == 200 and read.json()['status'] == 'completed', read.text
    return read.json()['artifact']


def choose(client, headers, artifact, *, fields=None, reject=False, label='new-human-decision'):
    ctx = client.get(f"/api/v1/agent/artifacts/{artifact['id']}/decision-context", headers=headers)
    assert ctx.status_code == 200, ctx.text
    value = ctx.json()
    if not reject:
        assert 'adopt' in value['allowed_decisions'], value
    payload = {'client_decision_id': label, 'patient_id': artifact['patient_id'], 'artifact_id': artifact['id'],
        'expected_previous_version': value['expected_previous_version'], 'decision_context': value['decision_context'],
        'decision': 'reject' if reject else 'adopt', 'content': None if reject else value['default_content'],
        'reason': '本人逐项核对，仅带入表单后再确认实际业务。', 'confirmed': True}
    if fields is not None:
        payload['confirmed_fields'] = fields
    return client.post('/api/v1/agent/artifact-decisions', headers=headers, json=payload)


def test_profile_requires_each_field_confirmation_then_saves_exact_background_once(client):
    _, owner, pid = actor(client, suffix='adoption-profile')
    fields = {'sleep': {'status': 'provided', 'value': '本人实际提供的睡眠说明'},
        'medication': {'status': 'unknown', 'value': None}, 'school_work': {'status': 'skipped', 'value': None}}
    artifact = run(client, owner, pid, 'profile_fields', json.dumps(fields, ensure_ascii=False))
    missing = choose(client, owner, artifact, fields=['sleep'])
    assert missing.status_code == 422, missing.text
    decision = choose(client, owner, artifact, fields=list(fields))
    assert decision.status_code == 201, decision.text
    chosen = decision.json()
    assert chosen['target_type'] == 'assessment_background'
    assert client.get(f'/api/v1/care/assessments?patient_id={pid}', headers=owner).json()['items'] == []
    body = {'patient_id': pid, 'template_id': 'adult-demo', 'template_version': 'W03-demo-1',
        'background': {key: {**field, 'source': 'self_report', 'confirmed': True} for key, field in fields.items()},
        'source_ai_decision_id': chosen['id'], 'client_assessment_id': chosen['target_client_id']}
    wrong = {**body, 'background': {**body['background'], 'sleep': {**body['background']['sleep'], 'value': '未经核对的替换'}}}
    assert client.post('/api/v1/care/patient/assessments', headers=owner, json=wrong).status_code == 409
    saved = client.post('/api/v1/care/patient/assessments', headers=owner, json=body)
    assert saved.status_code == 201, saved.text
    assert saved.json()['background']['sleep']['value'] == fields['sleep']['value']
    assert saved.json()['background']['medication']['value'] is None
    assert saved.json()['source_ai_decision_id'] == chosen['id']
    retry = client.post('/api/v1/care/patient/assessments', headers=owner, json=body)
    assert retry.status_code == 201 and retry.json()['id'] == saved.json()['id'], retry.text
    assert len(client.get(f'/api/v1/care/assessments?patient_id={pid}', headers=owner).json()['items']) == 1


def test_cycle_summary_binds_one_cycle_and_latest_human_decision_without_changing_dates(client):
    _, owner, pid = actor(client, suffix='adoption-cycle')
    day = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    original = client.post('/api/v1/care/cycles', headers=owner, json={'patient_id': pid,
        'client_cycle_id': 'adoption-real-cycle', 'start_date': str(day-timedelta(days=13)), 'end_date': str(day)})
    assert original.status_code == 201, original.text
    cycle = original.json()
    record = client.post('/api/v1/care/daily-records', headers=owner, json={'patient_id': pid, 'cycle_id': cycle['id'],
        'record_date': str(day), 'client_submission_id': 'adoption-real-day', 'expected_revision': 0,
        'content': {'note': '真实合成困难说明，专注时长未知。'}, 'recorded_at': None})
    assert record.status_code == 201, record.text
    artifact = run(client, owner, pid, 'cycle_summary', '请整理这个实际周期。', cycle_id=cycle['id'])
    chosen_response = choose(client, owner, artifact)
    assert chosen_response.status_code == 201, chosen_response.text
    chosen = chosen_response.json()
    use = client.get(f"/api/v1/agent/artifact-decisions/{chosen['id']}/adoption-context", headers=owner)
    assert use.status_code == 200 and use.json()['cycle_id'] == cycle['id'], use.text
    ctx = client.get(f"/api/v1/care/cycles/{cycle['id']}/review-context", headers=owner).json()
    body = {'client_cycle_review_id': chosen['target_client_id'], 'patient_id': pid, 'cycle_id': cycle['id'],
        'expected_previous_version': ctx['expected_previous_version'], 'input_digest': ctx['input_digest'], 'review_context': ctx['review_context'],
        'decision': 'end', 'body': chosen['content']['text'], 'limitations': '仅核对记录覆盖，未知保持未知。',
        'reason': '本人明确结束自助周期。', 'confirmed': True, 'source_ai_decision_id': chosen['id']}
    wrong = client.post('/api/v1/care/cycle-reviews', headers=owner, json={**body, 'body': '其他未核对内容'})
    assert wrong.status_code == 409, wrong.text
    rejected = choose(client, owner, artifact, reject=True, label='cycle-summary-rejected')
    assert rejected.status_code == 201, rejected.text
    assert client.post('/api/v1/care/cycle-reviews', headers=owner, json=body).status_code == 409
    newest = choose(client, owner, artifact, label='cycle-summary-reviewed-again')
    assert newest.status_code == 201, newest.text
    body.update(client_cycle_review_id=newest.json()['target_client_id'], source_ai_decision_id=newest.json()['id'])
    saved = client.post('/api/v1/care/cycle-reviews', headers=owner, json=body)
    assert saved.status_code == 201 and saved.json()['source_ai_decision_id'] == newest.json()['id'], saved.text
    assert saved.json()['professional_confirmation'] is False
    assert client.get('/api/v1/care/daily-records/adoption-real-day', headers=owner).json() == record.json()
    actual = client.get(f"/api/v1/care/cycles/{cycle['id']}", headers=owner).json()
    assert actual['start_date'] == cycle['start_date'] and actual['end_date'] == cycle['end_date'] and len(actual['records']) == 1


def test_professional_cycle_summary_still_needs_its_actual_responsible_doctor(client):
    from backend.tests.test_cycle_reviews import actual_plan
    owner, doctor, _, session, plan, record, _ = actual_plan(client)
    patient_artifact = run(client, owner, session['patient_id'], 'cycle_summary', '整理实际周期', cycle_id=plan['cycle_id'])
    denied = client.get(f"/api/v1/agent/artifacts/{patient_artifact['id']}/decision-context", headers=owner)
    assert denied.status_code == 200 and denied.json()['allowed_decisions'] == ['reject'], denied.text
    # A cycle, rather than an arbitrary assessment picker, supplies the doctor's actual plan basis.
    doctor_artifact = run(client, doctor, session['patient_id'], 'cycle_summary', '核对实际周期摘要', cycle_id=plan['cycle_id'])
    chosen = choose(client, doctor, doctor_artifact)
    assert chosen.status_code == 201, chosen.text
    ctx = client.get(f"/api/v1/care/cycles/{plan['cycle_id']}/review-context", headers=doctor).json()
    saved = client.post('/api/v1/care/cycle-reviews', headers=doctor, json={
        'client_cycle_review_id': chosen.json()['target_client_id'], 'patient_id': session['patient_id'], 'cycle_id': plan['cycle_id'],
        'expected_previous_version': 0, 'input_digest': ctx['input_digest'], 'review_context': ctx['review_context'],
        'decision': 'end', 'body': chosen.json()['content']['text'], 'limitations': '仅合成资料，覆盖不能判断效果。',
        'reason': '实际负责医生核对并决定结束。', 'confirmed': True, 'source_ai_decision_id': chosen.json()['id']})
    assert saved.status_code == 201 and saved.json()['professional_confirmation'] is True, saved.text
    assert client.get('/api/v1/care/daily-records/cycle-actual-day', headers=owner).json() == record
