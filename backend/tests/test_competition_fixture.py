"""Competition data must be reproducible API evidence in a disposable store."""
import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


def fixture_module():
    path = ROOT / 'tests' / 'web' / 'competition_fixture.py'
    assert path.is_file(), 'The isolated synthetic competition fixture is missing.'
    spec = importlib.util.spec_from_file_location('competition_fixture_under_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_competition_fixture_rejects_an_unmarked_runtime_before_mutation(client, sqlite_database_path):
    fixture = fixture_module()
    with pytest.raises(AssertionError, match='synthetic runtime marker'):
        fixture.provision(client, sqlite_database_path.parent, ROOT)
    assert client.post('/api/v1/auth/login', json={
        'identifier': 'review@competition.example.com', 'password': 'Synthetic123!'
    }).status_code == 401


def test_competition_fixture_produces_separate_real_review_and_followup_evidence(client, sqlite_database_path):
    fixture = fixture_module()
    runtime = sqlite_database_path.parent
    (runtime / 'competition-demo.json').write_text(json.dumps({'synthetic': True}), encoding='utf-8')
    result = fixture.provision(client, runtime, ROOT)
    assert result['synthetic_only'] is True
    assert result['external_ai_enabled'] is False
    assert result['training_performed'] is False
    assert result['accounts']['doctor']['user']['full_name'] == '演示医生·林（合成）'
    review = result['scenarios']['review']
    followup = result['scenarios']['followup']
    assert review['patient_id'] != followup['patient_id']
    assert review['assessment']['status'] == 'under_review'
    assert len(review['submissions']) == len(followup['submissions']) == 7
    assert {r['submission_id'] for r in review['submissions']}.isdisjoint(
        r['submission_id'] for r in followup['submissions'])
    assert followup['report']['status'] == 'published'
    assert followup['acknowledgement']['meaning'] == 'received_only'
    assert len(followup['cycle']['records']) == 1
    assert len(followup['historical_self_cycle']['records']) == 7
    assert followup['historical_self_cycle']['summary']['completed_count'] == 7
    assert any(row['content']['focus_minutes'] is None for row in followup['historical_self_cycle']['records'])
    assert len(followup['plan']['tasks']) == 14
    assert len(followup['messages']) == 2
    assert followup['agent']['status'] == 'completed'
    assert followup['agent']['mode'] == 'rules'
    for account in result['accounts'].values():
        logged_in = client.post('/api/v1/auth/login', json={
            'identifier': account['email'], 'password': account['password'], 'role': account['role']})
        assert logged_in.status_code == 200, logged_in.text
        assert logged_in.json()['user']['id'] == account['user']['id']
