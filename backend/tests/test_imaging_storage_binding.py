"""W09 next storage segment counterexamples, actual synthetic writes only."""
from sqlalchemy import text
from backend.tests.w02_helpers import register, qualify


def swap_saved_field(table, field, source_id, target_id):
    from backend.app.db.session import SessionLocal
    # Names are internal constants from these tests, never request input.
    with SessionLocal() as db:
        original = db.execute(text(f'SELECT {field} FROM {table} WHERE id=:id'), {'id': source_id}).scalar_one()
        db.execute(text(f'UPDATE {table} SET {field}=:value WHERE id=:id'), {'value': original, 'id': target_id})
        db.commit()


def test_new_model_result_ciphertext_cannot_be_transplanted_to_a_different_patient(client):
    first, own = register(client, 'imaging-binding-owner-a@example.org')
    second, other = register(client, 'imaging-binding-owner-b@example.org')
    saved = []
    for account, headers, name in [(first, own, 'synthetic-owner-a.csv'), (second, other, 'synthetic-private-owner-b.csv')]:
        response = client.post(f"/api/v1/model/predict_mock?patient_id={account['user']['patient_profile']['id']}&file_name={name}", headers=headers)
        assert response.status_code == 200, response.text
        saved.append(response.json())
    swap_saved_field('model_predictions', 'file_name', saved[1]['prediction_id'], saved[0]['prediction_id'])
    leaked = client.get('/api/v1/patient/comprehensive_report', headers=own)
    assert leaked.status_code in {409, 503}, leaked.text
    assert 'synthetic-private-owner-b.csv' not in leaked.text


def test_new_saved_image_notes_cannot_be_transplanted_between_currently_shared_patients(client):
    first, own = register(client, 'image-notes-owner-a@example.org')
    second, other = register(client, 'image-notes-owner-b@example.org')
    doctor, clinician = register(client, 'image-notes-doctor@example.org', 'researcher')
    qualify(doctor['user']['id'])
    saved = []
    for account, headers, note in [(first, own, '合成A原件说明。'), (second, other, '合成B独有私密说明。')]:
        invitation = client.post('/api/v1/care/relationships/invitations', headers=clinician,
            json={'target_email': account['user']['email'], 'purpose': 'clinical_sharing', 'scope': ['profile', 'imaging']})
        assert invitation.status_code == 201, invitation.text
        accepted = client.post(f"/api/v1/care/relationships/{invitation.json()['id']}/accept", headers=headers,
            json={'expected_revision': invitation.json()['revision']})
        assert accepted.status_code == 200, accepted.text
        response = client.post(f"/api/v1/doctor/patient/{account['user']['patient_profile']['id']}/imaging_visualization", headers=clinician,
            json={'visualization_type': 'nifti', 'notes': note})
        assert response.status_code == 201, response.text
        saved.append(response.json())
    swap_saved_field('imaging_visualizations', 'notes', saved[1]['id'], saved[0]['id'])
    leaked = client.get('/api/v1/patient/comprehensive_report', headers=own)
    assert leaked.status_code in {409, 503}, leaked.text
    assert '合成B独有私密说明' not in leaked.text
