"""Synthetic competition walkthrough, using real APIs in a marked test store only.

No production stores, external AI, training, fabricated database clinical states,
or patched business clocks are used. Doctor qualification is an explicitly
synthetic institution fixture; decisions below are synthetic demo decisions.
"""
from __future__ import annotations

from datetime import date, timedelta
import json
import os
from pathlib import Path
from secrets import token_urlsafe
from time import monotonic, sleep


def _isolated_runtime(runtime: Path, root: Path) -> None:
    from sqlalchemy.engine import make_url
    from backend.app.core.config import settings
    from backend.app.db.session import engine

    assert settings.APP_ENV == 'test', 'Competition fixtures require APP_ENV=test.'
    assert runtime.is_dir() and runtime != root, 'A separate disposable runtime is required.'
    marker = runtime / 'competition-demo.json'
    assert marker.is_file(), 'An explicit synthetic runtime marker is required.'
    assert json.loads(marker.read_text(encoding='utf-8')).get('synthetic') is True, 'Invalid synthetic runtime marker.'
    configured = make_url(settings.DATABASE_URL)
    assert configured.drivername == 'sqlite' and configured.database, 'Only isolated SQLite fixtures are supported.'
    db = Path(configured.database)
    assert db.is_absolute() and db.resolve().is_relative_to(runtime), 'Database must be absolute and inside the synthetic runtime.'
    assert Path(engine.url.database).resolve() == db.resolve(), 'The active database does not match the isolated configuration.'
    assert db.resolve() != (root / 'backend' / 'app.db').resolve(), 'The development database is forbidden.'
    for setting in ('AUTHORIZATION_LEDGER_PATH', 'SECURITY_MASTER_KEY_PATH', 'UPLOAD_ROOT'):
        value = Path(getattr(settings, setting))
        assert value.is_absolute() and value.resolve().is_relative_to(runtime), f'{setting} must stay inside the synthetic runtime.'
    # Findviz reads this environment variable directly rather than via Settings.
    cache = Path(os.environ.get('FINDVIZ_CACHE_ROOT', ''))
    assert cache.is_absolute() and cache.resolve().is_relative_to(runtime), 'FINDVIZ_CACHE_ROOT must stay inside the synthetic runtime.'
    assert not settings.DEEPSEEK_API_KEY, 'External AI must remain disabled for competition provisioning.'


def _request(client, method, path, headers=None, body=None, status=200):
    response = client.request(method, path, headers=headers, **({'json': body} if body is not None else {}))
    assert response.status_code == status, f'{method} {path}: {response.status_code} {response.text}'
    return response.json()


def _account(client, key, name, role, password):
    email = f'{key}@competition.example.com'
    payload = {'email': email, 'password': password, 'full_name': name, 'role': role, 'consent_agreed': role == 'patient'}
    if role == 'patient':
        payload['patient_profile'] = {'age': 26 if key == 'review' else 29, 'gender': 'other', 'patient_type': 'adult', 'display_name': name}
    registered = _request(client, 'POST', '/api/v1/auth/register', body=payload, status=201)
    logged_in = _request(client, 'POST', '/api/v1/auth/login', body={'identifier': email, 'password': password, 'role': role})
    assert logged_in['user']['id'] == registered['user']['id']
    account = {'email': email, 'password': password, 'role': role, 'label': '合成演示', **logged_in}
    return account, {'Authorization': 'Bearer ' + logged_in['access_token']}


def _relationship(client, patient, owner, doctor):
    invitation = _request(client, 'POST', '/api/v1/care/relationships/invitations', doctor, {
        'target_email': patient['email'], 'patient_id': patient['user']['patient_profile']['id'],
        'scope': ['profile', 'assessment', 'tracking', 'care', 'imaging'], 'purpose': 'clinical_sharing'}, 201)
    return _request(client, 'POST', f"/api/v1/care/relationships/{invitation['id']}/accept", owner, {'expected_revision': invitation['revision']})


