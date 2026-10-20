"""Selected real dialogue is confirmed once, frozen, and dispatched on synthetic HTTP only."""
import json

import pytest
from pydantic import ValidationError

from backend.tests.test_agent_provider import config, frame_and_request, install_transport, response

POLICY = 'Xingzai-selected-dialogue-1'
PERMISSION = {'version': POLICY, 'confirmed': True}


def preview(*turns):
    from backend.app.services.cognitive_contract import canonical_digest
    value = {'policy_version': POLICY, 'turns': [
        {'run_id': identifier, 'user_message': question, 'assistant_message': answer}
        for identifier, question, answer in turns]}
    return {**value, 'digest': canonical_digest(value)}


def test_selected_dialogue_ids_are_strict_positive_unique_and_bounded():
    from backend.app.schemas.agent import AgentRunCreate
    value = dict(client_run_id='selected-schema', patient_id=9, intent='question', message='继续帮我拆解这个任务',
        expected_context_digest='a'*64, run_context='x'*20, external_message_consent=PERMISSION)
    assert AgentRunCreate(**value, context_run_ids=[1, 2]).context_run_ids == [1, 2]
    for invalid in ([1, 1], [0], [-1], [True], ['1'], [1, 2, 3]):
        with pytest.raises(ValidationError):
            AgentRunCreate(**value, context_run_ids=invalid)


def test_preview_text_limit_is_exact_and_never_silently_truncated():
    from backend.app.services.agent.provider_authority import validate_dialogue_preview
    from fastapi import HTTPException
    complete = preview((17, '学'*3999, '好'))
    assert validate_dialogue_preview(complete, [17]) == complete
    too_long = preview((17, '学'*4000, '好'))
    with pytest.raises(HTTPException) as failure:
        validate_dialogue_preview(too_long, [17])
    assert failure.value.status_code == 422 and len(too_long['turns'][0]['user_message']) == 4000


def test_exact_selected_turns_and_current_message_are_only_model_text(monkeypatch):
    frame, request = frame_and_request()
    selected = preview((17, '学习拖延时如何开始？', '先把作业缩成一个具体步骤。'),
        (18, '作业第一步怎样变小？', '先打开书，找到今天的题目。'))
    request.update(intent='question', message='继续帮我细化刚才这个步骤', context_run_ids=[17, 18], external_message_consent=PERMISSION)
    provider, sent = install_transport(monkeypatch, [response({'content': '先只看一道题的题目，再说说最卡住的一个地方。'})])
    body, _, _ = provider.run_provider(frame, request, conversation_preview=selected, settings=config(),
        authorize_dispatch=lambda **_: True, execute_authorized_tool=lambda *_: pytest.fail('Dialogue cannot use tools'))
    assert sent[0]['messages'][1:] == [
        {'role': role, 'content': turn[field]}
        for turn in selected['turns'] for role, field in [('user', 'user_message'), ('assistant', 'assistant_message')]
    ] + [{'role': 'user', 'content': request['message']}]
    assert 'tools' not in sent[0] and 'PRIVATE_' not in json.dumps(sent)
    assert 'patient_id' not in json.dumps(sent) and 'run_id' not in json.dumps(sent)
    assert body['reply'] == '先只看一道题的题目，再说说最卡住的一个地方。'
    assert body['external_field_policy'] == POLICY


@pytest.mark.parametrize('question,answer,current,code', [
    ('是不是ADHD，需要什么诊断？', '请咨询医生。', '刚才那个继续说', 'local_safety_boundary'),
    ('我想伤害自己', '请联系家人和医生。', '刚才那个继续说', 'local_safety_boundary'),
    ('我想停药，可以吗？', '需要负责医生判断。', '刚才那个继续说', 'local_safety_boundary'),
    ('注意力困难，I want to hurt myself', 'Please contact a trusted person.', '刚才那个继续说', 'local_safety_boundary'),
    ('学习时注意力不集中', '先缩小任务。', '帮我做一份旅游攻略', 'product_help_only'),
    ('学习时注意力不集中', '先缩小任务。', '告诉我一份法国食谱', 'product_help_only'),
])
def test_history_cannot_evade_local_safety_or_expand_unrelated_current_topic(monkeypatch, question, answer, current, code):
    frame, request = frame_and_request()
    selected = preview((17, question, answer))
    request.update(intent='question', message=current, context_run_ids=[17], external_message_consent=PERMISSION)
    provider, sent = install_transport(monkeypatch, [])
    with pytest.raises(provider.ProviderFailure, match=code):
        provider.run_provider(frame, request, conversation_preview=selected, settings=config(),
            authorize_dispatch=lambda **_: True, execute_authorized_tool=lambda *_: {})
    assert not sent


