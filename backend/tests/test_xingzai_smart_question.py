"""Per-message permission: actual runner/consent; synthetic model transport only."""
import json
from time import monotonic

import pytest
from backend.tests.test_agent_provider import frame_and_request, config, install_transport, response

PERMISSION = {'version': 'Xingzai-current-message-1', 'confirmed': True}


@pytest.mark.parametrize('role,entry', [('researcher', '底部“用户”'), ('patient', '我的数据与报告')])
def test_smart_help_receives_verified_navigation_for_current_role_without_private_records(monkeypatch, role, entry):
    frame, request = frame_and_request()
    frame['role'] = role
    request.update(intent='question', message='影像报告在哪里看？', external_message_consent=PERMISSION)
    provider, sent = install_transport(monkeypatch, [response({'content': '请打开已生成影像报告与实际审核版本。'})])
    provider.run_provider(frame, request, settings=config(), authorize_dispatch=lambda **_: True,
        execute_authorized_tool=lambda *_: pytest.fail('Help must not execute tools'))
    prompt = sent[0]['messages'][0]['content']
    assert entry in prompt and '已生成影像报告与实际审核版本' in prompt
    assert 'PRIVATE_' not in json.dumps(sent) and 'patient_id' not in json.dumps(sent)


def test_explicit_smart_question_sends_only_this_message_and_cannot_call_tools(monkeypatch):
    frame, request = frame_and_request()
    request.update(intent='question', message='我拖延了一件事情，怎样把大任务拆成小步骤？', external_message_consent=PERMISSION)
    provider, sent = install_transport(monkeypatch, [response({'content': '可以呀。先说一个你想完成的任务，我们从最容易开始的一小步做起。'})])
    reservations = []
    body, _, metrics = provider.run_provider(frame, request, settings=config(), authorize_dispatch=lambda **kw: reservations.append(kw),
        execute_authorized_tool=lambda *_: pytest.fail('Free questions must not execute model tools'), deadline=monotonic()+60)
    assert len(sent) == len(reservations) == metrics['model_round_count'] == 1
    assert sent[0]['messages'][-1] == {'role': 'user', 'content': request['message']}
    assert len(sent[0]['messages']) == 2 and 'tools' not in sent[0]
    assert 'PRIVATE_' not in json.dumps(sent) and 'patient_id' not in json.dumps(sent)
    assert body['provider_narrative'] is True and body['summary']['missing_items'] == 1


def test_false_or_other_version_permission_cannot_send_raw_text(monkeypatch):
    frame, request = frame_and_request()
    request.update(intent='question', message='嗨，我想聊一个不在固定分类中的问题')
    provider, sent = install_transport(monkeypatch, [])
    for consent in ({**PERMISSION, 'confirmed': False}, {**PERMISSION, 'version': 'other'}):
        with pytest.raises(provider.ProviderFailure):
            provider.run_provider(frame, {**request, 'external_message_consent': consent}, settings=config(),
                authorize_dispatch=lambda **_: True, execute_authorized_tool=lambda *_: {}, deadline=monotonic()+60)
    assert sent == []


@pytest.mark.parametrize('model_message', [
    {'content': None, 'tool_calls': [{'id': 'untrusted-write', 'type': 'function', 'function': {'name': 'publish_plan', 'arguments': '{}'}}]},
    {'content': '建议每天服用100mg药物，接下来直接加药。'},
])
def test_text_only_output_cannot_execute_a_tool_or_present_medication_instructions(monkeypatch, model_message):
    frame, request = frame_and_request()
    request.update(intent='question', message='在小程序做测试跟不上怎么办？', external_message_consent=PERMISSION)
    provider, sent = install_transport(monkeypatch, [response(model_message)])
    with pytest.raises(provider.ProviderFailure):
        provider.run_provider(frame, request, settings=config(), authorize_dispatch=lambda **_: True,
            execute_authorized_tool=lambda *_: pytest.fail('No model tools in per-message conversation'))
    assert len(sent) == 1


