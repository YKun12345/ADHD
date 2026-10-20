from threading import Event
from time import monotonic, sleep
import pytest
from backend.tests.test_review_drafts import context_and_body
from backend.tests.test_assessment_sessions import start


@pytest.mark.parametrize('change', ['input', 'withdrawal'])
def test_running_agent_does_not_block_business_and_cannot_save_after_original_input_or_authority_changes(client, monkeypatch, change):
    owner, doctor, _, session, _, _ = context_and_body(client)
    from backend.app.services.agent import runner
    from backend.app.db.session import SessionLocal
    from backend.app.models.agent import AgentRun, AIArtifact
    from sqlalchemy import select
    entered, release = Event(), Event()
    original = runner.rule_artifact
    def held(frame, request):
        entered.set()
        if not release.wait(45):
            raise RuntimeError('synthetic_wait_expired')
        return original(frame, request)
    monkeypatch.setattr(runner, 'rule_artifact', held)
    ctx = client.get(f"/api/v1/agent/run-context?patient_id={session['patient_id']}", headers=doctor).json()
    before = monotonic()
    queued = client.post('/api/v1/agent/runs', headers=doctor, json={'client_run_id': 'held-' + change,
        'patient_id': session['patient_id'], 'assessment_id': session['id'], 'cycle_id': None, 'intent': 'assessment_summary',
        'message': '实际后台材料摘要。', 'expected_context_digest': ctx['input_digest'], 'run_context': ctx['run_context']})
    try:
        assert queued.status_code == 202, queued.text
        assert entered.wait(10) and not release.is_set(), 'POST must return before the held Agent is released'
        current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
        assert current.status_code == 200, current.text
        if change == 'input':
            item = next(row for row in current.json()['items'] if row['kind'] == 'scale' and 'create_attempt' in row['allowed_actions'])
            actual = start(client, owner, item, session['patient_id'])
            assert actual.status_code == 201, actual.text
        else:
            relation = next(row for row in client.get('/api/v1/care/relationships', headers=owner).json()['items'] if row['doctor_user_id'] == session['responsible_doctor_id'])
            revoked = client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=owner, json={'expected_revision': relation['revision']})
            assert revoked.status_code == 200, revoked.text
    finally:
        release.set()
    identifier = queued.json()['run_id']
    for _ in range(100):
        with SessionLocal() as db:
            row = db.get(AgentRun, identifier)
            if row.status not in {'queued', 'running'}:
                assert row.status == 'stale' and row.error_code == ('input_changed' if change == 'input' else 'authority_changed')
                assert row.artifact_id is None and db.scalar(select(AIArtifact.id).where(AIArtifact.run_id == identifier)) is None
                break
        sleep(0.05)
    else:
        raise AssertionError('Background must persist its actual stale result without an artifact')