def _assessment(client, key, patient, owner, doctor, *, wait_for_processing=None):
    from backend.tests.test_assessment_sessions import start
    from backend.tests.test_submission_cognitive_evidence import cognitive_submission

    pid = patient['user']['patient_profile']['id']
    session = _request(client, 'POST', '/api/v1/care/doctor/assessments', doctor, {
        'patient_id': pid, 'template_id': 'adult-demo', 'template_version': 'W03-demo-1',
        'background': {'history': {'status': 'provided', 'source': 'patient_report',
            'value': '合成演示资料：用于展示协作流程，不代表真实患者、诊断或疗效。', 'confirmed': True}}}, 201)
    session = _request(client, 'POST', f"/api/v1/care/assessments/{session['id']}/publish", doctor, {'expected_version': session['version']})
    item = session['items'][0]
    response = start(client, owner, item, pid)
    assert response.status_code == 201, response.text
    attempt = response.json()
    body = {'submission_id': f'competition-{key}-scale', 'kind': 'scale', 'patient_id': pid,
        'assessment_id': session['id'], 'assessment_item_id': item['id'], 'attempt_id': attempt['id'],
        'run_id': attempt['run_id'], 'task_id': item['patient_task_id'],
        **{field: attempt[field] for field in ('protocol_id', 'protocol_schema_version', 'config_digest', 'template_digest',
            'actor_user_id', 'performer_kind', 'performer_user_id', 'performer_patient_id', 'respondent_user_id', 'respondent_kind', 'submitter_user_id')},
        'content': {'scale_type': item['instrument'], 'answers': [1, 2, 1, 2, 1, 1, 2, 1, 0, 1, 2, 1, 1, 1, 0, 2, 1, 1],
            'recall_window': item['recall_window'], 'content_digest': item['content_digest']}}
    receipts = [_request(client, 'POST', '/api/v1/care/submissions', owner, body, 201)]
    for task in ('reaction', 'stroop', 'flanker', 'nback', 'trail', 'digit'):
        _, _, cognitive_item, _, content = cognitive_submission(client, task, context=(owner, session, pid))
        content['submission_id'] = f'competition-{key}-{task}'
        content['task_id'] = cognitive_item['patient_task_id']
        receipts.append(_request(client, 'POST', '/api/v1/care/submissions', owner, content, 201))
    if wait_for_processing is None:
        from backend.tests.test_assessment_consumers import drain
        drain()
    else:
        wait_for_processing(client, owner, session['id'])
    current = _request(client, 'GET', f"/api/v1/care/assessments/{session['id']}", owner)
    assert current['status'] == 'under_review' and all(row['acceptance_status'] == 'pending_review' for row in current['items'])
    for receipt in receipts:
        recovered = _request(client, 'GET', f"/api/v1/care/submissions/{receipt['submission_id']}", owner)
        # The API deliberately adds the live aggregate status/version to an
        # immutable submission receipt. Later submissions advance those fields.
        live_fields = {'assessment_status', 'assessment_version', 'item_version'}
        assert {key: value for key, value in recovered.items() if key not in live_fields} == {
            key: value for key, value in receipt.items() if key not in live_fields}, receipt['submission_id']
    return {'patient_id': pid, 'assessment': current, 'submissions': receipts}


def _clarification(client, scenario, doctor):
    sid = scenario['assessment']['id']
    ctx = _request(client, 'GET', f'/api/v1/care/assessments/{sid}/review-context', doctor)
    return _request(client, 'POST', '/api/v1/care/clarifications', doctor, {
        'client_question_id': 'competition-review-question', 'patient_id': scenario['patient_id'], 'assessment_id': sid,
        'expected_assessment_version': ctx['assessment_version'], 'input_digest': ctx['input_digest'], 'review_context': ctx['review_context'],
        'source_type': 'submission', 'source_key': ctx['submissions'][0]['submission_id'],
        'question': '【合成演示】请补充本次量表回顾期间的学习或工作情境；不清楚或不便提供可以说明。', 'confirmed': True}, 201)


