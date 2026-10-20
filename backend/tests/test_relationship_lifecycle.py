from backend.tests.w02_helpers import register, qualify, invite


def test_legacy_binding_is_not_a_clinical_grant(client):
    doctor, headers = register(client, "legacy-doctor@example.com", "researcher")
    patient, _ = register(client, "legacy-patient@example.com")
    patient_id = patient["user"]["patient_profile"]["id"]
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient import Patient
    with SessionLocal() as db:
        db.get(Patient, patient_id).assigned_researcher_id = doctor["user"]["id"]
        db.commit()
    assert client.get(f"/api/v1/doctor/patient/{patient_id}/report", headers=headers).status_code in [403,404]
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/summary", headers=headers).status_code == 403


def test_pending_both_confirmation_revocation_and_old_replay(client):
    doctor, doctor_headers = register(client, "qualified@example.com", "researcher")
    patient, owner = register(client, "confirmed@example.com")
    patient_id = patient["user"]["patient_profile"]["id"]
    body = {"target_email": patient["user"]["email"], "scope":["profile","assessment","tracking","care","imaging"]}
    assert client.post("/api/v1/care/relationships/invitations", headers=doctor_headers, json=body).status_code == 403
    qualify(doctor["user"]["id"])
    relationship = invite(client, doctor_headers, patient, patient_id)
    assert relationship["status"] == "pending"
    url = f"/api/v1/care/doctor/patient/{patient_id}/messages"
    assert client.get(url, headers=doctor_headers).status_code == 403
    accept_url = f"/api/v1/care/relationships/{relationship['id']}/accept"
    assert client.post(accept_url, headers=doctor_headers, json={"expected_revision":1}).status_code == 403
    accepted = client.post(accept_url, headers=owner, json={"expected_revision":1})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "active"
    message = {"content":"Synthetic message", "client_message_id":"w02-replay"}
    assert client.post(url, headers=doctor_headers, json=message).status_code == 201
    revoked = client.post(f"/api/v1/care/relationships/{relationship['id']}/revoke", headers=owner, json={"expected_revision":2})
    assert revoked.status_code == 200, revoked.text
    assert client.get(url, headers=doctor_headers).status_code == 403
    assert client.post(url, headers=doctor_headers, json=message).status_code == 403
