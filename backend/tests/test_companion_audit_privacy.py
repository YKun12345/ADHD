"""A security assignment does not expose another actor's private companion baseline."""
from backend.tests.test_security_regressions import actors, initialize


def test_assigned_dac_cannot_read_another_actors_companion_observation_but_existing_security_audits_remain(client, actors):
    initialize(client, actors)
    pid, owner = actors['patient_id'], actors['patient']['headers']
    response = client.get(f'/api/v1/agent/actions?patient_id={pid}', headers=owner)
    assert response.status_code == 200, response.text
    current = response.json()
    action = current['items'][0]
    resolved = client.post(f"/api/v1/agent/actions/{action['id']}/resolve", headers=owner,
        json={'patient_id': pid, 'expected_action_digest': action['action_digest']})
    assert resolved.status_code == 200, resolved.text
    observed = client.post('/api/v1/agent/companion-observations', headers=owner,
        json={'patient_id': pid, 'observation_context': current['companion']['observation_context']})
    assert observed.status_code == 200, observed.text
    listed = client.get('/api/v1/security/dac/audit_logs', headers=actors['dac']['headers'])
    assert listed.status_code == 200, listed.text
    assert not any(row['action'] == 'agent_companion_observed' for row in listed.json()['items'])
    # Keep the existing audit policy intact for ordinary business operations.
    assert any(row['action'] == 'agent_action_resolved' for row in listed.json()['items'])
    assert any(row['action'] == 'data_read' for row in listed.json()['items'])
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.services.security_service import list_recent_audit_logs
    with SessionLocal() as db:
        own = list_recent_audit_logs(db, db.get(User, actors['patient']['id']))
        assert any(row['action'] == 'agent_companion_observed' for row in own)