def _report_and_plan(client, scenario, owner, doctor):
    sid, pid = scenario['assessment']['id'], scenario['patient_id']
    ctx = _request(client, 'GET', f'/api/v1/care/assessments/{sid}/review-context', doctor)
    review = _request(client, 'POST', '/api/v1/care/reviews', doctor, {
        'client_review_id': 'competition-followup-review', 'patient_id': pid, 'assessment_id': sid,
        'expected_assessment_version': ctx['assessment_version'], 'input_digest': ctx['input_digest'], 'review_context': ctx['review_context'],
        'category': 'evidence_review', 'body': '【合成演示】已核对本轮量表和六项认知任务的原始材料。材料仅用于展示审核与后续记录流程，不构成诊断。建议按计划记录实际日期与未知项，后续由专业人员结合完整资料讨论。',
        'limitations': '全部身份、量表答案和试次均为合成测试数据；移动设备等效性未经验证，不能用于真实临床判断或证明治疗效果。',
        'decisions': [{'submission_id': row['submission_id'], 'assessment_item_id': row['assessment_item_id'], 'attempt_id': row['attempt_id'],
            'decision': 'accepted', 'reason': '合成演示材料核对：服务器验证有效；仅接受为本轮演示证据，不代表诊断。'} for row in ctx['submissions']], 'confirmed': True}, 201)
    publication = _request(client, 'GET', f"/api/v1/care/reviews/{review['id']}/publication-context", doctor)
    report = _request(client, 'POST', '/api/v1/care/review-publications', doctor, {
        'client_publication_id': 'competition-followup-report', 'patient_id': pid, 'assessment_id': sid, 'review_id': review['id'],
        'expected_assessment_version': publication['expected_assessment_version'], 'expected_previous_report_version': publication['expected_previous_report_version'],
        'input_digest': review['input_digest'], 'publication_context': publication['publication_context'], 'confirmed': True}, 201)
    assert _request(client, 'GET', f"/api/v1/care/reports/{report['id']}", owner)['id'] == report['id']
    ctx = _request(client, 'GET', f'/api/v1/care/assessments/{sid}/plan-context', doctor)
    today = date.fromisoformat(ctx['calendar_today'])
    plan = _request(client, 'POST', '/api/v1/care/plan-versions', doctor, {
        **{field: ctx[field] for field in ('patient_id', 'assessment_id', 'expected_previous_version', 'expected_plan_revision', 'source_report_id', 'input_digest', 'plan_context')},
        'client_plan_version_id': 'competition-followup-plan', 'expected_assessment_version': ctx['assessment_version'],
        'title': '合成演示 · 14天日常观察记录', 'instructions': '每天按实际日期记录注意状态、日常活动和需要讨论的情况；未知值留空，不补造数据。可以通过共享消息反馈。此计划为合成流程演示，不含用药、诊断或疗效承诺。',
        'start_date': today.isoformat(), 'end_date': (today + timedelta(days=13)).isoformat(), 'confirmed': True}, 201)
    ackctx = _request(client, 'GET', f"/api/v1/care/plan-versions/{plan['id']}/acknowledgement-context", owner)
    acknowledgement = _request(client, 'POST', '/api/v1/care/plan-acknowledgements', owner, {
        'client_acknowledgement_id': 'competition-followup-received', 'patient_id': pid, 'assessment_id': sid,
        'plan_version_id': plan['id'], 'acknowledgement_context': ackctx['acknowledgement_context'], 'confirmed': True}, 201)
    actual = _request(client, 'POST', '/api/v1/care/daily-records', owner, {
        'client_submission_id': 'competition-professional-today', 'patient_id': pid, 'cycle_id': plan['cycle_id'],
        'record_date': today.isoformat(), 'expected_revision': 0, 'recorded_at': None,
        'content': {'note': '【合成演示】今天收到专业计划并记录一条日常观察，专注时长未知。', 'focus_minutes': None, 'mood_tag': '平静'}}, 201)
    scenario.update(review=review, report=report, plan_publication=plan, acknowledgement=acknowledgement, professional_record=actual,
        plan=_request(client, 'GET', f"/api/v1/care/plans/{plan['plan_id']}", owner),
        cycle=_request(client, 'GET', f"/api/v1/care/cycles/{plan['cycle_id']}", owner))
    return today


def _history(client, scenario, owner, today):
    pid = scenario['patient_id']
    cycle = _request(client, 'POST', '/api/v1/care/cycles', owner, {'patient_id': pid,
        'client_cycle_id': 'competition-historical-self-cycle', 'cycle_type': 'self',
        'start_date': (today - timedelta(days=13)).isoformat(), 'end_date': today.isoformat()}, 201)
    for index, (offset, focus) in enumerate(((-13, 18), (-11, 25), (-8, None), (-6, 22), (-3, 20), (-1, None), (0, 24))):
        _request(client, 'POST', '/api/v1/care/daily-records', owner, {
            'client_submission_id': f'competition-self-day-{index + 1}', 'patient_id': pid, 'cycle_id': cycle['id'],
            'record_date': (today + timedelta(days=offset)).isoformat(), 'expected_revision': 0, 'recorded_at': None,
            'content': {'focus_minutes': focus, 'mood_tag': ('平静', '一般', '忙碌')[index % 3],
                'note': '【合成演示·自助历史】样例观察，未记录项目保持未知；缺日不补造。', 'is_medication': None}}, 201)
    scenario['historical_self_cycle'] = _request(client, 'GET', f"/api/v1/care/cycles/{cycle['id']}", owner)
    scenario['historical_self_cycle_note'] = '合成自助历史周期，与今天新发布的专业计划分别保存；7个记录日、7个缺日，未知值为null。'


