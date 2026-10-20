"""Independent HTTP checks for visibility before actual doctor publication."""
from backend.tests.test_authorization_edges import active_care


def test_doctor_assessment_draft_is_private_until_actual_publication(client):
    _, clinician, _, owner, patient_id, _ = active_care(client, suffix="w03-draft-visibility")
    created = client.post('/api/v1/care/doctor/assessments', headers=clinician, json={
        'patient_id': patient_id, 'template_id': 'adult-demo', 'template_version': 'W03-demo-1', 'background': {}
    })
    assert created.status_code == 201, created.text
    draft = created.json()
    assert draft['status'] == 'draft'
    own = client.get(f"/api/v1/care/assessments/{draft['id']}", headers=owner)
    assert own.status_code in {403, 404}, own.text
    history = client.get(f'/api/v1/care/assessments?patient_id={patient_id}', headers=owner)
    assert history.status_code == 200, history.text
    assert not any(row['id'] == draft['id'] for row in history.json()['items']), history.text
    published = client.post(f"/api/v1/care/assessments/{draft['id']}/publish", headers=clinician,
                            json={'expected_version': draft['version']})
    assert published.status_code == 200, published.text
    readable = client.get(f"/api/v1/care/assessments/{draft['id']}", headers=owner)
    assert readable.status_code == 200 and readable.json()['status'] == 'active', readable.text