def test_attention_help_is_in_scope_but_unrelated_life_chat_stays_local(monkeypatch):
    from backend.app.services.agent.companion import is_product_question
    from backend.app.services.agent.artifacts import rule_artifact
    frame, request = frame_and_request()
    assert is_product_question('学习时容易走神和拖延，可以怎么做？') is True
    assert is_product_question('小程序点完保存没有反应怎么办？') is True
    assert is_product_question('帮我安排一个旅游攻略') is False
    request.update(intent='question', message='学习时总走神和拖延')
    body, _, _ = rule_artifact(frame, request)
    assert body['question_topic'] == 'attention_help' and '共享消息' in body['reply']
    request.update(message='帮我安排一个旅游攻略', external_message_consent=PERMISSION)
    provider, sent = install_transport(monkeypatch, [])
    with pytest.raises(provider.ProviderFailure, match='product_help_only'):
        provider.run_provider(frame, request, settings=config(), authorize_dispatch=lambda **_: True, execute_authorized_tool=lambda *_: {})
    assert not sent


def test_smart_run_requires_original_care_purpose_and_exact_ack_but_default_question_stays_local(client, monkeypatch):
    from backend.tests.test_review_drafts import context_and_body
    from backend.app.core.config import settings
    from backend.app.services.agent import runner
    owner, doctor, _, session, _, _ = context_and_body(client)
    for key, value in vars(config()).items():
        monkeypatch.setattr(settings, key, value)
    provider, sent = install_transport(monkeypatch, [response({'content': '先选一件最想做的事。我们一起把第一步变小一点。'})])
    monkeypatch.setattr(runner, 'schedule_run', lambda *_: None)
    def prepare(label, smart=True):
        ctx = client.get(f"/api/v1/agent/run-context?patient_id={session['patient_id']}&question_mode={'smart' if smart else 'local'}", headers=doctor).json()
        body = {'client_run_id': label, 'patient_id': session['patient_id'], 'intent': 'question', 'assessment_id': None, 'cycle_id': None,
            'message': '我想在小程序完成评估，应该如何开始？', 'expected_context_digest': ctx['input_digest'], 'run_context': ctx['run_context']}
        if smart:
            body['external_message_consent'] = PERMISSION
        return ctx, body
    _, body = prepare('smart-no-purpose')
    assert client.post('/api/v1/agent/runs', headers=doctor, json=body).status_code == 403
    grant = client.post('/api/v1/patient/consents', headers=owner, json={'patient_id': session['patient_id'], 'purpose': 'external_ai', 'scope': ['care'], 'terms_version': 'W02-1'})
    assert grant.status_code == 201, grant.text
    _, local = prepare('explicit-local', False)
    queued = client.post('/api/v1/agent/runs', headers=doctor, json=local)
    assert queued.status_code == 202 and queued.json()['original_request'] == local
    from backend.app.db.session import SessionLocal
    assert runner.execute_one(SessionLocal, queued.json()['id']) is True
    assert not sent
    ctx, body = prepare('explicit-smart')
    assert ctx['external_ai']['required_scopes'] == ['care']
    accepted = client.post('/api/v1/agent/runs', headers=doctor, json=body)
    assert accepted.status_code == 202, accepted.text
    ack = accepted.json()
    assert ack['original_request'] == body
    assert client.get('/api/v1/agent/runs/submissions/explicit-smart', headers=doctor).json() == ack
    changed = {**body, 'external_message_consent': {**PERMISSION, 'confirmed': False}}
    assert client.post('/api/v1/agent/runs', headers=doctor, json=changed).status_code in {409, 422}
    assert runner.execute_one(SessionLocal, ack['id']) is True
    actual = client.get(f"/api/v1/agent/runs/{ack['id']}", headers=doctor).json()
    assert actual['status'] == 'completed' and actual['mode'] == 'remote' and len(sent) == 1
    _, revoked_body = prepare('smart-revoked-before-dispatch')
    revoked_ack = client.post('/api/v1/agent/runs', headers=doctor, json=revoked_body).json()
    assert client.post(f"/api/v1/patient/consents/{grant.json()['id']}/withdraw", headers=owner, json={'expected_revision': grant.json()['revision']}).status_code == 200
    assert runner.execute_one(SessionLocal, revoked_ack['id']) is False
    assert len(sent) == 1
    assert client.get('/api/v1/agent/runs/submissions/smart-revoked-before-dispatch', headers=doctor).json() == revoked_ack