def test_selected_preview_missing_changed_or_under_old_permission_never_dispatches(monkeypatch):
    frame, request = frame_and_request()
    selected = preview((17, '学习拖延怎么开始？', '先打开书。'))
    request.update(intent='question', message='继续刚才那个步骤', context_run_ids=[17], external_message_consent=PERMISSION)
    provider, sent = install_transport(monkeypatch, [])
    for changed, permission in [(None, PERMISSION), ({**selected, 'digest': '0'*64}, PERMISSION),
            (selected, {'version': 'Xingzai-current-message-1', 'confirmed': True}),
            (selected, {**PERMISSION, 'confirmed': False})]:
        with pytest.raises(provider.ProviderFailure):
            provider.run_provider(frame, {**request, 'external_message_consent': permission}, conversation_preview=changed,
                settings=config(), authorize_dispatch=lambda **_: True, execute_authorized_tool=lambda *_: {})
    assert not sent


def get_context(client, headers, patient_id, *, identifiers=None, mode='smart'):
    params = [('patient_id', patient_id), ('question_mode', mode)]
    params += [('context_run_ids', identifier) for identifier in identifiers or []]
    return client.get('/api/v1/agent/run-context', headers=headers, params=params)


def enqueue(client, headers, patient_id, label, *, context=None, identifiers=None, message='继续刚才这个步骤', intent='question'):
    context = context or get_context(client, headers, patient_id, identifiers=identifiers).json()
    body = {'client_run_id': label, 'patient_id': patient_id, 'intent': intent, 'assessment_id': None, 'cycle_id': None,
        'message': message, 'expected_context_digest': context['input_digest'], 'run_context': context['run_context']}
    if identifiers is not None:
        body['context_run_ids'] = identifiers
    if context.get('question_mode') == 'smart':
        body['external_message_consent'] = PERMISSION if identifiers else {'version': 'Xingzai-current-message-1', 'confirmed': True}
    result = client.post('/api/v1/agent/runs', headers=headers, json=body)
    return result, body


def setup_real_sources(client, monkeypatch):
    from backend.tests.test_review_drafts import context_and_body
    from backend.app.services.agent import runner
    from backend.app.db.session import SessionLocal
    owner, doctor, incoming, session, _, _ = context_and_body(client)
    monkeypatch.setattr(runner, 'schedule_run', lambda *_: None)
    patient_id = session['patient_id']
    identifiers = []
    for index, message in enumerate(('学习拖延时怎样开始？', '做作业总是走神，怎样把任务变小？')):
        context = get_context(client, doctor, patient_id, mode='local').json()
        result, _ = enqueue(client, doctor, patient_id, f'selected-source-{index}', context=context, message=message)
        assert result.status_code == 202, result.text
        assert runner.execute_one(SessionLocal, result.json()['id']) is True
        identifiers.append(result.json()['id'])
    grant = client.post('/api/v1/patient/consents', headers=owner,
        json={'patient_id': patient_id, 'purpose': 'external_ai', 'scope': ['care'], 'terms_version': 'W02-1'})
    assert grant.status_code == 201, grant.text
    return owner, doctor, incoming, session, identifiers, grant.json()


