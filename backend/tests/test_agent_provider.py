"""Native tools against synthetic HTTP only; no external AI or patient store."""
import json
from types import SimpleNamespace
from time import monotonic
import httpx
import pytest


def frame_and_request():
    frame = {'actor_user_id': 5, 'role': 'patient', 'patient_id': 9, 'subject_kind': 'adult', 'authorized_scopes': ['assessment'],
        'assessments': [{'id': 3, 'responsible_doctor_id': None, 'source_ref': 'assessment:3:2', 'items': [{'id': 1}],
            'submissions': [], 'reports': [{'body': 'PRIVATE_REPORT_NAME', 'id': 8, 'version': 1, 'input_digest': 'a'*64}]}],
        'plans': [], 'cycles': [], 'authorization_snapshot': [], 'input_digest': 'b'*64,
        'private_chat': 'PRIVATE_CHAT_NAME', 'raw_trials': 'PRIVATE_RAW_TRIALS', 'name': 'PRIVATE_PATIENT_NAME'}
    return frame, {'intent': 'assessment_summary', 'patient_id': 9, 'assessment_id': 3, 'cycle_id': None, 'message': 'PRIVATE_FREE_QUESTION'}


def config():
    return SimpleNamespace(DEEPSEEK_API_KEY='synthetic-only-key', DEEPSEEK_BASE_URL='https://provider.synthetic.test/chat/completions',
        DEEPSEEK_CHAT_MODEL='synthetic-model', AGENT_MAX_PROMPT_TOKENS=50000, AGENT_MAX_COMPLETION_TOKENS=1000,
        AGENT_MAX_COST_MICROUNITS=100000, AGENT_PROMPT_MICROUNITS_PER_TOKEN='0.1', AGENT_COMPLETION_MICROUNITS_PER_TOKEN='0.2')


def install_transport(monkeypatch, responses):
    from backend.app.services.agent import provider
    actual = httpx.AsyncClient; captured = []
    def handle(request):
        captured.append(json.loads(request.content))
        value = responses[min(len(captured)-1, len(responses)-1)]
        if isinstance(value, Exception):
            raise value
        return httpx.Response(200, json=value)
    monkeypatch.setattr(provider.httpx, 'AsyncClient', lambda **kw: actual(transport=httpx.MockTransport(handle), **kw))
    return provider, captured


def response(message, prompt=100, completion=20):
    return {'choices': [{'message': {'role': 'assistant', **message}, 'finish_reason': 'tool_calls' if message.get('tool_calls') else 'stop'}],
        'usage': {'prompt_tokens': prompt, 'completion_tokens': completion}}


def tool(name='get_progress', pid=9, count=1, tag='call'):
    return response({'content': None, 'tool_calls': [{'id': f'{tag}-{n}', 'type': 'function',
        'function': {'name': name, 'arguments': json.dumps({'patient_id': pid, 'assessment_id': 3, 'cycle_id': None})}} for n in range(count)]})


def final(ref='assessment:3:2'):
    return response({'content': json.dumps({'narrative': '请核对实际缺失材料，再按当前页面继续。', 'source_refs': [ref]})})


def test_native_two_round_tool_protocol_and_program_values_are_retained_without_private_free_text(monkeypatch):
    p, sent = install_transport(monkeypatch, [tool(), final()]); frame, request = frame_and_request(); authorizations = []; calls = []
    body, refs, stats = p.run_provider(frame, request, settings=config(), authorize_dispatch=lambda **kw: authorizations.append(kw['reservation']),
        execute_authorized_tool=lambda name, args: calls.append((name, args)) or {'summary': {'missing_items': 1}, 'secret': 'PRIVATE_TOOL_TEXT'}, deadline=monotonic()+60)
    assert len(sent) == len(authorizations) == stats['model_round_count'] == 2 and stats['tool_count'] == 2
    assert calls[0][0] == 'get_progress' and stats['prompt_tokens'] == 200 and stats['completion_tokens'] == 40
    assert stats['cost_microunits'] == 28
    assert [row['model_round_count'] for row in authorizations]==[1,2]
    assert authorizations[0]['reserved_cost_microunits'] > 0 and authorizations[0]['prices']['prompt_microunits_per_token']=='0.1'
    assert authorizations[0]['deployment_caps']['cost_microunits']==100000
    assert body['summary']['missing_items'] == 1 and body['summary']['valid_submissions'] == 0
    assert body['status'] == 'draft' and body['requires_human_confirmation'] is True and refs == ['assessment:3:2']
    text = json.dumps(sent); assert 'PRIVATE_' not in text and 'synthetic-only-key' not in text
    assert sent[1]['messages'][-1]['role'] == 'tool' and sent[1]['messages'][-1]['tool_call_id'] == 'call-0'
    assert sent[1]['messages'][-2]['tool_calls'][0]['id'] == 'call-0'
    assert all(value.get('thinking')=={'type':'disabled'} for value in sent)
    assert all('reasoning_content' not in json.dumps(value['messages']) for value in sent)


@pytest.mark.parametrize('invalid', ['source', 'unknown_tool', 'other_patient', 'too_many_tools', 'round_limit', 'usage', 'numbers', 'timeout', 'budget'])
def test_provider_fails_closed_at_actual_protocol_and_output_boundaries(monkeypatch, invalid):
    replies = {'source': [final('submission:invented:abc')], 'unknown_tool': [tool('run_sql')], 'other_patient': [tool(pid=77)],
        'too_many_tools': [tool(count=7)], 'round_limit': [tool(tag='r1'), tool(tag='r2'), tool(tag='r3')], 'usage': [{'choices': final()['choices']}],
        'numbers': [response({'content': json.dumps({'narrative': '已经完成99项。', 'source_refs': ['assessment:3:2']})})],
        'timeout': [httpx.ReadTimeout('synthetic timeout')], 'budget': [final()]}[invalid]
    p, sent = install_transport(monkeypatch, replies); frame, request = frame_and_request(); settings = config()
    if invalid == 'budget': settings.AGENT_MAX_COST_MICROUNITS = 1
    from fastapi import HTTPException
    with pytest.raises((p.ProviderFailure, HTTPException)) as failure:
        p.run_provider(frame, request, settings=settings, authorize_dispatch=lambda **kw: True, execute_authorized_tool=lambda *args: {}, deadline=monotonic()+60)
    assert len(sent) <= 3
    if invalid == 'budget': assert not sent
    if invalid == 'round_limit': assert len(sent) == 3 and failure.value.code == 'model_round_limit'


def test_missing_budget_or_consent_callback_denial_never_dispatches(monkeypatch):
    p, sent = install_transport(monkeypatch, [final()]); frame, request = frame_and_request(); settings = config()
    settings.AGENT_COMPLETION_MICROUNITS_PER_TOKEN = ''
    with pytest.raises(p.ProviderFailure, match='budget_not_configured'):
        p.run_provider(frame, request, settings=settings, authorize_dispatch=lambda **kw: True, execute_authorized_tool=lambda *args: {})
    from fastapi import HTTPException
    def denied(**kw): raise HTTPException(403, 'original consent withdrawn')
    with pytest.raises(HTTPException):
        p.run_provider(frame, request, settings=config(), authorize_dispatch=denied, execute_authorized_tool=lambda *args: {})
    assert not sent
