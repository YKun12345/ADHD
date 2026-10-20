from backend.tests.test_review_drafts import context_and_body


def test_unified_agent_context_binds_actual_actor_patient_and_real_business_without_private_chat_or_raw_trials(client):
    owner, doctor, other, session, _, _ = context_and_body(client)
    route = f"/api/v1/agent/context?patient_id={session['patient_id']}"
    owned = client.get(route, headers=owner)
    assert owned.status_code == 200, owned.text
    assert owned.json()['actor_user_id'] != session['responsible_doctor_id']
    assert owned.json()['patient_id'] == session['patient_id']
    clinician = client.get(route, headers=doctor)
    assert clinician.status_code == 200, clinician.text
    data = clinician.json()
    assert data['actor_user_id'] == session['responsible_doctor_id'] and data['role'] == 'researcher'
    actual = next(row for row in data['assessments'] if row['id'] == session['id'])
    assert actual['responsible_doctor_id'] == session['responsible_doctor_id']
    assert actual['submissions'][0]['quality_status'] == 'limited'
    assert 'practice_records' not in clinician.text and 'raw_result' not in clinician.text and 'trials' not in clinician.text
    assert 'private_chat_history' not in data and data['model_evidence_status'] == 'not_admitted'
    denied = client.get(f'/api/v1/agent/context?patient_id={session["patient_id"] + 999}', headers=doctor)
    assert denied.status_code in {403, 404}
    relation = next(row for row in client.get('/api/v1/care/relationships', headers=owner).json()['items'] if row['doctor_user_id'] == session['responsible_doctor_id'])
    assert client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=owner, json={'expected_revision': relation['revision']}).status_code == 200
    assert client.get(route, headers=doctor).status_code == 403
    assert client.get(route, headers=owner).status_code == 200