def test_real_runs_preview_and_dispatch_exactly_then_reject_replaced_selection_and_old_policy(client, monkeypatch):
    owner, doctor, _, session, identifiers, _ = setup_real_sources(client, monkeypatch)
    from backend.app.core.config import settings
    from backend.app.services.agent import runner
    from backend.app.db.session import SessionLocal
    from backend.app.models.agent import AgentRun
    for key, value in vars(config()).items():
        monkeypatch.setattr(settings, key, value)
    provider, sent = install_transport(monkeypatch, [response({'content': '先选一道题，只读题目就好。'})])
    patient_id = session['patient_id']
    context = get_context(client, doctor, patient_id, identifiers=identifiers)
    assert context.status_code == 200, context.text
    context = context.json()
    selected = context['conversation_preview']
    assert selected['policy_version'] == POLICY
    assert [turn['run_id'] for turn in selected['turns']] == identifiers
    for turn in selected['turns']:
        original = client.get(f"/api/v1/agent/runs/{turn['run_id']}", headers=doctor).json()
        assert turn['user_message'] == original['original_message']
        assert turn['assistant_message'] == original['artifact']['body']['reply']
    replaced, _ = enqueue(client, doctor, patient_id, 'changed-selected', context=context, identifiers=identifiers[:1])
    assert replaced.status_code == 409, replaced.text
    candidate, body = enqueue(client, doctor, patient_id, 'exact-selected', context=context, identifiers=identifiers)
    assert candidate.status_code == 202, candidate.text
    ack = candidate.json()
    assert ack['original_request'] == body
    assert client.post('/api/v1/agent/runs', headers=doctor, json=body).json() == ack
    assert client.post('/api/v1/agent/runs', headers=doctor, json={**body, 'client_run_id': 'old-selected-permission',
        'external_message_consent': {'version': 'Xingzai-current-message-1', 'confirmed': True}}).status_code == 422
    assert client.post('/api/v1/agent/runs', headers=doctor, json={**body, 'client_run_id': 'false-selected-permission',
        'external_message_consent': {**PERMISSION, 'confirmed': False}}).status_code == 422
    assert runner.execute_one(SessionLocal, ack['id']) is True
    actual = client.get(f"/api/v1/agent/runs/{ack['id']}", headers=doctor).json()
    assert actual['mode'] == 'remote' and actual['artifact']['body']['reply'] == '先选一道题，只读题目就好。'
    assert sent[0]['messages'][1:] == [{'role': role, 'content': turn[field]} for turn in selected['turns']
        for role, field in [('user', 'user_message'), ('assistant', 'assistant_message')]] + [{'role': 'user', 'content': body['message']}]
    with SessionLocal() as db:
        assert db.get(AgentRun, ack['id']).snapshot['conversation_preview'] == selected
    # A client cannot insert a preview body into an otherwise valid request.
    assert client.post('/api/v1/agent/runs', headers=doctor,
        json={**body, 'client_run_id': 'client-written-preview', 'conversation_preview': selected}).status_code == 422