def _messages(client, scenario, owner, doctor, relationship):
    pid, rid = scenario['patient_id'], relationship['id']
    receipts = []
    for index, (headers, content) in enumerate(((owner, '【合成演示】我已收到14天观察安排。历史自助记录有缺日和未知值，想在后续沟通时说明。'),
            (doctor, '【合成演示】已看到反馈。请继续按实际日期记录，未知内容保留为空；我们后续核对具体情境。本消息不代表已完成阶段评估。'))):
        contexts = _request(client, 'GET', f'/api/v1/care/shared-messages/relationships?patient_id={pid}', headers)
        context = next(row for row in contexts['items'] if row['relationship_id'] == rid)
        body = {'patient_id': pid, 'relationship_id': rid, 'client_message_id': f'competition-followup-message-{index + 1}',
            'content': content, 'confirmed': True, 'send_context': context['send_context']}
        if receipts:
            body['reply_to_message_id'] = receipts[0]['message_id']
        receipts.append(_request(client, 'POST', '/api/v1/care/shared-messages', headers, body, 201))
    scenario['messages'] = receipts
    scenario['message_read_receipt'] = _request(client, 'POST', f"/api/v1/care/shared-messages/{receipts[0]['message_id']}/read", doctor)


def _agent(client, scenario, owner):
    pid = scenario['patient_id']
    ctx = _request(client, 'GET', f'/api/v1/agent/run-context?patient_id={pid}', owner)
    accepted = _request(client, 'POST', '/api/v1/agent/runs', owner, {
        'client_run_id': 'competition-followup-rule-summary', 'patient_id': pid, 'intent': 'assessment_summary',
        'assessment_id': scenario['assessment']['id'], 'cycle_id': None, 'message': '请根据已保存的合成材料整理本轮进度，并保留局限和下一步人工核对入口。',
        'expected_context_digest': ctx['input_digest'], 'run_context': ctx['run_context']}, 202)
    deadline = monotonic() + 20
    while True:
        run = _request(client, 'GET', f"/api/v1/agent/runs/{accepted['run_id']}", owner)
        if run['status'] not in ('queued', 'running') or monotonic() >= deadline:
            break
        sleep(0.05)
    assert run['status'] == 'completed' and run['mode'] == 'rules' and run['model_round_count'] == 0, run
    assert run['artifact']['status'] == 'draft', run
    scenario['agent'] = run


def provision(client, runtime, root):
    """Provision one doctor and two adults; ``client`` must have an active lifespan."""
    runtime, root = Path(runtime).resolve(), Path(root).resolve()
    _isolated_runtime(runtime, root)
    from backend.tests.w02_helpers import qualify

    password = 'Demo-' + token_urlsafe(12) + '9!'
    doctor, clinician = _account(client, 'doctor', '演示医生·林（合成）', 'researcher', password)
    qualify(doctor['user']['id'])
    review, review_owner = _account(client, 'review', '演示用户·小禾（合成）', 'patient', password)
    followup, followup_owner = _account(client, 'followup', '演示用户·小安（合成）', 'patient', password)
    review_relation = _relationship(client, review, review_owner, clinician)
    followup_relation = _relationship(client, followup, followup_owner, clinician)
    reviewing = _assessment(client, 'review', review, review_owner, clinician)
    following = _assessment(client, 'followup', followup, followup_owner, clinician)
    reviewing['relationship'] = review_relation
    following['relationship'] = followup_relation
    reviewing['clarification'] = _clarification(client, reviewing, clinician)
    today = _report_and_plan(client, following, followup_owner, clinician)
    _history(client, following, followup_owner, today)
    _messages(client, following, followup_owner, clinician, followup_relation)
    _agent(client, following, followup_owner)
    reviewing['assessment'] = _request(client, 'GET', f"/api/v1/care/assessments/{reviewing['assessment']['id']}", review_owner)
    following['assessment'] = _request(client, 'GET', f"/api/v1/care/assessments/{following['assessment']['id']}", followup_owner)
    assert following['assessment']['status'] == 'reviewed', following['assessment']['status']
    cross_read = client.get(f"/api/v1/care/assessments/{reviewing['assessment']['id']}", headers=followup_owner)
    assert cross_read.status_code == 403, cross_read.text
    queue = _request(client, 'GET', '/api/v1/care/doctor/work_queue', clinician)
    assert any(row['assessment_id'] == reviewing['assessment']['id'] for row in queue['items'])
    return {'synthetic_only': True, 'source_created_via_production_api_testclient': True,
        'external_ai_enabled': False, 'training_performed': False, 'calendar_today': today.isoformat(),
        'accounts': {'doctor': doctor, 'review': review, 'followup': followup},
        'scenarios': {'review': reviewing, 'followup': following}, 'doctor_work_queue': queue,
        'evidence': {'cross_patient_read_status': cross_read.status_code, 'immutable_submission_receipts_recovered': 14,
            'qualification_source': 'synthetic-institution: explicit isolated-test verification fixture',
            'clinical_state_source': 'production API decisions and durable care event consumer; no direct clinical DB writes',
            'professional_plan_starts_today': True, 'historical_records_source': 'separate synthetic self cycle; no historical professional execution invented'}}
