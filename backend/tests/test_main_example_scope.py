"""Synthetic accounts in the main database cannot acquire real-patient scope."""
from backend.tests.w02_helpers import register, qualify


def _marked(client):
    from backend.app.db.session import SessionLocal
    from backend.app.services.example_scope_service import mark_example_account
    doctor, clinician = register(client, 'scope-doctor@competition.example.com', 'researcher')
    patient, owner = register(client, 'scope-user@competition.example.com')
    with SessionLocal() as db:
        mark_example_account(db, doctor['user']['id'], doctor=True)
        mark_example_account(db, patient['user']['id'])
    return doctor, clinician, patient, owner


def _invite(client, clinician, patient):
    return client.post('/api/v1/care/relationships/invitations', headers=clinician, json={
        'target_email': patient['user']['email'], 'patient_id': patient['user']['patient_profile']['id'],
        'scope': ['profile', 'assessment', 'tracking', 'care', 'imaging'], 'purpose': 'clinical_sharing'})


def test_example_doctor_can_only_invite_marked_example_patients(client):
    _, clinician, patient, owner = _marked(client)
    actual, _ = register(client, 'non-example@example.com')
    denied = _invite(client, clinician, actual)
    assert denied.status_code == 403, denied.text
    invitation = _invite(client, clinician, patient)
    assert invitation.status_code == 201, invitation.text
    row = invitation.json()
    accepted = client.post(f"/api/v1/care/relationships/{row['id']}/accept", headers=owner,
        json={'expected_revision': row['revision']})
    assert accepted.status_code == 200, accepted.text
    pid = patient['user']['patient_profile']['id']
    assert client.get(f'/api/v1/care/assessment-templates?patient_id={pid}', headers=clinician).status_code == 200


def test_normal_doctor_cannot_invite_examples_and_marker_revocation_fails_closed(client):
    doctor, clinician, patient, owner = _marked(client)
    normal, normal_headers = register(client, 'scope-real-doctor@example.com', 'researcher')
    qualify(normal['user']['id'])
    assert _invite(client, normal_headers, patient).status_code == 403
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import InstitutionMembership
    from backend.app.services import authorization_ledger as ledger
    from sqlalchemy import select
    with SessionLocal() as db:
        membership = db.scalar(select(InstitutionMembership).where(
            InstitutionMembership.user_id == doctor['user']['id'], InstitutionMembership.role == 'example_account'))
        ledger.deny(membership)
    assert _invite(client, clinician, patient).status_code == 403
    # A revoked example marker must never turn the account into a regular one.
    assert client.get('/api/v1/identity/context', headers=owner).status_code == 200
