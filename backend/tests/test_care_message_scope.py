"""Two actually accepted care relationships must not merge their conversations."""
from backend.tests.test_assessment_sessions import actor
from backend.tests.w02_helpers import register, qualify


def message_world(client, *, child=False):
    owner_data, owner, pid = actor(client, child=child, suffix="w05-message-scope")
    doctors = []
    for label in ("a", "b"):
        data, headers = register(client, f"w05-message-{label}@example.com", "researcher")
        qualify(data["user"]["id"])
        invited = client.post("/api/v1/care/relationships/invitations", headers=headers,
            json={"target_email":owner_data["user"]["email"],"patient_id":pid,"scope":["profile","care"],"purpose":"clinical_sharing"})
        assert invited.status_code == 201, invited.text
        accepted = client.post(f"/api/v1/care/relationships/{invited.json()['id']}/accept", headers=owner,
            json={"expected_revision":invited.json()["revision"]})
        assert accepted.status_code == 200, accepted.text
        doctors.append((data,headers,accepted.json()))
    return owner_data,owner,pid,doctors


def test_original_doctor_reply_is_not_disclosed_to_another_current_doctor(client):
    _,owner,pid,doctors = message_world(client)
    _,doctor_a,_ = doctors[0]
    _,doctor_b,_ = doctors[1]
    # Same stored legacy fact as the preserved pre-fix HTTP counterexample.
    # Legacy POST now rejects unbound writes, so seed pre-existing history.
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_message import CareMessage
    with SessionLocal() as db:
        saved = CareMessage(patient_id=pid,sender_user_id=doctors[0][0]["user"]["id"],
            sender_role="researcher",content="合成资料：A与本人之间的原始回复。",
            client_message_id="w05-message-original-a")
        db.add(saved)
        db.commit()
        saved_id = saved.id
    own = client.get("/api/v1/care/patient/messages",headers=owner)
    assert own.status_code == 200 and any(row["id"] == saved_id for row in own.json()["items"])
    assert own.json()["legacy_scope_status"] == "own_history_only"
    other = client.get(f"/api/v1/care/doctor/patient/{pid}/messages",headers=doctor_b)
    assert other.status_code == 200, other.text
    assert all(row["id"] != saved_id for row in other.json()["items"]), other.text
    assert other.json()["legacy_scope_status"] == "unverified_relationship"