def test_preview_rejects_other_actor_profile_professional_and_unfinished_runs(client, monkeypatch):
    owner, doctor, _, session, identifiers, _ = setup_real_sources(client, monkeypatch)
    from backend.app.services.agent import runner
    from backend.app.db.session import SessionLocal
    patient_id = session['patient_id']
    assert get_context(client, owner, patient_id, identifiers=identifiers).status_code == 403
    assert get_context(client, doctor, patient_id, identifiers=[999999]).status_code == 404
    assert get_context(client, doctor, patient_id, identifiers=[identifiers[0], identifiers[0]]).status_code == 422
    assert get_context(client, doctor, patient_id, identifiers=identifiers, mode='local').status_code == 422
    ctx = get_context(client, doctor, patient_id, mode='local').json()
    queued, _ = enqueue(client, doctor, patient_id, 'unfinished-question', context=ctx, message='如何在小程序开始评估？')
    assert queued.status_code == 202
    assert get_context(client, doctor, patient_id, identifiers=[queued.json()['id']]).status_code == 409
    professional, _ = enqueue(client, doctor, patient_id, 'professional-not-conversation', context=ctx,
        message='本轮材料摘要', intent='assessment_summary')
    assert professional.status_code == 202, professional.text
    assert runner.execute_one(SessionLocal, professional.json()['id']) is True
    assert get_context(client, doctor, patient_id, identifiers=[professional.json()['id']]).status_code == 422
    long_run, _ = enqueue(client, doctor, patient_id, 'long-complete-question', context=ctx,
        message='注意力' + '长'*3997)
    assert long_run.status_code == 202, long_run.text
    assert runner.execute_one(SessionLocal, long_run.json()['id']) is True
    assert get_context(client, doctor, patient_id, identifiers=[long_run.json()['id']]).status_code == 422
    from backend.tests.w02_helpers import register
    from backend.app.models.patient import Patient
    from sqlalchemy import select
    other, other_owner = register(client, 'selected-other-profile@example.com')
    with SessionLocal() as db:
        other_patient_id = db.scalar(select(Patient.id).where(Patient.user_id == other['user']['id']))
    invitation = client.post('/api/v1/care/relationships/invitations', headers=doctor, json={
        'target_email': other['user']['email'], 'patient_id': other_patient_id, 'purpose': 'clinical_sharing',
        'scope': ['profile', 'assessment', 'care']})
    assert invitation.status_code == 201, invitation.text
    assert client.post(f"/api/v1/care/relationships/{invitation.json()['id']}/accept", headers=other_owner,
        json={'expected_revision': invitation.json()['revision']}).status_code == 200
    assert get_context(client, doctor, other_patient_id, identifiers=identifiers).status_code == 403


def test_server_preview_source_change_and_signed_context_tampering_are_rejected(client, monkeypatch):
    _, doctor, _, session, identifiers, _ = setup_real_sources(client, monkeypatch)
    from backend.app.services.agent import runner
    patient_id = session['patient_id']
    context = get_context(client, doctor, patient_id, identifiers=identifiers).json()
    assert 'conversation_preview' in context
    original = runner._dialogue_preview
    def changed_source(*args, **kwargs):
        source = original(*args, **kwargs)
        return preview(*[(turn['run_id'], turn['user_message'], turn['assistant_message']+' changed') for turn in source['turns']])
    monkeypatch.setattr(runner, '_dialogue_preview', changed_source)
    result, _ = enqueue(client, doctor, patient_id, 'source-changed-after-preview', context=context, identifiers=identifiers)
    assert result.status_code == 409, result.text
    monkeypatch.setattr(runner, '_dialogue_preview', original)
    token = context['run_context']
    middle = len(token)//2
    tampered = token[:middle] + ('a' if token[middle] != 'a' else 'b') + token[middle+1:]
    result, _ = enqueue(client, doctor, patient_id, 'tampered-preview-token',
        context={**context, 'run_context': tampered}, identifiers=identifiers)
    assert result.status_code in {403, 409, 422}, result.text
    # Even an authenticated run state must not borrow another run's answer.
    # This mutation is restricted to the test fixture's temporary database.
    from backend.app.db.session import SessionLocal
    from backend.app.models.agent import AgentRun
    with SessionLocal() as db:
        first, second = [db.get(AgentRun, identifier) for identifier in identifiers]
        first.artifact_id = second.artifact_id
        runner._seal_state(first)
        db.commit()
    assert get_context(client, doctor, patient_id, identifiers=identifiers[:1]).status_code == 409


