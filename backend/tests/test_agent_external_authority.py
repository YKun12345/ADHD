"""Actual purpose grants and actual runner, with a synthetic provider transport."""
import json
from threading import Event
from time import sleep
import httpx
from backend.tests.test_review_drafts import context_and_body


def test_real_runner_freezes_external_purpose_records_native_metrics_and_stops_regrant_during_model_call(client, monkeypatch):
    owner, doctor, _, session, _, _ = context_and_body(client)
    from backend.app.services.agent import provider, runner
    from backend.app.core.config import settings
    from backend.app.db.session import SessionLocal
    from backend.app.models.agent import AgentRun, AIArtifact
    from sqlalchemy import select
    for key, value in {'DEEPSEEK_API_KEY': 'synthetic-provider-key', 'AGENT_MAX_PROMPT_TOKENS': 50000,
        'AGENT_MAX_COMPLETION_TOKENS': 2000, 'AGENT_MAX_COST_MICROUNITS': 100000,
        'AGENT_PROMPT_MICROUNITS_PER_TOKEN': '0.1', 'AGENT_COMPLETION_MICROUNITS_PER_TOKEN': '0.2'}.items():
        monkeypatch.setattr(settings, key, value)
    actual = httpx.AsyncClient; sent = []; entered, release = Event(), Event(); hold = False
    def handle(request):
        payload = json.loads(request.content); sent.append(payload)
        if hold:
            entered.set()
            if not release.wait(30): raise RuntimeError('synthetic_latch_expired')
        current = json.loads(payload['messages'][1]['content'])
        if payload['messages'][-1]['role'] != 'tool':
            message = {'content': None, 'tool_calls': [{'id': 'actual-native-tool', 'type': 'function', 'function': {'name': 'get_progress',
                'arguments': json.dumps({'patient_id': session['patient_id'], 'assessment_id': session['id'], 'cycle_id': None})}}]}
        else:
            message = {'content': json.dumps({'narrative': '请核对实际局限与缺失材料，再继续当前流程。', 'source_refs': current['source_refs']})}
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', **message}, 'finish_reason': 'tool_calls' if 'tool_calls' in message else 'stop'}],
            'usage': {'prompt_tokens': 100, 'completion_tokens': 20}})
    monkeypatch.setattr(provider.httpx, 'AsyncClient', lambda **kw: actual(transport=httpx.MockTransport(handle), **kw))
    def enqueue(label):
        ctx = client.get(f"/api/v1/agent/run-context?patient_id={session['patient_id']}", headers=doctor)
        assert ctx.status_code == 200, ctx.text
        result = client.post('/api/v1/agent/runs', headers=doctor, json={'client_run_id': label, 'patient_id': session['patient_id'],
            'intent': 'assessment_summary', 'assessment_id': session['id'], 'cycle_id': None, 'message': 'PRIVATE_USER_PROMPT_MUST_STAY_LOCAL',
            'expected_context_digest': ctx.json()['input_digest'], 'run_context': ctx.json()['run_context']})
        assert result.status_code == 202, result.text
        return result.json()['run_id']
    def finished(identifier):
        for _ in range(250):
            with SessionLocal() as db:
                row = db.get(AgentRun, identifier)
                if row.status not in {'queued', 'running'}:
                    return runner.get_run(db, db.get(__import__('backend.app.models.user', fromlist=['User']).User, row.actor_user_id), identifier)
            sleep(0.05)
        raise AssertionError('Actual runner did not finish')
    local = enqueue('external-not-consented')
    assert finished(local)['mode'] == 'rules' and not sent
    grant = client.post('/api/v1/patient/consents', headers=owner, json={'patient_id': session['patient_id'], 'purpose': 'external_ai',
        'scope': ['assessment'], 'terms_version': 'W02-1'})
    assert grant.status_code == 201, grant.text
    # A later grant never converts the earlier immutable run to remote mode.
    assert client.get('/api/v1/agent/runs/submissions/external-not-consented', headers=doctor).status_code == 200
    assert finished(local)['mode'] == 'rules' and not sent
    remote = enqueue('external-current-consent'); result = finished(remote)
    assert result['status'] == 'completed' and result['mode'] == 'remote', result
    assert result['model_round_count'] == 2 and result['tool_count'] == 2
    assert result['prompt_tokens'] == 200 and result['completion_tokens'] == 40 and result['estimated_cost_microunits'] == 28
    assert result['artifact']['model_name'] == settings.DEEPSEEK_CHAT_MODEL
    assert 'PRIVATE_USER_PROMPT' not in json.dumps(sent)
    hold = True; held = enqueue('external-withdraw-and-regrant')
    try:
        assert entered.wait(10)
        revoked = client.post(f"/api/v1/patient/consents/{grant.json()['id']}/withdraw", headers=owner, json={'expected_revision': grant.json()['revision']})
        assert revoked.status_code == 200, revoked.text
        replaced = client.post('/api/v1/patient/consents', headers=owner, json={'patient_id': session['patient_id'], 'purpose': 'external_ai',
            'scope': ['assessment'], 'terms_version': 'W02-1'})
        assert replaced.status_code == 201 and replaced.json()['id'] != grant.json()['id']
    finally:
        release.set()
    stopped = finished(held)
    assert stopped['status'] == 'stale' and stopped['error_code'] == 'authority_changed' and stopped['artifact'] is None
    assert stopped['model_round_count'] == 1 and stopped['prompt_tokens'] == 100
    historical = client.get(f'/api/v1/agent/runs/{remote}', headers=doctor)
    assert historical.status_code == 200 and historical.json()['artifact']['stale'] is True
    with SessionLocal() as db:
        assert db.scalar(select(AIArtifact.id).where(AIArtifact.run_id == held)) is None
