"""The regular backend must execute reference assessments without test mode."""
from backend.tests.test_assessment_sessions import actor, create, start


def test_development_create_attempt_and_recover_preserves_original_template(client, monkeypatch):
    _, owner, pid = actor(client)
    from backend.app.core.config import settings
    original = client.get(f'/api/v1/care/assessment-templates?patient_id={pid}', headers=owner).json()['items'][0]
    monkeypatch.setattr(settings, 'APP_ENV', 'development')
    registry = client.get(f'/api/v1/care/assessment-templates?patient_id={pid}', headers=owner).json()
    template = registry['items'][0]
    assert template['admission_status'] == 'reference_use'
    assert registry['can_create_self'] is True
    assert template['template_digest'] == original['template_digest']
    assert template['professional_approval'] is None
    assert 'W04_W05_submission_transaction_not_connected' not in template['blockers']
    response = create(client, owner, pid)
    assert response.status_code == 201, response.text
    session = response.json()
    assert session['usage_scope'] == 'reference_assessment'
    assert all('create_attempt' in item['allowed_actions'] for item in session['items'])
    attempt = start(client, owner, session['items'][0], pid)
    assert attempt.status_code == 201, attempt.text
    recovered = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()['items'][0]['attempts'][0]['id'] == attempt.json()['id']
    assert 'W04_W05_submission_transaction_not_connected' not in session['blockers']


def test_development_reference_still_checks_current_consent_and_age(client, monkeypatch):
    _, owner, pid = actor(client)
    from backend.app.core.config import settings
    monkeypatch.setattr(settings, 'APP_ENV', 'development')
    bad = create(client, owner, pid, template_id='child-demo')
    assert bad.status_code == 422, bad.text
    grants = client.get(f'/api/v1/patient/consents?patient_id={pid}', headers=owner).json()['items']
    current = next(row for row in grants if row['purpose'] == 'basic_use' and row['effective_access'])
    withdrawn = client.post(f"/api/v1/patient/consents/{current['id']}/withdraw", headers=owner,
        json={'expected_revision': current['revision']})
    assert withdrawn.status_code == 200, withdrawn.text
    assert create(client, owner, pid).status_code == 403