def test_queued_selected_dialogue_cannot_borrow_regrant_and_original_ack_survives(client, monkeypatch):
    owner, doctor, _, session, identifiers, grant = setup_real_sources(client, monkeypatch)
    from backend.app.core.config import settings
    from backend.app.services.agent import runner
    from backend.app.db.session import SessionLocal
    for key, value in vars(config()).items():
        monkeypatch.setattr(settings, key, value)
    _, sent = install_transport(monkeypatch, [response({'content': '先读一道题。'})])
    patient_id = session['patient_id']
    context = get_context(client, doctor, patient_id, identifiers=identifiers).json()
    result, body = enqueue(client, doctor, patient_id, 'selected-old-grant', context=context, identifiers=identifiers)
    assert result.status_code == 202, result.text
    ack = result.json()
    assert client.post(f"/api/v1/patient/consents/{grant['id']}/withdraw", headers=owner,
        json={'expected_revision': grant['revision']}).status_code == 200
    assert client.post('/api/v1/patient/consents', headers=owner,
        json={'patient_id': patient_id, 'purpose': 'external_ai', 'scope': ['care'], 'terms_version': 'W02-1'}).status_code == 201
    assert runner.execute_one(SessionLocal, ack['id']) is False
    assert not sent
    assert client.get('/api/v1/agent/runs/submissions/selected-old-grant', headers=doctor).json() == ack
    assert client.post('/api/v1/agent/runs', headers=doctor,
        json={**body, 'client_run_id': 'selected-obsolete-context'}).status_code == 403


def test_withdraw_and_regrant_after_http_dispatch_prevents_saving_answer(client, monkeypatch):
    owner, doctor, _, session, identifiers, grant = setup_real_sources(client, monkeypatch)
    from backend.app.core.config import settings
    from backend.app.services.agent import provider, runner
    from backend.app.db.session import SessionLocal
    import httpx
    for key, value in vars(config()).items():
        monkeypatch.setattr(settings, key, value)
    patient_id = session['patient_id']
    sent = []
    async_client = httpx.AsyncClient
    def handle(request):
        sent.append(json.loads(request.content))
        assert client.post(f"/api/v1/patient/consents/{grant['id']}/withdraw", headers=owner,
            json={'expected_revision': grant['revision']}).status_code == 200
        assert client.post('/api/v1/patient/consents', headers=owner,
            json={'patient_id': patient_id, 'purpose': 'external_ai', 'scope': ['care'], 'terms_version': 'W02-1'}).status_code == 201
        return httpx.Response(200, json=response({'content': '这条模型文字不能在原授权失效后保存。'}))
    monkeypatch.setattr(provider.httpx, 'AsyncClient', lambda **kwargs: async_client(transport=httpx.MockTransport(handle), **kwargs))
    result, _ = enqueue(client, doctor, patient_id, 'selected-revoked-after-http', identifiers=identifiers)
    assert result.status_code == 202, result.text
    assert runner.execute_one(SessionLocal, result.json()['id']) is False
    assert len(sent) == 1
    actual = client.get(f"/api/v1/agent/runs/{result.json()['id']}", headers=doctor).json()
    assert actual['status'] == 'stale' and actual['error_code'] == 'authority_changed' and actual['artifact'] is None


def test_actual_clinical_history_gets_local_reply_and_no_http_even_for_related_reference(client, monkeypatch):
    _, doctor, _, session, _, _ = setup_real_sources(client, monkeypatch)
    from backend.app.core.config import settings
    from backend.app.services.agent import runner
    from backend.app.db.session import SessionLocal
    for key, value in vars(config()).items():
        monkeypatch.setattr(settings, key, value)
    _, sent = install_transport(monkeypatch, [])
    patient_id = session['patient_id']
    local = get_context(client, doctor, patient_id, mode='local').json()
    source, _ = enqueue(client, doctor, patient_id, 'clinical-source', context=local, message='注意力不好，可以停药了吗？')
    assert source.status_code == 202, source.text
    assert runner.execute_one(SessionLocal, source.json()['id']) is True
    selected, _ = enqueue(client, doctor, patient_id, 'clinical-reference', identifiers=[source.json()['id']], message='刚才那个继续帮我说')
    assert selected.status_code == 202, selected.text
    assert runner.execute_one(SessionLocal, selected.json()['id']) is True
    actual = client.get(f"/api/v1/agent/runs/{selected.json()['id']}", headers=doctor).json()
    assert actual['mode'] == 'rules' and actual['error_code'] == 'local_safety_boundary'
    assert actual['artifact']['body']['question_topic'] == 'clinical'
    assert '医生' in actual['artifact']['body']['reply'] and not sent
