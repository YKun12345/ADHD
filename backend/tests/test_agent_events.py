from backend.tests.test_review_drafts import context_and_body


def test_actual_next_actions_are_deduplicated_role_bound_and_resolved_against_current_business(client):
    owner, doctor, other, session, _, _ = context_and_body(client)
    route = f"/api/v1/agent/actions?patient_id={session['patient_id']}"
    first = client.get(route, headers=doctor)
    assert first.status_code == 200, first.text
    action = next(row for row in first.json()['items'] if row['kind'] == 'review_assessment')
    assert action['target']['page_key'] == 'doctor_review'
    assert action['target']['params'] == {'patient_id': session['patient_id'], 'assessment_id': session['id']}
    again = client.get(route, headers=doctor)
    assert again.status_code == 200 and next(row for row in again.json()['items'] if row['kind'] == action['kind'])['id'] == action['id']
    payload = {'patient_id': session['patient_id'], 'expected_action_digest': action['action_digest']}
    resolve = f"/api/v1/agent/actions/{action['id']}/resolve"
    assert client.post(resolve, headers=owner, json=payload).status_code == 403
    assert client.post(resolve, headers=other, json=payload).status_code == 403
    assert client.post(resolve, headers=doctor, json={**payload, 'target_url': 'https://invalid.example'}).status_code == 422
    ready = client.post(resolve, headers=doctor, json=payload)
    assert ready.status_code == 200 and ready.json()['target'] == action['target'], ready.text
    assert ready.json()['revalidated'] is True
    patient = client.get(route, headers=owner)
    assert patient.status_code == 200 and all(row['target']['page_key'] != 'doctor_review' for row in patient.json()['items'])
    relation = next(row for row in client.get('/api/v1/care/relationships', headers=owner).json()['items'] if row['doctor_user_id'] == session['responsible_doctor_id'])
    assert client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=owner, json={'expected_revision': relation['revision']}).status_code == 200
    assert client.post(resolve, headers=doctor, json=payload).status_code in {403, 409}
