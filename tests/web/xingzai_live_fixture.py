"""Explicit live-provider validation in a disposable synthetic store only."""
import os
from pathlib import Path
from urllib.parse import urlsplit


def enable_synthetic_provider():
    from dotenv import dotenv_values
    from backend.app.core.config import settings
    root = Path(__file__).resolve().parents[2]
    assert settings.APP_ENV == 'test'
    assert str(root / '.codex-tmp').replace('\\', '/') in settings.DATABASE_URL.replace('\\', '/')
    values = dotenv_values(root / 'backend' / '.env')
    endpoint = values.get('DEEPSEEK_BASE_URL') or 'https://api.deepseek.com/chat/completions'
    assert urlsplit(endpoint).scheme == 'https' and urlsplit(endpoint).hostname == 'api.deepseek.com'
    key = values.get('DEEPSEEK_API_KEY', '').strip()
    assert key, 'Existing provider credential is absent'
    settings.DEEPSEEK_API_KEY = key
    settings.DEEPSEEK_BASE_URL = endpoint
    settings.DEEPSEEK_CHAT_MODEL = values.get('DEEPSEEK_CHAT_MODEL') or 'deepseek-flash'
    # Conservative peak/cache-miss USD microunits, checked against official docs
    # 2026-10-17: https://api-docs.deepseek.com/quick_start/pricing/
    settings.AGENT_MAX_PROMPT_TOKENS = 30000
    settings.AGENT_MAX_COMPLETION_TOKENS = 1500
    settings.AGENT_MAX_COST_MICROUNITS = 10000
    settings.AGENT_PROMPT_MICROUNITS_PER_TOKEN = '0.3'
    settings.AGENT_COMPLETION_MICROUNITS_PER_TOKEN = '1.2'


def run_check():
    import json
    from time import monotonic
    from fastapi.testclient import TestClient
    from isolated_server import root, runtime
    enable_synthetic_provider()
    from backend.app.main import app
    from backend.app.services.agent import runner, provider
    from backend.app.db.session import SessionLocal
    from backend.tests.w02_helpers import register
    runner.schedule_run = lambda *_: None
    original_post = provider._post
    outbound = []
    async def checked_post(settings, payload, timeout):
        assert len(payload['messages']) == 2 and 'tools' not in payload
        assert payload['messages'][-1] == {'role': 'user', 'content': question}
        outbound.append({'message_count': 2, 'user_messages': 1, 'history_messages': 0, 'tools': False,
            'current_question_only': True, 'max_tokens': payload['max_tokens']})
        return await original_post(settings, payload, timeout)
    provider._post = checked_post
    question = '这是合成体验问题。我学习时容易走神和拖延，想先试一个小方法，也想知道可以怎样用这个小程序向医生反馈。'
    started = monotonic()
    with TestClient(app) as client:
        user, headers = register(client, 'xingzai-smart-synthetic@example.com')
        pid = user['user']['patient_profile']['id']
        grant = client.post('/api/v1/patient/consents', headers=headers,
            json={'patient_id': pid, 'purpose': 'external_ai', 'scope': ['care'], 'terms_version': 'W02-1'})
        assert grant.status_code == 201, grant.text
        context = client.get(f'/api/v1/agent/run-context?patient_id={pid}&question_mode=smart', headers=headers).json()
        body = {'client_run_id': 'live-synthetic-smart-current', 'patient_id': pid, 'intent': 'question', 'assessment_id': None, 'cycle_id': None,
            'message': question, 'expected_context_digest': context['input_digest'], 'run_context': context['run_context'],
            'external_message_consent': {'version': 'Xingzai-current-message-1', 'confirmed': True}}
        accepted = client.post('/api/v1/agent/runs', headers=headers, json=body)
        assert accepted.status_code == 202, accepted.text
        ack = accepted.json()
        assert ack['original_request'] == body
        runner.execute_one(SessionLocal, ack['id'])
        actual = client.get(f"/api/v1/agent/runs/{ack['id']}", headers=headers).json()
        restored = client.get('/api/v1/agent/runs/submissions/live-synthetic-smart-current', headers=headers).json()
        proof = {'synthetic_only': True, 'temporary_database': True, 'provider_transport': 'actual_https',
            'status': actual['status'], 'mode': actual['mode'], 'model': actual['model_name'], 'error_code': actual['error_code'],
            'model_round_count': actual['model_round_count'], 'prompt_tokens': actual['prompt_tokens'], 'completion_tokens': actual['completion_tokens'],
            'estimated_cost_microunits_usd': actual['estimated_cost_microunits'], 'exact_original_ack_recovered': restored == ack,
            'outbound': outbound, 'question': question, 'answer': actual['artifact']['body']['reply'] if actual['artifact'] else None,
            'elapsed_seconds': round(monotonic()-started, 2)}
        (root / 'docs/evidence/xingzai-smart-live-current.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(proof, ensure_ascii=False))
        assert actual['status'] == 'completed' and actual['mode'] == 'remote', 'Actual provider did not complete; inspect evidence error_code'


if __name__ == '__main__':
    run_check()
